# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixtures for nemoclaw.tf.json, which the runner compiles from nemoclaw.yaml.

module "docker" {
  source   = "../../shared/docker"
  document = "${path.module}/nemoclaw.yaml"
}

data "fixture_state" "setup" {
  declare = module.docker.declare
}

module "observed" {
  source     = "../../shared/observed"
  depends_on = [fabric_agent.assistant]
}
