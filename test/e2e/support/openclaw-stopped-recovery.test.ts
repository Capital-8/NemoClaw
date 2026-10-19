// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import { proveStoppedDockerAgentRecovery } from "../live/openclaw-stopped-recovery.ts";

const NAME = "e2e-recovery";
const ID = "source-id";
const CONTAINER = "a".repeat(64);
const ROW = {
  id: ID,
  name: NAME,
  labels: {},
  resource_version: 1,
  created_at: "2026-10-19T00:00:00Z",
  phase: "Ready",
  current_policy_version: 1,
};
const page = (rows = [ROW], token = "") =>
  JSON.stringify({ sandboxes: rows, next_page_token: token });
const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

function fixture(initial = page(), terminal = page([{ ...ROW, phase: "Error" }])) {
  const openshell = vi
    .fn()
    .mockResolvedValueOnce(result(initial))
    .mockResolvedValue(result(terminal));
  const exec = vi
    .fn()
    .mockResolvedValueOnce(result())
    .mockResolvedValue(result("stopped-source-1000\nstopped-source-1000-unknown-root"));
  const command = vi
    .fn()
    .mockResolvedValueOnce(
      result(
        JSON.stringify([
          CONTAINER,
          {
            "openshell.ai/managed-by": "openshell",
            "openshell.ai/sandbox-name": NAME,
            "openshell.ai/sandbox-id": ID,
          },
          true,
        ]),
      ),
    )
    .mockResolvedValue(result());
  const runtime = {
    id: "docker",
    command,
    resolveSandboxResourceHandle: vi
      .fn()
      .mockResolvedValueOnce(CONTAINER)
      .mockResolvedValue("b".repeat(64)),
  };
  const rebuild = vi.fn().mockResolvedValue(undefined);
  const writeJson = vi.fn();
  return {
    command,
    rebuild,
    writeJson,
    openshell,
    run: () =>
      proveStoppedDockerAgentRecovery(
        { openshell, exec } as unknown as SandboxClient,
        runtime as unknown as RuntimeProviderPrerequisite,
        { writeJson } as unknown as ArtifactSink,
        NAME,
        rebuild,
        "native-readiness",
      ),
  };
}

describe("stopped Docker recovery inventory", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "");
    vi.stubEnv("E2E_TARGET_ID", "rebuild-openclaw");
    vi.spyOn(Date, "now").mockReturnValue(1000);
  });

  it.each([
    ["0.1.3 page", page()],
    ["legacy array", JSON.stringify([ROW])],
  ])("recovers the identified source from a complete %s", async (_name, inventory) => {
    const f = fixture(inventory);
    await f.run();
    expect(f.command.mock.calls.map(([args]) => args[0])).toEqual(["inspect", "kill"]);
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.writeJson).toHaveBeenCalledWith(
      "openclaw-stopped-source-recovery.json",
      expect.objectContaining({
        sourceContainerId: CONTAINER,
        replacementContainerId: "b".repeat(64),
        sourcePhase: "Error",
        workspacePreserved: true,
        unknownNativeRootStatePreserved: true,
      }),
    );
  });

  it.each([
    ["partial page", page([ROW], "next")],
    ["missing page token", JSON.stringify({ sandboxes: [ROW] })],
    ["invalid JSON", "{"],
    ["missing sandbox", page([])],
    ["ambiguous identity", page([ROW, ROW])],
    ["invalid ID", page([{ ...ROW, id: "unsafe/id" }])],
    ["not ready", page([{ ...ROW, phase: "Error" }])],
  ])("rejects %s before container inspection or mutation", async (_name, inventory) => {
    const f = fixture(inventory);
    await expect(f.run()).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it("rejects a changed source ID before rebuild", async () => {
    const f = fixture(page(), page([{ ...ROW, id: "replacement-id", phase: "Error" }]));
    await expect(f.run()).rejects.toThrow("The source identity changed");
    expect(f.rebuild).not.toHaveBeenCalled();
  });
});
