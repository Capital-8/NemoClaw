// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! GitHub-hosted controller for the operator's DGX Station v1 receiver.

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path, process::ExitCode, time::Duration};

type Result<T> = std::result::Result<T, String>;
const AUDIENCE: &str = "nemoclaw-dgx-station-v1-dispatch";
const STATUS_LIMIT: usize = 64 * 1024;
const LOG_LIMIT: usize = 4 * 1024 * 1024;
const ARCHIVE_LIMIT: usize = 1024 * 1024;
const ARTIFACT_LIMIT: usize = LOG_LIMIT * 6 + ARCHIVE_LIMIT * 2 + STATUS_LIMIT;

fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn example_path(path: &str) -> bool {
    path.len() <= 512
        && path.starts_with("examples/")
        && (path.ends_with(".yaml") || path.ends_with(".yml"))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
}

fn request(candidate: String, example: String, run: String, attempt: String) -> Result<Value> {
    if candidate.len() != 40
        || !candidate
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("candidate must be a full lowercase commit SHA".into());
    }
    if !example_path(&example) {
        return Err("example must be a normalized YAML path below examples/".into());
    }
    let positive = |v: &str| {
        v.parse::<u64>()
            .ok()
            .filter(|n| *n > 0 && n.to_string() == v)
    };
    if positive(&run).is_none() {
        return Err("workflow run ID must be a positive decimal integer".into());
    }
    let attempt =
        positive(&attempt).ok_or("workflow attempt must be a positive decimal integer")?;
    Ok(
        json!({"schemaVersion": 4, "target": "dgx-station-v1", "candidateSha": candidate, "examplePath": example, "workflowRunId": run, "workflowRunAttempt": attempt}),
    )
}

fn job_id(request: &Value) -> String {
    let identity = format!(
        "4:dgx-station-v1:{}:{}:{}:{}",
        request["candidateSha"].as_str().unwrap(),
        request["examplePath"].as_str().unwrap(),
        request["workflowRunId"].as_str().unwrap(),
        request["workflowRunAttempt"]
    );
    Sha256::digest(identity.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn origin(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "invalid dispatch URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("dispatch URL must be an HTTPS origin without credentials or a path".into());
    }
    Ok(url)
}

fn validate_status(status: &Value, request: &Value, job: &str) -> Result<()> {
    if status["schemaVersion"] != 4 || status["jobId"] != job || status["request"] != *request {
        return Err("backend returned a different dispatch identity".into());
    }
    match status["state"].as_str() {
        Some("queued" | "running")
            if status["cleanup"] == "pending" && status.get("conclusion").is_none() =>
        {
            Ok(())
        }
        Some("completed") => {
            if !matches!(
                status["conclusion"].as_str(),
                Some("success" | "failure" | "cancelled" | "timed-out" | "cleanup-failed")
            ) || !matches!(status["cleanup"].as_str(), Some("succeeded" | "failed"))
                || (status["conclusion"] == "success" && status["cleanup"] != "succeeded")
            {
                return Err("backend returned an invalid terminal result".into());
            }
            Ok(())
        }
        _ => Err("backend returned an invalid job state".into()),
    }
}

#[async_trait]
trait Api: Sync {
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<Value>;
}

struct Http {
    client: Client,
    base: Url,
    token_url: Url,
    request_token: String,
}

async fn response(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    if !response.status().is_success() {
        return Err(format!("dispatch HTTP {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("dispatch response exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "dispatch response read failed")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("dispatch response exceeds its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "dispatch response is not JSON".into())
}

impl Http {
    fn from_environment() -> Result<Self> {
        let mut token_url = Url::parse(&required("ACTIONS_ID_TOKEN_REQUEST_URL")?)
            .map_err(|_| "invalid GitHub OIDC URL")?;
        if token_url.scheme() != "https"
            || !token_url.username().is_empty()
            || token_url.password().is_some()
        {
            return Err("GitHub OIDC URL must use HTTPS without credentials".into());
        }
        token_url
            .query_pairs_mut()
            .append_pair("audience", AUDIENCE);
        Ok(Self {
            client: Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| "HTTP client setup failed")?,
            base: origin(&required("DGX_STATION_V1_DISPATCH_URL")?)?,
            token_url,
            request_token: required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?,
        })
    }
}

#[async_trait]
impl Api for Http {
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        limit: usize,
    ) -> Result<Value> {
        let token = self
            .client
            .get(self.token_url.clone())
            .bearer_auth(&self.request_token)
            .send()
            .await
            .map_err(|_| "GitHub OIDC token request failed")?;
        let token = response(token, 32 * 1024).await?;
        let token = token["value"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 16 * 1024)
            .ok_or("invalid GitHub OIDC token response")?;
        let url = self.base.join(path).map_err(|_| "invalid dispatch route")?;
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(token)
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(body).map_err(|_| "invalid request")?);
        }
        response(
            request
                .send()
                .await
                .map_err(|_| "dispatch transport failed")?,
            limit,
        )
        .await
    }
}

