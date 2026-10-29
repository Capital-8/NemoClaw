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
  capturePublicFetchFailureProbe,
  runOpenClawAgentAssertion,
} from "../live/openclaw-agent-assertion.ts";

import {
  reduceOpenClawToolEvidence,
  projectPersonalPublicFetchToolEvidenceArtifact,
  validateOpenClawAgentAttemptEvidence,
  type OpenClawAgentAttemptEvidenceOptions,
} from "../live/common-egress-agent-helpers.ts";

const PUBLIC_FETCH_EXPECTATION = {
  url: "https://www.wikidata.org/w/api.php",
  content: "United States",
};
const REDUCER_SECRET_SENTINEL = "reducer-private-must-not-remain";
function publicFetchPayload(overrides = {}) {
  return {
    status: 200,
    url: PUBLIC_FETCH_EXPECTATION.url,
    finalUrl: PUBLIC_FETCH_EXPECTATION.url,
    text: "United States",
    ...overrides,
  };
}
function publicFetchSessionJsonLines(options: { isError?: boolean; payload?: object } = {}) {
  return [
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "web_fetch",
            arguments: { url: PUBLIC_FETCH_EXPECTATION.url, maxChars: 8000 },
          },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "web_fetch",
        isError: options.isError,
        content: [{ type: "text", text: JSON.stringify(options.payload ?? publicFetchPayload()) }],
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
}
function publicFetchAttemptValidationOptions(
  overrides: Partial<OpenClawAgentAttemptEvidenceOptions> = {},
): OpenClawAgentAttemptEvidenceOptions {
  return {
    classification: { passed: true },
    label: "c2",
    reply: "REFERENCE_AGENT_OK",
    recordToolEvidence: async () => {},
    recordToolEvidenceReductionFailure: async () => {},
    reduceToolEvidence: async () => ({
      exitCode: 0,
      stdout:
        "__NEMOCLAW_TOOL_EVIDENCE__=" +
        JSON.stringify(
          reduceOpenClawToolEvidence(publicFetchSessionJsonLines(), "", PUBLIC_FETCH_EXPECTATION),
        ),
    }),
    ...overrides,
  };
}

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

  it("collects failed-turn records and a separate HTTP probe before preserving the reply failure", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-fetch-diagnostic-"));
    const result = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
    };
    const reduced = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        isError: true,
        payload: {
          status: "error",
          tool: "web_fetch",
          error: `Web fetch failed (503): ${SECRET_SENTINEL}`,
        },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    const exec = vi.fn().mockImplementation(async (_sandbox, args) => ({
      ...result,
      stdout: args[0] === "node" ? "__NEMOCLAW_TOOL_EVIDENCE__=" + JSON.stringify(reduced) : "503",
    }));
    const sandbox = {
      exec,
      openshell: vi.fn().mockResolvedValue({ ...result, stdout: "Host openshell-test-sandbox" }),
    } as unknown as SandboxClient;
    const command = vi.fn().mockResolvedValue({ ...result, stdout: "wrong reply" });
    try {
      await expect(
        runOpenClawAgentAssertion(
          { command } as unknown as HostCliClient,
          sandbox,
          new ArtifactSink(fixtureRoot),
          {
            apiKey: SECRET_SENTINEL,
            expected: "REFERENCE_AGENT_OK",
            label: "c2",
            prompt: "fetch",
            sandboxName: "test-sandbox",
            publicFetchExpectation: PUBLIC_FETCH_EXPECTATION,
            persistCommandArtifacts: false,
            redactOutputInFailure: true,
          },
        ),
      ).rejects.toThrow("expected REFERENCE_AGENT_OK");
      expect(command).toHaveBeenCalledOnce();
      expect(exec).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(readFileSync(join(fixtureRoot, "actions/c2-attempt-1-reduced.json"), "utf8")),
      ).toMatchObject({
        webFetchDiagnostics: [{ httpStatus: 503, toolError: true, paired: true }],
      });
      expect(
        JSON.parse(readFileSync(join(fixtureRoot, "actions/c2-separate-http-probe.json"), "utf8")),
      ).toMatchObject({ httpStatus: 503, source: "separate-sandbox-curl-request" });
      const files = readdirSync(join(fixtureRoot, "actions"))
        .map((file) => readFileSync(join(fixtureRoot, "actions", file), "utf8"))
        .join("\n");
      expect(files).not.toContain(SECRET_SENTINEL);
      expect(files).not.toContain("wrong reply");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
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

