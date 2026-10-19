// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-neutral runtime entry point. Package dispatch remains inside the
//! service component alongside each installer's implementation.

pub(super) mod supervisor;

use crate::{CancellationToken, Error};
use std::path::Path;

pub async fn run(cancel: &CancellationToken, trip: &CancellationToken) -> Result<(), Error> {
    holds_after_protection()?;
    let text = match std::env::var("NEMOCLAW_RUNTIME_SPEC") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            return Err(Error::State("missing runtime specification"));
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(Error::State("runtime specification is not UTF-8"));
        }
    };
    match crate::RuntimeSpec::decode(&text)? {
        crate::RuntimeSpec::Ollama(service) => {
            crate::ollama::runtime::run(&service, cancel, trip).await
        }
        crate::RuntimeSpec::Vllm(service) => {
            crate::vllm::runtime::run(&service, cancel, trip).await
        }
    }
}

pub(super) fn report(phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    report_at(Path::new("/data"), phase, detail, pid)
}

fn report_at(root: &Path, phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    let updated = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::State("cannot timestamp runtime status"))?;
    let value = serde_json::json!({"phase":phase,"detail":detail,"updated":updated,"pid":pid});
    crate::files::save_json(&root.join("status.json"), &value)?;
    eprintln!("{phase}: {detail}");
    Ok(())
}

/// Whether the platform asked the runtime to stay alive after a protective stop.
fn holds_after_protection() -> Result<bool, Error> {
    on_stop(std::env::var_os(crate::ON_STOP_ENV))
}

fn on_stop(value: Option<std::ffi::OsString>) -> Result<bool, Error> {
    match value.as_ref().map(|value| value.to_str()) {
        None | Some(Some("exit")) => Ok(false),
        Some(Some("hold")) => Ok(true),
        _ => Err(Error::State(
            "NEMOCLAW_RUNTIME_ON_STOP must be hold or exit",
        )),
    }
}

/// After the runtime reported `error` as stopped, and while it still holds the
/// storage lock: when memory protection stopped the service and the platform
/// asked to hold, stay alive and unready until the platform stops the
/// container. Other failures exit, so the platform may retry them.
pub(crate) async fn hold(error: &Error, trip: &CancellationToken, cancel: &CancellationToken) {
    hold_if(
        holds_after_protection().unwrap_or(false),
        error,
        trip,
        cancel,
    )
    .await;
}

async fn hold_if(
    holding: bool,
    error: &Error,
    trip: &CancellationToken,
    cancel: &CancellationToken,
) {
    let protective = trip.is_cancelled() || matches!(error, Error::Protection(_));
    if holding && protective {
        eprintln!(
            "holding after memory protection stopped the service; restart the workload to recover"
        );
        cancel.cancelled().await;
    }
}

/// Whether the service in this container is ready, for a platform's readiness
/// probe. It reads the status file only: it neither locks nor writes.
pub fn ready() -> bool {
    ready_at(Path::new("/data"), Path::new("/proc"))
}

fn ready_at(root: &Path, processes: &Path) -> bool {
    #[derive(serde::Deserialize)]
    struct Status {
        phase: String,
        pid: u32,
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    let read = std::fs::File::open(root.join("status.json"))
        .and_then(|file| file.take(128 << 10).read_to_end(&mut bytes));
    let Ok(status) = read
        .map_err(drop)
        .and_then(|_| serde_json::from_slice::<Status>(&bytes).map_err(drop))
    else {
        return false;
    };
    // The runtime reports `initializing` once it holds the storage lock, so a
    // `ready` left by an earlier container is replaced before the service
    // starts; the recorded server process must also still be running.
    status.phase == "ready" && status.pid != 0 && processes.join(status.pid.to_string()).exists()
}

#[cfg(test)]
mod status_tests {
    #[test]
    fn status_replaces_the_previous_phase_and_preserves_it_when_directory_is_missing() {
        let root = tempfile::tempdir().unwrap();
        super::report_at(root.path(), "preparing", "verified model", 0).unwrap();
        super::report_at(root.path(), "ready", "serving", 123).unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(status["phase"], "ready");
        assert_eq!(status["detail"], "serving");
        assert_eq!(status["pid"], 123);
        assert!(
            time::OffsetDateTime::parse(
                status["updated"].as_str().unwrap(),
                &time::format_description::well_known::Rfc3339
            )
            .is_ok()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        assert!(super::report_at(&root.path().join("missing"), "stopped", "failed", 0).is_err());
        let preserved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(preserved, status);
    }

    #[test]
    fn ready_requires_a_ready_phase_and_a_running_server_process() {
        let root = tempfile::tempdir().unwrap();
        let processes = tempfile::tempdir().unwrap();
        std::fs::create_dir(processes.path().join("42")).unwrap();
        let ready = |root: &std::path::Path| super::ready_at(root, processes.path());
        // No status yet: the runtime has not started.
        assert!(!ready(root.path()));
        super::report_at(root.path(), "ready", "serving", 42).unwrap();
        assert!(ready(root.path()));
        // A ready status whose server is gone, as when the container restarted.
        super::report_at(root.path(), "ready", "serving", 43).unwrap();
        assert!(!ready(root.path()));
        for phase in ["initializing", "downloading", "loading", "stopped"] {
            super::report_at(root.path(), phase, "not serving", 42).unwrap();
            assert!(!ready(root.path()), "{phase}");
        }
        std::fs::write(root.path().join("status.json"), b"{\"phase\":\"ready\"}").unwrap();
        assert!(!ready(root.path()));
    }

    #[tokio::test]
    async fn only_memory_protection_holds_and_only_when_the_platform_asks() {
        use crate::{CancellationToken, Error};
        let held = |holding: bool, error: Error, tripped: bool| async move {
            let (trip, cancel) = (CancellationToken::new(), CancellationToken::new());
            if tripped {
                trip.cancel();
            }
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                super::hold_if(holding, &error, &trip, &cancel),
            )
            .await
            .is_err()
        };
        assert!(held(true, Error::Protection("pressure".into()), false).await);
        assert!(held(true, Error::Conflict("tripped"), true).await);
        assert!(!held(true, Error::Conflict("process exited"), false).await);
        assert!(!held(false, Error::Protection("pressure".into()), false).await);
        // A held runtime still stops when the platform stops the container.
        let (trip, cancel) = (CancellationToken::new(), CancellationToken::new());
        cancel.cancel();
        super::hold_if(true, &Error::Protection("pressure".into()), &trip, &cancel).await;
    }

    #[test]
    fn the_stop_setting_accepts_only_hold_or_exit() {
        let setting = |value: Option<&str>| super::on_stop(value.map(Into::into));
        assert!(!setting(None).unwrap());
        assert!(!setting(Some("exit")).unwrap());
        assert!(setting(Some("hold")).unwrap());
        for value in ["", "Hold", "restart"] {
            assert!(setting(Some(value)).is_err(), "{value}");
        }
    }
}
