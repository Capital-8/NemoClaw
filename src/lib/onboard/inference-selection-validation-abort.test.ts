// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { useOpenAiValidationTestServers } from "../inference/openai-validation-session.test-helpers";
import { teardownOrphanManagedGatewayOnAbort as teardownManagedGateway } from "./gateway-destroy";
import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

const EXPECTED_WSL_SLOW_VERIFICATION_ADVISORY =
  "WSL2 detected — network verification may be slower than expected. " +
  "Check proxy and VPN health, then run onboarding again with a longer budget: " +
  "`NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS=360 nemoclaw onboard`.";

const listen = useOpenAiValidationTestServers();
const resumableValidationExit = {
  code: 1,
  name: "OnboardDeferredExitError",
  preserveIncompleteSession: true,
};

describe("inference selection abort", () => {
  it("carries a default-probe WSL timeout through non-interactive teardown (#10413)", async () => {
    let _requestIndex = 0;
    const apiKey = "test-timeout-credential-canary";
    const observedAuthorization: Array<string | undefined> = [];
    const reasoningResponse =
      '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}';
    const replies = [(response: http.ServerResponse) => response.end(reasoningResponse), () => {}];
    const server = http.createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      request.resume();
      (replies[_requestIndex++] ?? replies[1])(response);
    });
    const port = await listen(server);
    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const releaseManagedGatewayPort = vi.fn(() => ({
      port: 8080,
      released: true,
      stopped: [4242],
      remaining: [],
      scanned: true,
      skipped: false,
    }));
    const removeGatewayRegistration = vi.fn(() => true);
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() =>
      teardownManagedGateway({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        resolveAuthority: () => ({
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        }),
        releaseManagedGatewayPort,
        removeGatewayRegistration,
        log: () => {},
        warn: () => {},
      }),
    );
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      teardownOrphanManagedGatewayOnAbort,
      promptValidationRecovery,
    });
    const probeOptions = {
      apiKey,
      skipResponsesProbe: true,
      requireChatCompletionsToolCalling: true,
      isWsl: true,
      spawnSyncImpl: () => {
        throw new Error("unexpected legacy probe");
      },
      validationTiming: { connectTimeoutSeconds: 0.01, maxTimeSeconds: 0.01, source: "standard" },
      validationSessionOptions: {
        env: {},
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        allowPrivateAddressesForTesting: true,
      },
    };
    try {
      const failure = await helpers
        .validateOpenAiLikeSelection(
          "Compatible endpoint",
          `http://provider.example.com:${port}/v1`,
          "qwen3-vl:4b",
          null,
          undefined,
          undefined,
          probeOptions,
        )
        .catch((caught) => caught);
      expect({
        failure,
        output: error.mock.calls.map((args) => args.join(" ")),
        promptCalls: promptValidationRecovery.mock.calls.length,
        teardownCalls: teardownOrphanManagedGatewayOnAbort.mock.calls.length,
      }).toEqual({
        failure: expect.objectContaining(resumableValidationExit),
        output: expect.arrayContaining([
          "  Validation timed out before the provider replied. Retry, or check network/proxy health.",
          `  ${EXPECTED_WSL_SLOW_VERIFICATION_ADVISORY}`,
        ]),
        promptCalls: 0,
        teardownCalls: 1,
      });
      expect(process.exitCode).toBe(1);
      expect(releaseManagedGatewayPort).toHaveBeenCalledExactlyOnceWith({ port: 8080 });
      expect(removeGatewayRegistration).toHaveBeenCalledExactlyOnceWith("nemoclaw");
      expect(releaseManagedGatewayPort.mock.invocationCallOrder[0]).toBeLessThan(
        removeGatewayRegistration.mock.invocationCallOrder[0],
      );
      expect(observedAuthorization).toContain(`Bearer ${apiKey}`);
      expect(error.mock.calls.flat().join("\n")).not.toContain(apiKey);
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
    }
  });
});
