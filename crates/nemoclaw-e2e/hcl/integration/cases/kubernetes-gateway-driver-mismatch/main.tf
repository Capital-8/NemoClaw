# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture configuration and observations beside nemoclaw.tf.json, which the
# runner compiles from nemoclaw.yaml and which declares the fixture provider.

# The gateway runs Docker sandboxes, not the Kubernetes driver the document requires.
data "fixture_gateway" "wrong_driver" {
  compute_driver = "docker"
}

data "fixture_http" "inference" {}

# Read whenever planned: nothing in the deployment can be applied.
data "fixture_observations" "now" {}
