// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw clamps even per-run timeout overrides to the Node timer maximum.
const MAX_TURN_TIMEOUT_MS = 2_147_483_647;
export const SEARCH_DENIAL_RETENTION_MS = MAX_TURN_TIMEOUT_MS + 60_000;
export const SEARCH_DENIAL_IDENTITY_LIMIT = 1024;

/** Reserve bounded turn ownership before inference so no active denial can overflow. */
export class DeniedSearchState {
  private readonly identities = new Map<string, { expiresAt: number; denied: boolean }>();
  private capacityWarning = false;
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

  admit(identity: string): boolean {
    this.expire();
    if (this.identities.has(identity)) return true;
    if (this.size >= this.capacity) {
      if (!this.capacityWarning) this.onCapacity();
      this.capacityWarning = true;
      return false;
    }
    this.identities.set(identity, {
      expiresAt: Date.now() + SEARCH_DENIAL_RETENTION_MS,
      denied: false,
    });
    this.schedule();
    return true;
  }

  hasAdmission(identity: string | undefined): boolean {
    this.expire();
    return identity !== undefined && this.identities.has(identity);
  }

  deny(identity: string): void {
    if (!this.admit(identity)) return;
    this.identities.set(identity, {
      expiresAt: Date.now() + SEARCH_DENIAL_RETENTION_MS,
      denied: true,
    });
    this.schedule();
  }

  blocks(identity: string | undefined): boolean {
    this.expire();
    this.schedule();
    return !identity || this.identities.get(identity)?.denied === true;
  }

  delete(identity: string): void {
    this.identities.delete(identity);
    this.schedule();
  }

  clear(): void {
    this.identities.clear();
    this.capacityWarning = false;
    this.schedule();
  }

  private expire(): void {
    const now = Date.now();
    for (const [identity, { expiresAt }] of this.identities) {
      if (expiresAt <= now) this.identities.delete(identity);
    }
    if (this.size < this.capacity) this.capacityWarning = false;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const nextExpiry = Math.min(
      ...Array.from(this.identities.values(), ({ expiresAt }) => expiresAt),
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
