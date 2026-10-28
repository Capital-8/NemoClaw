// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateSessionReport,
  validateOpeningReport,
} from "../../../scripts/checks/pr-session-report.mts";

it("rejects a comment without an authoring report", () => {
  expect(() => validateSessionReport("## Outcome\nRead skills and ran tests.")).toThrow();
});

const template = `<!-- agent-session-report:opening -->
<details>
<summary>Authoring session report: PR opening</summary>

<!-- agent-session-report:v1 -->
| Field | Status | Value | Evidence or limit |
| --- | --- | --- | --- |
| Harness | unavailable | - | Authoring harness evidence unavailable. |
| Skills | unavailable | - | Instruction record missing. |
| Instruction files | unavailable | - | Instruction record missing. |
| Tool calls | unavailable | - | Invocation record missing. |
| Session window | unavailable | - | Start timestamp missing. |
| Compactions | unavailable | - | Compaction record missing. |
| Models | unavailable | - | Model history missing. |
| Reasoning levels | unavailable | - | Settings history missing. |
<!-- /agent-session-report -->
</details>`;

it("accepts a report when all authoring evidence is unavailable", () => {
  expect(() => validateSessionReport(template)).not.toThrow();
});

it("accepts Windows line endings in a posted comment", () => {
  expect(() => validateOpeningReport([{ body: template.replaceAll("\n", "\r\n") }])).not.toThrow();
});

it("requires the report comment to be collapsed by default", () => {
  expect(() => validateSessionReport(template.replace("<details>", "<details open>"))).toThrow();
});

it("does not let a later report replace the opening report", () => {
  const later = template
    .replace(":opening -->", ":commit -->")
    .replace("PR opening", "Commit update");
  const quoted = later.replace(
    "<!-- agent-session-report:v1 -->",
    "<!-- agent-session-report:opening -->\n<!-- agent-session-report:v1 -->",
  );
  expect(() => validateOpeningReport([{ body: quoted }])).toThrow();
  expect(() => validateOpeningReport([{ body: quoted }, { body: template }])).not.toThrow();
});

it("selects one opening report among unrelated and later comments", () => {
  const later = template
    .replace(":opening -->", ":commit -->")
    .replace("PR opening", "Commit update");
  expect(() =>
    validateOpeningReport([{ body: "Looks good" }, { body: later }, { body: template }]),
  ).not.toThrow();
  expect(() => validateOpeningReport([{ body: later }])).toThrow();
  expect(() => validateOpeningReport([{ body: template }, { body: template }])).toThrow();
  expect(() =>
    validateOpeningReport([{ body: template.replace("| unavailable |", "| invented |") }]),
  ).toThrow();
  expect(() => validateOpeningReport([])).toThrow();
});

it.each([
  ["commit", "Commit update"],
  ["merge", "PR merge"],
])("accepts the shared collapsed format for a future %s report", (stage, label) => {
  expect(() =>
    validateSessionReport(
      template.replace(":opening -->", `:${stage} -->`).replace("PR opening", label),
    ),
  ).not.toThrow();
});

it("accepts mixed evidence statuses and a confirmed zero", () => {
  const body = template
    .replace("| Harness | unavailable | - |", "| Harness | recorded | Pi 1.3.0 |")
    .replace("| Skills | unavailable | - |", "| Skills | partial | sample (complete read) |")
    .replace("| Compactions | unavailable | - |", "| Compactions | recorded | 0 |");
  expect(() => validateSessionReport(body)).not.toThrow();
});

it.each([
  [
    "missing instruction files",
    (body: string) =>
      body
        .split("\n")
        .filter((line) => !line.startsWith("| Instruction files |"))
        .join("\n"),
  ],
  ["duplicate field", (body: string) => body.replace("| Models |", "| Skills |")],
  ["unknown field", (body: string) => body.replace("| Models |", "| Tokens |")],
  ["unknown status", (body: string) => body.replace("| unavailable |", "| compliant |")],
  [
    "unavailable zero",
    (body: string) =>
      body.replace("| Compactions | unavailable | - |", "| Compactions | unavailable | 0 |"),
  ],
  ["missing value", (body: string) => body.replace("| unavailable | - |", "| recorded | |")],
  ["missing limit", (body: string) => body.replace("Authoring harness evidence unavailable.", "-")],
  [
    "extra column",
    (body: string) => body.replace("Authoring harness evidence unavailable.", "a | b"),
  ],
  ["duplicate report", (body: string) => body + body],
  [
    "reversed markers",
    (_body: string) => "<!-- /agent-session-report -->\n<!-- agent-session-report:v1 -->",
  ],
])("rejects a report with %s", (_name, change) => {
  expect(() => validateSessionReport(change(template))).toThrow();
});

it("validates fetched comments and treats shell syntax as data", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pr-session-report-"));
  const eventFile = path.join(directory, "event.json");
  const marker = path.join(directory, "must-not-exist");
  const run = () =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/checks/pr-session-report.mts", "--comments-file", eventFile],
      { encoding: "utf8" },
    );
  try {
    writeFileSync(eventFile, JSON.stringify([{ body: "No report" }]));
    expect(run().status).toBe(1);
    const body = template.replace(
      "Authoring harness evidence unavailable.",
      `$(touch ${marker}); \`false\`; <script>`,
    );
    writeFileSync(eventFile, JSON.stringify([{ body }]));
    expect(run().status).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an empty report instead of treating missing evidence as zero", () => {
  expect(() =>
    validateSessionReport("<!-- agent-session-report:v1 -->\n<!-- /agent-session-report -->"),
  ).toThrow();
});
