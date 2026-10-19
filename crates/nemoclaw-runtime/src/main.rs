// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    // A readiness probe runs this binary under its ready name. A name, not an
    // argument, selects it: runtimes that predate it ignore arguments and
    // would start a second service instead.
    let ready = std::path::Path::new(nemoclaw_runtime::READY_ENTRYPOINT).file_name();
    if std::env::args_os()
        .next()
        .is_some_and(|program| std::path::Path::new(&program).file_name() == ready)
    {
        return if nemoclaw_runtime::ready() {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::FAILURE
        };
    }
    serve()
}

#[cfg(target_os = "linux")]
#[tokio::main]
async fn serve() -> std::process::ExitCode {
    use nemoclaw_runtime::{CancellationToken, Error};
    let cancel = CancellationToken::new();
    let trip = CancellationToken::new();
    let signals=async {
        let mut stop=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|_|Error::State("cannot install runtime termination handler"))?;
        let mut interrupt=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).map_err(|_|Error::State("cannot install runtime interrupt handler"))?;
        let mut protection=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1()).map_err(|_|Error::State("cannot install protection handler"))?;
        let cancel=cancel.clone();let trip=trip.clone();
        Ok::<_,Error>(tokio::spawn(async move {
            tokio::select! { _=stop.recv()=>cancel.cancel(),_=interrupt.recv()=>cancel.cancel(),_=protection.recv()=>trip.cancel() }
        }))
    }.await;
    let result = async {
        let _signals = signals?;
        nemoclaw_runtime::run(&cancel, &trip).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("{error}");
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("managed service runtimes require Linux");
    std::process::ExitCode::FAILURE
}
