// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, it } from "vitest";

import { buildProxyServer } from "../../../scripts/ollama-auth-proxy.mts";

it("counts only completed authenticated chat requests at the Ollama proxy", async () => {
  const backend = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(request.headers["x-test-fail"] === "1" ? 500 : 200);
      response.end("model response");
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.address() as AddressInfo;
  const token = "test-proxy-token";
  const proxy = buildProxyServer(token, new URL(`http://127.0.0.1:${backendAddress.port}`));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address() as AddressInfo;
  const url = `http://127.0.0.1:${proxyAddress.port}`;
  const authorization = `Bearer ${token}`;
  const receipt = async () => {
    const response = await fetch(`${url}/_nemoclaw/proxy-config`, {
      headers: { authorization },
    });
    return response.json() as Promise<{ completedRequests: number }>;
  };
  const request = (auth = authorization, failed = false) =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: auth,
        ...(failed ? { "x-test-fail": "1" } : {}),
      },
      body: JSON.stringify({ model: "local-model", messages: [] }),
    });
  try {
    expect((await receipt()).completedRequests).toBe(0);
    expect((await request("Bearer wrong")).status).toBe(401);
    expect((await request(authorization, true)).status).toBe(500);
    expect((await receipt()).completedRequests).toBe(0);
    const accepted = await request();
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("model response");
    expect((await receipt()).completedRequests).toBe(1);
  } finally {
    proxy.closeIdleConnections();
    backend.closeIdleConnections();
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
});