fn save(directory: &Path, name: &str, value: &Value) -> Result<()> {
    fs::write(
        directory.join(name),
        serde_json::to_vec_pretty(value).map_err(|_| "cannot encode dispatch receipt")?,
    )
    .map_err(|_| "cannot save dispatch receipt".into())
}

async fn drive(
    api: &impl Api,
    request: &Value,
    job: &str,
    directory: &Path,
    interval: Duration,
) -> Result<bool> {
    let mut status = api
        .call(Method::POST, "v1/jobs", Some(request), STATUS_LIMIT)
        .await?;
    loop {
        validate_status(&status, request, job)?;
        save(directory, "station-dispatch.json", &status)?;
        if status["state"] == "completed" {
            break;
        }
        tokio::time::sleep(interval).await;
        status = api
            .call(Method::GET, &format!("v1/jobs/{job}"), None, STATUS_LIMIT)
            .await?;
    }
    let artifact = api
        .call(
            Method::GET,
            &format!("v1/jobs/{job}/artifact"),
            None,
            ARTIFACT_LIMIT,
        )
        .await?;
    validate_status(&artifact["status"], request, job)?;
    if artifact["status"] != status {
        return Err("artifact status differs from the terminal result".into());
    }
    let log = artifact["log"]
        .as_str()
        .filter(|log| log.len() <= LOG_LIMIT)
        .ok_or("invalid artifact log")?;
    fs::write(directory.join("station.log"), log).map_err(|_| "cannot save dispatch log")?;
    if let Some(archive) = artifact.get("artifactArchiveBase64") {
        let archive = archive
            .as_str()
            .filter(|s| s.len() <= ARCHIVE_LIMIT.div_ceil(3) * 4)
            .ok_or("invalid artifact archive")?;
        let decoded = STANDARD
            .decode(archive)
            .map_err(|_| "invalid archive encoding")?;
        if decoded.len() > ARCHIVE_LIMIT {
            return Err("artifact archive exceeds its size limit".into());
        }
        fs::write(directory.join("station-artifacts.tar.gz"), decoded)
            .map_err(|_| "cannot save artifact archive")?;
    }
    Ok(status["conclusion"] == "success" && status["cleanup"] == "succeeded")
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn dispatch(
    api: &impl Api,
    request: &Value,
    directory: &Path,
    interval: Duration,
    deadline: Duration,
) -> Result<bool> {
    let job = job_id(request);
    let mut receipt = json!({"schemaVersion": 4, "jobId": job, "request": request});
    save(directory, "station-dispatch.json", &receipt)?;
    let result = tokio::select! {
        result = tokio::time::timeout(deadline, drive(api, request, &job, directory, interval)) => result.map_err(|_| "dispatch deadline exceeded".to_owned()).and_then(|result| result),
        _ = shutdown() => Err("dispatch interrupted".into()),
    };
    if let Err(error) = result {
        receipt["cancellation"] = match api
            .call(
                Method::DELETE,
                &format!("v1/jobs/{job}"),
                None,
                STATUS_LIMIT,
            )
            .await
        {
            Ok(status) if validate_status(&status, request, &job).is_ok() => json!("requested"),
            _ => json!("unconfirmed"),
        };
        save(directory, "station-recovery.json", &receipt)?;
        return Err(format!(
            "{error}; cancellation {}; inspect the dispatch receipt",
            receipt["cancellation"]
        ));
    }
    result
}

async fn run() -> Result<bool> {
    let request = request(
        required("STATION_CANDIDATE_SHA")?,
        required("STATION_EXAMPLE_PATH")?,
        required("GITHUB_RUN_ID")?,
        required("GITHUB_RUN_ATTEMPT")?,
    )?;
    let api = Http::from_environment()?;
    let directory = std::path::PathBuf::from(required("STATION_ARTIFACT_DIR")?);
    if !directory.is_absolute() {
        return Err("STATION_ARTIFACT_DIR must be absolute".into());
    }
    fs::create_dir(&directory).map_err(|_| "artifact directory must be new")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "cannot protect artifact directory")?;
    }
    dispatch(
        &api,
        &request,
        &directory,
        Duration::from_secs(10),
        Duration::from_secs(110 * 60),
    )
    .await
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => {
            println!("Station example and backend cleanup passed");
            ExitCode::SUCCESS
        }
        Ok(false) => {
            eprintln!("Station test or backend cleanup failed; inspect the artifacts");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};

    struct Fake {
        replies: Mutex<VecDeque<Result<Value>>>,
        calls: Mutex<Vec<(Method, String)>>,
    }

    #[async_trait]
    impl Api for Fake {
        async fn call(
            &self,
            method: Method,
            path: &str,
            _body: Option<&Value>,
            _limit: usize,
        ) -> Result<Value> {
            self.calls.lock().unwrap().push((method, path.into()));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected backend request")
        }
    }

    fn candidate() -> Value {
        request(
            "a".repeat(40),
            "examples/gtc-dc/openclaw-dgx-station.yaml".into(),
            "123456789".into(),
            "1".into(),
        )
        .unwrap()
    }

    #[test]
    fn matches_the_station_handoff_job_identity() {
        assert_eq!(
            job_id(&candidate()),
            "1d9fa04f619dc5eb6b7d30cf4b680989229bc685655e3b2f66d754d42dba7ec8"
        );
    }

    #[tokio::test]
    async fn bounds_http_bodies_and_keeps_backend_error_text_out_of_errors() {
        let reply = |status, body: &str| {
            reqwest::Response::from(
                http::Response::builder()
                    .status(status)
                    .body(body.to_owned())
                    .unwrap(),
            )
        };
        assert_eq!(
            response(reply(200, "{\"ok\":true}"), 32).await.unwrap(),
            json!({"ok":true})
        );
        assert!(response(reply(200, "{\"ok\":true}"), 4).await.is_err());
        assert!(response(reply(200, "not JSON"), 32).await.is_err());
        let error = response(reply(401, "private-backend-message"), 32)
            .await
            .unwrap_err();
        assert_eq!(error, "dispatch HTTP 401");
    }

    fn status(request: &Value, state: &str, conclusion: Option<&str>, cleanup: &str) -> Value {
        let mut status = json!({"schemaVersion":4,"jobId":job_id(request),"request":request,"state":state,"cleanup":cleanup});
        if let Some(conclusion) = conclusion {
            status["conclusion"] = conclusion.into();
        }
        status
    }

    fn fake(replies: Vec<Result<Value>>) -> Fake {
        Fake {
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn rejects_paths_outside_repository_examples_and_credential_bearing_origins() {
        for path in [
            "/examples/a.yaml",
            "examples/../a.yaml",
            "examples//a.yaml",
            "examples/./a.yaml",
            "examples/a.yaml;id",
            "examples/a.yaml\n",
            "examples/a.txt",
            "examples/a\\b.yaml",
        ] {
            assert!(!example_path(path), "{path:?}");
        }
        for url in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/jobs",
            "https://example.com/?token=secret",
            "https://example.com/#fragment",
        ] {
            assert!(origin(url).is_err());
        }
        assert_eq!(
            origin("https://example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert!(
            request(
                "main".into(),
                "examples/a.yaml".into(),
                "1".into(),
                "1".into()
            )
            .is_err()
        );
        for attempt in ["0", "-1", "1.5", "01"] {
            assert!(
                request(
                    "a".repeat(40),
                    "examples/a.yaml".into(),
                    "1".into(),
                    attempt.into()
                )
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn polls_the_owned_job_and_downloads_bounded_artifacts_after_cleanup() {
        let request = candidate();
        let complete = status(&request, "completed", Some("success"), "succeeded");
        let api = fake(vec![
            Ok(status(&request, "queued", None, "pending")),
            Ok(status(&request, "running", None, "pending")),
            Ok(complete.clone()),
            Ok(
                json!({"status":complete,"log":"components passed","artifactArchiveBase64":STANDARD.encode(b"archive")}),
            ),
        ]);
        let directory = tempfile::tempdir().unwrap();
        assert!(
            dispatch(
                &api,
                &request,
                directory.path(),
                Duration::ZERO,
                Duration::from_secs(5)
            )
            .await
            .unwrap()
        );
        assert_eq!(
            fs::read(directory.path().join("station-artifacts.tar.gz")).unwrap(),
            b"archive"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("station.log")).unwrap(),
            "components passed"
        );
        let calls = api.calls.lock().unwrap();
        let job = job_id(&request);
        assert_eq!(
            *calls,
            vec![
                (Method::POST, "v1/jobs".into()),
                (Method::GET, format!("v1/jobs/{job}")),
                (Method::GET, format!("v1/jobs/{job}")),
                (Method::GET, format!("v1/jobs/{job}/artifact"))
            ]
        );
    }

    #[tokio::test]
    async fn propagates_failed_tests_and_cleanup_without_repeating_the_job() {
        for (conclusion, cleanup) in [
            ("failure", "succeeded"),
            ("cleanup-failed", "failed"),
            ("timed-out", "succeeded"),
            ("cancelled", "succeeded"),
        ] {
            let request = candidate();
            let complete = status(&request, "completed", Some(conclusion), cleanup);
            let api = fake(vec![
                Ok(complete.clone()),
                Ok(json!({"status":complete,"log":"failure"})),
            ]);
            let directory = tempfile::tempdir().unwrap();
            assert!(
                !dispatch(
                    &api,
                    &request,
                    directory.path(),
                    Duration::ZERO,
                    Duration::from_secs(5)
                )
                .await
                .unwrap()
            );
            assert_eq!(api.calls.lock().unwrap().len(), 2);
            assert!(directory.path().join("station.log").is_file());
        }
    }

    #[tokio::test]
    async fn cancels_an_uncertain_submission_and_keeps_its_recovery_identity() {
        let request = candidate();
        let api = fake(vec![
            Err("lost POST response".into()),
            Ok(status(
                &request,
                "completed",
                Some("cancelled"),
                "succeeded",
            )),
        ]);
        let directory = tempfile::tempdir().unwrap();
        assert!(
            dispatch(
                &api,
                &request,
                directory.path(),
                Duration::ZERO,
                Duration::from_secs(5)
            )
            .await
            .is_err()
        );
        let receipt: Value = serde_json::from_slice(
            &fs::read(directory.path().join("station-recovery.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["jobId"], job_id(&request));
        assert_eq!(receipt["request"], request);
        assert_eq!(receipt["cancellation"], "requested");
        assert_eq!(
            *api.calls.lock().unwrap(),
            vec![
                (Method::POST, "v1/jobs".into()),
                (Method::DELETE, format!("v1/jobs/{}", job_id(&request)))
            ]
        );
    }

    #[tokio::test]
    async fn cancels_and_reports_an_unconfirmed_cancellation_after_status_failure() {
        let request = candidate();
        let api = fake(vec![
            Ok(status(&request, "running", None, "pending")),
            Err("status transport failed".into()),
            Err("cancel transport failed".into()),
        ]);
        let directory = tempfile::tempdir().unwrap();
        let error = dispatch(
            &api,
            &request,
            directory.path(),
            Duration::ZERO,
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.contains("unconfirmed"));
        assert_eq!(api.calls.lock().unwrap().last().unwrap().0, Method::DELETE);
    }

    #[tokio::test]
    async fn cancels_when_the_controller_deadline_expires() {
        let request = candidate();
        let api = fake(vec![
            Ok(status(&request, "running", None, "pending")),
            Ok(status(&request, "running", None, "pending")),
        ]);
        let directory = tempfile::tempdir().unwrap();
        let error = dispatch(
            &api,
            &request,
            directory.path(),
            Duration::from_secs(10),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert!(error.contains("deadline"));
        assert_eq!(api.calls.lock().unwrap().last().unwrap().0, Method::DELETE);
    }

    #[test]
    fn rejects_success_for_another_candidate_or_incomplete_cleanup() {
        let request = json!({"candidateSha": "a".repeat(40), "examplePath": "examples/gtc-dc/openclaw-dgx-station.yaml"});
        let status = json!({"schemaVersion": 4, "jobId": "job", "request": request, "state": "completed", "conclusion": "success", "cleanup": "succeeded"});
        validate_status(&status, &request, "job").unwrap();
        for (field, value) in [
            ("jobId", json!("other")),
            ("request", json!({"candidateSha": "b".repeat(40)})),
            ("cleanup", json!("pending")),
            ("cleanup", json!("failed")),
            ("conclusion", json!("unknown")),
            ("state", json!("unknown")),
        ] {
            let mut invalid = status.clone();
            invalid[field] = value;
            assert!(
                validate_status(&invalid, &request, "job").is_err(),
                "{field}"
            );
        }
    }
}
