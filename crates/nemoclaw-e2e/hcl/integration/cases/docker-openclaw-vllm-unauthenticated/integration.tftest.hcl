# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The mocked Docker provider's alias and image addresses follow from the
# runner's engine socket; IDs match the shared docker module's declaration.
mock_provider "docker" {
  alias = "engine_458359b8eb2082727c6a2c24868bb29d"
}

override_resource {
  target = docker_container.managed_gateway_runtime
  values = { id = "fixture-gateway-container" }
}

override_resource {
  target = docker_container.inference_service_inference_qwen
  values = { id = "fixture-qwen-container" }
}

override_resource {
  target = docker_image.image_7375e80899aa9cf267de887f14c290c6
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_583faece70370c60fa76821c077d3b66
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

override_resource {
  target = docker_image.image_7d5ef94e4b20c07573fca715be7d2a6a
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

  # Without authentication the container mounts only its data volume, no
  # credential storage exists, and readiness reads the status file and no key.
  assert {
    condition = (
      docker_container.inference_service_inference_qwen.image == docker_image.image_7d5ef94e4b20c07573fca715be7d2a6a.image_id
      && [for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"] == ["${docker_volume.inference_storage_inference_qwen.name}:/data"]
      && module.observed.engine.volumes == ["${module.docker.prefix}-gateway-data"]
      && data.vllm_readiness.inference_service_inference_qwen.ready
      && contains(module.observed.engine.requests, "GET /containers/fixture-qwen-container/archive?path=%2Fdata%2Fstatus.json")
      && length([for request in module.observed.engine.requests : request if strcontains(request, "inference-key")]) == 0
    )
    error_message = "The unauthenticated vLLM service has credential storage, or its readiness read a key."
  }

  # OpenShell registered the address without a credential, and Fabric
  # started the agent with that address and model.
  assert {
    condition = (
      openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
      && values(module.observed.registrations)[0].credentials == {}
      && module.observed.sandboxes.assistant.providers == [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.registration]
      && module.observed.sandboxes.assistant.policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
      && module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.starts.assistant.configuration.models.primary.base_url == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
    )
    error_message = "The unauthenticated vLLM binding or the agent's configuration differs from the service."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "A deployment without hosted inference called the inference upstream."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "permit_teardown" {
  variables {
    permit_destroy = true
  }
}
