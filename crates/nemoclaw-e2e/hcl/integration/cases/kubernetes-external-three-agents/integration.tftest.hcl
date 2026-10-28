# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A Kubernetes gateway uses no engine, so nothing is mocked.
provider "openshell" {}
provider "fabric" {}
provider "host" {}
provider "vllm" {}
provider "ollama" {}
provider "fixture" {}

# The SDK's teardown graph permits deletion; its apply graph does not.
provider "openshell" {
  alias   = "teardown"
  destroy = true
}

provider "fabric" {
  alias   = "teardown"
  destroy = true
}

# Declare the gateway and upstream before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  plan_options {
    target = [data.fixture_gateway.cluster, data.fixture_http.inference]
  }
}

run "deploy" {
  command = apply

  # The gateway reports the Kubernetes driver the document requires, and no
  # provider inspects an engine.
  assert {
    condition = (
      data.openshell_gateway.apply.compatible
      && data.openshell_gateway.apply.compute_drivers == toset(["kubernetes"])
      && data.openshell_gateway.apply.endpoint == data.fixture_gateway.cluster.endpoint
      && local.engine.requests == []
    )
    error_message = "The Kubernetes gateway was not found compatible, or a provider inspected an engine."
  }

  # Each harness comes from the metadata bundle, not an engine.
  assert {
    condition = alltrue([
      for sandbox, harness in local.harnesses :
      harness.available
      && harness.image == local.agent_image
      && harness.metadata_env == "NEMOCLAW_AGENT_IMAGE_METADATA"
      && harness.adapter_id == "nvidia.fabric.openclaw"
      && local.sandboxes[sandbox].command == jsondecode(harness.launch_json).command
    ])
    error_message = "An agent's harness was not read from the image metadata bundle."
  }

  # One registration holds the environment credential, and all three
  # sandboxes in the workspace name it and may reach only its endpoint.
  assert {
    condition = (
      length(local.openshell.created_providers) == 1
      && local.openshell.created_providers[0].name == openshell_inference.inference_inference-2c7590f4a674089b7cabb3e1.registration
      && local.openshell.created_providers[0].credentials == {
        (openshell_inference.inference_inference-2c7590f4a674089b7cabb3e1.sandbox_env) = "env:INFERENCE_API_KEY"
      }
      && keys(local.sandboxes) == keys(local.agents)
      && alltrue([
        for sandbox in values(local.sandboxes) :
        sandbox.workspace == openshell_workspace.deployment.name
        && sandbox.labels["nemoclaw.nvidia.com/uid"] == local.owner
        && sandbox.providers == [openshell_inference.inference_inference-2c7590f4a674089b7cabb3e1.registration]
        && sandbox.policy_endpoints == ["${trimprefix(data.fixture_http.inference.endpoint, "http://")}/v1/**"]
      ])
    )
    error_message = "The shared registration or a sandbox's binding or policy differs from the configuration."
  }

  # Fabric started each agent once in its own sandbox with its compiled configuration.
  assert {
    condition = (
      length(local.openshell.execs) == 3
      && alltrue([
        for sandbox, agent in local.agents :
        local.starts[sandbox].command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", agent, "--config", "-"]
        && jsondecode(local.starts[sandbox].stdin) == jsondecode(local.configurations[sandbox])
      ])
    )
    error_message = "An agent did not start in its own sandbox with its compiled configuration."
  }

  assert {
    condition     = local.upstream.requests == []
    error_message = "Configuring and starting the agents called the inference upstream."
  }
}

# OpenTofu removes a run's resources with the providers of the last run that
# applied them. This run changes nothing and permits that removal; the runner
# checks what remains afterward.
run "permit_teardown" {
  command = apply

  providers = {
    openshell = openshell.teardown
    fabric    = fabric.teardown
    host      = host
    vllm      = vllm
    ollama    = ollama
    fixture   = fixture
  }
}
