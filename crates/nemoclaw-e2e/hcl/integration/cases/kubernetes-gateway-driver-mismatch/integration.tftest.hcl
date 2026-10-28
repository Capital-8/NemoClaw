# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A Kubernetes gateway uses no engine, so nothing is mocked.
provider "openshell" {}
provider "fabric" {}
provider "host" {}
provider "vllm" {}
provider "ollama" {}
provider "fixture" {}

run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_gateway.wrong_driver, data.fixture_http.inference]
  }
}

# The workspace, which every other gateway object follows, rejects the
# incompatible gateway in its precondition.
run "plan_rejects_the_gateway" {
  command = plan

  expect_failures = [openshell_workspace.deployment]
}

# The gateway reports why, and nothing reached OpenShell, Fabric, or the
# inference upstream.
run "nothing_changed" {
  command = plan

  plan_options {
    target = [data.openshell_gateway.current, data.fixture_observations.now]
  }

  assert {
    condition = (
      !data.openshell_gateway.current.compatible
      && strcontains(data.openshell_gateway.current.incompatibility, "kubernetes")
      && data.openshell_gateway.current.compute_drivers == toset(["docker"])
    )
    error_message = "The gateway's incompatibility does not name the missing Kubernetes driver."
  }

  # Locals are not evaluated in a targeted plan, so the observations are
  # decoded here.
  assert {
    condition = (
      jsondecode(data.fixture_observations.now.openshell_json).created_providers == []
      && jsondecode(data.fixture_observations.now.openshell_json).created_sandboxes == []
      && jsondecode(data.fixture_observations.now.openshell_json).execs == []
      && jsondecode(data.fixture_observations.now.openshell_json).objects.workspaces == []
      && length([for rpc in jsondecode(data.fixture_observations.now.openshell_json).rpcs : rpc if startswith(rpc, "Create") || startswith(rpc, "Import")]) == 0
      && jsondecode(data.fixture_observations.now.http_json).requests == []
    )
    error_message = "A rejected plan changed the gateway or called the inference upstream."
  }
}
