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

provider "vllm" {}

variable "context" {
  type = any
}

variable "targets" {
  type = any
  default = {
    assistant = {
      agent             = "assistant"
      request           = "What is 2 plus 2? Answer in one short sentence."
      response_contract = "openclaw"
    }
  }
  validation {
    condition     = length(var.targets) > 0
    error_message = "The suite must select at least one verification target."
  }
}

module "vllm" {
  source  = "../../probes/vllm"
  context = var.context
  service = "qwen"
}

module "target" {
  for_each          = var.targets
  source            = "../../verifier"
  context           = var.context
  target            = each.key
  agent             = each.value.agent
  request           = each.value.request
  response_contract = each.value.response_contract
  depends_on        = [module.vllm]
}

output "vllm" {
  value = module.vllm
}

output "targets" {
  value = module.target
}
