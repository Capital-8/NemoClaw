// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runs each scenario in `hcl/integration/tests` under `tofu test`. A scenario
//! is `hcl/cases/<scenario>.yaml`, shared with the live E2E suites, and
//! `hcl/integration/tests/<scenario>.tftest.hcl`. The runner compiles the YAML
//! with the SDK against the fixtures into `cases/<scenario>` of a work copy of
//! the integration root, beside a copy of `harness/main.tf`, then runs each test file with
//! fixtures reset and checks what teardown leaves, which no run block sees.

mod fixtures;

use fixtures::Fixtures;
use nemoclaw_sdk::{compile, config::Document};
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const HCL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/hcl");
const GENERATIONS: [&str; 7] = [
    "workspace",
    "provider",
    "sandbox",
    "managed_gateway",
    "inference_service",
    "ollama",
    "ollama_service",
];

struct Scenario {
    name: String,
    environment: BTreeMap<String, String>,
    credentials: BTreeMap<String, String>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn every_scenario_passes_under_tofu_test() {
    let bundle = Bundle::from_env();
    let root = Path::new(HCL).join("integration");
    let mut tests: Vec<String> = fs::read_dir(root.join("tests"))
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            name.strip_suffix(".tftest.hcl").map(str::to_owned)
        })
        .collect();
    tests.sort();
    assert!(!tests.is_empty(), "no integration scenarios");

    let fixtures = Fixtures::start().await;
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("integration");
    copy(&root, &work);
    let manifest: Value =
        serde_json::from_slice(&fs::read(bundle.root().join("manifest.json")).unwrap()).unwrap();
    let version = manifest["Version"].as_str().unwrap();
    let generations: compile::Generations =
        GENERATIONS.map(|kind| (kind.into(), "a".repeat(32))).into();
    // Without an engine to inspect, image metadata names the fixture image's bundle.
    let (fixture_image, metadata) = nemoclaw_e2e::image_runtime::metadata_bundle(directory.path());
    let scenarios: Vec<Scenario> = tests
        .into_iter()
        .map(|name| {
            let yaml = Path::new(HCL).join("cases").join(format!("{name}.yaml"));
            let source =
                fs::read(&yaml).unwrap_or_else(|_| panic!("{} is missing", yaml.display()));
            let mut document = Document::parse(source.as_slice()).unwrap();
            // A sandbox described by image metadata runs the fixture image.
            let mut image_metadata = Vec::new();
            for sandbox in document.spec.sandboxes.values_mut() {
                if let Some(variable) = &sandbox.image.metadata {
                    image_metadata.push(variable.env.clone());
                    sandbox.image.ref_.clone_from(&fixture_image);
                }
            }
            let credentials: BTreeMap<String, String> = document
                .credential_names()
                .into_iter()
                .filter(|credential| !image_metadata.iter().any(|variable| variable == credential))
                .map(|credential| {
                    (
                        credential.to_owned(),
                        format!("fixture-credential-{}", credential.to_lowercase()),
                    )
                })
                .collect();
            fixtures.redirect(&mut document);
            let mut graph = compile::compile(&document, &generations, version).unwrap();
            for_tofu_test(&mut graph);
            let case = work.join("cases").join(&name);
            fs::create_dir_all(&case).unwrap();
            fs::write(case.join("nemoclaw.tf.json"), graph.to_string()).unwrap();
            fs::write(case.join("nemoclaw.yaml"), &source).unwrap();
            fs::copy(root.join("harness/main.tf"), case.join("harness.tf")).unwrap();
            let mut environment = credentials.clone();
            for variable in image_metadata {
                environment.insert(variable, metadata.display().to_string());
            }
            Scenario {
                name,
                environment,
                credentials,
            }
        })
        .collect();

    let mirror = directory.path().join("fixture-provider");
    let platform = mirror
        .join("registry.opentofu.org/nvidia/fixture/1.0.0")
        .join(bundle.root().file_name().unwrap());
    fs::create_dir_all(&platform).unwrap();
    std::os::unix::fs::symlink(
        nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
        platform.join("terraform-provider-fixture"),
    )
    .unwrap();
    let configuration = directory.path().join("providers.tfrc");
    fs::write(
        &configuration,
        format!(
            "provider_installation {{\n  filesystem_mirror {{\n    path = {mirror:?}\n    include = [\"registry.opentofu.org/nvidia/fixture\"]\n  }}\n  filesystem_mirror {{\n    path = {:?}\n  }}\n}}\n",
            bundle.root().join("providers"),
        ),
    )
    .unwrap();
    let diagnostics = directory.path().join("diagnostics");
    let mut base: BTreeMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", directory.path().display().to_string()),
        ("TF_CLI_CONFIG_FILE", configuration.display().to_string()),
        ("TF_IN_AUTOMATION", "1".into()),
        ("CHECKPOINT_DISABLE", "1".into()),
        ("NEMOCLAW_FIXTURE_CONTROL", fixtures.control.clone()),
        (
            nemoclaw_backend::DIAGNOSTICS_ENV,
            diagnostics.display().to_string(),
        ),
    ]
    .map(|(name, value)| (name.to_owned(), value))
    .into();
    // Coverage-instrumented providers write their profiles where the caller asks.
    if let Ok(profile) = std::env::var("LLVM_PROFILE_FILE") {
        base.insert("LLVM_PROFILE_FILE".into(), profile);
    }
    let (initialized, output) =
        tofu(&bundle, &work, &base, ["init", "-input=false", "-no-color"]).await;
    assert!(initialized, "tofu init failed:\n{output}");

    let mut failed = Vec::new();
    for scenario in &scenarios {
        fixtures.reset(scenario.credentials.clone());
        let mut environment = base.clone();
        environment.extend(scenario.environment.clone());
        let filter = format!("-filter=tests/{}.tftest.hcl", scenario.name);
        let (_, output) = tofu(&bundle, &work, &environment, ["test", "-no-color", &filter]).await;
        let problem = check(&output, &scenario.credentials, &diagnostics)
            .or_else(|| fixtures.teardown_problem());
        println!(
            "scenario {}: {}",
            scenario.name,
            if problem.is_none() {
                "passed"
            } else {
                "failed"
            }
        );
        if let Some(problem) = problem {
            let evidence = directory.path().join("evidence").join(&scenario.name);
            fs::create_dir_all(&evidence).unwrap();
            let observations = fixtures.shared.observations().to_string();
            for (file, text) in [("tofu.txt", output), ("observations.json", observations)] {
                fs::write(evidence.join(file), fixtures.shared.redact(text)).unwrap();
            }
            eprintln!(
                "{}: {problem}\n{}",
                scenario.name,
                fs::read_to_string(evidence.join("tofu.txt")).unwrap()
            );
            failed.push(scenario.name.clone());
        }
    }
    if !failed.is_empty() {
        let kept = directory.keep();
        panic!(
            "failed scenarios: {failed:?}; evidence retained in {}",
            kept.join("evidence").display()
        );
    }
}

