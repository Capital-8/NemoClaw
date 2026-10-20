<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station v1 Smoke

The test applies one Hermes/vLLM example through the SDK and checks its gateway, model service, sandbox, and supervisor containers in Docker.
It checks running state and Docker health when present. It requests no inference.

On a dedicated ARM64 Station, prepare an owned copy of `examples/gtc-dc/hermes-dgx-station.yaml` using the [example instructions](../../examples/gtc-dc/README.md).
Assign a fresh deployment UID for the first run and replace the placeholder images with immutable references built from the candidate checkout.
Compatible later runs reuse that UID, local assignments, and deployment state so SDK destroy can retain model storage between runs.
Cologit rejects incompatible intent or gateway pins; those candidates need a separate deployment and its own warm-up.
The operator supplies the leased VM. The Cologit worker owns example preparation and the bundle build. Use free ports and subnet addresses.

```sh
export NEMOCLAW_TEST_BUNDLE="$PWD/dist/linux_arm64"
export NEMOCLAW_LIVE_STATION_EXAMPLE=/absolute/private/path/to/prepared-example.yaml
export NEMOCLAW_LIVE_STATION_RUN=/absolute/private/path/to/new-run
export NEMOCLAW_LIVE_STATION_STATE=/absolute/private/path/to/deployment/state
export NEMOCLAW_LIVE_STATION_RESULT=/absolute/private/path/to/job/smoke-result.json
cargo test --locked -p nemoclaw-e2e --test station \
  station_example_components_are_running -- --ignored --exact --nocapture
```

The run directory must not exist. Keep the state directory separate from it and choose a fresh result path with an existing private parent directory for each job.
The [worker marker](station-worker.json) declares the state and receipt inputs expected by [Cologit MR !12](https://gitlab-master.nvidia.com/sdang/nemoclaw-colossus-jetson-tunnel/-/blob/819f84306620cc627dc7efe0d523ee1b6076ed1a/station/README.md#required-teammate-changes).
After successful apply, four component observations, and completed destroy, the test writes a receipt with the deployment UID, assigned state path, SHA-256 of the prepared YAML bytes, and the four observed container IDs.
Receipt `healthy: true` means Docker health was healthy when a healthcheck existed. Keep this receipt private on Station.
The test attempts SDK destroy after apply or observation succeeds or fails; cleanup failure fails the test and no passing receipt is written.
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
Cologit MR !12 supplies the Station backend and initially accepts only the Hermes example. The request is:

```json
{"schemaVersion":4,"target":"dgx-station-v1","candidateSha":"<40-character commit>","examplePath":"examples/gtc-dc/hermes-dgx-station.yaml","workflowRunId":"<run ID>","workflowRunAttempt":1}
```

Station's `POST /v1/jobs`, `GET /v1/jobs/{id}`, and `DELETE /v1/jobs/{id}` return bare status objects.
`GET /v1/jobs/{id}/artifact` returns an object containing that terminal `status` and a sanitized `log`.
Compute the job ID as SHA-256 of the six request values joined by `:` in the displayed order.
The controller submits once, polls completion, checks the echoed identity, and requires `conclusion: success` plus `cleanup: succeeded`.
On interruption, timeout, or an uncertain response it requests cancellation using that job ID and the original request JSON as the DELETE body.
Cologit durably records cancellation even if it arrives before POST; acknowledgement does not prove cleanup has finished.
Status bodies are limited to 64 KiB and artifact bodies to 32 MiB. The artifact JSON is uploaded unchanged; archives are not decoded.

Cologit owns authentication, normalized example-path validation, deduplication, locking, log redaction, and cleanup.
Require the canonical repository, the `station.yml` workflow, matching run identity and candidate commit, and an approved workflow revision.
Allow manual runs from `v1`; explicitly approve `run-station-v1-e2e/**` push branches before using them for initial qualification.
The backend deadline must fit within the controller's 110-minute wait. Docker access grants host-level access; run approved commits on a dedicated VM.
GitHub requires the workflow on the default branch for manual dispatch; the opt-in push trigger supports initial qualification.

## Test Responsibility

`station_example_components_are_running` owns the Station SDK-to-Docker boundary and the four container readiness checks.
SDK/provider tests own configuration validation and resource ownership; the existing Brev lifecycle test owns CLI process persistence.
Non-live Station tests own container-state interpretation and receipt fields/failure gates. Controller tests cover the shared Hermes identity vector, cancellation request body, result validation, and response limits.
Live qualification still needs a first deployment, a compatible retained-state rerun, and backend cancellation/recovery on Station.
