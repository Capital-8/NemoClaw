// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Connect re-points the shared route of local-timeout providers with
// NEMOCLAW_LOCAL_INFERENCE_TIMEOUT. An unsupported value used to fail the route
// switch with a generic error while connect continued on the old route (#13734).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";
import { connectInferenceTimeoutRangeError } from "./connect-inference-gateway";

describe("connect local inference timeout range (#13734)", () => {
  it.each(["compatible-endpoint", "ollama-local", "vllm-local"])(
    "rejects an unsupported timeout for %s",
    (provider) => {
      expect(
        connectInferenceTimeoutRangeError(provider, { NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: "3601" }),
      ).toBe('NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds; got "3601".');
      expect(
        connectInferenceTimeoutRangeError(provider, { NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: "3600" }),
      ).toBeNull();
    },
  );

  it.each(["nvidia-prod", "openai-api", null, undefined])(
    "ignores the timeout for %s, whose route does not carry it",
    (provider) => {
      expect(
        connectInferenceTimeoutRangeError(provider, { NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: "7200" }),
      ).toBeNull();
    },
  );
});

describe("connectSandbox local inference timeout (#13734)", () => {
  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    vi.unstubAllEnvs();
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("stops before the lifecycle lock for a compatible-endpoint sandbox", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "7200");
    const harness = createConnectHarness({
      registryEntry: { provider: "compatible-endpoint", model: "test-model" },
    });
    const gatewayState = requireDist(
      "../../src/lib/actions/sandbox/gateway-state.js",
    ) as typeof import("./gateway-state");
    const errorSpy = vi.spyOn(console, "error");

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith(
      '  NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds; got "7200".',
    );
    expect(gatewayState.withConnectSandboxLifecycleLock).not.toHaveBeenCalled();
  });
});
