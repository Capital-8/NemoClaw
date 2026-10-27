# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.9"
  required_providers {
    vllm = {
      source = "registry.opentofu.org/nvidia/vllm"
    }
  }
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    probe_executable = string
    evidence_dir     = string
  })
}
variable "targets" {
  type = any
  validation {
    condition     = length(var.targets) > 0
    error_message = "The verifier must select at least one target."
  }
}

variable "vllm_services" {
  type    = set(string)
  default = []
}

locals {
  deployment = length(var.vllm_services) > 0 ? jsondecode(file("${var.context.state_dir}/terraform.tfstate")) : null
  # Select SDK readiness bindings, rather than guessing container names.
  vllm_bindings = {
    for service in var.vllm_services : service => one([
      for resource in local.deployment.resources : one(resource.instances).attributes
      if resource.mode == "data" && resource.type == "vllm_readiness" &&
      resource.name == "inference_service_inference_${service}"
    ])
  }
}

data "vllm_readiness" "service" {
  for_each     = var.vllm_services
  engine       = local.vllm_bindings[each.key].engine
  name         = local.vllm_bindings[each.key].name
  container_id = local.vllm_bindings[each.key].container_id
  contract     = local.vllm_bindings[each.key].contract
  # Re-observe through the provider; never reuse the deployment's saved ready flag.
  read_trigger         = timestamp() != ""
  wait_timeout_seconds = 60
}

resource "terraform_data" "probe" {
  for_each   = var.targets
  depends_on = [data.vllm_readiness.service]
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
      NEMOCLAW_HCL_TARGET            = each.key
      NEMOCLAW_HCL_AGENT             = each.value.agent
      NEMOCLAW_HCL_RESPONSE_CONTRACT = each.value.response_contract
      NEMOCLAW_HCL_REQUEST_JSON      = jsonencode(each.value.request)
      NEMOCLAW_HCL_REQUEST           = "${var.context.evidence_dir}/${self.id}.request.json"
      NEMOCLAW_HCL_REPORT            = "${var.context.evidence_dir}/${self.id}.json"
    }
  }
}

# The new resource ID is unknown until apply, so the file is read after the probe.
locals {
  reports = {
    for name, probe in terraform_data.probe :
    name => jsondecode(file("${var.context.evidence_dir}/${probe.id}.json"))
  }
}

output "targets" {
  value = {
    for name, report in local.reports : name => {
      expected = report.expected
      health = merge(report.health, {
        binding_matches = (
          report.health.agent_name != null &&
          report.health.agent_name == report.expected.agent_name
        )
      })
      response = merge(report.response, {
        valid = (
          report.response.succeeded &&
          report.response.agent_name == report.expected.agent_name &&
          report.response.runtime_id == report.expected.runtime_id &&
          report.response.output_valid
        )
      })
    }
  }
}

output "vllm" {
  value = { for name, service in data.vllm_readiness.service : name => { ready = service.ready } }
}
