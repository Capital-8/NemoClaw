// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema};
use nemoclaw_sdk::services::KubernetesService;
use serde_json::{Value, json};

/// A managed cluster service beside a managed Kubernetes gateway, whose
/// sandbox still uses the hosted provider.
fn cluster_document(kind: &str) -> Value {
    let mut document: Value = serde_saphyr::from_str(include_str!(
        "../../../examples/kubernetes/managed-development.yaml"
    ))
    .unwrap();
    let source = match kind {
        "vllm" => include_str!("../../../examples/spark/vllm.yaml"),
        "ollama" => include_str!("../../../examples/managed-ollama-gpu.yaml"),
        _ => unreachable!(),
    };
    let source: Value = serde_saphyr::from_str(source).unwrap();
    document["spec"]["services"] = source["spec"]["services"].clone();
    document["spec"]["services"]["qwen"]["container"] =
        json!({"cpuLimitMillis": 4000, "memoryLimitGiB": 64});
    document["spec"]["services"]["qwen"]["kubernetes"] = json!({
        "cpuRequestMillis": 1000,
        "memoryRequestGiB": 32,
        "storageGiB": 100,
        "storageClass": "model-cache",
        "runtimeClassName": "nvidia",
        "nodeSelector": {"accelerator.example.com/pool": "inference"},
        "tolerations": [{"key": "nvidia.com/gpu", "operator": "Exists", "effect": "NoSchedule"}]
    });
    document
}

fn fixture(kind: &str) -> Value {
    serde_saphyr::from_str(match kind {
        "vllm" => include_str!("../../test-support/cluster-models/vllm.yaml"),
        "ollama" => include_str!("../../test-support/cluster-models/ollama.yaml"),
        _ => unreachable!(),
    })
    .unwrap()
}

fn parse_error(input: &Value) -> String {
    Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string()
}

#[test]
fn cluster_model_services_accept_explicit_capacity_storage_and_scheduling() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for kind in ["vllm", "ollama"] {
        for driver in ["kubernetes", "openshift"] {
            let mut input = cluster_document(kind);
            input["spec"]["gateway"]["runtime"]["provider"] = json!(driver);
            assert!(validator.is_valid(&input), "{kind} on {driver}");
            let document = Document::parse(input.to_string().as_bytes()).unwrap();
            let exported = serde_json::to_value(&document).unwrap();
            let (authored, exported) = (
                &input["spec"]["services"]["qwen"],
                &exported["spec"]["services"]["qwen"],
            );
            for field in ["cpuLimitMillis", "memoryLimitGiB"] {
                assert_eq!(exported["container"][field], authored["container"][field]);
            }
            assert_eq!(exported["kubernetes"], authored["kubernetes"]);
            assert_eq!(
                Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
                document
            );
        }
    }
}

