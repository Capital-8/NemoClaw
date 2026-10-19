// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm as removeDirectory } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { withOnboardTrace } from "../fixtures/onboard-trace.ts";
import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const SANITIZER = "scripts/e2e/sanitize-trace-timing.py";
const SUMMARY = "cloud-onboard-trace-timing-summary.json";
const PROBE = "nemoclaw.inference.validation_probe";
const RETRY = "nemoclaw.inference.validation_transport_retry";

function probeTrace(events: unknown[], durationMs = 42, name = RETRY) {
  const trace = makeTrace();
  return {
    ...trace,
    summary: { ...trace.summary, total_duration_ms: durationMs },
    resource_spans: [
      {
        scope_spans: [
          {
            spans: [...trace.resource_spans[0].scope_spans[0].spans, { name, events }],
          },
        ],
      },
    ],
  };
}

function recordRetryTrace(environment: NodeJS.ProcessEnv): void {
  vi.stubEnv("NEMOCLAW_TRACE_FILE", "");
  vi.stubEnv("NEMOCLAW_TRACE_DIR", environment.NEMOCLAW_TRACE_DIR!);
  const trace = require("../../../src/lib/trace") as typeof import("../../../src/lib/trace");
  const { runChatCompletionsRetryLoop } = require("../../../src/lib/inference/probe-retry");
  trace.resetTraceForTests();
  const results = [
    { ok: false, httpStatus: 0, curlStatus: -110, body: "private-provider-body" },
    { ok: false, httpStatus: 401, curlStatus: 0, body: "private-provider-body" },
  ];
  let call = 0;
  try {
    trace.withTraceSpan("nemoclaw.onboard", {}, () =>
      trace.withTraceSpan("nemoclaw.onboard.phase.provider_selection", {}, () =>
        runChatCompletionsRetryLoop(() => results[call++]),
      ),
    );
    trace.flushTrace("ERROR");
  } finally {
    trace.resetTraceForTests();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function runPython(script: string) {
  return spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runSanitizer(source: string, output: string) {
  return spawnSync("python3", [SANITIZER, source, output], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function makeTrace(overrides: Record<string, unknown> = {}) {
  return {
    resource_spans: [
      {
        resource: { attributes: { "service.name": "nemoclaw" } },
        scope_spans: [
          {
            scope: { name: "nemoclaw.onboard", version: "1.0.0" },
            spans: [
              {
                name: "nemoclaw.onboard",
                duration_ms: 42,
                attributes: { api_key: "nvapi-should-never-appear" },
                events: [{ name: "prompt", attributes: { value: "secret prompt" } }],
              },
              {
                name: "nemoclaw.onboard.phase.gateway",
                duration_ms: 7.1234,
                attributes: { endpoint: "https://example.test/token" },
              },
            ],
          },
        ],
      },
    ],
    summary: {
      trace_id: "0123456789abcdef0123456789abcdef",
      generated_at: "2026-07-02T00:00:00.000Z",
      output_path: "/tmp/raw-trace.json",
      slowest_spans: [
        {
          name: "nemoclaw.onboard.phase.gateway",
          duration_ms: 7.1234,
          status: "ERROR",
        },
      ],
      total_duration_ms: 42.9876,
    },
    ...overrides,
  };
}

describe("sanitize trace timing", () => {
  it("retains initial and retry evidence from shorter traces without publishing raw fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-probe-summary-"));
    const raw = join(directory, "raw");
    const output = join(directory, "summary");
    const first = { attempt: 1, ok: false, http_status: 0, curl_status: -110 };
    const last = { attempt: 2, ok: false, http_status: 401, curl_status: 0 };
    try {
      mkdirSync(raw);
      writeFileSync(
        join(raw, "1-failed.json"),
        JSON.stringify(
          probeTrace([
            {
              name: "probe_result",
              attributes: { ...first, body: "private-body", url: "https://private.test/key" },
            },
            {
              name: "probe_retry_sleep",
              attributes: {
                delay_ms: 5_000,
                http_status: 0,
                curl_status: -110,
                credential: "secret-value",
              },
            },
            { name: "probe_result", attributes: last },
          ]),
        ),
      );
      writeFileSync(
        join(raw, "2-longer.json"),
        JSON.stringify(
          probeTrace(
            [
              {
                name: "probe_result",
                attributes: { attempt: 1, ok: false, http_status: 503, curl_status: 0 },
              },
              {
                name: "probe_retry_sleep",
                attributes: { delay_ms: 15_000, http_status: 503, retry_reason: "private-value" },
              },
            ],
            100,
            PROBE,
          ),
        ),
      );

      const result = runSanitizer(raw, output);
      expect(result.status, result.stderr).toBe(0);
      const text = readFileSync(join(output, SUMMARY), "utf8");
      const summary = JSON.parse(text);
      expect(summary.total_duration_ms).toBe(100);
      expect(summary.provider_probes).toEqual([
        {
          trace_id: "0123456789abcdef0123456789abcdef",
          spans: [
            {
              name: RETRY,
              events: [
                { name: "probe_result", ...first },
                { name: "probe_retry_sleep", delay_ms: 5_000, http_status: 0, curl_status: -110 },
                { name: "probe_result", ...last },
              ],
            },
          ],
        },
        {
          trace_id: "0123456789abcdef0123456789abcdef",
          spans: [
            {
              name: PROBE,
              events: [
                { name: "probe_result", attempt: 1, ok: false, http_status: 503, curl_status: 0 },
                { name: "probe_retry_sleep", delay_ms: 15_000, http_status: 503 },
              ],
            },
          ],
        },
      ]);
      expect(text).not.toMatch(/private|secret|attributes|credential|https:\/\//u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("omits malformed probe metadata and reports bounded event and span retention", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-probe-bounds-"));
    const valid = {
      name: "probe_result",
      attributes: { attempt: 1, ok: false, http_status: 0, curl_status: 28 },
    };
    const invalid = [
      { name: "probe_result", attributes: { ...valid.attributes, attempt: true } },
      { name: "probe_result", attributes: { ...valid.attributes, attempt: 33 } },
      { name: "probe_result", attributes: { ...valid.attributes, http_status: "401" } },
      { name: "probe_result", attributes: { ...valid.attributes, http_status: 99 } },
      { name: "probe_result", attributes: { ...valid.attributes, curl_status: -1 } },
      { name: "probe_result", attributes: { ...valid.attributes, ok: "false" } },
      { name: "probe_retry_sleep", attributes: { http_status: 503, delay_ms: 60_001 } },
      { name: "probe_retry_sleep", attributes: { http_status: 503, delay_ms: 1.5 } },
      {
        name: "probe_retry_sleep",
        attributes: { http_status: 503, delay_ms: 5_000, curl_status: false },
      },
      { name: "private-event", attributes: valid.attributes },
    ];
    const events = [valid, ...invalid, ...Array.from({ length: 40 }, () => valid)];
    const trace = probeTrace(events);
    trace.resource_spans[0].scope_spans[0].spans.push(
      ...Array.from({ length: 16 }, () => ({ name: RETRY, events: [valid] })),
    );
    (trace.resource_spans[0].scope_spans[0].spans as unknown[]).push({ name: [] });
    try {
      const raw = join(directory, "trace.json");
      const output = join(directory, "summary");
      writeFileSync(raw, JSON.stringify(trace));
      const result = runSanitizer(raw, output);
      expect(result.status, result.stderr).toBe(0);
      const group = JSON.parse(readFileSync(join(output, SUMMARY), "utf8")).provider_probes[0];
      expect(group.spans).toHaveLength(16);
      expect(group.omitted_spans).toBe(1);
      expect(group.spans[0].events).toHaveLength(22);
      expect(group.spans[0].omitted_events).toBe(events.length - 22);
      expect(group.spans[0].events).toEqual(
        Array.from({ length: 22 }, () => ({ name: "probe_result", ...valid.attributes })),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("extract_candidate returns only the timing allowlist from the TraceArtifact shape", () => {
    const result = runPython(String.raw`
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sanitize_trace_timing",
    Path("scripts/e2e/sanitize-trace-timing.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
artifact = {
    "resource_spans": [{
        "resource": {"attributes": {"service.name": "nemoclaw"}},
        "scope_spans": [{
            "scope": {"name": "nemoclaw.onboard", "version": "1.0.0"},
            "spans": [
                {
                    "trace_id": "0123456789abcdef0123456789abcdef",
                    "span_id": "0000000000000001",
                    "name": "nemoclaw.onboard",
                    "kind": "INTERNAL",
                    "start_time_unix_nano": "1",
                    "duration_ms": 42,
                    "status": {"code": "OK", "message": "secret detail"},
                    "attributes": {"api_key": "nvapi-secret"},
                    "events": [{"name": "prompt", "attributes": {"value": "secret"}}],
                },
                {
                    "trace_id": "0123456789abcdef0123456789abcdef",
                    "span_id": "0000000000000002",
                    "parent_span_id": "0000000000000001",
                    "name": "nemoclaw.onboard.phase.gateway",
                    "kind": "INTERNAL",
                    "start_time_unix_nano": "2",
                    "duration_ms": 7.1234,
                    "status": {"code": "ERROR", "message": "raw error"},
                    "attributes": {"endpoint": "https://example.test/token"},
                    "events": [],
                },
            ],
        }],
    }],
    "summary": {
        "trace_id": "0123456789abcdef0123456789abcdef",
        "generated_at": "2026-07-02T00:00:00.000Z",
        "total_duration_ms": 42.9876,
        "slowest_spans": [{
            "name": "nemoclaw.onboard.phase.gateway",
            "duration_ms": 7.1234,
            "status": "ERROR",
        }],
        "output_path": "/tmp/raw-trace.json",
    },
}
print(json.dumps(module.extract_candidate(artifact), sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      phases: { "nemoclaw.onboard.phase.gateway": 7.123 },
      schema_version: "nemoclaw.trace_timing.v1",
      slowest_spans: [
        { duration_ms: 7.123, name: "nemoclaw.onboard.phase.gateway", status: "ERROR" },
      ],
      total_duration_ms: 42.988,
      trace_id: "0123456789abcdef0123456789abcdef",
    });
    expect(result.stdout).not.toMatch(/api_key|attributes|events|output_path|raw error|secret/u);
  });

  it("extract_candidate rejects non-onboard and incomplete traces", () => {
    const result = runPython(String.raw`
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sanitize_trace_timing",
    Path("scripts/e2e/sanitize-trace-timing.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [
    None,
    {"summary": {"total_duration_ms": 1}, "resource_spans": []},
    {
        "resource_spans": [{"scope_spans": [{"spans": [{"name": "nemoclaw.other"}]}]}],
        "summary": {"total_duration_ms": 1},
    },
    {
        "resource_spans": [{"scope_spans": [{"spans": [{"name": "nemoclaw.onboard"}]}]}],
        "summary": {"total_duration_ms": "not-a-number"},
    },
    {
        "resource_spans": [{"scope_spans": [{"spans": [{"name": "nemoclaw.onboard"}]}]}],
        "summary": {"total_duration_ms": 1},
    },
]
print(json.dumps([module.extract_candidate(case) for case in cases]))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, null, null, null, null]);
  });

  it("writes trusted summaries and directories with restrictive permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-sanitize-"));
    const source = join(directory, "raw.json");
    const output = join(directory, "trusted");
    try {
      writeFileSync(source, JSON.stringify(makeTrace()));

      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);

      const summaryPath = join(output, SUMMARY);
      expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toMatchObject({
        phases: { "nemoclaw.onboard.phase.gateway": 7.123 },
        total_duration_ms: 42.988,
      });
      expect(statSync(output).mode & 0o777).toBe(0o700);
      expect(statSync(summaryPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("onboard trace fixture publication", () => {
  const primaryFailure = new Error("onboarding failed");
  let progress: TestProgress;
  let progressLines: string[];
  beforeEach(() => {
    progressLines = [];
    progress = startTestProgress("onboard trace capture", ["collect traces", "publish traces"], {
      logLine: (line) => progressLines.push(line),
    });
  });
  afterEach(() => progress.stop());
  it.each([
    { outcome: "successful", finish: async () => undefined, failure: undefined },
    {
      outcome: "failed",
      finish: async () => {
        throw primaryFailure;
      },
      failure: primaryFailure,
    },
  ])(
    "publishes producer retry evidence after a $outcome fixture and removes raw traces",
    async ({ finish, failure }) => {
      const root = mkdtempSync(join(tmpdir(), "nemoclaw-fixture-traces-"));
      const artifacts = new ArtifactSink(join(root, "artifacts"));
      let raw = "";
      try {
        const result = await withOnboardTrace(artifacts, progress, async (environment) => {
          raw = environment.NEMOCLAW_TRACE_DIR!;
          expect(statSync(dirname(raw)).mode & 0o777).toBe(0o700);
          recordRetryTrace(environment);
          await finish();
        }).catch((error: unknown) => error);
        expect(result).toBe(failure);
        expect(progressLines).toEqual(
          expect.arrayContaining([
            expect.stringContaining("child lifecycle 1: started"),
            expect.stringContaining("child lifecycle 1: exited-zero"),
          ]),
        );
        expect(progressLines.join("\n")).not.toContain("private-provider-body");
        expect(existsSync(dirname(raw))).toBe(false);
        expect(readdirSync(artifacts.rootDir)).toEqual([SUMMARY]);
        const published = join(artifacts.rootDir, SUMMARY);
        const text = readFileSync(published, "utf8");
        expect(JSON.parse(text).provider_probes[0].spans[0].events).toEqual([
          { name: "probe_result", attempt: 1, ok: false, http_status: 0, curl_status: -110 },
          { name: "probe_retry_sleep", delay_ms: 5_000, http_status: 0, curl_status: -110 },
          { name: "probe_result", attempt: 2, ok: false, http_status: 401, curl_status: 0 },
        ]);
        expect(text).not.toContain("private-provider-body");
        expect(statSync(published).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("records unavailable evidence when no onboard trace was produced", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-empty-traces-"));
    const artifacts = new ArtifactSink(join(root, "artifacts"));
    let raw = "";
    try {
      await withOnboardTrace(artifacts, progress, async (environment) => {
        raw = environment.NEMOCLAW_TRACE_DIR!;
      });
      expect(existsSync(dirname(raw))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(artifacts.rootDir, "onboard-trace-capture.json"), "utf8")),
      ).toEqual({ status: "unavailable" });
      expect(existsSync(join(artifacts.rootDir, SUMMARY))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the original failure and removes raw traces when artifact publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-unwritable-traces-"));
    const artifacts = new ArtifactSink(join(root, "artifacts"));
    const publicationFailure = new Error("artifact write failed");
    vi.spyOn(artifacts, "writeJson").mockRejectedValue(publicationFailure);
    let raw = "";
    try {
      const result = await withOnboardTrace(artifacts, progress, async (environment) => {
        raw = environment.NEMOCLAW_TRACE_DIR!;
        recordRetryTrace(environment);
        throw primaryFailure;
      }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([primaryFailure, publicationFailure]);
      expect((result as Error).cause).toBe(primaryFailure);
      expect(existsSync(dirname(raw))).toBe(false);
      expect(readdirSync(artifacts.rootDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the original failure when removing private traces also fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-trace-removal-"));
    const artifacts = new ArtifactSink(join(root, "artifacts"));
    const deletionFailure = new Error("private trace removal failed");
    vi.mocked(removeDirectory).mockRejectedValueOnce(deletionFailure);
    let raw = "";
    let privateDirectory = root;
    try {
      const result = await withOnboardTrace(artifacts, progress, async (environment) => {
        raw = environment.NEMOCLAW_TRACE_DIR!;
        privateDirectory = dirname(raw);
        recordRetryTrace(environment);
        throw primaryFailure;
      }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([primaryFailure, deletionFailure]);
      expect((result as Error).cause).toBe(primaryFailure);
      expect(existsSync(dirname(raw))).toBe(true);
      expect(existsSync(join(artifacts.rootDir, SUMMARY))).toBe(true);
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes private traces when the sanitizer rejects a symlink source", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-invalid-traces-"));
    const artifacts = new ArtifactSink(join(root, "artifacts"));
    const privateFile = join(root, "private.json");
    writeFileSync(privateFile, "private-provider-body");
    let raw = "";
    try {
      await expect(
        withOnboardTrace(artifacts, progress, async (environment) => {
          raw = environment.NEMOCLAW_TRACE_DIR!;
          symlinkSync(privateFile, raw);
        }),
      ).rejects.toThrow("Onboard trace sanitization failed");
      expect(existsSync(dirname(raw))).toBe(false);
      expect(readdirSync(artifacts.rootDir)).toEqual([]);
      expect(readFileSync(privateFile, "utf8")).toBe("private-provider-body");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a temporary directory inside the upload root before running onboarding", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-upload-traces-"));
    const upload = join(root, "upload");
    const artifacts = new ArtifactSink(join(upload, "scenario"));
    const temporary = join(upload, "temporary");
    mkdirSync(temporary);
    vi.stubEnv("TMPDIR", temporary);
    vi.stubEnv("E2E_ARTIFACT_DIR", upload);
    const use = vi.fn(async () => undefined);
    try {
      await expect(withOnboardTrace(artifacts, progress, use)).rejects.toThrow(
        "outside the artifact upload root",
      );
      expect(use).not.toHaveBeenCalled();
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
