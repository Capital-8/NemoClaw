// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::CancellationToken;
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use std::{
    collections::BTreeMap, ffi::OsString, fs::File, path::Path, process::Stdio, time::Duration,
};

/// Stop the complete subprocess group before the caller starts deployment cleanup.
pub(super) async fn execute(
    binary: &Path,
    args: &[OsString],
    directory: &Path,
    label: &str,
    environment: &BTreeMap<OsString, OsString>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err(format!("{label}: cancelled"));
    }
    let stdout = File::create(directory.join(format!("{label}.stdout")))
        .map_err(|_| "cannot create stdout evidence")?;
    let stderr = File::create(directory.join(format!("{label}.stderr")))
        .map_err(|_| "cannot create stderr evidence")?;
    let mut command = CommandWrap::with_new(binary, |c| {
        c.args(args)
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        if label.starts_with("tofu-") {
            let path = std::env::var_os("PATH");
            c.env_clear();
            if let Some(path) = path {
                c.env("PATH", path);
            }
        }
        // Ambient OpenTofu arguments must not redirect either local state directory.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("TF_")
                || key.to_string_lossy().starts_with("TOFU_")
            {
                c.env_remove(key);
            }
        }
        c.envs(environment);
    });
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::JobObject);
    let mut child = command
        .spawn()
        .map_err(|_| format!("{label}: cannot start executable"))?;
    let result = tokio::select! {
        status = child.wait() => status.map_err(|_| format!("{label}: cannot wait for executable"))
            .and_then(|s| if s.success() { Ok(()) } else { Err(format!("{label}: command failed; inspect private evidence")) }),
        () = cancel.cancelled() => Err(format!("{label}: cancelled")),
        () = tokio::time::sleep(Duration::from_secs(600)) => Err(format!("{label}: deadline exceeded")),
    };
    if result.is_err() {
        #[cfg(unix)]
        let _ = child.signal(2);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    result
}
