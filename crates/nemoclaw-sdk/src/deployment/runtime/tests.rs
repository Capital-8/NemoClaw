// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{deployment::tests::kubernetes_context, managed::GATEWAY_STORAGE_KIND};

use crate::deployment::plan::check_plan as check_runtime_plan;

const GATEWAY: &str = "openshell_podman_gateway.runtime";

/// The rows a runtime's bindings allow, after the Docker model check.
struct Checked {
    expected: BTreeMap<String, Row>,
}

fn runtime_observations(
    document: &Document,
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
    plan: &Plan,
) -> Result<Checked, Error> {
    let expected = runtime_bindings(targets, bindings)?;
    preserve_models(document, plan)?;
    Ok(Checked { expected })
}

#[test]
fn cluster_model_pod_changes_require_recreate_unless_its_rollout_never_completed() {
    for source in [
        include_str!("../../../../../crates/test-support/cluster-models/vllm.yaml"),
        include_str!("../../../../../crates/test-support/cluster-models/ollama.yaml"),
    ] {
        let preserved = Document::parse(source.as_bytes()).unwrap();
        let mut input = serde_json::to_value(&preserved).unwrap();
        input["spec"]["services"]["qwen"]["updatePolicy"] = json!("Recreate");
        let recreate = Document::parse(input.to_string().as_bytes()).unwrap();
        let deployment = |image: &str, label: &str| {
            json!({
                "metadata": [{"labels": {"nemoclaw.nvidia.com/generation": label}}],
                "spec": [{"template": [{"spec": [{"container": [{"image": image}]}]}]}]
            })
        };
        let running = deployment("model@sha256:a", "one");
        let plan = |actions: Value, after: Value, unknown: Value, reason: Option<&str>| -> Plan {
            serde_json::from_value(json!({"resource_changes": [{
                "address": "kubernetes_deployment_v1.qwen",
                "action_reason": reason,
                "change": {"actions": actions, "before": running, "after": after, "after_unknown": unknown}
            }]}))
            .unwrap()
        };
        let refused = |plan: &Plan| {
            matches!(
                preserve_models(&preserved, plan),
                Err(Error::ClusterModelUpdateRefused { service }) if service == "qwen"
            )
        };
        for (change, disrupts) in [
            // A new image changes the Pod template, which replaces the Pod.
            (
                plan(
                    json!(["update"]),
                    deployment("model@sha256:b", "one"),
                    Value::Null,
                    None,
                ),
                true,
            ),
            // So does any template value known only during apply.
            (
                plan(
                    json!(["update"]),
                    running.clone(),
                    json!({"spec": [{"template": [{"spec": [{"container": [{"image": true}]}]}]}]}),
                    None,
                ),
                true,
            ),
            (
                plan(
                    json!(["delete", "create"]),
                    deployment("model@sha256:b", "one"),
                    Value::Null,
                    Some("replace_because_cannot_update"),
                ),
                true,
            ),
            (
                plan(json!(["delete"]), Value::Null, Value::Null, None),
                true,
            ),
            // A label outside the template leaves the Pod running, even with
            // OpenTofu's structure of known template values beside it.
            (
                plan(
                    json!(["update"]),
                    deployment("model@sha256:a", "two"),
                    json!({"spec": [{"template": [{"spec": [{"container": [{"env": [{"value_from": []}]}]}]}]}]}),
                    None,
                ),
                false,
            ),
            (
                plan(json!(["no-op"]), running.clone(), Value::Null, None),
                false,
            ),
            // A tainted Deployment never completed its rollout.
            (
                plan(
                    json!(["delete", "create"]),
                    deployment("model@sha256:b", "one"),
                    Value::Null,
                    Some("replace_because_tainted"),
                ),
                false,
            ),
        ] {
            assert_eq!(
                refused(&change),
                disrupts,
                "{:?}",
                change.resource_changes[0].change.actions
            );
            preserve_models(&recreate, &change).unwrap();
        }
        // The same service on Docker would be a container; a cluster service
        // has none, so a Docker change at that address is not its update.
        let docker: Plan = serde_json::from_value(json!({"resource_changes": [{
            "address": crate::docker_compute::address(
                &preserved.spec.services["qwen"].model_address("qwen").unwrap()
            ),
            "change": {"actions": ["delete"], "before": {"id": "x", "must_run": true}}
        }]}))
        .unwrap();
        preserve_models(&preserved, &docker).unwrap();
    }
}

