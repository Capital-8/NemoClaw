// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { superviseChild } from "../../helpers/process-supervisor.ts";
import { spawnObservedChild } from "./observed-child-process.ts";
import type { TestProgress } from "./progress.ts";

export const PORTABLE_IMAGE_COMMAND_TIMEOUT_MS = 6 * 60_000;
export const PORTABLE_GATEWAY_STARTUP_BUDGET_MS = 15_000;
export const PORTABLE_SANDBOX_CREATE_BUDGET_MS = 240_000;
export const PORTABLE_HERMES_LIFECYCLE_BUDGET_MS = 2 * 240_000 + 2 * (60_000 + 30_000);
export const PORTABLE_SANDBOX_DELETE_BUDGET_MS = 60_000;
export const PORTABLE_ASSERTION_CLEANUP_RESERVE_MS = 6 * 60_000;
// Two prebuilds each build and publish; preserve the existing gateway, create,
// two public starts and stops, deletion, and assertion/cleanup allowances.
export const PORTABLE_PROFILE_LIVE_TIMEOUT_MS =
  4 * PORTABLE_IMAGE_COMMAND_TIMEOUT_MS +
  PORTABLE_GATEWAY_STARTUP_BUDGET_MS +
  PORTABLE_SANDBOX_CREATE_BUDGET_MS +
  PORTABLE_HERMES_LIFECYCLE_BUDGET_MS +
  PORTABLE_SANDBOX_DELETE_BUDGET_MS +
  PORTABLE_ASSERTION_CLEANUP_RESERVE_MS;
const DIAGNOSTIC_TAIL_CHARS = 8_192;
const POST_KILL_OUTPUT_DRAIN_MS = 1_000;
const SAFE_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM", "ETIMEDOUT", "EUNRECONCILED"]);
type BuildResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
  error?: Error;
  stdoutObserved?: boolean;
  stderrObserved?: boolean;
};

type ImageCommandRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
) => Promise<BuildResult>;

type StoreIdentity = { graphRoot: string; runRoot: string };
type StoreProbe = (env: NodeJS.ProcessEnv, selectedUrl?: string) => StoreIdentity;

