// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::{http_fixture, image_runtime, openshell, tofu::TofuWorkspace};
use nemoclaw_sdk::{bundle, compile, config::Document};
use nemoclaw_test_fixtures::Bundle;
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use serde_json::{Value, json};
use std::{
    fs,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

const GENERATION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTAINER: &str = "fixture-gateway-container";
const IMAGE: &str = "sha256:fixture-image";

async fn tofu(workspace: &TofuWorkspace, label: &str, args: &[&str]) -> Result<(), String> {
    let stdout = fs::File::create(workspace.path().join(format!("{label}.stdout"))).unwrap();
    let stderr = fs::File::create(workspace.path().join(format!("{label}.stderr"))).unwrap();
    let mut command = CommandWrap::from(tokio::process::Command::from(workspace.command()));
    command
        .command_mut()
        .args(args)
        .env_clear()
        .env("TF_CLI_CONFIG_FILE", workspace.path().join("tofu.rc"))
        .env("TF_IN_AUTOMATION", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .env("NEMOCLAW_TEST_INFERENCE_KEY", "fixture-key-never-real")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::JobObject);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(60), child.wait()).await;
    if result.is_err() {
        // Let OpenTofu finish teardown before stopping the subprocess group.
        #[cfg(unix)]
        let _ = child.signal(2);
        let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let status = result
        .map_err(|_| format!("{label} exceeded 60 seconds"))?
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{label} failed: {status}"))
    }
}

