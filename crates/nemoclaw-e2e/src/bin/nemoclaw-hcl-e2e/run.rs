// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{case::Case, process};
use nemoclaw_sdk::{
    CancellationToken, OperationResult, Outcome,
    bundle::{Bundle, executable},
    config::Document,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

const MODULE: &str = include_str!("../../../hcl/verifier/main.tf");
const ASSERTIONS: &str = include_str!("../../../hcl/verifier/integration.tftest.hcl");

pub(super) struct Tools {
    pub candidate_revision: String,
    pub cli: PathBuf,
    pub tofu: PathBuf,
    pub docker: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
}

pub(super) fn verifier(directory: &Path) -> Result<(), String> {
    fs::create_dir(directory).map_err(|_| "verifier directory must be new")?;
    fs::create_dir(directory.join("reports"))
        .map_err(|_| "cannot create probe report directory")?;
    fs::write(directory.join("main.tf"), MODULE).map_err(|_| "cannot write verifier module")?;
    fs::write(directory.join("integration.tftest.hcl"), ASSERTIONS)
        .map_err(|_| "cannot write assertions")?;
    fs::write(directory.join("cli.tfrc"), "disable_checkpoint = true\n")
        .map_err(|_| "cannot write verifier CLI configuration")?;
    Ok(())
}

pub(super) async fn execute(
    case: &Path,
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
        docker: "docker".into(),
        environment: BTreeMap::new(),
    };
    execute_with_tools(case, &bundle.directory, directory, &tools, cancel).await
}

pub(super) async fn execute_with_tools(
    case_path: &Path,
    bundle: &Path,
    directory: &Path,
    tools: &Tools,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let case = Case::read(case_path)?;
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
    let document = case.owned_document()?;
    let directory = directory
        .canonicalize()
        .map_err(|_| "cannot resolve run directory")?;
    let state = directory.join("deployment");
    fs::create_dir(&state).map_err(|_| "cannot create deployment state directory")?;
    let verification = directory.join("verifier");
    verifier(&verification)?;
    let config = directory.join("deployment.yaml");
    fs::write(
        &config,
        document
            .yaml()
            .map_err(|_| "cannot encode resolved deployment")?,
    )
    .map_err(|_| "cannot save resolved deployment")?;
    let request = directory.join("request.json");
    fs::write(&request, case.request.to_string()).map_err(|_| "cannot save invocation request")?;
    nemoclaw_runtime::files::save_json(
        &directory.join("case.json"),
        &json!({"case": case.id, "candidate_revision": tools.candidate_revision}),
    )
    .map_err(|_| "cannot save case identity")?;
    let mut environment = tools.environment.clone();
    environment.insert(
        nemoclaw_backend::DIAGNOSTICS_ENV.into(),
        directory.join("diagnostics").into_os_string(),
    );
    environment.insert(
        "NEMOCLAW_HCL_E2E".into(),
        std::env::current_exe()
            .map_err(|_| "cannot locate probe executable")?
            .into_os_string(),
    );
    environment.insert(
        "NEMOCLAW_HCL_CONFIG".into(),
        config.clone().into_os_string(),
    );
    environment.insert("NEMOCLAW_HCL_STATE".into(), state.clone().into_os_string());
    environment.insert("NEMOCLAW_HCL_REQUEST".into(), request.into_os_string());
    let arguments = |operation: &str| {
        let mut args: Vec<OsString> = [
            operation,
            "--output",
            "json",
            "--progress",
            "off",
            "--bundle",
        ]
        .map(Into::into)
        .into();
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
        phase = "tofu-init";
        process::execute(
            &tools.tofu,
            &strings(&["init", "-backend=false", "-input=false", "-no-color"]),
            &verification,
            phase,
            &verifier_environment,
            cancel,
        )
        .await?;
        phase = "tofu-test";
        process::execute(
            &tools.tofu,
            &strings(&["test", "-json", "-no-color"]),
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
            Ok(()) => {
                verify_cleanup(&directory, &state, &document, tools, &environment, &cleanup).await
            }
            Err(error) => Err(error),
        }
    } else {
        Ok(Vec::new())
    };
    let succeeded = primary.is_ok() && cleanup_result.is_ok();
    let result = json!({
        "case": case.id, "succeeded": succeeded,
        "candidate_revision": tools.candidate_revision,
        "deployment_uid": document.metadata.uid,
        "failed_phase": failed_phase, "attributed_to": if succeeded { "none" } else { "unknown" },
        "failure": primary.err(),
        "cleanup": {"required": apply_started, "succeeded": cleanup_result.is_ok(), "failure": cleanup_result.as_ref().err(), "retained": cleanup_result.as_ref().ok()},
    });
    nemoclaw_runtime::files::save_json(&directory.join("result.json"), &result)
        .map_err(|_| "cannot save case result")?;
    if succeeded {
        Ok(())
    } else {
        Err("E2E failed; inspect result.json and private command/probe evidence in the run directory".into())
    }
}

