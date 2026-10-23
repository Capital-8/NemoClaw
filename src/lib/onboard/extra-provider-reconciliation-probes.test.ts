// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { planRegisteredExtraProviders } from "./extra-provider-reconciliation";
import {
  missing,
  ok,
  type ProbeResult,
  reconcile,
} from "./extra-provider-reconciliation.test-fixtures";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("planRegisteredExtraProviders probe outcomes", () => {
  it.each([true, false])(
    "preserves shared registrations while filtering revoked Tavily grants: %s (#13082)",
    async (excludeTavily) => {
      const getProvider = vi.fn(async ({ providerName }: { providerName: string }) => ({
        ok: true as const,
        value: {
          name: providerName,
          type: providerName === "shared-search" ? "tavily" : "nvidia",
          credentialKeys: [],
          configKeys: [],
        },
      }));
      const plan = await planRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["shared-search", "inference"],
        providerAdapter: { getProvider } as never,
        excludeTavily,
      });
      expect(plan).toEqual({
        extraProviders: excludeTavily ? ["inference"] : ["shared-search", "inference"],
        staleExtraProviders: [],
      });
    },
  );

  it("still prunes a confirmed missing registration when Tavily is excluded (#13082)", async () => {
    const plan = await planRegisteredExtraProviders("nemoclaw", {
      listExtraProviders: () => ["missing-provider"],
      providerAdapter: {
        getProvider: vi.fn(async () => ({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "missing" },
        })),
      } as never,
      excludeTavily: true,
    });
    expect(plan).toEqual({ extraProviders: [], staleExtraProviders: ["missing-provider"] });
  });

  it("stops rebuild when a revoked provider cannot be classified (#13082)", async () => {
    await expect(
      planRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["shared-search"],
        providerAdapter: {
          getProvider: vi.fn(async () => ({ ok: false, error: { kind: "timeout" } })),
        } as never,
        excludeTavily: true,
      }),
    ).rejects.toThrow("Cannot verify disabled Tavily provider selection");
  });

  it("preserves providers when raw probe failures lack classifiable adapter diagnostics (#6501)", async () => {
    const warn = vi.fn();
    const recorded = [
      "thrown-provider",
      "timed-out-provider",
      "nonstandard-exit-provider",
      "buffer-error-provider",
    ];

    expect(
      await reconcile(
        recorded,
        {
          "thrown-provider": () => {
            throw new Error("gateway process unavailable");
          },
          "timed-out-provider": {
            status: null,
            stderr: missing("timed-out-provider").stderr,
          },
          "nonstandard-exit-provider": {
            status: 7,
            stderr: missing("nonstandard-exit-provider").stderr,
          },
          "buffer-error-provider": {
            status: 1,
            error: new Error("spawnSync ENOBUFS"),
            stderr: missing("buffer-error-provider").stderr,
          },
        },
        { warn },
      ),
    ).toEqual(recorded);
    expect(warn).toHaveBeenCalledWith(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        "(providerCount=4; reasonClasses=ambiguous-diagnostic).",
    );
  });

  it("bounds aggregate probe latency and preserves names left after the deadline (#6501)", async () => {
    let now = 0;
    const timeouts: number[] = [];
    const warn = vi.fn();
    const runOpenshell = vi.fn((_args: string[], options?: Record<string, unknown>) => {
      const timeout = Number(options?.timeout);
      timeouts.push(timeout);
      now += timeout;
      return { status: null, stderr: "provider process timed out" };
    });
    const recorded = ["provider-1", "provider-2", "provider-3", "provider-4", "provider-5"];

    expect(
      (
        await planRegisteredExtraProviders("nemoclaw", {
          listExtraProviders: () => [...recorded],
          nowMs: () => now,
          runOpenshell,
          warn,
        })
      ).extraProviders,
    ).toEqual(recorded);
    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(timeouts).toEqual([5_000, 5_000, 5_000]);
    expect(warn).toHaveBeenCalledWith(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        "(providerCount=5; reasonClasses=aggregate-time-budget,ambiguous-diagnostic).",
    );
  });

  it("enforces gateway containment and requires a gateway name before probing (#6501)", async () => {
    const runOpenshell = vi.fn((): ProbeResult => ok());
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");

    await expect(
      planRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["custom-provider"],
        runOpenshell,
      }),
    ).rejects.toThrow(/OPENSHELL_GATEWAY_ENDPOINT is set/);
    vi.unstubAllEnvs();
    await expect(
      planRegisteredExtraProviders("", {
        listExtraProviders: () => ["custom-provider"],
        runOpenshell,
      }),
    ).rejects.toThrow("OpenShell gateway name is required.");
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
