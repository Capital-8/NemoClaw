# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The Docker provider is mocked. Its alias and image addresses follow from the
# runner's fixed engine socket, unix:///tmp/nemoclaw-integration/CASE.sock.
mock_provider "docker" {
  alias = "engine_52eda79c1950072bac8db6a75108d1eb"
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
  target = docker_image.image_34d29801aac5362ff0ece25f44725c6a
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_8e2466401c9c2389f95a4cafe96ee16d
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
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

  # Docker inputs: the gateway container runs the image its storage was
  # initialized from, mounts the data path, receives the configuration the
  # real OpenShell provider returned, and carries the owner label.
  assert {
    condition = (
      docker_image.image_34d29801aac5362ff0ece25f44725c6a.name == openshell_gateway_storage.runtime.image
      && docker_container.managed_gateway_runtime.image == docker_image.image_34d29801aac5362ff0ece25f44725c6a.image_id
      && contains([for mount in docker_container.managed_gateway_runtime.mounts : mount.target if mount.type == "volume"], openshell_gateway_storage.runtime.data_path)
      && docker_container.managed_gateway_runtime.command == data.openshell_docker_gateway_runtime.managed_gateway_runtime.command
      && [for file in docker_container.managed_gateway_runtime.upload : file.content] == [data.openshell_docker_gateway_runtime.managed_gateway_runtime.config_file]
      && { for label in docker_container.managed_gateway_runtime.labels : label.label => label.value }["nemoclaw.nvidia.com/uid"] == local.owner
    )
    error_message = "The gateway container's Docker inputs do not match its storage and runtime configuration."
  }

  # The real providers initialized storage on the engine, then read the
  # mocked container by its ID and reached a ready, compatible gateway.
  assert {
    condition = (
      contains(local.engine.volumes, "${local.gateway_name}-data")
      && data.openshell_docker_gateway_readiness.current.engine == data.fixture_engine.docker.endpoint
      && data.openshell_docker_gateway_readiness.current.container_id == docker_container.managed_gateway_runtime.id
      && contains(local.engine.requests, "GET /containers/${local.gateway_container_id}/json")
      && data.openshell_docker_gateway_readiness.current.ready
      && data.openshell_gateway.apply.compatible
      && contains(data.openshell_gateway.apply.compute_drivers, "docker")
    )
    error_message = "The gateway container did not hand off to a ready, compatible gateway."
  }

  # The mocked pull's image ID reaches the real harness read.
  assert {
    condition = (
      docker_image.image_8e2466401c9c2389f95a4cafe96ee16d.name == openshell_sandbox.assistant.image
      && data.fabric_harness.assistant_acquired.image_id == docker_image.image_8e2466401c9c2389f95a4cafe96ee16d.image_id
      && data.fabric_harness.assistant_acquired.available
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
    )
    error_message = "The sandbox image did not hand off to the OpenClaw harness."
  }

  # OpenShell stored one registration at the fixture upstream, holding the
  # credential from NVIDIA_INFERENCE_API_KEY under the sandbox's name for it.
  assert {
    condition = (
      openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.api == "openai-completions"
      && openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint == "${data.fixture_http.inference.endpoint}/v1"
      && length(local.openshell.created_providers) == 1
      && local.openshell.created_providers[0].name == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration
      && local.openshell.created_providers[0].labels["nemoclaw.nvidia.com/uid"] == local.owner
      && local.openshell.created_providers[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && local.openshell.created_providers[0].credentials == {
        (openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
    )
    error_message = "The NVIDIA inference binding is not registered as configured."
  }

  # OpenShell created one sandbox in the deployment's workspace that names
  # the registration, allows only the inference endpoint, and runs Fabric.
  assert {
    condition = (
      length(local.openshell.created_sandboxes) == 1
      && local.openshell.created_sandboxes[0].id == openshell_sandbox.assistant.id
      && local.openshell.created_sandboxes[0].workspace == openshell_workspace.deployment.name
      && local.openshell.created_sandboxes[0].labels["nemoclaw.nvidia.com/uid"] == local.owner
      && local.openshell.created_sandboxes[0].providers == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && local.openshell.created_sandboxes[0].policy_endpoints == ["${trimprefix(data.fixture_http.inference.endpoint, "http://")}/v1/**"]
      && local.openshell.created_sandboxes[0].command == jsondecode(data.fabric_harness.assistant_acquired.launch_json).command
      && openshell_sandbox.assistant.policy_hash != ""
    )
    error_message = "The sandbox's identity, inference binding, or policy differs from the configuration."
  }

  # Fabric started the agent in that sandbox through ExecSandbox with the
  # configuration the SDK compiled, after OpenShell created it.
  assert {
    condition = (
      fabric_agent.assistant.sandbox == openshell_sandbox.assistant.ref
      && fabric_agent.assistant.runtime_id != ""
      && fabric_agent.assistant.models["primary"].api_key_env == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env
      && length(local.openshell.execs) == 1
      && local.openshell.execs[0].sandbox == "assistant"
      && local.openshell.execs[0].command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "assistant", "--config", "-"]
      && jsondecode(local.openshell.execs[0].stdin) == jsondecode(terraform_data.agent_assistant.input)
      && local.openshell.fabric.starts[openshell_sandbox.assistant.id] == 1
      && index(local.openshell.rpcs, "CreateProvider") < index(local.openshell.rpcs, "CreateSandbox")
      && index(local.openshell.rpcs, "CreateSandbox") < index(local.openshell.rpcs, "ExecSandbox")
    )
    error_message = "The Fabric agent did not start in the sandbox with its compiled configuration."
  }

  assert {
    condition     = local.upstream.requests == []
    error_message = "Configuring and starting the agent called the inference upstream."
  }
}

# OpenTofu removes a run's resources with the providers of the last run that
# applied them. This run changes nothing and permits that removal; the runner
# checks what remains afterward.
run "permit_teardown" {
  command = apply

  providers = {
    docker.engine_52eda79c1950072bac8db6a75108d1eb = docker.engine_52eda79c1950072bac8db6a75108d1eb
    openshell                                      = openshell.teardown
    fabric                                         = fabric.teardown
    host                                           = host
    vllm                                           = vllm
    ollama                                         = ollama
    fixture                                        = fixture
  }
}
