// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Lines of the onboarding completion "Manage later" block. */
export function manageLaterLines(
  cliName: string,
  sandboxName: string,
  modelCommand: string,
): string[] {
  return [
    "",
    "  Manage later",
    "",
    `    Status:      ${cliName} ${sandboxName} status`,
    `    Logs:        ${cliName} ${sandboxName} logs --follow`,
    `    Model:       ${modelCommand}`,
    `    Policies:    ${cliName} ${sandboxName} policy add`,
    `    Credentials: ${cliName} credentials reset <PROVIDER> && ${cliName} onboard`,
  ];
}
