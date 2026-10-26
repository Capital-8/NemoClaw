// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Write placeholder mTLS files where the OpenShell SDK reads them in a gateway state directory. */
export function writeSdkTlsFiles(stateDir: string): void {
  const clientDir = path.join(stateDir, "tls", "client");
  fs.mkdirSync(clientDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "tls", "ca.crt"), "ca\n", { mode: 0o600 });
  fs.writeFileSync(path.join(clientDir, "tls.crt"), "cert\n", { mode: 0o600 });
  fs.writeFileSync(path.join(clientDir, "tls.key"), "key\n", { mode: 0o600 });
}
