// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadState } from "./blueprint/state.js";
import type { SuppliedSearchSources } from "./denied-search-state.js";
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

type ResearchScope = "external" | "supplied" | "ordinary";

interface ResearchRequestScope extends SuppliedSearchSources {
  scope: ResearchScope;
}

function classifyResearchScope(prompt: string): ResearchRequestScope {
  // Generic questions need local tools without naming a source. Require external
  // research intent, and keep separate requests from exempting one another.
  // Normalize URLs before splitting so their path words cannot become requests.
  const urls: string[] = [];
  const requests = prompt
    .replace(/\bhttps?:\/\/\S+/giu, (raw) => {
      const url = raw.replace(/[.,;!?)\]}]+$/u, "");
      const index = urls.push(url) - 1;
      return `https://supplied-url.invalid/${index}/${raw.slice(url.length)}`;
    })
    .replace(/:\s*\n\s*(?=https?:\/\/)/giu, ": ")
    // Coordinated verbs share the following target: "find and fix the bug".
    // Keep the research verb so an external target still requires web search.
    .replace(
      /\b(search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query|read|summarize)\s+(?:(?:and|then)\s+(?:search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query|provide|show|point|give|summarize|fetch|retrieve|read|get|inspect|fix|repair|replace|edit|update|debug|test)\s+)+/giu,
      "$1 ",
    )
    .split(
      /(?<=[.!?])\s+|[\n;]+|,\s*(?=(?:google|bing|duckduckgo|search|research|look|find|locate|browse|investigate)\b)|\b(?:and|then|but|instead)\b(?!\s+(?:fetch|retrieve)\s+https?:\/\/)(?=\s+(?:(?:please|could|can|would|you|I|we|do|not|don't|never)\s+)*(?:use|run|ask|google|bing|duckduckgo|web[_ -]?search|search|research|investigate|look|find|locate|gather|browse|seek|consult|query|discover|explore|provide|show|point|give|summarize|fetch|retrieve|read|get|need|want|where|which|what|who|when|how)\b)/iu,
    );
  const scopes = requests.map((request): ResearchRequestScope => {
    const requestUrls = Array.from(
      request.matchAll(/https:\/\/supplied-url\.invalid\/(\d+)\//gu),
      (match) => urls[Number(match[1])]!,
    );
    // A supplied URL is a retrieval target; its path words are not user intent.
    const hasUrl = requestUrls.length > 0;
    const intent = request.replace(/\bhttps?:\/\/\S+/giu, "");
    const action =
      /\b(?:(?:use|run|ask)\s+(?:tavily|brave)|google|bing|duckduckgo|web[_ -]?search|search|research|investigate|look(?:\s+(?:up|for|on))?|find|locate|gather|browse|seek|consult|query|discover|explore|provide|show|point|give|summarize|fetch|retrieve|read|get|need|where|which|what|who|when|how)\b/iu.exec(
        intent,
      );
    const prefix = intent.slice(0, action?.index ?? 0);
    if (/\b(?:(?:do\s+not|don't|never)\s+(?:use\s+(?:web_fetch[,\s]*)?)?|not\s*)$/iu.test(prefix)) {
      return { scope: "ordinary", local: false, urls: [] };
    }

    // A requested external result does not require a particular action verb.
    const source = intent.slice(action?.index ?? 0);
    const directFetch = /^(?:browse|summarize|fetch|retrieve|read|get)\b/iu.test(source);
    const searchAction =
      /\b(?:googl(?:e|ing)|bing|duckduckgo|web[_ -]?search|search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek)\b/iu.test(
        source,
      );

    const externalSource =
      /^(?:(?:use|run|ask)\s+(?:tavily|brave)|google|bing|duckduckgo|web[_ -]?search)\b|\b(?:on\s+(?:the\s+)?(?:web|internet)|(?:search|research|browse|look)\s+(?:(?:the|on\s+the)\s+)?(?:web|internet|online)|(?:using|with|via)\s+(?:tavily|brave|google|bing|duckduckgo))\b/iu.test(
        source,
      );
    // A local source must be the action's target or an explicit source location.
    // Words in the requested research topic do not grant access to substitutes.
    const subject = source
      .slice(action?.[0].length ?? 0)
      .trimStart()
      .replace(/^(?:['’]s|is|are|was|were)\s+/iu, "");
    const localSource =
      /(?:^|\b(?:in|from|within|under|through)\s+)(?:(?:this|the|our|my|your)\s+)?(?:file\s+)?(?:local\s+(?:files?|logs?|memory|repository|repo|workspace|codebase|project|directory|sources?|docs|documentation)\b|sandbox\b|(?:current\s+(?:working\s+)?|working\s+)directory\b|(?:logs|memory|repository|repo|workspace|codebase|project|function|conversation|code)\b|[`"']?(?:\.?\.?\/)[^\s]+|[`"']?(?:Dockerfile|Containerfile|(?:GNU)?Makefile|LICENSE|NOTICE|README)(?:\.[\w-]+)*(?![\w-]|\.[\w-])|[`"']?\.[\w-]+\b|[`"']?[\w.-]+(?:\/[\w.-]+)*\/|[`"']?[\w.-]+(?:\/[\w.-]+)+|[`"'][\w.-]+[`"']|[`"']?(?:[\w.-]+\/)*[\w-]+\.(?:md|txt|[cm]?[jt]sx?|json|ya?ml|toml|py|sh)\b)(?:\s+(?:files?|docs|directory|sources?|logs?|code|recursively|layout))*[`"']?(?=\s*(?:[.!?,;:]|$)|\s+(?:for|to|and|then)\b)/iu.test(
        subject,
      ) ||
      /(?:^|\b(?:in|from|within|under|through)\s+)(?:(?:why|how)\s+|(?:the\s+)?(?:root\s+)?cause\s+of\s+)?(?:(?:(?:this|these|those|our|my|the|your|a|an)\s+)?(?:(?:(?:failing|failed|broken)\s+)?(?:(?:unit|integration)\s+)?tests?|(?:build|test)\s+(?:error|failure|output|results?))|shell\s+history)\b(?=\s*(?:[.!?,;:]|$)|\s+(?:(?:(?:is|are|was|were|has|have|had|keeps?|kept)\s+)?fail(?:s|ed|ing)?|for|to|and|then)\b)/iu.test(
        subject,
      );
    const suppliedUrl =
      /\b(?:search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query)\s+(?:(?:in|within|at|on|through)\s+)?https?:\/\/\S+|\b(?:browse|summarize|fetch|retrieve|read|get)\s+https?:\/\/\S+|\b(?:in|within|at|from)\s+https?:\/\/\S+/iu.test(
        request,
      );
    // Local inspection does not require a supplied retrieval source. Keep it
    // separate from source grants and from requests about an external topic.
    const localWork =
      /^(?:for\s+)?(?:(?:out\s+)?(?:which|what|why|how)(?:\s+many)?\s+)?(?:of\s+)?(?:(?:all|any|some|each|every|both|many)(?:\s+of)?\s+)?(?:(?:this|these|those|the|our|my|your|a|an)\s+)?(?:(?:top\s+)?\d+\s+)?(?:(?:(?:current|high|low|excessive)\s+)?(?:disk|storage|memory|cpu)\s+(?:usage|space|pressure)|(?:(?:running|active|stalled|zombie|background)\s+)?process(?:es)?|(?:(?:largest|biggest|smallest|oldest|newest|duplicate|empty|hidden|temporary|(?:recently\s+)?modified)\s+)?(?:files?|directories|folders?)|(?:file\s*system|file|directory)\s+permissions)\b(?=\s*(?:[.!?,;:]|$)|\s+(?:is|are|was|were|has|have|owns?|uses?|using|listens?|listening|consumes?|consuming|holds?|holding|by|with|that|which|named|matching|larger|smaller|older|newer|for|to|and|then)\b|\s+(?:in|on|under|within)\s+(?:(?:this|the|our|my|your|local|current|working)\s+)*(?:disk|file\s*system|directory|folder|machine|sandbox|workspace|repo|repository|computer|host)\b)/iu.test(
        subject,
      );
    const externalResearch =
      (!localWork &&
        /^(?:search|research|investigate|look\s+(?:up|for)|find|locate|gather|seek|discover|explore|browse|consult|query)\b|\bto\s+search\b/iu.test(
          source,
        )) ||
      /\bonline(?=\s*(?:[.!?]|$)|\s+(?:for|about|using|with|via|today|now|please)\b)/iu.test(
        source,
      ) ||
      (!localWork &&
        /^(?:what|where|which|who|when|how)\b/iu.test(source) &&
        /\b(?:current|latest|recent|today(?:['’]s)?|now|live|up[ -]to[ -]date)\b/iu.test(source)) ||
      (/\b(?:official|latest|recent|alternative)\b/iu.test(source) &&
        /\b(?:documentation|docs|installation\s+(?:instructions|procedure|guides?)|release\s+notes|announcements|news|sources)\b/iu.test(
          source,
        ));
    if (directFetch && !searchAction && hasUrl) {
      return { scope: "supplied", local: localSource, urls: requestUrls };
    }
    if (externalSource) return { scope: "external", local: false, urls: [] };
    if (localSource || suppliedUrl) {
      return { scope: "supplied", local: localSource, urls: suppliedUrl ? requestUrls : [] };
    }
    return { scope: externalResearch ? "external" : "ordinary", local: false, urls: [] };
  });
  if (scopes.some(({ scope }) => scope === "external")) {
    return { scope: "external", local: false, urls: [] };
  }
  return {
    scope: scopes.some(({ scope }) => scope === "supplied") ? "supplied" : "ordinary",
    local: scopes.some(({ local }) => local),
    urls: scopes.flatMap(({ urls: targets }) => targets),
  };
}

export function researchScope(prompt: string): ResearchScope {
  return classifyResearchScope(prompt).scope;
}

/** Retain retrieval targets only when the complete request supplies its sources. */
export function suppliedSearchSources(prompt: string): SuppliedSearchSources | undefined {
  const { scope, local, urls } = classifyResearchScope(prompt);
  return scope === "supplied" ? { local, urls } : undefined;
}

/** Prepends runtime context and withholds tools for disabled-search research. */
export function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void {
  api.on("before_prompt_build", (...args) => {
    const event = args[0];
    const prompt =
      event && typeof event === "object" && !Array.isArray(event) ? event.prompt : undefined;
    // A tool-call denial happens after the model has already attempted discovery.
    // Keep local work and direct URL retrieval available without using them as
    // substitutes for research whose source the user has not supplied.
    const scope = typeof prompt === "string" ? researchScope(prompt) : "ordinary";
    const searchDisabled = configuredSearchEnabled(api.config) === false;
    const unavailableSearch = searchDisabled && scope === "external";
    return {
      prependSystemContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig), api.config),
      ...(unavailableSearch ? { toolsAllow: [] } : {}),
    };
  });
}