#[test]
fn cluster_services_require_limits_capacity_and_compatible_execution_settings() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for kind in ["vllm", "ollama"] {
        for (mapping, field) in [
            ("kubernetes", "cpuRequestMillis"),
            ("container", "cpuLimitMillis"),
            ("kubernetes", "memoryRequestGiB"),
            ("container", "memoryLimitGiB"),
            ("kubernetes", "storageGiB"),
        ] {
            let mut input = cluster_document(kind);
            input["spec"]["services"]["qwen"][mapping]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(!validator.is_valid(&input), "missing {mapping}.{field}");
            assert!(Document::parse(input.to_string().as_bytes()).is_err());
        }
        // Docker defaults omitted limits; a cluster service must declare both.
        let mut input = cluster_document(kind);
        input["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove("container");
        let error = parse_error(&input);
        assert!(
            error.starts_with("configuration violates schema at spec.services.qwen (")
                && error.ends_with("cluster model services require container.cpuLimitMillis"),
            "{error}"
        );
        // The old cluster layout held limits and policy in kubernetes.
        for field in [
            "cpuLimitMillis",
            "memoryLimitGiB",
            "updatePolicy",
            "imageMetadata",
        ] {
            let mut input = cluster_document(kind);
            input["spec"]["services"]["qwen"]["kubernetes"][field] = json!("unknown");
            assert!(!validator.is_valid(&input), "kubernetes.{field}");
            assert!(parse_error(&input).ends_with("unknown fields are not allowed"));
        }
        for variation in [
            "implicit", "docker", "podman", "external", "host-ipc", "ssh",
        ] {
            let mut input = cluster_document(kind);
            match variation {
                "implicit" => {
                    input["spec"]["services"]["qwen"]
                        .as_object_mut()
                        .unwrap()
                        .remove("kubernetes");
                }
                "docker" | "podman" => {
                    input["spec"]["gateway"] =
                        json!({"management":"managed", "runtime":{"provider":variation}});
                    if variation == "podman" {
                        input["spec"]["gateway"]["engine"] =
                            json!("unix:///run/user/1000/podman/podman.sock");
                    }
                    for sandbox in input["spec"]["sandboxes"].as_array_mut().unwrap() {
                        sandbox["image"].as_object_mut().unwrap().remove("metadata");
                    }
                }
                "external" => {
                    input["spec"]["gateway"] = json!({"management":"external", "runtime":{"provider":"kubernetes"}, "endpoint":"https://gateway.example"});
                }
                "host-ipc" => {
                    input["spec"]["services"]["qwen"]["container"]["ipc"] = json!("host");
                }
                "ssh" => {
                    input["spec"]["services"]["qwen"]["placement"] =
                        json!({"engine":"ssh://gpu@10.0.0.5", "networkCidr":"10.30.0.0/24"});
                    input["spec"]["services"]["qwen"]["publication"] =
                        json!({"endpoint":"http://10.0.0.5:8000/v1", "bindAddress":"10.0.0.5"});
                }
                _ => unreachable!(),
            }
            assert!(
                Document::parse(input.to_string().as_bytes()).is_err(),
                "{kind}: {variation}"
            );
            if variation != "host-ipc" && variation != "ssh" {
                assert!(!validator.is_valid(&input), "{kind}: {variation}");
            }
        }
    }
}

#[test]
fn cluster_requests_and_volumes_must_fit_limits_and_runtime_budgets() {
    for kind in ["vllm", "ollama"] {
        for (request, limit) in [
            ("cpuRequestMillis", "cpuLimitMillis"),
            ("memoryRequestGiB", "memoryLimitGiB"),
        ] {
            let mut input = cluster_document(kind);
            input["spec"]["services"]["qwen"]["kubernetes"][request] = json!(65);
            input["spec"]["services"]["qwen"]["container"][limit] = json!(64);
            assert!(
                parse_error(&input).contains("requests must not exceed their limits"),
                "{kind}: {request} exceeds {limit}"
            );
        }
        let mut input = cluster_document(kind);
        input["spec"]["services"]["qwen"]["container"]["memoryLimitGiB"] = json!(32);
        input["spec"]["services"]["qwen"]["container"]["sharedMemoryGiB"] = json!(33);
        input["spec"]["services"]["qwen"]["kubernetes"]["memoryRequestGiB"] = json!(16);
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        input["spec"]["services"]["qwen"]["container"]["sharedMemoryGiB"] = json!(32);
        Document::parse(input.to_string().as_bytes()).unwrap();
        input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(15);
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        input["spec"]["services"]["qwen"]["kubernetes"]["storageGiB"] = json!(16);
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
}

#[test]
fn cluster_scheduling_rejects_invalid_names_labels_tolerations_and_secrets() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (field, value) in [
        ("runtimeClassName", json!("Invalid Class")),
        ("storageClass", json!("")),
        ("nodeSelector", json!({"not a label": "gpu"})),
        ("nodeSelector", json!({"pool": "not a value"})),
        (
            "tolerations",
            json!([{"key": "gpu", "operator": "Exists", "value": "true"}]),
        ),
        (
            "tolerations",
            json!([{"operator": "Equal", "value": "gpu"}]),
        ),
        (
            "tolerations",
            json!([{"key": "gpu", "operator": "Exists", "effect": "NoSchedule", "tolerationSeconds": 30}]),
        ),
        ("keySecret", json!({"name": "Not A Name", "key": "key"})),
        ("keySecret", json!({"name": "qwen", "key": "a/b"})),
        ("memoryRequestGiB", json!((i64::MAX as u64 >> 30) + 1)),
        ("storageGiB", json!((i64::MAX as u64 >> 30) + 1)),
    ] {
        let mut settings =
            cluster_document("vllm")["spec"]["services"]["qwen"]["kubernetes"].clone();
        settings[field] = value;
        let mut input = cluster_document("vllm");
        input["spec"]["services"]["qwen"]["kubernetes"] = settings.clone();
        assert!(!validator.is_valid(&input), "accepted invalid {field}");
        if let Ok(settings) = serde_json::from_value::<KubernetesService>(settings) {
            assert!(settings.validate().is_err(), "accepted invalid {field}");
        }
    }
}