/// This slice starts with established workspace and storage identities. Those
/// resources forbid test-driven deletion. Bind their real provider outputs
/// into the workload graph so OpenTofu can tear down every test-owned resource.
fn workload_graph(mut graph: Value, workspace: Value, data_path: &str) -> Value {
    for kind in ["openshell_workspace", "openshell_gateway_storage"] {
        assert_eq!(graph["resource"][kind].as_object().unwrap().len(), 1);
        graph["resource"].as_object_mut().unwrap().remove(kind);
    }
    fn bind(value: &mut Value) {
        match value {
            Value::String(text) => {
                *text = text
                    .replace(
                        "${openshell_workspace.deployment.ref}",
                        "${local.workspace}",
                    )
                    .replace(
                        "${openshell_gateway_storage.runtime.data_path}",
                        "${local.data_path}",
                    );
            }
            Value::Array(items) => {
                items.retain(|item| {
                    !matches!(
                        item.as_str(),
                        Some(
                            "openshell_workspace.deployment" | "openshell_gateway_storage.runtime"
                        )
                    )
                });
                items.iter_mut().for_each(bind);
            }
            Value::Object(fields) => fields.values_mut().for_each(bind),
            _ => {}
        }
    }
    bind(&mut graph);
    graph["locals"] = json!({"workspace":workspace, "data_path":data_path});
    // The compiler declares all native providers; this scenario uses only these.
    for name in ["vllm", "ollama"] {
        graph["provider"].as_object_mut().unwrap().remove(name);
        graph["terraform"]["required_providers"]
            .as_object_mut()
            .unwrap()
            .remove(name);
    }
    graph
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires pinned OpenTofu and real providers from NEMOCLAW_TEST_BUNDLE"]
async fn docker_openclaw_hosted_inference_handoffs() {
    let bundle = Bundle::from_env();
    let verified = bundle::Bundle::open(bundle.root()).unwrap();
    let workspace = TofuWorkspace::with_providers(
        bundle.tofu(),
        &[
            ("openshell", &bundle.provider("openshell")),
            ("fabric", &bundle.provider("fabric")),
            ("host", &bundle.provider("host")),
        ],
    );
    let gateway = openshell::Fixture::start().await;
    let engine_requests = Arc::new(Mutex::new(Vec::new()));
    let engine_seed = Arc::new(Mutex::new(json!({})));
    let requests = engine_requests.clone();
    let seed = engine_seed.clone();
    let engine = http_fixture::Fixture::engine(move |request| {
        requests.lock().unwrap().push(format!("{} {}", request.method, request.path));
        let seed = seed.lock().unwrap();
        let path = request.path.split('?').next().unwrap();
        let value = match (request.method.as_str(), path) {
            ("GET", "/info") => json!({"ID":"fixture-engine", "Architecture":"arm64", "OSType":"linux", "ServerVersion":"28.0", "DockerRootDir":"/var/lib/docker", "NCPU":4, "MemTotal":8589934592_i64}),
            ("GET", path) if path == format!("/images/{}/json", seed["image"]["RepoDigests"][0].as_str().unwrap()) => seed["image"].clone(),
            ("GET", path) if path == format!("/images/{}/json", seed["gateway_image"]["RepoDigests"][0].as_str().unwrap()) => seed["gateway_image"].clone(),
            ("GET", path) if path == format!("/containers/{CONTAINER}/json") => seed["container"].clone(),
            ("GET", path) if path == format!("/volumes/{}", seed["storage"]["Name"].as_str().unwrap()) => seed["storage"].clone(),
            ("GET", path) if path == format!("/networks/{}", seed["network"]["Name"].as_str().unwrap()) => seed["network"].clone(),
            ("GET", path) if path == format!("/containers/{}/json", seed["helper"]["Name"].as_str().unwrap()) => seed["helper"].clone(),
            ("GET", "/containers/fixture-initializer/archive") => {
                let bytes = if request.path.contains("public.pem") { b"fixture-public-key".to_vec() } else { vec![7_u8;32] };
                let mut archive = tar::Builder::new(Vec::new());
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o600);
                header.set_cksum();
                archive.append_data(&mut header, "file", bytes.as_slice()).unwrap();
                return Some((200, archive.into_inner().unwrap()));
            }
            // Every direct engine operation must be an observation. Docker's
            // mocked creates/destroys cannot populate or mutate this fixture.
            _ => return Some((400, br#"{"message":"unexpected engine request"}"#.to_vec())),
        };
        Some((200, serde_json::to_vec(&value).unwrap()))
    }).await;
    let inference_requests = Arc::new(Mutex::new(Vec::new()));
    let requests = inference_requests.clone();
    let inference = http_fixture::Fixture::start_tcp(move |request| {
        requests
            .lock()
            .unwrap()
            .push(format!("{} {}", request.method, request.path));
        Some((400, b"inference is outside this test".to_vec()))
    })
    .await;
    let mut yaml: Value =
        serde_saphyr::from_str(include_str!("../hcl/cases/docker-openclaw-nvidia.yaml")).unwrap();
    yaml["spec"]["sandboxes"]
        .as_object_mut()
        .unwrap()
        .remove("researcher");
    yaml["spec"]["gateway"]["endpoint"] = json!(gateway.endpoint);
    yaml["spec"]["gateway"]["engine"] = json!(engine.endpoint);
    yaml["spec"]["inferenceProviders"]["nvidia"]["endpoint"] =
        json!(format!("{}/v1", inference.endpoint));
    yaml["spec"]["inferenceProviders"]["nvidia"]["credential"]["env"] =
        json!("NEMOCLAW_TEST_INFERENCE_KEY");
    let document = Document::parse(serde_saphyr::to_string(&yaml).unwrap().as_bytes()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "managed_gateway_storage",
    ]
    .map(|kind| (kind.into(), GENERATION.into()))
    .into();
    let compiled = compile::compile(&document, &generations, &verified.manifest.version).unwrap();
    let owner = &document.metadata.uid;
    let name = document.workspace();
    let storage_name = format!("{name}-gateway-data");
    let data_path = format!("/var/lib/docker/volumes/{storage_name}/_data");
    let container = &compiled["resource"]["docker_container"]["managed_gateway_runtime"];
    let alias = container["provider"].as_str().unwrap();
    assert_eq!(compiled["provider"]["docker"][0]["host"], engine.endpoint);
    let alias_name = compiled["provider"]["docker"][0]["alias"].as_str().unwrap();
    assert_eq!(alias, format!("docker.{alias_name}"));
    let images = compiled["resource"]["docker_image"].as_object().unwrap();
    assert_eq!(images.len(), 2);
    let sandbox_image = &document.spec.sandboxes["assistant"].image.ref_;
    let sandbox_pull = images
        .iter()
        .find(|(_, value)| value["name"] == *sandbox_image)
        .unwrap()
        .0;
    for image in images.values() {
        assert_eq!(image["provider"], alias);
        assert_eq!(image["keep_locally"], true);
    }
    let registrations = compiled["resource"]["openshell_inference"]
        .as_object()
        .unwrap();
    assert_eq!(registrations.len(), 1);
    let registration = registrations.keys().next().unwrap();
    assert_eq!(
        compiled["resource"]["openshell_sandbox"]["assistant"]["providers"],
        json!([format!("${{openshell_inference.{registration}.ref}}")])
    );
    assert_eq!(
        compiled["resource"]["fabric_agent"]["assistant"]["sandbox"],
        "${openshell_sandbox.assistant.ref}"
    );
    let labels = json!({"nemoclaw.nvidia.com/uid":owner});
    let storage = &compiled["resource"]["openshell_gateway_storage"]["runtime"];
    let row = storage
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect();
    let spec = nemoclaw_sdk::managed::Spec::from_gateway_row("gateway_storage", &row).unwrap();
    let gateway_pull = images
        .iter()
        .find(|(_, value)| value["name"] == spec.image())
        .unwrap()
        .0;
    let initializer = json!({"Image":spec.image(), "User":"0:0", "Labels":spec.labels().unwrap(), "Entrypoint":["/usr/local/bin/openshell-gateway"], "Cmd":["generate-certs", "--output-dir", format!("{data_path}/tls"), "--server-san", "127.0.0.1"]});
    *engine_seed.lock().unwrap() = json!({
        "image":{"Id":IMAGE, "Os":"linux", "Architecture":"arm64", "RepoDigests":[sandbox_image], "Config":{"Labels":{nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL:serde_json::to_string(&image_runtime::catalog()).unwrap()}}},
        "gateway_image":{"Id":"sha256:fixture-gateway-image", "Os":"linux", "Architecture":"arm64", "RepoDigests":[spec.image()], "Config":{"Labels":{}}},
        "container":{"Id":CONTAINER, "Name":format!("/{}", container["name"].as_str().unwrap()), "Config":{"Labels":labels}, "State":{"Status":"running", "Running":true}},
        "storage":{"Name":storage_name, "Labels":spec.labels().unwrap(), "Mountpoint":data_path, "Driver":"local", "Scope":"local", "CreatedAt":"2026-10-27T00:00:00Z", "Options":{}},
        "network":{"Id":"fixture-network", "Name":spec.network(), "Driver":"bridge", "Internal":false, "EnableIPv6":false, "Labels":spec.labels().unwrap(), "IPAM":{"Driver":"default", "Config":[{"Subnet":spec.network_cidr(), "Gateway":spec.bridge().unwrap()}]}},
        "helper":{"Id":"fixture-initializer", "Name":format!("{}-initialize", spec.name), "Config":initializer, "HostConfig":{"NetworkMode":"none", "CapDrop":["ALL"], "SecurityOpt":["no-new-privileges"]}, "State":{"Status":"exited", "Running":false, "ExitCode":0}, "Mounts":[{"Type":"volume", "Name":storage_name, "Destination":data_path, "RW":true}]},
    });
    let suite = include_str!("../hcl/integration/docker-openclaw-nvidia.tftest.hcl")
        .replace("DOCKER_ALIAS", alias)
        .replace("SANDBOX_PULL", sandbox_pull)
        .replace("GATEWAY_PULL", gateway_pull)
        .replace("INFERENCE_RESOURCE", registration);
    fs::write(workspace.path().join("integration.tftest.hcl"), suite).unwrap();
    // mock_provider still needs Docker's schema, loaded from the pinned bundle.
    let docker = verified
        .manifest
        .files
        .keys()
        .find(|name| name.contains("/kreuzwerker/docker/"))
        .unwrap();
    fs::copy(
        bundle.root().join(docker),
        workspace.path().join(nemoclaw_test_fixtures::executable(
            "terraform-provider-docker",
        )),
    )
    .unwrap();
    let config = format!(
        "provider_installation {{ dev_overrides {{ {} \"registry.opentofu.org/kreuzwerker/docker\" = {} }} }}",
        ["openshell", "fabric", "host"]
            .map(|name| format!(
                "\"registry.opentofu.org/nvidia/{name}\" = {}",
                json!(workspace.path())
            ))
            .join(" "),
        json!(workspace.path())
    );
    fs::write(workspace.path().join("tofu.rc"), config).unwrap();
    // Establish retained prerequisites with real OpenShell resources in their
    // own temporary state. No Docker resources or workloads run in this step.
    let mut prerequisites = json!({
        "terraform":{"required_providers":{"openshell":compiled["terraform"]["required_providers"]["openshell"]}},
        "provider":{"openshell":{}},
        "resource":{"openshell_workspace":compiled["resource"]["openshell_workspace"], "openshell_gateway_storage":compiled["resource"]["openshell_gateway_storage"]},
        "output":{"workspace":{"value":"${openshell_workspace.deployment.ref}"}, "data_path":{"value":"${openshell_gateway_storage.runtime.data_path}"}},
    });
    for instances in prerequisites["resource"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        for resource in instances.as_object_mut().unwrap().values_mut() {
            resource.as_object_mut().unwrap().remove("depends_on");
            resource["lifecycle"] = json!({"prevent_destroy":true});
        }
    }
    fs::create_dir(workspace.path().join("prerequisites")).unwrap();
    fs::write(
        workspace.path().join("prerequisites/main.tf.json"),
        prerequisites.to_string(),
    )
    .unwrap();
    let mut result = tofu(
        &workspace,
        "setup",
        &[
            "-chdir=prerequisites",
            "apply",
            "-auto-approve",
            "-input=false",
            "-no-color",
        ],
    )
    .await;
    if result.is_ok() {
        result = tofu(
            &workspace,
            "outputs",
            &["-chdir=prerequisites", "output", "-json"],
        )
        .await;
    }
    let retained = gateway.state.lock().unwrap().workspaces.get(&name).cloned();
    let retained_state = fs::read(workspace.path().join("prerequisites/terraform.tfstate")).ok();
    if result.is_ok() {
        let outputs: Value =
            serde_json::from_slice(&fs::read(workspace.path().join("outputs.stdout")).unwrap())
                .unwrap();
        assert_eq!(outputs["data_path"]["value"], data_path);
        let graph = workload_graph(
            compiled.clone(),
            outputs["workspace"]["value"].clone(),
            &data_path,
        );
        fs::write(workspace.path().join("main.tf.json"), graph.to_string()).unwrap();
        result = tofu(&workspace, "tofu", &["test", "-no-color", "-verbose"]).await;
    }
    let state = gateway.state.lock().unwrap();
    let evidence = json!({"result":result, "providers":format!("{:?}", state.provider_creates), "sandboxes":format!("{:?}", state.sandbox_creates),
        "exec":state.exec_calls, "exec_sandboxes":state.exec_sandboxes,
        "exec_stdin":state.exec_stdin.iter().map(|bytes|String::from_utf8_lossy(bytes).into_owned()).collect::<Vec<_>>(),
        "engine":*engine_requests.lock().unwrap(), "inference":*inference_requests.lock().unwrap(),
        "remaining":{"workspaces":state.workspaces.keys().collect::<Vec<_>>(), "sandboxes":state.sandboxes.keys().collect::<Vec<_>>(), "providers":state.providers.keys().collect::<Vec<_>>(), "profiles":state.profiles.keys().collect::<Vec<_>>(), "runtimes":state.fabric_runtimes}});
    let checks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Evaluate cleanup even when an HCL assertion fails.
        assert!(state.sandboxes.is_empty(), "sandbox teardown did not run");
        assert!(
            state.providers.is_empty(),
            "registration teardown did not run"
        );
        assert!(state.profiles.is_empty(), "profile teardown did not run");
        assert!(state.fabric_runtimes.is_empty(), "Fabric stop did not run");
        assert!(retained.is_some());
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces.get(&name), retained.as_ref());
        assert!(retained_state.is_some());
        assert_eq!(
            fs::read(workspace.path().join("prerequisites/terraform.tfstate")).ok(),
            retained_state
        );
        assert_eq!(engine_seed.lock().unwrap()["storage"]["Name"], storage_name);
        assert!(
            inference_requests.lock().unwrap().is_empty(),
            "configuration must not invoke inference"
        );
        assert_eq!(state.provider_creates.len(), 1);
        assert_eq!(state.sandbox_creates.len(), 1);
        let provider = &state.provider_creates[0];
        let provider_meta = provider.metadata.as_ref().unwrap();
        assert_eq!(provider_meta.workspace, name);
        assert_eq!(provider_meta.labels["nemoclaw.nvidia.com/uid"], *owner);
        assert_eq!(
            provider.config["OPENAI_BASE_URL"],
            format!("{}/v1", inference.endpoint)
        );
        assert_eq!(
            provider.credentials.values().collect::<Vec<_>>(),
            ["fixture-key-never-real"]
        );
        let sandbox = &state.sandbox_creates[0];
        let meta = sandbox.metadata.as_ref().unwrap();
        assert_eq!(meta.workspace, name);
        assert_eq!(meta.name, "assistant");
        assert_eq!(meta.labels["nemoclaw.nvidia.com/uid"], *owner);
        assert_eq!(meta.labels["nemoclaw.nvidia.com/generation"], GENERATION);
        let launch: Value =
            serde_json::from_str(&meta.annotations["nemoclaw.nvidia.com/launch-v1"]).unwrap();
        assert_eq!(
            launch["metadata"]["nemoclaw.nvidia.com/agent-runtime"],
            "fabric"
        );
        let spec = sandbox.spec.as_ref().unwrap();
        assert_eq!(spec.template.as_ref().unwrap().image, *sandbox_image);
        assert_eq!(spec.providers, std::slice::from_ref(&provider_meta.name));
        assert_eq!(spec.command, ["/opt/fabric/bin/fabric-agent-ctl", "serve"]);
        let policy = spec.policy.as_ref().unwrap();
        let base = image_runtime::policy();
        assert_eq!(policy.filesystem, base.filesystem);
        assert_eq!(policy.process, base.process);
        assert_eq!(policy.network_policies.len(), 1);
        let rule = &policy.network_policies[&provider.r#type];
        assert_eq!(rule.binaries[0].path, "/usr/local/bin/python3.99");
        assert_eq!(rule.endpoints.len(), 1);
        assert_eq!(rule.endpoints[0].host, "127.0.0.1");
        assert_eq!(
            rule.endpoints[0].port,
            inference
                .endpoint
                .rsplit(':')
                .next()
                .unwrap()
                .parse::<u32>()
                .unwrap()
        );
        assert_eq!(rule.endpoints[0].path, "/v1/**");
        assert_eq!(state.exec_calls.len(), 2);
        assert_eq!(state.exec_sandboxes, ["assistant", "assistant"]);
        assert_eq!(
            state.exec_calls[0],
            [
                "/opt/fabric/bin/fabric-agent-ctl",
                "start",
                "--agent",
                "assistant",
                "--config",
                "-"
            ]
        );
        let configured: Value = serde_json::from_slice(&state.exec_stdin[0]).unwrap();
        let expected: Value = serde_json::from_str(
            compiled["resource"]["terraform_data"]["agent_assistant"]["input"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            configured, expected,
            "ExecSandbox stdin must carry the SDK's complete agent configuration"
        );
        assert_eq!(
            configured["harness"]["adapter_id"],
            "nvidia.fabric.openclaw"
        );
        assert_eq!(configured["metadata"]["name"], "assistant");
        assert_eq!(
            configured["models"]["primary"]["base_url"],
            provider.config["OPENAI_BASE_URL"]
        );
        assert_eq!(
            configured["models"]["primary"]["model"],
            "nvidia/nemotron-3.5-super-vl-120b-a12b"
        );
        assert!(
            provider.credentials.contains_key(
                configured["models"]["primary"]["api_key_env"]
                    .as_str()
                    .unwrap()
            )
        );
        assert_eq!(
            state.exec_calls[1],
            [
                "/opt/fabric/bin/fabric-agent-ctl".to_owned(),
                "stop".into(),
                "--agent".into(),
                "assistant".into(),
                "--runtime-id".into(),
                format!("fixture-runtime-{}", meta.id)
            ]
        );
        let requests = engine_requests.lock().unwrap();
        assert!(requests.iter().all(|request| request.starts_with("GET ")));
        assert!(
            requests
                .iter()
                .any(|request| request == &format!("GET /containers/{CONTAINER}/json"))
        );
        assert!(
            requests
                .iter()
                .any(|request| request == &format!("GET /images/{sandbox_image}/json"))
        );
        assert!(state.gateway_reads > 0 && state.health_reads > 0);
        assert!(result.is_ok(), "{result:?}");
    }));
    drop(state);
    // Fixture Drop implementations abort their servers on success and unwind.
    drop(inference);
    drop(engine);
    drop(gateway);
    if checks.is_err() {
        for (file, value) in [("requests.json", evidence), ("compiled.tf.json", compiled)] {
            fs::write(
                workspace.path().join(file),
                value
                    .to_string()
                    .replace("fixture-key-never-real", "[REDACTED]"),
            )
            .unwrap();
        }
        let diagnostics = tempfile::tempdir().unwrap().keep();
        for file in [
            "requests.json",
            "compiled.tf.json",
            "main.tf.json",
            "prerequisites/main.tf.json",
            "prerequisites/terraform.tfstate",
            "integration.tftest.hcl",
            "setup.stdout",
            "setup.stderr",
            "outputs.stdout",
            "outputs.stderr",
            "tofu.stdout",
            "tofu.stderr",
        ] {
            let Ok(text) = fs::read_to_string(workspace.path().join(file)) else {
                continue;
            };
            let destination = diagnostics.join(file);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(
                destination,
                text.replace("fixture-key-never-real", "[REDACTED]"),
            )
            .unwrap();
        }
        panic!("integration evidence: {}", diagnostics.display());
    }
}
