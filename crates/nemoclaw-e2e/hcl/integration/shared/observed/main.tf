# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# What the fixtures recorded, read when the module is: give it depends_on the
# resources whose effects a case asserts.

terraform {
  required_providers {
    fixture = {
      source = "registry.opentofu.org/nvidia/fixture"
    }
  }
}

data "fixture_state" "now" {}

locals {
  observed = jsondecode(data.fixture_state.now.observations)
}

output "openshell" {
  description = "RPCs, created registrations and sandboxes, execs, Fabric starts, and workspaces."
  value       = local.observed.openshell
}

output "engine" {
  description = "Endpoint, requests, and volumes."
  value       = local.observed.engine
}

output "http" {
  description = "The inference upstream's endpoint and requests."
  value       = local.observed.http
}

output "registrations" {
  value = { for provider in local.observed.openshell.created_providers : provider.name => provider }
}

output "sandboxes" {
  value = { for sandbox in local.observed.openshell.created_sandboxes : sandbox.name => sandbox }
}

output "starts" {
  description = "Each sandbox's Fabric exec, with its decoded configuration."
  value = {
    for exec in local.observed.openshell.execs :
    exec.sandbox => merge(exec, { configuration = jsondecode(exec.stdin) })
  }
}
