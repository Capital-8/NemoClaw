// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  OPENCLAW_TOOL_EVIDENCE_MARKER,
  reduceOpenClawToolEvidence,
  projectUnavailableSearchReplyArtifact,
  projectOpenClawAgentFailureArtifact,
} from "../live/common-egress-agent-helpers.ts";
import { runOpenClawAgentAssertion } from "../live/openclaw-agent-assertion.ts";

import { projectOpenClawAgentCompletion } from "../../../src/lib/openclaw/agent-json-provenance.ts";

const SECRET_SENTINEL = "nvidia-api-key-must-not-remain";

describe("OpenClaw agent assertion", () => {
  it("keeps OpenShell SSH configuration outside artifacts and removes its temporary file", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-assertion-"));
    const artifactRoot = join(fixtureRoot, "artifacts");
    const temporaryRoot = join(fixtureRoot, "tmp");
    mkdirSync(temporaryRoot);
    vi.stubEnv("TMPDIR", temporaryRoot);
    const sshConfigSentinel = `ProxyCommand connect -H bearer=${SECRET_SENTINEL}`;
    const shellResult = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: sshConfigSentinel,
      timedOut: false,
    };
    const sandbox = {
      exec: vi.fn(),
      openshell: vi.fn().mockResolvedValue(shellResult),
    } as unknown as SandboxClient;
    const host = {
      command: vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        const configPath = args[1];
        expect(readFileSync(configPath!, "utf8")).toBe(sshConfigSentinel);
        expect(statSync(configPath!).mode & 0o777).toBe(0o600);
        return {
          ...shellResult,
          exitCode: 1,
          stderr: `credential=${SECRET_SENTINEL}`,
          stdout: "wrong reply",
        };
      }),
    } as unknown as HostCliClient;

    try {
      await expect(
        runOpenClawAgentAssertion(host, sandbox, new ArtifactSink(artifactRoot), {
          apiKey: SECRET_SENTINEL,
          expected: "PERSONAL_PUBLIC_FETCH_OK",
          label: "personal-public-fetch",
          persistCommandArtifacts: false,
          prompt: "fetch the fixed public reference",
          redactOutputInFailure: true,
          sandboxName: "personal-sandbox",
        }),
      ).rejects.toThrow(/agent output omitted; exit=1/u);

      expect(sandbox.openshell).toHaveBeenCalledWith(
        ["sandbox", "ssh-config", "personal-sandbox"],
        expect.objectContaining({ persistArtifacts: false }),
      );
      expect(readdirSync(temporaryRoot)).toEqual([]);
      expect(existsSync(join(artifactRoot, "ssh"))).toBe(false);
      const persistedActions = readdirSync(join(artifactRoot, "actions"))
        .map((name) => readFileSync(join(artifactRoot, "actions", name), "utf8"))
        .join("\n");
      expect(persistedActions).not.toContain(SECRET_SENTINEL);
      expect(sandbox.exec).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("reports when the temporary OpenShell SSH configuration cannot be removed", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-cleanup-"));
    const temporaryRoot = join(fixtureRoot, "tmp");
    mkdirSync(temporaryRoot);
    vi.stubEnv("TMPDIR", temporaryRoot);
    const shellResult = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "Host openshell-personal-sandbox",
      timedOut: false,
    };
    const sandbox = {
      exec: vi.fn(),
      openshell: vi.fn().mockResolvedValue(shellResult),
    } as unknown as SandboxClient;
    const host = {
      command: vi.fn().mockResolvedValue({
        ...shellResult,
        exitCode: 1,
        stdout: "wrong reply",
      }),
    } as unknown as HostCliClient;
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    try {
      await expect(
        runOpenClawAgentAssertion(host, sandbox, new ArtifactSink(join(fixtureRoot, "artifacts")), {
          apiKey: SECRET_SENTINEL,
          expected: "PERSONAL_PUBLIC_FETCH_OK",
          label: "personal-public-fetch",
          persistCommandArtifacts: false,
          prompt: "fetch the fixed public reference",
          redactOutputInFailure: true,
          sandboxName: "personal-sandbox",
        }),
      ).rejects.toThrow(/failed to remove temporary OpenShell SSH configuration/u);

      expect(readdirSync(temporaryRoot)).toHaveLength(1);
    } finally {
      remove.mockRestore();
      vi.unstubAllEnvs();
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

function replyFixture(reply: string) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-search-reply-"));
  const result = {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    durationMs: 1,
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: "Host openshell-test",
    timedOut: false,
  };
  const evidence = reduceOpenClawToolEvidence("", "");
  const sandbox = {
    openshell: vi.fn().mockResolvedValue(result),
    exec: vi.fn().mockResolvedValue({
      ...result,
      stdout: OPENCLAW_TOOL_EVIDENCE_MARKER + JSON.stringify(evidence),
    }),
  };
  const host = {
    command: vi.fn().mockResolvedValue({
      ...result,
      stdout: JSON.stringify({ payloads: [{ text: reply }], meta: {} }),
    }),
  };
  const options = {
    apiKey: SECRET_SENTINEL,
    expected: "searchStatus",
    label: "unavailable-search",
    prompt: "report unavailable search",
    persistCommandArtifacts: false,
    redactOutputInFailure: true,
    sandboxName: "test",
  };
  return {
    root,
    evidence,
    sandbox,
    host,
    options,
    artifacts: new ArtifactSink(join(root, "artifacts")),
  };
}

describe("unavailable-search assertion wiring", () => {
  it("reduces negative-path tool evidence without an expected fetch", async () => {
    const f = replyFixture('{"searchStatus":"unavailable","installationDocumentation":null}');
    const validator = vi.fn().mockReturnValue(true);
    try {
      await runOpenClawAgentAssertion(
        f.host as unknown as HostCliClient,
        f.sandbox as unknown as SandboxClient,
        f.artifacts,
        {
          ...f.options,
          toolEvidenceValidator: validator,
        },
      );
      expect(validator).toHaveBeenCalledWith(f.evidence);
      expect(f.sandbox.exec.mock.calls[0]?.[1][2]).toContain("const expectedFetch = null");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  it("records reply evidence before a rejected reply can end the attempt", async () => {
    const f = replyFixture("unparseable reply with a private query");
    const recordReplyEvidence = vi.fn(async (reply: string, attempt: number) => {
      await f.artifacts.writeJson(
        `reply-${attempt}.json`,
        projectUnavailableSearchReplyArtifact(reply),
      );
    });
    try {
      await expect(
        runOpenClawAgentAssertion(
          f.host as unknown as HostCliClient,
          f.sandbox as unknown as SandboxClient,
          f.artifacts,
          {
            ...f.options,
            recordReplyEvidence,
          },
        ),
      ).rejects.toThrow(/agent output omitted/u);
      expect(recordReplyEvidence).toHaveBeenCalledWith("unparseable reply with a private query", 1);
      const artifact = readFileSync(join(f.root, "artifacts", "reply-1.json"), "utf8");
      expect(JSON.parse(artifact)).toMatchObject({
        jsonParseStatus: "invalid",
        unavailableSearchReply: false,
      });
      expect(artifact).not.toContain("private query");
      const failureArtifact = readFileSync(
        join(f.root, "artifacts", "actions", "unavailable-search-attempt-1-agent-failure.json"),
        "utf8",
      );
      expect(JSON.parse(failureArtifact).response).toEqual({
        stdoutPresent: true,
        stderrPresent: false,
        jsonDocumentCount: 1,
        responseRecordCount: 1,
        payloadCount: 1,
        incompleteTurn: false,
        timeoutPhase: "none",
        abandoned: false,
        replayRisk: false,
        incompleteTurnError: false,
        assistantReplyPresent: true,
      });
      expect(failureArtifact).not.toContain("private query");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });
});

describe("OpenClaw agent failure diagnostics", () => {
  it.each([
    {
      name: "empty stdout",
      stdout: "",
      documents: 0,
      responses: 0,
      payloads: 0,
      incomplete: false,
      reply: false,
    },
    {
      name: "non-JSON stdout",
      stdout: "provider notice",
      documents: 0,
      responses: 0,
      payloads: 0,
      incomplete: false,
      reply: false,
    },
    {
      name: "unrecognized JSON",
      stdout: JSON.stringify({ answer: "private" }),
      documents: 1,
      responses: 0,
      payloads: 0,
      incomplete: false,
      reply: false,
    },
    {
      name: "empty response",
      stdout: JSON.stringify({ payloads: [], meta: {} }),
      documents: 1,
      responses: 1,
      payloads: 0,
      incomplete: false,
      reply: false,
    },
    {
      name: "incomplete response",
      stdout: JSON.stringify({
        payloads: [{ text: "private" }],
        meta: { timeoutPhase: "private-phase", error: { kind: "incomplete_turn" } },
      }),
      documents: 1,
      responses: 1,
      payloads: 1,
      incomplete: true,
      reply: false,
    },
    {
      name: "tool output",
      stdout: JSON.stringify({ payloads: [{ text: "tool_calls: private" }], meta: {} }),
      documents: 1,
      responses: 1,
      payloads: 1,
      incomplete: false,
      reply: false,
    },
    {
      name: "bounded payload count",
      stdout: JSON.stringify({
        payloads: Array.from({ length: 1_001 }, () => ({ text: "private" })),
        meta: {},
      }),
      documents: 1,
      responses: 1,
      payloads: 1_000,
      incomplete: false,
      reply: true,
    },
    {
      name: "accepted assistant text",
      stdout: JSON.stringify({ payloads: [{ text: "private reply" }], meta: {} }),
      documents: 1,
      responses: 1,
      payloads: 1,
      incomplete: false,
      reply: true,
    },
  ])("distinguishes $name without retaining response content", (fixture) => {
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: SECRET_SENTINEL,
        stdout: fixture.stdout,
        timedOut: false,
      },
    );
    expect(artifact.response).toEqual({
      stdoutPresent: fixture.stdout.length > 0,
      stderrPresent: true,
      jsonDocumentCount: fixture.documents,
      responseRecordCount: fixture.responses,
      payloadCount: fixture.payloads,
      incompleteTurn: fixture.incomplete,
      timeoutPhase: fixture.incomplete ? "other" : "none",
      abandoned: false,
      replayRisk: false,
      incompleteTurnError: fixture.incomplete,
      assistantReplyPresent: fixture.reply,
    });
    expect(JSON.stringify(artifact)).not.toMatch(/private|provider notice|nvidia-api-key/u);
  });
});

describe("incomplete-turn failure categories", () => {
  it.each([
    {
      meta: { timeoutPhase: "provider" },
      phase: "provider",
      abandoned: false,
      replayRisk: false,
      error: false,
    },
    {
      meta: { timeoutPhase: "tool" },
      phase: "tool",
      abandoned: false,
      replayRisk: false,
      error: false,
    },
    {
      meta: { timeoutPhase: "post_turn" },
      phase: "post_turn",
      abandoned: false,
      replayRisk: false,
      error: false,
    },
    {
      meta: { timeoutPhase: "private-phase" },
      phase: "other",
      abandoned: false,
      replayRisk: false,
      error: false,
    },
    {
      meta: { livenessState: "abandoned" },
      phase: "none",
      abandoned: true,
      replayRisk: false,
      error: false,
    },
    {
      meta: { replayInvalid: true },
      phase: "none",
      abandoned: false,
      replayRisk: true,
      error: false,
    },
    {
      meta: { error: { kind: "incomplete_turn", message: "private-message" } },
      phase: "none",
      abandoned: false,
      replayRisk: false,
      error: true,
    },
    { meta: {}, phase: "none", abandoned: false, replayRisk: false, error: false },
  ])("retains fixed categories for $meta", (fixture) => {
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: SECRET_SENTINEL,
        timedOut: false,
        stdout: JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "private-reply" }], meta: fixture.meta },
        }),
      },
    );
    expect(artifact.response).toMatchObject({
      timeoutPhase: fixture.phase,
      abandoned: fixture.abandoned,
      replayRisk: fixture.replayRisk,
      incompleteTurnError: fixture.error,
    });
    expect(JSON.stringify(artifact)).not.toMatch(/private|nvidia-api-key/u);
  });

  it("ignores incomplete markers in tool output and superseded responses", () => {
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: "",
        timedOut: false,
        stdout: [
          JSON.stringify({ payloads: [], meta: { timeoutPhase: "provider", replayInvalid: true } }),
          JSON.stringify({
            payloads: [
              {
                role: "tool",
                content: {
                  timeoutPhase: "private-phase",
                  livenessState: "abandoned",
                  error: { kind: "incomplete_turn" },
                },
              },
            ],
            meta: {},
          }),
        ].join("\n"),
      },
    );
    expect(artifact.response).toMatchObject({
      timeoutPhase: "none",
      abandoned: false,
      replayRisk: false,
      incompleteTurnError: false,
    });
  });
});

