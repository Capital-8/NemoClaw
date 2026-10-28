# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

locals {
  owner                = "80a5b9c4-d5ad-40fd-8c94-85b04a9e26f8"
  gateway_name         = "nc-cb31e3c9b6871668-gateway"
  gateway_container_id = "fixture-gateway-container"
  gateway_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000001"
  sandbox_image        = "nc-fabric@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  sandbox_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000002"
  vllm_name            = "nc-cb31e3c9b6871668-inference-qwen"
  vllm_container_id    = "fixture-vllm-container"
  vllm_image           = "nc-prototype-vllm@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  vllm_image_id        = "sha256:0000000000000000000000000000000000000000000000000000000000000004"
  vllm_key             = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

# What the mocked Docker resources would have left on the engine: the pulled
# sandbox and vLLM images, the running gateway container, and the vLLM
# container, whose runtime reports ready after it started. The IDs match the
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
      labels = {
        "org.nemoclaw.backend"                  = "vllm"
        "org.nemoclaw.inference.authentication" = "bearer-v1"
        "org.nemoclaw.inference.routes"         = "openai-v2"
      }
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
      id      = local.vllm_container_id
      name    = local.vllm_name
      image   = local.vllm_image_id
      labels  = { "nemoclaw.nvidia.com/uid" = local.owner }
      running = true
      # OpenShell finds the service container by name for its credential.
      by_name    = true
      started_at = "2026-01-01T00:00:00Z"
      mounts = {
        "/data"        = "${local.vllm_name}-data"
        "/credentials" = "${local.vllm_name}-auth"
      }
      files = {
        "/data/status.json" = jsonencode({ phase = "ready", updated = "2026-01-01T00:00:05Z", detail = "serving", pid = 7 })
        # The bearer key the runtime generates in its credential volume.
        "/credentials/inference-key" = local.vllm_key
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