#[test]
fn cluster_ports_exclude_destinations_openshell_refuses() {
    for port in [2379, 2380, 6443, 10250, 10255] {
        let mut input = cluster_document("ollama");
        input["spec"]["services"]["qwen"]["serving"]["port"] = json!(port);
        assert!(
            parse_error(&input).contains("which OpenShell refuses as destinations"),
            "{port}"
        );
    }
}

#[test]
fn sandboxes_route_to_a_cluster_service_by_its_service_address() {
    for kind in ["vllm", "ollama"] {
        let document = Document::parse(fixture(kind).to_string().as_bytes()).unwrap();
        let provider = &document.spec.inference_providers[0];
        let connection = document.provider_connection(provider).unwrap();
        let name = nemoclaw_sdk::services::cluster::name(&document, "qwen");
        let port = match &document.spec.services["qwen"] {
            nemoclaw_sdk::services::ServiceDefinition::Vllm(service) => service.serving.port,
            nemoclaw_sdk::services::ServiceDefinition::Ollama(service) => service.serving.port,
            _ => unreachable!(),
        };
        assert_eq!(
            connection.endpoint,
            format!("http://{name}.nemoclaw-local-{kind}.svc.cluster.local:{port}/v1")
        );
        // Only the authenticated vLLM server takes the key, from the provider.
        assert_eq!(
            connection.credential.map(|credential| credential.env),
            (kind == "vllm").then(|| "QWEN_INFERENCE_KEY".to_owned())
        );
    }
}

#[test]
fn an_authenticated_cluster_service_needs_its_secret_and_its_key_where_nemoclaw_runs() {
    let mut input = fixture("vllm");
    input["spec"]["services"]["qwen"]["kubernetes"]
        .as_object_mut()
        .unwrap()
        .remove("keySecret");
    assert!(parse_error(&input).contains("requires kubernetes.keySecret"));

    let mut input = fixture("vllm");
    input["spec"]["inferenceProviders"][0]
        .as_object_mut()
        .unwrap()
        .remove("credential");
    assert!(parse_error(&input).contains("requires credential"));

    // Without authentication there is no key to name.
    let mut input = fixture("vllm");
    input["spec"]["services"]["qwen"]
        .as_object_mut()
        .unwrap()
        .remove("authentication");
    assert!(parse_error(&input).contains("applies only to an authenticated vLLM service"));
    input["spec"]["services"]["qwen"]["kubernetes"]
        .as_object_mut()
        .unwrap()
        .remove("keySecret");
    let error = parse_error(&input);
    assert!(
        error.contains(
            "credential with serviceRef applies only to an authenticated cluster vLLM service"
        ) && !error.contains("QWEN_INFERENCE_KEY"),
        "{error}"
    );

    let mut input = fixture("ollama");
    input["spec"]["services"]["qwen"]["kubernetes"]["keySecret"] =
        json!({"name": "qwen", "key": "key"});
    assert!(parse_error(&input).contains("applies only to an authenticated vLLM service"));
}

#[test]
fn a_service_key_with_service_ref_requires_a_cluster_gateway() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let mut input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/managed-ollama-gpu.yaml")).unwrap();
    input["spec"]["inferenceProviders"][0]["credential"] = json!({"env": "QWEN_INFERENCE_KEY"});
    assert!(!validator.is_valid(&input));
    let error = parse_error(&input);
    assert!(
        error.contains("requires a managed Kubernetes or OpenShift gateway")
            && !error.contains("QWEN_INFERENCE_KEY"),
        "{error}"
    );
}

#[test]
fn docker_service_defaults_do_not_add_cluster_settings() {
    for source in [
        include_str!("../../../examples/spark/vllm.yaml"),
        include_str!("../../../examples/managed-ollama-gpu.yaml"),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let value = serde_json::to_value(&document).unwrap();
        assert!(
            value["spec"]["services"]["qwen"]
                .get("kubernetes")
                .is_none()
        );
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
    }
}
