# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The Docker provider is mocked. Its alias and image addresses follow from the
# runner's fixed engine socket, unix:///tmp/nemoclaw-integration/CASE.sock.
mock_provider "docker" {
  alias = "engine_458359b8eb2082727c6a2c24868bb29d"
}

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

override_resource {
  target = docker_container.managed_gateway_runtime
  values = { id = "fixture-gateway-container" }
}

override_resource {
  target = docker_container.inference_service_inference_qwen
  values = { id = "fixture-vllm-container" }
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
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000004" }
}

# Declare the engine and upstream before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_engine.docker, data.fixture_http.inference]
  }
}

run "deploy" {
  command = apply

  # Docker inputs: without authentication the container mounts only its data
  # volume, and no credential storage exists.
  assert {
    condition = (
      docker_container.inference_service_inference_qwen.image == docker_image.image_7d5ef94e4b20c07573fca715be7d2a6a.image_id
      && docker_container.inference_service_inference_qwen.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.vllm_runtime.inference_service_inference_qwen.spec}"])
      && [for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"] == ["${docker_volume.inference_storage_inference_qwen.name}:/data"]
      && [for port in docker_container.inference_service_inference_qwen.ports : "${port.ip}:${port.external}"] == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}"]
      && local.engine.volumes == ["${local.gateway_name}-data"]
    )
    error_message = "The unauthenticated vLLM container's Docker inputs or storage differ from its runtime launch."
  }

  # Readiness read the status file and no key.
  assert {
    condition = (
      data.vllm_readiness.inference_service_inference_qwen.ready
      && data.vllm_readiness.inference_service_inference_qwen.container_id == docker_container.inference_service_inference_qwen.id
      && contains(local.engine.requests, "GET /containers/${local.vllm_container_id}/archive?path=%2Fdata%2Fstatus.json")
      && length([for request in local.engine.requests : request if strcontains(request, "inference-key")]) == 0
    )
    error_message = "Readiness of the unauthenticated vLLM service did not follow its status, or read a key."
  }

  # OpenShell registered the address without a credential, and Fabric
  # started the agent with that address and model.
  assert {
    condition = (
      openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
      && openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.credential_source == ""
      && length(local.openshell.created_providers) == 1
      && local.openshell.created_providers[0].credentials == {}
      && local.openshell.created_providers[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
      && local.openshell.created_sandboxes[0].providers == [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.registration]
      && local.openshell.created_sandboxes[0].policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
      && length(local.openshell.execs) == 1
      && jsondecode(local.openshell.execs[0].stdin) == jsondecode(terraform_data.agent_assistant.input)
      && jsondecode(local.openshell.execs[0].stdin).models.primary.base_url == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
      && jsondecode(local.openshell.execs[0].stdin).models.primary.model == "Qwen/Qwen3-4B"
    )
    error_message = "The unauthenticated vLLM binding or the agent's configuration differs from the service."
  }

  assert {
    condition     = local.upstream.requests == []
    error_message = "A deployment without hosted inference called the inference upstream."
  }
}

# OpenTofu removes a run's resources with the providers of the last run that
# applied them. This run changes nothing and permits that removal; the runner
# checks what remains afterward.
run "permit_teardown" {
  command = apply

  providers = {
    docker.engine_458359b8eb2082727c6a2c24868bb29d = docker.engine_458359b8eb2082727c6a2c24868bb29d
    openshell                                      = openshell.teardown
    fabric                                         = fabric.teardown
    host                                           = host
    vllm                                           = vllm
    ollama                                         = ollama
    fixture                                        = fixture
  }
}
