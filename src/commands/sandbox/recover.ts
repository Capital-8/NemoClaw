// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { recoverSandboxWithHermesCronRestore } from "../../lib/actions/sandbox/runtime/hermes-cron-restore-recovery";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class RecoverCliCommand extends NemoClawCommand {
  static id = "sandbox:recover";
  static strict = true;
  static summary = "Recover a stopped sandbox and verify its agent runtime";
  static description =
    "Start a stopped sandbox through OpenShell and verify its agent runtime without opening an SSH session. For OpenClaw and Hermes, probe gateway health and repair stopped gateways or host forwards. A healthy gateway is not restarted; use `gateway restart` when you need a forced runtime reload. For Hermes, also validate and release a NemoClaw cron restore gate left by an interrupted rebuild. For Deep Agents Code, which has no gateway or host forward, verify the sandbox inference route and run the terminal smoke checks.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox recover alpha"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(RecoverCliCommand);
    await recoverSandboxWithHermesCronRestore(args.sandboxName);
  }
}