#[test]
fn docker_model_updates_preserve_running_containers_unless_recreation_is_explicit() {
    for (source, name, kind) in [
        (
            include_str!("../../../../../examples/station/vllm.yaml"),
            "qwen",
            "inference_service",
        ),
        (
            include_str!("../../../../../examples/managed-ollama.yaml"),
            "ollama-server",
            "ollama_service",
        ),
        // A Podman gateway with a model placed on a Docker engine over SSH.
        (
            include_str!("../../../../../examples/spark/remote-vllm.yaml"),
            "qwen",
            "inference_service",
        ),
    ] {
        let document = Document::parse(source.as_bytes()).unwrap();
        let mut recreate = serde_json::to_value(&document).unwrap();
        recreate["spec"]["services"][name]["updatePolicy"] = json!("Recreate");
        let recreate = Document::parse(recreate.to_string().as_bytes()).unwrap();
        let record = Record::new(document.clone()).unwrap();
        let targets = compile::runtime_targets(&document, &record.generations).unwrap();
        let address = targets
            .iter()
            .find(|target| target.kind == kind)
            .unwrap()
            .address
            .clone();
        let plan = |actions: &Value, before: &Value, after: &Value| -> Plan {
            serde_json::from_value(json!({"resource_changes": [{
                "address": address,
                "change": {"actions": actions, "before": before, "after": after}
            }]}))
            .unwrap()
        };
        let refused = |plan: &Plan| {
            let message = runtime_observations(&document, &targets, &BTreeMap::new(), plan)
                .err()
                .expect("Preserve must refuse disrupting a running or unconfirmed model")
                .to_string();
            for expected in [
                name,
                "updatePolicy: Preserve",
                "updatePolicy: Recreate",
                "downtime",
            ] {
                assert!(message.contains(expected), "missing {expected}: {message}");
            }
            runtime_observations(&recreate, &targets, &BTreeMap::new(), plan).unwrap();
        };
        for actions in [
            json!(["delete", "create"]),
            json!(["create", "delete"]),
            json!(["delete"]),
        ] {
            for before in [
                json!({"id": "existing-model", "must_run": true}),
                json!({"id": "existing-model"}),
            ] {
                refused(&plan(&actions, &before, &Value::Null));
            }
        }
        // Docker lowers memory in place, and the kernel can OOM-kill a model
        // whose usage exceeds the new limit.
        for running in [
            json!({"id": "running-model", "must_run": true}),
            json!({"id": "running-model"}),
        ] {
            for (field, lowered) in [("memory", "memory_swap"), ("memory_swap", "memory")] {
                let mut before = running.clone();
                before["memory"] = json!(65536);
                before["memory_swap"] = json!(65536);
                let mut after = before.clone();
                after["must_run"] = json!(true);
                after[field] = json!(16384);
                after[lowered] = before[lowered].clone();
                refused(&plan(&json!(["update"]), &before, &after));
            }
        }
        // Provider refresh reports a stopped container as must_run=false and a
        // missing container with no prior value. A stopped model container is
        // replaced because its published port also drifts (remote_service
        // e2e). Neither requires downtime, and in-place updates that keep or
        // raise memory do not stop the model.
        let limits = |memory: u64, must_run: bool| json!({"id": "model", "must_run": must_run, "memory": memory, "memory_swap": memory});
        for (actions, before, after) in [
            (
                json!(["delete", "create"]),
                json!({"id": "stopped-model", "must_run": false}),
                Value::Null,
            ),
            (json!(["create"]), Value::Null, limits(65536, true)),
            (json!(["no-op"]), limits(65536, true), limits(65536, true)),
            (json!(["update"]), limits(65536, true), limits(65536, true)),
            (json!(["update"]), limits(16384, true), limits(65536, true)),
            (json!(["update"]), limits(65536, false), limits(16384, true)),
        ] {
            runtime_observations(
                &document,
                &targets,
                &BTreeMap::new(),
                &plan(&actions, &before, &after),
            )
            .unwrap();
        }
        // Replacement cleanup is for a previous instance, not the current model.
        let plan = serde_json::from_value(json!({"resource_changes": [{
            "address": address, "deposed": "old-instance", "change": {
                "actions": ["delete"], "before": {"id": "old-model", "must_run": true}
            }
        }, {
            "address": "docker_container.managed_gateway_runtime", "change": {
                "actions": ["delete", "create"], "before": {"id": "gateway", "must_run": true}
            }
        }, {
            "address": "docker_container.ollama_proxy_proxy", "change": {
                "actions": ["delete", "create"], "before": {"id": "proxy", "must_run": true}
            }
        }]}))
        .unwrap();
        runtime_observations(&document, &targets, &BTreeMap::new(), &plan).unwrap();
    }
}