/// Run the bundle's OpenTofu in `directory` with only `environment`.
async fn tofu<const N: usize>(
    bundle: &Bundle,
    directory: &Path,
    environment: &BTreeMap<String, String>,
    args: [&str; N],
) -> (bool, String) {
    let mut command = tokio::process::Command::new(bundle.tofu());
    command
        .args(args)
        .current_dir(directory)
        .env_clear()
        .envs(environment)
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .expect("tofu exceeded 120 s")
        .unwrap();
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    (result.status.success(), output)
}

/// What failed in a scenario's `tofu test` output: a run, teardown outside
/// storage NemoClaw retains, or a fixture credential in output or diagnostics.
fn check(
    output: &str,
    credentials: &BTreeMap<String, String>,
    diagnostics: &Path,
) -> Option<String> {
    // Every run passed, and there was at least one.
    let passed = output
        .split("Success! ")
        .nth(1)
        .and_then(|summary| summary.split(" passed, 0 failed.").next())
        .and_then(|count| count.parse::<usize>().ok())
        .is_some_and(|count| count > 0);
    if !passed {
        return Some("a run failed".into());
    }
    // OpenTofu's teardown may only fail on storage that NemoClaw retains.
    if !output
        .lines()
        .filter(|line| line.starts_with("Error: "))
        .all(|line| line == "Error: Destroy incomplete")
    {
        return Some("teardown failed outside retained storage".into());
    }
    let files = walk(diagnostics);
    credentials
        .values()
        .any(|value| {
            output.contains(value)
                || files
                    .iter()
                    .any(|file| fs::read_to_string(file).unwrap_or_default().contains(value))
        })
        .then(|| "a fixture credential leaked".into())
}

/// `tofu test` removes what it applied. Deletion follows the harness's
/// `var.permit_destroy`, which a scenario's last run sets as the SDK's teardown
/// graph does, and the fixture provider is declared beside the SDK's providers.
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
    graph["terraform"]["required_providers"]["fixture"] =
        json!({"source": "registry.opentofu.org/nvidia/fixture", "version": "= 1.0.0"});
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

fn walk(directory: &Path) -> Vec<PathBuf> {
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
