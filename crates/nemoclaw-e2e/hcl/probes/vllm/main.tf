# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.8"
  required_providers {
    vllm = {
      source = "registry.opentofu.org/nvidia/vllm"
    }
  }
}

variable "context" {
  type = object({ state_dir = string })
}

variable "service" {
  type = string
}

locals {
  deployment = jsondecode(file("${var.context.state_dir}/terraform.tfstate"))
  # This is the SDK's managed-service readiness address, not a container name.
  binding = one([
    for resource in local.deployment.resources : one(resource.instances).attributes
    if resource.mode == "data" && resource.type == "vllm_readiness" &&
    resource.name == "inference_service_inference_${var.service}"
  ])
}

data "vllm_readiness" "service" {
  engine       = local.binding.engine
  name         = local.binding.name
  container_id = local.binding.container_id
  contract     = local.binding.contract
  # Re-observe through the provider; never reuse the deployment's saved ready flag.
  read_trigger         = timestamp() != ""
  wait_timeout_seconds = 60
}

output "ready" {
  value = data.vllm_readiness.service.ready
}
