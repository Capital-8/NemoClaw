# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The Docker provider is mocked. Its alias and image addresses follow from the
# runner's fixed engine socket, unix:///tmp/nemoclaw-integration/CASE.sock.
mock_provider "docker" {
  alias = "engine_f89fac887110ef1343c27ef101d8f0e9"
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
  target = docker_image.image_daa6d1792943cbc17fbfbacdedbb9def
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_aee9e5430d1479f6dfd173d0400547e4
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

override_resource {
  target = docker_image.image_7b22b0d2475b85cddc02f4821135d50c
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

  # Docker inputs: the vLLM container runs the acquired image with the
  # runtime launch the real vLLM provider computed, on its data volume and the
  # credential storage that provider created, with GPUs, at the gateway
  # network's host address.
  assert {
    condition = (
      docker_container.inference_service_inference_qwen.image == docker_image.image_7b22b0d2475b85cddc02f4821135d50c.image_id
      && docker_container.inference_service_inference_qwen.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.vllm_runtime.inference_service_inference_qwen.spec}"])
      && toset([for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"]) == toset([
        "${docker_volume.inference_storage_inference_qwen.name}:/data",
        "${vllm_credential_storage.inference_qwen_auth.name}:/credentials",
      ])
      && [for port in docker_container.inference_service_inference_qwen.ports : "${port.ip}:${port.external}"] == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}"]
      && docker_container.inference_service_inference_qwen.gpus == "all"
    )
    error_message = "The vLLM container's Docker inputs do not match its runtime launch and credential storage."
  }

  # The real vLLM provider created the credential volume on the engine, and
  # readiness read the mocked container's status and generated key by ID.
  assert {
    condition = (
      contains(local.engine.volumes, vllm_credential_storage.inference_qwen_auth.name)
      && jsondecode(data.host_image.runtime_image_acquired_inference_service_inference_qwen.observation_json).status == "available"
      && data.vllm_readiness.inference_service_inference_qwen.container_id == docker_container.inference_service_inference_qwen.id
      && data.vllm_readiness.inference_service_inference_qwen.ready
      && contains(local.engine.requests, "GET /containers/${local.vllm_container_id}/archive?path=%2Fdata%2Fstatus.json")
      && contains(local.engine.requests, "GET /containers/${local.vllm_container_id}/archive?path=%2Fcredentials%2Finference-key")
      && data.openshell_docker_gateway_readiness.current.ready
    )
    error_message = "The vLLM credential storage or container did not hand off to a ready service."
  }

  # OpenShell registered the service's address with the key the runtime
  # generated, and the sandbox may reach only that address.
  assert {
    condition = (
      openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
      && length(local.openshell.created_providers) == 1
      && local.openshell.created_providers[0].name == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.registration
      && local.openshell.created_providers[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
      && local.openshell.created_providers[0].credentials == {
        (openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.sandbox_env) = "file:${local.vllm_name}:/credentials/inference-key"
      }
      && length(local.openshell.created_sandboxes) == 1
      && local.openshell.created_sandboxes[0].providers == [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.registration]
      && local.openshell.created_sandboxes[0].policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
    )
    error_message = "The vLLM binding, its key, or the sandbox's access to it differs from the service."
  }

  # Fabric started the agent with the service's address, model, and the
  # sandbox's name for the key.
  assert {
    condition = (
      length(local.openshell.execs) == 1
      && local.openshell.execs[0].sandbox == "assistant"
      && local.openshell.execs[0].command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "assistant", "--config", "-"]
      && jsondecode(local.openshell.execs[0].stdin) == jsondecode(terraform_data.agent_assistant.input)
      && jsondecode(local.openshell.execs[0].stdin).models.primary.base_url == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
      && jsondecode(local.openshell.execs[0].stdin).models.primary.api_key_env == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.sandbox_env
      && jsondecode(local.openshell.execs[0].stdin).models.primary.model == "Qwen/Qwen3-4B"
    )
    error_message = "The Fabric agent did not start with the vLLM service's address, key name, and model."
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
    docker.engine_f89fac887110ef1343c27ef101d8f0e9 = docker.engine_f89fac887110ef1343c27ef101d8f0e9
    openshell                                      = openshell.teardown
    fabric                                         = fabric.teardown
    host                                           = host
    vllm                                           = vllm
    ollama                                         = ollama
    fixture                                        = fixture
  }
}
