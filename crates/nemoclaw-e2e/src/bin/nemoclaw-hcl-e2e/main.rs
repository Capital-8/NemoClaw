// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod case;
mod probe;
mod process;
mod response;
mod wrapper;

use clap::{Parser, Subcommand};
use nemoclaw_sdk::CancellationToken;
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(about = "Verify a NemoClaw deployment with shared HCL assertions")]
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
        /// Full source commit used to build the helper and candidate bundle.
        #[arg(long)]
        candidate_revision: String,
        /// New private directory; an existing directory is refused.
        #[arg(long)]
        run_dir: PathBuf,
    },
    /// Collect SDK/provider observations for an existing deployment.
    Probe(probe::Inputs),
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    let result = match args.command {
        Action::Probe(inputs) => probe::execute(&inputs).await,
        Action::Run {
            case,
            bundle,
            candidate_revision,
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
            let result =
                wrapper::execute(&case, &bundle, &candidate_revision, &run_dir, &cancel).await;
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
