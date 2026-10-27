<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pi Evidence

Use the [shared report contract](session-report.md). Pi's [skills documentation](https://pi.dev/docs/latest/skills) distinguishes the startup catalog, model reads, and explicit `/skill:name` loading. Count full instructions visible in retained messages or successful complete read results; the catalog alone does not count.

Prefer the documented [SessionManager interface and session format](https://pi.dev/docs/latest/session-format) when available. Sessions use versioned JSONL trees; inspect the header version and select the active branch with its ancestry. The documented default location is `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`. Resolve the current session only; do not scan unrelated conversations.

Inspect message/tool records, timestamps, model changes, thinking-level changes, and compaction entries along that branch. Exclude abandoned sibling branches and do not equate a branch summary with compaction. Retain ordered setting changes, including returns to earlier values. If the active leaf, inherited context, or earlier history cannot be established, report the resulting coverage limit.

Older versions and retained exports may omit evidence present in current documentation. No installed extension or native metric is assumed to provide a complete ledger. Do not build an extension or parser to fill gaps; partial and unavailable remain valid outcomes.
