// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../helpers/supervised-process";
import { testTimeoutOptions } from "../helpers/timeouts";

const BOOTSTRAP = path.join(import.meta.dirname, "../..", "install.sh");
const REPO_URL = "https://github.com/NVIDIA/NemoClaw.git";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-deadline-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const cli = path.join(bin, "nemoclaw");
  fs.writeFileSync(cli, "#!/usr/bin/env bash\nprintf 'nemoclaw v0.0.140\\n'\n", {
    mode: 0o755,
  });
  const bootstrap = path.join(root, "bootstrap.sh");
  fs.writeFileSync(
    bootstrap,
    fs
      .readFileSync(BOOTSTRAP, "utf8")
      .replace("BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=30", "BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=1"),
  );
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
case " $* " in
  *" fetch "*)
    case "$FETCH_RESULT" in
      stall | cancel-INT | cancel-TERM)
        /bin/sleep 60 &
        child=$!
        trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 143' TERM
        printf '%s\\n%s\\n' "$$" "$child" >"$FETCH_PIDS"
        case "$FETCH_RESULT" in
          cancel-*)
            owner="$(ps -o ppid= -p "$PPID" | tr -d '[:space:]')"
            [[ "$owner" =~ ^[0-9]+$ && "$owner" -gt 1 ]] || exit 98
            kill "-\${FETCH_RESULT#cancel-}" "$owner"
            ;;
        esac
        wait "$child"
        ;;
      delayed-error)
        printf "%s\\n" "fatal: unable to access '${REPO_URL}/': Failed to connect to github.com port 443 after 132678 ms: Couldn't connect to server" >&2
        exit 128
        ;;
    esac
    ;;
  *) exec /usr/bin/git "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, bin, bootstrap, cli, pids: path.join(root, "fetch.pids") };
}

const fileDigest = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("public installer fetch deadline", testTimeoutOptions(15_000), () => {
  it("reports a stalled ref lookup as a timeout and stops its owned processes (#14007)", async (context) => {
    const fixture = createFixture();
    const before = fileDigest(fixture.cli);
    try {
      const result = await runSupervisedProcess("bash", ["-c", 'exec bash < "$BOOTSTRAP"'], {
        owner: context,
        cwd: fixture.root,
        env: {
          HOME: fixture.root,
          PATH: `${fixture.bin}:/usr/bin:/bin`,
          TMPDIR: fixture.root,
          BOOTSTRAP: fixture.bootstrap,
          CHECKOUT: path.join(fixture.root, "checkout"),
          FETCH_PIDS: fixture.pids,
          FETCH_RESULT: "stall",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        timeoutMs: 5_000,
        maxOutputBytesPerStream: 64 * 1024,
      });

      expect(result.error).toBeUndefined();
      expect(result.timedOut).toBe(false);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`Timed out looking up install ref 'lkg' at ${REPO_URL}.`);
      expect(result.stderr).toContain("The installed CLI was not changed.");
      expect(result.stderr).toContain("Check network access to github.com and try again.");
      expect(result.stderr).not.toContain("Could not verify install ref");
      const ownedPids = fs.readFileSync(fixture.pids, "utf8").trim().split("\n");
      expect(ownedPids).toHaveLength(2);
      expect(spawnSync("kill", ["-0", ownedPids[0]]).status).not.toBe(0);
      expect(spawnSync("kill", ["-0", ownedPids[1]]).status).not.toBe(0);
      expect(fileDigest(fixture.cli)).toBe(before);
      expect(spawnSync(fixture.cli, ["--version"], { encoding: "utf8" }).stdout).toBe(
        "nemoclaw v0.0.140\n",
      );
      expect(fs.existsSync(path.join(fixture.root, "checkout", "scripts", "install.sh"))).toBe(
        false,
      );
      expect(
        fs
          .readdirSync(fixture.root)
          .filter((name) => name.startsWith("nemoclaw-bootstrap-lookup.")),
      ).toEqual([]);
      expect(fs.readdirSync(fixture.root).sort()).toEqual(["bin", "bootstrap.sh", "fetch.pids"]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps an elapsed-only Git failure separate from the installer deadline (#14007)", async (context) => {
    const fixture = createFixture();
    try {
      const result = await runSupervisedProcess(
        "bash",
        ["-c", 'source "$BOOTSTRAP"\nclone_nemoclaw_ref lkg "$CHECKOUT"'],
        {
          owner: context,
          cwd: fixture.root,
          env: {
            HOME: fixture.root,
            PATH: `${fixture.bin}:/usr/bin:/bin`,
            TMPDIR: fixture.root,
            BOOTSTRAP: fixture.bootstrap,
            CHECKOUT: path.join(fixture.root, "checkout"),
            FETCH_PIDS: fixture.pids,
            FETCH_RESULT: "delayed-error",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          timeoutMs: 5_000,
          maxOutputBytesPerStream: 64 * 1024,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Couldn't connect to server");
      expect(result.stderr).toContain(`Could not verify install ref 'lkg' from ${REPO_URL}.`);
      expect(result.stderr).toContain("Git reported 132678 ms elapsed before the lookup failed.");
      expect(result.stderr).not.toContain("Timed out");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["INT", 130],
    ["TERM", 143],
  ] as const)(
    "preserves SIG%s cancellation and stops the fetch processes (#14007)",
    async (signal, status) => {
      const fixture = createFixture();
      try {
        const result = await runSupervisedProcess(
          "bash",
          ["-c", 'source "$BOOTSTRAP"\nclone_nemoclaw_ref lkg "$CHECKOUT"'],
          {
            cwd: fixture.root,
            timeoutMs: 5_000,
            maxOutputBytesPerStream: 64 * 1024,
            env: {
              HOME: fixture.root,
              PATH: `${fixture.bin}:/usr/bin:/bin`,
              TMPDIR: fixture.root,
              BOOTSTRAP: fixture.bootstrap,
              CHECKOUT: path.join(fixture.root, "checkout"),
              FETCH_PIDS: fixture.pids,
              FETCH_RESULT: `cancel-${signal}`,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.timedOut).toBe(false);
        expect(result.status).toBe(status);
        expect(result.stderr).not.toContain("Could not verify install ref");
        expect(result.stderr).not.toContain("Timed out");
        const ownedPids = fs.readFileSync(fixture.pids, "utf8").trim().split("\n");
        expect(ownedPids).toHaveLength(2);
        expect(spawnSync("kill", ["-0", ownedPids[0]]).status).not.toBe(0);
        expect(spawnSync("kill", ["-0", ownedPids[1]]).status).not.toBe(0);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
