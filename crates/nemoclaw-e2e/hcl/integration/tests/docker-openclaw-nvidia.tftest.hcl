# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The live E2E hosted scenario: two OpenClaw agents on NVIDIA hosted inference
# behind a managed Docker gateway.

# Docker is mocked. Its alias and image addresses follow from the runner's
# engine socket; the IDs match the fixtures module's declaration.
mock_provider "docker" {
  alias = "engine_23ddaef7520a85fde258e31aae3cf758"
}

override_resource {
  target = docker_container.managed_gateway_runtime
  values = { id = "fixture-gateway-container" }
}

override_resource {
  target = docker_image.image_2cca7375931d84dde8c7697a5011510a
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
}

override_resource {
  target = docker_image.image_638c90056c2497661432d77b6741eb7d
  values = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000002" }
}

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-openclaw-nvidia"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  # Docker inputs: the gateway container runs the image its storage was
  # initialized from, mounts the data path, receives the configuration the
  # real OpenShell provider returned, and carries the owner label.
  assert {
    condition = (
      docker_image.image_2cca7375931d84dde8c7697a5011510a.name == openshell_gateway_storage.runtime.image
      && docker_container.managed_gateway_runtime.image == docker_image.image_2cca7375931d84dde8c7697a5011510a.image_id
      && contains([for mount in docker_container.managed_gateway_runtime.mounts : mount.target if mount.type == "volume"], openshell_gateway_storage.runtime.data_path)
      && docker_container.managed_gateway_runtime.command == data.openshell_docker_gateway_runtime.managed_gateway_runtime.command
      && [for file in docker_container.managed_gateway_runtime.upload : file.content] == [data.openshell_docker_gateway_runtime.managed_gateway_runtime.config_file]
      && { for label in docker_container.managed_gateway_runtime.labels : label.label => label.value }["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
    )
    error_message = "The gateway container's Docker inputs do not match its storage and runtime configuration."
  }

  # The real providers initialized storage on the engine, then read the
  # mocked container by its ID and reached a ready, compatible gateway.
  assert {
    condition = (
      contains(module.observed.engine.volumes, "${module.fixtures.prefix}-gateway-data")
      && data.openshell_docker_gateway_readiness.current.engine == module.observed.engine.endpoint
      && data.openshell_docker_gateway_readiness.current.container_id == docker_container.managed_gateway_runtime.id
      && contains(module.observed.engine.requests, "GET /containers/fixture-gateway-container/json")
      && data.openshell_docker_gateway_readiness.current.ready
      && data.openshell_gateway.apply.compatible
      && contains(data.openshell_gateway.apply.compute_drivers, "docker")
    )
    error_message = "The gateway container did not hand off to a ready, compatible gateway."
  }

  # The mocked pull's image ID reaches both agents' real harness reads.
  assert {
    condition = (
      docker_image.image_638c90056c2497661432d77b6741eb7d.name == openshell_sandbox.assistant.image
      && data.fabric_harness.assistant_acquired.image_id == docker_image.image_638c90056c2497661432d77b6741eb7d.image_id
      && data.fabric_harness.researcher_acquired.image_id == docker_image.image_638c90056c2497661432d77b6741eb7d.image_id
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
    )
    error_message = "The sandbox image did not hand off to the OpenClaw harnesses."
  }

  # OpenShell stored one registration at the fixture upstream, holding the
  # credential from NVIDIA_INFERENCE_API_KEY under the sandboxes' name for it.
  assert {
    condition = (
      openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.api == "openai-completions"
      && openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint == "${module.observed.http.endpoint}/v1"
      && keys(module.observed.registrations) == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].labels["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].config["OPENAI_BASE_URL"] == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].credentials == {
        (openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
    )
    error_message = "The NVIDIA inference binding is not registered as configured."
  }

  # OpenShell created both sandboxes in the deployment's workspace; each names
  # the registration, may reach only the inference endpoint, and runs Fabric.
  assert {
    condition = (
      keys(module.observed.agents) == ["assistant", "researcher"]
      && module.observed.agents.assistant.id == openshell_sandbox.assistant.id
      && module.observed.agents.researcher.id == openshell_sandbox.researcher.id
      && alltrue([
        for agent in values(module.observed.agents) :
        agent.workspace == openshell_workspace.deployment.name
        && agent.labels["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
        && agent.providers == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
        && agent.policy_endpoints == ["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"]
        && agent.command == jsondecode(data.fabric_harness.assistant_acquired.launch_json).command
      ])
      && openshell_sandbox.assistant.policy_hash != ""
    )
    error_message = "A sandbox's identity, inference binding, or policy differs from the configuration."
  }

  # Fabric started each agent once, in its sandbox, through ExecSandbox with
  # the configuration the SDK compiled, after OpenShell created it.
  assert {
    condition = (
      fabric_agent.assistant.sandbox == openshell_sandbox.assistant.ref
      && fabric_agent.researcher.sandbox == openshell_sandbox.researcher.ref
      && fabric_agent.assistant.models["primary"].api_key_env == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env
      && module.observed.agents.assistant.start.command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "assistant", "--config", "-"]
      && module.observed.agents.researcher.start.command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "researcher", "--config", "-"]
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.researcher.start.configuration == jsondecode(terraform_data.agent_researcher.input)
      && module.observed.openshell.fabric_starts[openshell_sandbox.assistant.id] == 1
      && module.observed.openshell.fabric_starts[openshell_sandbox.researcher.id] == 1
      && index(module.observed.openshell.rpcs, "CreateProvider") < index(module.observed.openshell.rpcs, "CreateSandbox")
      && index(module.observed.openshell.rpcs, "CreateSandbox") < index(module.observed.openshell.rpcs, "ExecSandbox")
    )
    error_message = "A Fabric agent did not start in its sandbox with its compiled configuration."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "Configuring and starting the agents called the inference upstream."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "teardown" {
  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  variables {
    permit_destroy = true
  }
}
