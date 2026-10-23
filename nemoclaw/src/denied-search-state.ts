// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw clamps even per-run timeout overrides to the Node timer maximum.
const MAX_TURN_TIMEOUT_MS = 2_147_483_647;
export const SEARCH_DENIAL_RETENTION_MS = MAX_TURN_TIMEOUT_MS + 60_000;
export const SEARCH_DENIAL_IDENTITY_LIMIT = 1024;

/** Bound gateway memory without forgetting an active denied turn's policy. */
export class DeniedSearchState {
  private readonly identities = new Map<string, number>();
  private saturatedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly capacity: number;

  constructor(
    private readonly onCapacity: () => void,
    capacity = SEARCH_DENIAL_IDENTITY_LIMIT,
  ) {
    this.capacity = Math.max(1, Math.min(Math.floor(capacity), SEARCH_DENIAL_IDENTITY_LIMIT));
  }

  get size(): number {
    return this.identities.size;
  }

  deny(identity: string): void {
    this.expire();
    const expiresAt = Date.now() + SEARCH_DENIAL_RETENTION_MS;
    if (this.identities.has(identity) || this.size < this.capacity) {
      this.identities.set(identity, expiresAt);
    } else {
      const firstOverflow = this.saturatedUntil === 0;
      this.saturatedUntil = Math.max(this.saturatedUntil, expiresAt);
      if (firstOverflow) this.onCapacity();
    }
    this.schedule();
  }

  blocks(identity: string | undefined): boolean {
    this.expire();
    this.schedule();
    // Overflow identities cannot be distinguished from ordinary identified work.
    // Conservatively restrict substitutes until every untracked denial expires.
    return !identity || this.saturatedUntil > 0 || this.identities.has(identity);
  }

  delete(identity: string): void {
    this.identities.delete(identity);
    this.schedule();
  }

  clear(): void {
    this.identities.clear();
    this.saturatedUntil = 0;
    this.schedule();
  }

  private expire(): void {
    const now = Date.now();
    for (const [identity, expiresAt] of this.identities) {
      if (expiresAt <= now) this.identities.delete(identity);
    }
    if (this.saturatedUntil <= now) this.saturatedUntil = 0;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const nextExpiry = Math.min(
      ...this.identities.values(),
      this.saturatedUntil || Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(nextExpiry)) return;
    // Retention includes cleanup grace beyond Node's largest timer delay.
    const delay = Math.min(MAX_TURN_TIMEOUT_MS, Math.max(1, nextExpiry - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.expire();
      this.schedule();
    }, delay);
    this.timer.unref();
  }
}
