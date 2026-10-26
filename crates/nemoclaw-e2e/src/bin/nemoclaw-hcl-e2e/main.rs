// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod case;
mod probe;
mod process;
mod run;

use clap::{Parser, Subcommand};
use nemoclaw_sdk::CancellationToken;
use serde_json::{Value, json};
use std::{path::PathBuf, process::ExitCode};

fn response_observations(response: &Value) -> Value {
    json!({
        "attempted": true,
        "succeeded": nemoclaw_e2e::state::successful_invocation(&serde_json::to_vec(response).unwrap()),
        "agent_name": response["agent_name"].as_str(),
        "runtime_id": response["runtime_id"].as_str(),
        // Interpret the OpenClaw adapter's payload without retaining response text.
        "has_response_text": response["output"]["response"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
    })
}

#[derive(Parser)]
#[command(about = "Run the Docker/OpenClaw/hosted NVIDIA HCL E2E proof of concept")]
struct Args {
    #[command(subcommand)]
    command: Action,
}

#[derive(Subcommand)]
enum Action {
    Run {
        #[arg(long)]
        case: PathBuf,
        #[arg(long)]
        bundle: PathBuf,
        /// New private directory; an existing directory is refused.
        #[arg(long)]
        run_dir: PathBuf,
    },
    #[command(hide = true)]
    Probe,
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    let result = match args.command {
        Action::Probe => probe::execute().await,
        Action::Run {
            case,
            bundle,
            run_dir,
        } => {
            let cancel = CancellationToken::new();
            #[cfg(unix)]
            let mut terminate =
                match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    Ok(signal) => signal,
                    Err(_) => return ExitCode::FAILURE,
                };
            let token = cancel.clone();
            let signals = tokio::spawn(async move {
                #[cfg(unix)]
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = terminate.recv() => {},
                }
                #[cfg(not(unix))]
                let _ = tokio::signal::ctrl_c().await;
                token.cancel();
            });
            let result = run::execute(&case, &bundle, &run_dir, &cancel).await;
            signals.abort();
            result
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_response_is_reported_without_claiming_response_text() {
        let response = json!({
            "status": "succeeded", "error": null,
            "agent_name": "assistant", "runtime_id": "runtime", "output": null
        });
        let observed = response_observations(&response);
        assert_eq!(observed["has_response_text"], false);
        assert_eq!(observed["agent_name"], "assistant");
        assert_eq!(observed["runtime_id"], "runtime");
    }

    #[test]
    fn response_observations_preserve_the_binding_and_normalize_the_adapter_output() {
        let good = json!({"status":"succeeded", "error":null, "agent_name":"assistant", "runtime_id":"runtime", "output":{"response":"Hello"}});
        assert_eq!(
            response_observations(&good),
            json!({
                "attempted":true,"succeeded":true,"agent_name":"assistant",
                "runtime_id":"runtime","has_response_text":true
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
            (
                "/output/response",
                json!(" "),
                "has_response_text",
                json!(false),
            ),
            (
                "/output/response",
                Value::Null,
                "has_response_text",
                json!(false),
            ),
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert_eq!(response_observations(&bad)[field], expected, "{pointer}");
        }
    }
}
