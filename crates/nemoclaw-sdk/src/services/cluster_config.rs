// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Requests, scheduling and retained storage for a model service on the
//! managed gateway's cluster. Kubernetes schedules and runs the server; these
//! settings only describe the objects NemoClaw declares for it.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use super::installers::vllm::ServiceContainer;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One GPU model service in the managed gateway's namespace. Its model volume survives destroy.
pub struct KubernetesService {
    /// Requested CPU capacity in millicores. Must not exceed container.cpuLimitMillis.
    #[schemars(range(min = 1))]
    pub cpu_request_millis: u32,
    /// Requested container memory in GiB. Must not exceed container.memoryLimitGiB.
    #[serde(rename = "memoryRequestGiB")]
    #[schemars(range(min = 1))]
    pub memory_request_gib: u64,
    /// Retained model-volume capacity in GiB. Must cover prepared data plus a 16 GiB working reserve; allow additional space for model downloads and retained snapshots.
    #[serde(rename = "storageGiB")]
    #[schemars(range(min = 16))]
    pub storage_gib: u64,
    /// StorageClass for the retained model volume. Omission selects the cluster default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    /// Required node labels in addition to Linux and the model's declared CPU architecture.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_selector: BTreeMap<String, String>,
    /// Node taints the model Pod may tolerate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tolerations: Vec<ServiceToleration>,
    /// Existing RuntimeClass to use for the model Pod.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_class_name: Option<String>,
    /// The Secret in the gateway namespace whose key holds the API key of an authenticated vLLM service. The platform owns the Secret; NemoClaw never reads or writes it. Required with authentication and rejected without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "KeySecret")]
    pub key_secret: Option<KeySecret>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// A key of an existing Secret in the gateway namespace.
pub struct KeySecret {
    /// Secret name.
    pub name: String,
    /// Key within the Secret's data.
    pub key: String,
}

impl KubernetesService {
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        crate::config::schema::validate_definition("KubernetesService", self)
    }

