// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw — OpenClaw Plugin for OpenShell
 *
 * Uses the real OpenClaw plugin API. Types defined locally are minimal stubs
 * that match the OpenClaw SDK interfaces available at runtime via
 * `openclaw/plugin-sdk`. We define them here because the SDK package is only
 * available inside the OpenClaw host process and cannot be imported at build
 * time.
 */

import { renderBox } from "./banner.js";
import { handleSlashCommand } from "./commands/slash.js";
import { readNativeRoute } from "./onboard/native-route.js";
import { getPluginConfig } from "./plugin-config.js";
import { registerRuntimeContext } from "./runtime-context.js";
import { safeResolvePath } from "./security/safe-resolve-path.js";
import { isMemoryPath, scanForSecrets } from "./security/secret-scanner.js";

type PluginScalar = string | number | boolean | null | undefined;
type PluginValue = PluginScalar | PluginRecord | PluginValue[];
type PluginRecord = { [key: string]: PluginValue };

function isToolParams(value: unknown): value is ToolParams {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isToolParams(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function readBeforeToolCallEvent(value: unknown): Partial<BeforeToolCallEvent> | undefined {
  if (!isToolParams(value)) {
    return undefined;
  }
  const params = value["params"];
  return {
    toolName: readStringProperty(value, "toolName"),
    params: isToolParams(params) ? params : undefined,
    runId: readStringProperty(value, "runId"),
  };
}

/** Use the same host identity for tool denial and authoritative agent_end cleanup. */
function searchTurnKey(args: readonly PluginValue[]): string | undefined {
  for (const key of ["runId", "sessionKey", "sessionId"]) {
    const value = readStringProperty(args[1], key) ?? readStringProperty(args[0], key);
    if (value?.trim()) return `${key}:${value}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenClaw Plugin SDK compatible types (mirrors openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

/** Subset of OpenClawConfig that we actually read. */
export interface OpenClawConfig {
  [key: string]: PluginValue;
}

/** Logger provided by the plugin host. */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

type ToolParams = { [key: string]: PluginValue };

/** Context passed to slash-command handlers. */
export interface PluginCommandContext {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: OpenClawConfig;
  from?: string;
  to?: string;
  accountId?: string;
}

/** Return value from a slash-command handler. */
export interface PluginCommandResult {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}

/** Registration shape for a slash command. */
export interface PluginCommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
}

/** Auth method for a provider plugin. */
export interface ProviderAuthMethod {
  id?: string;
  type: string;
  envVar?: string;
  headerName?: string;
  label?: string;
}

/** Model entry in a provider's model catalog. */
export interface ModelProviderEntry {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutput?: number;
}

/** Model catalog shape. */
export interface ModelProviderConfig {
  chat?: ModelProviderEntry[];
  completion?: ModelProviderEntry[];
}

/** Registration shape for a custom model provider. */
export interface ProviderPlugin {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: ModelProviderConfig;
  auth: ProviderAuthMethod[];
}

/** Background service registration. */
export interface PluginService {
  id: string;
  start: (ctx: { config: OpenClawConfig; logger: PluginLogger }) => void | Promise<void>;
  stop?: (ctx: { config: OpenClawConfig; logger: PluginLogger }) => void | Promise<void>;
}

/** Event payload for before_tool_call hooks. */
export interface BeforeToolCallEvent {
  toolName: string;
  params: ToolParams;
  runId?: string;
  toolCallId?: string;
}

/** Return value from a before_tool_call hook. */
export interface BeforeToolCallResult {
  params?: ToolParams;
  block?: boolean;
  blockReason?: string;
}

/** Return value from a before_prompt_build hook. */
export interface BeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

/** Union of all hook result types. */
export type HookResult = BeforeToolCallResult | BeforePromptBuildResult | undefined;

/**
 * The API object injected into the plugin's register function by the OpenClaw
 * host. Only the methods we actually call are listed here.
 */
export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  config: OpenClawConfig;
  pluginConfig?: OpenClawConfig;
  logger: PluginLogger;
  registerCommand: (command: PluginCommandDefinition) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerService: (service: PluginService) => void;
  resolvePath: (input: string) => string;
  on: (
    hookName: string,
    handler: (...args: readonly PluginValue[]) => HookResult | Promise<HookResult>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Plugin-specific config (read from pluginConfig in openclaw.plugin.json)
// ---------------------------------------------------------------------------

export interface NemoClawConfig {
  blueprintVersion: string;
  blueprintRegistry: string;
  sandboxName: string;
  inferenceProvider: string;
}

function registeredProviderForConfig(route: ReturnType<typeof readNativeRoute>): ProviderPlugin {
  return {
    id: "inference",
    label: "Managed Inference Route",
    aliases: ["inference-local", "nemoclaw"],
    envVars: route.credentialEnv ? [route.credentialEnv] : [],
    models: { chat: route.managedModel ? [route.managedModel] : [] },
    auth: route.credentialEnv
      ? [
          {
            id: "bearer",
            type: "bearer",
            envVar: route.credentialEnv,
            headerName: "Authorization",
            label: `API Key (${route.credentialEnv})`,
          },
        ]
      : [],
  };
}

export { getPluginConfig };

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/** Tool names that can write/modify files and should be scanned for secrets. */
const WRITE_TOOL_NAMES = new Set(["write", "edit", "apply_patch", "notebook_edit"]);

// OpenClaw clamps even per-run timeout overrides to the Node timer maximum.
// Retain denial through that whole active window plus one minute for cleanup.
const SEARCH_DENIAL_RETENTION_MS = 2_147_483_647 + 60_000;

function blocksDisabledSearch(
  config: OpenClawConfig,
  event: BeforeToolCallEvent,
  deniedSearchRuns: Map<string, number>,
): boolean {
  const now = Date.now();
  for (const [identity, expiresAt] of deniedSearchRuns) {
    if (expiresAt <= now) deniedSearchRuns.delete(identity);
  }
  const tools = config.tools;
  const web = isToolParams(tools) ? tools["web"] : undefined;
  const search = isToolParams(web) ? web["search"] : undefined;
  if (!isToolParams(search) || search["enabled"] !== false) {
    if (event.runId) deniedSearchRuns.delete(event.runId);
    return false;
  }

  const target = event.toolName.toLowerCase().split(":").at(-1) ?? "";
  const wrappedTarget = readStringProperty(event.params, "id")?.toLowerCase().split(":").at(-1);
  const effectiveTarget = target === "tool_call" ? (wrappedTarget ?? "") : target;
  const searchTool =
    effectiveTarget === "search" ||
    /web[_-]?search|(?:brave|tavily)(?:[_:-]|$)/u.test(effectiveTarget);
  const probe = JSON.stringify(event.params);
  const searchDiscovery =
    /^(?:tool_search|tool_describe)$/u.test(effectiveTarget) &&
    /\b(?:brave|tavily|search|web[_ -]?search)\b/iu.test(probe);
  const providerProbe =
    /^(?:exec|execute|shell|web_fetch|browser)$/u.test(effectiveTarget) &&
    /https?:\/\/(?:api\.tavily\.com|(?:api\.)?search\.brave\.com)(?:[/:?"\s]|$)/iu.test(probe);
  if (searchTool || searchDiscovery || providerProbe) {
    if (event.runId) deniedSearchRuns.set(event.runId, now + SEARCH_DENIAL_RETENTION_MS);
    return true;
  }

  // A denied search identifies the turn, not the subject of a local document.
  // Identity-less calls cannot safely correlate turns, so substitutes fail closed.
  const substituteTool =
    /^(?:tool_search|tool_describe|tool_call|web_fetch|memory_search|sessions_search|read|exec|execute|shell|browser)$/u;
  return (!event.runId || deniedSearchRuns.has(event.runId)) && substituteTool.test(target);
}

export default function register(api: OpenClawPluginApi): void {
  const deniedSearchRuns = new Map<string, number>();
  // 1. Register /nemoclaw slash command (chat interface)
  api.registerCommand({
    name: "nemoclaw",
    description: "NemoClaw sandbox management (status, eject).",
    acceptsArgs: true,
    handler: (ctx) => handleSlashCommand(ctx, api),
  });

  // Native host configuration is the only route owner.
  const route = readNativeRoute(api.config);

  // 4. Register runtime context injection (sandbox-awareness hook)
  const pluginConfig = getPluginConfig(api);
  try {
    registerRuntimeContext(api, pluginConfig);
  } catch (err) {
    api.logger.warn(
      `Could not register runtime context hook: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bannerEndpoint = route.endpoint;
  const bannerProvider = route.provider;
  const bannerModel = route.model;

  if (route.managedModel) api.registerProvider(registeredProviderForConfig(route));

  // 3. Enforce disabled search and block secrets in memory writes.
  // NOTE: This relies on OpenClaw's before_tool_call plugin hook contract
  // (PluginHookBeforeToolCallEvent/Result in openclaw/src/plugins/types.ts).
  // If the hook name or return shape changes in a future OpenClaw release,
  // the try/catch ensures the plugin still loads — the scanner just becomes
  // a no-op. Verify after OpenClaw upgrades that blocked writes still show
  // the expected error message.
  try {
    api.on(
      "before_tool_call",
      (...args: readonly PluginValue[]): BeforeToolCallResult | undefined => {
        const event = readBeforeToolCallEvent(args[0]);
        if (!event?.toolName || !event.params) return undefined;

        const runId = searchTurnKey(args);
        if (
          blocksDisabledSearch(
            api.config,
            { toolName: event.toolName, params: event.params, runId },
            deniedSearchRuns,
          )
        ) {
          return {
            block: true,
            blockReason:
              "Web search is unavailable in this sandbox. Do not discover search providers, retry search, or probe web pages, local files, memory, or shell output as substitutes. " +
              "Tell the user search is unavailable. Do not claim to have searched or present unverified installation documentation; return installationDocumentation as null when requested.",
          };
        }

        const toolName = event.toolName.toLowerCase();
        if (!WRITE_TOOL_NAMES.has(toolName)) return undefined;

        const rawPath = event.params["file_path"] ?? event.params["path"];
        if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
        // Resolve symlinks and traversal before checking — prevents bypasses like
        // /sandbox/project/../../.openclaw/memory/secrets.md. The host's
        // resolver may be missing or return undefined under embedded-fallback
        // runtimes, so route through safeResolvePath which falls back to the
        // raw path rather than crashing the hook. isMemoryPath knows how to
        // classify both absolute resolved paths and canonical memory
        // basenames written through a relative path.
        const filePath = safeResolvePath(api, rawPath);
        if (!isMemoryPath(filePath)) return undefined;

        const content =
          event.params["content"] ?? event.params["new_string"] ?? event.params["patch"];
        if (typeof content !== "string" || content.length === 0) return undefined;

        const matches = scanForSecrets(content);
        if (matches.length === 0) return undefined;

        const summary = matches.map((m) => `  - ${m.pattern} (${m.redacted})`).join("\n");
        api.logger.warn(`[SECURITY] Blocked memory write to ${filePath} — secrets detected`);

        return {
          block: true,
          blockReason:
            `Memory write blocked: detected ${String(matches.length)} likely secret(s):\n${summary}\n\n` +
            "Remove secrets before saving to persistent memory. " +
            "Use environment variables or credential stores instead.",
        };
      },
    );
    api.on("agent_end", (...args: readonly PluginValue[]): undefined => {
      // Lifecycle context may carry more identity than an older tool envelope.
      // Clear matching session fallback state without changing unidentified policy.
      for (const key of ["runId", "sessionKey", "sessionId"]) {
        const value = readStringProperty(args[1], key) ?? readStringProperty(args[0], key);
        if (value?.trim()) deniedSearchRuns.delete(`${key}:${value}`);
      }
      return undefined;
    });
  } catch (err) {
    api.logger.warn(
      `[SECURITY] Could not register tool safety hooks: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bannerLines = [
    "  NemoClaw registered",
    null,
    `  Endpoint:  ${bannerEndpoint}`,
    `  Provider:  ${bannerProvider}`,
    `  Model:     ${bannerModel}`,
    "  Slash:     /nemoclaw",
  ];

  process.stderr.write("\n");
  for (const line of renderBox(bannerLines)) {
    process.stderr.write(`[gateway] ${line}\n`);
  }
  process.stderr.write("\n");
}
