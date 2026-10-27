// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";
import { exitCodeFor } from "./channel-status";

describe("Hermes Discord channel status", () => {
  it.each([
    ["auth_failed", "credential_rejected"],
    ["connected", "healthy"],
    ["unknown", "unknown"],
  ])("reports %s through the channel status action (#13809)", async (state, verdict) => {
    const { deps: syncDeps } = makeDeps({
      agentName: "hermes",
      sandbox: entry(["discord"], [], {}, "hermes"),
      appliedPresets: ["discord"],
      gatewayPresets: ["discord"],
      exec: () => ({
        status: 0,
        stdout: `NEMOCLAW_DISCORD_STATUS_V1\n${JSON.stringify({ state })}`,
        stderr: "",
      }),
    });
    const deps = {
      ...syncDeps,
      execSandbox: async (...args: Parameters<typeof syncDeps.execSandbox>) =>
        syncDeps.execSandbox(...args),
    };
    const report = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "discord",
      asJson: true,
      quietJson: true,
    });
    expect(report && "report" in report && report.report.verdict).toBe(verdict);
    expect(report && exitCodeFor(report)).toBe(verdict === "credential_rejected" ? 1 : 0);
  });

  it.each([
    [1, 'NEMOCLAW_DISCORD_STATUS_V1\n{"state":"connected"}'],
    [0, "probe error invalid-token-for-test"],
    [0, "NEMOCLAW_DISCORD_STATUS_V1\n{broken"],
  ])("keeps failed or malformed probes unverified (%s) (#13809)", async (status, stdout) => {
    const { deps: syncDeps } = makeDeps({
      agentName: "hermes",
      sandbox: entry(["discord"], [], {}, "hermes"),
      appliedPresets: ["discord"],
      gatewayPresets: ["discord"],
      exec: () => ({ status, stdout, stderr: "invalid-token-for-test" }),
    });
    const deps = {
      ...syncDeps,
      execSandbox: async (...args: Parameters<typeof syncDeps.execSandbox>) =>
        syncDeps.execSandbox(...args),
    };
    const report = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "discord",
      asJson: true,
      quietJson: true,
    });
    expect(report && "report" in report && report.report.verdict).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("invalid-token-for-test");
  });
});
