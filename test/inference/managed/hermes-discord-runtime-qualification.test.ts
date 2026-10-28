// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  hermesDiscordRuntimeContractCommand,
  runHermesDiscordRuntimeContract,
} from "../../../scripts/checks/run-hermes-discord-runtime-contract.mts";
import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

const image = `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`;

describe("native Hermes Discord qualification", () => {
  it("propagates a native test failure and removes only its recorded container", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-qualification-cleanup-"));
    const cidPath = path.join(directory, "cid-path");
    const cleanupLog = path.join(directory, "cleanup");
    const id = "a".repeat(64);
    fs.writeFileSync(
      path.join(directory, "docker"),
      `#!/bin/sh
case "$1" in
run)
  while [ "$#" -gt 0 ] && [ "$1" != --cidfile ]; do shift; done
  [ "$#" -gt 1 ] || exit 99
  shift
  printf '%s' "$1" > "$FIXTURE_CID_PATH"
  printf '%s' '${id}' > "$1"
  exit 23
  ;;
rm) printf '%s\\n' "$@" > "$FIXTURE_CLEANUP" ;;
*) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
    vi.stubEnv("FIXTURE_CID_PATH", cidPath);
    vi.stubEnv("FIXTURE_CLEANUP", cleanupLog);
    try {
      expect(() =>
        runHermesDiscordRuntimeContract(["--image", image, "--platform", "linux/arm64"]),
      ).toThrow("Native Hermes Discord runtime contract failed");
      expect(fs.readFileSync(cleanupLog, "utf8")).toBe(`rm\n--force\n${id}\n`);
      expect(fs.existsSync(path.dirname(fs.readFileSync(cidPath, "utf8")))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "pr-build-and-entrypoint",
      "${{ steps.contract.outputs.reference }}",
      "Publish exact same-repository PR managed image by digest",
    ],
    [
      "build-and-validate",
      "${{ steps.validate.outputs.reference }}",
      "Capture exact managed image publication evidence",
    ],
  ])(
    "runs the native contract before %s publication and propagates failure",
    (jobId, reference, publicationName) => {
      const job = required(readWorkflow("managed-images.yaml").jobs?.[jobId], "missing image job");
      const native = step(job, "Verify native Hermes Discord status before publication");
      const build = step(job, "Build CLI for Hermes runtime contract");
      const publication = step(job, publicationName);
      expect(native.if).toBe("matrix.agent == 'hermes'");
      expect(build.if).toBe(native.if);
      expect(native.env?.IMAGE_REFERENCE).toBe(reference);
      expect(job.steps!.indexOf(build)).toBeLessThan(job.steps!.indexOf(native));
      expect(job.steps!.indexOf(native)).toBeLessThan(job.steps!.indexOf(publication));
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-qualification-workflow-"));
      const argumentsFile = path.join(directory, "arguments");
      fs.writeFileSync(
        path.join(directory, "npx"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE_ARGUMENTS"\nexit "${NATIVE_STATUS:-0}"\n',
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        IMAGE_REFERENCE: image,
        PLATFORM: "linux/arm64",
        FIXTURE_ARGUMENTS: argumentsFile,
      };
      try {
        const result = spawnSync("bash", ["-c", native.run!], { env, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(argumentsFile, "utf8").trim().split("\n")).toEqual([
          "--no-install",
          "tsx",
          "scripts/checks/run-hermes-discord-runtime-contract.mts",
          "--image",
          image,
          "--platform",
          "linux/arm64",
        ]);
        const failed = spawnSync("bash", ["-c", native.run!], {
          env: { ...env, NATIVE_STATUS: "23" },
          encoding: "utf8",
        });
        expect(failed.status).toBe(23);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["linux/amd64", "linux/arm64"] as const)(
    "selects the compiled native contract in an isolated %s image",
    (platform) => {
      const command = hermesDiscordRuntimeContractCommand(
        { image, platform },
        "/checkout",
        "/checkout/.e2e/owned.cid",
      );
      expect(command[command.indexOf("--platform") + 1]).toBe(platform);
      expect(command[command.indexOf("--network") + 1]).toBe("none");
      expect(command[command.indexOf("--cidfile") + 1]).toBe("/checkout/.e2e/owned.cid");
      expect(command).toEqual(
        expect.arrayContaining([
          "--read-only",
          "ALL",
          "no-new-privileges",
          "type=bind,src=/checkout,dst=/workspace,readonly",
          "/sandbox/.hermes:rw,nosuid,nodev,mode=0700",
          "NEMOCLAW_HERMES_RUNTIME_TEST=1",
        ]),
      );
      expect(command.slice(command.indexOf(image) + 1)).toEqual([
        "node_modules/vitest/vitest.mjs",
        "run",
        "--project",
        "package-contract",
        "test/package-contract/channels/hermes-discord-runtime.test.ts",
        "--maxWorkers=1",
        "--no-file-parallelism",
      ]);
      expect(command.join(" ")).not.toMatch(/GITHUB_TOKEN|docker\.sock|\.ssh/);
    },
  );

  it.each([
    [["--image", "hermes:latest", "--platform", "linux/arm64"], "immutable"],
    [["--image", image, "--platform", "linux/s390x"], "linux/amd64 or linux/arm64"],
    [["--image", image, "--platform", "linux/arm64", "--privileged"], "usage"],
  ] as const)("rejects invalid qualification inputs %# before Docker runs", (argv, message) => {
    expect(() => runHermesDiscordRuntimeContract(argv)).toThrow(message);
  });
});
