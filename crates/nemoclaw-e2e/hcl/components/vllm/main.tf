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

provider "vllm" {}

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
}

variable "vllm_services" {
  type = set(string)
}

locals {
  deployment = jsondecode(file("${var.context.state_dir}/terraform.tfstate"))
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

module "verifier" {
  source     = "../../verifier"
  context    = var.context
  targets    = var.targets
  depends_on = [data.vllm_readiness.service]
}

output "targets" {
  value = module.verifier.targets
}

output "vllm" {
  value = { for name, service in data.vllm_readiness.service : name => { ready = service.ready } }
}
