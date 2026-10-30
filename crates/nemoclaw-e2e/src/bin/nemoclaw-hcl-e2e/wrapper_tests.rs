// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::Value;

fn deployment() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("hcl/cases/docker-openclaw-nvidia.yaml")
}

fn suite(root: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("hcl");
    for name in [
        "main.tf",
        "verifier/main.tf",
        "components/vllm/main.tf",
        "tests/docker-openclaw-nvidia.tftest.hcl",
        "tests/docker-openclaw-vllm.tftest.hcl",
    ] {
        let destination = root.join(name);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(source.join(name), destination).unwrap();
    }
    root.to_owned()
}

fn script(root: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(name);
    fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn tools(root: &Path) -> Tools {
    Tools {
        candidate_revision: "a".repeat(40),
        cli: script(
            root,
            "nemoclaw",
            r#"
operation="$1"
printf '%s\n' "$operation" >> "$TRACE"
shift
while [ "$#" -gt 0 ]; do
  if [ "$1" = --state-dir ]; then state="$2"; break; fi
  shift
done
case "$operation" in
  plan) printf '%s' product-state > "$state/sentinel" ;;
  apply)
    changes='[]'
    if [ -f "$state/terraform.tfstate" ] && [ "$FAIL_PHASE" = reapply ]; then
      changes='[{"resource":"openshell_sandbox.assistant","actions":["update"]}]'
    fi
    printf '{"outcome":"succeeded","changes":%s}' "$changes"
    printf '%s' '{"resources":[]}' > "$state/terraform.tfstate" ;;
  destroy)
    if [ "$FAIL_CLEANUP" = 1 ]; then exit 1; fi
    printf '%s' '{"outcome":"destroyed","changes":[],"retained":["openshell_gateway_storage.runtime"]}' ;;
esac
[ "$FAIL_PHASE" != "$operation" ]
"#,
        ),
        tofu: script(
            root,
            "tofu",
            r#"
shift
printf 'tofu-%s\n' "$1" >> "$TRACE"
if [ "$1" = test ] && [ "$FAIL_PHASE" = tofu-test ]; then exit 1; fi
"#,
        ),
        probe: script(
            root,
            "probe",
            r#"
ready=true
if [ "$NEMOCLAW_HCL_TARGET" = "$UNHEALTHY_TARGET" ]; then ready=false; fi
valid=true
if [ "$NEMOCLAW_HCL_TARGET" = "$INVALID_RESPONSE_TARGET" ]; then valid=false; fi
printf '{"target":"%s","expected":{"agent_name":"%s","runtime_id":"runtime"},"health":{"gateway_ready":%s,"identity_matches":true,"sandbox_ready":true,"agent_name":"%s","policy_loaded":true},"response":{"attempted":true,"succeeded":%s,"agent_name":"%s","runtime_id":"runtime","output_valid":%s}}' \
 "$NEMOCLAW_HCL_TARGET" "$NEMOCLAW_HCL_AGENT" "$ready" "$NEMOCLAW_HCL_AGENT" "$valid" "$NEMOCLAW_HCL_AGENT" "$valid" > "$NEMOCLAW_HCL_REPORT"
"#,
        ),
        environment: BTreeMap::from([
            ("TRACE".into(), root.join("trace").into_os_string()),
            ("FAIL_PHASE".into(), "".into()),
            ("FAIL_CLEANUP".into(), "0".into()),
            ("UNHEALTHY_TARGET".into(), "".into()),
            ("INVALID_RESPONSE_TARGET".into(), "".into()),
        ]),
    }
}

fn reports(run: &Path) -> BTreeMap<String, (PathBuf, Value)> {
    fs::read_dir(run.join("verifier/reports"))
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            if path.to_string_lossy().ends_with(".request.json") {
                return None;
            }
            let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            Some((value["target"].as_str().unwrap().into(), (path, value)))
        })
        .collect()
}

