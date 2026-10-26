// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::process;
use nemoclaw_sdk::{
    CancellationToken, OperationResult, Outcome,
    bundle::{Bundle, executable},
    config::{Document, parse_yaml_value},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

pub(super) struct Tools {
    pub candidate_revision: String,
    pub cli: PathBuf,
    pub tofu: PathBuf,
    pub probe: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
}

fn deployment(path: &Path) -> Result<Document, String> {
    let mut value =
        parse_yaml_value(fs::File::open(path).map_err(|_| "cannot read deployment YAML")?)
            .map_err(|_| "invalid deployment YAML")?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| "cannot allocate deployment identity")?;
    random[6] = (random[6] & 15) | 64;
    random[8] = (random[8] & 63) | 128;
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let uid = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    value
        .get_mut("metadata")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("deployment metadata must be an object")?
        .insert("uid".into(), uid.into());
    let bytes = serde_json::to_vec(&value).map_err(|_| "cannot encode deployment")?;
    Document::parse(bytes.as_slice()).map_err(|_| "invalid deployment configuration".into())
}

pub(super) async fn execute(
    deployment_path: &Path,
    suite: &Path,
    bundle: &Path,
    candidate_revision: &str,
    directory: &Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let bundle = Bundle::open(bundle).map_err(|_| "a verified candidate bundle is required")?;
    let tools = Tools {
        candidate_revision: candidate_revision.into(),
        cli: bundle.directory.join("bin").join(executable("nemoclaw")),
        tofu: bundle.tofu(),
        probe: std::env::current_exe().map_err(|_| "cannot locate probe executable")?,
        environment: BTreeMap::new(),
    };
    execute_with_tools(
        deployment_path,
        suite,
        &bundle.directory,
        directory,
        &tools,
        cancel,
    )
    .await
}

