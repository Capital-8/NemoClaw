# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

# OpenShell serves OpenShift with its Kubernetes driver.
data "fixture_gateway" "cluster" {
  compute_driver = "kubernetes"
}

# Both hosted endpoints answer nothing; configuration must not call them.
data "fixture_http" "inference" {}

data "fixture_observations" "deployed" {
  depends_on = [fabric_agent.assistant, fabric_agent.researcher]
}

locals {
  openshell = jsondecode(data.fixture_observations.deployed.openshell_json)
  engine    = jsondecode(data.fixture_observations.deployed.engine_json)
  upstream  = jsondecode(data.fixture_observations.deployed.http_json)

  registrations = { for provider in local.openshell.created_providers : provider.name => provider }
  sandboxes     = { for sandbox in local.openshell.created_sandboxes : sandbox.name => sandbox }
  starts        = { for exec in local.openshell.execs : exec.sandbox => exec }
  # Every binding the SDK compiled, by registration.
  bindings = {
    for binding in [
      openshell_inference.inference_hosted-01e6599f47b4bf91f2ab7aaa,
      openshell_inference.inference_nvidia-2cfb2cb09d105f40b4d93c7f,
      openshell_inference.inference_nvidia-d5ac1fe153c78e2f547d31a5,
    ] : binding.registration => binding
  }
  # The configurations Fabric received, decoded.
  started = { for sandbox, exec in local.starts : sandbox => jsondecode(exec.stdin) }
}
