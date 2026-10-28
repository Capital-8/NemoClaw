// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression for NemoClaw#13842: the changed-link workflow selected only
// `*.md`, so the 485 Fern `.mdx` pages under docs/ never reached the remote
// link check. Two retired OpenShell routes shipped to the published site
// because no workflow probed them.
//
// These cases run the workflow's real file-selection shell against a real git
// repository, so a pathspec that stops covering MDX fails here.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow, type WorkflowStep } from "../helpers/e2e-workflow-contract";

const WORKFLOW_PATH = ".github/workflows/docs-links-pr.yaml";

function workflow(): Workflow {
  return readYaml<Workflow>(WORKFLOW_PATH);
}

function selectStep(): WorkflowStep {
  const step = workflow().jobs["markdown-links"]?.steps?.find(
    (candidate) => candidate.id === "changed",
  );
  expect(step?.run, `Missing "changed" step in ${WORKFLOW_PATH}`).toBeTruthy();
  return step!;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

// Build a throwaway repository with one commit that changes a .md and a .mdx
// file, then run the workflow's own selection script against that range.
function selectChangedDocs(files: readonly string[]): string[] {
  const repo = mkdtempSync(join(tmpdir(), "nemoclaw-docs-links-select-"));
  try {
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    for (const file of files) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), "# baseline\n");
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "baseline"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();

    for (const file of files) {
      writeFileSync(join(repo, file), "# changed\n");
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "change"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    // The step reads these from the pull_request payload; supply the range
    // directly and let the step's own git invocation do the selecting.
    const script = selectStep()
      .run!.replaceAll("${{ github.event.pull_request.base.sha }}", base)
      .replaceAll("${{ github.event.pull_request.head.sha }}", head);
    const outputFile = join(repo, "github-output");
    writeFileSync(outputFile, "");

    const result = spawnSync("bash", ["-c", script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });
    expect(result.status, result.stderr).toBe(0);

    const output = spawnSync("cat", [outputFile], { encoding: "utf8" }).stdout;
    const filesBlock = /^files<<EOF\n([^]*?)\nEOF$/m.exec(output)?.[1] ?? "";
    return filesBlock === "" ? [] : filesBlock.split("\n");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
}

describe("changed-link workflow selects Fern MDX pages (#13842)", () => {
  it("selects a changed .mdx page for the link check (#13842)", () => {
    const selected = selectChangedDocs(["docs/network-policy/customize-network-policy.mdx"]);

    expect(selected).toEqual(["docs/network-policy/customize-network-policy.mdx"]);
  });

  it("selects a changed .md page for the link check (#13842)", () => {
    const selected = selectChangedDocs(["test/e2e/README.md"]);

    expect(selected).toEqual(["test/e2e/README.md"]);
  });

  it("selects both extensions in one change set (#13842)", () => {
    const selected = selectChangedDocs([
      "docs/network-policy/customize-network-policy.mdx",
      "test/e2e/README.md",
    ]);

    expect(selected).toEqual([
      "docs/network-policy/customize-network-policy.mdx",
      "test/e2e/README.md",
    ]);
  });

  it("ignores a changed file that is neither Markdown nor MDX (#13842)", () => {
    const selected = selectChangedDocs(["src/lib/example.ts"]);

    expect(selected).toEqual([]);
  });

  it("triggers on MDX changes as well as Markdown changes (#13842)", () => {
    const paths = (workflow() as unknown as { on: { pull_request: { paths: string[] } } }).on
      .pull_request.paths;

    expect(paths).toContain("**/*.md");
    expect(paths).toContain("**/*.mdx");
  });

  it("keeps remote probing disabled for contributor-controlled pages (#13842)", () => {
    const runStep = workflow().jobs["markdown-links"]?.steps?.find(
      (candidate) => candidate.name === "Run markdown link checker",
    );
    const run = runStep?.run ?? "";

    expect(run).toContain("check-docs.sh --only-links");
    // A pull-request run sees contributor-controlled URLs. Remote probing needs
    // destination admission and redirect validation the checker does not yet
    // implement, so it must stay off here.
    expect(run).toContain("--local-only");
  });
});
