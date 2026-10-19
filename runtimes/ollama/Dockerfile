# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
FROM ollama/ollama@sha256:265409e1d931028a8f7d5a32bcbafddd7bffbc6cc629d77efe9560adf692a5e7
COPY nemoclaw-runtime /usr/local/bin/nemoclaw-runtime
# Readiness probes run the runtime under this name; see docs/provider.md.
RUN ln -s nemoclaw-runtime /usr/local/bin/nemoclaw-runtime-ready
COPY supervisor-source.tar.gz supervisor.json LICENSE /opt/nemoclaw/source/
COPY NOTICE.md /opt/nemoclaw/source/NOTICE.md
COPY ollama-LICENSE /opt/nemoclaw/source/ollama-LICENSE
COPY Dockerfile build.json /opt/nemoclaw/source/
ENTRYPOINT ["/usr/local/bin/nemoclaw-runtime"]
CMD []
LABEL org.nemoclaw.backend="ollama"
