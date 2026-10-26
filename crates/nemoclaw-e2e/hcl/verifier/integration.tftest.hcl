# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

run "live_integration" {
  command = apply

  assert {
    condition     = output.health.gateway_ready
    error_message = "gateway: OpenShell capabilities were not observed; inspect probe evidence."
  }

  assert {
    condition     = output.health.identity_matches && output.health.sandbox_ready
    error_message = "sandbox: expected identity and readiness were not observed; inspect probe evidence."
  }

  assert {
    condition     = output.health.binding_matches
    error_message = "binding: the observed Fabric agent does not match the target agent."
  }

  assert {
    condition     = output.health.policy_loaded
    error_message = "policy: a loaded sandbox policy was not observed."
  }

  assert {
    condition = (
      output.response.attempted && output.response.valid
    )
    error_message = "invocation: Fabric did not return a successful response matching the target agent/runtime and selected response contract."
  }
}
