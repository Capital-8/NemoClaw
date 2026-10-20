// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn prepare(document: Document, uid: &str, agent_image: &str, model_image: &str) -> Document {
    let mut value = serde_json::to_value(document).unwrap();
    assert_eq!(value["spec"]["gateway"]["management"], "managed");
    assert_eq!(value["spec"]["gateway"]["runtime"]["provider"], "docker");
    assert_eq!(
        value["spec"]["gateway"]["engine"],
        "unix:///var/run/docker.sock"
    );
    assert_eq!(value["spec"]["sandboxes"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["spec"]["sandboxes"][0]["harness"]["kind"],
        "nvidia.fabric.openclaw"
    );
    let services = value["spec"]["services"].as_object_mut().unwrap();
    assert_eq!(services.len(), 1);
    let service = services.values_mut().next().unwrap();
    assert_eq!(service["kind"], "vllm");
    assert_eq!(service["hardware"]["profile"], "dgx-station");
    service["image"] = model_image.into();
    value["metadata"]["uid"] = uid.into();
    value["spec"]["sandboxes"][0]["image"]["ref"] = agent_image.into();
    let prepared: Document = serde_json::from_value(value).unwrap();
    prepared.yaml().unwrap();
    prepared
}

fn explicit_path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).expect(name));
    assert!(path.is_absolute(), "{name} must be an absolute path");
    path
}

fn image(name: &str) -> String {
    let value = std::env::var(name).expect(name);
    let (repository, digest) = value
        .split_once("@sha256:")
        .expect("image must use a digest");
    assert!(!repository.is_empty());
    assert!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_ne!(
        digest,
        "0".repeat(64),
        "replace the example's placeholder image"
    );
    value
}

