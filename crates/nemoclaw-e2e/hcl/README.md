<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# HCL E2E proof of concept

One opt-in case deploys Docker + OpenClaw + NVIDIA hosted inference.
It uses the candidate bundle's public NemoClaw CLI and existing
[Fabric invocation bridge](../../fabric-provider/src/bridge.rs).
Runner provisioning, other runtimes, export/reapply, model quality, and GPU qualification are outside this POC.

The case contains ordinary v1 deployment configuration and a text request.
Runtime, harness, inference endpoint, model, and credential reference come from that configuration.
The POC rejects combinations outside its scope before deployment.

~~~mermaid
flowchart LR
    subgraph input["1. Case input"]
        YAML["YAML<br/>Deployment combination + request"]
    end
    subgraph deployment["2. Deployment lifecycle — product state"]
        Apply["nemoclaw plan → apply"]
        Cleanup["nemoclaw destroy + verify cleanup"]
    end
    subgraph verification["3. Shared verification — tofu test, separate state"]
        Probe["Shared probe<br/>SDK/provider health observations + Fabric invoke"]
        Report["Observation JSON → HCL outputs"]
        Assert["HCL assertions<br/>Compare observations with expectations"]
        Probe --> Report --> Assert
    end
    YAML --> Apply -->|"tofu test starts probe"| Probe
    verification -->|"pass or fail"| Cleanup
    Apply -.->|"partial apply or cancellation"| Cleanup
~~~

The execution flow is case YAML → plan/apply → shared probe → HCL assertions → cleanup.
The probe writes observations; the verifier module exposes them as outputs.
HCL compares those observations with the expected agent and runtime from the resolved deployment.

## Run the live case

Use a Linux Docker host, a candidate bundle from the tested commit, and its required images.
The Docker CLI must be on PATH.
The case uses the local engine at unix:///var/run/docker.sock.
Provide NVIDIA_INFERENCE_API_KEY through the caller's secret environment; do not put its value in YAML or arguments.

Build the helper from the same checkout as the candidate bundle:

~~~sh
cargo build --locked -p nemoclaw-e2e --bin nemoclaw-hcl-e2e
target/debug/nemoclaw-hcl-e2e run \
  --case crates/nemoclaw-e2e/hcl/cases/docker-openclaw-nvidia.yaml \
  --bundle /absolute/path/to/candidate/bundle \
  --candidate-revision FULL_40_HEX_COMMIT \
  --run-dir /absolute/path/to/new-private-run
~~~

The parent of the run directory must exist. The run directory itself must not exist.
Each run allocates a fresh deployment UUID and loopback gateway endpoint.
The checked-in UUID is a template, never the identity used for deployment.
Supply the full lowercase source commit used to build both the helper and bundle.
The helper records this caller-selected revision in case.json before deployment and in result.json.
Bundle integrity is checked against its file manifest.

The helper runs these stages:

1. Resolve and validate the case and candidate revision.
   Write the resolved deployment, request, and case identity into a private directory.
2. Run nemoclaw plan and nemoclaw apply with noninteractive JSON output.
3. Initialize a separate verifier directory and run tofu test.
4. Let the verifier's apply-time local-exec resource run the same helper in probe mode.
5. Collect SDK/provider observations and invoke the agent once through AgentBridge::invoke_agent.
   Write the observation JSON, expose it as verifier outputs, and evaluate the HCL assertions.
6. Run nemoclaw destroy after every started apply, including partial failures and cancellation.
7. Verify final state and Docker workload absence. Write the combined test/cleanup outcome.

Each subprocess has a ten-minute deadline.
SIGINT and SIGTERM cancel the active process group before cleanup starts.
Cleanup uses a fresh cancellation token. Failed cleanup makes the run fail without replacing the original test failure.
SIGKILL, host loss, and an unavailable Docker engine can prevent cleanup; the retained state supports recovery.

## Assertion and state boundaries

[The shared HCL file](verifier/integration.tftest.hcl) owns two live assertions:

- Required gateway/sandbox readiness, expected Fabric binding, and loaded policy.
- A successful Fabric response from the expected agent/runtime, containing nonempty OpenClaw response text.

