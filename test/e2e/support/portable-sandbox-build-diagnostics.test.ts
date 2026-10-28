// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../../../src/lib/sandbox/build-context.ts";
import { prebuildSandboxImageIfEligible } from "../../../src/lib/onboard/sandbox-prebuild.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  PORTABLE_ASSERTION_CLEANUP_RESERVE_MS,
  PORTABLE_GATEWAY_STARTUP_BUDGET_MS,
  PORTABLE_HERMES_LIFECYCLE_BUDGET_MS,
  PORTABLE_IMAGE_COMMAND_TIMEOUT_MS,
  PORTABLE_PROFILE_LIVE_TIMEOUT_MS,
  PORTABLE_SANDBOX_CREATE_BUDGET_MS,
  PORTABLE_SANDBOX_DELETE_BUDGET_MS,
  buildPortableSandboxImageWithEvidence,
  probePortableSandboxOciAfterBuildFailure,
  probePodmanStore,
  publishPortableSandboxImage,
  verifyPortablePodmanStoreAuthority,
} from "../fixtures/portable-sandbox-build-diagnostics.ts";
import { startTestProgress } from "../fixtures/progress.ts";

it("parses only the fixed Podman store fields from the selected service", () => {
  const env = { XDG_CONFIG_HOME: "/private/config" };
  const runInfo = vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify({
      store: { graphRoot: "/private/graph", runRoot: "/private/run" },
      host: { ociRuntime: { path: "/private/crun" } },
    }),
  }));
  expect(probePodmanStore(env, "unix:///run/user/1001/podman/podman.sock", runInfo)).toEqual({
    graphRoot: "/private/graph",
    runRoot: "/private/run",
    ociRuntimePath: "/private/crun",
  });
  expect(runInfo).toHaveBeenCalledWith(
    ["--url", "unix:///run/user/1001/podman/podman.sock", "info", "--format", "json"],
    env,
  );
  expect(() => probePodmanStore(env, undefined, () => ({ status: 1, stdout: "secret" }))).toThrow(
    "probe",
  );
  expect(() => probePodmanStore(env, undefined, () => ({ status: 0, stdout: "secret" }))).toThrow(
    "parse",
  );
  expect(() => probePodmanStore(env, undefined, () => ({ status: 0, stdout: "{}" }))).toThrow(
    "missing-field",
  );
});

