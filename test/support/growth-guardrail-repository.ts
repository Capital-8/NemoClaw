// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RETAINED_TEST = "test/retained.test.ts";
export const BUDGET = "ci/e2e-assertion-budget.json";
export const POLICY = "ci/e2e-assertion-growth-exceptions.json";

export function assertionBudget(count: number): string {
  const metrics = {
    expectCalls: count,
    matcherAssertions: count,
    nodeAssertions: 0,
    namedAssertionHelpers: 0,
    failCalls: 0,
    throwGuards: 0,
    objectFieldAssertions: 0,
    assertionPoints: count,
    generatedProbeBlocks: 0,
    generatedProbeConditions: 0,
  };
  return JSON.stringify({
    $comment: "fixture",
    schemaVersion: 1,
    issue: 10934,
    epic: 10920,
    reference: {
      mainSha: "a".repeat(40),
      currentMainCollectedTests: 1,
      epicMainSha: "b".repeat(40),
      epicCollectedTests: 1,
      epicDirectExpectCalls: 2,
      epicLiveExpectCalls: 2,
    },
    limits: {
      testFileCount: 1,
      liveFileCount: 1,
      direct: metrics,
      unique: metrics,
      fileMetricOrder: [
        "directExpectCalls",
        "directAssertionPoints",
        "transitiveExpectCalls",
        "transitiveAssertionPoints",
        "transitiveGeneratedProbeBlocks",
      ],
      files: { "test/e2e/live/example.test.ts": [count, count, count, count, 0] },
    },
  });
}

export class GrowthRepository {
  readonly directory = mkdtempSync(path.join(os.tmpdir(), "growth-diff-"));
  readonly origin = path.join(this.directory, "origin");
  readonly checkout = path.join(this.directory, "checkout");
  readonly ancestor: string;

  constructor() {
    mkdirSync(this.origin);
    this.git(this.origin, "init", "--initial-branch=main");
    this.write(RETAINED_TEST, "if (true) {}\n");
    this.write(BUDGET, assertionBudget(2));
    this.write(POLICY, JSON.stringify({ schemaVersion: 1, exceptions: [] }));
    this.ancestor = this.commit("common ancestor");
    this.git(this.origin, "branch", "candidate");
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Growth Fixture",
        "-c",
        "user.email=growth@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  write(file: string, content: string): void {
    const target = path.join(this.origin, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  commit(message: string): string {
    this.git(this.origin, "add", ".");
    this.git(this.origin, "commit", "--allow-empty", "-m", message);
    return this.git(this.origin, "rev-parse", "HEAD");
  }

  reduceBase(): string {
    this.write(RETAINED_TEST, "// base removed a conditional\n");
    this.write(BUDGET, assertionBudget(1));
    return this.commit("base-only ratchet reduction");
  }

  startCandidate(): void {
    this.git(this.origin, "checkout", "candidate");
  }

  cloneBase(depth: "full" | "shallow" = "full"): void {
    this.git(this.origin, "update-ref", "refs/pull/1/head", "candidate");
    this.git(
      this.directory,
      "clone",
      "--no-local",
      "--branch",
      "main",
      ...(depth === "shallow" ? ["--depth=1"] : []),
      pathToFileURL(this.origin).href,
      this.checkout,
    );
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
