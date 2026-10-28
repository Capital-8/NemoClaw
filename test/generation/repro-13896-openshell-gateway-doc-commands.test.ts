// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression for NemoClaw#13896 (previously #3685). The troubleshooting and
// commands reference pages told readers to run `openshell gateway trust` and
// `openshell gateway destroy`. The OpenShell CLI that NemoClaw pins exposes
// only `add`, `remove`, `login`, `logout`, `select`, `info`, and `list`, so both
// documented recoveries stopped at an `unrecognized subcommand` error.
//
// These assertions read the shipped docs and the generated agent variants, so a
// page edit that reintroduces an unavailable recovery command fails here rather
// than in a reader's shell. The subcommand surface is derived from the pinned
// blueprint version rather than a hard-coded list, so a future OpenShell bump
// must revisit this contract deliberately.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  agentVariants,
  findGeneratedNavigationTargets,
  renderAgentVariantPage,
} from "../../scripts/sync-agent-variant-docs.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Gateway subcommands the pinned OpenShell release exposes. Verified against
 * `openshell gateway --help` on the pinned 0.0.116 build; update this list with
 * the pin when a release adds a subcommand the docs want to prescribe.
 */
const SUPPORTED_GATEWAY_SUBCOMMANDS = new Set([
  "add",
  "remove",
  "login",
  "logout",
  "select",
  "info",
  "list",
]);

/**
 * A mention that states the subcommand does not exist is allowed, and is how
 * the pages now explain the supported boundary.
 */
const BOUNDARY_STATEMENT_RE = /\bhas no\b|\bdoes not have\b|unrecognized subcommand/i;

const GATEWAY_INVOCATION_RE = /\bopenshell gateway ([a-z][a-z-]*)/g;

/** Pages that carried the unavailable recovery commands in #13896. */
const AFFECTED_SOURCES = [
  "reference/troubleshooting.mdx",
  "reference/commands.mdx",
  "manage-sandboxes/update-sandboxes.mdx",
] as const;

type AffectedSource = (typeof AFFECTED_SOURCES)[number];

function pinnedOpenshellVersion(): string {
  const blueprint = parse(
    readFileSync(path.join(repoRoot, "nemoclaw-blueprint", "blueprint.yaml"), "utf8"),
  ) as { min_openshell_version?: string; max_openshell_version?: string };
  expect(blueprint.min_openshell_version).toBe(blueprint.max_openshell_version);
  return String(blueprint.min_openshell_version);
}

/** The whole source line holding `index`, so a boundary statement can exempt it. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Find prose or code that invokes an `openshell gateway <subcommand>` the pinned
 * CLI does not implement.
 */
function unavailableInvocations(text: string): string[] {
  return [...text.matchAll(GATEWAY_INVOCATION_RE)]
    .filter((match) => !SUPPORTED_GATEWAY_SUBCOMMANDS.has(match[1]))
    .filter((match) => !BOUNDARY_STATEMENT_RE.test(lineAt(text, match.index)))
    .map((match) => `line ${lineNumberAt(text, match.index)}: openshell gateway ${match[1]}`);
}

function readSource(sourcePath: AffectedSource): string {
  return readFileSync(path.join(repoRoot, "docs", sourcePath), "utf8");
}

/** Variants that publish `sourcePath` through the generated agent-variant build. */
function variantsPublishing(sourcePath: AffectedSource) {
  const targets = findGeneratedNavigationTargets();
  return agentVariants.filter((variant) =>
    targets.some((target) => target.sourcePath === sourcePath && target.variant === variant),
  );
}

/**
 * Documented invocations per page, resolved once at module scope so each test
 * asserts a prepared value instead of re-reading shipped pages.
 */
const DOCUMENTED_INVOCATIONS = new Map<AffectedSource, string[]>(
  AFFECTED_SOURCES.map((sourcePath) => [
    sourcePath,
    unavailableInvocations(readSource(sourcePath)),
  ]),
);

