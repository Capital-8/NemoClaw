// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed vLLM and Ollama on a managed Kubernetes gateway's cluster: the
//! objects NemoClaw declares for each service and the endpoint sandboxes reach.
//! `kubernetes::models` writes their bodies; Kubernetes runs them.

use super::contract::{InstallPlan, RemovePlan};
use crate::{
    Error,
    backend::Row,
    compile::{Generations, Target},
    config::{ConfigError, Document},
};
use sha2::{Digest, Sha256};

/// The retained model volume.
pub const CLAIM: &str = "kubernetes_persistent_volume_claim_v1";
/// The server Pod's controller.
pub const DEPLOYMENT: &str = "kubernetes_deployment_v1";
/// The address sandboxes reach.
pub const SERVICE: &str = "kubernetes_service_v1";
/// The supervisor-only ingress rule.
pub const NETWORK_POLICY: &str = "kubernetes_network_policy_v1";

/// The Kubernetes name of a service's objects, unique in the deployment's
/// namespace and valid as a Service name.
pub fn name(document: &Document, service: &str) -> String {
    let digest = Sha256::digest(service.as_bytes());
    let suffix: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}-model-{suffix}", document.workspace())
}

/// The name of a service's retained model volume.
pub fn claim_name(document: &Document, service: &str) -> String {
    format!("{}-data", name(document, service))
}

/// The OpenTofu address of a service's object of `kind`.
pub fn address(kind: &str, service: &str) -> String {
    format!("{kind}.{service}")
}

pub(crate) fn namespace(document: &Document) -> Result<&str, ConfigError> {
    document
        .spec
        .gateway
        .as_kubernetes()
        .map(|kubernetes| kubernetes.namespace.as_str())
        .ok_or(ConfigError::new(
            "cluster model services require a managed Kubernetes gateway",
        ))
}

/// The in-cluster address of a service, resolved when sandboxes connect.
pub(super) fn endpoint(
    document: &Document,
    service: &str,
    port: i64,
) -> Result<String, ConfigError> {
    Ok(format!(
        "http://{}.{}.svc.cluster.local:{port}/v1",
        name(document, service),
        namespace(document)?
    ))
}

/// Identity rows for the objects of service `service`; the bodies come from
/// `kubernetes::models::configure`.
pub(super) fn install(
    document: &Document,
    service: &str,
    _generations: &Generations,
) -> Result<InstallPlan, Error> {
    let namespace = namespace(document)?.to_owned();
    let object = name(document, service);
    let target = |kind: &str, name: String| Target {
        kind: kind.into(),
        address: address(kind, service),
        values: Row::from([
            ("name".into(), name),
            ("namespace".into(), namespace.clone()),
            ("owner".into(), document.metadata.uid.clone()),
        ]),
    };
    Ok(InstallPlan {
        targets: vec![
            target(CLAIM, claim_name(document, service)),
            target(DEPLOYMENT, object.clone()),
            target(SERVICE, object.clone()),
            target(NETWORK_POLICY, object),
        ],
        ..InstallPlan::default()
    })
}

/// Teardown keeps the model volume, and destroying the server requires it.
pub(super) fn remove(service: &str) -> RemovePlan {
    let claim = address(CLAIM, service);
    RemovePlan {
        retained: vec![claim.clone()],
        required_storage: vec![(address(DEPLOYMENT, service), claim)],
    }
}

/// Whether `kind` is an object this module declares.
pub fn is_cluster_kind(kind: &str) -> bool {
    matches!(kind, CLAIM | DEPLOYMENT | SERVICE | NETWORK_POLICY)
}
