// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { parseOpenShellPolicy } from "../../adapters/openshell/policy-boundary";
import type { NativeProviderDefinition } from "./contract";

/** Narrow parsed YAML mappings before inspecting their endpoint fields. */
function isPolicyMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare DNS names and IPv6 addresses in the same form as the provider URL. */
function normalizedHost(host: string): string {
  const bare = host.replace(/^\[|\]$/gu, "");
  return new URL(`https://${bare.includes(":") ? `[${bare}]` : bare}`).hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
}

/** OpenShell keeps * within a DNS label and lets ** span labels. */
function policyHostMatches(pattern: string, host: string): boolean {
  if (!pattern) return true;
  const normalized = pattern.includes(":")
    ? normalizedHost(pattern)
    : pattern.toLowerCase().replace(/\.$/u, "");
  // Track consumed prefixes to avoid backtracking through repeated wildcards.
  let positions = [0];
  for (const part of normalized.split(/(\*+)/u)) {
    positions = [
      ...new Set(
        positions.flatMap((start) => {
          if (!part.startsWith("*")) {
            return host.startsWith(part, start) ? [start + part.length] : [];
          }
          const dot = part.length === 1 ? host.indexOf(".", start) : -1;
          const end = dot < 0 ? host.length : dot;
          return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
        }),
      ),
    ];
  }
  return positions.includes(host.length);
}

/** Match OpenShell's set comparison of configured address pins. */
function normalizedPins(pins: readonly string[]): string[] {
  return [...new Set(pins.map((pin) => pin.trim().toLowerCase()))].sort();
}

/** Refuse known address-pin conflicts before registering an endpoint-bound provider. */
export function assertCustomNativePolicyPins(
  document: string,
  definition: NativeProviderDefinition & { endpoint: string },
): void {
  if (!definition.allowedIps?.length) return;
  const destination = new URL(definition.endpoint);
  const host = normalizedHost(destination.hostname);
  const port = Number(destination.port || (destination.protocol === "https:" ? 443 : 80));
  const policies = parseOpenShellPolicy(document).policy.network_policies ?? {};
  const expected = normalizedPins(definition.allowedIps);
  for (const [name, policy] of Object.entries(policies)) {
    if (
      !isPolicyMapping(policy) ||
      (policy.endpoints !== undefined && !Array.isArray(policy.endpoints))
    ) {
      throw new Error(
        "Cannot inspect malformed sandbox endpoint policies. No provider was changed.",
      );
    }
    for (const endpoint of policy.endpoints ?? []) {
      if (!isPolicyMapping(endpoint)) {
        throw new Error("Cannot inspect malformed sandbox endpoints. No provider was changed.");
      }
      // OpenShell normalizes a single port only when ports is empty or absent.
      const ports =
        Array.isArray(endpoint.ports) && endpoint.ports.length > 0
          ? endpoint.ports
          : [endpoint.port];
      if (!ports.includes(port)) continue;
      const policyHost = endpoint.host ?? "";
      if (typeof policyHost !== "string" || !policyHostMatches(policyHost, host)) continue;
      const pins = endpoint.allowed_ips;
      if (
        Array.isArray(pins) &&
        pins.every((pin) => typeof pin === "string") &&
        isDeepStrictEqual(normalizedPins(pins), expected)
      )
        continue;
      throw new Error(
        `Existing policy ${JSON.stringify(name)} for ${destination.hostname}:${port} has conflicting IP pins. No provider was changed. Review that policy before retrying.`,
      );
    }
  }
}
