// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "./shell-probe.ts";

const MCP_CURL_HTTP_CODE_MARKER = "NEMOCLAW_MCP_CURL_HTTP_CODE=";
export const INFERENCE_CURL_HTTP_CODE_MARKER = "NEMOCLAW_INFERENCE_CURL_HTTP_CODE=";

/** Keep connect errors while withholding verbose outgoing headers from artifacts. */
export const INFERENCE_CURL_DIAGNOSTIC_SCRIPT = `curl() (
  probe_stderr=$(mktemp) || exit 2
  trap 'rm -f "$probe_stderr"' EXIT
  LC_ALL=C command curl --verbose --write-out '\n${INFERENCE_CURL_HTTP_CODE_MARKER}%{http_code}\n' "$@" 2>"$probe_stderr"
  probe_status=$?
  sed -n '/^\\* Immediate connect fail for /p; /^\\* connect to .* failed: /p; /^curl: /p' "$probe_stderr" >&2
  exit "$probe_status"
)`;

/**
 * Require a policy response or curl's explicit connect permission error.
 * Exit 7 alone also represents refused connections and is not denial evidence.
 */
export function isExpectedMcpCurlPolicyDenial(
  result: Pick<ShellProbeResult, "exitCode" | "stderr" | "stdout" | "timedOut">,
  httpCodeMarker = MCP_CURL_HTTP_CODE_MARKER,
  connectDeniedHttpCode: "000" | "302" = "000",
): boolean {
  if (result.timedOut) return false;

  const records = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(httpCodeMarker));
  if (records.length !== 1) return false;
  const httpCode = records[0]?.slice(httpCodeMarker.length);
  if (result.exitCode === 0) {
    return httpCode === "403" && /policy[_ ]denied|not allowed by any policy/iu.test(result.stdout);
  }
  // A followed redirect retains its last response code when the next connect is denied.
  if (result.exitCode === 7 && httpCode === connectDeniedHttpCode) {
    // curl 8.14.1 cf-socket.c reports connect(2)'s errno here. Require every
    // attempted address to fail with EACCES, not a mixed transport failure.
    const failures = result.stderr
      .split(/\r?\n/u)
      .filter(
        (line) =>
          line.startsWith("* Immediate connect fail for ") ||
          (line.startsWith("* connect to ") && line.includes(" failed: ")),
      );
    return (
      failures.length > 0 &&
      failures.every((line) =>
        /^\* Immediate connect fail for [0-9a-f:.]+: Permission denied$/iu.test(line),
      )
    );
  }

  return (
    result.exitCode === 56 &&
    /curl:\s*\(56\)\s*CONNECT tunnel failed,\s*response 403/i.test(result.stderr)
  );
}
