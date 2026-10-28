# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The Docker provider is mocked. Its alias and image addresses follow from the
# runner's fixed engine socket, unix:///tmp/nemoclaw-integration/CASE.sock.
mock_provider "docker" {
  alias = "engine_02632359dc013c8b7efa4491c2ae99fb"
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

# Declare the engine and upstream before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_engine.docker, data.fixture_http.inference]
  }
}

run "deploy" {
  command = apply

  # Both agents' images resolve to the one mocked sandbox pull, and the
  # Ollama service becomes ready behind the ready gateway.
  assert {
    condition = (
      data.fabric_harness.assistant_acquired.image_id == docker_image.image_684f1e7adde9d740873f313f775968da.image_id
      && data.fabric_harness.researcher_acquired.image_id == docker_image.image_684f1e7adde9d740873f313f775968da.image_id
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
      && data.fabric_harness.researcher_acquired.adapter_id == "nvidia.fabric.hermes"
      && data.ollama_readiness.ollama_service_ollama-server.container_id == docker_container.ollama_service_ollama-server.id
      && data.ollama_readiness.ollama_service_ollama-server.ready
      && data.openshell_docker_gateway_readiness.current.ready
    )
    error_message = "The images, the Ollama service, or the gateway did not hand off to the agents."
  }

  # OpenShell stored one registration per provider: the hosted one with the
  # credential from the environment, the Ollama one at the service without one.
  assert {
    condition = (
      length(local.registrations) == 2
      && openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint == "${data.fixture_http.inference.endpoint}/v1"
      && local.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].config["OPENAI_BASE_URL"] == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && local.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].credentials == {
        (openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
      && openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint == "http://172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1"
      && local.registrations[openshell_inference.inference_local-ceb21a97a2146548236ff520.registration].config["OPENAI_BASE_URL"] == openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint
      && local.registrations[openshell_inference.inference_local-ceb21a97a2146548236ff520.registration].credentials == {}
    )
    error_message = "The hosted and Ollama bindings are not registered as configured."
  }

  # Each sandbox names only its own provider and may reach only its endpoint.
  assert {
    condition = (
      length(local.sandboxes) == 2
      && local.sandboxes["assistant"].providers == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && local.sandboxes["assistant"].policy_endpoints == ["${trimprefix(data.fixture_http.inference.endpoint, "http://")}/v1/**"]
      && local.sandboxes["researcher"].providers == [openshell_inference.inference_local-ceb21a97a2146548236ff520.registration]
      && local.sandboxes["researcher"].policy_endpoints == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1/**"]
      && local.sandboxes["assistant"].workspace == local.sandboxes["researcher"].workspace
    )
    error_message = "A sandbox's inference binding or network access crosses to the other agent's provider."
  }

  # Fabric started each agent once, in its own sandbox, with its own harness
  # and the configuration the SDK compiled for it.
  assert {
    condition = (
      length(local.openshell.execs) == 2
      && local.starts["assistant"].command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "assistant", "--config", "-"]
      && jsondecode(local.starts["assistant"].stdin) == jsondecode(terraform_data.agent_assistant.input)
      && jsondecode(local.starts["assistant"].stdin).harness.adapter_id == "nvidia.fabric.openclaw"
      && jsondecode(local.starts["assistant"].stdin).models.primary.base_url == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && local.starts["researcher"].command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "researcher", "--config", "-"]
      && jsondecode(local.starts["researcher"].stdin) == jsondecode(terraform_data.agent_researcher.input)
      && jsondecode(local.starts["researcher"].stdin).harness.adapter_id == "nvidia.fabric.hermes"
      && jsondecode(local.starts["researcher"].stdin).models.primary.base_url == openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint
      && fabric_agent.assistant.sandbox == openshell_sandbox.assistant.ref
      && fabric_agent.researcher.sandbox == openshell_sandbox.researcher.ref
    )
    error_message = "A Fabric agent did not start in its own sandbox with its own configuration."
  }

  assert {
    condition     = local.upstream.requests == []
    error_message = "Configuring and starting the agents called the inference upstream."
  }
}

# OpenTofu removes a run's resources with the providers of the last run that
# applied them. This run changes nothing and permits that removal; the runner
# checks what remains afterward.
run "permit_teardown" {
  command = apply

  providers = {
    docker.engine_02632359dc013c8b7efa4491c2ae99fb = docker.engine_02632359dc013c8b7efa4491c2ae99fb
    openshell                                      = openshell.teardown
    fabric                                         = fabric.teardown
    host                                           = host
    vllm                                           = vllm
    ollama                                         = ollama
    fixture                                        = fixture
  }
}