#[tokio::test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; NEMOCLAW_HCL_TOFU may override OpenTofu; fixture observations, no Docker or inference"]
async fn shared_hcl_assertions_load_scenarios_from_disk_and_only_fail_on_outcome() {
    let root = tempfile::tempdir().unwrap();
    let suite = suite(root.path());
    let mut tools = tools(root.path());
    let bundle = Bundle::open(Path::new(
        &std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap(),
    ))
    .unwrap();
    tools.tofu = std::env::var_os("NEMOCLAW_HCL_TOFU")
        .map(PathBuf::from)
        .unwrap_or_else(|| bundle.tofu());
    let healthy = root.path().join("healthy");
    let filter = Path::new("tests/docker-openclaw-nvidia.tftest.hcl");
    execute_with_tools(
        &deployment(),
        &suite,
        filter,
        &bundle,
        &healthy,
        &tools,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let first = reports(&healthy);
    assert_eq!(
        first.keys().map(String::as_str).collect::<Vec<_>>(),
        ["assistant"]
    );
    assert_eq!(
        fs::read_to_string(root.path().join("trace")).unwrap(),
        "plan\napply\napply\ndestroy\n"
    );

    // Add a selectable scenario on disk without recompiling the helper.
    let scenario = fs::read_to_string(suite.join(filter))
        .unwrap()
        .replace("run \"openclaw_hosted\"", "run \"followup\"")
        .replace("source = \"./verifier\"", "source = \"./components/vllm\"")
        // No model service is needed for these fixture observations.
        .replace("  variables {", "  variables {\n    vllm_services = []")
        .replacen("assistant", "followup", 1)
        // Multi-target coverage belongs to this fixture, independently of live cases.
        .replacen(
            "    targets = {",
            r#"    targets = {
      researcher = {
        agent             = "researcher"
        request           = "a second fixture question"
        response_contract = "openclaw"
      }"#,
            1,
        )
        .replace(
            "Reply with one short sentence confirming that you can respond.",
            "a new question from disk",
        );
    let filter = Path::new("tests/followup.tftest.hcl");
    fs::write(suite.join(filter), scenario).unwrap();
    tools
        .environment
        .insert("UNHEALTHY_TARGET".into(), "researcher".into());
    let unhealthy = root.path().join("unhealthy");
    execute_with_tools(
        &deployment(),
        &suite,
        filter,
        &bundle,
        &unhealthy,
        &tools,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let second = reports(&unhealthy);
    assert_eq!(
        second.keys().map(String::as_str).collect::<Vec<_>>(),
        ["followup", "researcher"]
    );
    let followup = &second["followup"].0;
    let request: Value =
        serde_json::from_slice(&fs::read(followup.with_extension("request.json")).unwrap())
            .unwrap();
    assert_eq!(request, "a new question from disk");
    // The fixture deliberately leaves the response valid while health is false.
    // HCL records that observation without making it a second verdict.
    assert_eq!(second["researcher"].1["health"]["gateway_ready"], false);
    tools
        .environment
        .insert("UNHEALTHY_TARGET".into(), "".into());
    tools
        .environment
        .insert("INVALID_RESPONSE_TARGET".into(), "researcher".into());
    let invalid = root.path().join("invalid");
    assert!(
        execute_with_tools(
            &deployment(),
            &suite,
            filter,
            &bundle,
            &invalid,
            &tools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(
        fs::read_to_string(invalid.join("verifier/tofu-test.stdout"))
            .unwrap()
            .contains("outcome: researcher")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("trace")).unwrap(),
        "plan\napply\napply\ndestroy\nplan\napply\napply\ndestroy\nplan\napply\ndestroy\n"
    );
    for run in [&healthy, &unhealthy, &invalid] {
        assert_eq!(
            fs::read_to_string(run.join("deployment/sentinel")).unwrap(),
            "product-state"
        );
        let result: Value =
            serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
        assert_eq!(result["cleanup"]["succeeded"], true);
        assert_eq!(
            result["cleanup"]["retained"],
            json!(["openshell_gateway_storage.runtime"])
        );
    }
    assert!(first.values().all(|(path, _)| path.exists()));
}

#[tokio::test]
async fn deployment_or_verification_failure_still_cleans_up_and_preserves_the_original_failure() {
    for phase in ["apply", "tofu-test", "reapply"] {
        let root = tempfile::tempdir().unwrap();
        let suite = suite(root.path());
        let mut tools = tools(root.path());
        tools.environment.insert("FAIL_PHASE".into(), phase.into());
        tools.environment.insert("FAIL_CLEANUP".into(), "1".into());
        let run = root.path().join("run");
        let bundle = Bundle {
            directory: root.path().into(),
            manifest: nemoclaw_sdk::bundle::Manifest {
                version: "0.1.0-dev.fixture".into(),
                rust: "fixture".into(),
                opentofu: "1.12.9".into(),
                files: BTreeMap::new(),
            },
        };
        assert!(
            execute_with_tools(
                &deployment(),
                &suite,
                Path::new("tests/docker-openclaw-nvidia.tftest.hcl"),
                &bundle,
                &run,
                &tools,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        let trace = fs::read_to_string(root.path().join("trace")).unwrap();
        assert!(trace.ends_with("destroy\n"));
        assert_eq!(
            trace.lines().filter(|line| *line == "apply").count(),
            if phase == "reapply" { 2 } else { 1 }
        );
        let result: Value =
            serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
        assert_eq!(result["failed_phase"], phase);
        assert!(result["failure"].as_str().unwrap().starts_with(phase));
        assert_eq!(result["cleanup"]["succeeded"], false);
        assert!(
            result["cleanup"]["failure"]
                .as_str()
                .unwrap()
                .starts_with("destroy")
        );
        assert!(
            run.join(format!("{phase}.stderr")).exists()
                || run.join(format!("verifier/{phase}.stderr")).exists()
        );
    }
}
