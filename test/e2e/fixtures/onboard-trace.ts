// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ArtifactSink } from "./artifacts.ts";
import { REPO_ROOT } from "./paths.ts";
import type { TestProgress } from "./progress.ts";
import { ShellProbe, trustedShellCommand } from "./shell-probe.ts";

const SUMMARY = "cloud-onboard-trace-timing-summary.json";

/** Keep raw traces outside upload roots for the lifetime of an opt-in fixture. */
export async function withOnboardTrace(
  artifacts: ArtifactSink,
  progress: TestProgress,
  use: (environment: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "nemoclaw-onboard-trace-"));
  const raw = path.join(directory, "raw");
  const sanitized = path.join(directory, "sanitized");
  const failures: unknown[] = [];
  try {
    const uploadRoot = await realpath(process.env.E2E_ARTIFACT_DIR ?? artifacts.rootDir);
    const privateRoot = await realpath(directory);
    if (privateRoot === uploadRoot || privateRoot.startsWith(`${uploadRoot}${path.sep}`)) {
      throw new Error("Raw onboard traces must remain outside the artifact upload root");
    }
    try {
      await use({ NEMOCLAW_TRACE_DIR: raw });
    } catch (error) {
      failures.push(error);
    }
    // The existing reducer owns the publication allowlist for cloud and deferred runs.
    const probe = new ShellProbe({
      artifacts,
      progress,
      redact: (text) => artifacts.redact(text),
      // Finalize evidence under its own deadline even after the test aborts.
      signal: new AbortController().signal,
    });
    const result = await probe
      .run(
        trustedShellCommand({
          command: "python3",
          args: [path.join(REPO_ROOT, "scripts/e2e/sanitize-trace-timing.py"), raw, sanitized],
          reason: "Reduce private onboard traces before artifact publication",
        }),
        {
          timeoutMs: 10_000,
          captureLimitBytes: 64 * 1024,
          env: { PATH: process.env.PATH },
          artifactName: "onboard-trace-sanitizer",
          persistArtifacts: false,
        },
      )
      .catch(() => undefined);
    if (!result || result.exitCode !== 0 || result.timedOut || result.signal !== null) {
      // Subprocess stderr can contain untrusted trace paths; do not publish it.
      throw new Error("Onboard trace sanitization failed");
    }
    const content = await readFile(path.join(sanitized, SUMMARY), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    const filename = content === undefined ? "onboard-trace-capture.json" : SUMMARY;
    const value = content === undefined ? { status: "unavailable" } : JSON.parse(content);
    const published = await artifacts.writeJson(filename, value);
    await chmod(published, 0o600);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Onboard trace finalization failed", { cause: failures[0] });
  }
}
