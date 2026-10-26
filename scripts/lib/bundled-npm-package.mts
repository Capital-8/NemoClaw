// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs, {
  closeSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type JsonObject = Record<string, unknown>;

export function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

export function readJsonObject(file: string, label: string): JsonObject {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a real file: ${file}`);
    return jsonObject(JSON.parse(readFileSync(descriptor, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

function syncMetadataDirectory(filename: string): void {
  const directory = fs.openSync(
    dirname(filename),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

/** Publish complete verified metadata without modifying the source file in place. */
export function rewriteRegularFile(
  filename: string,
  label: string,
  transform: (original: string) => string,
): void {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let temporary: string | undefined;
  try {
    const initial = fs.fstatSync(descriptor);
    if (!initial.isFile()) throw new Error(`${label} must be a real file`);
    const original = fs.readFileSync(descriptor, "utf8");
    const patched = transform(original);
    if (patched === original) {
      syncMetadataDirectory(filename);
      return;
    }
    const bytes = Buffer.from(patched);
    const stagingPath = `${filename}.nemoclaw-${randomBytes(16).toString("hex")}.tmp`;
    const staging = fs.openSync(
      stagingPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporary = stagingPath;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(staging, bytes, offset, bytes.length - offset, offset);
        if (!written) throw new Error(`${label} write made no progress`);
        offset += written;
      }
      if (!fs.readFileSync(staging).equals(bytes))
        throw new Error(`${label} staged contents failed verification`);
      const staged = fs.fstatSync(staging);
      if (staged.uid !== initial.uid || staged.gid !== initial.gid)
        fs.fchownSync(staging, initial.uid, initial.gid);
      fs.fchmodSync(staging, initial.mode & 0o777);
      fs.fsyncSync(staging);
      const current = fs.lstatSync(filename);
      const observed = fs.fstatSync(descriptor);
      if (
        !current.isFile() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        observed.size !== initial.size ||
        observed.mtimeMs !== initial.mtimeMs ||
        observed.ctimeMs !== initial.ctimeMs
      )
        throw new Error(`${label} changed before writing`);
      fs.renameSync(stagingPath, filename);
      temporary = undefined;
      syncMetadataDirectory(filename);
    } finally {
      fs.closeSync(staging);
    }
  } finally {
    try {
      if (temporary) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

export function requireRealDirectory(directory: string, label: string): string {
  const resolved = resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

export function rejectUnsafePackageTree(root: string, label: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`${label} contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafePackageTree(join(root, entry.name), label);
  }
}

function isContainedBinSymlink(
  nodeModulesRoot: string,
  directory: string,
  entryName: string,
): boolean {
  if (basename(directory) !== ".bin") return false;
  try {
    const target = realpathSync(join(directory, entryName));
    const targetRelative = relative(nodeModulesRoot, target);
    return (
      targetRelative !== "" &&
      targetRelative !== ".." &&
      !targetRelative.startsWith(`..${sep}`) &&
      !isAbsolute(targetRelative) &&
      lstatSync(target).isFile()
    );
  } catch {
    return false;
  }
}

export function collectBundledPackageVersions(options: {
  ignoredDirectoryPrefixes: readonly string[];
  nodeModulesRoot: string;
  packageName: string;
}): string[] {
  const versions: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        if (!isContainedBinSymlink(options.nodeModulesRoot, directory, entry.name)) {
          throw new Error(`npm package contains an unsafe symlink: ${join(directory, entry.name)}`);
        }
        continue;
      }
      if (
        entry.isDirectory() &&
        options.ignoredDirectoryPrefixes.some((prefix) => entry.name.startsWith(prefix))
      ) {
        continue;
      }
      const child = join(directory, entry.name);
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error(`npm package contains an unsafe member: ${child}`);
      }
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = readJsonObject(child, "npm bundled package manifest");
      if (manifest.name !== options.packageName) continue;
      if (typeof manifest.version !== "string") {
        throw new Error(`npm bundled ${options.packageName} version is invalid`);
      }
      versions.push(manifest.version);
    }
  };
  visit(options.nodeModulesRoot);
  return versions;
}

function removeBackup(backupPath: string): void {
  try {
    rmSync(backupPath, { force: true, recursive: true });
  } catch (cleanupError) {
    try {
      rmSync(backupPath, { force: true, recursive: true });
    } catch (retryError) {
      throw new AggregateError(
        [cleanupError, retryError],
        `verified replacement retained but affected backup cleanup failed: ${backupPath}`,
      );
    }
  }
}

type RetainedBackupOptions = {
  npmRoot: string;
  packageName: "ip-address" | "undici";
  verifyBackup: (manifest: JsonObject) => void;
};

// Only one recognized backup is eligible; ambiguous or unverifiable trees stay intact.
function verifiedRetainedBackup(options: RetainedBackupOptions): string | undefined {
  const parent = requireRealDirectory(
    join(options.npmRoot, "node_modules"),
    "npm node_modules root",
  );
  const prefix = `${options.packageName}.nemoclaw-backup-`;
  const backups = readdirSync(parent).filter((entry) => entry.startsWith(prefix));
  if (backups.length === 0) return undefined;
  const backupPath = join(parent, backups[0]);
  if (backups.length !== 1 || !/^[1-9][0-9]*-[a-f0-9]{16}$/.test(backups[0].slice(prefix.length))) {
    throw new Error(
      `npm bundled ${options.packageName} has an ambiguous retained backup; inspect before retrying: ${backupPath}`,
    );
  }
  try {
    requireRealDirectory(backupPath, "retained npm package backup");
    rejectUnsafePackageTree(backupPath, "retained npm package backup");
    options.verifyBackup(
      readJsonObject(join(backupPath, "package.json"), "retained npm package backup manifest"),
    );
  } catch (error) {
    throw new Error(
      `npm bundled ${options.packageName} retained backup cannot be verified; inspect before retrying: ${backupPath}`,
      { cause: error },
    );
  }
  return backupPath;
}

