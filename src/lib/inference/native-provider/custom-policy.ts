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
  const expected = [...definition.allowedIps].sort();
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
      if (
        typeof endpoint.host !== "string" ||
        !endpoint.host ||
        normalizedHost(endpoint.host) !== host
      )
        continue;
      const pins = endpoint.allowed_ips;
      if (Array.isArray(pins) && isDeepStrictEqual([...pins].sort(), expected)) continue;
      throw new Error(
        `Existing policy ${JSON.stringify(name)} for ${destination.hostname}:${port} has conflicting IP pins. No provider was changed. Review that policy before retrying.`,
      );
    }
  }
}