function alignPrivatePodmanStorage(configHome: string, env: NodeJS.ProcessEnv): boolean {
  const source = env.CONTAINERS_STORAGE_CONF;
  if (!source) return false;
  const destination = path.join(configHome, "containers", "storage.conf");
  const noFollow = fs.constants.O_NOFOLLOW;
  try {
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    let contents: Buffer;
    try {
      const sourceStat = fs.fstatSync(sourceFd);
      if (!sourceStat.isFile() || sourceStat.size > 65_536) throw new Error("invalid source");
      contents = fs.readFileSync(sourceFd);
    } finally {
      fs.closeSync(sourceFd);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    let destinationFd: number;
    try {
      destinationFd = fs.openSync(
        destination,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      try {
        fs.writeFileSync(destinationFd, contents);
      } finally {
        fs.closeSync(destinationFd);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      destinationFd = fs.openSync(destination, fs.constants.O_RDONLY | noFollow);
      try {
        const destinationStat = fs.fstatSync(destinationFd);
        if (
          !destinationStat.isFile() ||
          (destinationStat.mode & 0o777) !== 0o600 ||
          !fs.readFileSync(destinationFd).equals(contents)
        ) {
          throw new Error("existing config differs");
        }
      } finally {
        fs.closeSync(destinationFd);
      }
    }
    return true;
  } catch {
    throw new Error("Portable Podman storage config alignment failed");
  }
}

export function probePodmanStore(
  env: NodeJS.ProcessEnv,
  selectedUrl?: string,
  runInfo: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    status: number | null;
    stdout: string;
    error?: Error;
  } = (args, selectedEnv) =>
    spawnSync("podman", args, {
      env: selectedEnv,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
    }),
): StoreIdentity {
  const result = runInfo(
    selectedUrl ? ["--url", selectedUrl, "info", "--format", "json"] : ["info", "--format", "json"],
    env,
  );
  if (result.error || result.status !== 0) throw new Error("probe");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("parse");
  }
  const store = (parsed as { store?: Partial<StoreIdentity> })?.store;
  if (
    typeof store?.graphRoot !== "string" ||
    !store.graphRoot ||
    typeof store.runRoot !== "string" ||
    !store.runRoot
  ) {
    throw new Error("missing-field");
  }
  return { graphRoot: store.graphRoot, runRoot: store.runRoot };
}

/** Compare only fixed store fields; never publish Podman paths or command output. */
export async function verifyPortablePodmanStoreAuthority(
  childEnv: NodeJS.ProcessEnv,
  fullEnv: NodeJS.ProcessEnv,
  selectedUrl: string,
  configHome: string,
  artifactName: string,
  artifacts: ArtifactSink,
  probe: StoreProbe = probePodmanStore,
): Promise<void> {
  if (fullEnv.CONTAINERS_STORAGE_CONF && (!configHome || childEnv.XDG_CONFIG_HOME !== configHome)) {
    throw new Error("Portable Podman storage config alignment failed");
  }
  if (!alignPrivatePodmanStorage(configHome, fullEnv)) return;
  let category = "match";
  let childMatchesHost: boolean | null = null;
  let hostMatchesService: boolean | null = null;
  try {
    if (!selectedUrl.startsWith("unix:///")) throw new Error("probe");
    const child = probe(childEnv);
    const host = probe(fullEnv);
    const service = probe(fullEnv, selectedUrl);
    childMatchesHost = child.graphRoot === host.graphRoot && child.runRoot === host.runRoot;
    hostMatchesService = host.graphRoot === service.graphRoot && host.runRoot === service.runRoot;
    if (!childMatchesHost || !hostMatchesService) throw new Error("mismatch");
  } catch (cause) {
    category = ["probe", "parse", "missing-field", "mismatch"].includes((cause as Error).message)
      ? (cause as Error).message
      : "probe";
  }
  await artifacts.writeJson(artifactName, {
    schemaVersion: 1,
    category,
    childMatchesHost,
    hostMatchesService,
  });
  if (category !== "match") throw new Error(`Portable Podman store authority ${category}`);
}

async function runPodmanBuild(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
): Promise<BuildResult> {
  let child: ReturnType<typeof spawnObservedChild>;
  try {
    child = spawnObservedChild("podman", args, {
      activityLabel:
        args[0] === "push"
          ? "command: portable-sandbox-image-publish"
          : "command: portable-sandbox-image-build",
      progress,
      spawn: { env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true },
    });
  } catch (cause) {
    return {
      status: null,
      signal: null,
      diagnostic: "",
      error: cause instanceof Error ? cause : new Error("Podman image command could not start"),
    };
  }
  let diagnostic = "";
  let stdoutObserved = false;
  let stderrObserved = false;
  const appendDiagnostic = (chunk: string) => {
    // Dockerfile steps can print credentials. Keep only a bounded in-memory tail.
    diagnostic = (diagnostic + chunk).slice(-DIAGNOSTIC_TAIL_CHARS);
  };
  const result = await superviseChild(child, {
    timeoutMs,
    killGraceMs: 0,
    postKillOutputDrainMs: POST_KILL_OUTPUT_DRAIN_MS,
    onStdout: (chunk) => {
      stdoutObserved ||= chunk.length > 0;
      appendDiagnostic(chunk);
    },
    onStderr: (chunk) => {
      stderrObserved ||= chunk.length > 0;
      appendDiagnostic(chunk);
    },
  });
  const error = result.cleanupError
    ? Object.assign(new Error("Podman build group was not reconciled"), { code: "EUNRECONCILED" })
    : result.timedOut
      ? Object.assign(new Error("Podman image command timed out"), { code: "ETIMEDOUT" })
      : result.spawnError;
  return {
    status: result.exitCode,
    signal: result.signal,
    diagnostic,
    error,
    stdoutObserved,
    stderrObserved,
  };
}

function failureCategory(output: string): string {
  const diagnostic = output.slice(-8_192).toLowerCase();
  if (/no space left on device|enospc/u.test(diagnostic)) return "disk-full";
  if (/permission denied|operation not permitted|eacces|eperm/u.test(diagnostic))
    return "permission";
  if (
    /connection refused|connection reset|network is unreachable|timed out|timeout/u.test(diagnostic)
  )
    return "network";
  if (/unauthorized|authentication required|denied: requested access/u.test(diagnostic))
    return "registry-auth";
  if (/manifest unknown|pull access denied|failed to resolve source metadata/u.test(diagnostic))
    return "base-image-unavailable";
  if (
    /no such file or directory|not found in build context|failed to calculate checksum/u.test(
      diagnostic,
    )
  )
    return "build-context";
  if (/cgroup|pids[.]max|clone3/u.test(diagnostic)) return "process-isolation";
  if (/overlay|storage|mount/u.test(diagnostic)) return "storage";
  return "unclassified";
}

function observedBuildStep(output: string): "base-image" | "dockerfile-run" | "unknown" {
  const stepLines = [...output.matchAll(/^STEP [1-9]\d*\/[1-9]\d*: (FROM|RUN)\b/gmu)];
  const lastStep = stepLines.at(-1)?.[1];
  if (lastStep === "FROM") return "base-image";
  if (lastStep === "RUN") return "dockerfile-run";
  return "unknown";
}

function fixedFailureEvidence(result: BuildResult) {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    schemaVersion: 1,
    status: result.status,
    signal: result.signal,
    errorCode: errorCode && SAFE_ERROR_CODES.has(errorCode) ? errorCode : null,
    category:
      errorCode === "EUNRECONCILED" ? "process-isolation" : failureCategory(result.diagnostic),
    observedBuildStep: observedBuildStep(result.diagnostic),
  };
}

