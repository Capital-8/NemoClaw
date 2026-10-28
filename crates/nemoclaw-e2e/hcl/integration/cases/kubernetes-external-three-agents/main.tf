# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

locals {
  owner = "785e7cc0-d2c1-4847-aede-a9b0ba2b8d83"
  # The runner's metadata bundle describes this image and its Fabric catalog.
  agent_image = "fixture/agent@sha256:e5dee78a2d23235e73acb1f7aa4cba799df73c1a149f730b4ce0ebb598358d32"
  agents      = { assistant = "main", researcher = "researcher", reviewer = "reviewer" }
}

# OpenShell runs its Kubernetes driver.
data "fixture_gateway" "cluster" {
  compute_driver = "kubernetes"
}

# The hosted endpoint answers nothing; configuration must not call it.
data "fixture_http" "inference" {}

data "fixture_observations" "deployed" {
  depends_on = [fabric_agent.assistant, fabric_agent.researcher, fabric_agent.reviewer]
}

locals {
  openshell = jsondecode(data.fixture_observations.deployed.openshell_json)
  engine    = jsondecode(data.fixture_observations.deployed.engine_json)
  upstream  = jsondecode(data.fixture_observations.deployed.http_json)

  sandboxes = { for sandbox in local.openshell.created_sandboxes : sandbox.name => sandbox }
  starts    = { for exec in local.openshell.execs : exec.sandbox => exec }
  harnesses = {
    assistant  = data.fabric_harness.assistant
    researcher = data.fabric_harness.researcher
    reviewer   = data.fabric_harness.reviewer
  }
  configurations = {
    assistant  = terraform_data.agent_assistant.input
    researcher = terraform_data.agent_researcher.input
    reviewer   = terraform_data.agent_reviewer.input
  }
}
