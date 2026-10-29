// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeForwardRestart } from "../fixtures/forward-restart-observation.ts";

import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";

const progressInstances: TestProgress[] = [];
function observedProgress(): TestProgress {
  const progress = startTestProgress(
    "forward restart observation",
    ["observe restart", "verify cleanup"],
    { logLine: () => undefined },
  );
  progressInstances.push(progress);
  return progress;
}
afterEach(() => {
  for (const progress of progressInstances.splice(0)) progress.stop();
});

const ready =
  'process.stderr.write("Forwarding 127.0.0.1:123 -> 127.0.0.1:18789 in sandbox test via gRPC\\n");';

describe("forward restart observation", () => {
  it("records a real child exit on a non-Ready sandbox without exposing stderr", async () => {
    const record = vi.fn();
    const result = await observeForwardRestart({
      progress: observedProgress(),
      executable: process.execPath,
      args: [
        "-e",
        `${ready}setTimeout(() => { process.stderr.write("private-token\\nsandbox 'test' is no longer ready (phase: Stopped); stopping service forward\\n"); process.exit(7); }, 30);`,
      ],
      env: process.env,
      record,
      restart: async () => {
        await sleep(150);
        return "original-restart-result";
      },
    });
    expect(result).toBe("original-restart-result");
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        ready: true,
        sandboxNotReady: true,
        exitedBeforeCleanup: true,
        exitCode: 7,
        cleanupConfirmed: true,
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(record.mock.calls)).not.toContain("sandbox 'test'");
  });

  it("cleans up its live child and preserves a restart failure", async () => {
    const record = vi.fn();
    const failure = new Error("original restart failure");
    await expect(
      observeForwardRestart({
        progress: observedProgress(),
        executable: process.execPath,
        args: ["-e", `${ready}setInterval(() => {}, 1000);`],
        env: process.env,
        record,
        restart: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        ready: true,
        exitedBeforeCleanup: false,
        signal: "SIGTERM",
        cleanupConfirmed: true,
      }),
    );
  });

  it("confirms cleanup after its child ignores graceful termination", async () => {
    const record = vi.fn();
    await observeForwardRestart({
      progress: observedProgress(),
      executable: process.execPath,
      args: ["-e", `process.on("SIGTERM", () => {});${ready}setInterval(() => {}, 1000);`],
      env: process.env,
      record,
      restart: async () => "original",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        ready: true,
        exitedBeforeCleanup: false,
        signal: "SIGKILL",
        cleanupConfirmed: true,
      }),
    );
  });

  it("still runs the original restart when the diagnostic executable cannot start", async () => {
    const record = vi.fn();
    const restart = vi.fn().mockResolvedValue("original");
    await expect(
      observeForwardRestart({
        progress: observedProgress(),
        executable: "/nonexistent/forward",
        args: [],
        env: process.env,
        record,
        restart,
      }),
    ).resolves.toBe("original");
    expect(restart).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false, spawnFailed: true, cleanupConfirmed: true }),
    );
  });

  it("drains large child output while retaining only bounded diagnostic flags", async () => {
    const record = vi.fn();
    await observeForwardRestart({
      progress: observedProgress(),
      executable: process.execPath,
      args: [
        "-e",
        `${ready}setTimeout(() => { process.stderr.write("sensitive".repeat(10000) + "\\nsandbox 'test' no longer exists; stopping service forward\\n", () => process.exit(1)); }, 30);`,
      ],
      env: process.env,
      record,
      restart: async () => {
        await sleep(150);
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stderrTruncated: true,
        sandboxMissing: true,
        cleanupConfirmed: true,
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("sensitive");
    expect(JSON.stringify(record.mock.calls).length).toBeLessThan(1000);
  });
});
