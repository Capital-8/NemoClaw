// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(unix)]
#[tokio::test]
async fn successful_verification_and_cleanup_produce_a_successful_case() {
    let root = tempfile::tempdir().unwrap();
    let tools = tools(root.path(), true, true, true);
    let run = root.path().join("run");
    execute_with_tools(
        &case_path(),
        root.path(),
        &run,
        &tools,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let result: Value =
        serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["succeeded"], true);
    assert_eq!(result["cleanup"]["succeeded"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn leftover_docker_workloads_fail_an_otherwise_successful_case() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = tools(root.path(), true, true, true);
    tools.docker = script(
        root.path(),
        "leftover-docker",
        "printf '%s\\n' owned-container",
    );
    let run = root.path().join("run");
    assert!(
        execute_with_tools(
            &case_path(),
            root.path(),
            &run,
            &tools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let result: Value =
        serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["succeeded"], false);
    assert_eq!(result["failed_phase"], Value::Null);
    assert_eq!(result["cleanup"]["succeeded"], false);
    assert_eq!(
        result["cleanup"]["failure"],
        "Docker still holds test-owned workloads"
    );
}

fn case_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("hcl/cases/docker-openclaw-nvidia.yaml")
}

#[test]
fn the_case_allocates_a_new_deployment_identity_for_each_run() {
    let case = Case::read(&case_path()).unwrap();
    let first = case.owned_document().unwrap();
    let second = case.owned_document().unwrap();
    assert_ne!(first.metadata.uid, second.metadata.uid);
    assert_ne!(first.workspace(), second.workspace());
    assert_ne!(first.metadata.uid, case.document().unwrap().metadata.uid);
}

#[test]
fn unsupported_combinations_are_rejected_before_execution() {
    for (pointer, value) in [
        ("/spec/gateway/runtime/provider", "podman"),
        (
            "/spec/sandboxes/assistant/harness/kind",
            "nvidia.fabric.hermes",
        ),
        (
            "/spec/inferenceProviders/nvidia/endpoint",
            "https://example.com/v1",
        ),
    ] {
        let mut case = Case::read(&case_path()).unwrap();
        *case.deployment.pointer_mut(pointer).unwrap() = json!(value);
        assert!(case.document().is_err(), "{pointer}");
    }
}

#[cfg(unix)]
fn script(root: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(name);
    fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[cfg(unix)]
fn tools(root: &Path, apply: bool, verify: bool, destroy: bool) -> Tools {
    let cli = script(
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
  plan) printf '%s' product-sentinel > "$state/sentinel" ;;
  apply)
    printf '%s' '{"resources":[]}' > "$state/terraform.tfstate"
    if [ "$HANG_APPLY" = 1 ]; then while :; do sleep 1; done; fi
    exit "$APPLY_EXIT" ;;
  destroy)
    printf '%s' '{"outcome":"destroyed","changes":[],"retained":[]}'
    exit "$DESTROY_EXIT" ;;
esac
"#,
    );
    let tofu = script(
        root,
        "tofu",
        r#"
printf 'tofu-%s\n' "$1" >> "$TRACE"
if [ "$1" = test ]; then
  printf '%s' verifier-sentinel > terraform.tfstate
  exit "$VERIFY_EXIT"
fi
"#,
    );
    Tools {
        cli,
        tofu,
        docker: script(root, "docker", "exit 0"),
        environment: BTreeMap::from([
            ("TRACE".into(), root.join("trace").into_os_string()),
            ("APPLY_EXIT".into(), if apply { "0" } else { "1" }.into()),
            ("VERIFY_EXIT".into(), if verify { "0" } else { "1" }.into()),
            (
                "DESTROY_EXIT".into(),
                if destroy { "0" } else { "1" }.into(),
            ),
            ("HANG_APPLY".into(), "0".into()),
        ]),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn failed_hcl_verification_preserves_evidence_and_destroys_only_the_deployment() {
    let root = tempfile::tempdir().unwrap();
    let tools = tools(root.path(), true, false, true);
    let run = root.path().join("run");
    assert!(
        execute_with_tools(
            &case_path(),
            root.path(),
            &run,
            &tools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(root.path().join("trace"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["plan", "apply", "tofu-init", "tofu-test", "destroy"]
    );
    let result: Value =
        serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["failed_phase"], "tofu-test");
    assert_eq!(result["cleanup"]["succeeded"], true);
    assert_eq!(
        fs::read_to_string(run.join("deployment/sentinel")).unwrap(),
        "product-sentinel"
    );
    assert_eq!(
        fs::read_to_string(run.join("verifier/terraform.tfstate")).unwrap(),
        "verifier-sentinel"
    );
    assert!(run.join("verifier/tofu-test.stderr").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn partial_apply_failure_still_destroys_and_keeps_the_original_failure() {
    for cleanup_ok in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let tools = tools(root.path(), false, true, cleanup_ok);
        let run = root.path().join("run");
        assert!(
            execute_with_tools(
                &case_path(),
                root.path(),
                &run,
                &tools,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(root.path().join("trace"))
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["plan", "apply", "destroy"]
        );
        let result: Value =
            serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
        assert_eq!(result["failed_phase"], "apply");
        assert_eq!(result["cleanup"]["succeeded"], cleanup_ok);
        assert_eq!(result["succeeded"], false);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn an_existing_run_directory_is_preserved_without_running_commands() {
    let root = tempfile::tempdir().unwrap();
    let tools = tools(root.path(), true, true, true);
    let run = root.path().join("run");
    fs::create_dir(&run).unwrap();
    fs::write(run.join("owned"), "preserve").unwrap();
    assert!(
        execute_with_tools(
            &case_path(),
            root.path(),
            &run,
            &tools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(!root.path().join("trace").exists());
    assert_eq!(fs::read_to_string(run.join("owned")).unwrap(), "preserve");
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_during_apply_stops_the_process_before_fresh_token_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = tools(root.path(), true, true, true);
    tools.environment.insert("HANG_APPLY".into(), "1".into());
    let run = root.path().join("run");
    let cancel = CancellationToken::new();
    let case = case_path();
    let operation = execute_with_tools(&case, root.path(), &run, &tools, &cancel);
    let interrupt = async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if fs::read_to_string(root.path().join("trace"))
                    .is_ok_and(|s| s.lines().any(|l| l == "apply"))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(operation, interrupt);
    assert!(result.is_err());
    let result: Value =
        serde_json::from_slice(&fs::read(run.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["failed_phase"], "apply");
    assert_eq!(result["cleanup"]["succeeded"], true);
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires pinned OpenTofu via NEMOCLAW_TEST_BUNDLE or NEMOCLAW_HCL_TOFU; uses fixture reports, no Docker or inference"]
async fn shared_hcl_assertions_keep_verifier_state_separate_and_reject_failed_observations() {
    let tofu = std::env::var_os("NEMOCLAW_HCL_TOFU")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Bundle::open(Path::new(
                &std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("NEMOCLAW_TEST_BUNDLE"),
            ))
            .unwrap()
            .tofu()
        });
    let root = tempfile::tempdir().unwrap();
    let product_state = root.path().join("terraform.tfstate");
    fs::write(&product_state, "owned-product-state").unwrap();
    let probe = script(
        root.path(),
        "probe",
        "cp \"$FIXTURE_REPORT\" \"$NEMOCLAW_HCL_REPORT\"",
    );
    for (defect, value) in [
        (None, Value::Null),
        (Some("/health/gateway_ready"), json!(false)),
        (Some("/health/agent_name"), json!("another-agent")),
        (Some("/health/identity_matches"), json!(false)),
        (Some("/health/sandbox_ready"), json!(false)),
        (Some("/health/policy_loaded"), json!(false)),
        (Some("/response/attempted"), json!(false)),
        (Some("/response/succeeded"), json!(false)),
        (Some("/response/agent_name"), json!("another-agent")),
        (Some("/response/runtime_id"), json!("another-runtime")),
        (Some("/response/has_response_text"), json!(false)),
    ] {
        let directory = root
            .path()
            .join(defect.unwrap_or("healthy").replace('/', "-"));
        verifier(&directory).unwrap();
        let mut report = json!({
            "expected": {"agent_name":"assistant","runtime_id":"runtime"},
            "health": {
                "gateway_ready":true,"sandbox_ready":true,"identity_matches":true,
                "agent_name":"assistant","policy_loaded":true
            },
            "response": {
                "attempted":true,"succeeded":true,"agent_name":"assistant",
                "runtime_id":"runtime","has_response_text":true
            }
        });
        if let Some(field) = defect {
            *report.pointer_mut(field).unwrap() = value;
        }
        let fixture = directory.join("fixture.json");
        fs::write(&fixture, report.to_string()).unwrap();
        let environment = BTreeMap::from([
            ("NEMOCLAW_HCL_E2E".into(), probe.as_os_str().to_owned()),
            ("FIXTURE_REPORT".into(), fixture.into_os_string()),
            (
                "TF_CLI_CONFIG_FILE".into(),
                directory.join("cli.tfrc").into_os_string(),
            ),
        ]);
        let cancel = CancellationToken::new();
        process::execute(
            &tofu,
            &strings(&["init", "-backend=false", "-input=false", "-no-color"]),
            &directory,
            "tofu-init",
            &environment,
            &cancel,
        )
        .await
        .unwrap();
        let result = process::execute(
            &tofu,
            &strings(&["test", "-json", "-no-color"]),
            &directory,
            "tofu-test",
            &environment,
            &cancel,
        )
        .await;
        assert_eq!(
            result.is_ok(),
            defect.is_none(),
            "{defect:?}: {}",
            fs::read_to_string(directory.join("tofu-test.stdout")).unwrap()
        );
        assert_eq!(
            fs::read_to_string(&product_state).unwrap(),
            "owned-product-state"
        );
        assert_eq!(fs::read_dir(directory.join("reports")).unwrap().count(), 1);
    }
}
