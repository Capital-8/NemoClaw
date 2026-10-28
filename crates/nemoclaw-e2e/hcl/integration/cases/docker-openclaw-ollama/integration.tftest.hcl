# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The Docker provider is mocked. Its alias and image addresses follow from the
# runner's fixed engine socket, unix:///tmp/nemoclaw-integration/CASE.sock.
mock_provider "docker" {
  alias = "engine_f25c36bf88278a32e798ca36e5874da3"
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
  target = docker_container.ollama_service_ollama-server
  values = { id = "fixture-ollama-container" }
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

# Declare the engine and upstream before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_engine.docker, data.fixture_http.inference]
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
      && { for label in docker_container.ollama_service_ollama-server.labels : label.label => label.value }["nemoclaw.nvidia.com/uid"] == local.owner
    )
    error_message = "The Ollama container's Docker inputs do not match its runtime launch."
  }

  # The real host provider found the acquired runtime image on the engine,
  # and readiness read the mocked container and its runtime status by ID.
  assert {
    condition = (
      data.host_image.runtime_image_acquired_ollama_service_ollama-server.image_id == docker_image.image_fab520dc5bd9818f486fc8e5bac2f4c5.image_id
      && jsondecode(data.host_image.runtime_image_acquired_ollama_service_ollama-server.observation_json).status == "available"
      && data.ollama_readiness.ollama_service_ollama-server.container_id == docker_container.ollama_service_ollama-server.id
      && data.ollama_readiness.ollama_service_ollama-server.ready
      && contains(local.engine.requests, "GET /containers/${local.ollama_container_id}/archive?path=%2Fdata%2Fstatus.json")
      && data.openshell_docker_gateway_readiness.current.ready
    )
    error_message = "The Ollama image or container did not hand off to a ready service."
  }

  # OpenShell registered the service's address without a credential, and
  # the sandbox may reach only that address.
  assert {
    condition = (
      openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint == "http://172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1"
      && length(local.openshell.created_providers) == 1
      && local.openshell.created_providers[0].name == openshell_inference.inference_local-5834fdcc94534d6506776906.registration
      && local.openshell.created_providers[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint
      && local.openshell.created_providers[0].credentials == {}
      && length(local.openshell.created_sandboxes) == 1
      && local.openshell.created_sandboxes[0].providers == [openshell_inference.inference_local-5834fdcc94534d6506776906.registration]
      && local.openshell.created_sandboxes[0].policy_endpoints == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1/**"]
    )
    error_message = "The Ollama binding or the sandbox's access to it differs from the service."
  }

  # Fabric started the agent with the service's address and model.
  assert {
    condition = (
      length(local.openshell.execs) == 1
      && local.openshell.execs[0].sandbox == "assistant"
      && local.openshell.execs[0].command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "main", "--config", "-"]
      && jsondecode(local.openshell.execs[0].stdin) == jsondecode(terraform_data.agent_assistant.input)
      && jsondecode(local.openshell.execs[0].stdin).models.primary.base_url == openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint
      && jsondecode(local.openshell.execs[0].stdin).models.primary.model == "qwen3:0.6b"
    )
    error_message = "The Fabric agent did not start with the Ollama service's address and model."
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
    docker.engine_f25c36bf88278a32e798ca36e5874da3 = docker.engine_f25c36bf88278a32e798ca36e5874da3
    openshell                                      = openshell.teardown
    fabric                                         = fabric.teardown
    host                                           = host
    vllm                                           = vllm
    ollama                                         = ollama
    fixture                                        = fixture
  }
}
