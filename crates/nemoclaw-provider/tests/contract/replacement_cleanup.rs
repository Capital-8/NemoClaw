// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A container replacement whose cleanup failed, through pinned OpenTofu and
//! the bundled Docker provider. OpenTofu and the provider own that cleanup
//! (`docs/provider.md`); the SDK reads their plans and state. The SDK's
//! `replacement_cleanup` test drives `Deployment` with canned copies of the
//! shapes this test pins, so a change here must change it too.

use super::vllm_runtime::Workspace;
use serde_json::{Value, json};
use std::{fs, path::Path};

const KEY: &str = "deadbeef";
const OLD: &str = "old-container";
const ADDRESS: &str = "docker_container.service";

fn container() -> String {
    format!(
        "resource \"docker_container\" \"service\" {{\n  name  = \"service\"\n  image = \"runtime@sha256:{}\"\n}}\n",
        "a".repeat(64)
    )
}

fn read(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
}

fn save(root: &Path, name: &str, value: &Value) {
    fs::write(root.join(name), value.to_string()).unwrap();
}

struct Scenario {
    workspace: Workspace,
    remote: tempfile::TempDir,
}

impl Scenario {
    fn new() -> Self {
        let remote = tempfile::tempdir().unwrap();
        let root = remote.path();
        // The Docker provider runs `ssh` from PATH without passing the
        // environment on, so the simulator reads its root from beside itself.
        nemoclaw_test_fixtures::ssh::install_simulator(&root.join("bin"), root);
        save(
            root,
            "fixture.json",
            &json!({"files":{}, "stats":{}, "image_refs":[], "image":{"Id":"sha256:runtime", "Config":{"Labels":{}}}}),
        );
        save(
            root,
            "engine.json",
            &json!({"effects":0, "creates":0, "network":{"Name":"bridge"}}),
        );
        save(root, "control.json", &json!({}));
        let workspace = Workspace::with("ssh://operator@gpu-box", &container());
        Self { workspace, remote }
    }

    fn root(&self) -> &Path {
        self.remote.path()
    }

