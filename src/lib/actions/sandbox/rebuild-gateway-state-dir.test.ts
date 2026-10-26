// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { writeSdkTlsFiles } from "../../../../test/helpers/openshell-sdk-tls";
import { ensureManagedGatewayStateRoot } from "../../onboard/gateway/state-dir";

const roots: string[] = [];

function unmarkedStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.homedir(), ".nemoclaw-rebuild-state-dir-"));
  roots.push(stateDir);
  fs.chmodSync(stateDir, 0o700);
  return stateDir;
}

function markedStateDirWithoutTls(): string {
  const stateDir = unmarkedStateDir();
  ensureManagedGatewayStateRoot({ gatewayName: "nemoclaw", gatewayPort: 8080, stateDir });
  return stateDir;
}

function sandboxGatewayStateDir(): string {
  const stateDir = markedStateDirWithoutTls();
  writeSdkTlsFiles(stateDir);
  return stateDir;
}

function sandboxGatewayStateDirWithMalformedKey(): string {
  const stateDir = sandboxGatewayStateDir();
  fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.key"), "not a key\n", { mode: 0o600 });
  return stateDir;
}

function replaceCertificateWithInvalidDates(
  stateDir: string,
  certificate: "CA" | "client",
  validity: "expired" | "future",
): void {
  const tlsDir = path.join(stateDir, "tls");
  const signingDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-invalid-cert-"));
  try {
    const key = path.join(tlsDir, "client", "tls.key");
    const csr = path.join(signingDir, "cert.csr");
    execFileSync(
      "openssl",
      ["req", "-new", "-key", key, "-subj", "/CN=nemoclaw-test", "-out", csr],
      { stdio: "ignore" },
    );
    fs.writeFileSync(path.join(signingDir, "index.txt"), "");
    fs.writeFileSync(path.join(signingDir, "serial"), "01\n");
    const config = path.join(signingDir, "openssl.cnf");
    fs.writeFileSync(
      config,
      [
        "[ ca ]",
        "default_ca = CA_default",
        "[ CA_default ]",
        `database = ${path.join(signingDir, "index.txt")}`,
        `serial = ${path.join(signingDir, "serial")}`,
        `new_certs_dir = ${signingDir}`,
        `private_key = ${key}`,
        `certificate = ${path.join(signingDir, "unused.pem")}`,
        "default_md = sha256",
        "policy = policy_any",
        "[ policy_any ]",
        "commonName = supplied",
      ].join("\n"),
    );
    execFileSync(
      "openssl",
      [
        "ca",
        "-selfsign",
        "-batch",
        "-config",
        config,
        "-in",
        csr,
        "-keyfile",
        key,
        "-startdate",
        validity === "expired" ? "20200101000000Z" : "20990101000000Z",
        "-enddate",
        validity === "expired" ? "20200102000000Z" : "20990102000000Z",
        "-out",
        path.join(tlsDir, certificate === "CA" ? "ca.crt" : "client/tls.crt"),
      ],
      { stdio: "ignore" },
    );
  } finally {
    fs.rmSync(signingDir, { recursive: true, force: true });
  }
}

describe("rebuild gateway state directory preflight (#13330)", () => {
  installRebuildFlowTestHooks();
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  it("stops before backup or delete when the SDK rejects the configured state directory", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = unmarkedStateDir();
    try {
      const harness = createRebuildFlowHarness();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow(/Configured OpenShell gateway state directory is unusable/u);

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("Unsafe OpenShell gateway state directory");
      expect(errors).toContain("sandbox is untouched");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("continues when the configured state directory belongs to the sandbox gateway", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = sandboxGatewayStateDir();
    try {
      const harness = createRebuildFlowHarness();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.onboardSpy).toHaveBeenCalledOnce();
    } finally {
      restoreEnv();
    }
  });

  it("stops before backup or delete when the state directory lacks the SDK TLS files", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = markedStateDirWithoutTls();
    try {
      const harness = createRebuildFlowHarness();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow(/Configured OpenShell gateway state directory is unusable/u);

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("gateway TLS credentials");
      expect(errors).toContain("or unset it");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("stops before backup or delete when the SDK TLS key is malformed", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = sandboxGatewayStateDirWithMalformedKey();
    try {
      const harness = createRebuildFlowHarness();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow(/Configured OpenShell gateway state directory is unusable/u);

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("gateway TLS credentials");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it.each([
    ["CA", "expired"],
    ["CA", "future"],
    ["client", "expired"],
    ["client", "future"],
  ] as const)(
    "stops before backup or delete when the %s certificate is %s",
    async (certificate, validity) => {
      const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
      const stateDir = sandboxGatewayStateDir();
      replaceCertificateWithInvalidDates(stateDir, certificate, validity);
      process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = stateDir;
      try {
        const harness = createRebuildFlowHarness();

        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).rejects.toThrow(/Configured OpenShell gateway state directory is unusable/u);

        const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(errors).toContain(`Gateway ${certificate} certificate is expired or not yet valid`);
        expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
        expect(harness.onboardSpy).not.toHaveBeenCalled();
      } finally {
        restoreEnv();
      }
    },
  );

  it("does not suggest unsetting the override when the recorded state directory is unusable", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR"]);
    delete process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { openshellGatewayStateDir: unmarkedStateDir() },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow(/Configured OpenShell gateway state directory is unusable/u);

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("recorded for the sandbox");
      expect(errors).not.toContain("or unset it");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });
});
