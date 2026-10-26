// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use fabric_provider::AgentBridge as _;
use nemoclaw_sdk::{
    EnvironmentSecrets,
    backend::Row,
    config::{Document, NamedSandbox},
};
use openshell_provider::{OpenShell, SandboxPhase, verify_identity};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

#[derive(clap::Args)]
pub(super) struct Inputs {
    #[arg(long)]
    pub config: PathBuf,
    #[arg(long)]
    pub state_dir: PathBuf,
    #[arg(long)]
    pub agent: String,
    #[arg(long)]
    pub request: PathBuf,
    #[arg(long, value_enum)]
    pub response_contract: super::response::Contract,
    #[arg(long)]
    pub report: PathBuf,
}

pub(super) fn target_agent<'a>(
    document: &'a Document,
    agent: &str,
) -> Result<NamedSandbox<'a>, String> {
    let mut matches = document.sandboxes().filter(|s| s.agent.name == agent);
    let sandbox = matches.next().ok_or("target agent is not configured")?;
    if matches.next().is_some() {
        return Err("target agent is ambiguous".into());
    }
    Ok(sandbox)
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

fn save(path: &Path, report: &Value) -> Result<(), String> {
    nemoclaw_runtime::files::save_json(path, report)
        .map_err(|_| "cannot save probe evidence".into())
}

fn initial_report() -> Value {
    json!({
        "expected": {"agent_name": null, "runtime_id": null},
        "health": {"gateway_ready": false, "sandbox_ready": false, "identity_matches": false, "agent_name": null, "policy_loaded": false},
        "response": {"attempted": false, "succeeded": false, "agent_name": null, "runtime_id": null, "output_valid": false},
        "failure": {"observed_at": "probe", "attributed_to": "unknown", "code": "incomplete"}
    })
}

pub(super) async fn execute(inputs: &Inputs) -> Result<(), String> {
    let report_path = &inputs.report;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report_path)
        .map_err(|_| "probe requires a new report file")?;
    let mut report = initial_report();
    save(report_path, &report)?;
    let result = observe(inputs, &mut report).await;
    if result.is_err() {
        // Backend text and response payloads can contain credentials or private prompts.
        report["failure"]["code"] = json!("observation_failed");
    }
    save(report_path, &report)
}