#[test]
fn kubernetes_gateway_requires_storage_without_replacement() {
    let (document, generations) = kubernetes_context();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let bindings = kubernetes_bindings(&targets);
    let mut plan: Plan = serde_json::from_value(json!({"resource_changes": targets.iter().map(|target| {
        let mut before = serde_json::to_value(&target.values).unwrap();
        before["id"] = json!(bindings[&target.address].id);
        before["running"] = json!("true");
        json!({"address":target.address, "change":{"actions":["no-op"], "before":before, "after":before}})
    }).collect::<Vec<_>>()})).unwrap();
    let checked = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
    assert!(
        check_runtime_plan(&plan, &checked.expected, &bindings)
            .unwrap()
            .is_empty()
    );
    let mut missing = bindings.clone();
    missing.remove(KUBERNETES_STORAGE);
    assert!(runtime_bindings(&targets, &missing).is_err());
    let mut drift = bindings.clone();
    drift.get_mut(KUBERNETES_STORAGE).unwrap().namespace = "elsewhere".into();
    assert!(runtime_bindings(&targets, &drift).is_err());
    for change in &mut plan.resource_changes {
        if change.address == "openshell_kubernetes_gateway.runtime" {
            change.change.actions = vec!["delete".into(), "create".into()];
        }
    }
    assert!(check_runtime_plan(&plan, &checked.expected, &bindings).is_err());
}

#[test]
fn opentofu_can_replace_an_unchanged_gateway_with_retained_storage() {
    let (document, _) = context();
    let (_, targets) = gateway_targets();
    let bindings: BTreeMap<String, StateBinding> = targets
        .iter()
        .map(|target| {
            (
                target.address.clone(),
                bound(format!("physical-{}", target.kind), target),
            )
        })
        .collect();
    // Core may choose replacement after taint or an explicit replacement request,
    // even when the desired process specification has not changed.
    let plan: Plan = serde_json::from_value(json!({"resource_changes": targets.iter().map(|target| json!({
        "address": target.address,
        "change": {
            "actions": if target.kind == GATEWAY_KIND { vec!["delete", "create"] } else { vec!["no-op"] },
            "before": before(&bindings[&target.address])
        }
    })).collect::<Vec<_>>()})).unwrap();
    let checked = runtime_observations(&document, &targets, &bindings, &plan).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &checked.expected, &bindings)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn bound_podman_gateway_requires_its_retained_storage_binding() {
    let (_, targets) = gateway_targets();
    let gateway = &targets[1];
    let bindings = BTreeMap::from([(gateway.address.clone(), bound("bound-gateway", gateway))]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
}

#[test]
fn unbound_gateway_intent_is_checked_locally() {
    let (document, _) = context();
    let (_, targets) = gateway_targets();
    let plan: Plan = serde_json::from_value(
        json!({"resource_changes": targets.iter().map(|target| json!({
        "address": target.address, "change": {"actions": ["create"], "before": null}
    })).collect::<Vec<_>>()}),
    )
    .unwrap();
    let checked = runtime_observations(&document, &targets, &BTreeMap::new(), &plan).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &checked.expected, &BTreeMap::new(),)
            .unwrap()
            .len(),
        2
    );
    let mut bindings = BTreeMap::from([(
        GATEWAY_STORAGE.into(),
        StateBinding {
            image: "changed".into(),
            ..bound("storage", &targets[0])
        },
    )]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
    bindings.clear();
    bindings.insert("undeclared".into(), StateBinding::default());
    assert!(runtime_bindings(&targets, &bindings).is_err());
}

