// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";
import { runOnboardProcessAsync } from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";
import { onboardScriptMocksPath } from "../helpers/onboard-split-context";

const ONBOARD_TEST_ENV = {
  NEMOCLAW_SANDBOX_PREBUILD: "1",
  NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE: "1",
  NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
} as const;

function isolatedDashboardPort(tmpDir: string): string {
  const offset = createHash("sha256").update(tmpDir).digest().readUInt16BE(0) % 10_000;
  return String(20_000 + offset);
}

describe.concurrent("Deep Agents recreation restore", () => {
  it.for([
    { scenario: "marked", marked: true, keep: true },
    { scenario: "unmarked", marked: false, keep: undefined },
  ])(
    "$scenario recreation journal reaches the Deep Agents config restore option (#13897)",
    {
      timeout: 60_000,
    },
    async ({ marked, keep }, context) => {
      const repoRoot = path.join(import.meta.dirname, "../..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dcode-recreate-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "dcode-recreate.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "sandbox.ts"),
      );
      const processRecoveryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "actions", "sandbox", "process-recovery.ts"),
      );
      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
	const runner = require(${runnerPath});
	const fixtureMocks = require(${onboardScriptMocksPath});
	fixtureMocks.mockStandaloneGatewayTeardownAuthority();
	fixtureMocks.mockManagedStateVolumeOnboardLifecycle();
	const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const processRecovery = require(${processRecoveryPath});
// The live dcode identity probe needs a running sandbox; this test owns only the restore handoff.
require(${JSON.stringify(path.join(repoRoot, "src/lib/onboard/dcode-selection-drift.ts"))}).createDcodeSelectionDriftReader = () => async () => ({ changed: false, providerChanged: false, modelChanged: false, unknown: false });
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
let nativeConfig = { agents: { defaults: { model: { primary: "openai/gpt-4o" } } }, models: { providers: {} }, custom: { retained: true } };
let registered = null;
const sandboxConfig = require(${JSON.stringify(path.join(repoRoot, "src/lib/sandbox/config.ts"))});
sandboxConfig.readSandboxConfig = () => structuredClone(nativeConfig);
sandboxConfig.setOpenClawConfigValues = (_name, updates) => {
  for (const { dotpath, value } of updates) {
    const keys = dotpath.split(".");
    const leaf = keys.pop();
    let current = nativeConfig;
    for (const key of keys) current = current[key] ??= {};
    current[leaf] = structuredClone(value);
  }
};
processRecovery.beginUnregisteredOpenClawBackupQuiesce = async (sandboxName) => ({ ok: true, window: { sandboxName, kind: "backup" } });
processRecovery.finishUnregisteredOpenClawPostRestoreDoctor = async () => {
  events.push({ kind: "restart", primary: nativeConfig.agents.defaults.model.primary });
  return { ok: true };
};
processRecovery.abortUnregisteredOpenClawPostRestoreDoctor = async () => ({ ok: true });
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({ lifecycleState: "created" });
runner.run = (command) => {
  const cmd = _n(command);
  const profileResult = fixtureMocks.mockProviderPreparationRun(command, "nemoclaw", "nemoclaw-mcp-v1", false);
  if (profileResult !== null) return profileResult;
  if (cmd.includes("sandbox delete") && createdSandbox.state.lifecycleState === "created") createdSandbox.delete();
  events.push({ kind: "run", cmd });
  return createdSandbox.run(command) ?? { status: 0 };
};
	runner.runCapture = (command) => {
	  const cmd = _n(command);
	  if (cmd.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
	  if (cmd.includes("policy get") && cmd.includes("--output json")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture-policy", active_version: 1, policy: {} });
	  const createdIdentity = createdSandbox.capture(command);
	  if (createdIdentity !== null) return createdIdentity;
  if (cmd.includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
};
	const sourceSandbox = fixtureMocks.sandboxLifecycleFixture({
	  name: "my-assistant",
	  gpuEnabled: false,
	  agent: "langchain-deepagents-code",
	}, { sandboxId: createdSandbox.state.sandboxId });
	registry.getSandbox = () => sourceSandbox;
	const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
	  sandboxName: "my-assistant",
	  provider: "nvidia-prod",
	  model: "gpt-5.4",
	  getSandbox: registry.getSandbox,
      registerSandbox: (entry) => { registered = entry; },
	});

let latestBackup = null;
sandboxState.getLatestBackup = () => latestBackup;
sandboxState.backupSandboxState = (name) => {
  events.push({ kind: "backup", name });
  latestBackup = { backupPath: "/tmp/fake-backup-path", timestamp: "2026-05-25T00:00:00Z" };
  return {
    success: true,
    backedUpDirs: ["workspace", "skills"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: latestBackup,
  };
};
sandboxState.restoreRecreatedSandboxState = (name, backupPath, options) => {
  events.push({ kind: "restore", name, backupPath, options });
  nativeConfig.agents.defaults.model.primary = "openai/gpt-4o";
  return {
    success: true,
    restoredDirs: ["workspace", "skills"],
    failedDirs: [],
    restoredFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
  };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))});
preflight.checkPortAvailable = async () => ({ ok: true });

	childProcess.spawn = (...args) => {
	  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
	  if (command.includes("sandbox create") && createdSandbox.state.lifecycleState === "deleted") createdSandbox.recreate(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4243;
  events.push({ kind: "spawn", cmd: command });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "0";
  const createArgs = fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
    [null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, null, require(${JSON.stringify(path.join(repoRoot, "src/lib/agent/defs.ts"))}).loadAgent("langchain-deepagents-code"), null, null, null, []],
    createFixture,
  );
  // Seed the durable checkpoint left by the interrupted invocation. The resumed
  // request carries only its existing transaction identity, never fresh authority.
  const sessions = require(${JSON.stringify(path.join(repoRoot, "src/lib/state/onboard-session.ts"))});
  const interrupted = sessions.loadSession();
  if (${JSON.stringify(marked)}) interrupted.checkpoint.sandboxRecreate.reconcileOpenClawInference = true;
  sessions.saveSession(interrupted);
  const sandboxName = await createSandbox(...createArgs);
  console.log(JSON.stringify({ sandboxName, events, nativeConfig, registered, sourceId: sourceSandbox.lifecycleLiveIdentityFingerprint, replacementId: createdSandbox.state.sandboxId }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = await runOnboardProcessAsync([scriptPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...ONBOARD_TEST_ENV,
          NEMOCLAW_DASHBOARD_PORT: isolatedDashboardPort(tmpDir),
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
        timeoutMs: 45_000,
        context,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      const restore = (
        payload.events as Array<{
          kind: string;
          options?: { targetAgentType?: string; keepReplacementDeepAgentsConfig?: boolean };
        }>
      ).find((event) => event.kind === "restore");
      assert.equal(restore?.options?.targetAgentType, "langchain-deepagents-code");
      assert.equal(restore?.options?.keepReplacementDeepAgentsConfig, keep);
    },
  );
});
