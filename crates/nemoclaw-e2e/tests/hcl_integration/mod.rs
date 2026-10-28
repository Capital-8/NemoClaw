// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runs each case in `hcl/integration/cases` under `tofu test`: compiles its
//! `nemoclaw.yaml` with the SDK against the fixtures, runs the bundle's
//! OpenTofu beside the case's HCL, and checks what teardown leaves, which no
//! run block observes. Cases configure fixtures and assert results in HCL.

mod fixtures;

use fixtures::Fixtures;
use nemoclaw_sdk::{compile, config::Document};
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/hcl/integration");
const GENERATIONS: [&str; 7] = [
    "workspace",
    "provider",
    "sandbox",
    "managed_gateway",
    "inference_service",
    "ollama",
    "ollama_service",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn every_case_passes_under_tofu_test() {
    let bundle = Bundle::from_env();
    let mut cases: Vec<_> = fs::read_dir(Path::new(ROOT).join("cases"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    cases.sort();
    let mut failed = Vec::new();
    for case in cases {
        let name = case.file_name().unwrap().to_string_lossy().into_owned();
        // A panicking case fails alone; its fixtures stop and its evidence stays.
        let passed = tokio::spawn(run_case(bundle.clone(), case)).await.is_ok();
        println!("case {name}: {}", if passed { "passed" } else { "failed" });
        if !passed {
            failed.push(name);
        }
    }
    assert!(failed.is_empty(), "failed cases: {failed:?}");
}

async fn run_case(bundle: Bundle, case: std::path::PathBuf) {
    let name = case.file_name().unwrap().to_string_lossy().into_owned();
    let mut document =
        Document::parse(fs::read(case.join("nemoclaw.yaml")).unwrap().as_slice()).unwrap();
    let image_metadata: Vec<String> = document
        .spec
        .sandboxes
        .values()
        .filter_map(|sandbox| Some(sandbox.image.metadata.as_ref()?.env.clone()))
        .collect();
    let credentials: BTreeMap<String, String> = document
        .credential_names()
        .into_iter()
        .filter(|name| !image_metadata.iter().any(|metadata| metadata == name))
        .map(|name| {
            (
                name.to_owned(),
                format!("fixture-credential-{}", name.to_lowercase()),
            )
        })
        .collect();
    let fixtures = Fixtures::start(&name, credentials.clone()).await;
    fixtures.redirect(&mut document);
    let manifest: Value =
        serde_json::from_slice(&fs::read(bundle.root().join("manifest.json")).unwrap()).unwrap();
    let generations: compile::Generations =
        GENERATIONS.map(|kind| (kind.into(), "a".repeat(32))).into();
    let mut graph = compile::compile(
        &document,
        &generations,
        manifest["Version"].as_str().unwrap(),
    )
    .unwrap();
    for_tofu_test(&mut graph);

    // The work directory keeps the case beside the shared HCL it sources.
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path();
    let run_directory = work.join("cases").join(&name);
    copy(&Path::new(ROOT).join("shared"), &work.join("shared"));
    copy(&case, &run_directory);
    fs::write(run_directory.join("nemoclaw.tf.json"), graph.to_string()).unwrap();
    let mirror = work
        .join("fixture-provider/registry.opentofu.org/nvidia/fixture/1.0.0")
        .join(bundle.root().file_name().unwrap());
    fs::create_dir_all(&mirror).unwrap();
    std::os::unix::fs::symlink(
        nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
        mirror.join("terraform-provider-fixture"),
    )
    .unwrap();
    fs::write(work.join("providers.tfrc"), format!(
        "provider_installation {{\n  filesystem_mirror {{\n    path = {:?}\n    include = [\"registry.opentofu.org/nvidia/fixture\"]\n  }}\n  filesystem_mirror {{\n    path = {:?}\n  }}\n}}\n",
        work.join("fixture-provider"), bundle.root().join("providers"),
    )).unwrap();
    let mut environment = credentials.clone();
    environment.extend([
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ("HOME".into(), work.display().to_string()),
        (
            "TF_CLI_CONFIG_FILE".into(),
            work.join("providers.tfrc").display().to_string(),
        ),
        ("TF_IN_AUTOMATION".into(), "1".into()),
        ("CHECKPOINT_DISABLE".into(), "1".into()),
        ("NEMOCLAW_FIXTURE_CONTROL".into(), fixtures.control.clone()),
        (
            nemoclaw_backend::DIAGNOSTICS_ENV.into(),
            work.join("diagnostics").display().to_string(),
        ),
    ]);
    // Without an engine to inspect, image metadata names the fixture image's bundle.
    let (_, bundle_path) = nemoclaw_e2e::image_runtime::metadata_bundle(work);
    for variable in image_metadata {
        environment.insert(variable, bundle_path.display().to_string());
    }

    let mut output = String::new();
    for args in [["init", "-input=false"], ["test", "-no-color"]] {
        let mut command = tokio::process::Command::new(bundle.tofu());
        command
            .args(args)
            .current_dir(&run_directory)
            .env_clear()
            .envs(&environment)
            .kill_on_drop(true);
        let result = tokio::time::timeout(Duration::from_secs(120), command.output()).await;
        let result = result.expect("tofu exceeded 120 s").unwrap();
        output = format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        if !result.status.success() || !passed(&output) && args[0] == "test" {
            keep_evidence(directory, &fixtures, &output);
            panic!("{name}: tofu {} failed", args[0]);
        }
    }
    // OpenTofu's teardown may only fail on storage that NemoClaw retains.
    let refused = output
        .lines()
        .filter(|line| line.starts_with("Error: "))
        .all(|line| line == "Error: Destroy incomplete");
    let leaked = credentials.values().any(|value| {
        output.contains(value)
            || walk(&work.join("diagnostics"))
                .iter()
                .any(|file| fs::read_to_string(file).unwrap_or_default().contains(value))
    });
    if !refused || leaked {
        keep_evidence(directory, &fixtures, &output);
        panic!("{name}: teardown failed outside retained storage, or a credential leaked");
    }
    fixtures.assert_torn_down();
}

/// `tofu test` removes what it applied. Deletion follows `var.permit_destroy`,
/// which a case's last run sets as the SDK's teardown graph does, and the
/// fixture provider is declared beside the SDK's providers.
fn for_tofu_test(graph: &mut Value) {
    for resource in graph["resource"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .flat_map(|resources| resources.as_object_mut().unwrap().values_mut())
    {
        if let Some(lifecycle) = resource.get_mut("lifecycle").and_then(Value::as_object_mut) {
            lifecycle.remove("prevent_destroy");
        }
    }
    for provider in ["openshell", "fabric"] {
        let configuration = &mut graph["provider"][provider];
        if configuration.is_array() {
            configuration[0]["destroy"] = json!("${var.permit_destroy}");
        } else {
            configuration["destroy"] = json!("${var.permit_destroy}");
        }
    }
    graph["variable"]["permit_destroy"] = json!({"type": "bool", "default": false});
    graph["terraform"]["required_providers"]["fixture"] =
        json!({"source": "registry.opentofu.org/nvidia/fixture", "version": "= 1.0.0"});
}

/// Every run passed, and there was at least one.
fn passed(output: &str) -> bool {
    output
        .split("Success! ")
        .nth(1)
        .and_then(|summary| summary.split(" passed, 0 failed.").next())
        .and_then(|count| count.parse::<usize>().ok())
        .is_some_and(|count| count > 0)
}

/// Keep the run directory with redacted OpenTofu output and observations.
fn keep_evidence(directory: tempfile::TempDir, fixtures: &Fixtures, output: &str) {
    let directory = directory.keep();
    let evidence = [
        ("tofu.txt", output.to_owned()),
        (
            "observations.json",
            fixtures.shared.observations().to_string(),
        ),
    ];
    for (file, text) in evidence {
        fs::write(directory.join(file), fixtures.shared.redact(text)).unwrap();
    }
    eprintln!(
        "{}\nevidence retained in {}",
        fixtures.shared.redact(output.to_owned()),
        directory.display()
    );
}

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).into_iter().flatten().flatten() {
        if entry.path().is_dir() {
            copy(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}

fn walk(directory: &Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|entry| {
            if entry.path().is_dir() {
                walk(&entry.path())
            } else {
                vec![entry.path()]
            }
        })
        .collect()
}