    fn tofu(&self, args: &[&str], success: bool) -> Vec<u8> {
        let output = self
            .workspace
            .command()
            .args(args)
            .env(
                "PATH",
                nemoclaw_test_fixtures::path_with(&self.root().join("bin")),
            )
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn apply(&self, success: bool) {
        self.tofu(
            &["apply", "-input=false", "-auto-approve", "-no-color"],
            success,
        );
    }

    /// The saved plan's changes to the container, current and deposed.
    fn plan(&self) -> Vec<Value> {
        self.tofu(
            &["plan", "-input=false", "-no-color", "-out=cleanup.plan"],
            true,
        );
        let plan: Value =
            serde_json::from_slice(&self.tofu(&["show", "-json", "cleanup.plan"], true)).unwrap();
        plan["resource_changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|change| change["address"] == ADDRESS)
            .cloned()
            .collect()
    }

    /// The state's container objects, current and deposed.
    fn objects(&self) -> Vec<Value> {
        let state: Value = serde_json::from_slice(&self.tofu(&["show", "-json"], true)).unwrap();
        state["values"]["root_module"]["resources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|resource| resource["address"] == ADDRESS)
            .cloned()
            .collect()
    }

    /// The state a replacement leaves when it created the new container but
    /// did not finish deleting the old one, which `present` says the engine
    /// still runs. OpenTofu writes this state itself only for
    /// `create_before_destroy`, which NemoClaw's graphs never set, so this
    /// fixture writes it.
    fn interrupt_cleanup(&self, present: bool) {
        let path = self.workspace.path();
        let mut state = read(path, "terraform.tfstate");
        let resource = state["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| resource["type"] == "docker_container")
            .unwrap();
        let mut old = resource["instances"][0].clone();
        old["deposed"] = json!(KEY);
        old["attributes"]["id"] = json!(OLD);
        old["attributes"]["name"] = json!(OLD);
        resource["instances"].as_array_mut().unwrap().push(old);
        save(path, "terraform.tfstate", &state);
        let mut engine = read(self.root(), "engine.json");
        let mut old = engine["container"].clone();
        old["Id"] = json!(OLD);
        old["Name"] = json!(format!("/{OLD}"));
        engine["deposed_container"] = if present { old } else { Value::Null };
        save(self.root(), "engine.json", &engine);
    }
}

fn deposed(changes: &[Value]) -> &Value {
    let deposed: Vec<_> = changes
        .iter()
        .filter(|change| change["deposed"].is_string())
        .collect();
    assert_eq!(deposed.len(), 1, "{changes:?}");
    assert_eq!(deposed[0]["mode"], "managed");
    assert_eq!(deposed[0]["deposed"], KEY);
    deposed[0]
}

fn current(changes: &[Value]) -> &Value {
    changes
        .iter()
        .find(|change| change.get("deposed").is_none_or(Value::is_null))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn opentofu_reports_and_finishes_unfinished_replacement_cleanup() {
    let s = Scenario::new();
    s.apply(true);
    let created = read(s.root(), "engine.json")["container"].clone();
    s.interrupt_cleanup(true);

    // State keeps the old container under its deposed key, beside the current one.
    let objects = s.objects();
    assert_eq!(objects.len(), 2, "{objects:?}");
    let old = objects
        .iter()
        .find(|object| object["deposed_key"] == KEY)
        .unwrap();
    assert_eq!(old["mode"], "managed");
    assert_eq!(old["values"]["id"], OLD);

    // Apply plans to delete only the old container, by its ID.
    let changes = s.plan();
    assert_eq!(current(&changes)["change"]["actions"], json!(["no-op"]));
    let cleanup = &deposed(&changes)["change"];
    assert_eq!(cleanup["actions"], json!(["delete"]));
    assert_eq!(cleanup["before"]["id"], OLD);
    assert!(cleanup["after"].is_null());

    // A failed cleanup keeps the old container in state and on the engine.
    save(s.root(), "control.json", &json!({"cleanup_failure":true}));
    s.apply(false);
    assert!(read(s.root(), "engine.json")["deposed_container"].is_object());
    assert!(
        s.objects()
            .iter()
            .any(|object| object["deposed_key"] == KEY)
    );

    // The next apply deletes it and leaves the current container alone.
    save(s.root(), "control.json", &json!({}));
    s.apply(true);
    let engine = read(s.root(), "engine.json");
    assert!(engine["deposed_container"].is_null());
    assert_eq!(engine["container"]["Id"], created["Id"]);
    assert_eq!(s.objects().len(), 1);

    // A lost delete reply: refresh finds the old container gone, and the plan
    // has nothing to do for it.
    s.interrupt_cleanup(false);
    let changes = s.plan();
    let cleanup = &deposed(&changes)["change"];
    assert_eq!(cleanup["actions"], json!(["no-op"]));
    assert!(cleanup["before"].is_null() && cleanup["after"].is_null());
    s.apply(true);
    assert_eq!(s.objects().len(), 1);

    // Teardown, which plans without the container's configuration, deletes
    // the current and the old container.
    s.interrupt_cleanup(true);
    fs::write(
        s.workspace.path().join("main.tf"),
        fs::read_to_string(s.workspace.path().join("main.tf"))
            .unwrap()
            .replace(&container(), ""),
    )
    .unwrap();
    let changes = s.plan();
    assert_eq!(current(&changes)["change"]["actions"], json!(["delete"]));
    let cleanup = &deposed(&changes)["change"];
    assert_eq!(cleanup["actions"], json!(["delete"]));
    assert_eq!(cleanup["before"]["id"], OLD);
    s.apply(true);
    let engine = read(s.root(), "engine.json");
    assert!(engine["container"].is_null() && engine["deposed_container"].is_null());
}
