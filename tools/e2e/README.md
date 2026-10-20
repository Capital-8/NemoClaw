<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station v1 Smoke

The test applies one OpenClaw/vLLM example through the SDK and checks its gateway, model service, sandbox, and supervisor containers in Docker.
It checks running state and Docker health when present. It requests no inference.

On a dedicated ARM64 Station, prepare an owned copy of `examples/gtc-dc/openclaw-dgx-station.yaml` using the [example instructions](../../examples/gtc-dc/README.md).
Assign a fresh deployment UID and replace the placeholder images with immutable references built from the candidate checkout.
The Cologit worker owns this preparation, the bundle build, and the VM lease. Use free ports and subnet addresses.

```sh
export NEMOCLAW_TEST_BUNDLE="$PWD/dist/linux_arm64"
export NEMOCLAW_LIVE_STATION_EXAMPLE=/absolute/private/path/to/prepared-example.yaml
export NEMOCLAW_LIVE_STATION_RUN=/absolute/private/path/to/new-run
cargo test --locked -p nemoclaw-e2e --test station \
  station_example_components_are_running -- --ignored --exact --nocapture
```

The run directory must not exist. The test attempts SDK destroy after apply or observation succeeds or fails; cleanup failure fails the test.
Destroy retains storage, credentials, and private deployment state under the product's [retention rules](../../docs/usage.md#remove-retained-resources).
Cologit must enforce a job deadline, clean up retained or interrupted job resources, and verify absence before releasing its lock.
Do not upload private configuration or state.

## GitHub Actions Handoff

`station.yml` sends the candidate commit and example path through a Cloudflare Tunnel to the Cologit backend on the leased Station VM.
Cologit runs the backend and `cloudflared` directly on that VM; no jump server is needed.
Set the repository Actions variable to the Station tunnel's public HTTPS origin:

```sh
gh variable set DGX_STATION_V1_DISPATCH_URL --repo NVIDIA/NemoClaw \
  --body 'https://<station-tunnel>.trycloudflare.com'
```

Replace the example URL with the origin reported by Station's `cloudflared`, without an API path.
Update the variable if a Quick Tunnel restart changes its URL. `JETSON_DISPATCH_URL` belongs to the separate Jetson backend.
The Station controller uses short-lived GitHub OIDC tokens with audience `nemoclaw-dgx-station-v1-dispatch`; tokens stay in memory.
The current Jetson backend needs a Station extension. The proposed request is:

```json
{"schemaVersion":4,"target":"dgx-station-v1","candidateSha":"<40-character commit>","examplePath":"examples/gtc-dc/openclaw-dgx-station.yaml","workflowRunId":"<run ID>","workflowRunAttempt":1}
```

Reuse Cologit's `POST /v1/jobs`, `GET /v1/jobs/{id}`, `DELETE /v1/jobs/{id}`, and `GET /v1/jobs/{id}/artifact` responses.
Compute the job ID as SHA-256 of the six request values joined by `:` in the displayed order.
The controller submits once, polls completion, checks the echoed identity, and requires `conclusion: success` plus `cleanup: succeeded`.
On interruption, timeout, or an uncertain response it requests cancellation using that job ID; Cologit must reconcile cancellation racing with submission.
Status bodies are limited to 64 KiB and artifact bodies to 32 MiB. The artifact JSON is uploaded unchanged; archives are not decoded.

Cologit owns authentication, normalized example-path validation, deduplication, locking, log redaction, and cleanup.
Require the canonical repository, the `station.yml` workflow, matching run identity and candidate commit, and an approved workflow revision.
Allow manual runs from `v1`; explicitly approve `run-station-v1-e2e/**` push branches before using them for initial qualification.
The backend deadline must fit within the controller's 110-minute wait. Docker access grants host-level access; run approved commits on a dedicated VM.
GitHub requires the workflow on the default branch for manual dispatch; the opt-in push trigger supports initial qualification.

## Test Responsibility

`station_example_components_are_running` owns the Station SDK-to-Docker boundary and the four container readiness checks.
SDK/provider tests own configuration validation and resource ownership; the existing Brev lifecycle test owns CLI process persistence.
The non-live Station test owns container-state interpretation. Controller tests cover job identity, result validation, and response limits.
