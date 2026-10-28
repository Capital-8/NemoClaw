# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixtures for nemoclaw.tf.json, which the runner compiles from nemoclaw.yaml.

# The gateway reports Docker while the document requires Kubernetes.
data "fixture_state" "setup" {
  declare = jsonencode({ compute_driver = "docker" })
}

# Read at plan time: nothing is applied in this case.
data "fixture_state" "now" {}
