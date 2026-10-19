// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_COUNTER,
  HARNESS_TMPDIR,
  makeFakeCurlScript,
  withFakeCurlProbe,
} from "./onboard-probes-curl-harness";

const { probeOpenAiLikeEndpoint } = require("./onboard-probes");

describe("chat-completions transport retry failures", () => {
  it("keeps GPT-5 timeout retries strict when tool calling is required (#6642)", () => {
    const script = `#!/usr/bin/env bash
outfile=""
payload=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    *) shift ;;
  esac
done
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
printf '%s' "$payload" > "${HARNESS_TMPDIR}/request-$n.json"
if [ "$n" -eq 1 ]; then
  if [ -n "$outfile" ]; then
    : > "$outfile"
  fi
  printf '000'
  exit 28
fi
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`;
    withFakeCurlProbe(
      { script, dirPrefix: "nemoclaw-strict-retry-probe-" },
      ({ counter, tmpDir }) => {
        const result = probeOpenAiLikeEndpoint("https://api.example.com/v1", "gpt-5.4", "sk-test", {
          skipResponsesProbe: true,
          requireChatCompletionsToolCalling: true,
        });

        expect(result).toMatchObject({ ok: false });
        expect(result.message).toContain("did not return a tool call");
        expect(result.failures).toEqual([
          expect.objectContaining({
            name: "Chat Completions API with tool calling (retry)",
            httpStatus: 200,
            curlStatus: 0,
            diagnosticCodes: ["openai-chat-missing-structured-tool-call"],
          }),
        ]);
        expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
        const retryPayload = JSON.parse(
          fs.readFileSync(path.join(tmpDir, "request-2.json"), "utf8"),
        );
        expect(retryPayload).toMatchObject({
          tool_choice: "required",
          max_completion_tokens: 256,
          stream: false,
        });
        expect(retryPayload.max_tokens).toBeUndefined();
        expect(retryPayload.temperature).toBeUndefined();
      },
    );
  });

  it.each([
    [401, 2],
    [403, 2],
    [503, 5],
  ])("retains HTTP %s after an initial timeout (#13350)", (status, attempts) => {
    const body = `n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
echo "$n" > "${HARNESS_COUNTER}"
if [ "$n" -eq 1 ]; then
  : > "$outfile"
  printf '000'
  exit 28
fi
printf '%s' '{"detail":"secret-key upstream response"}' > "$outfile"
printf '${status}'
exit 0
`;
    withFakeCurlProbe(
      { script: makeFakeCurlScript(body), dirPrefix: "nemoclaw-final-retry-error-" },
      ({ counter, lines }) => {
        const result = probeOpenAiLikeEndpoint(
          "https://integrate.api.nvidia.com/v1",
          "nvidia/nemotron-3-ultra-550b-a55b",
          "nvapi-test",
          { skipResponsesProbe: true },
        );

        expect(result.ok).toBe(false);
        expect(result.failures).toMatchObject([
          { name: "Chat Completions API (retry)", httpStatus: status, curlStatus: 0 },
        ]);
        expect(Number(fs.readFileSync(counter, "utf8"))).toBe(attempts);
        expect(lines.join("\n")).not.toContain("secret-key");
      },
    );
  });
});
