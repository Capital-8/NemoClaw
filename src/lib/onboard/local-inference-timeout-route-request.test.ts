// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// An accepted NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must reach the route request
// unchanged on every onboarding route that carries it (#13734).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADAPTER = {
  baseUrl: "http://host.openshell.internal:18081/v1",
  localBaseUrl: "http://127.0.0.1:18081/v1",
  logPath: "/tmp/runtime-adapter.log",
  credentialEnv: "NEMOCLAW_RUNTIME_ADAPTER_TOKEN",
  token: "adapter-token",
  region: "us-east-1",
};

function routeHarness() {
  return {
    sandboxName: null,
    isNonInteractive: () => true,
    gatewayName: "nemoclaw",
    inferenceRouteMutator: { setInferenceRoute: vi.fn(async () => ({ ok: true as const })) },
    upsertProvider: vi.fn(async () => ({ ok: true as const })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
    ensureAdapter: vi.fn(async () => ADAPTER),
    updateSandbox: vi.fn(() => true),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    error: vi.fn(),
    log: vi.fn(),
  };
}

const MAX_TIMEOUT_REQUEST = expect.objectContaining({ verificationTimeoutSeconds: 3600 });

describe("accepted local inference timeout reaches the route request (#13734)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "3600");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes 3600 seconds for the Bedrock Runtime adapter route", async () => {
    vi.stubEnv("COMPATIBLE_ANTHROPIC_API_KEY", "bedrock-token");
    const { setupBedrockRuntimeInference } = await import("./bedrock-runtime");
    const options = routeHarness();

    await setupBedrockRuntimeInference({
      ...options,
      provider: "compatible-anthropic-endpoint",
      model: "anthropic.claude",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    } as unknown as Parameters<typeof setupBedrockRuntimeInference>[0]);

    expect(options.inferenceRouteMutator.setInferenceRoute).toHaveBeenCalledWith(
      MAX_TIMEOUT_REQUEST,
    );
  });
});
