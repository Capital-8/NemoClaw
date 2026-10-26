# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.8"
}

resource "terraform_data" "probe" {
  provisioner "local-exec" {
    command     = "\"$NEMOCLAW_HCL_E2E\" probe"
    interpreter = ["/bin/sh", "-c"]
    environment = {
      NEMOCLAW_HCL_REPORT = "${path.cwd}/reports/${self.id}.json"
    }
  }
}

# The new resource ID is unknown until apply, so the file is read after the probe.
locals {
  report = jsondecode(file("${path.cwd}/reports/${terraform_data.probe.id}.json"))
}

output "health" {
  value = merge(local.report.health, {
    binding_matches = (
      local.report.health.identity_matches &&
      local.report.health.agent_name == local.report.expected.agent_name
    )
  })
}

output "expected" {
  value = local.report.expected
}

output "response" {
  value = merge(local.report.response, {
    valid = (
      local.report.response.succeeded &&
      local.report.response.agent_name == local.report.expected.agent_name &&
      local.report.response.runtime_id == local.report.expected.runtime_id &&
      local.report.response.has_response_text
    )
  })
}
