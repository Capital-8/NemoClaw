// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, Outcome,
    config::{ComputeDriver, Document, Gateway},
};
use serde_json::Value;
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

async fn components(document: &Document, state: &Path, engine: &str) -> Result<()> {
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
        binding("docker_container", "managed_gateway_runtime")?.to_owned(),
        binding(
            "docker_container",
            &format!("inference_service_inference_{service}"),
        )?
        .to_owned(),
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
        containers.push(ids[0].into());
    }
    for id in containers {
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
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires an owned ARM64 Station YAML with real image digests, verified bundle, and unused private run directory; destroys workloads and retains storage"]
async fn station_example_components_are_running() -> Result<()> {
    assert_eq!(
        (std::env::consts::OS, std::env::consts::ARCH),
        ("linux", "aarch64")
    );
    let document = Document::parse(fs::File::open(path("NEMOCLAW_LIVE_STATION_EXAMPLE"))?)?;
    let Gateway::Managed(gateway) = &document.spec.gateway else {
        panic!("requires a managed gateway");
    };
    assert_eq!(gateway.runtime.provider, ComputeDriver::Docker);
    assert_eq!(
        (document.spec.services.len(), document.spec.sandboxes.len()),
        (1, 1)
    );
    let run = path("NEMOCLAW_LIVE_STATION_RUN");
    let mut directory = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(&run)?;
    let state = run.join("state");
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
    result?;
    if cleanup?.outcome != Outcome::Destroyed {
        return Err("destroy did not complete".into());
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
