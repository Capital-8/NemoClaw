// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { writeExecutable, writeSnapshotRegistry } from "../support/native-snapshot.ts";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-inventory-"));
process.env.HOME = testHome;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src/lib/state/sandbox.ts")).href
);

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(testHome, { recursive: true, force: true });
});

it("rejects an archive member omitted from tar's listing before native inspection", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unlisted-native-member-"));
  const oldPath = process.env.PATH;
  try {
    const nativeRoot = path.join(fixture, "native-home");
    const archiveRoot = path.join(fixture, "archive-root");
    const binDir = path.join(fixture, "bin");
    fs.mkdirSync(nativeRoot);
    fs.mkdirSync(archiveRoot);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(nativeRoot, "original.txt"), "original");
    fs.writeFileSync(path.join(archiveRoot, "visible.txt"), "visible");
    fs.writeFileSync(path.join(archiveRoot, "unlisted.txt"), "hidden from listing");
    writeSnapshotRegistry(testHome, "alpha");
    const backup = sandboxState.backupSandboxState("alpha", {
      nativeStateSource: {
        root: "/sandbox",
        directory: nativeRoot,
        assertCurrent: () => undefined,
      },
    });
    expect(backup.success, backup.error).toBe(true);
    const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(systemTar).not.toBe("");
    const crafted = spawnSync(systemTar, ["-C", archiveRoot, "-cf", "-", "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    expect(crafted.status).toBe(0);
    const archive = crafted.stdout;
    const backupPath = backup.manifest!.backupPath;
    fs.writeFileSync(path.join(backupPath, "native-home.tar"), archive);
    const manifestPath = path.join(backupPath, "rebuild-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      nativeState: { sha256: string };
    };
    manifest.nativeState.sha256 = createHash("sha256").update(archive).digest("hex");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeExecutable(
      path.join(binDir, "tar"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(systemTar)}, process.argv.slice(2), {
  input: fs.readFileSync(0), encoding: "utf8",
});
if (result.status !== 0) { process.stderr.write(result.stderr || ""); process.exit(result.status || 1); }
process.stdout.write(result.stdout.split("\\n").filter((line) => !line.includes("unlisted.txt")).join("\\n"));
`,
    );
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    expect(() => sandboxState.inspectNativeSandboxState(backupPath, () => undefined)).toThrow(
      "tar raw header inventory did not match archive listing",
    );
  } finally {
    oldPath === undefined
      ? Reflect.deleteProperty(process.env, "PATH")
      : Reflect.set(process.env, "PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