Health probes reuse OpenShell capability, sandbox observation, identity, and readiness operations.
The report records readiness, identity verification, the observed agent binding, and policy presence.
Response observations include success, agent/runtime metadata, and whether the adapter returned nonempty text.
The probe records these facts without collapsing them into a final response verdict.
HCL owns the binding comparisons and health/response expectations.
The verifier derives health.binding_matches and response.valid in HCL from these observations.
The shared assertions use those outputs, preserving the proposal's HCL interface.
The probe requires a ready, correctly bound sandbox with a loaded policy before invoking it.
Fabric does not expose an independent runtime-status API at the pinned version.
Binding validation therefore does not claim that an agent process is healthy; the real invocation proves it responds.
The response check follows the pinned OpenClaw adapter's output.response contract.
It does not assert exact generated wording or benchmark model quality.

The verifier uses only the built-in terraform_data resource.
Its newly allocated resource ID determines the report filename.
That ID stays unknown during planning, so file evaluation waits for the apply-time probe.
Invocation never runs from a refresh-time data source, and ambiguous invocations are never retried.

The directories have separate owners:

- deployment/ contains NemoClaw's generated graph and product state.
- verifier/ contains the fixed verifier module, temporary test state, and probe reports.

OpenTofu's test cleanup owns only its verifier resource.
Only nemoclaw destroy owns product teardown.
Ambient OpenTofu argument and state overrides are removed from child commands.
The verifier receives an explicit environment without the hosted inference credential.

## Extend the shared flow

This POC permits only the checked-in Docker + OpenClaw + NVIDIA-hosted combination.
Broader support must extend this harness and its supported-case validation.
It must preserve the same deployment, observation, assertion, evidence, and cleanup flow.
The proposed combination/profile resolver is represented here by a case wrapper containing
deployment and request. Only deployment is passed to NemoClaw; test-only fields stay in the harness.
Profile resolution, runner scheduling, and multiple requests/suites are deferred.

- A new case within supported component interfaces should usually need only case YAML changes.
- A new runtime or agent interface may need a probe/cleanup adapter or response normalizer.
- A different test behavior may need additional HCL assertions against shared verifier outputs.

Runner provisioning and runtime expansion remain outside this POC.

## Evidence and cleanup

The run directory is created with mode 0700 on Unix.
It retains case.json, result.json, resolved inputs, command stdout/stderr, HCL JSON output,
probe observations, and private Fabric diagnostics.
Backend messages, requests, and response text are excluded from the normalized probe report.
Agent names and runtime IDs remain available for HCL binding assertions.
Raw command logs and Fabric diagnostics remain private; do not upload the complete run directory.

Probe failures identify the observation phase and preserve unknown attribution.
A failed Fabric invoke does not establish a Fabric defect.
The case result records the original failed phase and a separate cleanup outcome.

Cleanup checks the destroy result, remaining managed state, and Docker containers/volumes
selected by this run's fresh deployment UID or sandbox namespace.
It preserves NemoClaw's intentional gateway-storage retention and reports that resource explicitly.
It does not remove shared resources, unrelated deployments, or retained gateway data.

If cleanup fails, inspect the private evidence and recover using the same bundle and state:

~~~sh
/absolute/path/to/candidate/bundle/bin/nemoclaw destroy \
  --bundle /absolute/path/to/candidate/bundle \
  --state-dir /absolute/path/to/new-private-run/deployment \
  --output json
~~~

Do not start another test in the existing run directory.

## Validation and live evidence

Run focused harness tests:

~~~sh
cargo test --locked -p nemoclaw-e2e --bin nemoclaw-hcl-e2e
~~~

The ignored HCL contract test runs the actual pinned OpenTofu with fixture observations:

~~~sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/candidate/bundle \
  cargo test --locked -p nemoclaw-e2e --bin nemoclaw-hcl-e2e \
  shared_hcl_assertions -- --ignored
~~~

Alternatively, set NEMOCLAW_HCL_TOFU to an absolute pinned OpenTofu executable.
The lifecycle nextest profile selects this contract test.
It proves that healthy observations pass, failed health/response observations and mismatched bindings fail,
and verifier execution leaves product state unchanged.
It does not deploy Docker workloads or call hosted inference.

The fast tests own case validation, response classification, state-directory isolation,
partial-apply failure, cancellation, and preservation of original failures during cleanup.
A gateway-fixture test exercises the actual health/Fabric probe and blocks invocation after a binding mismatch.
The canonical live owner is the single YAML case run through the helper above.
Its distinct boundary is real deployment-to-Fabric-to-hosted-inference integration evaluated by HCL.
A passing fixture contract test does not establish a passing live E2E case.
