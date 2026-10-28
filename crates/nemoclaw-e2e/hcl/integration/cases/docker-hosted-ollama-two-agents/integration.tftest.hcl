# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The mocked Docker provider's alias and image addresses follow from the
# runner's engine socket; IDs match the shared docker module's declaration.
mock_provider "docker" {
  alias = "engine_02632359dc013c8b7efa4491c2ae99fb"
}

override_resource {
  target = docker_container.managed_gateway_runtime
  values = { id = "fixture-gateway-container" }
}

override_resource {
  target = docker_container.ollama_service_ollama-server
  values = { id = "fixture-ollama-server-container" }
}

override_resource {
  target = docker_image.image_3e2efcb7c5d21ef1acb25ff3770104ea
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_684f1e7adde9d740873f313f775968da
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

override_resource {
  target = docker_image.image_9af26e690485dd89f450153344059cf8
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000003" }
}

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  command = apply

  # Both harnesses resolve to the one mocked sandbox pull, behind a ready
  # gateway and Ollama service.
  assert {
    condition = (
      data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
      && data.fabric_harness.researcher_acquired.adapter_id == "nvidia.fabric.hermes"
      && data.fabric_harness.researcher_acquired.image_id == data.fabric_harness.assistant_acquired.image_id
      && data.ollama_readiness.ollama_service_ollama-server.ready
      && data.openshell_docker_gateway_readiness.current.ready
    )
    error_message = "The images, the Ollama service, or the gateway did not hand off to the agents."
  }

  # One registration per provider: hosted with the environment credential,
  # Ollama at the service without one.
  assert {
    condition = (
      length(module.observed.registrations) == 2
      && openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint == "${module.observed.http.endpoint}/v1"
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].credentials == {
        (openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
      && openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint == "http://172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1"
      && module.observed.registrations[openshell_inference.inference_local-ceb21a97a2146548236ff520.registration].credentials == {}
    )
    error_message = "The hosted and Ollama bindings are not registered as configured."
  }

  # Each sandbox names only its own provider and may reach only its endpoint.
  assert {
    condition = (
      module.observed.sandboxes.assistant.providers == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && module.observed.sandboxes.assistant.policy_endpoints == ["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"]
      && module.observed.sandboxes.researcher.providers == [openshell_inference.inference_local-ceb21a97a2146548236ff520.registration]
      && module.observed.sandboxes.researcher.policy_endpoints == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1/**"]
    )
    error_message = "A sandbox's inference binding or network access crosses to the other agent's provider."
  }

  # Fabric started each agent once, in its own sandbox, with its compiled
  # configuration and its own provider's address.
  assert {
    condition = (
      length(module.observed.starts) == 2
      && module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.starts.researcher.configuration == jsondecode(terraform_data.agent_researcher.input)
      && module.observed.starts.assistant.configuration.models.primary.base_url == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && module.observed.starts.researcher.configuration.harness.adapter_id == "nvidia.fabric.hermes"
      && module.observed.starts.researcher.configuration.models.primary.base_url == openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint
    )
    error_message = "A Fabric agent did not start in its own sandbox with its own configuration."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "Configuring and starting the agents called the inference upstream."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "permit_teardown" {
  variables {
    permit_destroy = true
  }
}
