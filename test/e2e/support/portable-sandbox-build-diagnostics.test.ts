// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../../../src/lib/sandbox/build-context.ts";
import { prebuildSandboxImageIfEligible } from "../../../src/lib/onboard/sandbox-prebuild.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import {
  PORTABLE_ASSERTION_CLEANUP_RESERVE_MS,
  PORTABLE_GATEWAY_STARTUP_BUDGET_MS,
  PORTABLE_HERMES_LIFECYCLE_BUDGET_MS,
  PORTABLE_IMAGE_COMMAND_TIMEOUT_MS,
  PORTABLE_PROFILE_LIVE_TIMEOUT_MS,
  PORTABLE_SANDBOX_CREATE_BUDGET_MS,
  PORTABLE_SANDBOX_DELETE_BUDGET_MS,
  buildPortableSandboxImageWithEvidence,
  publishPortableSandboxImage,
} from "../fixtures/portable-sandbox-build-diagnostics.ts";
import { startTestProgress } from "../fixtures/progress.ts";

vi.mock("../fixtures/observed-child-process.ts", () => ({ spawnObservedChild: vi.fn() }));

it("settles a timed-out Podman build when a descendant keeps its output pipe open (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
  const progress = startTestProgress("portable build diagnostics", ["prepare", "build"], {
    logLine: () => undefined,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(spawnObservedChild).mockClear();
  vi.mocked(spawnObservedChild).mockReturnValueOnce(
    child as unknown as ReturnType<typeof spawnObservedChild>,
  );
  vi.useFakeTimers();
  try {
    const build = buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
    );
    child.stderr.write("permission denied; credential=private-build-token");
    await vi.advanceTimersByTimeAsync(PORTABLE_IMAGE_COMMAND_TIMEOUT_MS);
    expect(vi.mocked(spawnObservedChild).mock.calls[0]?.[2].spawn).toMatchObject({
      detached: true,
      shell: false,
    });
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await build).toBeNull();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: null,
      signal: "SIGKILL",
      errorCode: "ETIMEDOUT",
      category: "permission",
    });
    expect(published).not.toContain("private-build-token");
  } finally {
    kill.mockRestore();
    vi.useRealTimers();
    progress.stop();
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("records a fixed Podman failure category without build output (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const progress = startTestProgress(
    "portable build diagnostics",
    ["prepare build", "build sandbox image"],
    {
      logLine: () => undefined,
    },
  );
  try {
    const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
    const runBuild = vi.fn(async () => ({
      status: 1,
      signal: null,
      diagnostic: "Error: permission denied; credential=private-build-token",
    }));

    const status = await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: { NEMOCLAW_DIAGNOSTIC_TEST: "1" }, stdio: "inherit" },
      artifacts,
      progress,
      runBuild,
    );

    expect(status).toBe(1);
    expect(runBuild).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledWith(
      ["build", "-t", "localhost/test:fixed", "."],
      {
        NEMOCLAW_DIAGNOSTIC_TEST: "1",
      },
      PORTABLE_IMAGE_COMMAND_TIMEOUT_MS,
      progress,
    );
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: 1,
      signal: null,
      errorCode: null,
      category: "permission",
    });
    expect(published).not.toContain("private-build-token");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an errored image build even when Podman reports exit zero (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const dockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM scratch\n");
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build diagnostics", ["prepare", "build"], {
    logLine: () => undefined,
  });
  const fetchRegistry = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const runBuild = vi.fn(async () => ({
    status: 0,
    signal: null,
    diagnostic: "",
    error: Object.assign(new Error("private error text"), { code: "ETIMEDOUT" }),
  }));

  try {
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: "rootless-e2e",
        createArgs: ["--from", dockerfile, "--name", "portable-e2e"],
        sandboxName: "portable-e2e",
        dockerDriverGateway: true,
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable", NEMOCLAW_SANDBOX_PREBUILD: "1" },
        origin: "generated",
        buildImage: (args, options) =>
          buildPortableSandboxImageWithEvidence(args, options, artifacts, progress, runBuild),
        log: () => undefined,
      }),
    ).rejects.toThrow("build failed without an exit status");

    expect(runBuild).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        fs.readFileSync(artifacts.pathFor("portable-sandbox-image-build-failure.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 1,
      status: 0,
      signal: null,
      errorCode: "ETIMEDOUT",
      category: "unclassified",
    });
  } finally {
    fetchRegistry.mockRestore();
    progress.stop();
    fs.rmSync(buildCtx, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("reserves live-test time for bounded image, gateway, create, lifecycle, and cleanup work (#13482)", () => {
  expect(PORTABLE_GATEWAY_STARTUP_BUDGET_MS).toBeGreaterThanOrEqual(15_000);
  expect(PORTABLE_SANDBOX_CREATE_BUDGET_MS).toBeGreaterThanOrEqual(240_000);
  expect(PORTABLE_HERMES_LIFECYCLE_BUDGET_MS).toBeGreaterThanOrEqual(
    2 * 240_000 + 2 * (60_000 + 30_000),
  );
  expect(PORTABLE_SANDBOX_DELETE_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
  expect(PORTABLE_ASSERTION_CLEANUP_RESERVE_MS).toBeGreaterThanOrEqual(6 * 60_000);
  expect(PORTABLE_PROFILE_LIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(
    4 * PORTABLE_IMAGE_COMMAND_TIMEOUT_MS +
      PORTABLE_GATEWAY_STARTUP_BUDGET_MS +
      PORTABLE_SANDBOX_CREATE_BUDGET_MS +
      PORTABLE_HERMES_LIFECYCLE_BUDGET_MS +
      PORTABLE_SANDBOX_DELETE_BUDGET_MS +
      PORTABLE_ASSERTION_CLEANUP_RESERVE_MS,
  );
  // Leave the 65-minute rootless job room for its 10-minute base build and artifact upload.
  expect(PORTABLE_PROFILE_LIVE_TIMEOUT_MS).toBeLessThan(54 * 60_000);
});

it("retains a build signal and allowlisted error code without error text (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-diagnostic-"));
  const progress = startTestProgress(
    "portable build diagnostics",
    ["prepare build", "build sandbox image"],
    {
      logLine: () => undefined,
    },
  );
  try {
    const artifacts = new ArtifactSink(path.join(directory, "portable-build"));
    const status = await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: null,
        signal: "SIGTERM" as const,
        diagnostic: "credential=private-build-token",
        error: Object.assign(new Error("private error text"), { code: "EACCES" }),
      })),
    );

    expect(status).toBeNull();
    const published = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toEqual({
      schemaVersion: 1,
      status: null,
      signal: "SIGTERM",
      errorCode: "EACCES",
      category: "unclassified",
    });
    expect(published).not.toContain("private-build-token");
    expect(published).not.toContain("private error text");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a failed registry push separate from build evidence (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publish-diagnostic-"));
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  const dockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM scratch\n");
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build diagnostics", ["build", "publish"], {
    logLine: () => undefined,
  });
  const fetchRegistry = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const runBuild = vi.fn(async (_args: readonly string[], _env: NodeJS.ProcessEnv) => ({
    status: 0,
    signal: null,
    diagnostic: "",
  }));
  const runPublish = vi.fn(
    async (_args: readonly string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({
      status: 125,
      signal: null,
      diagnostic: "registry push refused; credential=private-push-token",
    }),
  );

  try {
    await expect(
      prebuildSandboxImageIfEligible({
        buildCtx,
        buildId: "rootless-e2e",
        createArgs: ["--from", dockerfile, "--name", "portable-e2e"],
        sandboxName: "portable-e2e",
        dockerDriverGateway: true,
        env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable", NEMOCLAW_SANDBOX_PREBUILD: "1" },
        origin: "generated",
        buildImage: (args, options) =>
          buildPortableSandboxImageWithEvidence(args, options, artifacts, progress, runBuild),
        publishImage: (args, options) =>
          publishPortableSandboxImage(args, options, progress, runPublish),
        inspectImageId: () => `sha256:${"a".repeat(64)}`,
        log: () => undefined,
      }),
    ).rejects.toThrow("Managed local registry publish failed (exit 125)");

    expect(fetchRegistry).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledOnce();
    expect(runBuild.mock.calls[0]?.[0]?.[0]).toBe("build");
    expect(runPublish).toHaveBeenCalledOnce();
    expect(runPublish.mock.calls[0]?.[0]?.[0]).toBe("push");
    expect(runPublish.mock.calls[0]?.[2]).toBe(PORTABLE_IMAGE_COMMAND_TIMEOUT_MS);
    expect(fs.existsSync(artifacts.pathFor("portable-sandbox-image-build-failure.json"))).toBe(
      false,
    );
  } finally {
    fetchRegistry.mockRestore();
    progress.stop();
    fs.rmSync(buildCtx, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
