// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod helm_recovery;
#[cfg(feature = "test-scenarios")]
mod scenarios;
mod teardown;
#[cfg(all(test, unix))]
pub(super) mod tests;

use super::*;
use crate::managed::{GATEWAY_KIND, Spec};
const GATEWAY_STORAGE: &str = "openshell_gateway_storage.runtime";
const KUBERNETES_STORAGE: &str = "openshell_kubernetes_storage.runtime";
const KUBERNETES_AUTH: &str = "openshell_kubernetes_auth.runtime";

fn kubernetes_binding(
    target: &Target,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    let Some(binding) = bindings.get(&target.address) else {
        return Ok(());
    };
    let helm = crate::kubernetes::gateway::ADDRESS;
    let prerequisites: &[&str] = match target.kind.as_str() {
        crate::kubernetes::AUTH_KIND => &[KUBERNETES_STORAGE],
        "helm_release" => &[KUBERNETES_STORAGE, KUBERNETES_AUTH],
        crate::kubernetes::GATEWAY_KIND => &[KUBERNETES_STORAGE, KUBERNETES_AUTH, helm],
        _ => &[],
    };
    if prerequisites
        .iter()
        .any(|address| !bindings.contains_key(*address))
    {
        return Err(Error::Conflict(
            "Kubernetes runtime requires its independent prerequisite bindings; retain the original bundle and state for recovery",
        ));
    }
    if target.address == helm
        && (binding.id != target.values["name"]
            || binding.name != target.values["name"]
            || binding.namespace != target.values["namespace"]
            || binding.chart != target.values["chart"]
            || !binding.spec.is_empty()
            || !binding.deposed.is_empty())
    {
        return Err(Error::Conflict(
            "bound Helm release differs from retained intent",
        ));
    }
    Ok(())
}
fn bound_spec(kind: &str, want: &Spec, binding: Option<&StateBinding>) -> Result<Spec, Error> {
    let Some(binding) = binding else {
        return Ok(want.clone());
    };
    let mut bound = binding.typed_values();
    bound.insert("spec".into(), binding.spec.clone());
    let old = Spec::from_values(kind, &bound)
        .map_err(|_| Error::Conflict("bound runtime specification is incomplete"))?;
    if old.kind != want.kind
        || old.name != want.name
        || old.owner != want.owner
        || old.generation != want.generation
        || old.engine() != want.engine()
    {
        return Err(Error::Conflict(
            "bound runtime identity differs from retained intent",
        ));
    }
    Ok(old)
}
// Binding validation is local. Live identity and running state come from the
// provider refresh in the saved plan, never from a separate SDK preflight.
pub(super) fn runtime_bindings(
    targets: &[Target],
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<BTreeMap<String, Row>, Error> {
    let mut expected = allowed(targets);
    if bindings.keys().any(|key| {
        !expected.contains_key(key)
            && (!plan::disposable(key) || crate::docker_compute::is_retained_storage(key))
    }) {
        return Err(Error::Conflict("apply cannot remove a managed runtime"));
    }
    for target in targets {
        kubernetes_binding(target, bindings)?;
        if target.address == crate::kubernetes::gateway::ADDRESS {
            continue;
        }
        if target.kind == GATEWAY_KIND
            && bindings.contains_key(&target.address)
            && !bindings.contains_key(GATEWAY_STORAGE)
        {
            return Err(Error::Conflict(
                "gateway compute requires its retained storage binding",
            ));
        }
        if plan::disposable(&target.address) || target.address.starts_with("data.") {
            continue;
        }
        if target.kind == GATEWAY_KIND
            || crate::services::resource_behavior(&target.kind).runtime_process
        {
            let want = Spec::from_values(&target.kind, &target.values)
                .map_err(|_| Error::State("invalid compiled runtime"))?;
            let old = bound_spec(&target.kind, &want, bindings.get(&target.address))?;
            old.write_values(&target.kind, expected.get_mut(&target.address).unwrap())?;
        } else if bindings
            .get(&target.address)
            .is_some_and(|binding| binding.differs(&target.values))
        {
            return Err(Error::Conflict(
                "bound storage specification differs from retained intent",
            ));
        }
    }
    Ok(expected)
}
/// The saved bindings that belong to the runtime: everything but OpenShell and
/// Fabric objects, which share the deployment's state.
pub(super) fn runtime_saved(
    record: &Record,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<BTreeMap<String, StateBinding>, Error> {
    let objects: BTreeSet<String> = compile::targets(&record.document, &record.generations)?
        .into_iter()
        .map(|target| target.address)
        .collect();
    Ok(bindings
        .iter()
        .filter(|(address, _)| !objects.contains(*address) && !plan::reconstructible(address))
        .map(|(address, binding)| (address.clone(), binding.clone()))
        .collect())
}

/// Refuse a plan that would disrupt a serving model under the default
/// `updatePolicy: Preserve`.
pub(super) fn preserve_models(document: &Document, plan: &Plan) -> Result<(), Error> {
    use crate::services::ServiceUpdatePolicy;

    for (name, service) in &document.spec.services {
        let (Some(policy), Some(logical)) = (service.update_policy(), service.model_address(name))
        else {
            continue;
        };
        if policy == ServiceUpdatePolicy::Recreate {
            continue;
        }
        if service.kubernetes().is_some() {
            preserve_cluster_model(name, plan)?;
            continue;
        }
        let address = crate::docker_compute::address(&logical);
        if plan.resource_changes.iter().any(|change| {
            let (before, after) = (&change.change.before, &change.change.after);
            // Docker applies a lower memory limit to the running process, which
            // the kernel can OOM-kill. Compilation labels memory limits to force
            // replacement; this also refuses an in-place decrease.
            let lowers_memory = || {
                ["memory", "memory_swap"].iter().any(|field| {
                    matches!(
                        (before[field].as_i64(), after[field].as_i64()),
                        (Some(old), Some(new)) if new < old
                    )
                })
            };
            change.address == address
                && change.deposed.is_none()
                && !before.is_null()
                // The pinned Docker provider refreshes must_run to false for
                // a stopped container. Unknown observations cannot authorize
                // disrupting a model under the default preservation policy.
                && before["must_run"] != false
                && (change.change.actions.iter().any(|action| action == "delete")
                    || lowers_memory())
        }) {
            return Err(Error::DockerModelUpdateRefused {
                service: name.clone(),
            });
        }
    }
    Ok(())
}

/// Kubernetes replaces the model Pod whenever its Deployment's Pod template
/// changes, and deleting the Deployment stops it. Replacing a tainted
/// Deployment, whose rollout never completed, has no serving Pod to keep.
fn preserve_cluster_model(name: &str, plan: &Plan) -> Result<(), Error> {
    use crate::services::cluster::{DEPLOYMENT, address};
    let deployment = address(DEPLOYMENT, name);
    let disrupts = plan.resource_changes.iter().any(|change| {
        let detail = &change.change;
        let template = |value: &Value| value["spec"][0]["template"].clone();
        // OpenTofu mirrors `after` with empty lists and objects, marking only
        // the values known after apply `true`.
        fn unknown(value: &Value) -> bool {
            match value {
                Value::Bool(known_after_apply) => *known_after_apply,
                Value::Array(values) => values.iter().any(unknown),
                Value::Object(values) => values.values().any(unknown),
                _ => false,
            }
        }
        change.address == deployment
            && change.deposed.is_none()
            && !detail.before.is_null()
            && (if detail.actions.iter().any(|action| action == "delete") {
                change.action_reason.as_deref() != Some("replace_because_tainted")
            } else {
                detail.actions == ["update"]
                    && (template(&detail.before) != template(&detail.after)
                        || unknown(&template(&detail.after_unknown)))
            })
    });
    if disrupts {
        return Err(Error::ClusterModelUpdateRefused {
            service: name.into(),
        });
    }
    Ok(())
}
