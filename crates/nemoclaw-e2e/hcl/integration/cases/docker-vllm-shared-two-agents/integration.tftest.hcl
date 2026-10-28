# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The mocked Docker provider's alias and image addresses follow from the
# runner's engine socket; IDs match the shared docker module's declaration.
mock_provider "docker" {
  alias = "engine_52d87ec296278194ae85a25c011b34cc"
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
  target = docker_image.image_988edcdb1d22d79e5f67a83f7a10c730
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_e337127fcf829db47847aa19044d91a0
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

override_resource {
  target = docker_image.image_41ca6ec2414a2dd14c4740f986f2de7f
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

  # One authenticated vLLM container serves both agents from the credential
  # storage the real vLLM provider created.
  assert {
    condition = (
      contains([for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"], "${vllm_credential_storage.inference_qwen_auth.name}:/credentials")
      && contains(module.observed.engine.volumes, vllm_credential_storage.inference_qwen_auth.name)
      && data.vllm_readiness.inference_service_inference_qwen.ready
    )
    error_message = "The shared vLLM service did not become ready with its credential storage."
  }

  # Each harness has its own registration of the one service, holding the
  # generated key; each sandbox names only its own, and its agent starts with
  # that registration's key name and the shared address.
  assert {
    condition = (
      length(module.observed.registrations) == 2
      && module.observed.sandboxes.assistant.providers != module.observed.sandboxes.researcher.providers
      && alltrue([
        for binding in [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08, openshell_inference.inference_qwen-baed0ef93c97fa7f05788644] :
        module.observed.registrations[binding.registration].credentials == {
          (binding.sandbox_env) = "file:${module.docker.services.qwen.name}:/credentials/inference-key"
        }
      ])
      && alltrue([
        for sandbox in ["assistant", "researcher"] :
        length(module.observed.sandboxes[sandbox].providers) == 1
        && module.observed.sandboxes[sandbox].policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
        && module.observed.starts[sandbox].configuration.models.primary.base_url == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
        && contains([
          for binding in [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08, openshell_inference.inference_qwen-baed0ef93c97fa7f05788644] :
          binding.sandbox_env if[binding.registration] == module.observed.sandboxes[sandbox].providers
        ], module.observed.starts[sandbox].configuration.models.primary.api_key_env)
      ])
      && module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.starts.researcher.configuration == jsondecode(terraform_data.agent_researcher.input)
    )
    error_message = "The shared service's registrations, keys, bindings, or agent configurations differ from the configuration."
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
