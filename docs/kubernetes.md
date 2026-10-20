<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy to Kubernetes or OpenShift

Run agent sandboxes on an existing Kubernetes or OpenShift cluster.
NemoClaw either installs a development OpenShell gateway in a namespace it creates, or uses a gateway you already run.
The same agent images serve Docker, Podman, Kubernetes and OpenShift.

The managed gateway authenticates users through a development issuer it runs, or through [an existing OIDC issuer](#authenticate-through-an-existing-oidc-issuer).
OpenShift's security policy admitting these pods is untested; [current limits](limits.md#platforms-models-and-placement) lists what else is untested.

## Prerequisites

- **A NemoClaw bundle:** [build one](build.md#build-a-native-bundle) from this revision.
  The bundle includes the Helm provider that installs the gateway; no Helm CLI is needed.
- **Cluster access:** a kubeconfig file and an exact context that can create a namespace and, inside it, Secrets, ConfigMaps, Services, Deployments, StatefulSets and NetworkPolicies.
  The SDK reads the cluster's CustomResourceDefinitions, StorageClasses and namespaces.
  If the kubeconfig runs an exec plugin that needs your environment, such as `aws` for EKS, list those variables in `gateway.kubernetes.environment`, for example `[AWS_PROFILE, AWS_REGION]`.
  OpenTofu and its providers receive only platform variables such as `PATH` and `HOME`, plus the ones you list.
- **Cluster setup, done by the platform operator:**
  - [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox), with its controller running in `agent-sandbox-system`; CI tests version 0.5.0.
  - Exactly one default StorageClass.
- **Agent images:** pushed to a registry the cluster can pull from, and referenced by digest.
- **Inference:** an endpoint reachable from inside the sandboxes, such as a [model server you run in the cluster](#use-a-model-server-in-the-cluster), or a [managed model service](#run-a-managed-model-service) that NemoClaw declares beside a managed gateway.

NemoClaw installs nothing cluster-wide and never selects a context for you.

## Prepare Agent Images

A cluster sandbox names its image's metadata bundle in `image.metadata`, because no local engine can inspect the image there.
From the repository root, build the image, then write its bundle to a new file:

```sh
cargo images build --platform linux/amd64 openclaw
cargo images export-metadata nc-fabric:openclaw --platform linux/amd64 --output openclaw.metadata.json
```

Push the image, then use the digest of the pushed index in `image.ref`.
The bundle is checked against that digest, so it must come from the same build.
Set the environment variable named in `image.metadata` to the bundle's path before each command.
See [Build agent images](build.md#build-agent-images) for the harnesses each platform builds.

## Deploy with a Managed Gateway

The SDK creates the namespace and a credential key, starts a development token issuer, and installs the pinned OpenShell chart.
The `openshell` and `fabric` providers reach the gateway through port forwards they open on free loopback ports while OpenTofu runs.
Start from [the Kubernetes example](../examples/kubernetes/managed-development.yaml) and set:

- `metadata.uid` to a new UUID.
- `gateway.kubernetes.kubeconfig` to the environment variable holding the kubeconfig path, and `context` to the exact context.
- `gateway.kubernetes.namespace` to a namespace that does not exist yet; NemoClaw does not take over an existing one.
- `gateway.endpoint` to `https://127.0.0.1:` and an explicit port. Providers forward on free ports of their own, so this port is not bound.
- Each sandbox's `image.ref` and `image.metadata`.

```yaml
spec:
  gateway:
    management: managed
    runtime:
      provider: kubernetes
    endpoint: https://127.0.0.1:17671
    kubernetes:
      kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
      context: my-cluster
      namespace: nemoclaw-development
      authentication:
        profile: development
```

From the directory holding `deployment.yaml`, preview the deployment, then apply it:

```sh
export NEMOCLAW_CLUSTER_KUBECONFIG="$HOME/.kube/config"
export NEMOCLAW_AGENT_IMAGE_METADATA="$PWD/openclaw.metadata.json"
nemoclaw plan --state-dir .local/kubernetes deployment.yaml
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Apply creates the gateway and every sandbox, and starts each agent.
Keep the state directory: it holds the cluster ownership receipt and the development issuer's keys, and destroy needs both.
[Managed Kubernetes ownership](design/architecture.md#managed-kubernetes-ownership) describes which component owns each resource.

### Authenticate Through an Existing OIDC Issuer

The `development` profile runs a token issuer for this deployment, which is not an identity service.
To have the gateway authenticate users through your identity provider instead, use the `oidc` profile:

```yaml
spec:
  gateway:
    kubernetes:
      authentication:
        profile: oidc
        caConfigMap: issuer-ca
        token:
          env: NEMOCLAW_GATEWAY_TOKEN
    config:
      openshell.gateway.oidc:
        issuer: https://login.example.com/realms/openshell
        audience: openshell
        roles_claim: groups
        admin_role: openshell-admins
        user_role: openshell-users
```

- `openshell.gateway.oidc` in [`spec.gateway.config`](usage.md#configure-a-managed-gateway) holds OpenShell's OIDC settings in OpenShell's names, as its [gateway authentication guide](https://github.com/NVIDIA/OpenShell/blob/5a7728c304b5528e954e9ae900cf21f84e1a12b1/docs/how-it-works/gateways/authentication.mdx#oidc) describes for Helm deployments. OpenShell validates every request's bearer token against the issuer and audience, and maps the token's roles to administrator and user access; omitted settings take OpenShell's defaults. The `oidc` profile requires the table; under `development`, NemoClaw writes it for its own issuer.
- `caConfigMap` names a ConfigMap in the deployment's namespace whose `ca.crt` verifies the issuer's certificate. Omit it for a publicly trusted issuer. Like registry Secrets, create it after NemoClaw creates the namespace, then rerun apply with the same state directory.
- `token.env` names the variable holding the bearer token NemoClaw sends to the gateway.

NemoClaw runs no sign-in flow and stores no token.
Before each plan, apply or destroy, get an access token for the audience from your identity provider, for example with its command-line tool, and put it in the variable `token.env` names:

```sh
export NEMOCLAW_GATEWAY_TOKEN="$(your-identity-provider-cli token --audience openshell)"
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

When the token expires, get a new one and rerun.
The gateway still requires its client certificate; the token adds user identity on top.
With this profile, the namespace holds no development issuer, and the state directory holds no issuer keys.

### Reference Registry Credentials

For a managed gateway, `gateway.kubernetes.imagePullSecrets` names Kubernetes Secrets in the deployment's namespace.
The pinned chart attaches these references to gateway and helper pods and configures OpenShell to attach them to sandbox pods.
Credential values stay in Kubernetes; NemoClaw does not read, create, rotate, or remove these Secrets.

Add the names to the managed gateway settings:

```yaml
spec:
  gateway:
    kubernetes:
      imagePullSecrets:
        - registry-credentials
```

The namespace must be created by NemoClaw, so arrange for your platform to provision the Secrets after namespace creation.
If a Secret is missing or its credentials are wrong, image acquisition can fail and apply stops; keep the deployment state and UID.
After the namespace exists, provision or repair the Secret there, then rerun apply with the same configuration and state directory.
Do not create the namespace yourself or substitute another namespace to bypass ownership checks.

For the following example, install `kubectl` and prepare a protected Docker configuration file containing registry `auths` entries, as described in [Kubernetes registry authentication](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/).
Entries that only name a `credsStore` or `credHelpers` helper cannot supply credentials to the kubelet; it cannot run your client machine's helper.
From the directory holding `deployment.yaml`, create the registry Secret:

```sh
kubectl --kubeconfig "$NEMOCLAW_CLUSTER_KUBECONFIG" --context my-cluster \
  --namespace nemoclaw-development create secret generic registry-credentials \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/private/registry/config.json
nemoclaw apply --state-dir .local/kubernetes deployment.yaml
```

Use the deployment's context and namespace, and keep that credential file out of source control and shared diagnostics.
Check the pod events if a pull still fails; a configured reference does not establish registry access.
Retire upstream registry credentials separately; destroy retains the namespace and caller-managed Secrets.
Docker/Podman credential delivery and private-registry qualification across all runtimes remain tracked in [#12709](https://github.com/NVIDIA/NemoClaw/issues/12709).

## Deploy to OpenShift

Set `gateway.runtime.provider: openshift`; everything else matches the managed Kubernetes deployment above.
Start from [the OpenShift example](../examples/openshift/managed-development.yaml).

OpenShift assigns each namespace a UID and group range and admits only those identities.
After creating the namespace, the SDK waits up to 30 seconds for OpenShift to record that range, then runs the gateway as its first UID and group.
OpenShell runs each sandbox as the same UID.
If the range never appears, apply stops before installing the gateway with `OpenShift did not assign the namespace a UID range`; check that the context points at an OpenShift cluster.

The SDK records the range in its receipt, and a later apply refuses a namespace whose range has changed.
The agent images need no OpenShift variant: any UID can read their workspace seed.

## Use an Existing Gateway

To use an OpenShell gateway someone else runs on the cluster, set `gateway.management: external` with `runtime.provider` set to `kubernetes` or `openshift`.
Give its endpoint, credential and TLS material as environment references, as in [the external gateway example](../examples/kubernetes/external-gateway.yaml).
NemoClaw then manages only the sandboxes; it neither installs nor removes the gateway.
Sandboxes still need `image.metadata`.

## Use a Model Server in the Cluster

Sandboxes can use a model server that you run in the gateway's cluster.
NemoClaw creates nothing for it: you deploy the server with your platform's own tools, and the sandboxes reach it through its Service.
This has been tried on one kind cluster; [current limits](limits.md#platforms-models-and-placement) lists what is untested.
Name the Service by its cluster DNS name and port:

```yaml
spec:
  inferenceProviders:
    - name: qwen
      provider: openai
      api: openai-completions
      endpoint: http://qwen.models.svc.cluster.local:8000/v1
      credential: {env: QWEN_INFERENCE_KEY}
```

- **Destination:** OpenShell decides which address the name may reach when sandboxes connect; NemoClaw grants no address.
  OpenShell refuses the Kubernetes control-plane ports 2379, 2380, 6443, 10250 and 10255, so serve the model on another port.
- **Key:** `credential` is optional.
  It names the variable that holds the server's key where you run `nemoclaw`; OpenShell stores the key and adds it to sandbox requests.
  Give the server the same key from a Secret, as [Supply the Key on Other Platforms](inference.md#supply-the-key-on-other-platforms) shows.
  The key crosses the cluster network over plain HTTP unless your network plugin or a service mesh encrypts Pod traffic.
- **Model IDs:** the machine running `nemoclaw` usually can't resolve cluster names, so onboarding can't list the server's models; write the route's model ID yourself.
- **The server:** NemoClaw's vLLM and Ollama runtime images can run it; `vllm_runtime` and `ollama_runtime` describe the launch and requirements a platform needs ([Direct OpenTofu Usage](provider.md#direct-opentofu-usage)). Readiness is the platform's: point its probe at the server's health endpoint.

Start from [the in-cluster vLLM example](../examples/kubernetes/in-cluster-vllm.yaml), or from [the in-cluster Ollama example](../examples/kubernetes/in-cluster-ollama.yaml) for a server without a key.
Both examples use OpenClaw, which can't start in an OpenShell sandbox with the pinned Fabric, so apply stops at the agent until [#13372](https://github.com/NVIDIA/NemoClaw/issues/13372) is fixed.

## Run a Managed Model Service

Beside a managed gateway, `spec.services` can declare managed vLLM and Ollama services.
NemoClaw declares Kubernetes objects for each one with the bundled Kubernetes provider, and Kubernetes schedules, starts and restarts the server; NemoClaw runs no controller of its own.
This has not run on a real cluster or GPU yet; [current limits](limits.md#platforms-models-and-placement) lists what is untested.

The service needs `kubernetes` settings and both container limits:

```yaml
spec:
  services:
    qwen:
      kind: vllm
      authentication: bearer
      # image, hardware, model, serving and memory as on Docker
      container:
        cpuLimitMillis: 4000
        memoryLimitGiB: 64
      kubernetes:
        cpuRequestMillis: 1000
        memoryRequestGiB: 32
        storageGiB: 100
        tolerations:
          - {key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}
        keySecret: {name: qwen-inference-key, key: key}
  inferenceProviders:
    - name: qwen
      provider: openai
      api: openai-completions
      serviceRef: qwen
      credential: {env: QWEN_INFERENCE_KEY}
```

Start from [the managed vLLM example](../examples/kubernetes/managed-vllm.yaml) or [the managed Ollama example](../examples/kubernetes/managed-ollama.yaml).

**What NemoClaw declares**, in the gateway's namespace and named after the deployment and the service:

| Object | Purpose |
|---|---|
| PersistentVolumeClaim `<name>-data` | The model and its prepared data, sized by `storageGiB`, with `storageClass` or the default class; kept on destroy |
| NetworkPolicy | Admits only OpenShell supervisors, which carry sandbox traffic, on the serving port |
| Deployment, one replica, `Recreate` | The server Pod: the runtime image with `vllm_runtime`'s or `ollama_runtime`'s launch, the requests and limits, one `nvidia.com/gpu`, the volume, and `container.sharedMemoryGiB` of memory-backed `/dev/shm` |
| Service, `ClusterIP` | The address sandboxes reach: `http://<name>.<namespace>.svc.cluster.local:<port>/v1` |

The Pod runs as its image's user with every capability dropped and the runtime default seccomp profile; OpenShift assigns its user.
It is scheduled only on Linux nodes of the model's architecture, plus any `nodeSelector`, `tolerations` and `runtimeClassName` you set.
The gateway's `imagePullSecrets` apply to it too.

**Cluster prerequisites**, besides those of the gateway:

- A GPU device plugin that advertises `nvidia.com/gpu`, and the GPU runtime its nodes need.
- A network plugin that enforces NetworkPolicy. Plan and apply warn that the Kubernetes API can't verify this.
- Unlimited locked memory for containers on GPU nodes: Kubernetes can't set process limits, so the node's defaults apply.
- For the kubeconfig identity: create, read, update and delete PersistentVolumeClaims, Deployments, Services and NetworkPolicies in the namespace.

**Keys:** an authenticated vLLM service reads its key from `keySecret`, a Secret you create in the namespace; NemoClaw never reads or writes it.
Set the provider's `credential` to a variable that holds the same key where you run `nemoclaw`, so OpenShell can add it to sandbox requests.
Ollama takes no key, so the NetworkPolicy is its only access control.

**Readiness:** apply waits for the Deployment's rollout, up to 9 hours, so the model download and preparation can finish.
The Pod's readiness probe runs the runtime image's `nemoclaw-runtime-ready`, which succeeds only once the model is served; the runtime image must come from a revision that has it.
A server that keeps failing restarts until the rollout deadline expires; read its reason with `kubectl -n <namespace> logs deploy/<name>` or `kubectl describe pod`.

**Changes:** with the default `updatePolicy: Preserve`, plan and apply refuse a change that would replace a serving Pod, such as a new image, limits or serving settings.
Set `updatePolicy: Recreate` to accept the replacement and its downtime.
A Deployment whose rollout never completed is replaced without it.

**Memory protection:** when the runtime's watchdog stops the server, the Pod stays up but unready instead of restarting under the same memory pressure.
Correct the cause, then restart it with `kubectl -n <namespace> rollout restart deploy/<name>`.

**Retention:** destroy removes everything but the volume claim.
Applying the same configuration again finds the claim by its name and owner label and reuses it; a claim with the same name and another owner stops apply.
Delete a claim you no longer need with `kubectl -n <namespace> delete pvc <name>-data`.

## Destroy a Deployment

**Destroy deletes every sandbox's files and conversation history.**
Preview it, then run it with the same bundle and state directory:

```sh
nemoclaw plan --destroy --state-dir .local/kubernetes
nemoclaw destroy --state-dir .local/kubernetes
```

Destroy removes the sandboxes, the gateway release and the development issuer.
It keeps the namespace, the credential key Secret, the gateway's persistent volumes and managed model services' volume claims, as described in [deletion and retention](state.md#deletion-and-retention).
Removing them is not covered yet ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).
If destroy fails or is interrupted while removing the gateway release, follow [Recover an Interrupted Helm Removal](usage.md#recover-an-interrupted-helm-removal).
