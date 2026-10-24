// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  remediateOpenClawRuntimeDependencies,
  patchOpenClawManagedPluginOverrides,
} from "../../scripts/lib/remediate-openclaw-runtime-dependencies.mts";

const directories: string[] = [];
function fixture(installedVersion = "8.12.3") {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-runtime-security-"));
  directories.push(root);
  const legacy = join(root, "node_modules/openclaw/node_modules/undici");
  const replacement = join(root, "node_modules/undici");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(replacement, { recursive: true });
  writeFileSync(
    join(root, "node_modules/openclaw/package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.7" }),
  );
  writeFileSync(
    join(legacy, "package.json"),
    JSON.stringify({ name: "undici", version: "8.10.2" }),
  );
  writeFileSync(join(legacy, "original.js"), "original");
  writeFileSync(
    join(replacement, "package.json"),
    JSON.stringify({ name: "undici", version: installedVersion }),
  );
  const lockfile = join(root, "package-lock.json");
  writeFileSync(
    lockfile,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { openclaw: "2026.9.7", undici: "8.12.3" } },
        "node_modules/openclaw": { version: "2026.9.7" },
        "node_modules/undici": { version: "8.12.3" },
      },
    }),
  );
  return { root, legacy, replacement, lockfile };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("OpenClaw migration HTTP dependency remediation", () => {
  it("removes the bundled copy only when the consumer resolves the reviewed replacement", () => {
    const target = fixture();
    const originalLock = readFileSync(target.lockfile, "utf8");
    remediateOpenClawRuntimeDependencies(target.root);
    expect(existsSync(target.legacy)).toBe(false);
    expect(readFileSync(target.lockfile, "utf8")).toBe(originalLock);
    remediateOpenClawRuntimeDependencies(target.root);
    expect(readFileSync(target.lockfile, "utf8")).toBe(originalLock);
  });

  it("rechecks the resolved package on an already remediated installation", () => {
    const target = fixture();
    remediateOpenClawRuntimeDependencies(target.root);
    writeFileSync(
      join(target.replacement, "package.json"),
      JSON.stringify({ name: "undici", version: "8.10.2" }),
    );
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "HTTP client identity mismatch",
    );
    expect(existsSync(target.legacy)).toBe(false);
  });

  it("restores the original copy when replacement verification fails", () => {
    const target = fixture("8.10.2");
    const originalLock = readFileSync(target.lockfile, "utf8");
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "HTTP client identity mismatch",
    );
    expect(readFileSync(join(target.legacy, "original.js"), "utf8")).toBe("original");
    expect(readFileSync(target.lockfile, "utf8")).toBe(originalLock);
  });

  it("rejects a linked dependency without changing its target", () => {
    const target = fixture();
    const outside = join(target.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "preserved");
    rmSync(target.legacy, { recursive: true });
    symlinkSync(outside, target.legacy);
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "must be a real directory",
    );
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("preserved");
  });

  it("refuses a stale lock instead of quietly changing its reviewed identity", () => {
    const target = fixture();
    const lock = JSON.parse(readFileSync(target.lockfile, "utf8"));
    lock.packages["node_modules/openclaw/node_modules/undici"] = {
      version: "8.10.2",
      inBundle: true,
    };
    writeFileSync(target.lockfile, JSON.stringify(lock));
    expect(() => remediateOpenClawRuntimeDependencies(target.root)).toThrow(
      "retains an unremediated bundled HTTP client",
    );
    expect(readFileSync(join(target.legacy, "original.js"), "utf8")).toBe("original");
  });
});

describe("OpenClaw managed plugin security overrides", () => {
  it("rejects workspace source drift without changing the file", () => {
    const { root } = fixture();
    const owner = join(root, "node_modules/openclaw");
    writeFileSync(
      join(owner, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
    );
    const workspace = join(owner, "pnpm-workspace.yaml");
    writeFileSync(workspace, "overrides: {}\n");
    expect(() => patchOpenClawManagedPluginOverrides(owner)).toThrow("source integrity mismatch");
    expect(readFileSync(workspace, "utf8")).toBe("overrides: {}\n");
  });
});
