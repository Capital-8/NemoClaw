// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed model services on a managed Kubernetes gateway's cluster. This
//! module builds configuration only: the bundled Kubernetes provider creates
//! the objects, and Kubernetes runs, restarts and schedules them. The runtime
//! data source supplies what any platform runs; this placement chooses only
//! the namespace, requests, limits, storage and scheduling.

use super::gateway::{KUBECONFIG_VARIABLE, literal};
use crate::artifact_pins as pins;
use crate::{
    Error,
    compile::Generations,
    config::Document,
    services::{
        ServiceDefinition,
        cluster::{CLAIM, DEPLOYMENT, NETWORK_POLICY, SERVICE, claim_name, name},
        installers::{ollama, vllm},
    },
};
use serde_json::{Value, json};

pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/hashicorp/kubernetes";
pub use pins::KUBERNETES_PROVIDER_VERSION as PROVIDER_VERSION;
/// Labels a model Pod and its selector carry with the deployment's owner label.
pub const SERVICE_LABEL: &str = "nemoclaw.nvidia.com/service";
/// Model downloads and preparation are part of a rollout, so a Deployment may
/// take as long as Docker readiness waits.
const ROLLOUT_SECONDS: u32 = 9 * 3600;

/// A Kubernetes quantity in the canonical form the API server returns, so an
/// unchanged plan reads back unchanged.
fn gibibytes(value: u64) -> String {
    format!("{value}Gi")
}
fn millicores(value: u32) -> String {
    if value.is_multiple_of(1000) {
        (value / 1000).to_string()
    } else {
        format!("{value}m")
    }
}

