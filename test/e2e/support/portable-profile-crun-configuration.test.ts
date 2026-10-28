// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

import { portableHostPreparationInternals } from "../../../src/lib/onboard/experimental/portable-host-preparation.ts";
import {
  capturePortableCrunConfiguration,
  preservePortableCrunConfiguration,
} from "../fixtures/portable-profile-rootless-finalization-helpers.ts";

const portable = portableHostPreparationInternals.PORTABLE_CONTAINERS_CONF;

describe("Portable fixture crun configuration", () => {
  it("restores the captured runtime after host preparation replaces its configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-crun-"));
    try {
      const previous = path.join(root, "trusted.conf");
      const prepared = path.join(root, "portable.conf");
      fs.writeFileSync(previous, '[engine.runtimes]\ncrun = ["/trusted/crun"]\n');
      const environment = { CONTAINERS_CONF: previous };
      const restore = capturePortableCrunConfiguration(environment);
      fs.rmSync(previous);
      fs.writeFileSync(prepared, portable);
      environment.CONTAINERS_CONF = prepared;
      restore();
      expect(parseToml(fs.readFileSync(prepared, "utf8")).engine).toMatchObject({
        runtimes: { crun: ["/trusted/crun"] },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the trusted job runtime without replacing Portable network and storage policy", () => {
    const runtime = "/usr/local/libexec/nemoclaw/portable-crun.40637574265.1";
    const prior = `[containers]\npids_limit = 1024\n[engine]\ncgroup_manager = "systemd"\n[engine.runtimes]\ncrun = [${JSON.stringify(runtime)}]\n`;
    const result = parseToml(preservePortableCrunConfiguration(portable, prior));
    const expected = parseToml(portable);
    expect(result).toEqual({
      ...expected,
      engine: { ...(expected.engine as object), runtimes: { crun: [runtime] } },
    });
  });

  it.each(["", '[engine]\nruntime = "crun"\n', "[engine.runtimes]\ncrun = []\n"])(
    "preserves the normal Portable configuration without a pinned runtime: %j",
    (prior) => {
      expect(preservePortableCrunConfiguration(portable, prior)).toBe(portable);
    },
  );

  it("serializes runtime paths as TOML values", () => {
    const runtime = '/fixture/crun with "quotes"';
    const result = preservePortableCrunConfiguration(
      portable,
      `[engine.runtimes]\ncrun = [${JSON.stringify(runtime)}]\n`,
    );
    expect(parseToml(result).engine).toMatchObject({ runtimes: { crun: [runtime] } });
  });
});
