// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Ctrl+C at the configuration review, then `onboard --resume`, must give
// inference setup the endpoint that the review selected (#13802). This drives
// the review checkpoint through the real runtime boundary and session file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENDPOINT = "http://host.openshell.internal:11435/v1";
const originalHome = process.env.HOME;
let tmpHome: string;

describe("review interruption resume round trip (#13802)", () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-review-resume-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  it("resumes inference setup with the endpoint recorded at review", async () => {
    const sessionStore = await import("../../../state/onboard-session");
    const { OnboardRuntime } = await import("../runtime");
    const { OnboardRuntimeBoundary } = await import("../../runtime-boundary");
    const { toSessionUpdates } = await import("../../session-updates");
    const { handleProviderInferenceState } = await import("./provider-inference");
    const { baseOptions, baseSelection, createDeps } =
      await import("./provider-inference.test-support");
    sessionStore.saveSession(sessionStore.createSession());
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) =>
        toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: () => new OnboardRuntime(),
    });
    const checkpointSandboxIdentity = async (sandboxName: string) => {
      sessionStore.updateSession((current) => {
        current.sandboxName = sandboxName;
        current.sandboxPromptProgress.sandboxName = true;
        return current;
      });
    };

    const interrupted = createDeps({
      isNonInteractive: () => false,
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "ollama-local",
        model: "qwen2.5:1.5b",
        endpointUrl: ENDPOINT,
        credentialEnv: null,
      })),
      prompt: vi.fn(async () => {
        throw new Error("SIGINT");
      }),
      startRecordedStep: boundary.startRecordedStep.bind(boundary),
      checkpointSandboxIdentity,
    });
    await expect(
      handleProviderInferenceState({
        ...baseOptions(interrupted.deps, sessionStore.loadSession()),
        sandboxName: "review-resume",
      }),
    ).rejects.toThrow("SIGINT");
    await boundary.recordStepFailed(
      "provider_selection",
      "Onboarding exited before the step completed.",
    );

    const resumed = createDeps({
      isNonInteractive: () => true,
      isInferenceRouteReady: vi.fn(() => false),
    });
    await handleProviderInferenceState({
      ...baseOptions(resumed.deps, sessionStore.loadSession()),
      resume: true,
      sandboxName: "review-resume",
    });

    expect(resumed.calls.setupNim).not.toHaveBeenCalled();
    expect(resumed.calls.setupInference).toHaveBeenCalledWith(
      "review-resume",
      "qwen2.5:1.5b",
      "ollama-local",
      ENDPOINT,
      null,
      null,
      [],
      expect.any(Object),
    );
  });
});
