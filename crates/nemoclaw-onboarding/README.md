<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding

`nemoclaw onboard` asks questions to write validated desired-state YAML for a new single-sandbox deployment.
It does not plan or apply resources, create deployment state, or retain credential values.
Templates supply defaults for a new deployment with a fresh UID; onboarding does not edit an existing deployment.

## Run the Questionnaire

With the [build prerequisites](../../docs/build.md) installed, run from the repository root in a terminal:

```sh
cargo run -p nemoclaw-cli -- onboard --output my-deployment.yaml
```

Without a template, the defaults select a managed Docker gateway, OpenClaw, and NVIDIA Endpoints inference.
To start from a single-sandbox template:

```sh
cargo run -p nemoclaw-cli -- onboard examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

A built CLI accepts the same arguments:

```sh
nemoclaw onboard examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

The output defaults to `deployment.yaml` and must be a new file.
If it already exists, choose another `--output` path; onboarding never overwrites it.
Escape cancels without saving.
Comments and input formatting are not retained.

## Target Checks

The CLI reads engine prerequisites, the selected Fabric image, the selected route's model catalog, and credential availability through SDK discovery.
It also reads hardware advertisements for a managed gateway, but those do not affect questions or readiness yet.
Discovery needs no native bundle, starts no OpenTofu process, and does not pull images or start containers.
For an external gateway, set `spec.gateway.engine` in the template to the engine containing the selected immutable sandbox image; without it, image compatibility remains unverified.
See [engine and Fabric discovery](../../docs/provider.md#engine-and-fabric-discovery) for the observation contract.
These reads do not establish deployment readiness or working inference.

The standalone example uses the same questionnaire without discovery, so target compatibility remains unverified:

```sh
cargo run -p nemoclaw-onboarding -- examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

## Use the Saved YAML

Review the saved YAML before deploying it.
Set referenced credential environment variables before a non-interactive plan; interactive `nemoclaw plan` asks for missing values.
Plan and apply require a [verified native bundle and the CLI on PATH](../../docs/build.md#build-a-native-bundle).
Follow the [deployment guide](../../docs/usage.md) when ready to run those separate operations.

## Design and Limits

The [onboarding journey design](../../docs/design/onboarding-journeys.md) defines the supported question surface and its limits.
The [authoring domain model](../../docs/design/authoring-domain.md) owns resolver behavior, delegation, and validation gates.
The [unsupported-journeys tests](../nemoclaw-authoring/tests/unsupported_onboarding_journeys.rs) record the backlog.
