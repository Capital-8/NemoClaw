// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

describe("OpenAI-compatible loopback no-auth onboarding", () => {
  it("requires explicit none in non-interactive mode (#7424)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compatible-no-auth-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then outfile="$2"; shift 2; else shift; fi
done
body='{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}'
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
printf '200'
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

async function run(mode) {
  Object.assign(process.env, {
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: "http://localhost:11434/v1",
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_PREFERRED_API: "chat-completions",
  });
  delete process.env.COMPATIBLE_API_KEY;
  if (mode === null) delete process.env.NEMOCLAW_COMPATIBLE_AUTH_MODE;
  else process.env.NEMOCLAW_COMPATIBLE_AUTH_MODE = mode;
  const originalExit = process.exit;
  process.exit = (code) => { throw Object.assign(new Error("exit"), { code }); };
  try {
    const result = await setupNim(null);
    return { mode, credentialEnv: result.credentialEnv };
  } catch (error) {
    return { mode, exitCode: error.code };
  } finally {
    process.exit = originalExit;
  }
}

(async () => {
  const originalLog = console.log;
  console.log = () => {};
  const results = [];
  for (const mode of ["none", null, "invalid"]) results.push(await run(mode));
  console.log = originalLog;
  originalLog(JSON.stringify(results));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );

    try {
      const childEnv = { ...process.env };
      delete childEnv.COMPATIBLE_API_KEY;
      delete childEnv.NEMOCLAW_PROVIDER_KEY;
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...childEnv, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), [
        { mode: "none", credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
        { mode: null, exitCode: 1 },
        { mode: "invalid", exitCode: 1 },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("matches a same-gateway no-auth sandbox with identical settings (#13733)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compatible-no-auth-peer-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const compatibilityPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "gateway-route-compatibility.ts"),
    );
    const containmentPath = JSON.stringify(
      path.join(
        repoRoot,
        "src",
        "lib",
        "onboard",
        "machine",
        "handlers",
        "provider-inference-route-containment.ts",
      ),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then outfile="$2"; shift 2; else shift; fi
done
body='{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}'
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
printf '200'
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});
const compatibility = require(${compatibilityPath});
const { guardProviderInferenceRouteSelection } = require(${containmentPath});

function peer(credentialEnv) {
  return {
    name: "test-a",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    createdAt: "2026-10-26T00:00:00.000Z",
    provider: "compatible-endpoint",
    model: "test-model",
    endpointUrl: "http://localhost:11434/v1",
    preferredInferenceApi: "openai-completions",
    credentialEnv,
  };
}

async function run(label, { authMode, apiKey, peerCredentialEnv }) {
  Object.assign(process.env, {
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: "http://localhost:11434/v1",
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_PREFERRED_API: "chat-completions",
  });
  if (apiKey) process.env.COMPATIBLE_API_KEY = apiKey;
  else delete process.env.COMPATIBLE_API_KEY;
  if (authMode) process.env.NEMOCLAW_COMPATIBLE_AUTH_MODE = authMode;
  else delete process.env.NEMOCLAW_COMPATIBLE_AUTH_MODE;
  const sandboxes = [peer(peerCredentialEnv)];
  const errors = [];
  const deps = {
    checkGatewayRouteCompatibility: (request) =>
      compatibility.checkGatewayRouteCompatibility({ ...request, sandboxes }),
    preflightGatewayRouteDiscovery: (request) =>
      compatibility.preflightGatewayRouteDiscovery({ ...request, sandboxes }),
    error: (message) => errors.push(message),
    exitProcess: (code) => {
      throw Object.assign(new Error("exit"), { code });
    },
  };
  const guard = (route) =>
    guardProviderInferenceRouteSelection(deps, "nemoclaw", "test-b", false, route);
  const originalExit = process.exit;
  process.exit = (code) => { throw Object.assign(new Error("exit"), { code }); };
  try {
    const result = await setupNim(null, "test-b", null, true, null, "nemoclaw", guard);
    return { label, credentialEnv: result.credentialEnv };
  } catch (error) {
    const conflict = errors.find((message) => message.includes("credential identity"));
    return { label, exitCode: error.code, credentialConflict: Boolean(conflict) };
  } finally {
    process.exit = originalExit;
  }
}

(async () => {
  const originalLog = console.log;
  console.log = () => {};
  const results = [
    await run("same no-auth settings", {
      authMode: "none",
      peerCredentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    }),
    await run("API key against a no-auth peer", {
      apiKey: "test-key",
      peerCredentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    }),
    await run("no-auth against an API-key peer", {
      authMode: "none",
      peerCredentialEnv: "COMPATIBLE_API_KEY",
    }),
  ];
  console.log = originalLog;
  originalLog(JSON.stringify(results));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );

    try {
      const childEnv = { ...process.env };
      delete childEnv.COMPATIBLE_API_KEY;
      delete childEnv.NEMOCLAW_PROVIDER_KEY;
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...childEnv, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), [
        { label: "same no-auth settings", credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
        { label: "API key against a no-auth peer", exitCode: 1, credentialConflict: true },
        { label: "no-auth against an API-key peer", exitCode: 1, credentialConflict: true },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
