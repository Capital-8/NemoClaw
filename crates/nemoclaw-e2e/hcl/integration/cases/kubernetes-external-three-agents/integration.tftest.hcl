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

run "deploy" {
  command = apply

  # The gateway reports the Kubernetes driver, no provider inspects an engine,
  # and each harness comes from the metadata bundle.
  assert {
    condition = (
      data.openshell_gateway.apply.compatible
      && data.openshell_gateway.apply.compute_drivers == toset(["kubernetes"])
      && module.observed.engine.requests == []
      && alltrue([
        for harness in [data.fabric_harness.assistant, data.fabric_harness.researcher, data.fabric_harness.reviewer] :
        harness.available && harness.metadata_env == "NEMOCLAW_AGENT_IMAGE_METADATA"
      ])
    )
    error_message = "The Kubernetes gateway or a harness from the metadata bundle was not found."
  }

  # One registration holds the environment credential, and all three
  # sandboxes name it and may reach only its endpoint.
  assert {
    condition = (
      keys(module.observed.registrations) == [openshell_inference.inference_inference-2c7590f4a674089b7cabb3e1.registration]
      && values(module.observed.registrations)[0].credentials == {
        (openshell_inference.inference_inference-2c7590f4a674089b7cabb3e1.sandbox_env) = "env:INFERENCE_API_KEY"
      }
      && keys(module.observed.sandboxes) == ["assistant", "researcher", "reviewer"]
      && alltrue([
        for sandbox in values(module.observed.sandboxes) :
        sandbox.providers == [openshell_inference.inference_inference-2c7590f4a674089b7cabb3e1.registration]
        && sandbox.policy_endpoints == ["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"]
      ])
    )
    error_message = "The shared registration or a sandbox's binding or policy differs from the configuration."
  }

  # Fabric started each agent once in its own sandbox with its compiled configuration.
  assert {
    condition = (
      module.observed.starts.assistant.command[3] == "main"
      && module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.starts.researcher.configuration == jsondecode(terraform_data.agent_researcher.input)
      && module.observed.starts.reviewer.configuration == jsondecode(terraform_data.agent_reviewer.input)
      && module.observed.http.requests == []
    )
    error_message = "An agent did not start in its own sandbox with its compiled configuration, or inference was called."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "permit_teardown" {
  variables {
    permit_destroy = true
  }
}