it("aligns only a trusted selected storage config and records fixed equality evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-store-authority-"));
  try {
    const source = path.join(root, "selected-storage.conf");
    const configHome = path.join(root, "fixture-config");
    fs.writeFileSync(source, '[storage]\ngraphroot="/private/graph"\nrunroot="/private/run"\n');
    const artifacts = new ArtifactSink(path.join(root, "artifacts"));
    const fullEnv = { CONTAINERS_STORAGE_CONF: source };
    const childEnv = { XDG_CONFIG_HOME: configHome };
    const probe = vi.fn(() => ({
      graphRoot: "/private/graph",
      runRoot: "/private/run",
      ociRuntimePath: "/private/crun",
    }));
    const selectedUrl = "unix:///run/user/1001/podman/podman.sock";
    await verifyPortablePodmanStoreAuthority(
      childEnv,
      fullEnv,
      selectedUrl,
      configHome,
      "store-first.json",
      artifacts,
      probe,
    );
    await verifyPortablePodmanStoreAuthority(
      childEnv,
      fullEnv,
      selectedUrl,
      configHome,
      "store-second.json",
      artifacts,
      probe,
    );
    const destination = path.join(configHome, "containers", "storage.conf");
    expect(fs.readFileSync(destination, "utf8")).toBe(fs.readFileSync(source, "utf8"));
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(probe.mock.calls).toHaveLength(6);
    expect(probe.mock.calls[0]).toEqual([childEnv]);
    expect(probe.mock.calls[1]).toEqual([fullEnv]);
    expect(probe.mock.calls[2]).toEqual([fullEnv, selectedUrl]);
    const evidence = fs.readFileSync(artifacts.pathFor("store-first.json"), "utf8");
    expect(JSON.parse(evidence)).toEqual({
      schemaVersion: 1,
      category: "match",
      childMatchesHost: true,
      hostMatchesService: true,
      childMatchesHostRuntime: true,
      hostMatchesServiceRuntime: true,
    });
    expect(evidence).not.toContain("/private/graph");
    fs.writeFileSync(source, "changed");
    await expect(
      verifyPortablePodmanStoreAuthority(
        childEnv,
        fullEnv,
        selectedUrl,
        configHome,
        "store-third.json",
        artifacts,
        probe,
      ),
    ).rejects.toThrow("Portable Podman storage config alignment failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the automatic lane unchanged and rejects mismatched or linked storage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-store-guard-"));
  try {
    const configHome = path.join(root, "config");
    const artifacts = new ArtifactSink(path.join(root, "artifacts"));
    const selectedUrl = "unix:///run/user/1001/podman/podman.sock";
    const probe = vi.fn(() => ({
      graphRoot: "/private/graph",
      runRoot: "/private/run",
      ociRuntimePath: "/private/crun",
    }));
    await verifyPortablePodmanStoreAuthority(
      {},
      {},
      selectedUrl,
      configHome,
      "store-absent.json",
      artifacts,
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(configHome)).toBe(false);
    const source = path.join(root, "storage.conf");
    fs.writeFileSync(source, "[storage]\n");
    const linked = path.join(root, "linked-storage.conf");
    fs.symlinkSync(source, linked);
    await expect(
      verifyPortablePodmanStoreAuthority(
        { XDG_CONFIG_HOME: configHome },
        { CONTAINERS_STORAGE_CONF: linked },
        selectedUrl,
        configHome,
        "store-linked.json",
        artifacts,
        probe,
      ),
    ).rejects.toThrow("Portable Podman storage config alignment failed");
    const mismatched = vi
      .fn()
      .mockReturnValueOnce({
        graphRoot: "/private/other",
        runRoot: "/private/run",
        ociRuntimePath: "/private/crun",
      })
      .mockReturnValue({
        graphRoot: "/private/graph",
        runRoot: "/private/run",
        ociRuntimePath: "/private/crun",
      });
    await expect(
      verifyPortablePodmanStoreAuthority(
        { XDG_CONFIG_HOME: configHome },
        { CONTAINERS_STORAGE_CONF: source },
        selectedUrl,
        configHome,
        "store-mismatch.json",
        artifacts,
        mismatched,
      ),
    ).rejects.toThrow("Portable Podman store authority mismatch");
    const evidence = fs.readFileSync(artifacts.pathFor("store-mismatch.json"), "utf8");
    expect(JSON.parse(evidence)).toMatchObject({ category: "mismatch", childMatchesHost: false });
    expect(evidence).not.toContain("/private/other");
    const runtimeMismatch = vi
      .fn()
      .mockReturnValueOnce({
        graphRoot: "/private/graph",
        runRoot: "/private/run",
        ociRuntimePath: "/private/other-runtime",
      })
      .mockReturnValue({
        graphRoot: "/private/graph",
        runRoot: "/private/run",
        ociRuntimePath: "/private/crun",
      });
    await expect(
      verifyPortablePodmanStoreAuthority(
        { XDG_CONFIG_HOME: configHome },
        { CONTAINERS_STORAGE_CONF: source },
        selectedUrl,
        configHome,
        "runtime-mismatch.json",
        artifacts,
        runtimeMismatch,
      ),
    ).rejects.toThrow("Portable Podman store authority mismatch");
    const runtimeEvidence = fs.readFileSync(artifacts.pathFor("runtime-mismatch.json"), "utf8");
    expect(JSON.parse(runtimeEvidence)).toMatchObject({
      category: "mismatch",
      childMatchesHost: true,
      childMatchesHostRuntime: false,
    });
    expect(runtimeEvidence).not.toContain("/private/other-runtime");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("records fixed Podman failure category and build step without output (#13482)", async () => {
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
      diagnostic:
        "STEP 1/2: FROM private-base\nSTEP 2/2: RUN credential=private-build-token\nError: permission denied",
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
      observedBuildStep: "dockerfile-run",
    });
    expect(published).not.toContain("private-build-token");

    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: 1,
        signal: null,
        diagnostic: "STEP 1/2: FROM private-base\nError: credential=private-base-token",
      })),
    );
    const baseFailure = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(baseFailure)).toMatchObject({
      category: "unclassified",
      observedBuildStep: "base-image",
    });
    expect(baseFailure).not.toContain("private-base-token");
    expect(
      JSON.parse(
        fs.readFileSync(
          artifacts.pathFor("portable-sandbox-image-build-diagnostic-shape.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      stdoutObserved: null,
      stderrObserved: null,
      terminalErrorObserved: true,
      commitObserved: false,
      signals: [],
    });

    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: 1,
        signal: null,
        diagnostic: "STEP 1/24: FROM private-base\nSTEP 7/24: RUN credential=private-build-token",
      })),
    );
    const multiStepFailure = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(multiStepFailure)).toMatchObject({ observedBuildStep: "dockerfile-run" });
    expect(multiStepFailure).not.toContain("private-build-token");
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
      observedBuildStep: "unknown",
    });
  } finally {
    fetchRegistry.mockRestore();
    progress.stop();
    fs.rmSync(buildCtx, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("retains fixed build error signals without Dockerfile output or credentials (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-signals-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable build diagnostics", ["prepare", "build"], {
    logLine: () => undefined,
  });
  try {
    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: 1,
        signal: null,
        diagnostic:
          "STEP 1/2: FROM private-base\nSTEP 2/2: RUN credential=private-token\nError: building at STEP: while running runtime: crun: private-token",
        stdoutObserved: true,
        stderrObserved: true,
      })),
    );
    const diagnostic = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-diagnostic-shape.json"),
      "utf8",
    );
    expect(JSON.parse(diagnostic)).toEqual({
      schemaVersion: 1,
      stdoutObserved: true,
      stderrObserved: true,
      terminalErrorObserved: true,
      commitObserved: false,
      signals: ["runtime"],
    });
    expect(diagnostic).not.toContain("private-token");
    expect(diagnostic).not.toContain("private-base");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("probes only a cached base with no pull or network and redacts child output (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oci-probe-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable OCI probe", ["prepare", "diagnose"], {
    logLine: () => undefined,
  });
  const result = (status: number, diagnostic = "") => ({ status, signal: null, diagnostic });
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce(result(0))
    .mockResolvedValueOnce(result(1, "credential=private-token"))
    .mockResolvedValueOnce(result(0));
  try {
    await probePortableSandboxOciAfterBuildFailure(
      "docker.io/library/ubuntu@sha256:fixed",
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
      artifacts,
      progress,
      runCommand,
    );
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(runCommand.mock.calls[0]?.[0]).toEqual([
      "image",
      "exists",
      "docker.io/library/ubuntu@sha256:fixed",
    ]);
    const runArgs = runCommand.mock.calls[1]?.[0] as string[];
    expect(runArgs.slice(0, 5)).toEqual([
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--name",
    ]);
    expect(runArgs.slice(6)).toEqual(["docker.io/library/ubuntu@sha256:fixed", "/bin/true"]);
    expect(runCommand.mock.calls[2]?.[0]).toEqual(["rm", "--force", "--ignore", runArgs[5]]);
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual([
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
      { XDG_CONFIG_HOME: "/private/config", API_KEY: "private-token" },
    ]);
    const evidence = fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8");
    expect(JSON.parse(evidence)).toEqual({
      schemaVersion: 1,
      category: "oci-execution-failed",
      baseImageCached: true,
      runStatus: 1,
      cleanupSucceeded: true,
    });
    expect(evidence).not.toContain("private-token");
    expect(evidence).not.toContain("/private/config");
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("skips OCI execution when the pinned base is absent (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oci-absent-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable OCI probe", ["prepare", "diagnose"], {
    logLine: () => undefined,
  });
  const runCommand = vi.fn().mockResolvedValue({ status: 1, signal: null, diagnostic: "" });
  try {
    await probePortableSandboxOciAfterBuildFailure(
      "pinned-base",
      {},
      artifacts,
      progress,
      runCommand,
    );
    expect(runCommand).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "base-image-absent", baseImageCached: false, runStatus: null });
    const queryFailed = vi.fn().mockResolvedValue({ status: 125, signal: null, diagnostic: "" });
    await probePortableSandboxOciAfterBuildFailure(
      "pinned-base",
      {},
      artifacts,
      progress,
      queryFailed,
    );
    expect(queryFailed).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "image-query-failed", baseImageCached: null, runStatus: null });
  } finally {
    progress.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("records a passing OCI probe and fails closed when exact cleanup is unproved (#13482)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oci-cleanup-"));
  const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
  const progress = startTestProgress("portable OCI probe", ["prepare", "diagnose"], {
    logLine: () => undefined,
  });
  const result = (status: number) => ({ status, signal: null, diagnostic: "" });
  try {
    const passing = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0));
    await probePortableSandboxOciAfterBuildFailure("pinned-base", {}, artifacts, progress, passing);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "oci-execution-passed", cleanupSucceeded: true });

    const cleanupFailed = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(125));
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        cleanupFailed,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(cleanupFailed).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "cleanup-unproved", cleanupSucceeded: false });

    const timedOut = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce({
        status: null,
        signal: "SIGKILL",
        diagnostic: "credential=private-token",
        error: Object.assign(new Error("private timeout"), { code: "ETIMEDOUT" }),
      })
      .mockResolvedValueOnce(result(0));
    await probePortableSandboxOciAfterBuildFailure(
      "pinned-base",
      {},
      artifacts,
      progress,
      timedOut,
    );
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "oci-execution-timeout", cleanupSucceeded: true });
    expect(
      fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8"),
    ).not.toContain("private-token");

    const unreconciled = {
      status: null,
      signal: "SIGKILL",
      diagnostic: "credential=private-token",
      error: Object.assign(new Error("private child survived"), { code: "EUNRECONCILED" }),
    };
    const queryUnreconciled = vi.fn().mockResolvedValue(unreconciled);
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        queryUnreconciled,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(queryUnreconciled).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "cleanup-unproved", cleanupSucceeded: false });

    const runUnreconciled = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(unreconciled)
      .mockResolvedValueOnce(result(0));
    await expect(
      probePortableSandboxOciAfterBuildFailure(
        "pinned-base",
        {},
        artifacts,
        progress,
        runUnreconciled,
      ),
    ).rejects.toThrow("Portable sandbox OCI probe cleanup unproved");
    expect(runUnreconciled).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(fs.readFileSync(artifacts.pathFor("portable-sandbox-oci-probe.json"), "utf8")),
    ).toMatchObject({ category: "cleanup-unproved", cleanupSucceeded: false });
  } finally {
    progress.stop();
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
      observedBuildStep: "unknown",
    });
    expect(published).not.toContain("private-build-token");
    expect(published).not.toContain("private error text");

    await buildPortableSandboxImageWithEvidence(
      ["build", "-t", "localhost/test:fixed", "."],
      { env: {}, stdio: "inherit" },
      artifacts,
      progress,
      vi.fn(async () => ({
        status: null,
        signal: "SIGKILL" as const,
        diagnostic: "credential=private-build-token",
        error: Object.assign(new Error("private error text"), { code: "EUNRECONCILED" }),
      })),
    );
    const unreconciled = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-build-failure.json"),
      "utf8",
    );
    expect(JSON.parse(unreconciled)).toMatchObject({
      errorCode: "EUNRECONCILED",
      category: "process-isolation",
    });
    expect(unreconciled).not.toContain("private-build-token");
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
          publishPortableSandboxImage(args, options, artifacts, progress, runPublish),
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
    const publication = fs.readFileSync(
      artifacts.pathFor("portable-sandbox-image-publish-failure.json"),
      "utf8",
    );
    expect(JSON.parse(publication)).toMatchObject({
      schemaVersion: 1,
      status: 125,
      signal: null,
      errorCode: null,
      category: "unclassified",
      observedBuildStep: "unknown",
    });
    expect(publication).not.toContain("private-push-token");
  } finally {
    fetchRegistry.mockRestore();
    progress.stop();
    fs.rmSync(buildCtx, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
