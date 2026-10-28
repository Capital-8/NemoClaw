# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

locals {
  owner                = "87d485ad-fba7-4197-9eaa-aa97cc97446b"
  gateway_name         = "nc-8bb56695710753e3-gateway"
  gateway_container_id = "fixture-gateway-container"
  gateway_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000001"
  sandbox_image        = "nc-fabric-owner-20260924@sha256:c4c0d3add3869e49d0ce8d03bd7e41bbe2682d0df285ef6fde5f181b123cf83e"
  sandbox_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000002"
  ollama_name          = "nc-8bb56695710753e3-ollama-ollama-server"
  ollama_container_id  = "fixture-ollama-container"
  ollama_image         = "nc-prototype-ollama@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ollama_image_id      = "sha256:0000000000000000000000000000000000000000000000000000000000000003"
  ollama_started_at    = "2026-01-01T00:00:00Z"
}

# What the mocked Docker resources would have left on the engine: the pulled
# sandbox and Ollama images, the running gateway container, and the Ollama
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
      reference = local.ollama_image
      id        = local.ollama_image_id
      labels    = { "org.nemoclaw.backend" = "ollama" }
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
      id         = local.ollama_container_id
      name       = local.ollama_name
      image      = local.ollama_image_id
      labels     = { "nemoclaw.nvidia.com/uid" = local.owner }
      running    = true
      started_at = local.ollama_started_at
      mounts     = { "/data" = "${local.ollama_name}-data" }
      files = {
        "/data/status.json" = jsonencode({ phase = "ready", updated = "2026-01-01T00:00:05Z" })
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
