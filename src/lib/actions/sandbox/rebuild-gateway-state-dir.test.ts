// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { ensureManagedGatewayStateRoot } from "../../onboard/gateway/state-dir";

const roots: string[] = [];

function unmarkedStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".nemoclaw-rebuild-state-dir-"));
  roots.push(stateDir);
  fs.chmodSync(stateDir, 0o700);
  return stateDir;
}

function sandboxGatewayStateDir(): string {
  const stateDir = unmarkedStateDir();
  ensureManagedGatewayStateRoot({ gatewayName: "nemoclaw", gatewayPort: 8080, stateDir });
  return stateDir;
}

describe("rebuild gateway state directory preflight (#13330)", () => {
  installRebuildFlowTestHooks();
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  it("stops before backup or delete when the SDK rejects the configured state directory", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = unmarkedStateDir();
    try {
      const harness = createRebuildFlowHarness();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow(/Configured OpenShell gateway state directory is unusable/u);

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("Unsafe OpenShell gateway state directory");
      expect(errors).toContain("sandbox is untouched");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("continues when the configured state directory belongs to the sandbox gateway", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = sandboxGatewayStateDir();
    try {
      const harness = createRebuildFlowHarness();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.onboardSpy).toHaveBeenCalledOnce();
    } finally {
      restoreEnv();
    }
  });
});
