// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, OperationResult, Outcome,
    config::{ComputeDriver, Document, Gateway},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).expect(name));
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}

fn running(state: &Value) -> bool {
    state["Running"] == true
        && state["Status"] == "running"
        && state["Paused"] == false
        && state["Restarting"] == false
        && (state.get("Health").is_none() || state["Health"]["Status"] == "healthy")
}

fn finish(
    observed: Result<Value>,
    cleanup: Result<OperationResult>,
    file: &Path,
    document: &Document,
    configuration: &[u8],
    state: &Path,
) -> Result<()> {
    let components = observed?;
    let cleanup = cleanup?;
    if cleanup.outcome != Outcome::Destroyed || !cleanup.deferred.is_empty() {
        return Err("destroy did not complete".into());
    }
    let configuration_sha256: String = Sha256::digest(configuration)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    fs::write(
        file,
        json!({
            "schemaVersion":1,"test":"station_example_components_are_running",
            "deploymentUid":document.metadata.uid,"stateDirectory":state,
            "configurationSha256":configuration_sha256,
            "outcome":"passed","destroy":"succeeded","components":components
        })
        .to_string(),
    )?;
    Ok(())
}

async fn docker(engine: &str, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("docker")
            .args(["--host", engine])
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    if !output.status.success() {
        return Err("Docker observation failed".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

async fn components(document: &Document, state: &Path, engine: &str) -> Result<Value> {
    let state: Value = serde_json::from_slice(&fs::read(state.join("terraform.tfstate"))?)?;
    let resources = state["resources"]
        .as_array()
        .ok_or("missing deployment resources")?;
    let binding = |kind: &str, name: &str| -> Result<&str> {
        resources
            .iter()
            .find(|r| r["mode"] == "managed" && r["type"] == kind && r["name"] == name)
            .and_then(|r| r["instances"][0]["attributes"]["id"].as_str())
            .ok_or_else(|| format!("missing {kind}.{name}").into())
    };
    let service = document
        .spec
        .services
        .keys()
        .next()
        .ok_or("missing model service")?;
    let mut containers = vec![
        (
            "gateway",
            binding("docker_container", "managed_gateway_runtime")?.to_owned(),
        ),
        (
            "model",
            binding(
                "docker_container",
                &format!("inference_service_inference_{service}"),
            )?
            .to_owned(),
        ),
    ];
    let sandbox = binding("openshell_sandbox", &document.spec.sandboxes[0].name)?;
    for role in ["sandbox", "supervisor"] {
        let ids = docker(
            engine,
            &[
                "ps",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                "label=openshell.ai/managed-by=openshell",
                "--filter",
                &format!("label=openshell.ai/sandbox-id={sandbox}"),
                "--filter",
                &format!("label=openshell.ai/isolation-role={role}"),
            ],
        )
        .await?;
        let ids: Vec<_> = ids.lines().collect();
        if ids.len() != 1 {
            return Err(format!("expected one owned {role} container").into());
        }
        containers.push((role, ids[0].to_owned()));
    }
    let mut observations = serde_json::Map::new();
    for (role, id) in containers {
        let state = docker(
            engine,
            &[
                "inspect",
                "--type",
                "container",
                "--format",
                "{{json .State}}",
                &id,
            ],
        )
        .await?;
        if !running(&serde_json::from_str(&state)?) {
            return Err(format!("component {id} is not running and healthy").into());
        }
        observations.insert(role.into(), json!({"id":id,"running":true,"healthy":true}));
    }
    Ok(observations.into())
}

#[tokio::test]
#[ignore = "requires an owned ARM64 Station YAML with real image digests, verified bundle, and unused private run directory; destroys workloads and retains storage"]
async fn station_example_components_are_running() -> Result<()> {
    assert_eq!(
        (std::env::consts::OS, std::env::consts::ARCH),
        ("linux", "aarch64")
    );
    let configuration = fs::read(path("NEMOCLAW_LIVE_STATION_EXAMPLE"))?;
    let document = Document::parse(configuration.as_slice())?;
    let state = path("NEMOCLAW_LIVE_STATION_STATE");
    let receipt = path("NEMOCLAW_LIVE_STATION_RESULT");
    let Gateway::Managed(gateway) = &document.spec.gateway else {
        panic!("requires a managed gateway");
    };
    assert_eq!(gateway.runtime.provider, ComputeDriver::Docker);
    assert_eq!(
        (document.spec.services.len(), document.spec.sandboxes.len()),
        (1, 1)
    );
    let run = path("NEMOCLAW_LIVE_STATION_RUN");
    let directory = &mut fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(&run)?;
    let deployment = Deployment::new(&state, &path("NEMOCLAW_TEST_BUNDLE"));
    let result = async {
        let applied = deployment
            .apply(&document, &CancellationToken::new())
            .await?;
        if applied.outcome != Outcome::Succeeded || !applied.deferred.is_empty() {
            return Err("apply did not complete".into());
        }
        components(&document, &state, &gateway.engine).await
    }
    .await;
    let cleanup = deployment.destroy(&CancellationToken::new()).await;
    if let Err(error) = &cleanup {
        eprintln!("Workload cleanup failed: {error}");
    }
    finish(
        result,
        cleanup.map_err(Into::into),
        &receipt,
        &document,
        &configuration,
        &state,
    )
}

#[test]
fn writes_the_cologit_receipt_after_successful_observation_and_destroy() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("result.json");
    let state = directory.path().join("retained-state");
    let document =
        Document::parse(&include_bytes!("../../../examples/gtc-dc/hermes-dgx-station.yaml")[..])?;
    let components: Value = ["gateway", "model", "sandbox", "supervisor"]
        .into_iter()
        .enumerate()
        .map(|(i, role)| {
            (
                role.to_owned(),
                json!({"id":format!("{:064x}",i+1),"running":true,"healthy":true}),
            )
        })
        .collect();
    let cleanup = serde_json::from_value(json!({"outcome":"destroyed","changes":[]}))?;
    finish(
        Ok(components.clone()),
        Ok(cleanup),
        &file,
        &document,
        b"abc",
        &state,
    )?;
    let receipt: Value = serde_json::from_slice(&fs::read(file)?)?;
    assert_eq!(
        receipt,
        json!({
            "schemaVersion":1,"test":"station_example_components_are_running",
            "deploymentUid":document.metadata.uid,"stateDirectory":state,
            "configurationSha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "outcome":"passed","destroy":"succeeded","components":components
        })
    );
    Ok(())
}

#[test]
fn failed_observation_or_cleanup_never_writes_a_passing_receipt() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("result.json");
    let state = directory.path().join("retained-state");
    let document =
        Document::parse(&include_bytes!("../../../examples/gtc-dc/hermes-dgx-station.yaml")[..])?;
    let destroyed: OperationResult =
        serde_json::from_value(json!({"outcome":"destroyed","changes":[]}))?;
    let mut incomplete = destroyed.clone();
    incomplete.outcome = Outcome::Succeeded;
    let mut deferred = destroyed.clone();
    deferred.deferred.push("workload teardown".into());
    for (observed, cleanup) in [
        (Err("component observation failed".into()), Ok(destroyed)),
        (Ok(Value::Null), Err("destroy failed".into())),
        (Ok(Value::Null), Ok(incomplete)),
        (Ok(Value::Null), Ok(deferred)),
    ] {
        assert!(finish(observed, cleanup, &file, &document, b"abc", &state).is_err());
        assert!(!file.exists());
    }
    Ok(())
}

#[test]
fn rejects_stopped_paused_restarting_and_unhealthy_components() {
    let state = serde_json::json!({"Running": true, "Status": "running", "Paused": false, "Restarting": false});
    assert!(running(&state));
    for (field, value) in [
        ("Running", serde_json::json!(false)),
        ("Status", serde_json::json!("exited")),
        ("Paused", serde_json::json!(true)),
        ("Restarting", serde_json::json!(true)),
        ("Health", serde_json::json!({"Status":"unhealthy"})),
        ("Health", serde_json::json!({"Status":"starting"})),
    ] {
        let mut invalid = state.clone();
        invalid[field] = value;
        assert!(!running(&invalid), "{field}");
    }
    let mut healthy = state;
    healthy["Health"] = serde_json::json!({"Status":"healthy"});
    assert!(running(&healthy));
}