fn strings(args: &[&str]) -> Vec<OsString> {
    args.iter().map(Into::into).collect()
}

async fn verify_cleanup(
    directory: &Path,
    state: &Path,
    document: &Document,
    tools: &Tools,
    environment: &BTreeMap<OsString, OsString>,
    cancel: &CancellationToken,
) -> Result<Vec<String>, String> {
    let result: OperationResult = serde_json::from_slice(
        &fs::read(directory.join("destroy.stdout")).map_err(|_| "missing destroy result")?,
    )
    .map_err(|_| "invalid destroy result")?;
    if result.outcome != Outcome::Destroyed
        || result
            .retained
            .iter()
            .any(|r| r != "openshell_gateway_storage.runtime")
    {
        return Err("destroy did not confirm expected teardown/retention".into());
    }
    let final_state = match fs::read(state.join("terraform.tfstate")) {
        Ok(bytes) => Some(bytes),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && result.retained.is_empty() =>
        {
            None
        }
        Err(_) => return Err("cannot read final deployment state".into()),
    };
    if let Some(bytes) = final_state {
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "cannot verify final deployment state")?;
        for resource in value["resources"]
            .as_array()
            .ok_or("invalid final resource inventory")?
        {
            if resource["mode"] == "managed"
                && resource["instances"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
            {
                let address = format!(
                    "{}.{}",
                    resource["type"].as_str().unwrap_or_default(),
                    resource["name"].as_str().unwrap_or_default()
                );
                if !result.retained.contains(&address) {
                    return Err("destroy left a managed workload in state".into());
                }
            }
        }
    }
    let engine = match &document.spec.gateway {
        nemoclaw_sdk::config::Gateway::Managed(g) => &g.engine,
        _ => return Err("unexpected gateway".into()),
    };
    for (label, filter, volumes) in [
        (
            "cleanup-gateway",
            format!("label=nemoclaw.nvidia.com/uid={}", document.metadata.uid),
            false,
        ),
        (
            "cleanup-sandboxes",
            format!(
                "label=openshell.ai/sandbox-namespace={}-gateway",
                document.workspace()
            ),
            false,
        ),
        (
            "cleanup-workspaces",
            format!(
                "label=openshell.ai/sandbox-namespace={}-gateway",
                document.workspace()
            ),
            true,
        ),
    ] {
        let mut args = strings(&["--host", engine]);
        args.extend(if volumes {
            strings(&["volume", "ls", "--quiet", "--filter"])
        } else {
            strings(&["ps", "--all", "--quiet", "--filter"])
        });
        args.push(filter.into());
        process::execute(&tools.docker, &args, directory, label, environment, cancel).await?;
        if !fs::read(directory.join(format!("{label}.stdout")))
            .map_err(|_| "cannot read cleanup evidence")?
            .iter()
            .all(u8::is_ascii_whitespace)
        {
            return Err("Docker still holds test-owned workloads".into());
        }
    }
    Ok(result.retained)
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
