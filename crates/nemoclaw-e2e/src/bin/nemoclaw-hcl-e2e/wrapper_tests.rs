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
        "verifier/main.tf",
        "suites/docker-openclaw-nvidia/main.tf",
        "suites/docker-openclaw-nvidia/integration.tftest.hcl",
    ] {
        let destination = root.join(name);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(source.join(name), destination).unwrap();
    }
    root.join("suites/docker-openclaw-nvidia")
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
  apply) printf '%s' '{"resources":[]}' > "$state/terraform.tfstate" ;;
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
printf '{"target":"%s","expected":{"agent_name":"%s","runtime_id":"runtime"},"health":{"gateway_ready":%s,"identity_matches":true,"sandbox_ready":true,"agent_name":"%s","policy_loaded":true},"response":{"attempted":true,"succeeded":true,"agent_name":"%s","runtime_id":"runtime","output_valid":true}}' \
 "$NEMOCLAW_HCL_TARGET" "$NEMOCLAW_HCL_AGENT" "$ready" "$NEMOCLAW_HCL_AGENT" "$NEMOCLAW_HCL_AGENT" > "$NEMOCLAW_HCL_REPORT"
"#,
        ),
        environment: BTreeMap::from([
            ("TRACE".into(), root.join("trace").into_os_string()),
            ("FAIL_PHASE".into(), "".into()),
            ("FAIL_CLEANUP".into(), "0".into()),
            ("UNHEALTHY_TARGET".into(), "".into()),
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
async fn shared_hcl_assertions_load_targets_from_disk_and_reject_unhealthy_observations() {
    let root = tempfile::tempdir().unwrap();
    let suite = suite(root.path());
    let mut tools = tools(root.path());
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    tools.tofu = std::env::var_os("NEMOCLAW_HCL_TOFU")
        .map(PathBuf::from)
        .unwrap_or_else(|| Bundle::open(&bundle).unwrap().tofu());
    let healthy = root.path().join("healthy");
    execute_with_tools(
        &deployment(),
        &suite,
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
        ["assistant", "researcher"]
    );
    assert_eq!(
        fs::read_to_string(root.path().join("trace")).unwrap(),
        "plan\napply\ndestroy\n"
    );

    // Change only on-disk HCL inputs, using Terraform's JSON override syntax.
    fs::write(suite.join("override.tf.json"), json!({"variable":{"targets":{"default":{
        "assistant":{"agent":"assistant","request":"changed question","response_contract":"openclaw"},
        "researcher":{"agent":"researcher","request":"another question","response_contract":"openclaw"},
        "followup":{"agent":"assistant","request":"a new question from disk","response_contract":"openclaw"}
    }}}}).to_string()).unwrap();
    tools
        .environment
        .insert("UNHEALTHY_TARGET".into(), "researcher".into());
    let unhealthy = root.path().join("unhealthy");
    assert!(
        execute_with_tools(
            &deployment(),
            &suite,
            &bundle,
            &unhealthy,
            &tools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let second = reports(&unhealthy);
    assert_eq!(
        second.keys().map(String::as_str).collect::<Vec<_>>(),
        ["assistant", "followup", "researcher"]
    );
    let followup = &second["followup"].0;
    let request: Value =
        serde_json::from_slice(&fs::read(followup.with_extension("request.json")).unwrap())
            .unwrap();
    assert_eq!(request, "a new question from disk");
    assert_eq!(second["researcher"].1["health"]["gateway_ready"], false);
    assert!(
        fs::read_to_string(unhealthy.join("verifier/tofu-test.stdout"))
            .unwrap()
            .contains("gateway: researcher")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("trace")).unwrap(),
        "plan\napply\ndestroy\nplan\napply\ndestroy\n"
    );
    for run in [&healthy, &unhealthy] {
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
    for phase in ["apply", "tofu-test"] {
        let root = tempfile::tempdir().unwrap();
        let mut tools = tools(root.path());
        tools.environment.insert("FAIL_PHASE".into(), phase.into());
        tools.environment.insert("FAIL_CLEANUP".into(), "1".into());
        let run = root.path().join("run");
        assert!(
            execute_with_tools(
                &deployment(),
                root.path(),
                root.path(),
                &run,
                &tools,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        let trace = fs::read_to_string(root.path().join("trace")).unwrap();
        assert!(trace.ends_with("destroy\n"));
        assert_eq!(trace.lines().filter(|line| *line == "apply").count(), 1);
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
