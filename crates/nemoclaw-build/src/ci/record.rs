// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The record of one live suite run: what it ran, where, how each test ended,
//! and what it does not establish. Each field is typed and read from an
//! allow-listed source, and each string must be one token of reference
//! characters, so a record holds no test output or other free text. A value
//! that cannot be read is `null` and never fails the run.

use super::{Step, timing};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, process::Command};

/// The version of the record's JSON schema. Bump it when a field is removed
/// or changes meaning.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
pub struct Record {
    schema_version: u32,
    suite: &'static str,
    platform: String,
    revision: Revision,
    bundle: Bundle,
    pins: Pins,
    agent: Agent,
    /// `RUNNER_OS`, `RUNNER_ARCH`, `ImageOS`, and `ImageVersion`, which
    /// GitHub-hosted runners set.
    runner: BTreeMap<&'static str, Option<String>>,
    /// The step's outcome, after its time budget.
    outcome: Outcome,
    /// The JUnit report's run time, when this run wrote one.
    wall_seconds: Option<f64>,
    tests: Vec<Test>,
    /// Fixed codes for what the suite does not establish.
    limitations: &'static [&'static str],
}

/// `GITHUB_SHA`, which for a pull request is its merge commit, or else
/// `HEAD`; whether `git status` lists any file; and the GitHub Actions run.
#[derive(Serialize)]
struct Revision {
    commit: Option<String>,
    dirty: Option<bool>,
    run_id: Option<u64>,
    run_attempt: Option<u32>,
}

/// The `Version` and SHA-256 of `dist/PLATFORM/manifest.json`.
#[derive(Serialize)]
struct Bundle {
    version: Option<String>,
    manifest_sha256: Option<String>,
}

/// The pins from `versions.json`, and `FABRIC_REVISION` from
/// `image/fabric/Dockerfile`.
#[derive(Serialize)]
struct Pins {
    gateway: Option<String>,
    supervisor: Option<String>,
    sandbox_runtime: Option<String>,
    gateway_chart: Option<String>,
    openshell_revision: Option<String>,
    fabric_revision: Option<String>,
    #[serde(flatten)]
    kind: Option<KindPins>,
}

/// The platform's kind executable, the node image, and the Agent Sandbox
/// release that live-kind installs.
#[derive(Serialize)]
struct KindPins {
    kind: Option<Artifact>,
    kind_node: Option<String>,
    agent_sandbox: Option<Artifact>,
}

#[derive(Serialize)]
struct Artifact {
    url: String,
    sha256: String,
}

/// The digest of the agent image the tests deployed, and its Fabric harness.
#[derive(Serialize)]
struct Agent {
    image_digest: Option<String>,
    harness: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Passed,
    Failed,
}

/// One test's outcome and time from the JUnit report, without its output.
#[derive(Serialize)]
struct Test {
    binary: Option<String>,
    name: Option<String>,
    outcome: Outcome,
    seconds: f64,
}

/// What a live run used, as the runner knows it.
pub struct Inputs<'a> {
    pub suite: Step,
    pub platform: &'a str,
    /// The checkout, with `versions.json`, `image/fabric/Dockerfile`, and
    /// `dist/PLATFORM/manifest.json`.
    pub root: &'a Path,
    pub passed: bool,
    /// The JUnit report this run wrote, if any.
    pub junit: Option<&'a str>,
    /// The agent image the tests deployed, as `REFERENCE@sha256:HEX`, once
    /// the suite resolved it.
    pub agent_image: Option<&'a str>,
    pub harness: &'a str,
    /// The URL and SHA-256 of the Agent Sandbox release that live-kind installs.
    pub agent_sandbox: (&'a str, &'a str),
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// Git's standard output for these arguments, or `None` when Git fails.
    pub git: &'a dyn Fn(&[&str]) -> Option<String>,
}

/// Run Git in the current directory, returning its standard output, or
/// `None` when Git is missing or fails.
#[must_use]
pub fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `value` when it is one token of reference characters, as image
/// references, URLs, versions, and runner names are.
fn token(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/@+-".contains(&byte)))
    .then(|| value.to_owned())
}

