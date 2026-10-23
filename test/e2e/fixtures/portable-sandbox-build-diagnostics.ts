// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import type { ArtifactSink } from "./artifacts.ts";

const BUILD_TIMEOUT_MS = 4 * 60_000;
const DIAGNOSTIC_TAIL_CHARS = 8_192;
const SAFE_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM", "ETIMEDOUT"]);
type BuildResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
  error?: Error;
};

type BuildRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => BuildResult;

function runPodmanBuild(args: readonly string[], env: NodeJS.ProcessEnv): BuildResult {
  const result = spawnSync("podman", [...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  // Keep raw build output in memory only because Dockerfile steps can print credentials.
  return {
    status: result.status,
    signal: result.signal,
    diagnostic: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-DIAGNOSTIC_TAIL_CHARS),
    error: result.error,
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

/** Keep only fixed failure categories from the fixed live build. */
export async function buildPortableSandboxImageWithEvidence(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  artifacts: ArtifactSink,
  runBuild: BuildRunner = runPodmanBuild,
): Promise<number | null> {
  const result = runBuild(args, options.env);
  if (result.status !== 0 || result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    await artifacts.writeJson("portable-sandbox-image-build-failure.json", {
      schemaVersion: 1,
      status: result.status,
      signal: result.signal,
      errorCode: errorCode && SAFE_ERROR_CODES.has(errorCode) ? errorCode : null,
      category: failureCategory(result.diagnostic),
    });
  }
  return result.status;
}
