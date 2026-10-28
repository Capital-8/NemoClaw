<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Codex Evidence

Use the [shared report contract](session-report.md). Codex's [skills documentation](https://developers.openai.com/codex/skills) distinguishes discovery metadata from full instructions loaded on selection. Neither catalog presence nor an agent's claim of skill use establishes a complete load.

Inspect the current session through an available session interface or its retained record. Local CLI builds have stored rollouts below `CODEX_HOME/sessions/YYYY/MM/DD/rollout-….jsonl`; that is an observed implementation detail, not a stable API or a guarantee for desktop/cloud versions. Resolve only this session's record using available session identity. If access or scope cannot be established, mark affected fields unavailable.

Read the record's version/context before interpreting it. Observed local records include session metadata, turn context, tool calls and results, and compaction entries. Use actual complete read results or full injected instructions for skills; use recorded model/effort changes for settings. A compacted summary or current model setting cannot establish the missing earlier history. Forked/inherited material needs explicit scope; do not count a parent's calls as this session's activity.

The documented [advanced configuration metrics](https://learn.chatgpt.com/docs/config-file/config-advanced), including `codex.skill.injected`, are not a guaranteed complete per-session ledger. Do not enable metrics or hooks for this report. Use partial or unavailable when the retained evidence cannot support a field.

For Instruction files, inspect retained instruction inputs and complete tool-read results for non-skill guidance such as `AGENTS.md` and `WRITING.md`. A configured path or an automatically discovered file does not establish that its full contents were retained. If startup instructions are omitted from the record, report confirmed reads as partial; use unavailable if none can be established. Keep parent-session evidence outside this session's report unless inherited full contents are explicitly retained and attributable.