#[test]
fn native_compute_binding_does_not_require_a_nemoclaw_spec_or_replacement_authorization() {
    let target = Target {
        kind: "inference_service".into(),
        address: "docker_container.inference_service_model".into(),
        values: Row::new(),
    };
    let bindings = BTreeMap::from([(
        target.address.clone(),
        StateBinding {
            id: "prior-container".into(),
            spec: String::new(),
            ..Default::default()
        },
    )]);
    let expected = runtime_bindings(std::slice::from_ref(&target), &bindings).unwrap();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address": target.address, "change":{"actions":["delete","create"],"before":{"id":"prior-container"}}}]})).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &expected, &bindings)
            .unwrap()
            .len(),
        1
    );
    let removed = runtime_bindings(&[], &bindings).unwrap();
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address": target.address, "change":{"actions":["delete"],"before":{"id":"prior-container"}}}]})).unwrap();
    assert_eq!(
        check_runtime_plan(&plan, &removed, &bindings)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn removing_the_last_runtime_cannot_orphan_retained_state() {
    let desired =
        Document::parse(include_bytes!("../../../tests/fixtures/config/local.yaml").as_slice())
            .unwrap();
    assert!(!desired.has_runtime());
    let record = Record::new(desired.clone()).unwrap();
    let compiled = compile::deployment_graph(&desired, &record.generations, "0.1.0").unwrap();
    let bindings = BTreeMap::from([(
        "vllm_credential_storage.model".to_owned(),
        StateBinding {
            id: "daemon/volume/created".into(),
            spec: "retained".into(),
            ..Default::default()
        },
    )]);
    assert!(matches!(
        expected_bindings(&compiled, &bindings),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn docker_gateway_requires_durable_identity() {
    let (document, generations) = context();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let gateway = targets
        .iter()
        .find(|target| target.kind == GATEWAY_KIND)
        .unwrap();
    let storage = targets
        .iter()
        .find(|target| target.kind == GATEWAY_STORAGE_KIND)
        .unwrap();
    let mut bindings = BTreeMap::from([(
        gateway.address.clone(),
        StateBinding {
            id: "container".into(),
            spec: String::new(),
            ..Default::default()
        },
    )]);
    assert!(runtime_bindings(&targets, &bindings).is_err());
    bindings.insert(storage.address.clone(), bound("durable", storage));
    let plan: Plan = serde_json::from_value(json!({"resource_changes":[{"address":gateway.address,"change":{"actions":["no-op"],"before":{"id":"container"}}}]})).unwrap();
    runtime_observations(&document, &targets, &bindings, &plan).unwrap();
}

#[test]
fn podman_gateway_replacement_depends_on_protected_storage_in_the_compiled_graph() {
    let document =
        Document::parse(include_bytes!("../../../../../examples/managed-podman.yaml").as_slice())
            .unwrap();
    let generations = Record::new(document.clone()).unwrap().generations;
    let graph = compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
    let process = &graph["resource"]["openshell_podman_gateway"]["runtime"];
    assert_eq!(process["depends_on"], json!([GATEWAY_STORAGE]));
    assert_eq!(
        graph["resource"]["openshell_gateway_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
        true
    );
}

fn kubernetes_bindings(targets: &[Target]) -> BTreeMap<String, StateBinding> {
    targets
        .iter()
        .map(|target| {
            let mut values = serde_json::to_value(&target.values).unwrap();
            values["id"] = json!(if target.address == crate::kubernetes::gateway::ADDRESS {
                target.values["name"].clone()
            } else {
                format!("physical-{}", target.kind)
            });
            (
                target.address.clone(),
                serde_json::from_value(values).unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn plan_and_apply_warn_about_cluster_network_boundaries_even_with_bearer_authentication() {
    for (source, remove_authentication, warning_detail) in [
        (
            include_bytes!("../../../../../crates/test-support/cluster-models/ollama.yaml")
                .as_slice(),
            false,
            Some("no bearer authentication"),
        ),
        (
            include_bytes!("../../../../../crates/test-support/cluster-models/vllm.yaml")
                .as_slice(),
            false,
            Some("requires an image that restricts inference to authenticated /v1 routes"),
        ),
        (
            include_bytes!("../../../../../crates/test-support/cluster-models/vllm.yaml")
                .as_slice(),
            true,
            Some("no bearer authentication"),
        ),
        (
            include_bytes!("../../../../../examples/managed-ollama-gpu.yaml").as_slice(),
            false,
            None,
        ),
    ] {
        let mut document = Document::parse(source).unwrap();
        if remove_authentication {
            let crate::services::ServiceDefinition::Vllm(service) =
                document.spec.services.get_mut("qwen").unwrap()
            else {
                unreachable!()
            };
            // Without authentication there is no key Secret or provider key.
            service.authentication = None;
            service.kubernetes.as_mut().unwrap().key_secret = None;
            document.spec.inference_providers[0].credential = None;
        }
        for apply in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let events = Arc::new(std::sync::Mutex::new(Vec::new()));
            let saved = events.clone();
            let deployment = Deployment::new(
                &directory.path().join("state"),
                &directory.path().join("missing-bundle"),
            )
            .with_progress(Arc::new(move |event| saved.lock().unwrap().push(event)));
            let result = if apply {
                deployment.apply(&document, &CancellationToken::new()).await
            } else {
                deployment.plan(&document, &CancellationToken::new()).await
            };
            assert!(result.is_err());
            let events = events.lock().unwrap();
            let warnings: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    Progress::Warning { message } if message.contains("NetworkPolicy") => {
                        Some(message)
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(warnings.len(), usize::from(warning_detail.is_some()));
            if let Some(detail) = warning_detail {
                for required in [
                    "qwen",
                    detail,
                    "NetworkPolicy enforcement",
                    "Kubernetes API cannot verify",
                    "supervisor-only policy",
                ] {
                    assert!(warnings[0].contains(required), "{}", warnings[0]);
                }
            }
            assert!(!events.contains(&Progress::MutationStarted));
        }
    }
}

#[test]
fn apply_keeps_a_bound_cluster_model_volume_but_may_drop_its_server() {
    let document = Document::parse(
        include_bytes!("../../../../../crates/test-support/cluster-models/vllm.yaml").as_slice(),
    )
    .unwrap();
    let record = Record::new(document.clone()).unwrap();
    let targets = compile::runtime_targets(&document, &record.generations).unwrap();
    let bindings = kubernetes_bindings(&targets);
    runtime_bindings(&targets, &bindings).unwrap();
    let without = |address: &str| -> Vec<Target> {
        targets
            .iter()
            .filter(|target| target.address != address)
            .cloned()
            .collect()
    };
    assert!(matches!(
        runtime_bindings(
            &without("kubernetes_persistent_volume_claim_v1.qwen"),
            &bindings
        ),
        Err(Error::Conflict("apply cannot remove a managed runtime"))
    ));
    for disposable in [
        "kubernetes_deployment_v1.qwen",
        "kubernetes_service_v1.qwen",
        "kubernetes_network_policy_v1.qwen",
    ] {
        runtime_bindings(&without(disposable), &bindings).unwrap();
    }
    // OpenTofu never cleans up an old model volume as a replacement.
    let plan: Plan = serde_json::from_value(json!({"resource_changes": [{
        "address": "kubernetes_persistent_volume_claim_v1.qwen", "deposed": "old",
        "change": {"actions": ["delete"], "before": {"id": "models/old"}}
    }]}))
    .unwrap();
    let expected = runtime_bindings(&targets, &bindings).unwrap();
    assert!(matches!(
        check_runtime_plan(&plan, &expected, &bindings),
        Err(Error::Conflict("plan contains invalid replacement cleanup"))
    ));
}

#[test]
fn kubernetes_helm_binding_requires_auth_and_the_same_release() {
    let (document, generations) = kubernetes_context();
    let targets = compile::runtime_targets(&document, &generations).unwrap();
    let bindings = kubernetes_bindings(&targets);
    runtime_bindings(&targets, &bindings).unwrap();
    for prerequisite in [
        KUBERNETES_STORAGE,
        "openshell_kubernetes_auth.runtime",
        crate::kubernetes::gateway::ADDRESS,
    ] {
        let mut missing = bindings.clone();
        missing.remove(prerequisite);
        assert!(runtime_bindings(&targets, &missing).is_err());
    }
    let mut changed = bindings.clone();
    changed
        .get_mut(crate::kubernetes::gateway::ADDRESS)
        .unwrap()
        .id = "foreign-release".into();
    assert!(runtime_bindings(&targets, &changed).is_err());
    // Interrupted initial installation can retain just storage and authentication.
    let mut partial = bindings;
    partial.remove("openshell_kubernetes_gateway.runtime");
    partial.remove(crate::kubernetes::gateway::ADDRESS);
    runtime_bindings(&targets, &partial).unwrap();
}

fn context() -> (Document, crate::compile::Generations) {
    let document =
        Document::parse(include_bytes!("../../../../../examples/spark/vllm.yaml").as_slice())
            .unwrap();
    let generations = Record::new(document.clone()).unwrap().generations;
    (document, generations)
}

fn gateway_targets() -> (Spec, Vec<Target>) {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../nemoclaw-provider/src/managed/reference.json"
    ))
    .unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.compute_driver = crate::config::ComputeDriver::Podman;
    spec.gateway.network_cidr = "172.30.161.0/24".into();
    let mut targets = Vec::new();
    for (kind, address, layout) in [
        (GATEWAY_STORAGE_KIND, GATEWAY_STORAGE, 0),
        (GATEWAY_KIND, GATEWAY, 2),
    ] {
        spec.layout = layout;
        targets.push(Target {
            kind: kind.into(),
            address: address.into(),
            values: spec.gateway_row(kind).unwrap(),
        });
    }
    (spec, targets)
}

/// The binding OpenTofu state records for a compiled target.
fn bound(id: impl Into<String>, target: &Target) -> StateBinding {
    let value = |name: &str| target.values.get(name).cloned().unwrap_or_default();
    StateBinding {
        id: id.into(),
        spec: value("spec"),
        name: value("name"),
        owner: value("owner"),
        generation: value("generation"),
        engine: value("engine"),
        compute_driver: value("compute_driver"),
        endpoint: value("endpoint"),
        image: value("image"),
        network_cidr: value("network_cidr"),
        ..Default::default()
    }
}

/// Planned prior attributes of a bound resource.
fn before(binding: &StateBinding) -> Value {
    let mut before = json!(binding.typed_values());
    before["id"] = json!(binding.id);
    if !binding.spec.is_empty() {
        before["spec"] = json!(binding.spec);
    }
    before["running"] = json!("true");
    before
}

#[test]
fn runtime_checks_ignore_object_bindings_in_the_shared_state() {
    let (document, _) = kubernetes_context();
    let record = Record::new(document).unwrap();
    let targets = compile::runtime_targets(&record.document, &record.generations).unwrap();
    let mut bindings = kubernetes_bindings(&targets);
    bindings.insert(
        "openshell_workspace.deployment".into(),
        StateBinding {
            id: "workspace".into(),
            ..Default::default()
        },
    );
    assert!(
        runtime_bindings(&targets, &bindings).is_err(),
        "an object binding is not part of the runtime"
    );
    let runtime = runtime_saved(&record, &bindings).unwrap();
    assert!(!runtime.contains_key("openshell_workspace.deployment"));
    runtime_bindings(&targets, &runtime).unwrap();
}
