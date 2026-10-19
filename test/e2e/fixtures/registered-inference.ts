// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { normalizeNativeLocalProviderAttachment } from "../../../src/lib/inference/native-local/contract.ts";
import { recordedNativeProviderAttachment } from "../../../src/lib/inference/native-provider/recorded-selection.ts";
import { buildSandboxInferenceChatCommand } from "./inference-adapter.ts";
import { parseCliOpenShellProviderMetadata } from "../../../src/lib/adapters/openshell/provider-metadata-cli.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";

/** Read the published selection again after a failed backup or successful recreation. */
export function registeredCompatibleChatCommand(
  sandboxName: string,
  model: string,
  payload: string,
): [string, ...string[]] {
  const entry = getSandbox(sandboxName);
  const local = normalizeNativeLocalProviderAttachment(entry?.nativeLocalProviderAttachment);
  const hosted = entry && recordedNativeProviderAttachment(entry);
  if (
    entry?.provider !== "compatible-endpoint" ||
    entry.model !== model ||
    (entry.nativeLocalProviderAttachment !== undefined && !local) ||
    Boolean(local && hosted) ||
    (local &&
      (local.sandboxName !== sandboxName ||
        local.gatewayName !== entry.gatewayName ||
        local.provider !== entry.provider ||
        local.agent !== (entry.agent === "deepagents" ? undefined : entry.agent) ||
        (local.api ?? "openai-completions") !== "openai-completions")) ||
    (hosted &&
      (hosted.custom?.api !== "openai-completions" ||
        hosted.custom.credentialEnv !== "COMPATIBLE_API_KEY")) ||
    (!local && !hosted)
  )
    throw new Error("The registered compatible inference selection does not match this probe");
  return buildSandboxInferenceChatCommand(
    payload,
    entry.provider,
    (local ?? hosted)!.endpointUrl,
    60,
  );
}

/** Keep HTTP error responses visible for the DNS and redirect denial checks. */
export function registeredCompatibleResponseCommand(
  sandboxName: string,
  model: string,
  payload: string,
  followRedirect: boolean,
): [string, ...string[]] {
  const command = registeredCompatibleChatCommand(sandboxName, model, payload);
  command[2] = command[2].replace(
    "curl -fsS",
    `curl -sS --include${followRedirect ? " --location --post302 --max-redirs 3" : ""}`,
  );
  return command;
}

/** Bind the sibling snapshot to the real provider revision and attachment. */
export async function readRegisteredLocalRoute(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactName: string,
) {
  const entry = getSandbox(sandboxName);
  const receipt = normalizeNativeLocalProviderAttachment(entry?.nativeLocalProviderAttachment);
  if (
    !receipt ||
    receipt.sandboxName !== sandboxName ||
    receipt.gatewayName !== entry?.gatewayName ||
    receipt.provider !== entry.provider ||
    receipt.agent !== (entry.agent === "deepagents" ? undefined : entry.agent)
  )
    throw new Error("The sibling has no matching native local inference receipt");
  const options = { env: buildAvailabilityProbeEnv(), timeoutMs: 30_000 };
  const provider = await sandbox.openshell(
    ["provider", "get", "-g", receipt.gatewayName, receipt.providerName],
    { ...options, artifactName: `${artifactName}-provider` },
  );
  const attachment = await sandbox.openshell(
    ["sandbox", "provider", "list", "-g", receipt.gatewayName, sandboxName],
    { ...options, artifactName: `${artifactName}-attachment` },
  );
  const metadata =
    provider.exitCode === 0 ? parseCliOpenShellProviderMetadata(provider.stdout) : null;
  const ok =
    metadata?.name === receipt.providerName &&
    metadata.type === receipt.profileId &&
    metadata.revision?.id === receipt.providerId &&
    metadata.configKeys.length === 0 &&
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === receipt.credentialEnv &&
    attachment.exitCode === 0 &&
    attachment.stdout.split(/\s+/u).includes(receipt.providerName);
  return {
    exitCode: ok ? 0 : 1,
    stdout: JSON.stringify({ provider: entry!.provider, model: entry!.model, receipt }),
    stderr: ok ? "" : "Sibling native provider identity or attachment mismatch",
  };
}
