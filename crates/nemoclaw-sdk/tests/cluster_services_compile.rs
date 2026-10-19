// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Cluster model services compile to the Kubernetes provider's objects, fed by
//! the runtime contract, in the deployment's single OpenTofu root.

use nemoclaw_sdk::{compile, config::Document};
use serde_json::json;

fn document(kind: &str) -> Document {
    Document::parse(match kind {
        "vllm" => include_bytes!("../../test-support/cluster-models/vllm.yaml").as_slice(),
        "ollama" => include_bytes!("../../test-support/cluster-models/ollama.yaml").as_slice(),
        _ => unreachable!(),
    })
    .unwrap()
}

fn generations() -> compile::Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_storage",
        "kubernetes_gateway",
        "inference_service",
        "ollama_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

fn source(kind: &str) -> &'static str {
    match kind {
        "vllm" => "vllm_runtime",
        _ => "ollama_runtime",
    }
}

#[test]
fn a_cluster_service_runs_the_runtime_contract_as_kubernetes_objects() {
    for kind in ["vllm", "ollama"] {
        let document = document(kind);
        let graph = compile::compile_runtime(&document, &generations(), "0.1.0").unwrap();
        assert_eq!(
            graph["terraform"]["required_providers"]["kubernetes"],
            json!({"source": "registry.opentofu.org/hashicorp/kubernetes", "version": "= 3.3.0"})
        );
        // The authored kubeconfig and context only; no ambient settings.
        assert_eq!(
            graph["provider"]["kubernetes"],
            json!({"config_path": "${var.nemoclaw_kubeconfig}", "config_context": "replace-with-explicit-context"})
        );
        assert!(
            graph["terraform"]["required_providers"]
                .get("docker")
                .is_none()
        );
        let source = source(kind);
        assert!(graph["data"][source]["qwen"].is_object(), "{kind}");
        let launch = |field: &str| json!(format!("${{data.{source}.qwen.launch.{field}}}"));
        let name = nemoclaw_sdk::services::cluster::name(&document, "qwen");
        let namespace = format!("nemoclaw-local-{kind}");

        let claim = &graph["resource"]["kubernetes_persistent_volume_claim_v1"]["qwen"];
        assert_eq!(claim["metadata"][0]["name"], format!("{name}-data"));
        assert_eq!(claim["metadata"][0]["namespace"], namespace);
        assert_eq!(claim["wait_until_bound"], false);
        assert_eq!(claim["lifecycle"]["prevent_destroy"], true);
        assert_eq!(
            claim["depends_on"],
            json!(["openshell_kubernetes_storage.runtime"])
        );

        let deployment = &graph["resource"]["kubernetes_deployment_v1"]["qwen"];
        let spec = &deployment["spec"][0];
        assert_eq!(spec["replicas"], "1");
        assert_eq!(spec["strategy"][0]["type"], "Recreate");
        assert_eq!(deployment["wait_for_rollout"], true);
        assert_eq!(
            deployment["metadata"][0]["labels"]["nemoclaw.nvidia.com/generation"],
            "a".repeat(32)
        );
        let pod = &spec["template"][0]["spec"][0];
        assert_eq!(pod["automount_service_account_token"], false);
        assert_eq!(pod["node_selector"]["kubernetes.io/arch"], "amd64");
        assert_eq!(pod["node_selector"]["kubernetes.io/os"], "linux");
        assert_eq!(
            pod["toleration"],
            json!([{"key": "nvidia.com/gpu", "operator": "Exists", "value": "", "effect": "NoSchedule"}])
        );
        let container = &pod["container"][0];
        assert_eq!(container["command"], launch("entrypoint"));
        assert_eq!(container["args"], launch("command"));
        assert_eq!(container["port"][0]["container_port"], launch("port"));
        assert_eq!(
            container["readiness_probe"][0]["exec"][0]["command"],
            launch("ready_command")
        );
        assert!(container.get("liveness_probe").is_none());
        assert_eq!(
            container["resources"][0],
            json!({
                "requests": {"cpu": "1", "memory": "32Gi"},
                "limits": {"cpu": "4", "memory": "64Gi", "nvidia.com/gpu": "1"},
            })
        );
        assert_eq!(
            container["dynamic"]["env"]["for_each"],
            launch("environment")
        );
        let environment = container["env"].as_array().unwrap();
        assert!(
            environment.contains(&json!({"name": "NEMOCLAW_RUNTIME_ON_STOP", "value": "hold"}))
        );
        let key = environment
            .iter()
            .find(|variable| variable.get("value_from").is_some());
        if kind == "vllm" {
            assert_eq!(
                key.unwrap(),
                &json!({"name": launch("key_env"), "value_from": [{"secret_key_ref": [{"name": "qwen-inference-key", "key": "key"}]}]})
            );
        } else {
            assert!(key.is_none());
        }
        assert_eq!(
            container["security_context"][0],
            json!({"allow_privilege_escalation": false, "capabilities": [{"drop": ["ALL"]}]})
        );
        assert_eq!(
            pod["volume"][0]["persistent_volume_claim"][0]["claim_name"],
            format!("{name}-data")
        );
        // The policy exists before the server can accept connections.
        assert_eq!(
            deployment["depends_on"],
            json!([
                "openshell_kubernetes_storage.runtime",
                "kubernetes_persistent_volume_claim_v1.qwen",
                "kubernetes_network_policy_v1.qwen"
            ])
        );

        let service = &graph["resource"]["kubernetes_service_v1"]["qwen"];
        assert_eq!(service["metadata"][0]["name"], name);
        assert_eq!(service["spec"][0]["type"], "ClusterIP");
        assert_eq!(
            service["spec"][0]["selector"],
            spec["selector"][0]["match_labels"]
        );

        let policy = &graph["resource"]["kubernetes_network_policy_v1"]["qwen"]["spec"][0];
        assert_eq!(policy["policy_types"], json!(["Ingress"]));
        assert_eq!(
            policy["ingress"][0]["from"][0]["pod_selector"][0]["match_labels"],
            json!({"openshell.ai/managed-by": "openshell", "openshell.ai/boundary-role": "supervisor"})
        );
        assert_eq!(
            policy["pod_selector"][0]["match_labels"],
            spec["selector"][0]["match_labels"]
        );
    }
}

