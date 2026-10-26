# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.8"
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    probe_executable = string
    evidence_dir     = string
  })
}
variable "target" { type = string }
variable "agent" { type = string }
variable "request" { type = any }
variable "response_contract" { type = string }

resource "terraform_data" "probe" {
  # Every test apply recollects observations, including repeated identical scenarios.
  triggers_replace = uuid()
  provisioner "local-exec" {
    command     = <<-EOT
      set -eu
      printf '%s' "$NEMOCLAW_HCL_REQUEST_JSON" > "$NEMOCLAW_HCL_REQUEST"
      "$NEMOCLAW_HCL_E2E" probe \
        --config "$NEMOCLAW_HCL_CONFIG" \
        --state-dir "$NEMOCLAW_HCL_STATE" \
        --target "$NEMOCLAW_HCL_TARGET" \
        --agent "$NEMOCLAW_HCL_AGENT" \
        --request "$NEMOCLAW_HCL_REQUEST" \
        --response-contract "$NEMOCLAW_HCL_RESPONSE_CONTRACT" \
        --report "$NEMOCLAW_HCL_REPORT"
    EOT
    interpreter = ["/bin/sh", "-c"]
    environment = {
      NEMOCLAW_HCL_E2E               = var.context.probe_executable
      NEMOCLAW_HCL_CONFIG            = var.context.config
      NEMOCLAW_HCL_STATE             = var.context.state_dir
      NEMOCLAW_HCL_TARGET            = var.target
      NEMOCLAW_HCL_AGENT             = var.agent
      NEMOCLAW_HCL_RESPONSE_CONTRACT = var.response_contract
      NEMOCLAW_HCL_REQUEST_JSON      = jsonencode(var.request)
      NEMOCLAW_HCL_REQUEST           = "${var.context.evidence_dir}/${self.id}.request.json"
      NEMOCLAW_HCL_REPORT            = "${var.context.evidence_dir}/${self.id}.json"
    }
  }
}

# The new resource ID is unknown until apply, so the file is read after the probe.
locals {
  report = jsondecode(file("${var.context.evidence_dir}/${terraform_data.probe.id}.json"))
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
