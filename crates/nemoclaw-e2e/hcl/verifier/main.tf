# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.8"
}

resource "terraform_data" "probe" {
  provisioner "local-exec" {
    command     = <<-EOT
      "$NEMOCLAW_HCL_E2E" probe \
        --config "$NEMOCLAW_HCL_CONFIG" \
        --state-dir "$NEMOCLAW_HCL_STATE" \
        --agent "$NEMOCLAW_HCL_AGENT" \
        --request "$NEMOCLAW_HCL_REQUEST" \
        --response-contract "$NEMOCLAW_HCL_RESPONSE_CONTRACT" \
        --report "$NEMOCLAW_HCL_REPORT"
    EOT
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
      local.report.health.agent_name != null &&
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
      local.report.response.output_valid
    )
  })
}
