// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
  writeManagedAutoApproval,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed startup approval mode", () => {
  it.each([
    ["disabled\n", "auto", "manual"],
    ["disabled\n", "yolo", "manual"],
    ["thread-opt-in\n", "auto", "auto"],
    ["thread-opt-in\n", "manual", "manual"],
  ])(
    "applies capability %j to the native startup mode %s (#13838)",
    (capability, nativeMode, resolvedMode) => {
      const tempDir = createPackageFixture();
      patchFixture(tempDir);
      writeManagedAutoApproval(tempDir, capability);
      const result = spawnSync("python3", ["-m", "deepagents_code"], {
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: tempDir,
          FIXTURE_NATIVE_STARTUP_MODE: nativeMode,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`resolved_mode=${resolvedMode}`);
    },
  );
});