const PUBLISHED_VARIANTS = new Map<AffectedSource, string[]>(
  AFFECTED_SOURCES.map((sourcePath) => [sourcePath, variantsPublishing(sourcePath)]),
);

const VARIANT_INVOCATIONS = new Map<AffectedSource, string[]>(
  AFFECTED_SOURCES.map((sourcePath) => {
    const source = readSource(sourcePath);
    const findings = variantsPublishing(sourcePath).flatMap((variant) =>
      unavailableInvocations(renderAgentVariantPage(source, variant, { sourcePath })).map(
        (finding) => `${sourcePath} (${variant}) ${finding}`,
      ),
    );
    return [sourcePath, findings];
  }),
);

/** The TLS recovery section, sliced once so the ordering assertions stay direct. */
const TLS_SECTION = (() => {
  const source = readSource("reference/troubleshooting.mdx");
  const start = source.indexOf(
    "### Onboarding or Sandbox Creation Reports a TLS Certificate Error",
  );
  const end = source.indexOf("\n### ", start + 1);
  return start >= 0 && end > start ? source.slice(start, end) : "";
})();

const COMMANDS_PAGE = readSource("reference/commands.mdx");
const UPDATE_PAGE = readSource("manage-sandboxes/update-sandboxes.mdx");

describe("OpenShell gateway recovery commands in docs (#13896)", () => {
  it("pins one OpenShell release so the subcommand surface is unambiguous (#13896)", () => {
    expect(pinnedOpenshellVersion()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it.each(AFFECTED_SOURCES)(
    "does not prescribe an unavailable openshell gateway subcommand in %s (#13896)",
    (sourcePath) => {
      expect(DOCUMENTED_INVOCATIONS.get(sourcePath)).toEqual([]);
    },
  );

  it.each(AFFECTED_SOURCES)(
    "publishes %s to at least one generated agent variant (#13896)",
    (sourcePath) => {
      expect(PUBLISHED_VARIANTS.get(sourcePath)?.length).toBeGreaterThan(0);
    },
  );

  it.each(AFFECTED_SOURCES)(
    "does not prescribe an unavailable openshell gateway subcommand in any generated variant of %s (#13896)",
    (sourcePath) => {
      expect(VARIANT_INVOCATIONS.get(sourcePath)).toEqual([]);
    },
  );

  it("replaces the trust recovery with a supported gateway restart (#13896)", () => {
    expect(TLS_SECTION).toContain("has no `openshell gateway trust` subcommand");
    expect(TLS_SECTION).toContain("$$nemoclaw onboard --resume");
    expect(TLS_SECTION).toContain("Reconnect after a host reboot");
    // The pre-fix recovery ran the unavailable command as its first step.
    expect(TLS_SECTION).not.toMatch(/^openshell gateway trust/mu);
  });

  it("retires the gateway through its managed service on the commands page (#13896)", () => {
    expect(COMMANDS_PAGE).toContain("systemctl --user stop openshell-gateway");
    expect(COMMANDS_PAGE).toContain("systemctl --user stop nemoclaw-openshell-gateway");
    expect(COMMANDS_PAGE).toContain('openshell gateway remove "$gateway_name"');
    expect(COMMANDS_PAGE).not.toMatch(/^\s*openshell gateway destroy/mu);
    expect(COMMANDS_PAGE).not.toContain("|| openshell gateway destroy");
  });

  it("retires the gateway through its managed service on the update page (#13896)", () => {
    expect(UPDATE_PAGE).toContain("systemctl --user stop openshell-gateway");
    expect(UPDATE_PAGE).toContain("systemctl --user stop nemoclaw-openshell-gateway");
    expect(UPDATE_PAGE).toContain('openshell gateway remove "$gateway_name"');
    expect(UPDATE_PAGE).not.toMatch(/^\s*openshell gateway destroy/mu);
    expect(UPDATE_PAGE).not.toContain("|| openshell gateway destroy");
  });
});
