<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Shared HCL integration verifier

Deployment YAML → nemoclaw plan/apply → shared SDK/provider probe → HCL assertions → evidence and nemoclaw destroy.
The Docker + OpenClaw + NVIDIA hosted inference case is the initial example.
Other runtimes and agents require qualification; accepting their configuration does not establish support.
Runner provisioning remains outside this POC.

~~~mermaid
flowchart LR
    subgraph input["1. Case input"]
        YAML["Deployment YAML + target agent + request"]
    end
    subgraph deployment["2. Execution wrapper — product state"]
        Apply["nemoclaw plan → apply"]
        Cleanup["evidence + nemoclaw destroy"]
    end
    subgraph verification["3. Shared verifier — separate test state"]
        Probe["SDK/provider probe"]
        Report["Observation JSON → HCL outputs"]
        Assert["Five HCL assertions"]
        Probe --> Report --> Assert
    end
    YAML --> Apply -->|"tofu test"| Probe
    verification -->|"pass or fail"| Cleanup
    Apply -.->|"partial apply or cancellation"| Cleanup
~~~

## Verification boundary

[The probe](../src/bin/nemoclaw-hcl-e2e/probe.rs) reads deployment bindings and calls existing component APIs.
It does not select a container engine or inference endpoint.
[The HCL suite](verifier/integration.tftest.hcl) has one assertion per contract:

| Contract | Existing implementation | HCL output |
| --- | --- | --- |
| Gateway capabilities | OpenShell::verify_gateway | health.gateway_ready |
| Sandbox identity and readiness | observe, verify_identity, sandbox_phase | health.identity_matches, health.sandbox_ready |
| Expected Fabric agent binding | fabric_binding and HCL comparison | health.binding_matches |
| Policy presence | Observed sandbox policy hash | health.policy_loaded |
| Agent responds through Fabric | AgentBridge::invoke_agent and selected response contract | response.attempted, response.valid |

The verifier derives binding_matches and valid in HCL from observations and the expected agent/runtime.
The probe requires a ready, correctly bound sandbox with a loaded policy before invoking it once.
Readiness has a 60-second deadline. Invocation reuses the production bridge's deadline and is never retried.
Policy presence does not establish policy enforcement.
Fabric has no independent runtime-health API at the pinned version; invocation establishes responsiveness.

[Response normalization](../src/bin/nemoclaw-hcl-e2e/response.rs) is explicit:

- fabric reuses the existing successful_invocation envelope contract and allows adapter-owned output shapes.
- openclaw additionally requires nonempty output.response text, following that adapter's contract.

The example selects openclaw. This does not claim that every agent returns that payload shape.
The shared assertions do not check exact generated wording or model quality.
A different agent interface may require a response adapter, while retaining the five contracts.

The probe is also usable without the execution wrapper, against an existing deployment:

~~~sh
target/debug/nemoclaw-hcl-e2e probe \
  --config /absolute/path/to/deployment.yaml \
  --state-dir /absolute/path/to/deployment-state \
  --agent assistant --request /absolute/path/to/request.json \
  --response-contract openclaw --report /absolute/path/to/new-report.json
~~~

## Case and execution wrapper

The case contains id, ordinary deployment configuration, agent, request, and responseContract.
Agent selects the configured agent name, rather than the first sandbox.
Request accepts non-null JSON; the agent owns its input schema.
The SDK validates deployment configuration without additional runtime, agent, service, or endpoint restrictions.
Only deployment configuration reaches the product CLI.

[The wrapper](../src/bin/nemoclaw-hcl-e2e/wrapper.rs) supplies lifecycle handling:

1. Create a private run directory, allocate a fresh deployment UUID, and record the candidate revision and resolved inputs.
2. Run the candidate bundle's nemoclaw plan and apply.
3. Run tofu init/test in a separate verifier directory. Its apply-time terraform_data resource calls the shared probe and exposes the report as outputs.
4. Preserve probe/HCL evidence, then run nemoclaw destroy after every started apply, including failure and cancellation.
5. Check the product's Destroyed outcome and record retention and cleanup failure separately from the original failure.

Each subprocess has a ten-minute deadline. SIGINT/SIGTERM stop the active process group before cleanup uses a fresh cancellation token.
The wrapper delegates resource teardown to NemoClaw.
Docker inventory checks remain in runtime qualification, including [managed gateway](../tests/managed_gateway.rs) and [sandbox lifecycle](../tests/dummy_agent.rs) tests.
They do not belong to the shared verifier.

Product state lives in deployment/; OpenTofu test state and reports live in verifier/.
OpenTofu test cleanup owns only its verifier resource. It never destroys the product graph.
Ambient TF/TOFU overrides are removed. The verifier receives explicit paths and configured gateway-access references, without inheriting the caller's inference credentials.
The report filename uses the new resource ID, so reading it waits for the apply-time probe and cannot reuse a stale report.

## Run the example

Use a Linux Docker host and a candidate bundle from the same commit as the helper.
Reserve the gateway endpoint configured in the YAML; the wrapper preserves it.
Provide NVIDIA_INFERENCE_API_KEY through the caller's environment, never through YAML or arguments.

~~~sh
cargo build --locked -p nemoclaw-e2e --bin nemoclaw-hcl-e2e
target/debug/nemoclaw-hcl-e2e run \
  --case crates/nemoclaw-e2e/hcl/cases/docker-openclaw-nvidia.yaml \
  --bundle /absolute/path/to/candidate/bundle \
  --candidate-revision FULL_40_HEX_COMMIT \
  --run-dir /absolute/path/to/new-private-run
~~~

The run directory must not exist; its parent must exist. Unix permissions are 0700.
It retains case.json, result.json, resolved inputs, command logs, HCL JSON, probe reports, and private Fabric diagnostics.
The caller-selected candidate revision identifies the source used to build the helper and bundle; bundle integrity is verified against its manifest.
Normalized reports omit raw backend messages, prompts, and response text. Raw diagnostics remain private; do not upload the whole directory.
Failures record their observation phase and preserve unknown attribution rather than assigning an upstream defect without evidence.

NemoClaw may intentionally retain gateway storage; the result reports that retention.
SIGKILL, host loss, or unavailable infrastructure can prevent cleanup. Retained state supports recovery with the same bundle:

~~~sh
/absolute/path/to/candidate/bundle/bin/nemoclaw destroy \
  --bundle /absolute/path/to/candidate/bundle \
  --state-dir /absolute/path/to/run/deployment --output json
~~~

## Validation

~~~sh
cargo test --locked -p nemoclaw-e2e --bin nemoclaw-hcl-e2e
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/candidate/bundle \
  cargo test --locked -p nemoclaw-e2e --bin nemoclaw-hcl-e2e \
  shared_hcl_assertions -- --ignored
~~~

Alternatively, set NEMOCLAW_HCL_TOFU to the pinned OpenTofu executable.
The lifecycle profile selects this ignored contract test. Its fixture reports prove all five HCL failure categories and state separation without deploying workloads or invoking inference.
Fast tests cover SDK-valid inputs, target selection, response adapters, partial apply, cancellation, and cleanup-failure preservation.
The canonical live case is the single YAML example through the wrapper above: real deployment-to-Fabric-to-hosted-inference integration.
Fixture and HCL contract passes do not establish a passing live case or qualification of another runtime/agent combination.
