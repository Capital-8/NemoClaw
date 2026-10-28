// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.dirname(path.dirname(import.meta.dirname));
const CHECK_DOCS = path.join(
  import.meta.dirname,
  "..",
  "e2e",
  "e2e-cloud-experimental",
  "check-docs.sh",
);

function runCheckDocs(filePath: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [CHECK_DOCS, "--only-links", "--local-only", filePath], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

// Remote probing is off by default in these cases except where a case opts in,
// so the suite never depends on network reachability.
function runRemoteCheckDocs(filePath: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [CHECK_DOCS, "--only-links", filePath], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function writeDoc(prefix: string, body: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-check-docs-${prefix}-`));
  const docPath = path.join(tempDir, "guide.mdx");
  fs.writeFileSync(docPath, body);
  return docPath;
}

// A curl stand-in that records each invocation and answers with fixed headers.
function curlShim(prefix: string, response: string): { path: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-check-docs-${prefix}-`));
  const log = path.join(dir, "calls.log");
  const shim = path.join(dir, "curl");
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash\necho "$*" >> ${log}\nprintf '${response}'\nexit 0\n`,
    { mode: 0o755 },
  );
  return {
    path: shim,
    calls: () =>
      fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
}

describe("check-docs link validation", () => {
  it("reports broken local markdown links with source line numbers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(path.join(tempDir, "exists.md"), "# ok\n");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "[working](./exists.md)",
        "[broken](./missing.md)",
        "```md",
        "[ignored](./inside-code-fence.md)",
        "```",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `broken local link in ${mdPath}:4 -> ./missing.md`,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-code-fence.md");
  });

  it("ignores broken links inside fenced code blocks", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-codefence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "```md", "[example](./missing.md)", "```", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
  });

  it("ignores markdown-looking links inside inline code spans", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-inlinecode-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "Use `For more information, refer to [DOC PAGE](/doc/path).` as a placeholder.",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("/doc/path");
  });

  it("resolves Fern user-guide variant routes in Markdown and MDX hrefs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-fern-"));
    const mdPath = path.join(tempDir, "guide.mdx");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "[OpenClaw overview](/user-guide/openclaw/about/overview)",
        "[OpenClaw home](/openclaw)",
        "[OpenClaw hardening](/user-guide/openclaw/manage-sandboxes/configure-sandboxes/review-sandbox-hardening)",
        '<Card title="Hermes overview" href="/user-guide/hermes/about/overview">',
        '<Card title="Hermes home" href="/user-guide/hermes">',
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
  });

  it("resolves Fern extensionless and route-relative links from docs pages", () => {
    const routeRelativePage = path.join(
      REPO_ROOT,
      "docs",
      "get-started",
      "windows-preparation.mdx",
    );
    const slugAliasPage = path.join(REPO_ROOT, "docs", "about", "how-it-works.mdx");

    const routeRelativeResult = runCheckDocs(routeRelativePage);
    const slugAliasResult = runCheckDocs(slugAliasPage);

    expect(`${routeRelativeResult.stdout}${routeRelativeResult.stderr}`).not.toContain(
      "../../quickstart",
    );
    expect(routeRelativeResult.status).toBe(0);
    expect(`${slugAliasResult.stdout}${slugAliasResult.stderr}`).not.toContain(
      "../../manage-sandboxes/configure-sandboxes/review-sandbox-hardening",
    );
    expect(slugAliasResult.status).toBe(0);
  });

  it("resolves route-relative links from Deep Agents generated source aliases", () => {
    const tempDir = fs.mkdtempSync(path.join(REPO_ROOT, "docs", "check-docs-deepagents-"));
    const sourcePath = path.join(tempDir, "source.mdx");
    const navPath = path.join(tempDir, "index.yml");
    const sourceRel = path.relative(path.join(REPO_ROOT, "docs"), sourcePath);
    const generatedRel = `_build/agent-variants/${sourceRel.replace(/\.mdx$/, ".deepagents.generated.mdx")}`;
    const targetRel = path.relative(
      path.join(REPO_ROOT, "docs"),
      path.join(tempDir, "target.deepagents.generated.mdx"),
    );
    try {
      fs.writeFileSync(
        sourcePath,
        [
          "---",
          'title: "Temporary Deep Agents Source"',
          "---",
          "",
          "[Generated target](target)",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        navPath,
        [
          "navigation:",
          "  - tab: user-guide",
          "    variants:",
          "      - title: Deep Agents",
          "        slug: deepagents",
          "        layout:",
          '          - section: "Temporary"',
          "            slug: temporary",
          "            contents:",
          '              - page: "Source"',
          `                path: ${generatedRel}`,
          "                slug: source",
          '              - page: "Target"',
          `                path: ${targetRel}`,
          "                slug: target",
          "",
        ].join("\n"),
      );

      const result = runCheckDocs(sourcePath, { CHECK_DOCS_FERN_NAV_YML: navPath });

      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("resolves the native changelog root by its published slug", () => {
    const tempDir = fs.mkdtempSync(path.join(REPO_ROOT, "docs", "check-docs-changelog-"));
    const sourcePath = path.join(tempDir, "source.mdx");
    const navPath = path.join(tempDir, "index.yml");
    const sourceRel = path.relative(path.join(REPO_ROOT, "docs"), sourcePath);
    try {
      fs.writeFileSync(sourcePath, "# Reference\n\n[Release Notes](../release-notes)\n");
      fs.writeFileSync(
        navPath,
        [
          "navigation:",
          "  - tab: user-guide",
          "    variants:",
          '      - title: "OpenClaw"',
          "        slug: openclaw",
          "        layout:",
          "          - changelog: ./changelog",
          '            title: "Release Notes"',
          "            slug: release-notes",
          '          - section: "Reference"',
          "            slug: reference",
          "            contents:",
          '              - page: "Source"',
          `                path: ${sourceRel}`,
          "                slug: source",
          "",
        ].join("\n"),
      );

      const result = runCheckDocs(sourcePath, { CHECK_DOCS_FERN_NAV_YML: navPath });

      expect(`${result.stdout}${result.stderr}`).not.toContain("../../release-notes");
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects .md/.mdx suffixes for links that resolve as Fern routes", () => {
    const tempDir = fs.mkdtempSync(path.join(REPO_ROOT, "docs", "check-docs-route-suffix-"));
    const tempPath = path.join(tempDir, "temp.mdx");
    const navPath = path.join(tempDir, "index.yml");
    const tempNavPath = path.relative(path.join(REPO_ROOT, "docs"), tempPath);
    try {
      fs.writeFileSync(
        tempPath,
        [
          "---",
          'title: "Temporary Link Check Page"',
          "---",
          "",
          "[Wrong](deployment/deploy-to-remote-gpu.mdx)",
          "[Right](deployment/deploy-to-remote-gpu)",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        navPath,
        [
          "navigation:",
          "  - tab: user-guide",
          "    variants:",
          "      - title: OpenClaw",
          "        slug: openclaw",
          "        layout:",
          '          - page: "Temp"',
          `            path: ${tempNavPath}`,
          "            slug: temp",
          '          - section: "Deployment"',
          "            slug: deployment",
          "            contents:",
          '              - page: "Deploy"',
          "                path: deployment/deploy-to-remote-gpu.mdx",
          "                slug: deploy-to-remote-gpu",
          "",
        ].join("\n"),
      );

      const result = runCheckDocs(tempPath, { CHECK_DOCS_FERN_NAV_YML: navPath });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `route-style link should omit .md/.mdx extension in ${tempPath}:5 -> deployment/deploy-to-remote-gpu.mdx`,
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        `broken local link in ${tempPath}:6 -> deployment/deploy-to-remote-gpu`,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects broken Fern site routes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-bad-fern-"));
    const mdPath = path.join(tempDir, "guide.mdx");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "[Missing](/user-guide/openclaw/no-such-section/no-such-page)", ""].join(
        "\n",
      ),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `broken site route in ${mdPath}:3 -> /user-guide/openclaw/no-such-section/no-such-page`,
    );
  });

  it("fails loudly when the Fern route index cannot be built", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-bad-nav-"));
    const mdPath = path.join(tempDir, "guide.mdx");
    const navPath = path.join(tempDir, "index.yml");
    fs.writeFileSync(navPath, "navigation: []\n");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "[Overview](/user-guide/openclaw/about/overview)", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath, { CHECK_DOCS_FERN_NAV_YML: navPath });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("failed to parse Fern navigation");
    expect(`${result.stdout}${result.stderr}`).toContain("no Fern routes found");
  });

  it("ignores broken links inside tilde-fenced code blocks", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tildefence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "~~~md", "[example](./missing.md)", "~~~", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
  });

  it("keeps scanning disabled for mismatched or shorter fence closers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-mixedfence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "~~~~md",
        "[still-ignored](./inside-code-fence.md)",
        "```",
        "[also-ignored](./inside-shorter-fence.md)",
        "~~~~",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-code-fence.md");
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-shorter-fence.md");
  });

  it("does not treat fence markers with trailing text as closing fences", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-fenceclose-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "```md",
        "```not-a-close",
        "[still-ignored](./inside-code-fence.md)",
        "```",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-code-fence.md");
  });

  it("ignores links inside HTML comments and preserves later line numbers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-htmlcomment-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "<!--",
        "[ignored](./inside-comment.md)",
        "-->",
        "",
        "[broken](./missing.md)",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-comment.md");
    expect(`${result.stdout}${result.stderr}`).toContain(
      `broken local link in ${mdPath}:6 -> ./missing.md`,
    );
  });

  it("fails on malformed HTML comments", { timeout: 15000 }, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-badcomment-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "<!-- missing close", "[ignored](./inside-comment.md)", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`malformed HTML comment in ${mdPath}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-comment.md");
  });
});

// #13842: the scheduled external-link workflow probes the published set, so the
// checker must refuse internal destinations, validate every redirect hop, and
// stop before its own deadline rather than being killed by the job timeout.
describe("check-docs remote probe admission (#13842)", () => {
  it.each([
    ["loopback IPv4", "http://127.0.0.1/admin"],
    ["loopback name", "http://localhost/admin"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private 10/8", "http://10.0.0.5/admin"],
    ["private 192.168/16", "http://192.168.1.1/admin"],
    ["private 172.16/12", "http://172.16.0.1/admin"],
    ["CGNAT 100.64/10", "http://100.64.0.1/admin"],
    ["IPv6 loopback", "http://[::1]/admin"],
    ["IPv6 link-local", "http://[fe80::1]/admin"],
    ["IPv6 unique-local", "http://[fd00::1]/admin"],
    ["userinfo disguise", "http://user:pass@example.com/admin"],
  ])("refuses a %s destination without invoking curl (#13842)", (_label, url) => {
    const shim = curlShim("ssrf", "HTTP/1.1 200 OK\\r\\n\\r\\n");
    const result = runRemoteCheckDocs(writeDoc("ssrf", `- [target](${url})\n`), {
      CURL: shim.path,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("refused non-public probe destination");
    // The guard must reject before the request, not merely report afterwards.
    expect(shim.calls()).toHaveLength(0);
  });

  it("probes a public destination (#13842)", () => {
    const shim = curlShim("public", "HTTP/1.1 200 OK\\r\\n\\r\\n");
    const result = runRemoteCheckDocs(
      writeDoc("public", "- [schema](https://docs.nvidia.com/openshell/latest/)\n"),
      { CURL: shim.path },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(shim.calls()).toHaveLength(1);
  });

  it.each([
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["private 10/8", "http://10.0.0.5/admin"],
  ])("refuses a redirect to a %s destination (#13842)", (_label, target) => {
    const shim = curlShim("redir", `HTTP/1.1 302 Found\\r\\nLocation: ${target}\\r\\n\\r\\n`);
    const result = runRemoteCheckDocs(writeDoc("redir", "- [x](https://example.com/redir)\n"), {
      CURL: shim.path,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("refused non-public probe destination");
    // Only the public first hop may be requested.
    expect(shim.calls()).toHaveLength(1);
  });

  it("stops before its probe budget and lists every unprobed URL (#13842)", () => {
    const shim = curlShim("budget", "HTTP/1.1 200 OK\\r\\n\\r\\n");
    const body = Array.from(
      { length: 3 },
      (_, index) => `- [l${index}](https://example.com/p${index})`,
    ).join("\n");
    const result = runRemoteCheckDocs(writeDoc("budget", `${body}\n`), {
      CHECK_DOC_LINKS_PROBE_BUDGET_SECONDS: "0",
      CURL: shim.path,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("remote probe budget exhausted");
    expect(output.match(/unprobed: https:\/\/example\.com\/p[0-9]+/g)).toHaveLength(3);
    expect(shim.calls()).toHaveLength(0);
  });
});
