// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildPublishedRouteIndex,
  findBrokenPublishedRoutes,
  resolvePageLinksByText,
} from "../../scripts/check-docs-published-routes.mts";
import { renderAgentVariantPage } from "../../scripts/sync-agent-variant-docs.mts";

const NETWORK_POLICIES_SOURCE = "reference/network-policies.mdx";
const APPROVAL_SOURCE = "network-policy/approve-network-requests.mdx";
const CUSTOMIZE_POLICY_SOURCE = "network-policy/customize-network-policy.mdx";
const BASELINE_POLICY_SOURCE = "network-policy/change-baseline-network-policy.mdx";
const APPLY_PRESETS_SOURCE = "network-policy/apply-policy-presets.mdx";
const CUSTOM_PRESETS_SOURCE = "network-policy/create-custom-policy-presets.mdx";
const RAW_TLS_SOURCE = "network-policy/configure-raw-tls-passthrough.mdx";
const REPLACE_POLICY_SOURCE = "network-policy/replace-live-network-policy.mdx";
const INTEGRATION_POLICY_SOURCE = "network-policy/integration-policy-examples.mdx";
const GMAIL_SOURCE = "network-policy/set-up-gmail-with-an-app-password.mdx";
const APPROVAL_LINK_TEXT = "Approve or Deny Agent Network Requests";
const GMAIL_LINK_TEXT = "Set Up Gmail With an App Password";
// The guide variants that publish the Network Policy pages in docs/index.yml.
const PUBLISHED_POLICY_VARIANTS = ["openclaw", "hermes", "deepagents"] as const;
const OPENSHELL_DOCS_ORIGIN = "https://docs.nvidia.com/openshell/";
const VERSIONED_OPENSHELL_ROUTE =
  /^https:\/\/docs\.nvidia\.com\/openshell\/latest\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const INLINE_SEPARATOR_JOIN = /\]\([^)\n]*\)[^\n]*[^\S\n]-[^\S\n]\[/;
const OPENSHELL_SCHEMA_ROUTE =
  "https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema";
const OPENSHELL_MANAGE_POLICIES_ROUTE =
  "https://docs.nvidia.com/openshell/latest/how-it-works/policies/manage-policies";
const RETIRED_OPENSHELL_ROUTES = [
  "https://docs.nvidia.com/openshell/latest/reference/policy-schema.html",
  "https://docs.nvidia.com/openshell/latest/sandboxes/policies.html",
] as const;
const POLICY_PAGE_SOURCES = [
  CUSTOMIZE_POLICY_SOURCE,
  RAW_TLS_SOURCE,
  BASELINE_POLICY_SOURCE,
] as const;
const RENDERED_POLICY_CASES = PUBLISHED_POLICY_VARIANTS.flatMap((variant) =>
  POLICY_PAGE_SOURCES.map((source) => [variant, source] as const),
);
const CUSTOMIZE_SHARED_WORKFLOWS = [
  "Change the Baseline Network Policy",
  "Apply Policy Presets",
  "Create Custom Policy Presets",
  "Replace the Live Network Policy",
  "Approve or Deny Network Requests",
] as const;
const CUSTOMIZE_AGENT_WORKFLOWS = [
  "Configure Raw TLS Passthrough",
  "Explain Network Policy to Agents",
] as const;
const SHARED_CONFIGURATION_SOURCES = [
  BASELINE_POLICY_SOURCE,
  APPLY_PRESETS_SOURCE,
  CUSTOM_PRESETS_SOURCE,
  REPLACE_POLICY_SOURCE,
] as const;
const DEEPAGENTS_POLICY_ROUTES = [
  "/user-guide/deepagents/network-policy/approve-network-requests",
  "/user-guide/deepagents/network-policy/customize-network-policy",
  "/user-guide/deepagents/network-policy/configure-policies/change-baseline-network-policy",
  "/user-guide/deepagents/network-policy/configure-policies/apply-policy-presets",
  "/user-guide/deepagents/network-policy/configure-policies/create-custom-policy-presets",
  "/user-guide/deepagents/network-policy/configure-policies/replace-live-network-policy",
] as const;
const DEEPAGENTS_EXCLUDED_POLICY_ROUTES = [
  "/user-guide/deepagents/network-policy/configure-policies/configure-raw-tls-passthrough",
  "/user-guide/deepagents/network-policy/explain-network-policy-to-agents",
  "/user-guide/deepagents/network-policy/integration-policy-examples",
  "/user-guide/deepagents/network-policy/set-up-gmail-with-an-app-password",
] as const;
const LEGACY_CUSTOMIZE_POLICY_POINTERS = [
  {
    anchors: [
      "prerequisites",
      "edit-the-policy-file",
      "re-run-onboard",
      "verify-the-policy",
      "add-blueprint-policy-additions",
    ],
    target: "configure-policies/change-baseline-network-policy",
  },
  {
    anchors: ["scope-of-dynamic-changes", "add-a-preset-file-with-policy-add-recommended"],
    target: "configure-policies/apply-policy-presets",
  },
  {
    anchors: ["approve-requests-interactively"],
    target: "approve-network-requests",
  },
  {
    anchors: [
      "authoring",
      "apply-a-single-file",
      "apply-every-file-in-a-directory",
      "remove-a-custom-preset",
      "custom-recipe-url-based-mcp-server",
    ],
    target: "configure-policies/create-custom-policy-presets",
  },
  {
    anchors: ["custom-recipe-for-raw-tls-passthrough-with-tls-skip"],
    target: "configure-policies/configure-raw-tls-passthrough",
  },
  {
    anchors: ["export-edit-and-set-the-base-policy"],
    target: "configure-policies/replace-live-network-policy",
  },
] as const;

function readDoc(source: string): string {
  return readFileSync(path.join(process.cwd(), "docs", source), "utf8");
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

function expectUniqueAnchorsBeforePointer(
  source: string,
  anchors: readonly string[],
  target: string,
): void {
  const pointer = `](${target})`;

  for (const anchor of anchors) {
    const marker = `<a id="${anchor}"></a>`;
    expect(source.split(marker)).toHaveLength(2);
    const anchorIndex = source.indexOf(marker);
    const pointerIndex = source.indexOf(pointer, anchorIndex + marker.length);
    expect(pointerIndex).toBeGreaterThan(anchorIndex);
    expect(source.slice(anchorIndex + marker.length, pointerIndex)).not.toContain("](");
  }
}

describe("shared Network Policies published routes", () => {
  it("keeps the approval guide link inside variants that publish it (#6601)", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(NETWORK_POLICIES_SOURCE, index)).toEqual([]);
    expect(
      [...resolvePageLinksByText(NETWORK_POLICIES_SOURCE, APPROVAL_LINK_TEXT, index)].sort((a, b) =>
        a.fromRoute.localeCompare(b.fromRoute),
      ),
    ).toEqual([
      {
        fromRoute: "/user-guide/deepagents/reference/network-policies",
        published: true,
        resolved: "/user-guide/deepagents/network-policy/approve-network-requests",
        target: "../network-policy/approve-network-requests",
      },
      {
        fromRoute: "/user-guide/hermes/reference/network-policies",
        published: true,
        resolved: "/user-guide/hermes/network-policy/approve-network-requests",
        target: "../network-policy/approve-network-requests",
      },
      {
        fromRoute: "/user-guide/openclaw/reference/network-policies",
        published: true,
        resolved: "/user-guide/openclaw/network-policy/approve-network-requests",
        target: "../network-policy/approve-network-requests",
      },
    ]);
  });

  it("resolves every customization guide link inside its published variants", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(CUSTOMIZE_POLICY_SOURCE, index)).toEqual([]);
  });

  it.each([
    ["openclaw", true],
    ["hermes", true],
    ["deepagents", false],
  ] as const)(
    "keeps the customize decision table contiguous for %s",
    (variant, includesAgentWorkflows) => {
      const rendered = renderAgentVariantPage(readDoc(CUSTOMIZE_POLICY_SOURCE), variant);
      const tableLines =
        rendered
          .match(/\| Goal \| Use this workflow \|\n(?:\|[^\n]+\|\n)+/)?.[0]
          .trimEnd()
          .split("\n") ?? [];
      const expectedWorkflows = includesAgentWorkflows
        ? [...CUSTOMIZE_SHARED_WORKFLOWS, ...CUSTOMIZE_AGENT_WORKFLOWS]
        : CUSTOMIZE_SHARED_WORKFLOWS;

      expect(tableLines).toHaveLength(expectedWorkflows.length + 2);
      expect(tableLines.slice(2)).toEqual(
        expect.arrayContaining(
          expectedWorkflows.map((workflow) => expect.stringContaining(`[${workflow}]`)),
        ),
      );
      expect(
        tableLines.slice(2).every((row) => /^\| [^|\n]+ \| \[[^\]\n]+\]\([^)]+\) \|$/.test(row)),
      ).toBe(true);
    },
  );

  it.each(DEEPAGENTS_POLICY_ROUTES)("publishes the Deep Agents policy route %s", (route) => {
    const index = buildPublishedRouteIndex();
    expect(index.routes.has(route), route).toBe(true);
  });

  it.each(DEEPAGENTS_EXCLUDED_POLICY_ROUTES)(
    "excludes the Deep Agents policy route %s",
    (route) => {
      const index = buildPublishedRouteIndex();
      expect(index.routes.has(route), route).toBe(false);
    },
  );

  it.each(SHARED_CONFIGURATION_SOURCES)(
    "publishes the shared %s policy page for every supported agent",
    (source) => {
      const index = buildPublishedRouteIndex();
      const slug = source
        .split("/")
        .at(-1)
        ?.replace(/\.mdx$/, "");
      expect(
        index.sourceToRoutes
          .get(source)
          ?.map(({ route }) => route)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([
        `/user-guide/deepagents/network-policy/configure-policies/${slug}`,
        `/user-guide/hermes/network-policy/configure-policies/${slug}`,
        `/user-guide/openclaw/network-policy/configure-policies/${slug}`,
      ]);
      expect(findBrokenPublishedRoutes(source, index)).toEqual([]);
    },
  );

  it("keeps raw TLS configuration scoped to OpenClaw and Hermes", () => {
    const index = buildPublishedRouteIndex();

    expect(
      index.sourceToRoutes
        .get(RAW_TLS_SOURCE)
        ?.map(({ route }) => route)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "/user-guide/hermes/network-policy/configure-policies/configure-raw-tls-passthrough",
      "/user-guide/openclaw/network-policy/configure-policies/configure-raw-tls-passthrough",
    ]);
    expect(findBrokenPublishedRoutes(RAW_TLS_SOURCE, index)).toEqual([]);
  });

  it("removes unsupported workflows from the Deep Agents page variants", () => {
    const approval = renderAgentVariantPage(readDoc(APPROVAL_SOURCE), "deepagents");
    const customize = renderAgentVariantPage(readDoc(CUSTOMIZE_POLICY_SOURCE), "deepagents");
    const baseline = renderAgentVariantPage(readDoc(BASELINE_POLICY_SOURCE), "deepagents");
    const presets = renderAgentVariantPage(readDoc(APPLY_PRESETS_SOURCE), "deepagents");
    const custom = renderAgentVariantPage(readDoc(CUSTOM_PRESETS_SOURCE), "deepagents");

    expect(approval).not.toContain("## Run the Walkthrough Script");
    expect(customize).not.toContain("Configure Raw TLS Passthrough");
    expect(customize).not.toContain("Explain Network Policy to Agents");
    expect(customize).not.toContain("Common Integration Policy Examples");
    expect(baseline).toContain("agents/langchain-deepagents-code/policy-additions.yaml");
    expect(presets).toContain("Deep Agents baseline, tier, Tavily, and observability");
    expect(presets).not.toContain("Common Integration Policy Examples");
    expect(presets).toContain("nemo-deepagents my-assistant policy add weather --dry-run");
    expect(presets).toContain("nemo-deepagents my-assistant policy remove weather --yes");
    expect(presets).not.toContain("nemo-deepagents my-assistant policy add pypi");
    expect(custom).toContain("/opt/venv/bin/python3*");
    expect(custom).not.toContain("## Configure a URL-Based MCP Server");
    expect(custom).not.toContain("Configure Raw TLS Passthrough");
  });

  it("publishes the Gmail task only where the integration hub is available", () => {
    const index = buildPublishedRouteIndex();

    expect(
      index.sourceToRoutes
        .get(GMAIL_SOURCE)
        ?.map(({ route }) => route)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "/user-guide/hermes/network-policy/set-up-gmail-with-an-app-password",
      "/user-guide/openclaw/network-policy/set-up-gmail-with-an-app-password",
    ]);
    expect(findBrokenPublishedRoutes(GMAIL_SOURCE, index)).toEqual([]);
    expect(
      index.routes.has("/user-guide/deepagents/network-policy/set-up-gmail-with-an-app-password"),
    ).toBe(false);
  });

  it("keeps the Gmail compatibility section linked to its focused page", () => {
    const index = buildPublishedRouteIndex();

    expect(findBrokenPublishedRoutes(INTEGRATION_POLICY_SOURCE, index)).toEqual([]);
    expect(
      [...resolvePageLinksByText(INTEGRATION_POLICY_SOURCE, GMAIL_LINK_TEXT, index)].sort((a, b) =>
        a.fromRoute.localeCompare(b.fromRoute),
      ),
    ).toEqual([
      {
        fromRoute: "/user-guide/hermes/network-policy/integration-policy-examples",
        published: true,
        resolved: "/user-guide/hermes/network-policy/set-up-gmail-with-an-app-password",
        target: "set-up-gmail-with-an-app-password",
      },
      {
        fromRoute: "/user-guide/openclaw/network-policy/integration-policy-examples",
        published: true,
        resolved: "/user-guide/openclaw/network-policy/set-up-gmail-with-an-app-password",
        target: "set-up-gmail-with-an-app-password",
      },
    ]);
  });

  it.each(LEGACY_CUSTOMIZE_POLICY_POINTERS)(
    "preserves the compatibility anchors before $target (#7495)",
    ({ anchors, target }) => {
      const customizePolicy = readDoc(CUSTOMIZE_POLICY_SOURCE);
      expectUniqueAnchorsBeforePointer(customizePolicy, anchors, target);
    },
  );

  it("preserves retained policy sections (#7495)", () => {
    expect(readDoc(CUSTOMIZE_POLICY_SOURCE)).toContain("## Custom Preset Files");
    expect(readDoc(INTEGRATION_POLICY_SOURCE)).toContain("## Gmail With an App Password");
  });
});

