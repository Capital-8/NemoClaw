// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed cluster model services, compiled by the SDK, validate and plan
//! with the bundled Kubernetes, vLLM and Ollama providers: the objects match
//! the Kubernetes provider's schema, and their containers run what the runtime
//! contract says. Planning their creation contacts no cluster.

use nemoclaw_sdk::{bundle::Bundle, compile, config::Document};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

const OBJECTS: [&str; 4] = [
    "kubernetes_persistent_volume_claim_v1",
    "kubernetes_deployment_v1",
    "kubernetes_service_v1",
    "kubernetes_network_policy_v1",
];

async fn tofu(bundle: &Bundle, directory: &Path, arguments: &[&str]) -> std::process::Output {
    let mut command = tokio::process::Command::new(bundle.tofu());
    command
        .args(arguments)
        .current_dir(directory)
        .env_clear()
        .env("PATH", directory.join("empty-path"))
        .env("HOME", directory.join("home"))
        .env("TF_IN_AUTOMATION", "1")
        .env("TF_INPUT", "0")
        .env("CHECKPOINT_DISABLE", "1")
        .env("TF_CLI_CONFIG_FILE", directory.join("providers.tfrc"))
        .kill_on_drop(true);
    // Go plugins on Windows need the system's own settings to start, as the
    // SDK passes them to its providers.
    for name in [
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .expect("OpenTofu timed out")
        .expect("cannot execute the verified bundle's OpenTofu")
}

/// The model objects of a compiled graph and the runtime contracts they read,
/// with the Kubernetes provider pointed at a cluster that does not exist.
fn model_objects(graph: &Value, kubeconfig: &Path) -> Value {
    let mut objects = json!({
        "terraform": {"required_providers": {}},
        "provider": {"kubernetes": {
            "config_path": kubeconfig.to_string_lossy(),
            "config_context": graph["provider"]["kubernetes"]["config_context"],
        }},
        "data": graph["data"],
        "resource": {},
    });
    for name in ["kubernetes", "vllm", "ollama"] {
        objects["terraform"]["required_providers"][name] =
            graph["terraform"]["required_providers"][name].clone();
    }
    for kind in OBJECTS {
        let mut resources = graph["resource"][kind].clone();
        for body in resources.as_object_mut().unwrap().values_mut() {
            // The gateway's namespace storage is not part of this graph.
            body["depends_on"]
                .as_array_mut()
                .unwrap()
                .retain(|address| {
                    OBJECTS
                        .iter()
                        .any(|kind| address.as_str().unwrap().starts_with(kind))
                });
        }
        objects["resource"][kind] = resources;
    }
    objects
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; no cluster"]
async fn cluster_model_objects_plan_with_the_bundled_providers() {
    let input = std::env::var_os("NEMOCLAW_TEST_BUNDLE")
        .expect("NEMOCLAW_TEST_BUNDLE names a verified bundle");
    let bundle = Bundle::open(Path::new(&input)).unwrap();
    for (kind, source) in [
        (
            "vllm",
            include_str!("../../test-support/cluster-models/vllm.yaml"),
        ),
        (
            "ollama",
            include_str!("../../test-support/cluster-models/ollama.yaml"),
        ),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let generations = [
            "workspace",
            "provider",
            "sandbox",
            "kubernetes_storage",
            "kubernetes_gateway",
            "inference_service",
            "ollama_service",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        let graph =
            compile::compile_runtime(&document, &generations, &bundle.manifest.version).unwrap();
        let directory = tempfile::tempdir().unwrap();
        for name in ["empty-path", "home"] {
            fs::create_dir(directory.path().join(name)).unwrap();
        }
        let mirror = serde_json::to_string(
            &bundle
                .directory
                .join("providers")
                .to_string_lossy()
                .replace('\\', "/"),
        )
        .unwrap();
        fs::write(
            directory.path().join("providers.tfrc"),
            format!("provider_installation {{ filesystem_mirror {{ path = {mirror} }} }}\n"),
        )
        .unwrap();
        // Nothing listens on port 9, so any cluster request fails the plan.
        let kubeconfig = directory.path().join("kubeconfig");
        fs::write(
            &kubeconfig,
            json!({"apiVersion":"v1", "kind":"Config",
                "clusters":[{"name":"none", "cluster":{"server":"https://127.0.0.1:9"}}],
                "contexts":[{"name":"replace-with-explicit-context", "context":{"cluster":"none", "user":"none"}}],
                "users":[{"name":"none", "user":{}}]})
            .to_string(),
        )
        .unwrap();
        fs::write(
            directory.path().join("main.tf.json"),
            serde_json::to_vec(&model_objects(&graph, &kubeconfig)).unwrap(),
        )
        .unwrap();
        for arguments in [
            &["init", "-input=false", "-no-color"][..],
            &["validate", "-no-color"],
            &["plan", "-input=false", "-no-color", "-out=plan"],
        ] {
            let output = tofu(&bundle, directory.path(), arguments).await;
            assert!(
                output.status.success(),
                "{kind}: tofu {arguments:?}\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let shown = tofu(&bundle, directory.path(), &["show", "-json", "plan"]).await;
        let plan: Value = serde_json::from_slice(&shown.stdout).unwrap();
        let changes = plan["resource_changes"].as_array().unwrap();
        assert_eq!(changes.len(), 4, "{kind}");
        assert!(
            changes
                .iter()
                .all(|change| change["change"]["actions"] == json!(["create"]))
        );
        let deployment = changes
            .iter()
            .find(|change| change["type"] == "kubernetes_deployment_v1")
            .unwrap();
        let container =
            &deployment["change"]["after"]["spec"][0]["template"][0]["spec"][0]["container"][0];
        assert_eq!(
            container["command"],
            json!(["/usr/local/bin/nemoclaw-runtime"])
        );
        assert_eq!(
            container["readiness_probe"][0]["exec"][0]["command"],
            json!([nemoclaw_runtime::READY_ENTRYPOINT])
        );
        let port = match &document.spec.services["qwen"] {
            nemoclaw_sdk::services::ServiceDefinition::Vllm(service) => service.serving.port,
            nemoclaw_sdk::services::ServiceDefinition::Ollama(service) => service.serving.port,
            _ => unreachable!(),
        };
        assert_eq!(container["port"][0]["container_port"], port);
        let environment: Vec<&str> = container["env"]
            .as_array()
            .unwrap()
            .iter()
            .map(|variable| variable["name"].as_str().unwrap())
            .collect();
        assert!(
            environment.contains(&"NEMOCLAW_RUNTIME_SPEC"),
            "{environment:?}"
        );
        assert_eq!(
            environment.contains(&nemoclaw_runtime::INFERENCE_KEY_ENV),
            kind == "vllm",
            "{environment:?}"
        );
    }
}
