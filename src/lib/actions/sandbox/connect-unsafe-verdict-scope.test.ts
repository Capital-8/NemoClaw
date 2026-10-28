// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";

// The reported #10638 failure needs two facts kept apart: the persistent
// receipt store is unsafe, but the runtime authority epoch was still durably
// rotated. These cases pin which verdicts a caller that does not require
// published evidence may continue past.
describe("connectSandbox launch-readiness unsafe verdict scope", () => {
  let exitSpy: MockInstance;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
  });

  it("probe-only reports bounded unsafe authority evidence before mutation (#10638)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({
      kind: "unsafe",
      scope: "runtime-authority",
      evidence: {
        resource: "persistent receipt",
        path: "/home/test/.nemoclaw/launch-readiness/receipt.json",
        expectedUid: 1000,
        observedUid: 1000,
        expectedMode: "0600",
        observedMode: "0640",
        operation: "inspect",
        errorCode: null,
        repair: "chmod",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const errors = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("current launch-readiness epoch could not be safely revalidated");
    expect(errors).toContain("expected mode 0600, observed mode 0640");
    expect(errors).toContain("chmod 0600 --");
  });

  it("probe-only still refuses a runtime-authority unsafe verdict when publication is optional (#10638)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({
      kind: "unsafe",
      scope: "runtime-authority",
    });

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "current launch-readiness epoch could not be safely revalidated",
    );
  });

  it("probe-only completes recovery when only the receipt store is unsafe and publication is optional (#10638)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: false,
      },
      readinessPublicationResult: {
        kind: "evidence-failed",
        diagnostic: { stage: "publication-store", reason: "receipt-unsafe" },
      },
    });
    harness.launchReadinessMutationGateSpy.mockImplementationOnce((async (...args: unknown[]) => {
      const operation = args[1] as () => unknown;
      return {
        kind: "entered",
        value: await operation(),
        toleratedUnsafe: {
          resource: "persistent receipt directory",
          path: "/home/test/.nemoclaw/launch-readiness",
          expectedUid: 1000,
          observedUid: 1000,
          expectedMode: "0700",
          observedMode: "0750",
          operation: "inspect",
          errorCode: null,
          repair: "manual",
        },
      };
    }) as never);

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    const logs = harness.logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("launch-readiness evidence cannot be republished");
    expect(logs).toContain("expected mode 0700, observed mode 0750");
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain("Probe failed");
  });

  it("probe-only still exits when required publication hits an unsafe receipt store (#10638)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({
      kind: "unsafe",
      scope: "receipt-store",
      evidence: {
        resource: "persistent receipt directory",
        path: "/home/test/.nemoclaw/launch-readiness",
        expectedUid: 1000,
        observedUid: 1000,
        expectedMode: "0700",
        observedMode: "0750",
        operation: "inspect",
        errorCode: null,
        repair: "manual",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "current launch-readiness epoch could not be safely revalidated",
    );
  });
});
