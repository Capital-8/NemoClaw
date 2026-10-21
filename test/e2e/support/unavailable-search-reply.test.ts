// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyOpenClawAgentAssertion,
  isUnavailableSearchReply,
} from "../live/common-egress-agent-helpers.ts";

describe("unavailable web-search reply evidence", () => {
  it("rejects a fabricated documentation result even when the expected reply key is present", () => {
    const reply = JSON.stringify({
      searchStatus: "unavailable",
      installationDocumentation: {
        title: "NVIDIA Announces NemoClaw",
        url: "https://nvidianews.nvidia.com/",
      },
    });
    expect(
      classifyOpenClawAgentAssertion({
        exitCode: 0,
        expected: "searchStatus",
        reply,
        response: reply,
      }),
    ).toEqual({ passed: true });
    expect(isUnavailableSearchReply(reply)).toBe(false);
  });

  it.each([
    'Based on my investigation of the local files, there is no separate "official NVIDIA NemoClaw installation documentation" page.',
    "Based on my research of the OpenClaw documentation: Page Title: NVIDIA announces NemoClaw. URL: https://nvidianews.nvidia.com/",
    JSON.stringify({ searchStatus: "available", installationDocumentation: null }),
  ])("rejects an unsupported or incomplete reply: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(false);
  });

  it.each([
    '{"searchStatus":"unavailable","installationDocumentation":null}\nOfficial installation documentation: NVIDIA Announces NemoClaw, https://nvidianews.nvidia.com/',
    '```json\n{"searchStatus":"unavailable","installationDocumentation":null}\n```\nOfficial installation documentation: NVIDIA Announces NemoClaw, https://nvidianews.nvidia.com/',
    'Official installation documentation: NVIDIA Announces NemoClaw.\n{"searchStatus":"unavailable","installationDocumentation":null}',
    '{"searchStatus":"unavailable","installationDocumentation":null}\n{"installationDocumentation":{"url":"https://nvidianews.nvidia.com/"}}',
    '{"searchStatus":"unavailable","installationDocumentation":null,"claim":"NVIDIA Announces NemoClaw is the official installation documentation"}',
  ])("rejects claims outside the unavailable-search fields: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(false);
  });

  it.each([
    '{"searchStatus":"unavailable","installationDocumentation":null}',
    '  \n{"searchStatus":"unavailable","installationDocumentation":null}\n  ',
  ])("accepts a complete unavailable-search JSON reply: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(true);
  });

  it("accepts an unavailable-search reply with no claimed installation documentation", () =>
    expect(
      isUnavailableSearchReply(
        '```json\n{"searchStatus":"unavailable","installationDocumentation":null}\n```',
      ),
    ).toBe(true));
});