describe("public fetch failure probe", () => {
  it.each([503, 200])(
    "records a separate HTTP %s without retaining response content",
    async (httpStatus) => {
      const writeJson = vi.fn();
      const exec = vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: String(httpStatus),
        stderr: SECRET_SENTINEL,
      });
      await capturePublicFetchFailureProbe(
        { exec } as unknown as SandboxClient,
        { writeJson } as unknown as ArtifactSink,
        "test-sandbox",
        "c2",
        "https://www.wikidata.org/w/api.php?test=private",
      );
      expect(exec).toHaveBeenCalledWith(
        "test-sandbox",
        expect.arrayContaining(["--proto", "=https", "--output", "/dev/null", "--max-time", "15"]),
        expect.objectContaining({ persistArtifacts: false, timeoutMs: 20_000 }),
      );
      expect(writeJson).toHaveBeenCalledWith(
        "actions/c2-separate-http-probe.json",
        expect.objectContaining({ source: "separate-sandbox-curl-request", httpStatus }),
      );
      expect(JSON.stringify(writeJson.mock.calls)).not.toContain(SECRET_SENTINEL);
      expect(JSON.stringify(writeJson.mock.calls)).not.toContain("?test=private");
    },
  );

  it("records unavailable diagnostics without throwing the transport's sensitive message", async () => {
    const writeJson = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error(SECRET_SENTINEL));
    await capturePublicFetchFailureProbe(
      { exec } as unknown as SandboxClient,
      { writeJson } as unknown as ArtifactSink,
      "test-sandbox",
      "c2",
      "https://www.wikidata.org/",
    );
    expect(writeJson).toHaveBeenCalledWith(
      "actions/c2-separate-http-probe.json",
      expect.objectContaining({ unavailable: true }),
    );
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain(SECRET_SENTINEL);
  });
});

describe("failed public-fetch evidence", () => {
  it.each(["deterministic", "transient-external"] as const)(
    "collects failed-turn evidence without changing the %s retry classification",
    async (failureClass) => {
      const recordToolEvidence = vi.fn();
      const classification = { passed: false, failureClass, recoveryRequired: true };
      const result = await validateOpenClawAgentAttemptEvidence(
        publicFetchAttemptValidationOptions({
          classification,
          collectToolEvidence: true,
          recordToolEvidence,
        }),
      );
      expect(recordToolEvidence).toHaveBeenCalledOnce();
      expect(result).toEqual({ attempt: classification });
    },
  );

  it.each([
    async () => ({ exitCode: 2, stdout: "secret must-not-remain" }),
    async () => ({ exitCode: 0, stdout: "malformed must-not-remain" }),
    async () => {
      throw new Error("transport must-not-remain");
    },
  ])(
    "preserves the original failure when diagnostic reduction is unavailable",
    async (reduceToolEvidence) => {
      const classification = { passed: false, failureClass: "authentication" as const };
      const recordToolEvidenceReductionFailure = vi.fn();
      const result = await validateOpenClawAgentAttemptEvidence(
        publicFetchAttemptValidationOptions({
          classification,
          collectToolEvidence: true,
          reduceToolEvidence,
          recordToolEvidenceReductionFailure,
        }),
      );
      expect(result).toEqual({ attempt: classification });
      expect(recordToolEvidenceReductionFailure).toHaveBeenCalledOnce();
      expect(JSON.stringify(recordToolEvidenceReductionFailure.mock.calls)).not.toContain(
        "must-not-remain",
      );
    },
  );

  it("records HTTP status from tool results without trusting the assistant's explanation", () => {
    const session = publicFetchSessionJsonLines({
      isError: true,
      payload: publicFetchPayload({ status: 503, text: REDUCER_SECRET_SENTINEL }),
    });
    const evidence = reduceOpenClawToolEvidence(session, "", PUBLIC_FETCH_EXPECTATION);
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toEqual([
      { httpStatus: 503, toolError: true, paired: true },
    ]);
    expect(artifact.matches).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain(REDUCER_SECRET_SENTINEL);
    const assistantOnly = reduceOpenClawToolEvidence(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Wikimedia returned HTTP 503" }],
        },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(
      projectPersonalPublicFetchToolEvidenceArtifact(assistantOnly).webFetchDiagnostics,
    ).toEqual([]);
  });

  it("reads the pinned producer's error prefix without retaining its response detail", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        payload: {
          status: "error",
          tool: "web_fetch",
          error: `Web fetch failed (503): ${REDUCER_SECRET_SENTINEL}`,
        },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toEqual([
      { httpStatus: 503, toolError: true, paired: true },
    ]);
    expect(artifact.matches).toBe(false);
    expect(evidence.webFetchResults[0]?.httpSuccess).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(REDUCER_SECRET_SENTINEL);
  });

  it.each([
    { status: "error", tool: "web_fetch", error: "Agent said Web fetch failed (503): details" },
    { status: "error", tool: "web_fetch", error: "Web fetch failed (999): details" },
    { status: "error", tool: "web_fetch", error: "Web fetch failed (5030): details" },
    { status: "error", tool: "other", error: "Web fetch failed (503): details" },
    { status: "ok", tool: "web_fetch", error: "Web fetch failed (503): details" },
  ])("does not infer HTTP status from unsupported error shapes: %j", (payload) => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({ payload }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(
      projectPersonalPublicFetchToolEvidenceArtifact(evidence).webFetchDiagnostics[0]?.httpStatus,
    ).toBeNull();
  });

  it("keeps missing tool HTTP status unknown and bounds diagnostic records", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        isError: true,
        payload: { status: "error", error: "private details" },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(projectPersonalPublicFetchToolEvidenceArtifact(evidence).webFetchDiagnostics).toEqual([
      { httpStatus: null, toolError: true, paired: true },
    ]);
    evidence.webFetchResults = Array.from({ length: 100 }, () => ({
      ...evidence.webFetchResults[0]!,
      httpStatus: 999,
    }));
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toHaveLength(64);
    expect(artifact.webFetchDiagnostics.every((record) => record.httpStatus === null)).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain("private details");
  });
});
