// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Rebuild deletes the sandbox and then runs onboard in the same process. An
// unsupported NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must stop it before deletion,
// not in the inner onboard after the sandbox is gone (#13734).

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";

describe("rebuild local inference timeout preflight (#13734)", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("stops before deleting the sandbox when the timeout is out of range", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "7200");
    const onboard = vi.fn();
    const harness = createRebuildFlowHarness({ sandboxEntry: {}, onboard });
    const errorSpy = vi.spyOn(console, "error");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Unsupported NEMOCLAW_LOCAL_INFERENCE_TIMEOUT");

    const diagnostics = errorSpy.mock.calls.flat().join("\n");
    expect(diagnostics).toContain(
      'NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds; got "7200".',
    );
    expect(diagnostics).toContain("sandbox is untouched");
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.anything(),
    );
    expect(onboard).not.toHaveBeenCalled();
  });

  it("still rebuilds with the largest supported timeout", async () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", "3600");
    const onboard = vi.fn();
    const harness = createRebuildFlowHarness({ sandboxEntry: {}, onboard });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(onboard).toHaveBeenCalledTimes(1);
  });
});
