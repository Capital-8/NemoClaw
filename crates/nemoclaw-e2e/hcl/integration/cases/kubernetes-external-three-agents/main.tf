# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixtures for nemoclaw.tf.json, which the runner compiles from nemoclaw.yaml.

# OpenShell runs its Kubernetes driver.
data "fixture_state" "setup" {
  declare = jsonencode({ compute_driver = "kubernetes" })
}

module "observed" {
  source     = "../../shared/observed"
  depends_on = [fabric_agent.assistant, fabric_agent.researcher, fabric_agent.reviewer]
}