#[test]
fn agents_wait_for_the_model_rollout_and_reach_it_by_its_service_address() {
    for kind in ["vllm", "ollama"] {
        let document = document(kind);
        let graph = compile::compile(&document, &generations(), "0.1.0").unwrap();
        // Every object waits on the apply-time gateway read, which waits on
        // every runtime resource, the model Deployment's rollout included.
        let gates = graph["data"]["openshell_gateway"]["apply"]["depends_on"]
            .as_array()
            .unwrap();
        for address in [
            "kubernetes_deployment_v1.qwen",
            "kubernetes_persistent_volume_claim_v1.qwen",
            "kubernetes_service_v1.qwen",
            "kubernetes_network_policy_v1.qwen",
        ] {
            assert!(gates.contains(&json!(address)), "{kind}: {address}");
        }
        let inference = graph["resource"]["openshell_inference"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap();
        let name = nemoclaw_sdk::services::cluster::name(&document, "qwen");
        assert!(
            inference["server"]["endpoint"]
                .as_str()
                .unwrap()
                .starts_with(&format!(
                    "http://{name}.nemoclaw-local-{kind}.svc.cluster.local:"
                )),
            "{inference}"
        );
        assert_eq!(
            inference["server"]["credential_env"],
            if kind == "vllm" {
                "QWEN_INFERENCE_KEY"
            } else {
                ""
            },
        );
    }
}

#[test]
fn teardown_keeps_only_the_established_model_volume() {
    for kind in ["vllm", "ollama"] {
        let document = document(kind);
        let all = compile::runtime_targets(&document, &generations())
            .unwrap()
            .into_iter()
            .map(|target| target.address)
            .collect();
        let teardown = compile::compile_teardown(&document, &generations(), "0.1.0", &all).unwrap();
        assert_eq!(
            teardown.retained,
            [
                "kubernetes_persistent_volume_claim_v1.qwen".into(),
                "openshell_kubernetes_storage.runtime".into()
            ]
            .into()
        );
        let resources = &teardown.graph["resource"];
        assert_eq!(
            resources["kubernetes_persistent_volume_claim_v1"]["qwen"]["lifecycle"]["prevent_destroy"],
            true
        );
        for kind in [
            "kubernetes_deployment_v1",
            "kubernetes_service_v1",
            "kubernetes_network_policy_v1",
        ] {
            assert!(resources.get(kind).is_none(), "{kind}");
        }
        assert!(teardown.graph["provider"]["kubernetes"].is_object());
        // A volume the state never recorded is not created during teardown.
        let partial = compile::compile_teardown(
            &document,
            &generations(),
            "0.1.0",
            &["openshell_kubernetes_storage.runtime".into()].into(),
        )
        .unwrap();
        assert!(
            partial.graph["resource"]
                .get("kubernetes_persistent_volume_claim_v1")
                .is_none()
        );
    }
}

#[test]
fn authored_values_never_become_template_expressions() {
    let mut input = serde_json::to_value(document("vllm")).unwrap();
    input["spec"]["services"]["qwen"]["kubernetes"]["nodeSelector"] = json!({"pool": "a${b}"});
    let document = Document::parse(input.to_string().as_bytes());
    // Labels cannot contain `$`; a storage class can't either. The context can.
    assert!(document.is_err());
    let mut input = serde_json::to_value(self::document("vllm")).unwrap();
    input["spec"]["gateway"]["kubernetes"]["context"] = json!("ctx-${x}");
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    let graph = compile::compile_runtime(&document, &generations(), "0.1.0").unwrap();
    assert_eq!(
        graph["provider"]["kubernetes"]["config_context"],
        "ctx-$${x}"
    );
}

/// A kubeconfig named `name` for the API at `endpoint`, under the fixture's context.
fn kubeconfig(directory: &std::path::Path, name: &str, endpoint: &str) -> String {
    let path = directory.join(name);
    std::fs::write(
        &path,
        json!({"apiVersion":"v1", "kind":"Config",
            "clusters":[{"name":"fixture", "cluster":{"server":endpoint}}],
            "contexts":[{"name":"replace-with-explicit-context", "context":{"cluster":"fixture", "user":"fixture"}}],
            "users":[{"name":"fixture", "user":{}}]})
        .to_string(),
    )
    .unwrap();
    path.to_string_lossy().into_owned()
}

struct Kubeconfig(String);
impl nemoclaw_sdk::Secrets for Kubeconfig {
    fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn reapply_imports_only_this_deployments_retained_model_volume() {
    use nemoclaw_sdk::kubernetes::models::retained_claim_imports;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let document = document("vllm");
    let objects = crate::kube_api::Objects::default();
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let secrets = Kubeconfig(kubeconfig(directory.path(), "fixture", &fixture.endpoint));
    let unbound = Default::default();
    // A first apply creates the volume.
    assert!(
        retained_claim_imports(&document, &secrets, &unbound)
            .await
            .unwrap()
            .is_empty()
    );
    let claim = format!(
        "{}-data",
        nemoclaw_sdk::services::cluster::name(&document, "qwen")
    );
    let volume = |owner: &str| {
        json!({"apiVersion":"v1", "kind":"PersistentVolumeClaim",
            "metadata":{"name": claim, "namespace":"nemoclaw-local-vllm",
                "labels":{"nemoclaw.nvidia.com/uid": owner}}})
    };
    // After destroy the volume remains and the state no longer records it.
    objects.insert(volume(&document.metadata.uid));
    assert_eq!(
        retained_claim_imports(&document, &secrets, &unbound)
            .await
            .unwrap(),
        [json!({
            "to": "kubernetes_persistent_volume_claim_v1.qwen",
            "id": format!("nemoclaw-local-vllm/{claim}"),
        })]
    );
    // A recorded volume needs no import, and no cluster read.
    let bound = ["kubernetes_persistent_volume_claim_v1.qwen".to_owned()].into();
    let unreachable = Kubeconfig(kubeconfig(
        directory.path(),
        "unreachable",
        "https://127.0.0.1:9",
    ));
    assert!(
        retained_claim_imports(&document, &unreachable, &bound)
            .await
            .unwrap()
            .is_empty()
    );
    // Someone else's volume at that name is never adopted.
    objects.insert(volume("another-deployment"));
    let error = retained_claim_imports(&document, &secrets, &unbound)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("belongs to another owner"), "{error}");
}
