// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  writeExecutable,
  writeFakeOpenshell,
  writeFakeSsh,
  writeSnapshotRegistry,
} from "../support/native-snapshot.ts";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-backslash-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const HOST_TAR_SUPPORTS_LITERAL_QUOTING =
  spawnSync("tar", ["--quoting-style=literal", "-tf", "-"], {
    input: Buffer.alloc(1024),
  }).status === 0;

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP_HOME, ".nemoclaw", "rebuild-backups"), {
    recursive: true,
    force: true,
  });
});

function createBackslashEnvFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-backslash-env-"));
  const nativeRoot = path.join(fixture, "native-home");
  const relativePath = "workspace/05-\u{1F6E0}\u{FE0F}\\ Systems\\ \\&\\ Templates/.env";
  const content = "CUSTOM_MODE=enabled\n";
  fs.mkdirSync(path.dirname(path.join(nativeRoot, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, relativePath), content);
  writeSnapshotRegistry(TMP_HOME, "alpha");
  const backup = sandboxState.backupSandboxState("alpha", {
    nativeStateSource: {
      root: "/sandbox",
      directory: nativeRoot,
      assertCurrent: () => undefined,
    },
  });
  return { fixture, relativePath, content, backup };
}

describe("native backup of backslash paths across tar quoting modes", () => {
  it.skipIf(!HOST_TAR_SUPPORTS_LITERAL_QUOTING)(
    "preserves an .env under a backslash directory when tar lists literal names",
    () => {
      const { fixture, relativePath, content, backup } = createBackslashEnvFixture();
      try {
        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            expect(fs.readFileSync(path.join(root, relativePath), "utf8")).toBe(content);
          },
          relativePath,
        );
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(HOST_TAR_SUPPORTS_LITERAL_QUOTING)(
    "fails closed for an .env under a backslash directory when tar doubles names",
    () => {
      const { fixture, backup } = createBackslashEnvFixture();
      try {
        expect(backup.success).toBe(false);
        expect(backup.error).toContain("credential-bearing or uninspectable content");
        expect(sandboxState.getLatestBackup("alpha")).toBeNull();
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("round-trips backslash paths and rejects credential-bearing backslash paths after tar rejects --quoting-style=literal", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-bsdtar-fallback-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const tarLog = path.join(fixture, "tar-args.log");
      const relativeDir = "workspace/05-\u{1F6E0}\u{FE0F}\\ Systems\\ \\&\\ Templates";
      const relativeFile = `${relativeDir}/notes.md`;
      const relativeEnv = `${relativeDir}/.env`;
      const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(systemTar).not.toBe("");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(nativeRoot, relativeFile)), { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, relativeFile), "fallback-backslash-notes");
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      writeExecutable(
        path.join(binDir, "tar"),
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(tarLog)}, JSON.stringify(args) + "\\n");`,
          'if (args.includes("--quoting-style=literal")) { process.stderr.write("tar: Option --quoting-style=literal is not supported\\n"); process.exit(1); }',
          `process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 90);`,
        ].join("\n"),
      );
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeSnapshotRegistry(TMP_HOME, "alpha");

      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success, backup.error).toBe(true);
      const loggedInvocations = fs
        .readFileSync(tarLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(loggedInvocations).toContainEqual(["--quoting-style=literal", "-tf", "-"]);
      expect(loggedInvocations).toContainEqual(["-tf", "-"]);
      const fallbackValidation = sandboxState.validateTarEntries(
        { filePath: path.join(backup.manifest!.backupPath, "native-home.tar") },
        "/sandbox",
      );
      expect(fallbackValidation.safe).toBe(true);
      expect(
        fallbackValidation.entries.some((entry: string) =>
          entry.includes("\\\\ Systems\\\\ \\\\&\\\\ Templates/notes.md"),
        ),
      ).toBe(true);
      fs.writeFileSync(path.join(nativeRoot, relativeFile), "mutated");
      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
      expect(restore.success, restore.error).toBe(true);
      expect(fs.readFileSync(path.join(nativeRoot, relativeFile), "utf8")).toBe(
        "fallback-backslash-notes",
      );

      fs.writeFileSync(
        path.join(nativeRoot, relativeEnv),
        `OPENAI_API_KEY=${["sk-proj", "fallbackSecret1234567890abcd"].join("-")}\n`,
      );
      const rejected = sandboxState.backupSandboxState("alpha");
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain("credential-bearing or uninspectable content");
      expect(rejected.error).toContain(relativeEnv);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
