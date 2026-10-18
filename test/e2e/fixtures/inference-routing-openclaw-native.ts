// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import type { NativeLocalProviderAttachment } from "../../../src/lib/inference/native-local/contract.ts";
import { probeSandboxInferenceInvocation } from "../../../src/lib/actions/sandbox/inference-invocation-probe.ts";
import { executeSandboxExecCommand } from "../../../src/lib/adapters/sandbox/command-transport.ts";
import { NATIVE_LOCAL_AUTH_HEADER_SCRIPT } from "../../../src/lib/inference/native-local/agent-config.ts";
import {
  resolveMaxTokensField,
  resolveProbeReplyTokens,
} from "../../../src/lib/inference/max-tokens-field.ts";
import { shellQuote } from "../../../src/lib/runner.ts";
import {
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_DELAY_MS,
  OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_DOCTOR_TIMEOUT_MS,
  OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_PROBE_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import { sandboxAccessEnv } from "./clients/sandbox.ts";
import type { E2ETargetFixtures } from "./e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "./fake-openai-compatible.ts";
import type { ShellProbeResult } from "./shell-probe.ts";
import {
  cleanupSandbox,
  inferenceSandboxName,
  onboardSandbox,
  requireLivePrerequisites,
} from "../live/inference-routing-helpers.ts";

type NativeOpenClawContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "runtimeProvider" | "sandbox"
>;

type RestartDiagnosticContext = Pick<NativeOpenClawContext, "artifacts" | "host"> & {
  owner: string;
  model: string;
  apiKey: string;
  fake: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>>;
  attachment: NativeLocalProviderAttachment | null | undefined;
  referenceProbe?: typeof probeSandboxInferenceInvocation;
  classificationExec?: typeof executeSandboxExecCommand;
};

/** Preserve the original restart failure while collecting bounded route evidence for HTTP 503. */
export async function captureNativeRestart503Diagnostic(
  start: ShellProbeResult,
  {
    owner,
    model,
    apiKey,
    fake,
    attachment,
    referenceProbe,
    classificationExec,
    artifacts,
    host,
  }: RestartDiagnosticContext,
): Promise<void> {
  if (
    start.exitCode === 0 ||
    !(start.stdout + "\n" + start.stderr).includes(
      "sandbox inference invocation probe returned HTTP 503",
    ) ||
    !attachment
  )
    return;
  const evidence: Record<string, unknown> = {};
  const observe = async (name: string, operation: () => Promise<unknown>) => {
    try {
      evidence[name] = await operation();
    } catch {
      evidence[name] = { error: "probe unavailable" };
    }
  };
  try {
    const inspectReferenceRoute = async () => {
      const before = fake.requests().length;
      const probe = await (referenceProbe ?? probeSandboxInferenceInvocation)(
        {
          sandboxName: owner,
          gatewayName: attachment.gatewayName,
          provider: attachment.provider,
          model,
          preferredInferenceApi: "openai-completions",
          nativeLocalProviderAttachment: attachment,
        },
        {},
        OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_PROBE_TIMEOUT_MS,
      );
      return {
        ok: probe.ok,
        httpStatus: probe.ok ? null : probe.httpStatus,
        reachedEndpoint: fake.requests().length > before,
      };
    };
    // Classify a proxy-owned 503 without exporting its response body or credential.
    const inspectReferenceFailureClass = async () => {
      const body = JSON.stringify({
        model,
        [resolveMaxTokensField(model)]: resolveProbeReplyTokens(attachment.provider, model),
        messages: [{ role: "user", content: "Reply with OK" }],
        stream: false,
      });
      const script = [
        "umask 077",
        NATIVE_LOCAL_AUTH_HEADER_SCRIPT,
        "response=$(mktemp /tmp/nemoclaw-native-diagnostic.XXXXXX) || exit 1",
        "trap 'rm -f \"$response\"' EXIT HUP INT TERM",
        `status=$(curl -q -sS --connect-timeout 5 --max-time 10 --max-filesize 65536 -o "$response" -w '%{http_code}' -H 'Content-Type: application/json' -H "$AUTH_HEADER" --data-binary ${shellQuote(body)} ${shellQuote(`${attachment.endpointUrl}/chat/completions`)}) || exit 1`,
        'printf "%s\\n" "$status"',
        'if [ "$status" != 503 ]; then printf "not-503\\n"; exit 0; fi',
        `if grep -Fq '"error":"middleware_failed"' "$response"; then printf "middleware-admission\\n"`,
        `elif grep -Fq '"error":"inference service unavailable"' "$response"; then printf "inference-upstream\\n"`,
        `elif grep -Fq '"error":"cluster inference is not configured"' "$response"; then printf "inference-unconfigured\\n"`,
        `elif grep -Fq '"error":"tls_termination_unavailable"' "$response"; then printf "tls-unavailable\\n"`,
        'else printf "other-503\\n"; fi',
      ].join("; ");
      const result = await (classificationExec ?? executeSandboxExecCommand)(
        owner,
        script,
        OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_PROBE_TIMEOUT_MS,
        { gatewayName: attachment.gatewayName },
      );
      const [status, category] = result.stdout.trim().split(/\r?\n/u);
      return {
        exitCode: result.status,
        httpStatus: /^[1-5]\d\d$/u.test(status ?? "") ? status : "unknown",
        category: [
          "not-503",
          "middleware-admission",
          "inference-upstream",
          "inference-unconfigured",
          "tls-unavailable",
          "other-503",
        ].includes(category ?? "")
          ? category
          : "unavailable",
      };
    };
    await observe("immediateReference", inspectReferenceRoute);
    if (
      typeof evidence.immediateReference === "object" &&
      evidence.immediateReference !== null &&
      "httpStatus" in evidence.immediateReference &&
      evidence.immediateReference.httpStatus === 503
    ) {
      await observe("immediateReferenceClass", inspectReferenceFailureClass);
    }
    await new Promise((resolve) => setTimeout(resolve, OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_DELAY_MS));
    await observe("delayedReference", inspectReferenceRoute);
    await observe("doctorExitCode", async () => {
      const doctor = await host.nemoclaw([owner, "doctor"], {
        artifactName: `${owner}-restart-doctor`,
        env: sandboxAccessEnv(),
        timeoutMs: OPENCLAW_NATIVE_LOCAL_DIAGNOSTIC_DOCTOR_TIMEOUT_MS,
        redactionValues: [apiKey],
      });
      return doctor.exitCode;
    });
  } catch {
    // Diagnosis must not mask the original start failure.
  } finally {
    try {
      await artifacts.writeJson(`${owner}-restart-503-diagnostic.json`, evidence);
    } catch {
      // Artifact failure must not mask the original start failure.
    }
  }
}

// The real OpenClaw process must consume its scoped native-local attachment.
// llama.cpp exercises authenticated attachment; vLLM exercises sentinel auth.
export async function onboardNativeOpenClaw(
  authenticated: boolean,
  { artifacts, cleanup, host, progress, runtimeProvider, sandbox }: NativeOpenClawContext,
) {
  await requireLivePrerequisites(host, runtimeProvider);
  const owner = inferenceSandboxName(authenticated ? "e2e-oc-auth" : "e2e-oc-none");
  const model = "nemoclaw-openclaw-native-local";
  const switchedModel = "nemoclaw-openclaw-native-local-switched";
  const apiKey = authenticated ? "sk-openclaw-native-TEST-NOT-A-REAL-VALUE" : "dummy";
  const fake = await startFakeOpenAiCompatibleServer({
    apiKey,
    model,
    additionalModels: authenticated ? [switchedModel] : [],
    chatContent: "PONG",
    host: "0.0.0.0",
    port: authenticated ? 8081 : 8000,
    publicHost: "host.openshell.internal",
    requireAuth: true,
    allowMissingAuth: !authenticated,
    requireAuthModels: authenticated,
    llamaCppFingerprint: authenticated,
    progress,
  });
  cleanup.add(`close ${owner} endpoint`, async () => {
    try {
      await artifacts.writeJson(`${owner}-requests.json`, fake.requests());
    } finally {
      await fake.close();
    }
  });
  cleanup.add(`remove ${owner}`, () => cleanupSandbox(host, sandbox, owner, { strict: true }));
  await cleanupSandbox(host, sandbox, owner);
  await artifacts.target.declare({
    id: `openclaw-native-local-${authenticated ? "authenticated" : "credentialless"}`,
    contract: [
      "OpenClaw consumes its native local endpoint after onboarding",
      ...(authenticated
        ? [
            "rebuild and restart preserve the attachment",
            "an unattached sibling cannot reach the endpoint",
            "the raw credential is absent from sandbox observations",
          ]
        : ["credentialless vLLM uses sentinel authentication"]),
    ],
    model,
    switchedModel,
  });
  const onboard = await onboardSandbox(
    artifacts,
    owner,
    {
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_PROVIDER: authenticated ? "llama-cpp" : "vllm",
      NEMOCLAW_MODEL: model,
      ...(authenticated ? { NEMOCLAW_LLAMACPP_LOCAL_TOKEN: apiKey } : {}),
    },
    [apiKey],
    `${owner}-onboard`,
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  return {
    owner,
    model,
    switchedModel,
    apiKey,
    fake,
    onboard,
    attachment: getSandbox(owner)?.nativeLocalProviderAttachment,
  };
}

export async function requestNativeOpenClaw(
  owner: string,
  apiKey: string,
  fake: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>>,
  host: NativeOpenClawContext["host"],
  model = "nemoclaw-openclaw-native-local",
) {
  const requestOffset = fake.requests().length;
  const turn = await host.nemoclaw(
    [
      owner,
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      `${owner}-${Date.now()}`,
      "-m",
      "Reply with exactly one word: PONG",
    ],
    {
      artifactName: `${owner}-turn`,
      env: sandboxAccessEnv(),
      timeoutMs: 5 * 60_000,
      redactionValues: [apiKey],
    },
  );
  const requests = fake
    .requests()
    .slice(requestOffset)
    .filter((request) => request.model === model);
  return { turn, requests };
}
