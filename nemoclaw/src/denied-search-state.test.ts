// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeniedSearchState, SEARCH_DENIAL_RETENTION_MS } from "./denied-search-state.js";

describe("denied-search identity retention", () => {
  let state: DeniedSearchState;
  let warn: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.fn<() => void>();
    state = new DeniedSearchState(warn, 2);
  });
  afterEach(() => {
    state.clear();
    vi.useRealTimers();
  });

  it("caps retained identities without allowing tracked or excess denied turns", () => {
    state.deny("run-first");
    state.deny("run-second");
    state.deny("run-overflow");
    expect(state.size).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.blocks("run-first")).toBe(true);
    expect(state.blocks("run-overflow")).toBe(true);
    expect(state.blocks(undefined)).toBe(true);
    state.delete("run-first");
    expect(state.size).toBe(1);
    expect(state.blocks("run-first")).toBe(true);
  });

  it("expires idle retained and overflow state without another tool call", () => {
    state.deny("run-first");
    state.deny("run-second");
    state.deny("run-overflow");
    vi.advanceTimersByTime(SEARCH_DENIAL_RETENTION_MS - 1);
    expect(state.size).toBe(2);
    vi.advanceTimersByTime(1);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("ordinary-run")).toBe(false);
    expect(state.blocks(undefined)).toBe(true);
    state.deny("new-run");
    expect(state.blocks("new-run")).toBe(true);
    expect(state.size).toBe(1);
  });

  it("keeps a later overflow denial until its own deadline", () => {
    state.deny("run-first");
    state.deny("run-second");
    vi.advanceTimersByTime(30_000);
    state.deny("overflow");
    vi.advanceTimersByTime(SEARCH_DENIAL_RETENTION_MS - 30_000);
    expect(state.size).toBe(0);
    expect(state.blocks("overflow")).toBe(true);
    expect(state.blocks("ordinary-run")).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(state.blocks("ordinary-run")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels its last timer after matching cleanup or configuration recovery", () => {
    state.deny("finished");
    state.delete("finished");
    expect(vi.getTimerCount()).toBe(0);
    state.deny("next");
    state.clear();
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("next")).toBe(false);
  });
});
