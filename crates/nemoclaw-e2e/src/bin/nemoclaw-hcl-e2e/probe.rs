// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use fabric_provider::AgentBridge as _;
use nemoclaw_sdk::{EnvironmentSecrets, backend::Row, config::Document};
use openshell_provider::OpenShell;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc};

#[derive(clap::Args)]
pub(super) struct Inputs {
    #[arg(long)]
    pub config: PathBuf,
    #[arg(long)]
    pub state_dir: PathBuf,
    #[arg(long)]
    pub agent: String,
    /// HCL scenario key retained with this target's evidence.
    #[arg(long)]
    pub target: String,
    #[arg(long)]
    pub request: PathBuf,
    /// JSON pointer to the reply text in the harness output, such as /output/response.
    #[arg(long)]
    pub response_pointer: String,
    #[arg(long)]
    pub report: PathBuf,
}

fn resource(state: &Value, kind: &str, name: &str) -> Result<Value, String> {
    let found: Vec<_> = state["resources"]
        .as_array()
        .ok_or("missing deployment resources")?
        .iter()
        .filter(|r| r["mode"] == "managed" && r["type"] == kind && r["name"] == name)
        .collect();
    if found.len() != 1 || found[0]["instances"].as_array().map(Vec::len) != Some(1) {
        return Err("missing unique managed binding".into());
    }
    Ok(found[0]["instances"][0]["attributes"].clone())
}

fn invocation_failure(error: &nemoclaw_backend::Error) -> Value {
    use nemoclaw_backend::{Error, ObservationError};
    // These fields are fixed by the provider. Never serialize backend text or paths.
    match error {
        Error::Observation(ObservationError::FabricConfiguration {
            stage,
            code,
            runtime_state,
            ..
        }) => json!({"stage": stage, "code": code, "runtime_state": runtime_state}),
        Error::Observation(ObservationError::Rejected {
            operation, code, ..
        }) => {
            json!({"operation": operation, "code": code})
        }
        Error::Conflict(reason) => json!({"code": "conflict", "reason": reason}),
        Error::Observation(ObservationError::Transport) => json!({"code": "transport"}),
        Error::Observation(ObservationError::Authentication) => json!({"code": "authentication"}),
        Error::Observation(ObservationError::Permission) => json!({"code": "permission"}),
        _ => json!({"code": "observation_failed"}),
    }
}

pub(super) async fn execute(inputs: &Inputs) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&inputs.report)
        .map_err(|_| "probe requires a new report file")?;
    let mut report = json!({
        "target": inputs.target,
        "expected": {"agent_name": inputs.agent, "runtime_id": null},
        "response": {"attempted": false, "succeeded": false, "agent_name": null, "runtime_id": null, "output_valid": false},
        // Backend text and responses can hold credentials or private prompts; keep only codes.
        "failure": {"code": "observation_failed"},
    });
    if invoke(inputs, &mut report).await.is_ok() {
        report["failure"]["code"] = json!("none");
    }
    nemoclaw_runtime::files::save_json(&inputs.report, &report)
        .map_err(|_| "cannot save probe evidence".into())
}

async fn invoke(inputs: &Inputs, report: &mut Value) -> Result<(), String> {
    let document =
        Document::parse(fs::File::open(&inputs.config).map_err(|_| "cannot read configuration")?)
            .map_err(|_| "invalid configuration")?;
    let state: Value = serde_json::from_slice(
        &fs::read(inputs.state_dir.join("terraform.tfstate"))
            .map_err(|_| "cannot read deployment state")?,
    )
    .map_err(|_| "invalid deployment state")?;
    let mut sandboxes = document
        .sandboxes()
        .filter(|s| s.agent.name == inputs.agent);
    let (Some(sandbox), None) = (sandboxes.next(), sandboxes.next()) else {
        return Err("target agent must name exactly one sandbox".into());
    };
    // Apply already checked gateway, sandbox, and agent readiness; use its bindings.
    let mut attributes = resource(&state, "openshell_sandbox", sandbox.name)?;
    nemoclaw_openshell::flatten("openshell_sandbox", &mut attributes);
    let row: Row = attributes
        .as_object()
        .ok_or("invalid sandbox binding")?
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    let binding = fabric_provider::fabric_binding(row).map_err(|_| "invalid Fabric binding")?;
    let agent = resource(&state, "fabric_agent", sandbox.name)?;
    let runtime = agent["runtime_id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("missing runtime")?;
    report["expected"]["runtime_id"] = json!(runtime);
    let input: Value =
        serde_json::from_slice(&fs::read(&inputs.request).map_err(|_| "cannot read request")?)
            .map_err(|_| "invalid request")?;
    let client = OpenShell::connect(
        &document.spec.gateway.connection(),
        Arc::new(EnvironmentSecrets),
    )
    .map_err(|_| "cannot connect")?;
    report["response"]["attempted"] = json!(true);
    // Reuse the production bridge, including its deadline and no-retry behavior.
    let response = client
        .invoke_agent(&binding, runtime, &input)
        .await
        .map_err(|error| {
            report["failure"]["provider"] = invocation_failure(&error);
            "invocation failed"
        })?;
    let text = response
        .pointer(&inputs.response_pointer)
        .and_then(Value::as_str);
    report["response"] = json!({
        "attempted": true,
        "succeeded": nemoclaw_e2e::state::successful_invocation(&serde_json::to_vec(&response).unwrap()),
        "agent_name": response["agent_name"].as_str(),
        "runtime_id": response["runtime_id"].as_str(),
        "output_valid": text.is_some_and(|text| !text.trim().is_empty()),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nemoclaw_backend::{Error, ObservationError};

    #[test]
    fn invocation_evidence_keeps_safe_codes_without_private_details() {
        let error = Error::Observation(ObservationError::FabricConfiguration {
            stage: "invoke",
            code: "invoke_failed",
            runtime_state: "unknown",
            message_file: Some("private-diagnostic-path".into()),
        });
        assert_eq!(
            invocation_failure(&error),
            json!({"stage": "invoke", "code": "invoke_failed", "runtime_state": "unknown"})
        );
        let error = Error::Observation(ObservationError::Rejected {
            operation: "exec",
            code: "rejected",
            detail: "private-backend-detail".into(),
        });
        assert_eq!(
            invocation_failure(&error),
            json!({"operation": "exec", "code": "rejected"})
        );
    }
}
