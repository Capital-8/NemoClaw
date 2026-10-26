// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub(super) enum Contract {
    Fabric,
    Openclaw,
}

pub(super) fn observations(response: &Value, contract: Contract) -> Value {
    json!({
        "attempted": true,
        "succeeded": nemoclaw_e2e::state::successful_invocation(&serde_json::to_vec(response).unwrap()),
        "agent_name": response["agent_name"].as_str(),
        "runtime_id": response["runtime_id"].as_str(),
        // Fabric owns its envelope; only the selected adapter interprets the output.
        "output_valid": match contract {
            Contract::Fabric => response.get("output").is_some(),
            Contract::Openclaw => response["output"]["response"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
        }
    })
}