// Callers validate npm identity first. Never replace an existing path, including a dangling link.
// Unverified staging trees are not used or removed during recovery.
export function restoreMissingBundledPackage(options: RetainedBackupOptions): void {
  const parent = requireRealDirectory(
    join(options.npmRoot, "node_modules"),
    "npm node_modules root",
  );
  const livePath = join(parent, options.packageName);
  if (lstatSync(livePath, { throwIfNoEntry: false })) return;
  const backupPath = verifiedRetainedBackup(options);
  if (backupPath) renameSync(backupPath, livePath);
}

// A previous invocation may have installed the verified package but failed cleanup.
export function reconcileBundledPackageBackup(
  options: RetainedBackupOptions & {
    fixed: boolean;
  },
): void {
  const backupPath = verifiedRetainedBackup(options);
  if (!backupPath) return;
  if (!options.fixed) {
    throw new Error(
      `npm bundled ${options.packageName} has an ambiguous retained backup; inspect before retrying: ${backupPath}`,
    );
  }
  removeBackup(backupPath);
}

export function replaceBundledPackage<State>(options: {
  npmRoot: string;
  packageName: "ip-address" | "undici";
  replacementRoot: string;
  verify: (npmRoot: string) => State;
}): State {
  const { npmRoot, packageName, replacementRoot, verify } = options;
  const livePath = join(npmRoot, "node_modules", packageName);
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stagingRoot = mkdtempSync(join(dirname(livePath), `.${packageName}.nemoclaw-stage-`));
  const stagedPath = join(stagingRoot, "replacement");
  const backupPath = `${livePath}.nemoclaw-backup-${transactionId}`;
  let rollbackRequired = false;
  try {
    cpSync(replacementRoot, stagedPath, { dereference: false, recursive: true });
    cpSync(livePath, backupPath, {
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
    });
    rollbackRequired = true;
    rmSync(livePath, { recursive: true });
    renameSync(stagedPath, livePath);
    const fixed = verify(npmRoot);
    rollbackRequired = false;
    removeBackup(backupPath);
    return fixed;
  } catch (error) {
    if (rollbackRequired) {
      try {
        rmSync(livePath, { force: true, recursive: true });
        renameSync(backupPath, livePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `npm bundled ${packageName} rollback failed; ${backupPath} retains the original tree`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export type BundledNpmCommandRunner = (command: string, args: readonly string[]) => void;

export function runBundledNpmCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`);
  }
}

export type PreparedBundledReplacement = Readonly<{
  cleanup: () => void;
  replacementRoot: string;
}>;

export function prepareBundledPackageReplacement(options: {
  packageName: "ip-address" | "undici";
  version: string;
  integrity: string;
  tarball: string;
  offline: boolean;
  commandRunner: BundledNpmCommandRunner;
}): PreparedBundledReplacement {
  const { packageName, version, integrity, tarball, commandRunner } = options;
  const rootDirectory = mkdtempSync(join(tmpdir(), `nemoclaw-npm-${packageName}-`));
  const archivePath = join(rootDirectory, `${packageName}-${version}.tgz`);
  const replacementRoot = join(rootDirectory, "replacement");
  try {
    if (options.offline) {
      commandRunner("npm", [
        "pack",
        `${packageName}@${version}`,
        "--registry=https://registry.npmjs.org/",
        "--offline",
        "--ignore-scripts",
        "--pack-destination",
        rootDirectory,
      ]);
    } else {
      commandRunner("curl", [
        "--proto",
        "=https",
        "--tlsv1.2",
        "--fail",
        "--silent",
        "--show-error",
        "--output",
        archivePath,
        tarball,
      ]);
    }
    const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archiveBytes: Buffer;
    try {
      if (!fstatSync(descriptor).isFile())
        throw new Error(`${packageName} replacement download must be a real file`);
      archiveBytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (actualIntegrity !== integrity) {
      throw new Error(
        `${packageName} replacement integrity mismatch\nExpected: ${integrity}\nActual:   ${actualIntegrity}`,
      );
    }
    mkdirSync(replacementRoot, { mode: 0o700 });
    commandRunner("tar", [
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      replacementRoot,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    return {
      cleanup: () => rmSync(rootDirectory, { force: true, recursive: true }),
      replacementRoot,
    };
  } catch (error) {
    rmSync(rootDirectory, { force: true, recursive: true });
    throw error;
  }
}

export function remediateBundledPackageFromRegistry<
  State extends { state: "affected" | "fixed" },
>(options: {
  current: State;
  commandRunner: BundledNpmCommandRunner;
  prepareReplacement: (runner: BundledNpmCommandRunner) => PreparedBundledReplacement;
  patch: (replacementRoot: string) => State;
  verifyCommands: (runner: BundledNpmCommandRunner) => void;
}): State {
  if (options.current.state === "fixed") {
    options.verifyCommands(options.commandRunner);
    return options.current;
  }
  const prepared = options.prepareReplacement(options.commandRunner);
  try {
    const result = options.patch(prepared.replacementRoot);
    options.verifyCommands(options.commandRunner);
    return result;
  } finally {
    prepared.cleanup();
  }
}
