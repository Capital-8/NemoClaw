<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Image Source

Hermes Agent source is pinned to release [v0.22.4](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.4) (`4d04303818b61bf3aa09278af48356315515965b`) from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
Its dependencies come from that release's own `uv.lock`.
Its built dashboard (`hermes_cli/web_dist`) and TUI bundle (`hermes_cli/tui_dist`) come unmodified from the release's published image, [`nousresearch/hermes-agent:v0.22.4`](https://hub.docker.com/r/nousresearch/hermes-agent) (`sha256:7a69201726bc64db2072a1371557137c23312d29705cda2b8ea2a0214a50a4cf`), whose files shared with the release source match it, apart from the `README.md` its build empties.
Its upstream license and notices remain in `/opt/hermes` and the retained source archive.
NemoClaw installs the source and these builds unmodified.
