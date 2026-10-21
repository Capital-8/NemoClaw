// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawConfig, OpenClawPluginApi } from "./index.js";
import * as importedSandboxName from "./shared/sandbox-name.cjs";

const sourceOrGeneratedSandboxName = importedSandboxName as typeof importedSandboxName & {
  default?: typeof importedSandboxName;
};
const { isValidName } = sourceOrGeneratedSandboxName.default ?? sourceOrGeneratedSandboxName;

interface RuntimeSummary {
  sandboxName: string;
  sandboxPhase: string | null;
  networkLines: string[];
  filesystemLines: string[];
}

const STATIC_NETWORK_LINES = [
  "Outbound network access is deny-by-default, but allowed endpoints work. Try the request before declaring a host unreachable.",
  "OpenShell policy denials can raise operator approval requests. Report the actual error when a request fails.",
];

const STATIC_FILESYSTEM_LINES = [
  "filesystem and process access are scoped to the sandbox, not the host; do not assume access to host paths outside it",
  "within the sandbox you can create, edit, and run files (for example in /tmp or /sandbox) using your file and shell tools; try the operation and report if it fails rather than assuming it is unavailable",
];

/**
 * Resolves the active sandbox name by preferring the persisted state value
 * over the plugin configuration default.
 */
function getSandboxName(pluginConfig: NemoClawConfig): string {
  return loadState().sandboxName ?? pluginConfig.sandboxName;
}

/**
 * Returns static sandbox context without invoking OpenShell subprocesses.
 *
 * The gateway-loaded plugin must pass OpenClaw's install-time safety scanner,
 * so this intentionally avoids shelling out for live policy details. A future
 * implementation can replace this with Gateway API reads if OpenClaw exposes
 * policy state to plugins without subprocess execution.
 */
export function getRuntimeSummary(pluginConfig: NemoClawConfig): RuntimeSummary {
  let sandboxName = pluginConfig.sandboxName;
  try {
    sandboxName = getSandboxName(pluginConfig);
  } catch {
    // Keep the configured default if persisted state cannot be read.
  }

  return {
    sandboxName,
    sandboxPhase: null,
    networkLines: STATIC_NETWORK_LINES,
    filesystemLines: STATIC_FILESYSTEM_LINES,
  };
}

function searchContext(config: OpenClawConfig): string[] {
  // Read only the enable flag. Provider configuration can contain credentials.
  const tools = config.tools;
  const web = tools && typeof tools === "object" && !Array.isArray(tools) ? tools.web : undefined;
  const search = web && typeof web === "object" && !Array.isArray(web) ? web.search : undefined;
  const enabled =
    search && typeof search === "object" && !Array.isArray(search) ? search.enabled : undefined;

  let availability = "Web search availability is not confirmed by OpenClaw configuration.";
  if (enabled === false) {
    availability =
      "Web search is disabled in OpenClaw configuration. For web-search requests, tell the user that web search is unavailable.";
  } else if (enabled === true) {
    availability =
      "Web search is enabled in OpenClaw configuration. Configuration does not guarantee tool availability or request success.";
  }

  return [
    availability,
    "If no search tool is available, tell the user that web search is unavailable; do not claim to have searched.",
    "Only claim successful web research when a tool retrieved supporting content this turn.",
    "Label sandbox-local files, memory, and prior knowledge as local or unverified sources.",
    "Do not present a press release or announcement as installation documentation.",
    "A failed search or web_fetch is not evidence that a page does not exist.",
    "Report fetch errors separately from search availability.",
    "You may use successfully retrieved web_fetch content even when search is disabled. Cite the retrieved source and describe what it supports.",
  ];
}

function buildRuntimeContextText(summary: RuntimeSummary, config: OpenClawConfig): string {
  const displaySandboxName = isValidName(summary.sandboxName) ? summary.sandboxName : "<name>";
  const lines = [
    "<nemoclaw-runtime>",
    `You are running inside OpenShell sandbox "${displaySandboxName}" via NemoClaw.`,
    "Treat this as a sandboxed environment, not unrestricted host access.",
    summary.sandboxPhase ? `Current sandbox phase: ${summary.sandboxPhase}.` : null,
    "Network policy:",
    ...summary.networkLines.map((line) => `- ${line}`),
    "Filesystem policy:",
    ...summary.filesystemLines.map((line) => `- ${line}`),
    "Web research:",
    ...searchContext(config).map((line) => `- ${line}`),
    "Behavior:",
    "- Do not assert that a URL or host is blocked or unreachable unless you have actually attempted it this turn; report the actual result rather than speculating.",
    "- If a tool reports `CONNECT tunnel failed, response 403`, state that the proxy refused the request.",
    "- OpenShell policy may be the cause. The error alone does not confirm a policy denial.",
    `- Ask the operator to check \`nemoclaw ${displaySandboxName} logs --tail 50\` on the host before suggesting a policy change.`,
    "- Only suggest a policy change if a logged denial's destination and time match the failed request. The merged logs can contain unrelated denials.",
    "- If the last 50 log lines have no matching denial, ask the operator to inspect more logs; do not infer that policy allowed or blocked this request.",
    "- Do not call a proxy 403 a generic connectivity failure. Treat proxy 407, DNS, timeout, and TLS failures separately.",
    "- Do not claim unrestricted host or internet access either. When unsure, attempt the action and rely on the real result instead of speculating about the environment.",
    "</nemoclaw-runtime>",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

/**
 * Prepends sandbox and search context in a `<nemoclaw-runtime>` block each turn.
 */
export function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void {
  api.on("before_prompt_build", () => ({
    prependSystemContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig), api.config),
  }));
}
