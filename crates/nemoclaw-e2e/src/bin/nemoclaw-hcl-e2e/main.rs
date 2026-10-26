// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod case;
mod probe;
mod process;
mod run;

use clap::{Parser, Subcommand};
use nemoclaw_sdk::CancellationToken;
use serde_json::Value;
use std::{path::PathBuf, process::ExitCode};

fn response_valid(response: &Value, agent: &str, runtime: &str) -> bool {
    nemoclaw_e2e::state::successful_invocation(&serde_json::to_vec(response).unwrap())
        && response["agent_name"] == agent
        && response["runtime_id"] == runtime
        && response["output"]["response"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
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
    use serde_json::json;

    #[test]
    fn an_empty_response_cannot_pass_the_live_response_contract() {
        let response = json!({
            "status": "succeeded", "error": null,
            "agent_name": "assistant", "runtime_id": "runtime", "output": null
        });
        assert!(!response_valid(&response, "assistant", "runtime"));
    }

    #[test]
    fn the_response_must_be_nonempty_successful_and_from_the_expected_binding() {
        let good = json!({"status":"succeeded", "error":null, "agent_name":"assistant", "runtime_id":"runtime", "output":{"response":"Hello"}});
        assert!(response_valid(&good, "assistant", "runtime"));
        for (pointer, value) in [
            ("/agent_name", json!("other")),
            ("/runtime_id", json!("other")),
            ("/status", json!("failed")),
            ("/error", json!({"code":"model_error"})),
            ("/output/response", json!(" ")),
            ("/output/response", Value::Null),
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert!(!response_valid(&bad, "assistant", "runtime"), "{pointer}");
        }
    }
}
