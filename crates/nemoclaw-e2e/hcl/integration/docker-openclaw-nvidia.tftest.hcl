# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Rust binds the generated engine alias and content-addressed resource names.
# Only Docker operations are mocked; NVIDIA providers use loopback fixtures.
mock_provider "docker" {
  alias = "fixture"
  mock_resource "docker_image" {
    defaults = { image_id = "sha256:fixture-image" }
  }
  override_resource {
    target = docker_image.GATEWAY_PULL
    values = { image_id = "sha256:fixture-gateway-image" }
  }
  mock_resource "docker_container" {
    defaults = { id = "fixture-gateway-container" }
  }
}

run "docker_openclaw_hosted_inference" {
  command = apply
  providers = {
    DOCKER_ALIAS = docker.fixture
  }

  assert {
    condition = (
      docker_image.SANDBOX_PULL.keep_locally &&
      docker_image.SANDBOX_PULL.name == openshell_sandbox.assistant.image &&
      data.fabric_harness.assistant_acquired.image_id == docker_image.SANDBOX_PULL.image_id &&
      docker_container.managed_gateway_runtime.image == "sha256:fixture-gateway-image" &&
      docker_container.managed_gateway_runtime.must_run &&
      !docker_container.managed_gateway_runtime.remove_volumes &&
      docker_container.managed_gateway_runtime.entrypoint == data.openshell_docker_gateway_runtime.managed_gateway_runtime.entrypoint &&
      docker_container.managed_gateway_runtime.command == data.openshell_docker_gateway_runtime.managed_gateway_runtime.command &&
      docker_container.managed_gateway_runtime.env == toset(data.openshell_docker_gateway_runtime.managed_gateway_runtime.env) &&
      one(docker_container.managed_gateway_runtime.capabilities).drop == toset(["ALL"]) &&
      contains(docker_container.managed_gateway_runtime.security_opts, "no-new-privileges")
    )
    error_message = "The compiled Docker gateway must use the native launch contract and hardened Docker inputs."
  }
  assert {
    condition = (
      data.host_engine.current.available &&
      data.openshell_docker_gateway_readiness.current.ready &&
      openshell_inference.INFERENCE_RESOURCE.server.endpoint == fabric_agent.assistant.models.primary.base_url &&
      openshell_sandbox.assistant.providers[0].registration == openshell_inference.INFERENCE_RESOURCE.ref.registration &&
      openshell_sandbox.assistant.owner == local.workspace.owner &&
      openshell_sandbox.assistant.name == "assistant" &&
      length(one(openshell_sandbox.assistant.policy).managed) == 1
    )
    error_message = "The real OpenShell provider must bind the configured inference registration to the owned sandbox and policy."
  }
  assert {
    condition = (
      fabric_agent.assistant.sandbox == openshell_sandbox.assistant.ref &&
      fabric_agent.assistant.harness == data.fabric_harness.assistant_acquired.ref &&
      fabric_agent.assistant.name == "assistant" &&
      fabric_agent.assistant.models.primary.model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
    )
    error_message = "Fabric must consume OpenShell's sandbox identity and the selected OpenClaw model configuration."
  }
}
