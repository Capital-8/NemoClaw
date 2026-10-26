// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";
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
};

type ImageCommandRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
) => Promise<BuildResult>;

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
  const appendDiagnostic = (chunk: string) => {
    // Dockerfile steps can print credentials. Keep only a bounded in-memory tail.
    diagnostic = (diagnostic + chunk).slice(-DIAGNOSTIC_TAIL_CHARS);
  };
  const result = await superviseChild(child, {
    timeoutMs,
    killGraceMs: 0,
    postKillOutputDrainMs: POST_KILL_OUTPUT_DRAIN_MS,
    onStdout: appendDiagnostic,
    onStderr: appendDiagnostic,
  });
  const error = result.cleanupError
    ? Object.assign(new Error("Podman build group was not reconciled"), { code: "EUNRECONCILED" })
    : result.timedOut
      ? Object.assign(new Error("Podman image command timed out"), { code: "ETIMEDOUT" })
      : result.spawnError;
  return { status: result.exitCode, signal: result.signal, diagnostic, error };
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
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    await artifacts.writeJson("portable-sandbox-image-build-failure.json", {
      schemaVersion: 1,
      status: result.status,
      signal: result.signal,
      errorCode: errorCode && SAFE_ERROR_CODES.has(errorCode) ? errorCode : null,
      category:
        errorCode === "EUNRECONCILED" ? "process-isolation" : failureCategory(result.diagnostic),
      observedBuildStep: observedBuildStep(result.diagnostic),
    });
  }
  return result.error ? null : result.status;
}

/** Keep registry publication separate from build-failure evidence. */
export async function publishPortableSandboxImage(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  progress: TestProgress,
  runPublish: ImageCommandRunner = runPodmanBuild,
): Promise<number | null> {
  const result = await runPublish(args, options.env, PORTABLE_IMAGE_COMMAND_TIMEOUT_MS, progress);
  return result.error ? null : result.status;
}
