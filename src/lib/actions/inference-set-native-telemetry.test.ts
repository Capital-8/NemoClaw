// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  targets: [] as Array<{ sandboxName?: string; outcome: string; state: string }>,
}));

vi.mock("./telemetry/operation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telemetry/operation")>()),
  recordTelemetryTarget: (receipt: (typeof telemetry.targets)[number]) => {
    telemetry.targets.push(receipt);
  },
  getTelemetryTarget: (sandboxName: string) =>
    [...telemetry.targets].reverse().find((receipt) => receipt.sandboxName === sandboxName) ?? null,
}));
vi.mock("../onboard/experimental/portable-agent-lifecycle", async (importOriginal) => ({
  ...(await importOriginal()),
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createDeps,
  HERMES_TARGET,
  OPENCLAW_TARGET,
} from "../../../test/helpers/inference-set";

const AUTHORITY = {
  schemaVersion: 1 as const,
  profileId: "nemoclaw-nvidia-inference-v1" as const,
  providerName: "nemoclaw-nvidia-prod-v1" as const,
  providerId: "provider-id",
};

function nativeDeps(agent: "hermes" | "openclaw") {
  return createDeps({
    config: {},
    entry: {
      name: agent,
      agent,
      gatewayName: "nemoclaw",
      provider: "nvidia-prod",
      model: "nvidia/test-model",
      nativeNvidiaProviderAttachment: AUTHORITY,
    },
    getNativeNvidiaProviderAuthority: () => AUTHORITY,
    defaultSandbox: agent,
    target: agent === "hermes" ? HERMES_TARGET : OPENCLAW_TARGET,
    session: baseSession({ agent, sandboxName: agent }),
  });
}

describe("inference set telemetry for native NVIDIA selections (#13598)", () => {
  beforeEach(() => {
    telemetry.targets.length = 0;
  });

  it.each(["hermes", "openclaw"] as const)(
    "reports no_change when %s repeats the active native selection",
    async (agent) => {
      const deps = nativeDeps(agent);
      const request = { provider: "nvidia-prod", model: "nvidia/test-model", sandboxName: agent };
      await runInferenceSet({ ...request, noVerify: true }, deps);
      telemetry.targets.length = 0;

      await runInferenceSet({ ...request, noVerify: true }, deps);

      expect(telemetry.targets.at(-1)).toMatchObject({
        sandboxName: agent,
        outcome: "no_change",
        state: "unchanged",
      });
    },
  );

  it("reports completed when a native selection changes the model", async () => {
    const deps = nativeDeps("hermes");
    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/test-model",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );
    telemetry.targets.length = 0;

    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/other-model",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(telemetry.targets.at(-1)).toMatchObject({
      sandboxName: "hermes",
      outcome: "completed",
      state: "applied",
    });
  });
});
