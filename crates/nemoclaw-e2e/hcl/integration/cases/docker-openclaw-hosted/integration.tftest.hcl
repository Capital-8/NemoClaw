# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The mocked Docker provider's alias and image addresses follow from the
# runner's engine socket; IDs match the shared docker module's declaration.
mock_provider "docker" {
  alias = "engine_52eda79c1950072bac8db6a75108d1eb"
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

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_state.setup]
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
      && { for label in docker_container.managed_gateway_runtime.labels : label.label => label.value }["nemoclaw.nvidia.com/uid"] == module.docker.owner
    )
    error_message = "The gateway container's Docker inputs do not match its storage and runtime configuration."
  }

  # The real providers initialized storage on the engine, then read the
  # mocked container by its ID and reached a ready, compatible gateway.
  assert {
    condition = (
      contains(module.observed.engine.volumes, "${module.docker.prefix}-gateway-data")
      && data.openshell_docker_gateway_readiness.current.engine == module.observed.engine.endpoint
      && data.openshell_docker_gateway_readiness.current.container_id == docker_container.managed_gateway_runtime.id
      && contains(module.observed.engine.requests, "GET /containers/fixture-gateway-container/json")
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
      && openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint == "${module.observed.http.endpoint}/v1"
      && keys(module.observed.registrations) == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].labels["nemoclaw.nvidia.com/uid"] == module.docker.owner
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].config["OPENAI_BASE_URL"] == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].credentials == {
        (openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
    )
    error_message = "The NVIDIA inference binding is not registered as configured."
  }

  # OpenShell created one sandbox in the deployment's workspace that names
  # the registration, allows only the inference endpoint, and runs Fabric.
  assert {
    condition = (
      keys(module.observed.sandboxes) == ["assistant"]
      && module.observed.sandboxes.assistant.id == openshell_sandbox.assistant.id
      && module.observed.sandboxes.assistant.workspace == openshell_workspace.deployment.name
      && module.observed.sandboxes.assistant.labels["nemoclaw.nvidia.com/uid"] == module.docker.owner
      && module.observed.sandboxes.assistant.providers == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && module.observed.sandboxes.assistant.policy_endpoints == ["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"]
      && module.observed.sandboxes.assistant.command == jsondecode(data.fabric_harness.assistant_acquired.launch_json).command
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
      && keys(module.observed.starts) == ["assistant"]
      && module.observed.starts.assistant.command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "assistant", "--config", "-"]
      && module.observed.starts.assistant.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.openshell.fabric_starts[openshell_sandbox.assistant.id] == 1
      && index(module.observed.openshell.rpcs, "CreateProvider") < index(module.observed.openshell.rpcs, "CreateSandbox")
      && index(module.observed.openshell.rpcs, "CreateSandbox") < index(module.observed.openshell.rpcs, "ExecSandbox")
    )
    error_message = "The Fabric agent did not start in the sandbox with its compiled configuration."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "Configuring and starting the agent called the inference upstream."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "permit_teardown" {
  variables {
    permit_destroy = true
  }
}
