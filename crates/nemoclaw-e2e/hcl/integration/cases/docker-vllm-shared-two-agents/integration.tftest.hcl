# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The Docker provider is mocked. Its alias and image addresses follow from the
# runner's fixed engine socket, unix:///tmp/nemoclaw-integration/CASE.sock.
mock_provider "docker" {
  alias = "engine_52d87ec296278194ae85a25c011b34cc"
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
  target = docker_image.image_988edcdb1d22d79e5f67a83f7a10c730
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_e337127fcf829db47847aa19044d91a0
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

override_resource {
  target = docker_image.image_41ca6ec2414a2dd14c4740f986f2de7f
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

  # One authenticated vLLM container serves both agents from the credential
  # storage the real vLLM provider created, and readiness read its key.
  assert {
    condition = (
      contains([for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"], "${vllm_credential_storage.inference_qwen_auth.name}:/credentials")
      && contains(local.engine.volumes, vllm_credential_storage.inference_qwen_auth.name)
      && data.vllm_readiness.inference_service_inference_qwen.ready
      && contains(local.engine.requests, "GET /containers/${local.vllm_container_id}/archive?path=%2Fcredentials%2Finference-key")
    )
    error_message = "The shared vLLM service did not become ready with its credential storage."
  }

  # Each harness gets its own registration of the one service, each holding
  # the key the runtime generated, and each sandbox names only its own.
  assert {
    condition = (
      length(local.registrations) == 2
      && local.bindings["assistant"].registration != local.bindings["researcher"].registration
      && alltrue([
        for sandbox, binding in local.bindings :
        binding.server.endpoint == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
        && local.registrations[binding.registration].credentials == {
          (binding.sandbox_env) = "file:${local.vllm_name}:/credentials/inference-key"
        }
        && local.sandboxes[sandbox].policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
      ])
    )
    error_message = "The shared service's registrations, keys, or sandbox bindings differ from the configuration."
  }

  # Fabric started each agent with its harness, the shared address and model,
  # and its own registration's key name.
  assert {
    condition = (
      length(local.openshell.execs) == 2
      && local.started["assistant"] == jsondecode(terraform_data.agent_assistant.input)
      && local.started["researcher"] == jsondecode(terraform_data.agent_researcher.input)
      && local.started["assistant"].harness.adapter_id == "nvidia.fabric.openclaw"
      && local.started["researcher"].harness.adapter_id == "nvidia.fabric.hermes"
      && alltrue([
        for sandbox, binding in local.bindings :
        local.started[sandbox].models.primary.base_url == binding.server.endpoint
        && local.started[sandbox].models.primary.api_key_env == binding.sandbox_env
        && local.started[sandbox].models.primary.model == "Qwen/Qwen3-4B"
      ])
    )
    error_message = "An agent did not start with the shared service and its own key name."
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
    docker.engine_52d87ec296278194ae85a25c011b34cc = docker.engine_52d87ec296278194ae85a25c011b34cc
    openshell                                      = openshell.teardown
    fabric                                         = fabric.teardown
    host                                           = host
    vllm                                           = vllm
    ollama                                         = ollama
    fixture                                        = fixture
  }
}