/// `value` when it is lowercase hexadecimal of one of `lengths`, as commits
/// and SHA-256 digests are.
fn hex(value: &str, lengths: &[usize]) -> Option<String> {
    let value = value.trim();
    (lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    .then(|| value.to_owned())
}

/// A Git commit, SHA-1 or SHA-256.
fn commit(value: &str) -> Option<String> {
    hex(value, &[40, 64])
}

fn artifact(url: Option<&str>, sha256: Option<&str>) -> Option<Artifact> {
    Some(Artifact {
        url: token(url?)?,
        sha256: hex(sha256?, &[64])?,
    })
}

fn outcome(passed: bool) -> Outcome {
    if passed {
        Outcome::Passed
    } else {
        Outcome::Failed
    }
}

/// `seconds` rounded to the milliseconds that JUnit reports hold, so `1.993`
/// is not written as `1.9929999999999999`.
fn milliseconds(seconds: f64) -> f64 {
    (seconds * 1000.0).round() / 1000.0
}

/// Build the record of a live run. Inputs that cannot be read are `null`.
#[must_use]
pub fn build(inputs: &Inputs<'_>) -> Record {
    let env = |name: &str| (inputs.env)(name);
    let read = |path: &str| std::fs::read(inputs.root.join(path)).ok();
    let manifest = read(&format!("dist/{}/manifest.json", inputs.platform));
    let versions: Value = read("versions.json")
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let image = |name: &str| versions["images"][name].as_str().and_then(token);
    let kind = &versions["platforms"][inputs.platform]["kind"];
    let (sandbox_url, sandbox_sha256) = inputs.agent_sandbox;
    let run = inputs
        .junit
        .and_then(|junit| timing::Run::parse(junit).ok());
    let live_kind = inputs.suite == Step::LiveKind;
    Record {
        schema_version: SCHEMA_VERSION,
        suite: inputs.suite.name(),
        platform: inputs.platform.to_owned(),
        revision: Revision {
            commit: env("GITHUB_SHA").as_deref().and_then(commit).or_else(|| {
                (inputs.git)(&["rev-parse", "HEAD"])
                    .as_deref()
                    .and_then(commit)
            }),
            dirty: (inputs.git)(&["status", "--porcelain"]).map(|status| !status.trim().is_empty()),
            run_id: env("GITHUB_RUN_ID").and_then(|id| id.trim().parse().ok()),
            run_attempt: env("GITHUB_RUN_ATTEMPT").and_then(|attempt| attempt.trim().parse().ok()),
        },
        bundle: Bundle {
            version: manifest
                .as_deref()
                .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
                .and_then(|manifest| manifest["Version"].as_str().and_then(token)),
            manifest_sha256: manifest.map(|bytes| crate::hex(&Sha256::digest(bytes))),
        },
        pins: Pins {
            gateway: image("gateway"),
            supervisor: image("supervisor"),
            sandbox_runtime: image("sandboxRuntime"),
            gateway_chart: image("gatewayChart"),
            openshell_revision: versions["openshellRevision"].as_str().and_then(commit),
            fabric_revision: read("image/fabric/Dockerfile").and_then(|dockerfile| {
                String::from_utf8_lossy(&dockerfile)
                    .lines()
                    .find_map(|line| line.strip_prefix("ARG FABRIC_REVISION="))
                    .and_then(commit)
            }),
            kind: live_kind.then(|| KindPins {
                kind: artifact(kind["url"].as_str(), kind["sha256"].as_str()),
                kind_node: image("kindNode"),
                agent_sandbox: artifact(Some(sandbox_url), Some(sandbox_sha256)),
            }),
        },
        agent: Agent {
            image_digest: inputs
                .agent_image
                .and_then(|reference| reference.rsplit_once("@sha256:"))
                .and_then(|(_, digest)| hex(digest, &[64]))
                .map(|digest| format!("sha256:{digest}")),
            harness: token(inputs.harness),
        },
        runner: ["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion"]
            .map(|name| (name, env(name).as_deref().and_then(token)))
            .into(),
        outcome: outcome(inputs.passed),
        wall_seconds: run.as_ref().map(|run| milliseconds(run.wall_seconds)),
        tests: run
            .iter()
            .flat_map(|run| &run.tests)
            .map(|test| Test {
                binary: token(&test.binary),
                name: token(&test.name),
                outcome: outcome(!test.failed),
                seconds: milliseconds(test.seconds),
            })
            .collect(),
        limitations: if live_kind {
            &[
                "pi-substitutes-for-openclaw",
                "no-inference-request",
                "openshift-profile-not-enforced",
            ]
        } else {
            &["pi-substitutes-for-openclaw", "no-inference-request"]
        },
    }
}
