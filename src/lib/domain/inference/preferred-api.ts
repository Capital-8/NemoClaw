// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// `completions` is the documented spelling (#13884); `chat-completions` is the older alias.
const CHAT_COMPLETIONS_PREFERENCES = new Set([
  "openai-completions",
  "chat-completions",
  "completions",
]);

/** Whether a NEMOCLAW_PREFERRED_API value selects the Chat Completions API. */
export function isChatCompletionsPreference(preferredApi?: string): boolean {
  return CHAT_COMPLETIONS_PREFERENCES.has((preferredApi || "").trim().toLowerCase());
}
