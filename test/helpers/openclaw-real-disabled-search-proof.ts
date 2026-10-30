// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "./openclaw-env-fixture";
import { SEARCH_DENIAL_IDENTITY_LIMIT } from "../../nemoclaw/src/denied-search-state.js";
import register, { type OpenClawPluginApi } from "../../nemoclaw/src/index.js";

type ToolResult = { details?: { status?: string }; content: { text: string }[] };
type ToolContext = { runId?: string; sessionKey?: string };
type Hook = Parameters<OpenClawPluginApi["on"]>[1];
type Registry = {
  plugins: unknown[];
  hooks: unknown[];
  trustedToolPolicies: unknown[];
  typedHooks: { pluginId: string; hookName: string; handler: Hook }[];
};

/** Exercise the pinned caller and hook runner, without inference or real tool effects. */
export async function runRealOpenClawDisabledSearchProof(options: { dist: string }): Promise<void> {
  const dist = options.dist;
  const runtime = JSON.parse(fs.readFileSync(path.join(dist, "../package.json"), "utf8"));
  const plugin = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../../nemoclaw/package.json"), "utf8"),
  );
  assert.deepEqual(
    plugin.openclaw.compat,
    {
      pluginApi: `>=${runtime.version}`,
      minGatewayVersion: runtime.version,
    },
    "the real-runtime proof must exercise the advertised compatibility minimum",
  );
  const root = fs.mkdtempSync(path.join(path.dirname(dist), ".disabled-search-proof-"));
  const previousState = process.env.OPENCLAW_STATE_DIR;
  const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
  try {
    async function load(prefix: string, name: string): Promise<unknown> {
      const file = fs
        .readdirSync(dist)
        .find((file) => file.startsWith(prefix) && file.endsWith(".js"));
      assert(file, "pinned runtime module exists: " + prefix);
      const exports = (await import(
        /* @vite-ignore */ pathToFileURL(path.join(dist, file)).href
      )) as Record<string, unknown>;
      const value = Object.values(exports).find(
        (value) => typeof value === "function" && value.name === name,
      );
      assert.equal(typeof value, "function", "pinned export exists: " + name);
      return value;
    }
    const conversationAccessAllowed = (await load(
      "hook-policy-decisions-",
      "resolveConversationAccessAllowed",
    )) as (origin: string, policy: unknown) => boolean;
    const generated = buildConfig({ ...baseOpenClawGenerationEnv(), HOME: root }) as {
      plugins: { entries: { nemoclaw: { hooks?: object } } };
    };
    assert.equal(
      conversationAccessAllowed("config", generated.plugins.entries.nemoclaw.hooks),
      true,
      "the pinned loader must admit the generated NemoClaw prompt, admission and completion hooks",
    );
    const initialize = (await load("hook-runner-global-", "initializeGlobalHookRunner")) as (
      registry: Registry,
    ) => void;
    const runner = (await load("hook-runner-global-", "getGlobalHookRunner")) as () => {
      runBeforeAgentRun(
        event: { prompt: string; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<{ decision?: { outcome: string } } | undefined>;
      runBeforePromptBuild(
        event: { prompt: string; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<{ toolsAllow?: string[] }>;
      runGatewayStop(event: object, ctx: object): Promise<void>;
      runAgentEnd(
        event: { success: boolean; messages: unknown[] },
        ctx: ToolContext,
      ): Promise<void>;
    };
    const reset = (await load("hook-runner-global-", "resetGlobalHookRunner")) as () => void;
    type Tool = {
      name: string;
      description: string;
      parameters: object;
      execute: (id: string, params: object) => Promise<ToolResult>;
    };
    const wrap = (await load(
      "agent-tools.before-tool-call-",
      "wrapToolWithBeforeToolCallHook",
    )) as (
      tool: Tool,
      ctx: ToolContext & { config: OpenClawPluginApi["config"] },
      options: { emitDiagnostics: boolean },
    ) => Tool;
    const applyToolAllowlist = (await load(
      "attempt-tool-construction-plan-",
      "applyEmbeddedAttemptToolsAllow",
    )) as (tools: { name: string }[], toolsAllow?: string[]) => { name: string }[];
    const promptToolPolicy = (await load(
      "tool-surface-plan-",
      "createAgentHarnessPromptToolPolicy",
    )) as (params: { tools: { name: string }[] }) => {
      apply(input: { toolsAllow?: string[] }): {
        tools: { name: string }[];
        callableToolNames: string[];
      };
    };
    const registry: Registry = { plugins: [], hooks: [], typedHooks: [], trustedToolPolicies: [] };
    const config = { tools: { web: { search: { enabled: false } } } };
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    register({
      id: "nemoclaw",
      name: "NemoClaw",
      config,
      logger,
      registerCommand() {},
      registerProvider() {},
      registerService() {},
      resolvePath: (value) => value,
      on(hookName, handler) {
        registry.typedHooks.push({ pluginId: "nemoclaw", hookName, handler });
      },
    });
    initialize(registry);
    try {
      const availableTools = [
        "tool_search",
        "tool_call",
        "read",
        "exec",
        "memory_search",
        "web_fetch",
      ].map((name) => ({ name }));
      const publicFetchPrompts = [
        "Use the web_fetch tool to fetch exactly this URL:\nhttps://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json\nIf web_fetch is not a directly callable tool, invoke it through tool_call with id openclaw:core:web_fetch and the URL in args.url.\nYou may use tool_search and tool_describe only to discover web_fetch. Do not call an unexposed tool directly.\nAfter web_fetch returns, reply exactly REFERENCE_AGENT_OK if the fetched response says entity Q30 has the English label United States. Do not fetch any other URL.",
        "Use web_fetch to fetch exactly this public HTTPS URL:\nhttps://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json\nIf progressive tool disclosure is active, you may use tool_search, tool_describe, and tool_call only to discover and invoke web_fetch.\nDo not invoke any other target tool. Do not use web_search, Brave Search, or Tavily Search.\nSet web_fetch maxChars to no more than 8000.\nAfter web_fetch returns, reply exactly PERSONAL_PUBLIC_FETCH_OK if the fetched response says entity Q30 has the English label United States. Do not fetch any other URL.",
      ];
      const searchPrompt =
        "Use Tavily to search for the official NVIDIA NemoClaw installation documentation. Return the page title and URL.";
      for (const prompt of [
        searchPrompt,
        "Search file formats for best practices.",
        "Search Dockerfile.base best practices.",
        "Search README.md templates for ideas.",
        "Search for NemoClaw documentation.",
        "Find all *.ts files online.",
        "Find all TypeScript files using Tavily.",
        "Search the web for TypeScript files.",
        "Find all TypeScript files from GitHub.",
        "Find all *.ts files on GitHub.",
        "Find all *.ts files, then provide today's weather in Paris.",
        "Find all TypeScript files and search the web for solutions.",
        "Find documentation about *.ts files.",
        "Read the current contents of README.md, then provide today's weather in Paris.",
        "Explain the latest changes to src/index.ts using Tavily.",
        "Read the current contents of README.md online.",
        "Explain the latest changes to src/index.ts and search the web for alternatives.",
        "Provide today's weather in Paris.",
        "Give me today's weather in Paris.",
        "Show today's weather in Paris.",
        "Tell me today's weather in Paris.",
        "Please report current flight delays.",
        "List today's stock prices.",
        "Return the current exchange rate.",
        "Output today's election results.",
        "Summarize today's public health guidance.",
        "Get current travel restrictions for Japan.",
        "Retrieve the latest court ruling.",
        "Read today's market headlines.",
        "I need today's weather in Paris.",
        "I want the current exchange rate.",
        "Describe today's election results.",
        "Explain the latest tax rules.",
        "Present the current travel restrictions.",
        "Identify the current president of France.",
        "Read README.md, then provide today's weather in Paris.",
        "Read README.md, tell me today's weather in Paris.",
        "Find unused imports and list today's stock prices.",
        "What is the current weather in Paris?",
        "What are today's stock prices?",
        "Who is the current president of France?",
        "Where are the latest flight delays?",
        "Which airlines have availability today?",
        "How much does gold cost now?",
        "When is the next live broadcast today?",
        "Who won the election today?",
        "What are the current travel restrictions for Japan?",
        "What is the latest court ruling?",
        "What is the latest Node.js release version?",
        "What are the current travel restrictions for Japan during a build failure?",
        "What is the current git branch and who won the election today?",
        "Research the current Apple stock price.",
        "Look up today’s weather.",
        "Find the current population of Canada.",
        "Find the current process ID using Tavily.",
        "Find the current process ID and research the web for alternatives.",
        "Investigate why npm install fails using Brave.",
        "Research documentation about npm install failures.",
        "Investigate why npm install fails, then search the web for solutions.",
        "Search the latest Linux documentation for the current directory.",
        "Search for official documentation about local files.",
        "Search for best practices in code review.",
        "Find where this function is called on the web.",
        "Find the unit test that covers handleRequest using Tavily.",
        "Find all callers of handleRequest and search the web for alternatives.",
        "Find where handleRequest is called and then research online for a solution.",
        "Find all callers of handleRequest, then use Tavily for alternative implementations.",
        "Find all callers of handleRequest and update them using Brave.",
        "Find all callers of handleRequest and update them from the web.",
        "Find all callers of handleRequest and update them from online documentation.",
        "Find and refactor official installation documentation.",
        "Find unused imports using Tavily.",
        "Search for TODO comments. Then search the web for solutions.",
        "Find and fix the bug. Then find official installation documentation.",
        "Find unused imports recursively using Tavily, please.",
        "Search for TODO comments please. Then search the web for solutions, please.",
        "Find all callers of handleRequest recursively. Then find official installation documentation please.",
        "Find callers of first recursively using Tavily, please.",
        "Search for the latest news in project management.",
        "Google the official NemoClaw installation documentation.",
        "Look up the official NemoClaw installation documentation.",
        "Find the official NemoClaw installation documentation.",
        "Find all files containing foo, then search the web for solutions.",
        "Where is the official NemoClaw installation documentation?",
        "I want the official NemoClaw installation documentation.",
        "Official NemoClaw installation documentation, please.",
        "Get the latest NemoClaw release notes.",
        "Read /sandbox/README.md, then Google the official installation documentation.",
        "Fetch https://docs.nvidia.com/nemoclaw/ and find alternative installation guides.",
        "Find the official NemoClaw installation documentation online.",
        "Research online for the official NemoClaw installation documentation",
        "Browse the internet for the official NemoClaw installation documentation.",
        "Could you browse online for the NemoClaw installation documentation?",
        "Look for the official NemoClaw installation documentation on the web.",
      ]) {
        const searchTurn = await runner().runBeforePromptBuild(
          { prompt, messages: [] },
          { runId: "search-prompt" },
        );
        assert.deepEqual(
          searchTurn.toolsAllow,
          [],
          "source plugin narrows the real prompt hook result",
        );
        const submitted = promptToolPolicy({ tools: availableTools }).apply(searchTurn);
        assert.deepEqual(submitted.tools, [], "real prompt policy submits no tools");
        assert.deepEqual(submitted.callableToolNames, [], "discovery controls are not callable");
        assert.deepEqual(
          applyToolAllowlist(availableTools, searchTurn.toolsAllow),
          [],
          "real runtime submits no discovery or substitute tools",
        );
      }
      for (const prompt of [
        ...publicFetchPrompts,
        "Read /sandbox/README.md.",
        "Search Dockerfile for the base image",
        "Search Containerfile for the base image.",
        "Find the target in Makefile.",
        "Search .gitignore for ignored paths.",
        "Search scripts/start for the startup command.",
        "Search src/ for TODO comments.",
        "Search the file LICENSE for distribution terms.",
        "Search `NOTICE` for attribution.",
        "Find all Visual Basic files.",
        "Find all Objective C source files.",
        "Find all Structured Query Language files.",
        "Find all TypeScript and JavaScript files.",
        'Find all "* copy.ts" files.',
        'Find "* copy.ts".',
        "Find all *.ts files.",
        "Find all TypeScript files.",
        "Find *.ts.",
        "Find **/*.ts.",
        "Find all src/**/*.ts files.",
        "Search for *.test.ts files.",
        "Find all `*.ts` files.",
        'Find all "*.ts" files.',
        "Find all JavaScript files.",
        "Find all Python files.",
        "Find all Rust files.",
        "Find all Go files.",
        "Find all C++ files.",
        "Read the current contents of README.md",
        "Explain the latest changes to src/index.ts",
        "Show me today's date.",
        "Give me the current git commit hash.",
        "Tell me the current branch name.",
        "List today's files.",
        "Show the latest TODO comments.",
        "Report the current uptime.",
        "Show me the current git branch.",
        "Tell me the current working directory.",
        "Provide the current Node version.",
        "List the current files.",
        "Report current CPU usage.",
        "Return the current process ID.",
        "Output the current git status.",
        "Summarize the latest test results.",
        "Explain the current configuration.",
        "Describe the current environment.",
        "I need the current git branch.",
        "I want the current process ID.",
        "Give me today's weather from README.md.",
        "Provide today's weather from https://example.org/weather.",
        "Show today's logs.",
        "Summarize today's code changes.",
        "Do not provide today's weather. Read README.md.",
        "What is the current working directory?",
        "What is the latest error in the logs?",
        "What is the current weather in README.md?",
        "What is the current price in https://example.com/prices?",
        "Who won the election today in README.md?",
        "What are the current travel restrictions for Japan in https://example.com/advisory?",
        "What's the current working directory?",
        "Search Dockerfile.base for the base image.",
        "What files are in the current directory?",
        "Research the cause of this build error.",
        "Explore the project layout.",
        "Search the current directory for the config file.",
        "Search the project for TODO comments.",
        "Find unused imports",
        "Search for TODO comments",
        "Find and fix the bug",
        "Search auth.test.ts for failing assertions.",
        "Search main.rs for TODO comments",
        "Find a file called config.json",
        "Find the function named parseConfig",
        "Search main.go for TODO comments",
        "Search data.csv for missing values",
        "Find all callers of handleRequest and return their file paths.",
        "Search for TODO comments and list the matching files.",
        "Find unused imports recursively.",
        "Search for TODO comments please.",
        "Find all callers of handleRequest recursively.",
        "Discover web_fetch please.",
        "Find callers of please.",
        "Find callers of first recursively.",
        "Search for TODO and FIXME comments.",
        "Find and fix lint warnings.",
        "Find and fix the bug in src/index.ts.",
        "Find and fix the bug in this function.",
        "Find where this function is called.",
        "Find the unit test that covers handleRequest.",
        "Find where handleRequest is defined.",
        "Locate where this method is invoked.",
        "Find all callers of handleRequest().",
        "Find all callers of `handleRequest()`.",
        "Find all callers of `Handler.handleRequest`().",
        "Find all callers of handleRequest.",
        "Find where handleRequest is called and fix the bug.",
        "Find all callers of handleRequest and update them.",
        "Find the unit test that covers handleRequest and repair it.",
        "Find where handleRequest is defined, then refactor it.",
        "Find all callers of handleRequest, and then update them.",
        "Find all callers of handleRequest, update them.",
        "Find and then refactor all callers of handleRequest.",
        "Browse the web, fetch https://www.wikidata.org/wiki/Q30.",
        "Browse the web, and fetch https://www.wikidata.org/wiki/Q30.",
        "Run exactly this shell command: curl https://wttr.in/:help.\nDo not use web_fetch, web_search, or any other weather provider.",
        "Find call sites for this function.",
        "Search for references to handleRequest.",
        "Look up the definition of handleRequest.",
        "Find usages of this variable.",
        "Find the implementation of function handleRequest.",
        "Locate integration tests exercising handleRequest.",
        "Find the existing unit test that exercises handleRequest.",
        "Find which function calls handleRequest.",
        "Find the function that calls handleRequest.",
        "Find which unit test covers handleRequest.",
        "Find unit tests for handleRequest.",
        "Find test coverage for handleRequest.",
        "Find this function's callers.",
        "Find the class that implements Handler.",
        "Find all files containing foo.",
        'Search for files containing "foo".',
        "Find files containing foo and return their file paths.",
        "Find the largest files on disk",
        "Investigate the disk usage",
        "Find the process using port 8080.",
        "Find which process is using port 8080",
        "Find all files larger than 100 MB",
        "Find the current process ID.",
        "Locate the PID of this shell.",
        "Investigate why npm install fails.",
        "Research the root cause of npm install failures.",
        "What is the current git branch?",
        "What is the latest commit?",
        "What is the current Node version?",
        "How do I fix the latest build failure?",
        "Which branch is current?",
        "What is the current git status?",
        "What is the current installed Node version?",
        "What is the latest error in our build server?",
        "Find the current git branch.",
        "Investigate why the unit tests are failing",
        "Investigate why unit tests are failing",
        "Find and fix the failing unit tests.",
        "Investigate why the integration tests fail.",
        "Search and read README.md.",
        "Search for logs and traces in this project.",
        "Search through the project files for TODO comments.",
        "Search the repository recursively for TODO comments.",
        "Search the project code for TODO comments.",
        "Read the latest documentation in docs/README.md.",
        "Search https://docs.nvidia.com/nemoclaw/ for installation instructions.",
      ]) {
        const localTurn = await runner().runBeforePromptBuild(
          { prompt, messages: [] },
          { runId: "local-prompt" },
        );
        assert.deepEqual(
          promptToolPolicy({ tools: availableTools }).apply(localTurn).tools,
          availableTools,
          "local requests keep tools in the real prompt policy",
        );
        assert.deepEqual(
          applyToolAllowlist(availableTools, localTurn.toolsAllow),
          availableTools,
          "the next local turn keeps its tools",
        );
      }
      const fetchTurn = await runner().runBeforePromptBuild(
        { prompt: "Fetch https://docs.nvidia.com/nemoclaw/ with web_fetch.", messages: [] },
        { runId: "fetch-prompt" },
      );
      assert.deepEqual(
        promptToolPolicy({ tools: availableTools }).apply(fetchTurn).tools,
        availableTools,
        "explicit URL retrieval keeps its tools in the real prompt policy",
      );
      config.tools.web.search.enabled = true;
      const enabledTurn = await runner().runBeforePromptBuild(
        { prompt: searchPrompt, messages: [] },
        { runId: "enabled-prompt" },
      );
      assert.deepEqual(
        applyToolAllowlist(availableTools, enabledTurn.toolsAllow),
        availableTools,
        "configuration recovery keeps search tools",
      );
      config.tools.web.search.enabled = false;
      let sideEffects = 0;
      async function call(
        name: string,
        ctx: ToolContext,
        id: string,
        params?: object,
      ): Promise<ToolResult> {
        const tool = wrap(
          {
            name,
            description: "controlled denial witness",
            parameters: {},
            async execute() {
              sideEffects++;
              return { content: [{ text: "executed" }] };
            },
          },
          { ...ctx, config },
          { emitDiagnostics: false },
        );
        return tool.execute(
          id,
          params ?? (name === "read" ? { file_path: "/sandbox/README.md" } : {}),
        );
      }
      function blocked(result: ToolResult): void {
        assert.equal(result.details?.status, "blocked");
        assert.match(result.content[0]!.text, /Web search is unavailable in this sandbox/u);
      }
      async function admit(ctx: ToolContext, prompt = "What time is it?"): Promise<void> {
        const result = await runner().runBeforeAgentRun({ prompt, messages: [] }, ctx);
        assert.notEqual(
          result?.decision?.outcome,
          "block",
          "real admission gate accepts owned turn",
        );
      }
      for (const prompt of [
        searchPrompt,
        "Find a file called config.json online.",
        "Find the function named parseConfig using Tavily.",
        "Search main.rs for TODO comments, then search the web for solutions.",
        "Search data.csv for missing values using Tavily.",
        "Search data.csv for missing values online.",
        "Read README.md, then search the web for installation documentation.",
        "Find all files containing foo, then search the web for solutions.",
        "Fetch https://example.com/docs and find alternative installation guides.",
      ]) {
        const context = { runId: "external-first-tool" };
        await admit(context, prompt);
        // Deliberately bypass prompt filtering to exercise the execution guard.
        blocked(await call("read", context, "first-read", { file_path: "README.md" }));
        blocked(await call("memory_search", context, "first-memory", { query: "installation" }));
        blocked(await call("exec", context, "first-exec", { command: "cat README.md" }));
        blocked(
          await call("web_fetch", context, "first-fetch", { url: "https://example.org/install" }),
        );
        blocked(
          await call("tool_call", context, "first-wrapped-read", {
            id: "openclaw:core:read",
            args: { file_path: "README.md" },
          }),
        );
        assert.equal(sideEffects, 0, "admission blocks substitute execution before any search");
        await runner().runAgentEnd({ success: false, messages: [] }, context);
      }
      await admit({ runId: "denied-run" });
      blocked(await call("web_search", { runId: "denied-run" }, "search-1"));
      blocked(await call("read", { runId: "denied-run" }, "read-1"));
      await admit({ runId: "provider-probe" });
      blocked(
        await call("web_fetch", { runId: "provider-probe" }, "provider-probe-1", {
          url: "https://api.tavily.com./search",
        }),
      );
      blocked(await call("read", { runId: "provider-probe" }, "provider-read-1"));
      assert.equal(sideEffects, 0, "real caller stops search and substitute execution");
      await admit({ runId: "other-run" });
      await call("read", { runId: "other-run" }, "read-2");
      assert.equal(sideEffects, 1, "ordinary identified work executes");
      await admit({ sessionKey: "compatible-session" });
      blocked(await call("web_search", { sessionKey: "compatible-session" }, "search-2"));
      blocked(await call("read", { sessionKey: "compatible-session" }, "read-3"));
      blocked(await call("web_search", {}, "search-3"));
      await runner().runAgentEnd({ success: true, messages: [] }, { runId: "other-run" });
      await runner().runAgentEnd({ success: true, messages: [] }, {});
      blocked(await call("read", {}, "read-4"));
      assert.equal(
        sideEffects,
        1,
        "lifecycle events never allow unidentified substitute execution",
      );
      config.tools.web.search.enabled = true;
      await call("web_search", {}, "search-4");
      assert.equal(sideEffects, 2, "enabled search still executes");
      await runner().runGatewayStop({}, {});
      config.tools.web.search.enabled = false;
      for (let index = 0; index < SEARCH_DENIAL_IDENTITY_LIMIT; index++) {
        await runner().runBeforePromptBuild(
          { prompt: "Read README.md.", messages: [] },
          { runId: `abandoned-${index}` },
        );
      }
      blocked(await call("web_search", { runId: "abandoned-0" }, "unadmitted-search"));
      for (let index = 0; index < SEARCH_DENIAL_IDENTITY_LIMIT; index++) {
        const context = { runId: `capacity-${index}`, sessionKey: `capacity-session-${index}` };
        await admit(context);
        blocked(await call("web_search", context, `capacity-search-${index}`));
      }
      const excess = await runner().runBeforeAgentRun(
        { prompt: "Read README.md.", messages: [] },
        { runId: "excess" },
      );
      assert.equal(
        excess?.decision?.outcome,
        "block",
        "real gate refuses excess turn before inference",
      );
      blocked(await call("read", { runId: "excess" }, "excess-read"));
      blocked(await call("read", { runId: "capacity-1" }, "denied-at-capacity"));
      assert.equal(
        sideEffects,
        2,
        "retained search denials block substitute execution at capacity",
      );
      for (let index = 0; index < SEARCH_DENIAL_IDENTITY_LIMIT; index++) {
        await runner().runAgentEnd(
          { success: true, messages: [] },
          { sessionKey: `capacity-session-${index}` },
        );
      }
      await admit({ runId: "recovered" });
      await call("read", { runId: "recovered" }, "recovered-read");
      assert.equal(
        sideEffects,
        3,
        "completion restores capacity without waiting for retention expiry",
      );
      for (const [prompt, tool, params] of [
        ...publicFetchPrompts.map(
          (prompt) =>
            [
              prompt,
              "web_fetch",
              {
                url: "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json",
              },
            ] as const,
        ),
        ["Search the project for TODO comments.", "read", { file_path: "/sandbox/README.md" }],
        ["Find unused imports", "read", { file_path: "src/index.ts" }],
        ["Search for TODO comments", "read", { file_path: "src/index.ts" }],
        ["Find and fix the bug", "read", { file_path: "src/index.ts" }],
        ["Search auth.test.ts for failing assertions.", "read", { file_path: "auth.test.ts" }],
        ["Search main.rs for TODO comments", "read", { file_path: "main.rs" }],
        ["Find a file called config.json", "read", { file_path: "config.json" }],
        ["Find the function named parseConfig", "read", { file_path: "src/config.ts" }],
        ["Search main.go for TODO comments", "read", { file_path: "main.go" }],
        ["Search data.csv for missing values", "read", { file_path: "data.csv" }],
        [
          "Find all callers of handleRequest and return their file paths.",
          "read",
          { file_path: "src/handler.ts" },
        ],
        [
          "Search for TODO comments and list the matching files.",
          "read",
          { file_path: "src/index.ts" },
        ],
        ["Find unused imports recursively.", "read", { file_path: "src/index.ts" }],
        ["Search for TODO comments please.", "read", { file_path: "src/index.ts" }],
        ["Find callers of first recursively.", "read", { file_path: "src/first.ts" }],
        ["Find all callers of handleRequest recursively.", "read", { file_path: "src/handler.ts" }],
        ["Find all callers of handleRequest().", "read", { file_path: "src/handler.ts" }],
        ["Find all callers of `handleRequest()`.", "read", { file_path: "src/handler.ts" }],
        ["Find all callers of `Handler.handleRequest`().", "read", { file_path: "src/handler.ts" }],
        ["Find where this function is called.", "read", { file_path: "src/handler.ts" }],
        [
          "Find where handleRequest is called and fix the bug.",
          "read",
          { file_path: "src/handler.ts" },
        ],
        [
          "Find all callers of handleRequest and update them.",
          "read",
          { file_path: "src/handler.ts" },
        ],
        [
          "Find the unit test that covers handleRequest and repair it.",
          "read",
          { file_path: "test/handler.test.ts" },
        ],
        [
          "Find the unit test that covers handleRequest.",
          "read",
          { file_path: "test/handler.test.ts" },
        ],
        ["Investigate why the unit tests are failing", "read", { file_path: "test/unit.test.ts" }],
        ["Investigate why unit tests are failing", "read", { file_path: "test/unit.test.ts" }],
        ["Find and fix the failing unit tests.", "read", { file_path: "test/unit.test.ts" }],
        [
          "Investigate why the integration tests fail.",
          "read",
          { file_path: "test/integration.test.ts" },
        ],
        [
          "Search the repository recursively for TODO comments.",
          "read",
          { file_path: "README.md" },
        ],
        ["Search the project code for TODO comments.", "read", { file_path: "src/index.ts" }],
        [
          "Read the latest documentation in docs/README.md.",
          "read",
          { file_path: "docs/README.md" },
        ],
        [
          "Search https://docs.nvidia.com/nemoclaw/ for installation instructions.",
          "web_fetch",
          { url: "https://docs.nvidia.com/nemoclaw/" },
        ],
      ] as const) {
        const context = { runId: "supplied-source" };
        await admit(context, prompt);
        await runner().runBeforePromptBuild({ prompt, messages: [] }, context);
        const before: number = sideEffects;
        blocked(await call("web_search", context, "supplied-search"));
        await call(tool, context, "supplied-read", params);
        assert.equal(sideEffects, before + 1, "supplied sources remain usable after denied search");
        const mixedPrompt = `${prompt} Then search the web for alternatives.`;
        await admit(context, mixedPrompt);
        await runner().runBeforePromptBuild({ prompt: mixedPrompt, messages: [] }, context);
        blocked(await call(tool, context, "mixed-read", params));
        assert.equal(sideEffects, before + 1, "mixed external research cannot use substitutes");
        await runner().runAgentEnd({ success: true, messages: [] }, context);
        await admit(context);
        blocked(await call("web_search", context, "reused-search"));
        blocked(await call(tool, context, "reused-read", params));
        await runner().runAgentEnd({ success: true, messages: [] }, context);
      }
      const suppliedUrlContext = { runId: "bounded-supplied-url" };
      await admit(suppliedUrlContext, "Fetch https://docs.nvidia.com/nemoclaw/.");
      const beforeSuppliedUrl: number = sideEffects;
      blocked(await call("web_search", suppliedUrlContext, "bounded-search"));
      blocked(
        await call("web_fetch", suppliedUrlContext, "unrelated-fetch", {
          url: "https://example.org/",
        }),
      );
      blocked(await call("read", suppliedUrlContext, "unrelated-local"));
      blocked(
        await call("memory_get", suppliedUrlContext, "unrelated-memory-excerpt", {
          path: "memory/installation.md",
        }),
      );
      blocked(
        await call("memory_search", suppliedUrlContext, "unrelated-memory", {
          query: "installation documentation",
        }),
      );
      blocked(
        await call("tool_call", suppliedUrlContext, "wrapped-unrelated", {
          id: "openclaw:core:web_fetch",
          args: { url: "https://example.org/" },
        }),
      );
      assert.equal(
        sideEffects,
        beforeSuppliedUrl,
        "unrelated sources never reach the real tool executor",
      );
      await call("web_fetch", suppliedUrlContext, "bounded-fetch", {
        url: "https://DOCS.nvidia.com:443/nemoclaw/#intro",
      });
      await call("tool_call", suppliedUrlContext, "wrapped-bounded-fetch", {
        id: "openclaw:core:web_fetch",
        args: { url: "https://docs.nvidia.com/nemoclaw/" },
      });
      assert.equal(
        sideEffects,
        beforeSuppliedUrl + 2,
        "only supplied retrieval targets reach the real tool executor",
      );
      await runner().runAgentEnd({ success: true, messages: [] }, suppliedUrlContext);
      const mixedContext = { runId: "mixed-supplied-sources" };
      const mixedPrompt = "Read README.md and fetch https://example.com/docs.";
      await admit(mixedContext, mixedPrompt);
      const mixedTurn = await runner().runBeforePromptBuild(
        { prompt: mixedPrompt, messages: [] },
        mixedContext,
      );
      assert.deepEqual(
        applyToolAllowlist(availableTools, mixedTurn.toolsAllow),
        availableTools,
        "mixed supplied sources retain the real prompt tools",
      );
      const beforeMixed: number = sideEffects;
      blocked(await call("web_search", mixedContext, "mixed-source-search"));
      await call("read", mixedContext, "mixed-local-read", { file_path: "README.md" });
      await call("web_fetch", mixedContext, "mixed-url-fetch", { url: "https://example.com/docs" });
      await call("tool_call", mixedContext, "mixed-wrapped-read", {
        id: "openclaw:core:read",
        args: { file_path: "README.md" },
      });
      await call("tool_call", mixedContext, "mixed-wrapped-fetch", {
        id: "openclaw:core:web_fetch",
        args: { url: "https://example.com/docs" },
      });
      assert.equal(
        sideEffects,
        beforeMixed + 4,
        "the real executor receives both supplied source kinds",
      );
      blocked(
        await call("web_fetch", mixedContext, "mixed-unrelated-url", {
          url: "https://example.com/other",
        }),
      );
      assert.equal(
        sideEffects,
        beforeMixed + 4,
        "an unrelated URL never reaches the real executor",
      );
      await runner().runAgentEnd({ success: true, messages: [] }, mixedContext);
      for (const [prompt, wrapped] of [
        ["Find and fix the bug in src/index.ts.", false],
        ["Find and fix the bug in src/index.ts.", true],
        ["Find all files containing foo.", false],
        ["Find all files containing foo.", true],
        ['Search for files containing "foo".', false],
        ['Search for files containing "foo".', true],
        ["Find the largest files on disk", false],
        ["Find the largest files on disk", true],
        ["Investigate the disk usage", false],
        ["Investigate the disk usage", true],
        ["Find the process using port 8080.", false],
        ["Find the process using port 8080.", true],
        ["Find which process is using port 8080", false],
        ["Find which process is using port 8080", true],
        ["Find all files larger than 100 MB", false],
        ["Find all files larger than 100 MB", true],
        ["What is the current git branch?", false],
        ["What is the current git branch?", true],
        ["What is the latest commit?", false],
        ["What is the latest commit?", true],
        ["What is the current Node version?", false],
        ["What is the current Node version?", true],
        ["How do I fix the latest build failure?", false],
        ["How do I fix the latest build failure?", true],
        ["Which branch is current?", false],
        ["Which branch is current?", true],
        ["Find the current process ID.", false],
        ["Find the current process ID.", true],
        ["Investigate why npm install fails.", false],
        ["Investigate why npm install fails.", true],
      ] as const) {
        const context = { runId: `local-discovery-${wrapped}` };
        await admit(context, prompt);
        const policy = await runner().runBeforePromptBuild({ prompt, messages: [] }, context);
        assert.deepEqual(
          promptToolPolicy({ tools: availableTools }).apply(policy).tools,
          availableTools,
          "local inspection requests retain tools through the real prompt policy",
        );
        const before: number = sideEffects;
        for (const [name, params] of [
          ["tool_search", { query: "search local project files" }],
          ["tool_describe", { id: "openclaw:core:exec" }],
          ["exec", { command: "rg TODO src/" }],
          ["tool_search", { query: "search memory" }],
          ["memory_search", { query: "TODO" }],
        ] as const) {
          const result = wrapped
            ? await call("tool_call", context, `local-${name}`, {
                id: `openclaw:core:${name}`,
                args: params,
              })
            : await call(name, context, `local-${name}`, params);
          assert.notEqual(result.details?.status, "blocked");
        }
        assert.equal(
          sideEffects,
          before + 5,
          "local discovery and execution reach the real executor",
        );
        blocked(await call("tool_search", context, "web-discovery", { query: "web search" }));
        blocked(await call("exec", context, "denied-substitute", { command: "rg TODO src/" }));
        assert.equal(sideEffects, before + 5, "web discovery still denies substitute execution");
        await runner().runAgentEnd({ success: true, messages: [] }, context);
      }
    } finally {
      try {
        await runner().runGatewayStop({}, {});
      } finally {
        reset();
      }
    }
  } finally {
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
