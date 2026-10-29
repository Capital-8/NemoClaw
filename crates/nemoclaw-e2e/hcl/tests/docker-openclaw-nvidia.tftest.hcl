# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

run "openclaw_hosted" {
  command = apply

  module {
    source = "./verifier"
  }

  variables {
    targets = {
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
  }

  assert {
    condition     = alltrue([for target in output.targets : target.response.attempted && target.response.valid])
    error_message = "outcome: ${join(", ", [for name, target in output.targets : name if !(target.response.attempted && target.response.valid)])}"
  }
}
