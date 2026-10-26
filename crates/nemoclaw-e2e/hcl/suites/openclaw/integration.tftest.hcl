# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

run "agents_answer" {
  command = apply

  assert {
    condition     = alltrue([for target in output.targets : target.health.gateway_ready])
    error_message = "gateway: ${join(", ", [for name, target in output.targets : name if !target.health.gateway_ready])}"
  }

  assert {
    condition     = alltrue([for target in output.targets : target.health.identity_matches && target.health.sandbox_ready])
    error_message = "sandbox: ${join(", ", [for name, target in output.targets : name if !(target.health.identity_matches && target.health.sandbox_ready)])}"
  }

  assert {
    condition     = alltrue([for target in output.targets : target.health.binding_matches])
    error_message = "binding: ${join(", ", [for name, target in output.targets : name if !target.health.binding_matches])}"
  }

  assert {
    condition     = alltrue([for target in output.targets : target.health.policy_loaded])
    error_message = "policy: ${join(", ", [for name, target in output.targets : name if !target.health.policy_loaded])}"
  }

  assert {
    condition     = alltrue([for target in output.targets : target.response.attempted && target.response.valid])
    error_message = "invocation: ${join(", ", [for name, target in output.targets : name if !(target.response.attempted && target.response.valid)])}"
  }
}
