// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { entry } from "../../../../test/helpers/native-launch-readiness.ts";
import type { SandboxEntry } from "../../state/registry";
import { type LaunchReadinessDeps, withLaunchReadinessMutationGate } from "./launch-readiness";

const SANDBOX = "alpha";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const EPOCH = "a".repeat(64);

// The reported #10638 failure needs two facts kept apart: the persistent
// receipt store is unsafe, but the runtime authority epoch was still durably
// rotated. Only a caller that does not require published evidence may continue
// past a receipt-store-only verdict.
describe("launch readiness mutation gate unsafe verdict scope", () => {
  function gateDeps(sandbox: SandboxEntry): LaunchReadinessDeps {
    return {
      getSandbox: () => sandbox,
      withSandboxLock: async <T>(_name: string, operation: () => Promise<T> | T) => operation(),
      withGatewayLock: async <T>(_name: string, operation: () => Promise<T> | T) => operation(),
    };
  }

  function publication() {
    return {
      sandboxName: SANDBOX,
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
      epochId: EPOCH,
    };
  }

  it("enters the mutation window for a receipt-store-only verdict when the caller tolerates it (#10638)", async () => {
    const currentDeps = gateDeps(entry());
    const evidence = {
      resource: "persistent receipt directory" as const,
      path: "/home/test/.nemoclaw/launch-readiness",
      expectedUid: 1000,
      observedUid: 1000,
      expectedMode: "0700" as const,
      observedMode: "0750",
      operation: "inspect" as const,
      errorCode: null,
      repair: "manual" as const,
    };
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "receipt-store" as const,
      evidence,
    }));
    currentDeps.tolerateReceiptStoreUnsafe = true;
    const mutation = vi.fn(() => "complete");

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({ kind: "entered", value: "complete", toleratedUnsafe: evidence });
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("never tolerates a runtime-authority verdict even when publication is optional (#10638)", async () => {
    const currentDeps = gateDeps(entry());
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "runtime-authority" as const,
    }));
    currentDeps.tolerateReceiptStoreUnsafe = true;
    const mutation = vi.fn();

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({ kind: "unsafe", scope: "runtime-authority" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("keeps refusing a receipt-store verdict for callers that require publication (#10638)", async () => {
    const currentDeps = gateDeps(entry());
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "receipt-store" as const,
    }));
    const mutation = vi.fn();

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({ kind: "unsafe", scope: "receipt-store" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("tolerates a receipt-store verdict that carries no bounded evidence (#10638)", async () => {
    // The store can classify an unsafe receipt without a diagnostic snapshot.
    // The caller still runs the complete preflight; it just has no path to show.
    const currentDeps = gateDeps(entry());
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "receipt-store" as const,
    }));
    currentDeps.tolerateReceiptStoreUnsafe = true;
    const mutation = vi.fn(() => "complete");

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({ kind: "entered", value: "complete" });
    expect(mutation).toHaveBeenCalledOnce();
  });
});
