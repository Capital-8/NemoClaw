# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

run "openclaw_vllm" {
  command = apply

  module {
    source = "./components/vllm"
  }

  variables {
    vllm_services = ["qwen"]
    targets = {
      assistant = {
        agent             = "assistant"
        request           = "What is 2 plus 2? Answer in one short sentence. /no_think"
        response_contract = "openclaw"
      }
    }
  }

  assert {
    condition     = alltrue([for target in output.targets : target.response.attempted && target.response.valid])
    error_message = "outcome: ${join(", ", [for name, target in output.targets : name if !(target.response.attempted && target.response.valid)])}"
  }
}
