# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

run "live_integration" {
  command = apply

  assert {
    condition = (
      output.health.gateway_ready && output.health.sandbox_ready &&
      output.health.binding_matches && output.health.policy_loaded
    )
    error_message = "Required component health failed; inspect the private probe report."
  }

  assert {
    condition     = output.response.attempted && output.response.valid
    error_message = "Fabric invocation did not return a nonempty response from the expected agent/runtime."
  }
}
