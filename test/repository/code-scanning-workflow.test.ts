// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow } from "../helpers/e2e-workflow-contract";

const workflow = readYaml<Workflow>(".github/workflows/code-scanning.yaml");
const shellcheckSteps = workflow.jobs.shellcheck?.steps ?? [];

function requiredStep(name: string) {
  const step = shellcheckSteps.find((candidate) => candidate.name === name);
  assert(step, `ShellCheck workflow is missing step: ${name}`);
  return step;
}

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function runShellCheckInstall({
  aptUpdateSucceeds = true,
  installedSupportsJson1 = true,
  preinstalledSupportsJson1,
}: {
  aptUpdateSucceeds?: boolean;
  installedSupportsJson1?: boolean;
  preinstalledSupportsJson1: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shellcheck-install-"));
  const bin = path.join(root, "bin");
  const trace = path.join(root, "trace");
  const installedMarker = path.join(root, "installed");
  fs.mkdirSync(bin);
  writeExecutable(
    path.join(bin, "shellcheck"),
    `#!/bin/sh
printf 'shellcheck:%s\\n' "$*" >> "$TRACE"
case "$*" in
  *--format=json1*)
    [ "$PREINSTALLED_SUPPORTS_JSON1" = "true" ] ||
      { [ -f "$INSTALLED_MARKER" ] && [ "$INSTALLED_SUPPORTS_JSON1" = "true" ]; }
    ;;
  --version)
    printf 'version: 0.11.0\\n'
    ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "sudo"),
    `#!/bin/sh
printf 'sudo:%s\\n' "$*" >> "$TRACE"
case "$*" in
  *" update")
    [ "$APT_UPDATE_SUCCEEDS" = "true" ]
    ;;
  *" install -y shellcheck")
    : > "$INSTALLED_MARKER"
    ;;
esac
`,
  );
  const install = requiredStep("Install ShellCheck");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", install.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      APT_UPDATE_SUCCEEDS: String(aptUpdateSucceeds),
      PATH: `${bin}:${process.env.PATH}`,
      INSTALLED_MARKER: installedMarker,
      INSTALLED_SUPPORTS_JSON1: String(installedSupportsJson1),
      PREINSTALLED_SUPPORTS_JSON1: String(preinstalledSupportsJson1),
      RUNNER_TEMP: root,
      TRACE: trace,
    },
  });
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n");
  fs.rmSync(root, { recursive: true, force: true });
  return { calls, result };
}

describe("ShellCheck SARIF workflow boundary", () => {
  // source-shape-contract: security -- ShellCheck conversion must install npm from an immutable reviewed action before executing the trusted converter
  it("installs npm from the immutable reviewed action bootstrap", () => {
    expect(requiredStep("Install reviewed npm").uses).toBe(
      "NVIDIA/NemoClaw/.github/actions/setup-reviewed-npm@98669f24d35f18e49b6b2769cd68709509ea24f2",
    );
  });

  it("keeps a preinstalled ShellCheck only when its json1 formatter works (#7684)", () => {
    const { calls, result } = runShellCheckInstall({ preinstalledSupportsJson1: true });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "shellcheck:--version",
    ]);
  });

  it("installs and validates ShellCheck when the preinstalled binary lacks json1 (#7684)", () => {
    const { calls, result } = runShellCheckInstall({ preinstalledSupportsJson1: false });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y shellcheck",
      expect.stringContaining("shellcheck:--format=json1"),
      "shellcheck:--version",
    ]);
  });

  it("fails clearly when the bounded ShellCheck package-index update fails (#7684)", () => {
    const { calls, result } = runShellCheckInstall({
      aptUpdateSucceeds: false,
      preinstalledSupportsJson1: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to update apt package indexes for ShellCheck");
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
    ]);
  });

  it("rejects an installed ShellCheck without json1 support (#7684)", () => {
    const { calls, result } = runShellCheckInstall({
      installedSupportsJson1: false,
      preinstalledSupportsJson1: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Installed ShellCheck does not support --format=json1");
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y shellcheck",
      expect.stringContaining("shellcheck:--format=json1"),
    ]);
  });
});

const partitionJob = workflow.jobs["codeql-javascript"]!;
const partitionAggregate = workflow.jobs["codeql-javascript-complete"]!;
const partitionRows = partitionJob.strategy!.matrix!.include as {
  partition: string;
  config: string;
}[];

function partitionStep(owner: typeof partitionJob, name: string) {
  const step = owner.steps?.find((candidate) => candidate.name === name);
  assert(step, `CodeQL workflow is missing step: ${name}`);
  return step;
}

function exercisePartitionIdentities(
  mutate: (directory: string) => void = () => {},
  expectedAttempt = "1",
  rewriteConfiguration: (configuration: string) => string = (configuration) => configuration,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-codeql-partitions-"));
  const received = path.join(root, "received");
  fs.mkdirSync(received);
  try {
    const identities: { pattern: string; filter: string }[] = [];
    for (const row of partitionRows) {
      const producer = path.join(root, row.partition);
      fs.mkdirSync(producer);
      const recorded = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          partitionStep(partitionJob, "Record query partition identity").run!,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: producer,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            PARTITION: row.partition,
            QUERY_CONFIGURATION: rewriteConfiguration(row.config),
            CODEQL_VERSION: "2.27.3",
            SOURCE_REVISION: "a".repeat(40),
            CHECKOUT_REVISION: "b".repeat(40),
            QUERY_SUITE: partitionJob.env!.QUERY_SUITE!,
            QUERY_LANGUAGE: partitionJob.env!.QUERY_LANGUAGE!,
          },
        },
      );
      assert.equal(recorded.status, 0, recorded.stderr);
      identities.push(
        JSON.parse(
          fs.readFileSync(
            path.join(producer, "codeql-js-partition", row.partition + ".json"),
            "utf8",
          ),
        ),
      );
      fs.cpSync(
        path.join(producer, "codeql-js-partition"),
        path.join(received, `codeql-js-partition-123-1-${row.partition}`),
        { recursive: true },
      );
    }
    mutate(received);
    const verified = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        partitionStep(partitionAggregate, "Verify complete query partition identities").run!,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          PARTITION_DIRECTORY: received,
          EXPECTED_RUN_ID: "123",
          EXPECTED_RUN_ATTEMPT: expectedAttempt,
          EXPECTED_SOURCE_REVISION: "a".repeat(40),
          EXPECTED_CHECKOUT_REVISION: "b".repeat(40),
          EXPECTED_PATTERN: partitionAggregate.steps!.at(-1)!.env!.EXPECTED_PATTERN!,
        },
      },
    );
    return Object.assign(verified, { identities });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rewriteOtherIdentity(directory: string, key: string, value: unknown) {
  const file = path.join(directory, "codeql-js-partition-123-1-other/other.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt[key] = value;
  fs.writeFileSync(file, JSON.stringify(receipt));
}

describe("Complete CodeQL query partition qualification", () => {
  it.each([
    ["js/code-injection", "include"],
    ["js/log-injection", "include"],
    ["js/sql-injection", "exclude"],
    ["js/xss", "exclude"],
    ["future/new-query", "exclude"],
  ] as const)("selects %s in exactly one complementary query partition", (id, expectedFilter) => {
    const result = exercisePartitionIdentities();
    expect(result.status, result.stderr).toBe(0);
    const selected = (id: string) =>
      result.identities.filter((identity) => {
        const matches = new RegExp(identity.pattern.slice(1, -1)).test(id);
        return identity.filter === "include" ? matches : !matches;
      });
    expect(selected(id)).toHaveLength(1);
    expect(selected(id)[0]!.filter).toBe(expectedFilter);
  });

  it.each(["paths-ignore", "queries"])("rejects a configuration that adds %s", (field) => {
    expect(() =>
      exercisePartitionIdentities(
        () => {},
        "1",
        (configuration) => {
          const changed = JSON.parse(configuration);
          changed[field] = ["unreviewed-selection"];
          return JSON.stringify(changed);
        },
      ),
    ).toThrow("CodeQL query configuration cannot change the source or suite");
  });

  it("accepts the actual producer records from both complementary partitions", () => {
    const result = exercisePartitionIdentities();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Complete security-and-quality query suite passed");
  });

  it.each(["failure", "cancelled", "skipped"])(
    "rejects a %s partition before accepting any artifacts",
    (status) => {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          partitionStep(partitionAggregate, "Require every query partition to succeed").run!,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH, PARTITION_RESULT: status } },
      );
      expect(result.status).toBe(1);
    },
  );

  it.each([
    ["codeqlVersion", "2.28.0", "different CLI versions"],
    ["sourceRevision", "c".repeat(40), "identity changed"],
    ["checkoutRevision", "c".repeat(40), "identity changed"],
    ["filter", "include", "identity changed"],
    ["runId", "124", "identity changed"],
    ["runAttempt", 2, "identity changed"],
  ] as const)("rejects a substituted %s", (key, value, message) => {
    const result = exercisePartitionIdentities((directory) =>
      rewriteOtherIdentity(directory, key, value),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("rejects missing partition evidence", () => {
    const result = exercisePartitionIdentities((directory) => {
      fs.rmSync(path.join(directory, "codeql-js-partition-123-1-other"), { recursive: true });
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("identities are missing");
  });

  it("rejects a symbolic-link identity", () => {
    const result = exercisePartitionIdentities((directory) => {
      const file = path.join(directory, "codeql-js-partition-123-1-other/other.json");
      const target = path.join(directory, "codeql-js-partition-123-1-other/held.json");
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or ambiguous");
  });

  it("accepts aggregate-only reruns of the same immutable run", () => {
    const result = exercisePartitionIdentities(() => {}, "2");
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts a successful partial rerun with the same source and CLI", () => {
    const result = exercisePartitionIdentities((directory) => {
      const source = path.join(directory, "codeql-js-partition-123-1-other");
      const target = path.join(directory, "codeql-js-partition-123-2-other");
      fs.cpSync(source, target, { recursive: true });
      const file = path.join(target, "other.json");
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      receipt.runAttempt = 2;
      fs.writeFileSync(file, JSON.stringify(receipt));
    }, "2");
    expect(result.status, result.stderr).toBe(0);
  });

  it("does not fall back to an older matching CLI after a changed-version rerun", () => {
    const result = exercisePartitionIdentities((directory) => {
      const source = path.join(directory, "codeql-js-partition-123-1-other");
      const target = path.join(directory, "codeql-js-partition-123-2-other");
      fs.cpSync(source, target, { recursive: true });
      const file = path.join(target, "other.json");
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      receipt.runAttempt = 2;
      receipt.codeqlVersion = "2.28.0";
      fs.writeFileSync(file, JSON.stringify(receipt));
    }, "2");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different CLI versions");
  });
});
