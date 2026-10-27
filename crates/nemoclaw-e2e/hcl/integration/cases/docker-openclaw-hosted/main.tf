# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

locals {
  owner                = "4ab96c36-f96c-4f58-9e14-a97e0b3c4269"
  gateway_name         = "nc-40c03413ee4368cb-gateway"
  gateway_container_id = "fixture-gateway-container"
  gateway_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000001"
  sandbox_image        = "nc-fabric-owner-20260924@sha256:c4c0d3add3869e49d0ce8d03bd7e41bbe2682d0df285ef6fde5f181b123cf83e"
  sandbox_image_id     = "sha256:0000000000000000000000000000000000000000000000000000000000000002"
}

# What the mocked Docker resources would have left on the engine: the pulled
# sandbox image with its Fabric catalog, and the running gateway container.
# The IDs match the values the test file gives the mocked resources.
data "fixture_engine" "docker" {
  images_json = jsonencode([{
    reference      = local.sandbox_image
    id             = local.sandbox_image_id
    fabric_catalog = true
  }])
  containers_json = jsonencode([{
    id      = local.gateway_container_id
    name    = local.gateway_name
    image   = local.gateway_image_id
    labels  = { "nemoclaw.nvidia.com/uid" = local.owner }
    running = true
  }])
}

# The inference upstream answers nothing; configuration must not call it.
data "fixture_http" "inference" {}

data "fixture_observations" "deployed" {
  depends_on = [fabric_agent.assistant]
}

locals {
  openshell = jsondecode(data.fixture_observations.deployed.openshell_json)
  engine    = jsondecode(data.fixture_observations.deployed.engine_json)
  upstream  = jsondecode(data.fixture_observations.deployed.http_json)
}
