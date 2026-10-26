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

module "verifier" {
  source        = "../../verifier"
  context       = var.context
  targets       = var.targets
  vllm_services = ["qwen"]
}

output "vllm" {
  value = module.verifier.vllm
}

output "targets" {
  value = module.verifier.targets
}