function fixedBuildDiagnosticShape(result: BuildResult) {
  const tail = result.diagnostic.slice(-DIAGNOSTIC_TAIL_CHARS);
  const terminalErrors = tail
    .split(/\r?\n/u)
    .filter((line) => /^\s*(?:error|fatal):|\blevel=error\b/iu.test(line))
    .slice(-4)
    .join("\n")
    .toLowerCase();
  const patterns = [
    ["runtime", /\b(?:oci runtime|crun|runc|runtime)\b/u],
    ["container", /\b(?:build container|container create|creating container)\b/u],
    ["commit", /\b(?:commit|committing|writing manifest)\b/u],
    ["storage", /\b(?:overlay|storage|mount|graphroot)\b/u],
    ["bus", /\b(?:dbus|d-bus|bus address|systemd)\b/u],
    ["namespace", /\b(?:userns|user namespace|subuid|subgid)\b/u],
    ["network", /\b(?:network|connection|dial tcp)\b/u],
    ["registry", /\b(?:registry|manifest|pull)\b/u],
    ["exec", /\b(?:exec|executable|process)\b/u],
  ] as const;
  return {
    schemaVersion: 1,
    stdoutObserved: result.stdoutObserved ?? null,
    stderrObserved: result.stderrObserved ?? null,
    terminalErrorObserved: terminalErrors.length > 0,
    commitObserved: /^COMMIT\b/mu.test(tail),
    signals: patterns.filter(([, pattern]) => pattern.test(terminalErrors)).map(([name]) => name),
  };
}

/** Keep only fixed failure categories from the fixed live build. */
export async function buildPortableSandboxImageWithEvidence(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  artifacts: ArtifactSink,
  progress: TestProgress,
  runBuild: ImageCommandRunner = runPodmanBuild,
): Promise<number | null> {
  const result = await runBuild(args, options.env, PORTABLE_IMAGE_COMMAND_TIMEOUT_MS, progress);
  if (result.status !== 0 || result.error) {
    await artifacts.writeJson(
      "portable-sandbox-image-build-failure.json",
      fixedFailureEvidence(result),
    );
    if (failureCategory(result.diagnostic) === "unclassified") {
      await artifacts.writeJson(
        "portable-sandbox-image-build-diagnostic-shape.json",
        fixedBuildDiagnosticShape(result),
      );
    }
  }
  return result.error ? null : result.status;
}

/** Use the exact filtered child environment passed by the production prebuild callback. */
export function portableSandboxImageBuilder(
  artifacts: ArtifactSink,
  progress: TestProgress,
  selectedUrl: string,
) {
  return (label: "sandbox" | "hermes") =>
    async (args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: "inherit" }) => {
      await verifyPortablePodmanStoreAuthority(
        options.env,
        process.env,
        selectedUrl,
        options.env.XDG_CONFIG_HOME ?? "",
        `portable-podman-store-${label}.json`,
        artifacts,
      );
      return buildPortableSandboxImageWithEvidence(args, options, artifacts, progress);
    };
}

/** Keep registry publication separate from build-failure evidence. */
export async function publishPortableSandboxImage(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  artifacts: ArtifactSink,
  progress: TestProgress,
  runPublish: ImageCommandRunner = runPodmanBuild,
): Promise<number | null> {
  const result = await runPublish(args, options.env, PORTABLE_IMAGE_COMMAND_TIMEOUT_MS, progress);
  if (result.status !== 0 || result.error) {
    await artifacts.writeJson(
      "portable-sandbox-image-publish-failure.json",
      fixedFailureEvidence(result),
    );
  }
  return result.error ? null : result.status;
}
