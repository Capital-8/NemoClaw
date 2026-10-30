// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

vi.mock("./blueprint/state.js", () => ({
  loadState: () => ({ sandboxName: null }),
}));

import { registerRuntimeContext, suppliedSearchSources } from "./runtime-context.js";

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

type MockOpenClawPluginApi = OpenClawPluginApi & {
  _trigger: (name: string, ...args: readonly unknown[]) => Promise<unknown>;
};

function createMockApi(): MockOpenClawPluginApi {
  const hooks = new Map<string, (...args: readonly unknown[]) => unknown>();
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn((name, handler) => {
      hooks.set(name, handler as (...args: readonly unknown[]) => unknown);
    }),
    _trigger: async (name: string, ...args: readonly unknown[]) => hooks.get(name)?.(...args),
  } as MockOpenClawPluginApi;
}

describe("local file discovery with disabled web search", () => {
  it.each([
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
    "Find all * files.",
    "Find *",
    "Find **/*",
    "Find all **/*.{ts,tsx} files.",
    "Find all [ab]*.ts files.",
    "Find all .ts files.",
    "Find all JavaScript files.",
    "Find all Python files.",
    "Find all Rust files.",
    "Find all Go files.",
    "Find all C++ files.",
    "Find all C# files.",
    "Find all CSV files.",
    "Find all JSON files.",
    "Find all Markdown files.",
    "Find all TypeScript source files.",
    "Find all Jupyter notebook files.",
    "Find all custom-format files.",
    "Find TypeScript files.",
    "Locate any TypeScript files recursively, please.",
    "Look for all *.tsx files and return their file paths.",
    "Find files ending in .ts.",
    "Find files of type TypeScript.",
    "Find files with extension .ts.",
  ])("retains tools for local glob and file-type discovery: %s", async (prompt) => {
    const api = createMockApi();
    api.config = { tools: { web: { search: { enabled: false } } } };
    registerRuntimeContext(api, defaultConfig);
    expect(await api._trigger("before_prompt_build", { prompt }, {})).not.toHaveProperty(
      "toolsAllow",
    );
  });

  it.each([
    "Find all *.ts files online.",
    "Find all TypeScript files using Tavily.",
    "Search the web for TypeScript files.",
    "Find all TypeScript files from GitHub.",
    "Find all *.ts files on GitHub.",
    "Find all *.ts files, then provide today's weather in Paris.",
    "Find all TypeScript files and search the web for solutions.",
    "Find documentation about *.ts files.",
    "Find best practices for TypeScript files.",
    "Find the latest news about TypeScript files.",
    "Find official documentation for TypeScript files.",
    "Research the current weather in Paris.",
  ])("rejects external research around file discovery: %s", async (prompt) => {
    const api = createMockApi();
    api.config = { tools: { web: { search: { enabled: false } } } };
    registerRuntimeContext(api, defaultConfig);
    expect(await api._trigger("before_prompt_build", { prompt }, {})).toHaveProperty(
      "toolsAllow",
      [],
    );
    expect(suppliedSearchSources(prompt)).toBeUndefined();
  });
});
