// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA/NemoClaw V1 2732ba7d1da3ffc44cab11e84430c978a0b20ebf:
// replace the standalone Rust validator with main's TypeScript tooling and PR comment input.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- agent-session-report:v1 -->";
const END = "<!-- /agent-session-report -->";
const OPENING = "<!-- agent-session-report:opening -->";

export function validateSessionReport(body: string): void {
  const match = body
    .replaceAll("\r\n", "\n")
    .trim()
    .match(
      /^<!-- agent-session-report:(opening|commit|merge) -->\n<details>\n<summary>Authoring session report: (PR opening|Commit update|PR merge)<\/summary>\n\n([\s\S]+)\n<\/details>$/,
    );
  const labels = { opening: "PR opening", commit: "Commit update", merge: "PR merge" };
  if (!match || labels[match[1] as keyof typeof labels] !== match[2]) {
    throw new Error("Use the collapsed session report comment template");
  }
  if (/<\/?(?:details|summary)\b/i.test(match[3])) {
    throw new Error("Use one collapsed section for the report");
  }
  validateTable(match[3]);
}

function validateTable(body: string): void {
  if (body.split(START).length !== 2 || body.split(END).length !== 2) {
    throw new Error("Include exactly one v1 session report; see the comment template");
  }
  const start = body.indexOf(START) + START.length;
  const end = body.indexOf(END);
  if (end < start) throw new Error("Report end must follow its start");
  const lines = body
    .slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.shift() !== "| Field | Status | Value | Evidence or limit |" ||
    lines.shift() !== "| --- | --- | --- | --- |"
  ) {
    throw new Error("Use the report table header from the comment template");
  }
  const remaining = new Set([
    "Harness",
    "Skills",
    "Instruction files",
    "Tool calls",
    "Session window",
    "Compactions",
    "Models",
    "Reasoning levels",
  ]);
  for (const line of lines) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length !== 6 || cells[0] !== "" || cells[5] !== "") {
      throw new Error("Each report row must have four cells; use semicolons inside cells");
    }
    const [, field, status, value, evidence] = cells;
    if (!remaining.delete(field)) throw new Error("Report fields must be known and unique");
    if (!["recorded", "partial", "unavailable"].includes(status)) {
      throw new Error("Status must be recorded, partial, or unavailable");
    }
    if (!value || !evidence || evidence === "-") {
      throw new Error("Every field needs a value and evidence or an availability limit");
    }
    if ((status === "unavailable") !== (value === "-")) {
      throw new Error("Use '-' only for unavailable values");
    }
  }
  if (remaining.size) throw new Error("Include all eight report fields, even when unavailable");
}

export function validateOpeningReport(comments: unknown): void {
  if (!Array.isArray(comments)) throw new Error("Expected the complete PR comments array");
  const reports = comments.filter(
    (comment) => typeof comment?.body === "string" && comment.body.trim().startsWith(OPENING),
  );
  if (reports.length !== 1) throw new Error("Include exactly one PR opening report comment");
  validateSessionReport(reports[0].body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, file, ...extra] = process.argv.slice(2);
    if (!file || extra.length || !["--body-file", "--comments-file"].includes(mode)) {
      throw new Error("Expected --body-file PATH or --comments-file PATH");
    }
    const input = readFileSync(file, "utf8");
    if (mode === "--comments-file") validateOpeningReport(JSON.parse(input));
    else validateSessionReport(input);
  } catch {
    // Input and JSON parser errors can contain untrusted body text. Do not echo it to CI logs.
    console.error(
      "Session report validation failed. Check the collapsed comment and its eight-field report contract.",
    );
    process.exitCode = 1;
  }
}
