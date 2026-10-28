// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawConfig, OpenClawPluginApi } from "./index.js";
import { configuredSearchEnabled } from "./search-config.js";
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
  const enabled = configuredSearchEnabled(config);
  let availability = "Web search availability is not confirmed by OpenClaw configuration.";
  if (enabled === false) {
    availability =
      "Web search is disabled in OpenClaw configuration. For web-search requests, tell the user that web search is unavailable immediately. Do not use tool discovery to find the disabled search provider or retry searches. Do not inspect sandbox-local files, memory, or shell output to reconstruct web-search results.";
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

function researchScope(prompt: string): "external" | "supplied" | "ordinary" {
  // Generic questions need local tools without naming a source. Require external
  // research intent, and keep separate requests from exempting one another.
  // Normalize URLs before splitting so their path words cannot become requests.
  const requests = prompt
    .replace(/\bhttps?:\/\/\S+/giu, "https://supplied-url.invalid/")
    .replace(/:\s*\n\s*(?=https?:\/\/)/giu, ": ")
    .split(
      /(?<=[.!?])\s+|[\n;]+|,\s*(?=(?:google|bing|duckduckgo|search|research|look|find|locate|browse|investigate)\b)|\b(?:and|then|but|instead)\b(?!\s+(?:fetch|retrieve)\b)/iu,
    );
  const scopes = requests.map((request) => {
    // A supplied URL is a retrieval target; its path words are not user intent.
    const hasUrl = /\bhttps?:\/\/\S+/iu.test(request);
    const intent = request.replace(/\bhttps?:\/\/\S+/giu, "");
    const action =
      /\b(?:(?:use|run|ask)\s+(?:tavily|brave)|google|bing|duckduckgo|web[_ -]?search|search|research|investigate|look(?:\s+(?:up|for|on))?|find|locate|gather|browse|seek|consult|query|discover|explore|provide|show|point|give|summarize|fetch|retrieve|read|get|need|where|which|what|who|when|how)\b/iu.exec(
        intent,
      );
    if (!action) return "ordinary";
    const prefix = intent.slice(0, action.index);
    if (/\b(?:(?:do\s+not|don't|never)\s+(?:use\s+(?:web_fetch[,\s]*)?)?|not\s*)$/iu.test(prefix)) {
      return "ordinary";
    }

    const source = intent.slice(action.index);
    const directFetch = /^(?:browse|summarize|fetch|retrieve|read|get)\b/iu.test(source);
    const searchAction =
      /\b(?:googl(?:e|ing)|bing|duckduckgo|web[_ -]?search|search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek)\b/iu.test(
        source,
      );
    if (directFetch && !searchAction && hasUrl) return "supplied";

    const externalSource =
      /^(?:(?:use|run|ask)\s+(?:tavily|brave)|google|bing|duckduckgo|web[_ -]?search)\b|\b(?:on\s+(?:the\s+)?(?:web|internet)|(?:search|research|browse|look)\s+(?:(?:the|on\s+the)\s+)?(?:web|internet|online)|(?:using|with|via)\s+(?:tavily|brave|google|bing|duckduckgo))\b/iu.test(
        source,
      );
    // A local source must be the action's target or an explicit source location.
    // Words in the requested research topic do not grant access to substitutes.
    const subject = source.slice(action[0].length).trimStart();
    const localSource =
      /(?:^|\b(?:in|from|within|under|through)\s+)(?:(?:this|the|our|my|your)\s+)?(?:local\s+(?:files?|logs?|memory|repository|repo|workspace|codebase|project|directory|sources?|docs|documentation)\b|sandbox\b|(?:current|working)\s+directory\b|(?:logs|memory|repository|repo|workspace|codebase|project|function|conversation|code)\b|[`"']?(?:\.?\.?\/)[^\s]+|[`"']?(?:[\w.-]+\/)*[\w-]+\.(?:md|txt|[cm]?[jt]sx?|json|ya?ml|toml|py|sh)\b)(?:\s+(?:files?|docs|directory|sources?|logs?))?[`"']?(?=\s*(?:[.!?,;:]|$)|\s+(?:for|to|and|then)\b)/iu.test(
        subject,
      );
    const suppliedUrl =
      /\b(?:search|research|find|locate|look\s+(?:up|for))\s+(?:(?:in|within|at|on|through)\s+)?https?:\/\/\S+|\b(?:in|within|at|from)\s+https?:\/\/\S+/iu.test(
        request,
      );
    const externalResearch =
      /^search\b|\bto\s+search\b/iu.test(source) ||
      /\bonline(?=\s*(?:[.!?]|$)|\s+(?:for|about|using|with|via|today|now|please)\b)/iu.test(
        source,
      ) ||
      (/\b(?:official|latest|recent|alternative)\b/iu.test(source) &&
        /\b(?:documentation|docs|installation\s+(?:instructions|procedure|guides?)|release\s+notes|announcements|news|sources)\b/iu.test(
          source,
        ));
    if (externalSource) return "external";
    if (localSource || suppliedUrl) return "supplied";
    return externalResearch ? "external" : "ordinary";
  });
  if (scopes.includes("external")) return "external";
  return scopes.includes("supplied") ? "supplied" : "ordinary";
}

/** Prepends runtime context and withholds tools for disabled-search research. */
export function registerRuntimeContext(
  api: OpenClawPluginApi,
  pluginConfig: NemoClawConfig,
  onSourceScope?: (supplied: boolean, args: readonly unknown[]) => void,
): void {
  api.on("before_prompt_build", (...args) => {
    const event = args[0];
    const prompt =
      event && typeof event === "object" && !Array.isArray(event) ? event.prompt : undefined;
    // A tool-call denial happens after the model has already attempted discovery.
    // Keep local work and direct URL retrieval available without using them as
    // substitutes for research whose source the user has not supplied.
    const scope = typeof prompt === "string" ? researchScope(prompt) : "ordinary";
    const searchDisabled = configuredSearchEnabled(api.config) === false;
    if (searchDisabled) onSourceScope?.(scope === "supplied", args);
    const unavailableSearch = searchDisabled && scope === "external";
    return {
      prependSystemContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig), api.config),
      ...(unavailableSearch ? { toolsAllow: [] } : {}),
    };
  });
}
