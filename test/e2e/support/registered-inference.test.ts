// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
} from "../../../src/lib/inference/native-local/contract.ts";
import { customNativeProvider } from "../../../src/lib/inference/native-provider/custom.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  registeredCompatibleChatCommand,
  registeredCompatibleResponseCommand,
  readRegisteredLocalRoute,
} from "../fixtures/registered-inference.ts";

vi.mock("../../../src/lib/state/registry.ts", () => ({ getSandbox: vi.fn() }));

const localBinding: NativeLocalBinding = {
  provider: "compatible-endpoint",
  agent: "openclaw",
  endpointUrl: "http://host.openshell.internal:8000/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
  gatewayName: "test-gateway",
  sandboxName: "test-sandbox",
};
const local = {
  ...localBinding,
  ...nativeLocalIdentity(localBinding),
  schemaVersion: 1 as const,
  providerId: "provider-one",
};
const selection = {
  name: "test-sandbox",
  agent: "openclaw" as const,
  gatewayName: "test-gateway",
  provider: "compatible-endpoint",
  model: "test-model",
  nativeLocalProviderAttachment: local,
};
const payload = JSON.stringify({
  model: "test-model",
  messages: [{ role: "user", content: "PONG $(not-a-command)" }],
});
let directory: string;
beforeEach(() => {
  vi.mocked(getSandbox).mockReturnValue(selection);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "registered-inference-"));
  fs.writeFileSync(path.join(directory, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
    mode: 0o755,
  });
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function run(command: [string, ...string[]], env: Record<string, string>) {
  return spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ...env },
  });
}

it("executes the local probe with its exact endpoint, payload and scoped credential", () => {
  const credential = "openshell:resolve:env:v17_NEMOCLAW_LOCAL_INFERENCE_TOKEN";
  const result = run(registeredCompatibleChatCommand("test-sandbox", "test-model", payload), {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: credential,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.split("\n")).toEqual([
    "-fsS",
    "--max-time",
    "60",
    `${local.endpointUrl}/chat/completions`,
    "-H",
    "Content-Type: application/json",
    "-H",
    `Authorization: Bearer ${credential}`,
    "--data-raw",
    payload,
    "",
  ]);
});

it.each([
  "raw-secret",
  "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  "openshell:resolve:env:v17_NEMOCLAW_LOCAL_INFERENCE_TOKEN\nraw-secret",
])("rejects an unsafe local credential before invoking curl: %s", (credential) => {
  const result = run(registeredCompatibleChatCommand("test-sandbox", "test-model", payload), {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: credential,
  });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
});

it.each([
  { model: "other" },
  { gatewayName: "other-gateway" },
  { agent: "hermes" },
  { nativeLocalProviderAttachment: { ...local, providerId: "" } },
  { nativeLocalProviderAttachment: undefined },
])("rejects a stale or missing selection before constructing a probe: %j", (change) => {
  vi.mocked(getSandbox).mockReturnValue({ ...selection, ...change } as typeof selection);
  expect(() => registeredCompatibleChatCommand("test-sandbox", "test-model", payload)).toThrow();
});

it("reads the replacement endpoint from the current registry after recreation", () => {
  const binding = { ...localBinding, endpointUrl: "http://host.openshell.internal:8001/v1" };
  vi.mocked(getSandbox).mockReturnValue({
    ...selection,
    nativeLocalProviderAttachment: {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1,
      providerId: "replacement",
    },
  });
  const result = run(registeredCompatibleChatCommand("test-sandbox", "test-model", payload), {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: "openshell:resolve:env:v18_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`${binding.endpointUrl}/chat/completions`);
  expect(result.stdout).not.toContain(local.endpointUrl);
});

it.each([false, true])(
  "preserves hosted error responses and the explicit redirect choice: %s",
  (follow) => {
    const definition = customNativeProvider({
      provider: "compatible-endpoint",
      endpointUrl: "https://example.com/v1",
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      allowedIps: ["8.8.8.8"],
    });
    vi.mocked(getSandbox).mockReturnValue({
      ...selection,
      nativeLocalProviderAttachment: undefined,
      nativeHostedProviderAttachment: { ...definition, schemaVersion: 1, providerId: "hosted-one" },
    });
    const credential = "openshell:resolve:env:v18_COMPATIBLE_API_KEY";
    const result = run(
      registeredCompatibleResponseCommand("test-sandbox", "test-model", payload, follow),
      { COMPATIBLE_API_KEY: credential },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "-sS",
      "--include",
      ...(follow ? ["--location", "--post302", "--max-redirs", "3"] : []),
      "--max-time",
      "60",
      "https://example.com/v1/chat/completions",
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${credential}`,
      "--data-raw",
      payload,
      "",
    ]);
  },
);

function readback(providerId = local.providerId, attached = local.providerName) {
  return vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `Name: ${local.providerName}\nId: ${providerId}\nResource version: 1\nType: ${local.profileId}\nCredential keys: ${local.credentialEnv}\nConfig keys: <none>`,
      stderr: "",
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: attached, stderr: "" });
}
it("reads the sibling provider identity and attachment on its recorded gateway", async () => {
  const openshell = readback();
  const result = await readRegisteredLocalRoute(
    { openshell } as unknown as SandboxClient,
    "test-sandbox",
    "before",
  );
  expect(result).toEqual({
    exitCode: 0,
    stdout: JSON.stringify({
      provider: selection.provider,
      model: selection.model,
      receipt: local,
    }),
    stderr: "",
  });
  expect(openshell.mock.calls.map(([command]) => command)).toEqual([
    ["provider", "get", "-g", "test-gateway", local.providerName],
    ["sandbox", "provider", "list", "-g", "test-gateway", "test-sandbox"],
  ]);
});
it.each([
  ["other-provider", local.providerName],
  [local.providerId, "detached"],
])("rejects a replaced or detached sibling provider: %s %s", async (id, attached) => {
  const openshell = readback(id, attached);
  expect(
    await readRegisteredLocalRoute(
      { openshell } as unknown as SandboxClient,
      "test-sandbox",
      "after",
    ),
  ).toMatchObject({
    exitCode: 1,
    stderr: "Sibling native provider identity or attachment mismatch",
  });
});