async fn observe(inputs: &Inputs, report: &mut Value) -> Result<(), String> {
    let Inputs {
        config,
        state_dir: state_path,
        request,
        report: report_path,
        ..
    } = inputs;
    let document =
        Document::parse(fs::File::open(config).map_err(|_| "cannot read configuration")?)
            .map_err(|_| "invalid configuration")?;
    let state: Value = serde_json::from_slice(
        &fs::read(state_path.join("terraform.tfstate"))
            .map_err(|_| "cannot read deployment state")?,
    )
    .map_err(|_| "invalid deployment state")?;
    let sandbox = target_agent(&document, &inputs.agent)?;
    let mut attributes = resource(&state, "openshell_sandbox", sandbox.name)?;
    nemoclaw_openshell::flatten("openshell_sandbox", &mut attributes);
    let expected: Row = attributes
        .as_object()
        .ok_or("invalid sandbox binding")?
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    let agent = resource(&state, "fabric_agent", sandbox.name)?;
    let runtime = agent["runtime_id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("missing runtime")?;
    report["expected"] = json!({"agent_name": sandbox.agent.name, "runtime_id": runtime});
    let client = OpenShell::connect(
        &document.spec.gateway.connection(),
        Arc::new(EnvironmentSecrets),
    )
    .map_err(|_| "cannot connect")?;
    report["failure"]["observed_at"] = json!("openshell.gateway");
    let health = async {
        client
            .verify_gateway(document.spec.gateway.runtime().provider)
            .await
            .map_err(|_| "gateway unavailable")?;
        report["health"]["gateway_ready"] = json!(true);
        save(report_path, report)?;
        report["failure"]["observed_at"] = json!("openshell.sandbox");
        let observed = client
            .observe("sandbox", &document.workspace(), sandbox.name, false)
            .await
            .map_err(|_| "sandbox observation failed")?
            .ok_or("sandbox absent")?;
        verify_identity(&expected, &observed).map_err(|_| "sandbox identity mismatch")?;
        report["health"]["identity_matches"] = json!(true);
        report["health"]["policy_loaded"] =
            json!(observed.get("policy_hash").is_some_and(|v| !v.is_empty()));
        report["failure"]["observed_at"] = json!("fabric.binding");
        let binding =
            fabric_provider::fabric_binding(observed).map_err(|_| "invalid Fabric binding")?;
        report["health"]["agent_name"] = json!(binding.get("agent_name"));
        report["failure"]["observed_at"] = json!("openshell.sandbox-readiness");
        report["health"]["sandbox_ready"] = json!(
            client
                .sandbox_phase(&binding, true)
                .await
                .map_err(|_| "sandbox readiness failed")?
                == SandboxPhase::Ready
        );
        Ok::<_, String>(binding)
    };
    let binding = tokio::time::timeout(Duration::from_secs(60), health)
        .await
        .map_err(|_| "health deadline exceeded")??;
    save(report_path, report)?;
    // These prerequisites prevent invoking an unready or incorrectly bound agent.
    // HCL independently evaluates the recorded observations and expected binding.
    if report["health"]["sandbox_ready"] != true
        || report["health"]["policy_loaded"] != true
        || report["health"]["agent_name"] != report["expected"]["agent_name"]
    {
        return Err("required health check failed".into());
    }
    report["failure"]["observed_at"] = json!("fabric.invoke");
    report["response"]["attempted"] = json!(true);
    save(report_path, report)?;
    let input: Value =
        serde_json::from_slice(&fs::read(request).map_err(|_| "cannot read request")?)
            .map_err(|_| "invalid request")?;
    // Reuse the production bridge, including its deadline and no-retry behavior.
    let response = client
        .invoke_agent(&binding, runtime, &input)
        .await
        .map_err(|_| "invocation failed")?;
    report["response"] = super::response::observations(&response, inputs.response_contract);
    report["failure"]["code"] = json!("none");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nemoclaw_sdk::backend::Backend as _;
    use std::collections::BTreeMap;

    #[tokio::test]
    async fn the_probe_observes_the_bound_sandbox_and_invokes_only_after_health_checks() {
        let fixture = nemoclaw_e2e::openshell::Fixture::start().await;
        let mut document = Document::parse(
            include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
        )
        .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let client = OpenShell::connect(
            &document.spec.gateway.connection(),
            Arc::new(EnvironmentSecrets),
        )
        .unwrap();
        let generations = ["workspace", "provider", "sandbox"]
            .map(|name| (name.into(), format!("{name}-generation")))
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        let targets = nemoclaw_e2e::image_runtime::targets(&document, &generations).unwrap();
        for target in targets.iter().filter(|t| {
            matches!(
                t.kind.as_str(),
                "workspace" | "provider_profile" | "provider"
            )
        }) {
            assert!(
                client
                    .ensure(&target.kind, &target.values)
                    .await
                    .error()
                    .is_none()
            );
        }
        let desired = targets.iter().find(|t| t.kind == "sandbox").unwrap();
        let binding = client
            .ensure("sandbox", &desired.values)
            .await
            .into_parts()
            .0
            .unwrap();
        let bound = fabric_provider::fabric_binding(binding.clone()).unwrap();
        let runtime = client
            .start_agent(&bound, &json!({"metadata":{"name":bound["agent_name"]}}))
            .await
            .unwrap();
        let reply = json!({"operation":"invoke","status":"succeeded","changed":false,"error":null,"result":{
            "status":"succeeded","error":null,"agent_name":bound["agent_name"],"runtime_id":runtime,
            "output":{"response":"fixture reply"}
        }});
        fixture.state.lock().unwrap().exec_response = Some(format!("{reply}\n").into_bytes());
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("deployment.yaml");
        let request = root.path().join("request.json");
        let report_path = root.path().join("report.json");
        // The requested agent is deliberately not the first sandbox in the YAML.
        let mut other = document.spec.sandboxes["assistant"].clone();
        other.agent.name = "another-agent".into();
        document.spec.sandboxes.insert("aaa".into(), other);
        fs::write(&config, document.yaml().unwrap()).unwrap();
        fs::write(&request, json!("test question").to_string()).unwrap();
        let mut state = json!({"resources":[
            {"mode":"managed","type":"openshell_sandbox","name":"assistant","instances":[{"attributes":{
                "name":binding["name"],"id":binding["id"],"owner":binding["owner"],"generation":binding["generation"]
            }}]},
            {"mode":"managed","type":"fabric_agent","name":"assistant","instances":[{"attributes":{"runtime_id":runtime}}]}
        ]});
        fs::write(root.path().join("terraform.tfstate"), state.to_string()).unwrap();
        let inputs = Inputs {
            config,
            state_dir: root.path().into(),
            request,
            agent: bound["agent_name"].clone(),
            response_contract: crate::response::Contract::Openclaw,
            report: report_path.clone(),
        };
        let mut report = initial_report();
        observe(&inputs, &mut report).await.unwrap();
        assert_eq!(
            report["health"],
            json!({
                "gateway_ready":true,"sandbox_ready":true,"identity_matches":true,
                "agent_name":bound["agent_name"],"policy_loaded":true
            })
        );
        assert_eq!(
            report["expected"],
            json!({"agent_name":bound["agent_name"],"runtime_id":runtime})
        );
        assert_eq!(
            report["response"],
            json!({
                "attempted":true,"succeeded":true,"agent_name":bound["agent_name"],
                "runtime_id":runtime,"output_valid":true
            })
        );
        let calls = fixture.state.lock().unwrap().exec_calls.len();
        state["resources"][0]["instances"][0]["attributes"]["id"] = json!("another-sandbox");
        fs::write(root.path().join("terraform.tfstate"), state.to_string()).unwrap();
        let mut rejected = initial_report();
        assert!(observe(&inputs, &mut rejected).await.is_err());
        assert_eq!(rejected["response"]["attempted"], false);
        assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls);
    }
}
