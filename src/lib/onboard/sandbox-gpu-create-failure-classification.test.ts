// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));

vi.mock("./sandbox-readiness-tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-readiness-tracing")>()),
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
  printReadinessFailure: mocks.printReadinessFailure,
}));

vi.mock("./docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));

vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));

vi.mock("./sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));

vi.mock("./docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));

vi.mock("./openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));

import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
import {
  createGpuFlowInput,
  createGpuFlowDeps,
  createGpuPatchFixture,
  setupGpuFlowMocks,
  resetGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";

import {
  isNativeGpuCreatePreBuildRejection,
  isNativeGpuCreateRoutingFailure,
  isNativeGpuReadinessRoutingFailure,
  isTrustedNativeGpuRuntimeError,
} from "./sandbox-gpu-create-attempt";

describe("native GPU create failure classification", () => {
  it.each([
    { scenario: "argument rejection before progress" },
    { scenario: "argument rejection after progress" },
    { scenario: "build failure mentioning GPU flag" },
    { scenario: "certificate failure" },
    { scenario: "documentation output" },
    { scenario: "unbounded trailing output" },
    { scenario: "bounded CLI usage output" },
  ])(
    "accepts an argument rejection without treating unrelated build failures as routing [$scenario]",
    ({ scenario }) => {
      const rejection = "error: unexpected argument '--gpu' found";
      expect(isNativeGpuCreatePreBuildRejection(rejection)).toBe(true);
      const [message, sawProgress, expected] = (
        {
          "argument rejection before progress": [rejection, false, true],
          "argument rejection after progress": [rejection, true, false],
          "build failure mentioning GPU flag": [
            "Docker build failed while compiling a GPU Python package for --gpu support",
            false,
            false,
          ],
          "certificate failure": ["x509: certificate signed by unknown authority", false, false],
          "documentation output": [
            "notice: error: unexpected argument '--gpu' found while compiling docs",
            false,
            false,
          ],
          "unbounded trailing output": [
            "error: unexpected argument '--gpu' found\nimage-controlled trailing output",
            false,
            false,
          ],
          "bounded CLI usage output": [
            "error: unexpected argument '--gpu' found\nUsage: openshell sandbox create [OPTIONS]\nFor more information, try '--help'.",
            false,
            true,
          ],
        } as const
      )[scenario]!;
      expect(isNativeGpuCreateRoutingFailure(message, { sawProgress })).toBe(expected);
    },
  );

  it.each([
    ["Failed", "policy denied startup exec for gpu-device-initialization-failed", false],
    [null, "CDI device injection failed: unresolvable nvidia.com/gpu=all", false],
    ["Error", "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all", true],
  ] as const)(
    "requires exact-target terminal phase plus host runtime evidence for readiness fallback [case %#]",
    (failurePhase, runtimeError, expected) => {
      expect(isNativeGpuReadinessRoutingFailure({ failurePhase, runtimeError })).toBe(expected);
    },
  );

  it.each([
    ["unresolvable CDI devices nvidia.com/gpu=all", true],
    [
      "failed to create task for container: failed to create shim task: OCI runtime create failed: error injecting CDI devices: unresolvable CDI devices nvidia.com/gpu=all: unknown",
      true,
    ],
    ['could not select device driver "" with capabilities: [[gpu]]', true],
    ["Docker build failed while compiling CUDA support", false],
    ["CDI device injection failed: unresolvable CDI devices example.com/widget=all", false],
    [
      'failed to create task: exec: "CDI injection failed nvidia.com/gpu=all": executable file not found',
      false,
    ],
    [
      'chdir to cwd ("/CDI device injection failed/nvidia.com/gpu=all") set in config.json failed: no such file or directory',
      false,
    ],
    ["nvidia-container-cli: requirement error: unsatisfied condition: cuda>=999", false],
    ["nvidia-container-cli: mount error: failed to mount /image-controlled/path", false],
  ] as const)(
    "recognizes only narrow host-owned OCI/CDI GPU runtime errors [case %#]",
    (message, expected) => {
      expect(isTrustedNativeGpuRuntimeError(message)).toBe(expected);
    },
  );
});

describe("compatibility lifecycle failure diagnostics", () => {
  beforeEach(() => setupGpuFlowMocks(mocks));
  afterEach(resetGpuFlowMocks);

  it.each([
    { action: "stop", status: 1, signal: null, error: undefined, timeout: 90_000, applied: 0 },
    {
      action: "stop",
      status: null,
      signal: "SIGKILL",
      error: new Error("spawnSync openshell ETIMEDOUT"),
      timeout: 90_000,
      applied: 0,
    },
    { action: "start", status: 1, signal: null, error: undefined, timeout: 30_000, applied: 1 },
  ])(
    "retains bounded redacted $action failure evidence before further mutation [case %#]",
    async ({ action, status, signal, error, timeout, applied }) => {
      const input = createGpuFlowInput();
      input.gpuRoutePlan = "compatibility-only";
      input.initialGpuRoute = "compatibility";
      input.persistRetainedSandboxRecovery = vi.fn(() => true);
      input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
      input.verifyCreatedSandboxBeforeEffects = vi.fn(async (_identity, before, after) => {
        await before?.();
        await after?.();
      });
      const patch = createGpuPatchFixture();
      mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
      const deps = createGpuFlowDeps();
      let nonce = "";
      input.beforeCreateAttempt = (value) => {
        nonce = value;
      };
      vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
        args.includes("--selector")
          ? JSON.stringify([
              {
                id: "alpha-sandbox-id",
                name: "alpha",
                labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
                resource_version: 1,
                created_at: "2026-08-25T00:00:00Z",
                phase: "Ready",
                current_policy_version: 1,
              },
            ])
          : "alpha Ready",
      );
      const secret = "private-lifecycle-diagnostic-canary";
      vi.stubEnv("NVIDIA_API_KEY", secret);
      const originalRun = vi.mocked(deps.runOpenshell).getMockImplementation()!;
      vi.mocked(deps.runOpenshell).mockImplementation((args) =>
        args[1] === action
          ? {
              status,
              signal,
              error,
              stdout: "x".repeat(3_000),
              stderr: `runtime transition refused\nAuthorization: Bearer ${secret}\nhttps://user:private-password@example.com`,
            }
          : originalRun(args),
      );

      const failure = await runSandboxGpuCreateFlow(input, deps).catch((caught: Error) => caught);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(`could not ${action} sandbox 'alpha'`);
      expect(message).toContain(`status=${String(status)}, signal=${String(signal)}`);
      expect(message).toContain("runtime transition refused");
      expect(message.includes("ETIMEDOUT")).toBe(Boolean(error));
      expect(message).not.toContain(secret);
      expect(message).not.toContain("private-password");
      expect(message.length).toBeLessThanOrEqual(2_100);
      expect(deps.runOpenshell).toHaveBeenCalledWith(
        ["sandbox", action, "-g", "nemoclaw", "alpha"],
        expect.objectContaining({
          timeout,
          suppressOutput: true,
          killSignal: "SIGKILL",
          killProcessTreeOnTimeout: true,
        }),
      );
      expect(patch.ensureApplied).toHaveBeenCalledTimes(applied);
      expect(patch.commitAfterReady).not.toHaveBeenCalled();
      expect(mocks.waitForCreatedSandboxReadyWithTrace).not.toHaveBeenCalled();
      expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(1);
    },
  );
});
