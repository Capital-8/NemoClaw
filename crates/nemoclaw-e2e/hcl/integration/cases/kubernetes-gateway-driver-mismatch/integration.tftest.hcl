# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A Kubernetes gateway uses no engine, so nothing is mocked.

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_state.setup]
  }
}

# The workspace precondition rejects the plan before any gateway object
# is planned; dependent objects are never evaluated.
run "plan_rejects_incompatible_gateway" {
  command         = plan
  expect_failures = [openshell_workspace.deployment]
}

# Nothing reached OpenShell, Fabric, or the inference upstream, and the
# gateway names the missing driver. A targeted plan does not evaluate locals,
# so the observations are decoded here.
run "nothing_changed" {
  command = plan

  plan_options {
    target = [data.openshell_gateway.current, data.fixture_state.now]
  }

  assert {
    condition = (
      !data.openshell_gateway.current.compatible
      && strcontains(data.openshell_gateway.current.incompatibility, "kubernetes")
    )
    error_message = "The gateway did not report the missing Kubernetes driver."
  }

  assert {
    condition = (
      jsondecode(data.fixture_state.now.observations).openshell.created_providers == []
      && jsondecode(data.fixture_state.now.observations).openshell.created_sandboxes == []
      && jsondecode(data.fixture_state.now.observations).openshell.execs == []
      && jsondecode(data.fixture_state.now.observations).openshell.workspaces == []
      && jsondecode(data.fixture_state.now.observations).http.requests == []
    )
    error_message = "An incompatible gateway received changes, or inference was called."
  }
}
