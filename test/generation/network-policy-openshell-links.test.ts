// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression for NemoClaw#13842: the published Network Policy pages linked to
// two retired OpenShell routes (`reference/policy-schema.html` and
// `sandboxes/policies.html`), and the Customize page's Related Topics list
// collapsed three references into one paragraph with literal ` - ` separators.
//
// The assertions read the rendered agent variants, which is the surface the
// published pages are built from, so a source-only fix that leaves a variant
// broken still fails here.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { renderAgentVariantPage } from "../../scripts/sync-agent-variant-docs.mts";

const CUSTOMIZE_POLICY_SOURCE = "network-policy/customize-network-policy.mdx";
const RAW_TLS_SOURCE = "network-policy/configure-raw-tls-passthrough.mdx";
const BASELINE_POLICY_SOURCE = "network-policy/change-baseline-network-policy.mdx";
const POLICY_PAGE_SOURCES = [
  CUSTOMIZE_POLICY_SOURCE,
  RAW_TLS_SOURCE,
  BASELINE_POLICY_SOURCE,
] as const;
// The guide variants that publish these pages in docs/index.yml.
const PUBLISHED_POLICY_VARIANTS = ["openclaw", "hermes", "deepagents"] as const;
const RENDERED_POLICY_CASES = PUBLISHED_POLICY_VARIANTS.flatMap((variant) =>
  POLICY_PAGE_SOURCES.map((source) => [variant, source] as const),
);

const OPENSHELL_DOCS_ORIGIN = "https://docs.nvidia.com/openshell/";
const VERSIONED_OPENSHELL_ROUTE =
  /^https:\/\/docs\.nvidia\.com\/openshell\/latest\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const INLINE_SEPARATOR_JOIN = /\]\([^)\n]*\)[^\n]*[^\S\n]-[^\S\n]\[/;
const SCHEMA_ROUTE = "https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema";
const MANAGE_POLICIES_ROUTE =
  "https://docs.nvidia.com/openshell/latest/how-it-works/policies/manage-policies";
const RETIRED_OPENSHELL_ROUTES = [
  "https://docs.nvidia.com/openshell/latest/reference/policy-schema.html",
  "https://docs.nvidia.com/openshell/latest/sandboxes/policies.html",
] as const;

function readDoc(source: string): string {
  return readFileSync(path.join(process.cwd(), "docs", source), "utf8");
}

function renderPolicyPage(source: string, variant: (typeof PUBLISHED_POLICY_VARIANTS)[number]) {
  return renderAgentVariantPage(readDoc(source), variant);
}

// Count link targets directly instead of through the line-oriented link
// extractor, so a reference whose text wraps across lines is still counted.
function linkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

function relatedTopicsSection(markdown: string): string {
  const start = markdown.indexOf("## Related Topics");
  expect(start).toBeGreaterThan(-1);
  return markdown.slice(start);
}

function listItemLines(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.trimStart().startsWith("- "));
}

describe("Network Policy pages link to live OpenShell routes (#13842)", () => {
  it.each(RENDERED_POLICY_CASES)(
    "renders no retired OpenShell route in the %s variant of %s (#13842)",
    (variant, source) => {
      const rendered = renderPolicyPage(source, variant);

      expect(RETIRED_OPENSHELL_ROUTES.filter((retired) => rendered.includes(retired))).toEqual([]);
    },
  );

  it.each(RENDERED_POLICY_CASES)(
    "keeps every OpenShell link on a versioned canonical route in the %s variant of %s (#13842)",
    (variant, source) => {
      const targets = linkTargets(renderPolicyPage(source, variant)).filter((target) =>
        target.startsWith(OPENSHELL_DOCS_ORIGIN),
      );

      expect(targets.length).toBeGreaterThan(0);
      expect(targets.filter((target) => !VERSIONED_OPENSHELL_ROUTE.test(target))).toEqual([]);
    },
  );

  it.each(PUBLISHED_POLICY_VARIANTS)(
    "links the schema and policy-iteration pages from Customize Related Topics in the %s variant (#13842)",
    (variant) => {
      const related = relatedTopicsSection(renderPolicyPage(CUSTOMIZE_POLICY_SOURCE, variant));

      expect(related).toContain(SCHEMA_ROUTE);
      expect(related).toContain(MANAGE_POLICIES_ROUTE);
    },
  );
});

describe("Customize Network Policy Related Topics list structure (#13842)", () => {
  it.each(PUBLISHED_POLICY_VARIANTS)(
    "gives each Related Topics reference its own list item in the %s variant (#13842)",
    (variant) => {
      const related = relatedTopicsSection(renderPolicyPage(CUSTOMIZE_POLICY_SOURCE, variant));

      // A collapsed list keeps every reference but drops the list-item markers,
      // so the reference count exceeds the list-item count.
      expect(linkTargets(related).length).toBeGreaterThan(1);
      expect(listItemLines(related)).toHaveLength(linkTargets(related).length);
    },
  );

  it.each(PUBLISHED_POLICY_VARIANTS)(
    "does not join Related Topics references with inline separators in the %s variant (#13842)",
    (variant) => {
      const related = relatedTopicsSection(renderPolicyPage(CUSTOMIZE_POLICY_SOURCE, variant));

      expect(related).not.toMatch(INLINE_SEPARATOR_JOIN);
    },
  );

  it("keeps the retired routes out of the Customize source page (#13842)", () => {
    const source = readDoc(CUSTOMIZE_POLICY_SOURCE);

    expect(RETIRED_OPENSHELL_ROUTES.filter((retired) => source.includes(retired))).toEqual([]);
  });
});
