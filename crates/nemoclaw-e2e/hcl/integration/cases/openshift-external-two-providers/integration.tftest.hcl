# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An OpenShift gateway uses no engine, so nothing is mocked.
provider "openshell" {}
provider "fabric" {}
provider "host" {}
provider "vllm" {}
provider "ollama" {}
provider "fixture" {}

# The SDK's teardown graph permits deletion; its apply graph does not.
provider "openshell" {
  alias   = "teardown"
  destroy = true
}

provider "fabric" {
  alias   = "teardown"
  destroy = true
}

# Declare the gateway and upstream before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_gateway.cluster, data.fixture_http.inference]
  }
}

run "deploy" {
  command = apply

  assert {
    condition = (
      data.openshell_gateway.apply.compatible
      && data.openshell_gateway.apply.compute_drivers == toset(["kubernetes"])
      && local.engine.requests == []
      && data.fabric_harness.assistant.adapter_id == "nvidia.fabric.openclaw"
      && data.fabric_harness.researcher.adapter_id == "nvidia.fabric.hermes"
    )
    error_message = "The OpenShift gateway or the harnesses from the metadata bundle were not found."
  }

  # OpenShell stored each binding with its own API's base URL and the
  # credential from its provider's environment variable.
  assert {
    condition = (
      keys(local.registrations) == keys(local.bindings)
      && alltrue([
        for name, binding in local.bindings :
        local.registrations[name].credentials == { (binding.sandbox_env) = "env:${binding.server.credential_env}" }
        && contains(values(local.registrations[name].config), binding.server.endpoint)
        && binding.server.endpoint == "${data.fixture_http.inference.endpoint}/v1"
      ])
      && openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.api == "anthropic-messages"
      && openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.server.credential_env == "HOSTED_API_KEY"
    )
    error_message = "A registration's API, base URL, or credential differs from its provider."
  }

  # The OpenClaw sandbox names the Anthropic binding and one NVIDIA binding;
  # the Hermes sandbox names only its own NVIDIA binding.
  assert {
    condition = (
      toset(local.sandboxes["assistant"].providers) == toset([for provider in openshell_sandbox.assistant.providers : provider.registration])
      && toset(local.sandboxes["researcher"].providers) == toset([for provider in openshell_sandbox.researcher.providers : provider.registration])
      && contains(local.sandboxes["assistant"].providers, openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.registration)
      && length(local.sandboxes["assistant"].providers) == 2
      && !contains(local.sandboxes["researcher"].providers, openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.registration)
      && length(local.sandboxes["researcher"].providers) == 1
      && length(setintersection(local.sandboxes["assistant"].providers, local.sandboxes["researcher"].providers)) == 0
    )
    error_message = "A sandbox names another agent's binding or misses its own."
  }

  # Fabric started OpenClaw with both routes, Anthropic by default, each
  # under its own binding's key name, and Hermes with its one route.
  assert {
    condition = (
      length(local.openshell.execs) == 2
      && local.started["assistant"] == jsondecode(terraform_data.agent_assistant.input)
      && local.started["researcher"] == jsondecode(terraform_data.agent_researcher.input)
      && local.started["assistant"].models.smart.api_key_env == openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa.sandbox_env
      && local.started["assistant"].models.default == local.started["assistant"].models.smart
      && contains([for name in local.sandboxes["assistant"].providers : local.bindings[name].sandbox_env], local.started["assistant"].models.fast.api_key_env)
      && local.started["researcher"].harness.adapter_id == "nvidia.fabric.hermes"
      && local.started["researcher"].models.primary.api_key_env == local.bindings[local.sandboxes["researcher"].providers[0]].sandbox_env
    )
    error_message = "An agent did not start with its routes and its own bindings' key names."
  }

  assert {
    condition     = local.upstream.requests == []
    error_message = "Configuring and starting the agents called an inference upstream."
  }
}

# OpenTofu removes a run's resources with the providers of the last run that
# applied them. This run changes nothing and permits that removal; the runner
# checks what remains afterward.
run "permit_teardown" {
  command = apply

  providers = {
    openshell = openshell.teardown
    fabric    = fabric.teardown
    host      = host
    vllm      = vllm
    ollama    = ollama
    fixture   = fixture
  }
}
