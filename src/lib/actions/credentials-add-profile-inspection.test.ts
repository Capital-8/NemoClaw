// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { providerAdapter } from "../../../test/helpers/credentials-provider-adapter.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsAddAction } from "./credentials-add";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

vi.mock("../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

describe("credentials add reports operator profile inspection failures", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
    });
  });

  afterEach(() => {
    setGlobalCliActionRuntimeHooksForTest({});
    vi.unstubAllEnvs();
  });

  it("names the declared credentials when an extra NVIDIA provider uses an undeclared name (#13541)", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "host-only-value");
    const declared =
      "The supplied credential names are not declared by the OpenShell provider profile. Declared credential names: NVIDIA_API_KEY.";
    const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] =
      async () => ({
        ok: false,
        error: { kind: "command", reason: "profile_incompatible", message: declared },
      });
    const adapter = providerAdapter({ inspectProviderProfile: vi.fn(inspectProviderProfile) });

    const result = await runCredentialsAddAction(
      {
        provider: "demo-nvidia",
        type: "nvidia",
        credentials: ["NVIDIA_INFERENCE_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toEqual([
      "  Could not verify provider profile 'nvidia' for credential registration.",
      `  ${declared}`,
      "  Retry with a declared credential name, or ask the gateway operator to update this profile.",
    ]);
    expect(adapter.inspectProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profileType: "nvidia",
      timeoutMs: 30_000,
      registrationCredentials: ["NVIDIA_INFERENCE_API_KEY"],
    });
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(result.failureLines.join("\n")).not.toContain("host-only-value");
  });
});
