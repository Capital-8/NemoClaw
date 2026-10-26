# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.8"
}

resource "terraform_data" "probe" {
  provisioner "local-exec" {
    command     = "\"$NEMOCLAW_HCL_E2E\" probe"
    interpreter = ["/bin/sh", "-c"]
    environment = {
      NEMOCLAW_HCL_REPORT = "${path.cwd}/reports/${self.id}.json"
    }
  }
}

# The new resource ID is unknown until apply, so the file is read after the probe.
locals {
  report = jsondecode(file("${path.cwd}/reports/${terraform_data.probe.id}.json"))
}

output "health" {
  value = local.report.health
}

output "expected" {
  value = local.report.expected
}

output "response" {
  value = local.report.response
}
