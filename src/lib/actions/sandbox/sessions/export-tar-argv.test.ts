// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildSandboxTarArgv } from "./export";

describe("buildSandboxTarArgv", () => {
  it("isolates resolved files behind `--` and prefixes each with './' so a leading-dash filename cannot be reinterpreted as a tar option", () => {
    expect(
      buildSandboxTarArgv({
        sourceDir: "/sandbox/.openclaw/agents/main/sessions",
        tarballRemote: "/tmp/x.tgz",
        resolvedFiles: ["sid-1.jsonl", "sid-2.jsonl"],
      }),
    ).toEqual([
      "tar",
      "-czf",
      "/tmp/x.tgz",
      "--no-recursion",
      "-C",
      "/sandbox/.openclaw/agents/main/sessions",
      "--",
      "./sid-1.jsonl",
      "./sid-2.jsonl",
    ]);
  });
});
