<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station v1 Example Smoke

This smoke applies an example on an owned Linux ARM64 DGX Station VM.
It checks that the managed gateway, vLLM service, sandbox, and supervisor containers are running.
Docker health checks, when present, must report healthy.
Apply also performs the product's service and agent readiness checks.
The smoke requests no inference.

The initial input is `examples/gtc-dc/openclaw-dgx-station.yaml`.
The extension is `.yaml`, not `.yml`.
The smoke accepts another example with one managed Docker gateway, one Station vLLM service, and one OpenClaw sandbox.
It copies the configuration into a new private run directory, assigns a fresh deployment UID, and substitutes two built image references.
The source example remains unchanged, including its ports, subnet, model, and serving settings.
Use a dedicated VM with those ports, subnet, and GPU capacity available.

## Run on the VM

The operator supplies the lease, [build prerequisites](../../docs/build.md), Docker Buildx, NVIDIA GPU access, and sufficient disk for the model and build caches.
The Station template requires an ARM64 GB300 and driver major 580 or newer.
No jump server or SSH transport is part of this test.

Build from the candidate checkout on the Station:

```sh
cargo ci tools
export PROTOC="$PWD/.tools/protoc-36.2/bin/protoc"
cargo run --locked -p nemoclaw-build -- bundle --platform linux_arm64
docker buildx bake vllm
cargo images build --platform linux/arm64 openclaw
docker image inspect nc-prototype-vllm:rust-v1 nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
```

Supply the two resulting immutable references; both must exist on the local Docker daemon.
Choose a run directory that does not exist:

```sh
export NEMOCLAW_TEST_BUNDLE="$PWD/dist/linux_arm64"
export NEMOCLAW_LIVE_STATION_EXAMPLE="$PWD/examples/gtc-dc/openclaw-dgx-station.yaml"
export NEMOCLAW_LIVE_STATION_RUN=/absolute/private/path/to/new-run
export NEMOCLAW_LIVE_STATION_AGENT_IMAGE=nc-fabric@sha256:REPLACE_WITH_BUILD_DIGEST
export NEMOCLAW_LIVE_STATION_MODEL_IMAGE=nc-prototype-vllm@sha256:REPLACE_WITH_BUILD_DIGEST
cargo test --locked -p nemoclaw-e2e --test station \
  station_example_components_are_running -- --ignored --exact --nocapture
```