describe("replay-risk completion evidence", () => {
  it("distinguishes a completed failed-tool reply from a missing completion marker", () => {
    const reply = '{"searchStatus":"unavailable","installationDocumentation":null}';
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: SECRET_SENTINEL,
        timedOut: false,
        stdout: JSON.stringify({
          status: "ok",
          summary: "completed",
          result: {
            payloads: [{ text: reply }],
            meta: {
              replayInvalid: true,
              aborted: false,
              stopReason: "stop",
              finalAssistantVisibleText: reply,
              toolSummary: { calls: 2, failures: 1 },
            },
          },
        }),
      },
    );
    expect(artifact.completion).toMatchObject({
      runCompleted: true,
      aborted: false,
      errorPresent: false,
      stopReasonIsStop: true,
      toolCalls: 2,
      toolFailures: 1,
      finalTextPresent: true,
      finalTextMatchesPayload: true,
      finalReply: { unavailableSearchReply: true },
    });
    expect(artifact.response.assistantReplyPresent).toBe(false);
  });

  it("does not retain arbitrary completion metadata or reply contents", () => {
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: SECRET_SENTINEL,
        timedOut: false,
        stdout: JSON.stringify({
          status: "private-status",
          summary: "private-summary",
          result: {
            payloads: [{ text: "private-other-text" }],
            meta: {
              replayInvalid: true,
              aborted: true,
              stopReason: "private-stop",
              error: { kind: "private-error" },
              finalAssistantVisibleText: "private-query",
              toolSummary: { calls: 2000, failures: "private-failures" },
            },
          },
        }),
      },
    );
    expect(artifact.completion).toMatchObject({
      runCompleted: false,
      aborted: true,
      errorPresent: true,
      stopReasonIsStop: false,
      toolCalls: 1000,
      toolFailures: null,
      finalTextPresent: true,
      finalTextMatchesPayload: false,
      finalReply: { unavailableSearchReply: false },
    });
    expect(JSON.stringify(artifact)).not.toMatch(/private|nvidia-api-key/u);
  });

  it("uses the final response and ignores metadata within tool output", () => {
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: "",
        timedOut: false,
        stdout: [
          JSON.stringify({
            payloads: [],
            meta: {
              finalAssistantVisibleText: "private-old",
              toolSummary: { calls: 9, failures: 9 },
            },
          }),
          JSON.stringify({
            payloads: [{ role: "tool", content: { finalAssistantVisibleText: "private-tool" } }],
            meta: {},
          }),
        ].join("\n"),
      },
    );
    expect(artifact.completion).toMatchObject({
      runCompleted: false,
      toolCalls: null,
      toolFailures: null,
      finalTextPresent: false,
      finalTextMatchesPayload: false,
    });
  });
});

describe("shared completion projection", () => {
  it("keeps failure artifacts aligned with the canonical final-response projection", () => {
    const documents = [
      { meta: { aborted: true }, payloads: [] },
      {
        status: "ok",
        summary: "completed",
        result: {
          payloads: [{ text: "unavailable" }],
          meta: {
            replayInvalid: true,
            aborted: false,
            stopReason: "stop",
            finalAssistantVisibleText: "unavailable",
            toolSummary: { calls: 1, failures: 1 },
          },
        },
      },
      { event: "log", meta: { aborted: true } },
    ];
    const artifact = projectOpenClawAgentFailureArtifact(
      1,
      { passed: false },
      {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: JSON.stringify(documents),
        timedOut: false,
      },
    );
    const { finalReply, ...completion } = artifact.completion;
    expect(completion).toEqual(projectOpenClawAgentCompletion(documents));
    expect(completion.runCompleted).toBe(true);
    expect(completion.toolFailures).toBe(1);
    expect(finalReply.unavailableSearchReply).toBe(false);
    expect(artifact.response.replayRisk).toBe(true);
  });
});