/// Declare the Kubernetes provider and every cluster model service's objects.
pub(crate) fn configure(
    graph: &mut Value,
    document: &Document,
    generations: &Generations,
) -> Result<(), Error> {
    let target = document.spec.gateway.as_kubernetes().ok_or(Error::State(
        "managed Kubernetes gateway settings are missing",
    ))?;
    // Configured whenever the gateway is, so state that names these objects
    // always refreshes against the authored cluster.
    graph["terraform"]["required_providers"]["kubernetes"] = json!({
        "source": PROVIDER_ADDRESS, "version": format!("= {PROVIDER_VERSION}")
    });
    graph["provider"]["kubernetes"] = json!({
        "config_path": format!("${{var.{KUBECONFIG_VARIABLE}}}"),
        "config_context": literal(&target.context),
    });
    for (service, definition) in &document.spec.services {
        let Some(settings) = definition.kubernetes() else {
            continue;
        };
        let (source, generation_kind, runtime, image, pull_policy, container, architecture) =
            match definition {
                ServiceDefinition::Vllm(service) => (
                    vllm::RUNTIME_DATA_SOURCE,
                    vllm::SERVICE_KIND,
                    crate::hcl_schema::to_hcl(
                        &vllm::runtime_fields().map_err(|_| {
                            Error::State("the vLLM runtime contract has no OpenTofu schema")
                        })?,
                        &serde_json::to_value(service.runtime_settings())
                            .map_err(|_| Error::State("cannot encode runtime settings"))?,
                    ),
                    service.image.clone(),
                    service.image_pull_policy,
                    service.container.as_ref(),
                    service.architecture()?.to_owned(),
                ),
                ServiceDefinition::Ollama(service) => (
                    ollama::RUNTIME_DATA_SOURCE,
                    ollama::SERVICE_KIND,
                    crate::hcl_schema::to_hcl(
                        &ollama::runtime_fields().map_err(|_| {
                            Error::State("the Ollama runtime contract has no OpenTofu schema")
                        })?,
                        &serde_json::to_value(service.runtime_settings())
                            .map_err(|_| Error::State("cannot encode runtime settings"))?,
                    ),
                    service.image.clone(),
                    service.image_pull_policy,
                    service.container.as_ref(),
                    service.architecture()?.to_owned(),
                ),
                ServiceDefinition::OllamaProxy(_) | ServiceDefinition::Container(_) => {
                    return Err(Error::State("only vLLM and Ollama run on the cluster"));
                }
            };
        let mut runtime = runtime;
        crate::services::literal(&mut runtime);
        let source = crate::compile::data_source_type(source);
        graph["data"][&source][service] = runtime;
        let launch = |field: &str| format!("${{data.{source}.{service}.launch.{field}}}");
        let resources = vllm::ServiceContainer::resources(container);
        let (cpu_limit, memory_limit) = container
            .and_then(|container| Some((container.cpu_limit_millis?, container.memory_limit_gib?)))
            .ok_or(Error::State(
                "cluster model services require container limits",
            ))?;
        let object = name(document, service);
        let namespace = literal(&target.namespace);
        let owner = literal(&document.metadata.uid);
        let generation = generations
            .get(generation_kind)
            .ok_or(Error::State("missing cluster service generation"))?;
        let pod_labels = json!({
            super::cluster::OWNER_LABEL: owner,
            SERVICE_LABEL: literal(&object),
        });
        let metadata = |name: String| {
            json!([{
                "name": literal(&name),
                "namespace": namespace,
                "labels": {super::cluster::OWNER_LABEL: owner},
            }])
        };
        let storage = "openshell_kubernetes_storage.runtime";

        // The model volume outlives the server and the deployment.
        let mut claim_spec = json!({
            "access_modes": ["ReadWriteOnce"],
            "volume_mode": "Filesystem",
            "resources": [{"requests": {"storage": gibibytes(settings.storage_gib)}}],
        });
        if let Some(class) = &settings.storage_class {
            claim_spec["storage_class_name"] = json!(literal(class));
        }
        graph["resource"][CLAIM][service] = json!({
            "metadata": metadata(claim_name(document, service)),
            "spec": [claim_spec],
            // A WaitForFirstConsumer class binds only once the Pod uses it.
            "wait_until_bound": false,
            "lifecycle": {"prevent_destroy": true},
            "depends_on": [storage],
        });

        // Only supervisors, which carry sandbox traffic, reach the server.
        graph["resource"][NETWORK_POLICY][service] = json!({
            "metadata": metadata(object.clone()),
            "spec": [{
                "pod_selector": [{"match_labels": pod_labels}],
                "policy_types": ["Ingress"],
                "ingress": [{
                    "from": [{"pod_selector": [{"match_labels": {
                        "openshell.ai/managed-by": "openshell",
                        "openshell.ai/boundary-role": "supervisor",
                    }}]}],
                    "ports": [{"port": launch("port"), "protocol": "TCP"}],
                }],
            }],
            "depends_on": [storage],
        });

        graph["resource"][SERVICE][service] = json!({
            "metadata": metadata(object.clone()),
            "spec": [{
                "type": "ClusterIP",
                "selector": pod_labels,
                "port": [{"name": "http", "port": launch("port"), "target_port": launch("port"), "protocol": "TCP"}],
            }],
            "wait_for_load_balancer": false,
            "depends_on": [storage],
        });

        let mut environment = vec![
            json!({"name": "HOME", "value": "/data"}),
            json!({"name": "XDG_CACHE_HOME", "value": "/data/.cache"}),
            // Kubernetes restarts exited containers; memory protection must not
            // start the model again under the same pressure.
            json!({"name": nemoclaw_runtime::ON_STOP_ENV, "value": "hold"}),
        ];
        if let Some(secret) = &settings.key_secret {
            environment.push(json!({
                "name": launch("key_env"),
                "value_from": [{"secret_key_ref": [{
                    "name": literal(&secret.name), "key": literal(&secret.key),
                }]}],
            }));
        }
        let mut node_selector = serde_json::Map::new();
        for (key, value) in &settings.node_selector {
            node_selector.insert(literal(key), json!(literal(value)));
        }
        node_selector.insert("kubernetes.io/os".into(), json!("linux"));
        node_selector.insert("kubernetes.io/arch".into(), json!(literal(&architecture)));
        let tolerations: Vec<Value> = settings
            .tolerations
            .iter()
            .map(|toleration| {
                let mut value = json!({
                    "key": literal(&toleration.key),
                    "operator": format!("{:?}", toleration.operator),
                    "value": literal(&toleration.value),
                });
                if let Some(effect) = toleration.effect {
                    value["effect"] = json!(format!("{effect:?}"));
                }
                if let Some(seconds) = toleration.toleration_seconds {
                    value["toleration_seconds"] = json!(seconds.to_string());
                }
                value
            })
            .collect();
        let mut pod = json!({
            "automount_service_account_token": false,
            "enable_service_links": false,
            "termination_grace_period_seconds": 60,
            "node_selector": node_selector,
            "toleration": tolerations,
            "image_pull_secrets": target
                .image_pull_secrets
                .iter()
                .map(|secret| json!({"name": literal(secret)}))
                .collect::<Vec<_>>(),
            // The pod runs as the image's user with every capability dropped,
            // as Docker placement does; OpenShift assigns its own user.
            "security_context": [{"seccomp_profile": [{"type": "RuntimeDefault"}]}],
            "container": [{
                "name": "runtime",
                "image": literal(&image),
                "image_pull_policy": pull_policy.map_or("IfNotPresent", |policy| policy.as_str()),
                "command": launch("entrypoint"),
                "args": launch("command"),
                "env": environment,
                "dynamic": {"env": {
                    "for_each": launch("environment"),
                    "content": {"name": "${env.key}", "value": "${env.value}"},
                }},
                "port": [{"name": "http", "container_port": launch("port"), "protocol": "TCP"}],
                "resources": [{
                    "requests": {
                        "cpu": millicores(settings.cpu_request_millis),
                        "memory": gibibytes(settings.memory_request_gib),
                    },
                    "limits": {
                        "cpu": millicores(cpu_limit),
                        "memory": gibibytes(memory_limit),
                        // The runtime contract requires one visible GPU.
                        "nvidia.com/gpu": "1",
                    },
                }],
                "volume_mount": [
                    {"name": "data", "mount_path": launch("data_path")},
                    {"name": "shm", "mount_path": "/dev/shm"},
                    {"name": "tmp", "mount_path": "/tmp"},
                ],
                "security_context": [{
                    "allow_privilege_escalation": false,
                    "capabilities": [{"drop": ["ALL"]}],
                }],
                "termination_message_policy": "FallbackToLogsOnError",
                // The runtime reports ready only once the model is served.
                "readiness_probe": [{
                    "exec": [{"command": launch("ready_command")}],
                    "period_seconds": 10,
                    "timeout_seconds": 5,
                    "failure_threshold": 3,
                }],
            }],
            "volume": [
                {"name": "data", "persistent_volume_claim": [{"claim_name": literal(&claim_name(document, service))}]},
                {"name": "shm", "empty_dir": [{
                    "medium": "Memory",
                    "size_limit": gibibytes(resources.shared_memory_bytes >> 30),
                }]},
                {"name": "tmp", "empty_dir": [{}]},
            ],
        });
        if let Some(class) = &settings.runtime_class_name {
            pod["runtime_class_name"] = json!(literal(class));
        }
        let mut deployment_metadata = metadata(object.clone());
        deployment_metadata[0]["labels"][super::cluster::GENERATION_LABEL] =
            json!(literal(generation));
        graph["resource"][DEPLOYMENT][service] = json!({
            "metadata": deployment_metadata,
            "spec": [{
                "replicas": "1",
                // One GPU server per model volume: stop the old Pod first.
                "strategy": [{"type": "Recreate"}],
                "progress_deadline_seconds": ROLLOUT_SECONDS,
                "selector": [{"match_labels": pod_labels}],
                "template": [{
                    "metadata": [{"labels": pod_labels}],
                    "spec": [pod],
                }],
            }],
            "wait_for_rollout": true,
            "timeouts": {"create": "9h", "update": "9h", "delete": "10m"},
            // The policy exists before the server can accept connections.
            "depends_on": [
                storage,
                format!("{CLAIM}.{service}"),
                format!("{NETWORK_POLICY}.{service}"),
            ],
        });
    }
    Ok(())
}

