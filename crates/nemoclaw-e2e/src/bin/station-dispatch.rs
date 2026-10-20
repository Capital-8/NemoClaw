// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{name} is required").into())
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

fn validate_status(status: &Value, request: &Value, job: &str) -> Result<()> {
    if status["schemaVersion"] != 4 || status["jobId"] != job || status["request"] != *request {
        return Err("backend returned a different dispatch identity".into());
    }
    let valid = match status["state"].as_str() {
        Some("queued" | "running") => {
            status["cleanup"] == "pending" && status.get("conclusion").is_none()
        }
        Some("completed") => {
            matches!(
                status["conclusion"].as_str(),
                Some("success" | "failure" | "cancelled" | "timed-out" | "cleanup-failed")
            ) && matches!(status["cleanup"].as_str(), Some("succeeded" | "failed"))
                && (status["conclusion"] != "success" || status["cleanup"] == "succeeded")
        }
        _ => false,
    };
    if !valid {
        return Err("backend returned an invalid job status".into());
    }
    Ok(())
}

async fn read(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    if !response.status().is_success() {
        return Err(format!("dispatch HTTP {}", response.status().as_u16()).into());
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
    Ok(serde_json::from_slice(&bytes)?)
}

struct Backend {
    client: Client,
    url: Url,
    oidc: Url,
    request_token: String,
}

impl Backend {
    async fn request(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let token = self
            .client
            .get(self.oidc.clone())
            .bearer_auth(&self.request_token)
            .send()
            .await
            .map_err(|_| "GitHub OIDC request failed")?;
        let token = read(token, 32 * 1024).await?;
        let mut call = self
            .client
            .request(method, self.url.join(path)?)
            .bearer_auth(token["value"].as_str().ok_or("missing OIDC token")?);
        if let Some(body) = body {
            call = call
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        let limit = if path.ends_with("/artifact") {
            32 * 1024 * 1024
        } else {
            64 * 1024
        };
        read(
            call.send().await.map_err(|_| "dispatch transport failed")?,
            limit,
        )
        .await
    }

    async fn execute(&self, request: &Value, job: &str, receipt: &std::path::Path) -> Result<bool> {
        let mut status = self.request(Method::POST, "v1/jobs", Some(request)).await?;
        loop {
            validate_status(&status, request, job)?;
            fs::write(receipt, status.to_string())?;
            if status["state"] == "completed" {
                break;
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
            status = self
                .request(Method::GET, &format!("v1/jobs/{job}"), None)
                .await?;
        }
        let artifact = self
            .request(Method::GET, &format!("v1/jobs/{job}/artifact"), None)
            .await?;
        if artifact["status"] != status {
            return Err("artifact does not match the completed job".into());
        }
        fs::write(receipt, artifact.to_string())?;
        Ok(status["conclusion"] == "success" && status["cleanup"] == "succeeded")
    }
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

async fn run() -> Result<bool> {
    let request = json!({"schemaVersion":4,"target":"dgx-station-v1",
        "candidateSha":required("STATION_CANDIDATE_SHA")?,"examplePath":required("STATION_EXAMPLE_PATH")?,
        "workflowRunId":required("GITHUB_RUN_ID")?,"workflowRunAttempt":required("GITHUB_RUN_ATTEMPT")?.parse::<u32>()?});
    let url = Url::parse(&required("DGX_STATION_V1_DISPATCH_URL")?)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("dispatch URL must be an HTTPS origin without credentials or a path".into());
    }
    let backend = Backend {
        url,
        oidc: {
            let mut url = Url::parse(&required("ACTIONS_ID_TOKEN_REQUEST_URL")?)?;
            url.query_pairs_mut()
                .append_pair("audience", "nemoclaw-dgx-station-v1-dispatch");
            url
        },
        request_token: required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?,
        client: Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()?,
    };
    let directory = PathBuf::from(required("STATION_ARTIFACT_DIR")?);
    if !directory.is_absolute() {
        return Err("artifact directory must be absolute".into());
    }
    let builder = &mut fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory)?;
    dispatch(&backend, &request, &directory).await
}

async fn dispatch(backend: &Backend, request: &Value, directory: &std::path::Path) -> Result<bool> {
    let receipt = directory.join("station-result.json");
    let job = job_id(request);
    fs::write(&receipt, json!({"jobId":job,"request":request}).to_string())?;
    let result = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(110 * 60), backend.execute(request, &job, &receipt)) => result.unwrap_or_else(|_| Err("dispatch deadline exceeded".into())),
        _ = shutdown() => Err("dispatch interrupted".into()),
    };
    if result.is_err() {
        let cancellation = backend
            .request(Method::DELETE, &format!("v1/jobs/{job}"), None)
            .await;
        let confirmed = cancellation
            .as_ref()
            .is_ok_and(|status| validate_status(status, request, &job).is_ok());
        fs::write(
            directory.join("station-cancellation.json"),
            json!({"jobId":job,"request":request,"acknowledged":confirmed}).to_string(),
        )?;
        eprintln!("Cancellation acknowledged: {confirmed}; inspect the job receipt");
    }
    result
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(true) => std::process::ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!("Station test or cleanup failed");
            std::process::ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn propagates_job_results_and_cancels_a_lost_submission_without_resubmitting() {
        use nemoclaw_e2e::http_fixture::Fixture;
        use std::sync::{Arc, Mutex};
        for outcome in [Some(true), Some(false), None] {
            let request = json!({"candidateSha":"a".repeat(40),"examplePath":"examples/gtc-dc/openclaw-dgx-station.yaml","workflowRunId":"123456789","workflowRunAttempt":1});
            let status = json!({"schemaVersion":4,"jobId":job_id(&request),"request":request,"state":"completed","conclusion":if outcome==Some(true){"success"}else{"failure"},"cleanup":"succeeded"});
            let calls = Arc::new(Mutex::new(Vec::new()));
            let observed = calls.clone();
            let fixture = Fixture::start_tcp(move |call| {
                if call.path == "/oidc" {
                    assert_eq!(call.header("authorization"), Some("Bearer request-token"));
                    return Some((200, json!({"value":"job-token"}).to_string().into_bytes()));
                }
                assert_eq!(call.header("authorization"), Some("Bearer job-token"));
                observed.lock().unwrap().push(call.method.clone());
                let value = match call.method.as_str() {
                    "POST" => {
                        assert_eq!(
                            serde_json::from_slice::<Value>(&call.body).unwrap(),
                            status["request"]
                        );
                        outcome?;
                        status.clone()
                    }
                    "GET" => json!({"status":status,"log":"test result"}),
                    "DELETE" => status.clone(),
                    _ => panic!("unexpected request"),
                };
                Some((200, value.to_string().into_bytes()))
            })
            .await;
            let backend = Backend {
                client: Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(1))
                    .build()
                    .unwrap(),
                url: Url::parse(&fixture.endpoint).unwrap(),
                oidc: Url::parse(&format!("{}/oidc", fixture.endpoint)).unwrap(),
                request_token: "request-token".into(),
            };
            let directory = tempfile::tempdir().unwrap();
            let result = dispatch(&backend, &request, directory.path()).await;
            match outcome {
                Some(passed) => {
                    assert_eq!(result.unwrap(), passed);
                    assert_eq!(*calls.lock().unwrap(), ["POST", "GET"]);
                }
                None => {
                    assert!(result.is_err());
                    assert_eq!(*calls.lock().unwrap(), ["POST", "DELETE"]);
                    let receipt: Value = serde_json::from_slice(
                        &fs::read(directory.path().join("station-cancellation.json")).unwrap(),
                    )
                    .unwrap();
                    assert_eq!(receipt["acknowledged"], true);
                    assert_eq!(receipt["jobId"], job_id(&request));
                }
            }
        }
    }

    #[test]
    fn matches_the_station_handoff_job_identity() {
        let request = json!({"candidateSha":"a".repeat(40),"examplePath":"examples/gtc-dc/openclaw-dgx-station.yaml","workflowRunId":"123456789","workflowRunAttempt":1});
        assert_eq!(
            job_id(&request),
            "1d9fa04f619dc5eb6b7d30cf4b680989229bc685655e3b2f66d754d42dba7ec8"
        );
    }

    #[test]
    fn rejects_success_for_another_candidate_or_incomplete_cleanup() {
        let request = json!({"candidateSha":"a".repeat(40)});
        let status = json!({"schemaVersion":4,"jobId":"job","request":request,"state":"completed","conclusion":"success","cleanup":"succeeded"});
        validate_status(&status, &request, "job").unwrap();
        for (field, value) in [
            ("jobId", json!("other")),
            ("request", json!({"candidateSha":"b".repeat(40)})),
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
            read(reply(200, "{\"ok\":true}"), 32).await.unwrap(),
            json!({"ok":true})
        );
        assert!(read(reply(200, "{\"ok\":true}"), 4).await.is_err());
        assert!(read(reply(200, "not JSON"), 32).await.is_err());
        assert_eq!(
            read(reply(401, "private-backend-message"), 32)
                .await
                .unwrap_err()
                .to_string(),
            "dispatch HTTP 401"
        );
    }
}