The test attempts `nemoclaw destroy` after both successful and failed apply or observation.
Teardown failure fails the test.
Destroy retains model caches, gateway storage, credentials, and deployment state under the product's retention rules.
Keep the private run directory for recovery; do not upload its configuration or state.
The backend must remove its remaining owned resources and verify cleanup before releasing the lease lock.
An interrupted test needs the same backend cleanup; a killed process cannot guarantee teardown.
Use [retained-resource removal](../../docs/usage.md#remove-retained-resources) for manual cleanup.

## GitHub Actions and Cologit Handoff

`.github/workflows/station.yml` runs a GitHub-hosted controller.
It sends the workflow commit and example path to `DGX_STATION_V1_DISPATCH_URL`, an HTTPS origin configured as a repository Actions variable.
It polls completion, downloads bounded artifacts, and fails unless both the test and cleanup succeed.
Submission is attempted once; transport, protocol, deadline, and signal failures request cancellation.
The controller stores the deterministic job identity before submission for operator recovery.
It uses short-lived GitHub OIDC tokens in memory; no dispatcher secret is stored in GitHub.
Tokens are sent only to the configured origin and never written to artifacts.

The current Jetson backend does **not** accept this request.
Its contract, worker, and authentication rules need a coordinated Station extension before live execution.
This handoff follows the existing `/v1/jobs` API shape.
It reserves `schemaVersion: 4` for target `dgx-station-v1` without changing Jetson contracts 1 and 2 or the main-line Station contract 3.

```json
{
  "schemaVersion": 4,
  "target": "dgx-station-v1",
  "candidateSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "examplePath": "examples/gtc-dc/openclaw-dgx-station.yaml",
  "workflowRunId": "123456789",
  "workflowRunAttempt": 1
}
```

The job ID is lowercase SHA-256 of these UTF-8 values joined by `:` in the displayed order.
The request above produces job ID `1d9fa04f619dc5eb6b7d30cf4b680989229bc685655e3b2f66d754d42dba7ec8`.
`examplePath` must be a normalized relative YAML file below `examples/`, without traversal or symlink escape.
The request cannot select a repository, executable, host, credential, or cleanup command.
The backend fetches `candidateSha` only from `NVIDIA/NemoClaw`, verifies it, builds the bundle and images, and invokes the fixed test command above locally.
It supplies fresh private run paths and build references through the documented environment variables.
Candidate code with Docker access can modify the Station VM; a separate account does not isolate it.
Run only operator-approved commits and keep long-lived credentials off the VM.
The backend owns the device lock and reconciles cleanup independently of the test result.

The backend must validate GitHub's token signature, issuer, expiry, repository ID, workflow identity, event, runner environment, run ID, and attempt.
Use audience `nemoclaw-dgx-station-v1-dispatch` and workflow `.github/workflows/station.yml`.
Allow manual runs only from `refs/heads/v1`.
For initial qualification, explicitly approve the `run-station-v1-e2e/**` branch and workflow commit before enabling its push event.
Require the token's source commit to match `candidateSha`.
Do not reuse the Jetson audience, queue, state directory, or cleanup program.

| Method | Path | Response |
|---|---|---|
| POST | `/v1/jobs` | 202 with job status; repeated requests return the same job |
| GET | `/v1/jobs/{jobId}` | 200 with job status |
| DELETE | `/v1/jobs/{jobId}` | 202 acknowledging idempotent cancellation |
| GET | `/v1/jobs/{jobId}/artifact` | 200 with `{ "status": STATUS, "log": TEXT, "artifactArchiveBase64": OPTIONAL_ARCHIVE }` |

Status contains `schemaVersion: 4`, `jobId`, the unchanged `request`, `state`, and `cleanup`.
State is `queued`, `running`, or `completed`.
Completed status also contains `conclusion`: `success`, `failure`, `cancelled`, `timed-out`, or `cleanup-failed`.
Completed cleanup is `succeeded` or `failed`; successful tests require successful cleanup.
Nonterminal cleanup is `pending`.
Retain the device lock after cleanup failure and reconcile queued or interrupted jobs after backend restart.
Cancellation must also reconcile a POST whose response was lost; retain a cancellation tombstone if it arrives before submission completes.
Enforce a backend execution deadline shorter than the controller's 110-minute deadline, including queueing, build, execution, and cleanup.
Cache the model before dispatch when a cold build and model download cannot fit that deadline.
Do not automatically repeat failed mutations or rerun a failed test.

Limit status responses to 64 KiB, logs to 4 MiB, and decoded artifact archives to 1 MiB, as in Jetson.
The backend must redact credentials and private state from logs and archives.
The controller saves the archive without extracting it and uploads its receipt even after dispatch failure.

Once the workflow is dispatchable, run it with:

```sh
gh workflow run station.yml --repo NVIDIA/NemoClaw --ref v1 \
  -f example_path=examples/gtc-dc/openclaw-dgx-station.yaml
```

GitHub requires the workflow on the default branch for manual dispatch.
Before that, use an explicitly approved opt-in push branch.
This change does not provision a lease, install host prerequisites, deploy Cologit, or open a tunnel.

## Evidence Ownership

The missing live dimension is applying the GTC DC OpenClaw example on a Station VM through the v1 Docker deployment path.
The canonical live test is `station_example_components_are_running` in `crates/nemoclaw-e2e/tests/station.rs`.
Its real boundaries are the bundled CLI, GPU-backed vLLM startup, OpenShell sandbox creation, and Docker inspection.
The smallest assertion checks the owned gateway, service, sandbox, and supervisor processes after apply.
Existing SDK and provider tests own compilation and readiness rules.
Non-live tests in `station.rs` own template preparation and container-result validation.
The controller's binary tests own dispatch identity, terminal results, and cancellation behavior.
This smoke does not qualify model responses, tool calls, recovery, or performance.