/// Flatten a Kubernetes object in OpenTofu state to the identity bindings
/// compare: its name, namespace and owner label.
pub(crate) fn flatten(kind: &str, values: &mut Value) {
    if !crate::services::cluster::is_cluster_kind(kind) {
        return;
    }
    let metadata = &values["metadata"][0];
    let flattened = json!({
        "id": values["id"],
        "name": metadata["name"],
        "namespace": metadata["namespace"],
        "owner": metadata["labels"][super::cluster::OWNER_LABEL],
    });
    *values = flattened;
}

/// Import blocks for model volumes this deployment created and its state no
/// longer records, as after destroy, so a reapply reuses their data. Reads
/// only the volumes' metadata, and only for services without a bound volume.
/// A volume another deployment or anyone else owns is never adopted.
#[doc(hidden)]
pub async fn retained_claim_imports(
    document: &Document,
    secrets: &dyn nemoclaw_backend::Secrets,
    bound: &std::collections::BTreeSet<String>,
) -> Result<Vec<Value>, Error> {
    use crate::services::cluster::address;
    let Some(target) = document.spec.gateway.as_kubernetes() else {
        return Ok(Vec::new());
    };
    let unbound: Vec<&String> = document
        .spec
        .services
        .iter()
        .filter(|(service, definition)| {
            definition.kubernetes().is_some() && !bound.contains(&address(CLAIM, service))
        })
        .map(|(service, _)| service)
        .collect();
    if unbound.is_empty() {
        return Ok(Vec::new());
    }
    let kubeconfig = super::kubeconfig_path(&secrets.resolve(&target.kubeconfig.env)?)?;
    let client = super::connect(&super::ClusterTarget {
        kubeconfig,
        context: target.context.clone(),
    })
    .await?;
    let claims: kube::Api<k8s_openapi::api::core::v1::PersistentVolumeClaim> =
        kube::Api::namespaced(client, &target.namespace);
    let mut imports = Vec::new();
    for service in unbound {
        let claim = claim_name(document, service);
        let Some(existing) = claims
            .get_opt(&claim)
            .await
            .map_err(super::cluster::failure)?
        else {
            continue;
        };
        let owner = existing
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get(super::cluster::OWNER_LABEL));
        if owner != Some(&document.metadata.uid) {
            return Err(Error::Conflict(
                "a model volume with a cluster service's name exists but belongs to another owner; NemoClaw never adopts it",
            ));
        }
        imports.push(json!({
            "to": address(CLAIM, service),
            "id": format!("{}/{claim}", target.namespace),
        }));
    }
    Ok(imports)
}
