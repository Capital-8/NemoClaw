// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Project the existing model runtime contract onto the gateway's cluster.

use super::{
    ServiceDefinition,
    contract::{InstallPlan, RemovePlan},
};
use crate::{
    Error,
    backend::Row,
    compile::{Generations, Target},
    config::{ConfigError, Document},
    kubernetes::services::{SERVICE_KIND, STORAGE_KIND, Spec},
};
use sha2::{Digest, Sha256};

pub(super) fn name(document: &Document, service: &str) -> String {
    let digest = Sha256::digest(service.as_bytes());
    let suffix: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}-model-{suffix}", document.workspace())
}

pub(super) fn endpoint(
    document: &Document,
    service: &str,
    port: i64,
) -> Result<String, ConfigError> {
    let target = document
        .spec
        .gateway
        .as_kubernetes()
        .ok_or(ConfigError::new(
            "cluster service requires a managed Kubernetes gateway",
        ))?;
    Ok(format!(
        "http://{}:{port}/v1",
        crate::kubernetes::services::service_host(&name(document, service), &target.namespace)
    ))
}

pub(super) fn spec(
    definition: &ServiceDefinition,
    document: &Document,
    name: &str,
    generations: &Generations,
) -> Result<Spec, Error> {
    let settings = document.spec.gateway.as_managed().ok_or(Error::Conflict(
        "cluster service requires a managed gateway",
    ))?;
    let (
        runtime,
        image,
        image_pull_policy,
        container,
        update_policy,
        architecture,
        generation_kind,
    ) = match definition {
        ServiceDefinition::Vllm(service) => (
            nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(service.runtime_settings())),
            service.image.clone(),
            service.image_pull_policy,
            &service.container,
            service.update_policy,
            service.architecture()?.to_owned(),
            super::installers::vllm::SERVICE_KIND,
        ),
        ServiceDefinition::Ollama(service) => (
            nemoclaw_runtime::RuntimeSpec::Ollama(Box::new(service.runtime_settings())),
            service.image.clone(),
            service.image_pull_policy,
            &service.container,
            service.update_policy,
            service
                .hardware
                .as_ref()
                .ok_or(ConfigError::new("Ollama hardware is required"))?
                .architecture()?
                .to_owned(),
            super::installers::ollama::SERVICE_KIND,
        ),
        ServiceDefinition::OllamaProxy(_) => {
            return Err(Error::Conflict("Ollama proxy does not run on Kubernetes"));
        }
        ServiceDefinition::Container(_) => {
            return Err(Error::Conflict(
                "application containers do not run on Kubernetes",
            ));
        }
    };
    let generation = |kind: &str| {
        generations
            .get(kind)
            .cloned()
            .ok_or(Error::State("missing cluster service generation"))
    };
    let spec = Spec {
        layout: 1,
        kind: SERVICE_KIND.into(),
        name: self::name(document, name),
        owner: document.metadata.uid.clone(),
        generation: generation(generation_kind)?,
        gateway: crate::kubernetes::Spec {
            layout: 1,
            kind: crate::kubernetes::GATEWAY_KIND.into(),
            name: format!("{}-gateway", document.workspace()),
            owner: document.metadata.uid.clone(),
            generation: generation(crate::kubernetes::GATEWAY_KIND)?,
            settings: settings.clone(),
        },
        image,
        image_pull_policy,
        runtime,
        settings: definition
            .kubernetes()
            .ok_or(Error::Conflict("cluster service configuration is missing"))?
            .resolve(container.as_ref(), update_policy)?,
        shared_memory_gib: container
            .as_ref()
            .map_or(8, |container| container.shared_memory_gi_b),
        architecture,
    };
    spec.validate()?;
    Ok(spec)
}

/// The address of a kind's resource named `name`.
fn address(kind: &str, name: &str) -> String {
    format!("{}.{name}", crate::compile::resource_type(kind))
}

pub(super) fn install(
    definition: &ServiceDefinition,
    document: &Document,
    name: &str,
    generations: &Generations,
) -> Result<InstallPlan, Error> {
    let spec = spec(definition, document, name, generations)?;
    let storage = address(STORAGE_KIND, name);
    let service = address(SERVICE_KIND, name);
    Ok(InstallPlan {
        targets: vec![
            Target {
                kind: STORAGE_KIND.into(),
                address: storage.clone(),
                values: Row::from([("spec".into(), spec.storage().encode()?)]),
            },
            Target {
                kind: SERVICE_KIND.into(),
                address: service.clone(),
                values: Row::from([("spec".into(), spec.encode()?)]),
            },
        ],
        dependencies: [
            (
                storage.clone(),
                vec![
                    address(crate::kubernetes::STORAGE_KIND, "runtime"),
                    address(crate::kubernetes::AUTH_KIND, "runtime"),
                ],
            ),
            (
                service,
                vec![storage, address(crate::kubernetes::GATEWAY_KIND, "runtime")],
            ),
        ]
        .into(),
    })
}

pub(super) fn remove(name: &str) -> RemovePlan {
    let storage = address(STORAGE_KIND, name);
    RemovePlan {
        retained: vec![storage.clone()],
        required_storage: vec![(address(SERVICE_KIND, name), storage)],
    }
}
