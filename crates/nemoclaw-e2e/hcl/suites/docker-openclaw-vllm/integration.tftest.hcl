# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

run "agents_answer" {
  command = apply

  assert {
    condition     = alltrue([for target in output.targets : target.response.attempted && target.response.valid])
    error_message = "outcome: ${join(", ", [for name, target in output.targets : name if !(target.response.attempted && target.response.valid)])}"
  }
}