fn fresh_uid() -> String {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn running(state: &Value) -> bool {
    state["Running"] == true
        && state["Status"] == "running"
        && state["Paused"] == false
        && state["Restarting"] == false
        && (state.get("Health").is_none() || state["Health"]["Status"] == "healthy")
}

async fn docker(engine: &str, arguments: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("docker")
            .args(["--host", engine])
            .args(arguments)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    if !output.status.success() {
        return Err("Docker observation failed".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

async fn inspect(engine: &str, id: &str, label: &str, owner: &str) -> Result<()> {
    let format = r#"{"id":{{json .Id}},"state":{{json .State}},"labels":{{json .Config.Labels}}}"#;
    let observed: Value = serde_json::from_str(
        &docker(
            engine,
            &["inspect", "--type", "container", "--format", format, id],
        )
        .await?,
    )?;
    if observed["id"] != id || observed["labels"][label] != owner || !running(&observed["state"]) {
        return Err(format!("owned component {id} is not running and healthy").into());
    }
    Ok(())
}

fn bindings(state: &Path) -> Result<BTreeMap<String, Value>> {
    let state: Value = serde_json::from_slice(&fs::read(state.join("terraform.tfstate"))?)?;
    let mut bindings = BTreeMap::new();
    for resource in state["resources"]
        .as_array()
        .ok_or("state has no resources")?
    {
        if resource["mode"] != "managed" {
            continue;
        }
        let address = format!(
            "{}.{}",
            resource["type"].as_str().ok_or("missing resource type")?,
            resource["name"].as_str().ok_or("missing resource name")?
        );
        let instances = resource["instances"]
            .as_array()
            .ok_or("missing resource instances")?;
        if instances.len() != 1 {
            return Err("expected one current resource instance".into());
        }
        bindings.insert(address, instances[0]["attributes"].clone());
    }
    Ok(bindings)
}

async fn components(document: &Document, state: &Path) -> Result<()> {
    let authored = serde_json::to_value(document)?;
    let engine = authored["spec"]["gateway"]["engine"]
        .as_str()
        .ok_or("missing Docker engine")?;
    let bound = bindings(state)?;
    let service = document
        .spec
        .services
        .keys()
        .next()
        .ok_or("missing vLLM service")?;
    for address in [
        "docker_container.managed_gateway_runtime".to_owned(),
        format!("docker_container.inference_service_inference_{service}"),
    ] {
        let id = bound
            .get(&address)
            .and_then(|row| row["id"].as_str())
            .ok_or_else(|| format!("missing component {address}"))?;
        inspect(
            engine,
            id,
            "nemoclaw.nvidia.com/uid",
            &document.metadata.uid,
        )
        .await?;
    }
    let address = format!("openshell_sandbox.{}", document.spec.sandboxes[0].name);
    let id = bound
        .get(&address)
        .and_then(|row| row["id"].as_str())
        .ok_or("missing sandbox binding")?;
    for role in ["sandbox", "supervisor"] {
        let selected = docker(
            engine,
            &[
                "ps",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                "label=openshell.ai/managed-by=openshell",
                "--filter",
                &format!("label=openshell.ai/sandbox-id={id}"),
                "--filter",
                &format!("label=openshell.ai/isolation-role={role}"),
            ],
        )
        .await?;
        let containers: Vec<_> = selected.lines().collect();
        if containers.len() != 1 {
            return Err(format!("expected one owned {role} container").into());
        }
        inspect(engine, containers[0], "openshell.ai/sandbox-id", id).await?;
    }
    Ok(())
}

async fn cli(bundle: &Path, state: &Path, operation: &str, config: Option<&Path>) -> Result<()> {
    let mut command = tokio::process::Command::new(bundle.join("bin/nemoclaw"));
    command
        .args([operation, "--state-dir"])
        .arg(state)
        .kill_on_drop(true);
    if let Some(config) = config {
        command.arg(config);
    }
    let budget = if operation == "destroy" { 600 } else { 5400 };
    let output = tokio::time::timeout(Duration::from_secs(budget), command.output()).await??;
    if !output.status.success() {
        return Err(
            format!("nemoclaw {operation} failed; inspect the private deployment state").into(),
        );
    }
    let result: Value = serde_json::from_slice(&output.stdout)?;
    let outcome = if operation == "destroy" {
        "destroyed"
    } else {
        "succeeded"
    };
    if result["outcome"] != outcome {
        return Err(format!("nemoclaw {operation} did not complete").into());
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an owned ARM64 DGX Station VM, example path, verified bundle, two local image digests, and unused run directory; destroys workloads and retains storage"]
async fn station_example_components_are_running() -> Result<()> {
    assert_eq!(std::env::consts::OS, "linux");
    assert_eq!(std::env::consts::ARCH, "aarch64");
    let source = explicit_path("NEMOCLAW_LIVE_STATION_EXAMPLE");
    let run = explicit_path("NEMOCLAW_LIVE_STATION_RUN");
    let bundle = explicit_path("NEMOCLAW_TEST_BUNDLE");
    let document = prepare(
        Document::parse(fs::File::open(source)?)?,
        &fresh_uid(),
        &image("NEMOCLAW_LIVE_STATION_AGENT_IMAGE"),
        &image("NEMOCLAW_LIVE_STATION_MODEL_IMAGE"),
    );
    fs::create_dir(&run)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&run, fs::Permissions::from_mode(0o700))?;
    }
    let config = run.join("deployment.yaml");
    fs::write(&config, document.yaml()?)?;
    let state = run.join("state");
    let result = async {
        cli(&bundle, &state, "apply", Some(&config)).await?;
        components(&document, &state).await
    }
    .await;
    let cleanup = cli(&bundle, &state, "destroy", None).await;
    if let Err(error) = &cleanup {
        eprintln!("Workload cleanup failed: {error}");
    }
    result?;
    cleanup
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
        ("Health", serde_json::json!({"Status": "unhealthy"})),
        ("Health", serde_json::json!({"Status": "starting"})),
    ] {
        let mut invalid = state.clone();
        invalid[field] = value;
        assert!(!running(&invalid), "{field}");
    }
    let mut healthy = state;
    healthy["Health"] = serde_json::json!({"Status": "healthy"});
    assert!(running(&healthy));
}

#[test]
fn prepares_a_private_station_copy_with_fresh_identity_and_built_images() {
    let source = include_str!("../../../examples/gtc-dc/openclaw-dgx-station.yaml");
    let original = Document::parse(source.as_bytes()).unwrap();
    let uid = "909c54ab-d541-4c5a-bb63-2ea4c2f9ca80";
    let agent_image = format!("nc-fabric@sha256:{}", "a".repeat(64));
    let model_image = format!("nc-prototype-vllm@sha256:{}", "b".repeat(64));
    let prepared = prepare(original.clone(), uid, &agent_image, &model_image);
    let mut actual = serde_json::to_value(&prepared).unwrap();
    assert_eq!(actual["metadata"]["uid"], uid);
    assert_eq!(actual["spec"]["sandboxes"][0]["image"]["ref"], agent_image);
    assert_eq!(actual["spec"]["services"]["super"]["image"], model_image);
    let expected = serde_json::to_value(original).unwrap();
    actual["metadata"]["uid"] = expected["metadata"]["uid"].clone();
    actual["spec"]["sandboxes"][0]["image"] = expected["spec"]["sandboxes"][0]["image"].clone();
    actual["spec"]["services"]["super"]["image"] =
        expected["spec"]["services"]["super"]["image"].clone();
    assert_eq!(
        actual, expected,
        "preserve the example's deployment behavior"
    );
    Document::parse(prepared.yaml().unwrap().as_bytes()).unwrap();
}