pub(super) async fn execute_with_tools(
    deployment_path: &Path,
    suite: &Path,
    bundle: &Path,
    directory: &Path,
    tools: &Tools,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let document = deployment(deployment_path)?;
    let suite = suite
        .canonicalize()
        .map_err(|_| "HCL suite directory is unavailable")?;
    if !suite.is_dir() {
        return Err("HCL suite must be a directory".into());
    }
    if tools.candidate_revision.len() != 40
        || !tools
            .candidate_revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("candidate revision must be a full lowercase 40-hex commit".into());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|_| "run directory must be new and its parent must exist")?;
    let directory = directory
        .canonicalize()
        .map_err(|_| "cannot resolve run directory")?;
    let state = directory.join("deployment");
    fs::create_dir(&state).map_err(|_| "cannot create deployment state directory")?;
    let verification = directory.join("verifier");
    fs::create_dir(&verification).map_err(|_| "cannot create verifier directory")?;
    let reports = verification.join("reports");
    fs::create_dir(&reports).map_err(|_| "cannot create probe evidence directory")?;
    fs::write(verification.join("cli.tfrc"), "disable_checkpoint = true\n")
        .map_err(|_| "cannot write verifier CLI configuration")?;
    let config = directory.join("deployment.yaml");
    fs::write(
        &config,
        document
            .yaml()
            .map_err(|_| "cannot encode resolved deployment")?,
    )
    .map_err(|_| "cannot save resolved deployment")?;
    nemoclaw_runtime::files::save_json(
        &directory.join("run.json"),
        &json!({"suite": suite, "candidate_revision": tools.candidate_revision}),
    )
    .map_err(|_| "cannot save run identity")?;
    let mut environment = tools.environment.clone();
    // Only gateway access is needed by the probe; inference credentials stay with apply.
    let connection = document.spec.gateway.connection();
    for name in connection
        .credential_env
        .into_iter()
        .chain(
            connection
                .tls
                .into_iter()
                .flat_map(|tls| [tls.ca_env, tls.certificate_env, tls.key_env]),
        )
        .filter(|name| !name.starts_with("TF_") && !name.starts_with("TOFU_"))
    {
        if let Some(value) = std::env::var_os(&name) {
            environment.insert(name.into(), value);
        }
    }
    environment.insert(
        nemoclaw_backend::DIAGNOSTICS_ENV.into(),
        directory.join("diagnostics").into_os_string(),
    );
    let arguments = |operation: &str| {
        let mut args = strings(&[
            operation,
            "--output",
            "json",
            "--progress",
            "off",
            "--bundle",
        ]);
        args.extend([
            bundle.as_os_str().to_owned(),
            "--state-dir".into(),
            state.as_os_str().to_owned(),
        ]);
        if operation != "destroy" {
            args.extend(["--non-interactive".into(), config.as_os_str().to_owned()]);
        }
        args
    };
    let mut apply_started = false;
    let mut phase = "plan";
    let primary = async {
        process::execute(
            &tools.cli,
            &arguments("plan"),
            &directory,
            phase,
            &environment,
            cancel,
        )
        .await?;
        phase = "apply";
        apply_started = true;
        process::execute(
            &tools.cli,
            &arguments("apply"),
            &directory,
            phase,
            &environment,
            cancel,
        )
        .await?;
        let mut verifier_environment = environment.clone();
        verifier_environment.insert(
            "TF_CLI_CONFIG_FILE".into(),
            verification.join("cli.tfrc").into_os_string(),
        );
        verifier_environment.insert(
            "TF_DATA_DIR".into(),
            verification.join("data").into_os_string(),
        );
        verifier_environment.insert(
            "TF_VAR_context".into(),
            json!({
                "config": config, "state_dir": state,
                "probe_executable": tools.probe, "evidence_dir": reports,
            })
            .to_string()
            .into(),
        );
        let chdir: OsString = format!("-chdir={}", suite.display()).into();
        phase = "tofu-init";
        process::execute(
            &tools.tofu,
            &[
                chdir.clone(),
                "init".into(),
                "-backend=false".into(),
                "-input=false".into(),
                "-no-color".into(),
            ],
            &verification,
            phase,
            &verifier_environment,
            cancel,
        )
        .await?;
        phase = "tofu-test";
        process::execute(
            &tools.tofu,
            &[chdir, "test".into(), "-json".into(), "-no-color".into()],
            &verification,
            phase,
            &verifier_environment,
            cancel,
        )
        .await
    }
    .await;
    let failed_phase = primary.as_ref().err().map(|_| phase);
    // Cleanup is independent of the cancelled operation and runs after partial apply.
    let cleanup = CancellationToken::new();
    let cleanup_result = if apply_started {
        match process::execute(
            &tools.cli,
            &arguments("destroy"),
            &directory,
            "destroy",
            &environment,
            &cleanup,
        )
        .await
        {
            Ok(()) => destroy_result(&directory),
            Err(error) => Err(error),
        }
    } else {
        Ok(Vec::new())
    };
    let succeeded = primary.is_ok() && cleanup_result.is_ok();
    let result = json!({
        "deployment": document.metadata.name, "suite": suite, "succeeded": succeeded,
        "candidate_revision": tools.candidate_revision,
        "deployment_uid": document.metadata.uid,
        "failed_phase": failed_phase, "attributed_to": if succeeded { "none" } else { "unknown" },
        "failure": primary.err(),
        "cleanup": {"required": apply_started, "succeeded": cleanup_result.is_ok(), "failure": cleanup_result.as_ref().err(), "retained": cleanup_result.as_ref().ok()},
    });
    nemoclaw_runtime::files::save_json(&directory.join("result.json"), &result)
        .map_err(|_| "cannot save run result")?;
    if succeeded {
        Ok(())
    } else {
        Err("E2E failed; inspect result.json and private command/probe evidence in the run directory".into())
    }
}

fn strings(args: &[&str]) -> Vec<OsString> {
    args.iter().map(Into::into).collect()
}

fn destroy_result(directory: &Path) -> Result<Vec<String>, String> {
    let result: OperationResult = serde_json::from_slice(
        &fs::read(directory.join("destroy.stdout")).map_err(|_| "missing destroy result")?,
    )
    .map_err(|_| "invalid destroy result")?;
    if result.outcome != Outcome::Destroyed {
        return Err("destroy did not confirm expected teardown/retention".into());
    }
    Ok(result.retained)
}

#[cfg(all(test, unix))]
#[path = "wrapper_tests.rs"]
mod tests;
