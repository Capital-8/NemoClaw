// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{Document, parse_yaml_value, valid_name};
use serde::Deserialize;
use serde_json::Value;
use std::{fs, path::Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Case {
    pub id: String,
    pub deployment: Value,
    pub agent: String,
    #[serde(rename = "responseContract")]
    pub response_contract: super::response::Contract,
    pub request: Value,
}

impl Case {
    pub fn read(path: &Path) -> Result<Self, String> {
        let value = parse_yaml_value(fs::File::open(path).map_err(|_| "cannot read case")?)
            .map_err(|_| "invalid case YAML")?;
        let case: Self = serde_json::from_value(value).map_err(|_| "invalid case fields")?;
        if !valid_name(&case.id) || case.request.is_null() {
            return Err("case needs a valid ID and a non-null agent request".into());
        }
        super::probe::target_agent(&case.document()?, &case.agent)?;
        Ok(case)
    }

    pub fn document(&self) -> Result<Document, String> {
        let bytes = serde_json::to_vec(&self.deployment).map_err(|_| "cannot encode deployment")?;
        Document::parse(bytes.as_slice()).map_err(|_| "invalid deployment configuration".into())
    }

    pub fn owned_document(&self) -> Result<Document, String> {
        let mut deployment = self.deployment.clone();
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "cannot allocate deployment identity")?;
        random[6] = (random[6] & 15) | 64;
        random[8] = (random[8] & 63) | 128;
        let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
        deployment["metadata"]["uid"] = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        )
        .into();
        let bytes = serde_json::to_vec(&deployment).map_err(|_| "cannot encode deployment")?;
        Document::parse(bytes.as_slice()).map_err(|_| "invalid deployment configuration".into())
    }
}
