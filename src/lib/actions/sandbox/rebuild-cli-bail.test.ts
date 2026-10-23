// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  rebuildBackupPhase,
  rebuildDestroyPhase,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("interactive rebuild bail after backup (#12919)", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("releases the source window and onboard lock before exiting for a late failure", async () => {
    const harness = createRebuildFlowHarness();
    const release = vi
      .spyOn(rebuildBackupPhase, "releaseRebuildSourceOpenClawWindow")
      .mockResolvedValue({ ok: true } as never);
    vi.spyOn(rebuildBackupPhase, "bindRebuildSnapshotGpuAuthority").mockImplementation(() => {
      throw new Error("injected GPU authority conflict");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await harness.rebuildSandbox("alpha", ["--yes"]);

    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "Captured sandbox GPU authority cannot be replayed safely: injected GPU authority conflict",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("keeps the late bail when releasing the source window also rejects", async () => {
    const harness = createRebuildFlowHarness();
    const release = vi
      .spyOn(rebuildBackupPhase, "releaseRebuildSourceOpenClawWindow")
      .mockRejectedValue(new Error("injected release failure"));
    vi.spyOn(rebuildBackupPhase, "bindRebuildSnapshotGpuAuthority").mockImplementation(() => {
      throw new Error("injected GPU authority conflict");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await harness.rebuildSandbox("alpha", ["--yes"]);

    const errors = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("injected release failure");
    expect(errors).toContain("Captured sandbox GPU authority cannot be replayed safely");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("reports a source-window release error when no bail is pending", async () => {
    const harness = createRebuildFlowHarness();
    vi.spyOn(rebuildDestroyPhase, "runRebuildDestroyPhase").mockResolvedValue(null);
    vi.spyOn(rebuildBackupPhase, "releaseRebuildSourceOpenClawWindow").mockRejectedValue(
      new Error("injected release failure"),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await expect(harness.rebuildSandbox("alpha", ["--yes"])).rejects.toThrow(
      "injected release failure",
    );

    expect(exit).not.toHaveBeenCalled();
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });
});
