// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { writeExecutable, writeSnapshotRegistry } from "../support/native-snapshot.ts";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-inventory-"));
process.env.HOME = testHome;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src/lib/state/sandbox.ts")).href
);
const stoppedBackup = await import(
  pathToFileURL(
    path.join(import.meta.dirname, "../..", "src/lib/actions/sandbox/snapshot/backup-authority.ts"),
  ).href
);

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(testHome, { recursive: true, force: true });
});

it("stops stopped-state validation when an earlier archive listing exhausts its deadline", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-inventory-deadline-"));
  const source = path.join(fixture, "source");
  const archivePath = path.join(fixture, "source.tar");
  const raw = path.join(fixture, "raw");
  fs.mkdirSync(source);
  fs.mkdirSync(raw);
  fs.writeFileSync(path.join(source, "state.txt"), "preserved");
  const tar = spawnSync("tar", ["-C", source, "-cf", archivePath, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(tar.status).toBe(0);
  const baseNow = Date.now();
  let firstListingComplete = false;
  let listingStarts = 0;
  const originalRemove = fs.rmSync;
  const originalTempDir = fs.mkdtempSync;
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
    Reflect.apply(originalRemove, fs, args);
    firstListingComplete ||= path.basename(String(args[0])).startsWith("nemoclaw-tar-listing-");
  });
  const tempDir = vi.spyOn(fs, "mkdtempSync").mockImplementation((...args) => {
    listingStarts += Number(String(args[0]).includes("nemoclaw-tar-listing-"));
    return Reflect.apply(originalTempDir, fs, args) as string;
  });
  syncBuiltinESMExports();
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() =>
      firstListingComplete ? baseNow + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS + 1 : baseNow,
    );
  try {
    expect(() => stoppedBackup.validateStoppedStateArchive(archivePath, raw)).toThrow(
      "Stopped state archive failed snapshot validation",
    );
    expect(firstListingComplete).toBe(true);
    expect(listingStarts).toBe(1);
    expect(fs.readdirSync(raw)).toEqual([]);
  } finally {
    clock.mockRestore();
    tempDir.mockRestore();
    remove.mockRestore();
    syncBuiltinESMExports();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
it.each([
  ["omitted", 'return !line.includes("unlisted.txt")'],
  ["substituted", 'return line.replace("unlisted.txt", "substitute.txt")'],
  ["duplicated", 'return line.replace("unlisted.txt", "visible.txt")'],
] as const)(
  "rejects an archive member %s in tar's listing before native inspection",
  (_mode, transform) => {
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
process.stdout.write(result.stdout.split("\\n").${_mode === "omitted" ? "filter" : "map"}((line) => { ${transform}; }).join("\\n"));
`,
      );
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;

      expect(() => sandboxState.inspectNativeSandboxState(backupPath, () => undefined)).toThrow(
        "tar raw header inventory did not match archive listing",
      );
      const stoppedRoot = path.join(fixture, "stopped-root");
      fs.mkdirSync(stoppedRoot);
      expect(() =>
        stoppedBackup.validateStoppedStateArchive(
          path.join(backupPath, "native-home.tar"),
          stoppedRoot,
        ),
      ).toThrow("Stopped state archive raw headers did not match its listing");
    } finally {
      oldPath === undefined
        ? Reflect.deleteProperty(process.env, "PATH")
        : Reflect.set(process.env, "PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
);

it("rejects a same-count substituted tar listing during native capture", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-capture-inventory-"));
  const oldPath = process.env.PATH;
  try {
    const nativeRoot = path.join(fixture, "native-home");
    const binDir = path.join(fixture, "bin");
    fs.mkdirSync(nativeRoot);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(nativeRoot, "payload.txt"), "payload");
    writeSnapshotRegistry(testHome, "capture-mismatch");
    const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(systemTar).not.toBe("");
    writeExecutable(
      path.join(binDir, "tar"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(systemTar)}, args, { input: fs.readFileSync(0) });
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1); }
process.stdout.write(args.includes("-tf")
  ? result.stdout.toString("utf8").replace("payload.txt", "substitute.txt")
  : result.stdout);
`,
    );
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    const backup = sandboxState.backupSandboxState("capture-mismatch", {
      nativeStateSource: {
        root: "/sandbox",
        directory: nativeRoot,
        assertCurrent: () => undefined,
      },
    });
    expect(backup.success).toBe(false);
    expect(backup.error).toContain("tar raw header inventory did not match archive listing");
    expect(sandboxState.getLatestBackup("capture-mismatch")).toBeNull();
  } finally {
    oldPath === undefined
      ? Reflect.deleteProperty(process.env, "PATH")
      : Reflect.set(process.env, "PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it("reports a sparse raw header instead of an inventory mismatch", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sparse-inventory-"));
  const oldPath = process.env.PATH;
  try {
    const nativeRoot = path.join(fixture, "native-home");
    const binDir = path.join(fixture, "bin");
    fs.mkdirSync(nativeRoot);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(nativeRoot, "payload.txt"), "payload");
    writeSnapshotRegistry(testHome, "sparse-inventory");
    const backup = sandboxState.backupSandboxState("sparse-inventory", {
      nativeStateSource: {
        root: "/sandbox",
        directory: nativeRoot,
        assertCurrent: () => undefined,
      },
    });
    expect(backup.success, backup.error).toBe(true);
    const backupPath = backup.manifest!.backupPath;
    const archivePath = path.join(backupPath, "native-home.tar");
    const archive = fs.readFileSync(archivePath);
    archive[156] = "S".charCodeAt(0);
    fs.writeFileSync(archivePath, archive);
    const manifestPath = path.join(backupPath, "rebuild-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      nativeState: { sha256: string };
    };
    manifest.nativeState.sha256 = createHash("sha256").update(archive).digest("hex");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeExecutable(
      path.join(binDir, "tar"),
      `#!/usr/bin/env node
process.stdout.write("./\\n./payload.txt\\n");
`,
    );
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    expect(() => sandboxState.inspectNativeSandboxState(backupPath, () => undefined)).toThrow(
      "native state sparse archive entry",
    );
  } finally {
    oldPath === undefined
      ? Reflect.deleteProperty(process.env, "PATH")
      : Reflect.set(process.env, "PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it.each(["tab", "utf8", "unknown-escape", "short-octal", "overflow-octal"] as const)(
  "checks bsdtar fallback listing bytes for %s names",
  (mode) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bsdtar-inventory-"));
    const oldPath = process.env.PATH;
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const binDir = path.join(fixture, "bin");
      fs.mkdirSync(nativeRoot);
      fs.mkdirSync(binDir);
      const requestedName = mode === "utf8" ? "Résumé.md" : "notes\tdraft.txt";
      fs.writeFileSync(path.join(nativeRoot, requestedName), "payload");
      const actualName = fs.readdirSync(nativeRoot)[0]!;
      const octalName = Array.from(Buffer.from(actualName, "utf8"), (byte) =>
        byte >= 0x80 ? `\\${byte.toString(8).padStart(3, "0")}` : String.fromCharCode(byte),
      ).join("");
      const listedName =
        mode === "utf8"
          ? octalName
          : mode === "unknown-escape"
            ? "notes\\qdraft.txt"
            : mode === "short-octal"
              ? "notes\\12draft.txt"
              : mode === "overflow-octal"
                ? "notes\\400draft.txt"
                : actualName.replaceAll("\t", "\\t");
      const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(systemTar).not.toBe("");
      writeExecutable(
        path.join(binDir, "tar"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const input = fs.readFileSync(0);
if (args.includes("--quoting-style=literal")) {
  process.stderr.write("tar: --quoting-style=literal unsupported\\n");
  process.exit(1);
}
if (args.includes("-tf")) {
  process.stdout.write(${JSON.stringify(`./\n./${listedName}\n`)});
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(systemTar)}, args, {
  input, env: { ...process.env, COPYFILE_DISABLE: "1" },
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
      );
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      const key = `bsdtar-${mode}`;
      writeSnapshotRegistry(testHome, key);
      const backup = sandboxState.backupSandboxState(key, {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success, backup.error).toBe(mode === "tab" || mode === "utf8");
      backup.success
        ? sandboxState.inspectNativeSandboxState(backup.manifest!.backupPath, (root: string) => {
            expect(fs.readFileSync(path.join(root, actualName), "utf8")).toBe("payload");
          })
        : expect(backup.error).toContain("tar raw header inventory did not match archive listing");
    } finally {
      oldPath === undefined
        ? Reflect.deleteProperty(process.env, "PATH")
        : Reflect.set(process.env, "PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
