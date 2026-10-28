# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The mocked Docker provider's alias and image addresses follow from the
# runner's engine socket; IDs match the shared docker module's declaration.
mock_provider "docker" {
  alias = "engine_f25c36bf88278a32e798ca36e5874da3"
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
  target = docker_image.image_6e3ac62689c3f1d1c89a1488d116fae1
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_9a21067d734d6f6b8d958072c3212dfa
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

override_resource {
  target = docker_image.image_fab520dc5bd9818f486fc8e5bac2f4c5
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

  # Docker inputs: the Ollama container runs the acquired image with the
  # runtime launch the real Ollama provider computed, on the service volume,
  # GPUs, and the gateway network's host address.
  assert {
    condition = (
      docker_container.ollama_service_ollama-server.image == docker_image.image_fab520dc5bd9818f486fc8e5bac2f4c5.image_id
      && docker_container.ollama_service_ollama-server.entrypoint == data.ollama_runtime.ollama_service_ollama-server.launch.entrypoint
      && docker_container.ollama_service_ollama-server.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.ollama_runtime.ollama_service_ollama-server.spec}"])
      && [for mount in docker_container.ollama_service_ollama-server.mounts : "${mount.source}:${mount.target}"] == ["${docker_volume.ollama_service_storage_ollama-server.name}:${data.ollama_runtime.ollama_service_ollama-server.launch.data_path}"]
      && [for port in docker_container.ollama_service_ollama-server.ports : "${port.ip}:${port.external}"] == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}"]
      && docker_container.ollama_service_ollama-server.gpus == "all"
      && data.ollama_runtime.ollama_service_ollama-server.requirements.gpu
    )
    error_message = "The Ollama container's Docker inputs do not match its runtime launch."
  }

  # The real host provider found the acquired runtime image on the engine,
  # and readiness read the mocked container and its runtime status by ID.
  assert {
    condition = (
      jsondecode(data.host_image.runtime_image_acquired_ollama_service_ollama-server.observation_json).status == "available"
      && data.ollama_readiness.ollama_service_ollama-server.container_id == docker_container.ollama_service_ollama-server.id
      && data.ollama_readiness.ollama_service_ollama-server.ready
      && contains(module.observed.engine.requests, "GET /containers/fixture-ollama-server-container/archive?path=%2Fdata%2Fstatus.json")
    )
    error_message = "The Ollama image or container did not hand off to a ready service."
  }

  # OpenShell registered the service's address without a credential, the
  # sandbox may reach only that address, and Fabric started the agent with
  # that address and model.
  assert {
    condition = (
      openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint == "http://172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1"
      && keys(module.observed.registrations) == [openshell_inference.inference_local-5834fdcc94534d6506776906.registration]
      && values(module.observed.registrations)[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint
      && values(module.observed.registrations)[0].credentials == {}
      && module.observed.sandboxes.assistant.providers == [openshell_inference.inference_local-5834fdcc94534d6506776906.registration]
      && module.observed.sandboxes.assistant.policy_endpoints == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1/**"]
      && module.observed.starts.assistant.command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "main", "--config", "-"]
      && module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.starts.assistant.configuration.models.primary.base_url == openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint
      && module.observed.starts.assistant.configuration.models.primary.model == "qwen3:0.6b"
    )
    error_message = "The Ollama binding, the sandbox's access to it, or the agent's configuration differs from the service."
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
