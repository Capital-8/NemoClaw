// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, clap::ValueEnum, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Contract {
    Fabric,
    Openclaw,
}

impl Contract {
    pub fn name(self) -> &'static str {
        match self {
            Self::Fabric => "fabric",
            Self::Openclaw => "openclaw",
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fabric_contract_accepts_adapter_owned_output_shapes() {
        let response = json!({
            "status":"succeeded","error":null,"agent_name":"assistant",
            "runtime_id":"runtime","output":{"artifact":"adapter-owned"}
        });
        assert_eq!(
            observations(&response, Contract::Fabric)["output_valid"],
            true
        );
        assert_eq!(
            observations(&response, Contract::Openclaw)["output_valid"],
            false
        );
    }

    #[test]
    fn an_empty_response_is_reported_without_claiming_response_text() {
        let response = json!({
            "status": "succeeded", "error": null,
            "agent_name": "assistant", "runtime_id": "runtime", "output": null
        });
        let observed = observations(&response, Contract::Openclaw);
        assert_eq!(observed["output_valid"], false);
        assert_eq!(observed["agent_name"], "assistant");
        assert_eq!(observed["runtime_id"], "runtime");
    }

    #[test]
    fn response_observations_preserve_the_binding_and_normalize_the_adapter_output() {
        let good = json!({"status":"succeeded", "error":null, "agent_name":"assistant", "runtime_id":"runtime", "output":{"response":"Hello"}});
        assert_eq!(
            observations(&good, Contract::Openclaw),
            json!({
                "attempted":true,"succeeded":true,"agent_name":"assistant",
                "runtime_id":"runtime","output_valid":true
            })
        );
        for (pointer, value, field, expected) in [
            ("/agent_name", json!("other"), "agent_name", json!("other")),
            ("/runtime_id", json!("other"), "runtime_id", json!("other")),
            ("/status", json!("failed"), "succeeded", json!(false)),
            (
                "/error",
                json!({"code":"model_error"}),
                "succeeded",
                json!(false),
            ),
            ("/output/response", json!(" "), "output_valid", json!(false)),
            (
                "/output/response",
                Value::Null,
                "output_valid",
                json!(false),
            ),
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                observations(&bad, Contract::Openclaw)[field],
                expected,
                "{pointer}"
            );
        }
    }
}
