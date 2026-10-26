// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{ComputeDriver, Document, Gateway, parse_yaml_value, valid_name};
use serde::Deserialize;
use serde_json::Value;
use std::{fs, net::TcpListener, path::Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Case {
    pub id: String,
    pub deployment: Value,
    pub request: Value,
}

impl Case {
    pub fn read(path: &Path) -> Result<Self, String> {
        let value = parse_yaml_value(fs::File::open(path).map_err(|_| "cannot read case")?)
            .map_err(|_| "invalid case YAML")?;
        let case: Self = serde_json::from_value(value).map_err(|_| "invalid case fields")?;
        if !valid_name(&case.id) || !case.request.as_str().is_some_and(|v| !v.trim().is_empty()) {
            return Err("case needs a valid ID and a nonempty text request".into());
        }
        case.document()?;
        Ok(case)
    }

    pub fn document(&self) -> Result<Document, String> {
        let bytes = serde_json::to_vec(&self.deployment).map_err(|_| "cannot encode deployment")?;
        let doc =
            Document::parse(bytes.as_slice()).map_err(|_| "invalid deployment configuration")?;
        if !matches!(&doc.spec.gateway, Gateway::Managed(g) if g.runtime.provider == ComputeDriver::Docker && g.kubernetes.is_none())
            || doc.spec.sandboxes.len() != 1
            || !doc.spec.services.is_empty()
            || doc.sandboxes().any(|s| {
                !doc.sandbox_harness(s)
                    .is_ok_and(|h| h.kind.to_string() == "nvidia.fabric.openclaw")
            })
        {
            return Err("POC requires one OpenClaw sandbox and a managed Docker gateway".into());
        }
        let providers = doc
            .selected_inference_providers()
            .map_err(|_| "invalid inference selection")?;
        if providers.len() != 1
            || providers.iter().any(|p| {
                p.service_ref.is_some()
                    || p.provider.to_string() != "openai"
                    || p.endpoint != "https://integrate.api.nvidia.com/v1"
                    || p.credential.as_ref().map(|c| c.env.as_str())
                        != Some("NVIDIA_INFERENCE_API_KEY")
            })
        {
            return Err(
                "POC requires NVIDIA hosted inference using NVIDIA_INFERENCE_API_KEY".into(),
            );
        }
        Ok(doc)
    }

    pub fn owned_document(&self) -> Result<Document, String> {
        let mut doc = self.document()?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "cannot allocate deployment identity")?;
        random[6] = (random[6] & 15) | 64;
        random[8] = (random[8] & 63) | 128;
        let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
        doc.metadata.uid = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        let socket =
            TcpListener::bind("127.0.0.1:0").map_err(|_| "cannot allocate gateway port")?;
        let port = socket
            .local_addr()
            .map_err(|_| "cannot read gateway port")?
            .port();
        *doc.spec.gateway.endpoint_mut() = format!("http://127.0.0.1:{port}");
        Ok(doc)
    }
}
