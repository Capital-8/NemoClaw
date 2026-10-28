# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

locals {
  owner                = "1f7c3a9e-6b2d-4e8f-a0c5-9d3b7e1f2a64"
  gateway_name         = "nc-47267cc6ed54e5f9-gateway"
  gateway_container_id = "fixture-gateway-container"
  gateway_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000001"
  sandbox_image        = "nc-fabric@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  sandbox_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000002"
  vllm_name            = "nc-47267cc6ed54e5f9-inference-qwen"
  vllm_container_id    = "fixture-vllm-container"
  vllm_image           = "nc-prototype-vllm@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  vllm_image_id        = "sha256:0000000000000000000000000000000000000000000000000000000000000004"
}

# What the mocked Docker resources would have left on the engine: the pulled
# sandbox and vLLM images, the running gateway container, and the vLLM
# container, whose runtime reports ready after it started and holds no key. The IDs match the
# values the test file gives the mocked resources.
data "fixture_engine" "docker" {
  images_json = jsonencode([
    {
      reference      = local.sandbox_image
      id             = local.sandbox_image_id
      fabric_catalog = true
    },
    {
      reference = local.vllm_image
      id        = local.vllm_image_id
      labels    = { "org.nemoclaw.backend" = "vllm" }
    },
  ])
  containers_json = jsonencode([
    {
      id      = local.gateway_container_id
      name    = local.gateway_name
      image   = local.gateway_image_id
      labels  = { "nemoclaw.nvidia.com/uid" = local.owner }
      running = true
    },
    {
      id         = local.vllm_container_id
      name       = local.vllm_name
      image      = local.vllm_image_id
      labels     = { "nemoclaw.nvidia.com/uid" = local.owner }
      running    = true
      started_at = "2026-01-01T00:00:00Z"
      mounts     = { "/data" = "${local.vllm_name}-data" }
      files = {
        "/data/status.json" = jsonencode({ phase = "ready", updated = "2026-01-01T00:00:05Z", detail = "serving", pid = 7 })
      }
    },
  ])
}

# No hosted provider: nothing may call the inference upstream.
data "fixture_http" "inference" {}

data "fixture_observations" "deployed" {
  depends_on = [fabric_agent.assistant]
}

locals {
  openshell = jsondecode(data.fixture_observations.deployed.openshell_json)
  engine    = jsondecode(data.fixture_observations.deployed.engine_json)
  upstream  = jsondecode(data.fixture_observations.deployed.http_json)
}
