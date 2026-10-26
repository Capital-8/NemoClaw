# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.8"
}

variable "context" {
  type = any
}

variable "targets" {
  type = any
  default = {
    assistant = {
      agent             = "assistant"
      request           = "Reply with one short sentence confirming that you can respond."
      response_contract = "openclaw"
    }
    researcher = {
      agent             = "researcher"
      request           = "Name one benefit of sandbox isolation in one short sentence."
      response_contract = "openclaw"
    }
  }
  validation {
    condition     = length(var.targets) > 0
    error_message = "The suite must select at least one verification target."
  }
}

module "target" {
  for_each          = var.targets
  source            = "../../verifier"
  context           = var.context
  target            = each.key
  agent             = each.value.agent
  request           = each.value.request
  response_contract = each.value.response_contract
}

output "targets" {
  value = module.target
}