    /// Check requests, limits, shared memory and storage against the runtime's
    /// budgets without contacting the cluster.
    pub(crate) fn validate_runtime(
        &self,
        container: Option<&ServiceContainer>,
        runtime: &nemoclaw_runtime::RuntimeSpec,
    ) -> Result<(), crate::config::ConfigError> {
        use crate::config::validation::require;
        self.validate()?;
        let (cpu_limit, memory_limit) = container
            .and_then(|container| Some((container.cpu_limit_millis?, container.memory_limit_gib?)))
            .ok_or_else(|| {
                crate::config::ConfigError::new(
                    "cluster model services require container.cpuLimitMillis and container.memoryLimitGiB",
                )
            })?;
        require(
            memory_limit <= (i64::MAX as u64) >> 30,
            "container.memoryLimitGiB must fit signed 64-bit bytes",
        )?;
        require(
            self.cpu_request_millis <= cpu_limit && self.memory_request_gib <= memory_limit,
            "cluster service CPU and memory requests must not exceed their limits",
        )?;
        let (prepared, preparation_memory, authenticated) = match runtime {
            nemoclaw_runtime::RuntimeSpec::Vllm(service) => {
                let (prepared, preparation) = service.recipe.as_ref().map_or((0, 0), |recipe| {
                    (
                        recipe.resources.prepared_bytes,
                        recipe.resources.preparation_memory_gi_b,
                    )
                });
                (prepared, preparation, service.authentication.is_some())
            }
            nemoclaw_runtime::RuntimeSpec::Ollama(_) => (0, 0, false),
        };
        require(
            container.map_or(8, |container| container.shared_memory_gi_b) <= memory_limit,
            "container.memoryLimitGiB must cover container.sharedMemoryGiB",
        )?;
        require(
            preparation_memory <= memory_limit,
            "container.memoryLimitGiB must cover recipe preparationMemoryGiB",
        )?;
        let invalid =
            || crate::config::ConfigError::new("cluster storage capacity exceeds supported bounds");
        let required = prepared
            .checked_add(16 * nemoclaw_runtime::hardware::GIB)
            .ok_or_else(invalid)?;
        let capacity = self
            .storage_gib
            .checked_mul(nemoclaw_runtime::hardware::GIB)
            .ok_or_else(invalid)?;
        require(
            capacity >= required,
            "cluster storageGiB must cover recipe preparedBytes plus a 16 GiB working reserve; allow additional space for model downloads and retained snapshots",
        )?;
        require(
            authenticated == self.key_secret.is_some(),
            if authenticated {
                "an authenticated cluster vLLM service requires kubernetes.keySecret, the platform Secret holding its key"
            } else {
                "kubernetes.keySecret applies only to an authenticated vLLM service"
            },
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One explicit Kubernetes node-taint toleration.
pub struct ServiceToleration {
    /// Taint key. An empty key requires Exists and matches every key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// Match the taint's value with Equal, or its presence with Exists.
    pub operator: TolerationOperator,
    /// Value matched by Equal; Exists requires an empty value.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    /// Omission matches all taint effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "TolerationEffect")]
    pub effect: Option<TolerationEffect>,
    /// Optional eviction delay, valid only for NoExecute tolerations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub toleration_seconds: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// How a toleration matches a node taint.
pub enum TolerationOperator {
    Equal,
    Exists,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// Node-taint effect matched by a toleration.
pub enum TolerationEffect {
    NoSchedule,
    PreferNoSchedule,
    NoExecute,
}

pub(crate) fn constrain(defs: &mut serde_json::Map<String, Value>) {
    use crate::config::schema::validation::{at, property};
    const DNS_SUBDOMAIN: &str =
        r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*";
    const LABEL_NAME: &str = r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?";
    let key = json!({
        "pattern": format!(r"^(?:(?=[^/]{{1,253}}/){DNS_SUBDOMAIN}/)?{LABEL_NAME}$(?![\s\S])")
    });
    let value = json!({"type":"string", "pattern": format!(r"^(?:{LABEL_NAME})?$(?![\s\S])")});
    let dns_subdomain = json!({"type":"string", "maxLength":253, "pattern":format!(r"^{DNS_SUBDOMAIN}$(?![\s\S])")});
    let settings = &mut defs["KubernetesService"];
    // Kubernetes quantities must fit signed 64-bit bytes after conversion from GiB.
    for field in ["memoryRequestGiB", "storageGiB"] {
        property(settings, field, json!({"maximum": (i64::MAX as u64) >> 30}));
    }
    for field in ["storageClass", "runtimeClassName"] {
        property(settings, field, dns_subdomain.clone());
    }
    property(
        settings,
        "nodeSelector",
        json!({"propertyNames":key.clone(), "additionalProperties":value.clone()}),
    );
    let secret = &mut defs["KeySecret"];
    property(secret, "name", dns_subdomain);
    property(
        secret,
        "key",
        json!({"type":"string", "maxLength":253, "pattern":r"^[-._a-zA-Z0-9]+$(?![\s\S])"}),
    );
    let toleration = &mut defs["ServiceToleration"];
    property(toleration, "key", json!({"anyOf":[{"const":""},key]}));
    property(toleration, "value", value);
    property(
        toleration,
        "tolerationSeconds",
        json!({"type":"integer", "minimum":0, "maximum":i64::MAX}),
    );
    toleration["allOf"] = json!([
        {"if":at("operator",json!({"const":"Exists"}),true),
         "then":at("value",json!({"const":""}),false),
         "else":at("key",json!({"minLength":1}),true)},
        {"if":{"required":["tolerationSeconds"]},
         "then":at("effect",json!({"const":"NoExecute"}),true)}
    ]);

    for service in defs["ServiceDefinition"]["oneOf"].as_array_mut().unwrap() {
        if !matches!(
            service["properties"]["kind"]["const"].as_str(),
            Some("vllm" | "ollama")
        ) {
            continue;
        }
        // Docker defaults omitted limits, but a cluster Pod needs both. Name the
        // missing field instead of reporting only the failed keyword.
        let mut rules: Vec<Value> = ["cpuLimitMillis", "memoryLimitGiB"]
            .into_iter()
            .map(|field| {
                let mut rule = at(&format!("container/{field}"), json!({}), true);
                rule["x-nemoclaw-error"] =
                    json!(format!("cluster model services require container.{field}"));
                rule
            })
            .collect();
        // OpenShell refuses these destinations, so sandboxes could never reach them.
        let mut port = at(
            "serving/port",
            json!({"not":{"enum":[2379, 2380, 6443, 10250, 10255]}}),
            false,
        );
        port["x-nemoclaw-error"] = json!(
            "a cluster model service's serving.port must not be 2379, 2380, 6443, 10250, or 10255, which OpenShell refuses as destinations"
        );
        rules.push(port);
        let rule = json!({"if":{"required":["kubernetes"]}, "then":{"allOf":rules}});
        if let Some(existing) = service["allOf"].as_array_mut() {
            existing.push(rule);
        } else {
            service["allOf"] = json!([rule]);
        }
    }
}
