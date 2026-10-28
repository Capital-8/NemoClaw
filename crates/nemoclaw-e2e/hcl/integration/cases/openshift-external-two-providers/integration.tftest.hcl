# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An OpenShift gateway uses no engine, so nothing is mocked.

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  command = apply

  assert {
    condition = (
      data.openshell_gateway.apply.compatible
      && module.observed.engine.requests == []
      && data.fabric_harness.researcher.adapter_id == "nvidia.fabric.hermes"
    )
    error_message = "The OpenShift gateway or the harnesses from the metadata bundle were not found."
  }

  # Each registration holds its own API's base URL and the credential from its
  # provider's environment variable.
  assert {
    condition = alltrue([
      for binding in [
        openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa,
        openshell_inference.inference_nvidia-2cfb2cb09d105f40b4d93c7f,
        openshell_inference.inference_nvidia-d5ac1fe153c78e2f547d31a5,
      ] :
      module.observed.registrations[binding.registration].credentials == { (binding.sandbox_env) = "env:${binding.server.credential_env}" }
      && contains(values(module.observed.registrations[binding.registration].config), binding.server.endpoint)
    ]) && openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.api == "anthropic-messages"
    error_message = "A registration's API, base URL, or credential differs from its provider."
  }

  # The OpenClaw sandbox names the Anthropic binding and one NVIDIA binding;
  # the Hermes sandbox names only its own NVIDIA binding.
  assert {
    condition = (
      contains(module.observed.sandboxes.assistant.providers, openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.registration)
      && length(module.observed.sandboxes.assistant.providers) == 2
      && length(module.observed.sandboxes.researcher.providers) == 1
      && length(setintersection(module.observed.sandboxes.assistant.providers, module.observed.sandboxes.researcher.providers)) == 0
    )
    error_message = "A sandbox names another agent's binding or misses its own."
  }

  # OpenClaw starts with both routes, Anthropic by default; Hermes with one.
  assert {
    condition = (
      module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.starts.researcher.configuration == jsondecode(terraform_data.agent_researcher.input)
      && module.observed.starts.assistant.configuration.models.smart.api_key_env == openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.sandbox_env
      && module.observed.starts.assistant.configuration.models.default == module.observed.starts.assistant.configuration.models.smart
      && module.observed.http.requests == []
    )
    error_message = "An agent did not start with its routes and key names, or inference was called."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "permit_teardown" {
  variables {
    permit_destroy = true
  }
}
