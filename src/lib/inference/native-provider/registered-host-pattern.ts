// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

type LabelToken = "*" | ((character: string) => boolean);

function labelTokens(label: string): LabelToken[] {
  const tokens: LabelToken[] = [];
  const chars = [...label];
  for (let index = 0; index < chars.length; index++) {
    const character = chars[index]!;
    if (character === "*") {
      if (chars[index + 1] === "*") throw new Error("Invalid registered provider host pattern");
      tokens.push("*");
    } else if (character === "?") tokens.push(() => true);
    else if (character === "[") {
      const negated = chars[index + 1] === "!";
      const start = index + (negated ? 2 : 1);
      const end = chars.indexOf("]", start + 1);
      if (end < 0) throw new Error("Invalid registered provider host pattern");
      const ranges: [string, string][] = [];
      for (let position = start; position < end; position++) {
        const first = chars[position]!;
        if (position + 2 < end && chars[position + 1] === "-") {
          ranges.push([first, chars[position + 2]!]);
          position += 2;
        } else ranges.push([first, first]);
      }
      tokens.push(
        (value) => ranges.some(([first, last]) => value >= first && value <= last) !== negated,
      );
      index = end;
    } else tokens.push((value) => value === character);
  }
  return tokens;
}

function labelMatches(tokens: LabelToken[], label: string): boolean {
  const characters = [...label];
  let positions = new Set([0]);
  for (const token of tokens) {
    const next = new Set<number>();
    for (const position of positions) {
      if (token === "*") {
        for (let end = position; end <= characters.length; end++) next.add(end);
      } else if (position < characters.length && token(characters[position]!))
        next.add(position + 1);
    }
    positions = next;
  }
  return positions.has(characters.length);
}

/** Match OpenShell DNS-label globs without regular-expression backtracking. */
export function registeredProviderHostMatches(pattern: string, hostname: string): boolean {
  const labels = pattern.toLowerCase().split(".");
  const host = hostname.toLowerCase().split(".");
  if (!pattern || /[\s{}]/u.test(pattern) || labels.some((label) => !label))
    throw new Error("Invalid registered provider host pattern");
  if (host.some((label) => !label)) return false;
  if (pattern.toLowerCase() === hostname.toLowerCase() && isIP(pattern.replace(/^\[|\]$/gu, "")))
    return true;
  const compiled = labels.map((label) => (label === "**" ? "**" : labelTokens(label)));
  let positions = new Set([0]);
  for (const label of compiled) {
    const next = new Set<number>();
    for (const position of positions) {
      if (label === "**") {
        // OpenShell requires a recursive wildcard to consume at least one DNS label.
        for (let end = position + 1; end <= host.length; end++) next.add(end);
      } else if (position < host.length && labelMatches(label, host[position]!))
        next.add(position + 1);
    }
    positions = next;
  }
  return positions.has(host.length);
}