describe("Network Policy pages use versioned OpenShell routes (#13842)", () => {
  it.each(RENDERED_POLICY_CASES)(
    "renders no retired OpenShell route in the %s variant of %s (#13842)",
    (variant, source) => {
      const rendered = renderAgentVariantPage(readDoc(source), variant);

      expect(RETIRED_OPENSHELL_ROUTES.filter((retired) => rendered.includes(retired))).toEqual([]);
    },
  );

  it.each(RENDERED_POLICY_CASES)(
    "keeps every OpenShell link on a versioned canonical route in the %s variant of %s (#13842)",
    (variant, source) => {
      const rendered = renderAgentVariantPage(readDoc(source), variant);
      const targets = linkTargets(rendered).filter((target) =>
        target.startsWith(OPENSHELL_DOCS_ORIGIN),
      );

      expect(targets.length).toBeGreaterThan(0);
      expect(targets.filter((target) => !VERSIONED_OPENSHELL_ROUTE.test(target))).toEqual([]);
    },
  );

  it.each(PUBLISHED_POLICY_VARIANTS)(
    "links the schema and policy-iteration pages from Customize Related Topics in the %s variant (#13842)",
    (variant) => {
      const related = relatedTopicsSection(
        renderAgentVariantPage(readDoc(CUSTOMIZE_POLICY_SOURCE), variant),
      );

      expect(related).toContain(OPENSHELL_SCHEMA_ROUTE);
      expect(related).toContain(OPENSHELL_MANAGE_POLICIES_ROUTE);
    },
  );

  it.each(PUBLISHED_POLICY_VARIANTS)(
    "gives each Customize Related Topics reference its own list item in the %s variant (#13842)",
    (variant) => {
      const related = relatedTopicsSection(
        renderAgentVariantPage(readDoc(CUSTOMIZE_POLICY_SOURCE), variant),
      );

      // A collapsed list keeps every reference but drops the list-item markers,
      // so the reference count exceeds the list-item count.
      expect(linkTargets(related).length).toBeGreaterThan(1);
      expect(related.split("\n").filter((line) => line.trimStart().startsWith("- "))).toHaveLength(
        linkTargets(related).length,
      );
    },
  );

  it.each(PUBLISHED_POLICY_VARIANTS)(
    "does not join Customize Related Topics references with inline separators in the %s variant (#13842)",
    (variant) => {
      const related = relatedTopicsSection(
        renderAgentVariantPage(readDoc(CUSTOMIZE_POLICY_SOURCE), variant),
      );

      expect(related).not.toMatch(INLINE_SEPARATOR_JOIN);
    },
  );

  it("keeps the retired OpenShell routes out of the policy sources (#13842)", () => {
    expect(
      POLICY_PAGE_SOURCES.filter((source) =>
        RETIRED_OPENSHELL_ROUTES.some((retired) => readDoc(source).includes(retired)),
      ),
    ).toEqual([]);
  });
});
