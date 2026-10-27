// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA/NemoClaw V1 2732ba7d1da3ffc44cab11e84430c978a0b20ebf:
// replace the standalone Rust validator with main's TypeScript tooling and event input.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- agent-session-report:v1 -->";
const END = "<!-- /agent-session-report -->";

export function validateSessionReport(body: string): void {
  if (body.split(START).length !== 2 || body.split(END).length !== 2) {
    throw new Error("Include exactly one v1 session report; see the PR template");
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
    throw new Error("Use the report table header from the PR template");
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

function eventBody(text: string): string {
  const event: unknown = JSON.parse(text);
  if (typeof event !== "object" || event === null || !("pull_request" in event)) {
    throw new Error("Expected a pull request event");
  }
  const pull = event.pull_request;
  if (typeof pull !== "object" || pull === null || !("body" in pull)) {
    throw new Error("Expected a PR body in the event");
  }
  if (pull.body === null) return "";
  if (typeof pull.body !== "string") throw new Error("Expected a string PR body");
  return pull.body;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, file, ...extra] = process.argv.slice(2);
    if (!file || extra.length || !["--body-file", "--event-file"].includes(mode)) {
      throw new Error("Expected --body-file PATH or --event-file PATH");
    }
    const input = readFileSync(file, "utf8");
    validateSessionReport(mode === "--event-file" ? eventBody(input) : input);
  } catch {
    // Input and JSON parser errors can contain untrusted body text. Do not echo it to CI logs.
    console.error(
      "Session report validation failed. Check the input and the PR template's eight-field report contract.",
    );
    process.exitCode = 1;
  }
}
