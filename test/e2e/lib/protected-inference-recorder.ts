// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const RECEIPT_PATH = "/_nemoclaw/e2e-inference-receipt";

export interface ProtectedInferenceRecorder {
  readonly port: number;
  readonly token: string;
  readonly completedRequests: number;
  close(): Promise<void>;
}

function requestModel(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overLimit = false;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_REQUEST_BYTES) chunks.push(chunk);
      else overLimit = true;
    });
    request.on("end", () => {
      if (overLimit) return resolve(null);
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(
          body && typeof body === "object" && "model" in body && typeof body.model === "string"
            ? body.model
            : null,
        );
      } catch {
        resolve(null);
      }
    });
    request.on("aborted", () => resolve(null));
    request.on("error", () => resolve(null));
  });
}

function authorizedToken(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authorizedReceipt(request: IncomingMessage, token: string): boolean {
  const address = request.socket.remoteAddress;
  return (
    (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") &&
    authorizedToken(request, token)
  );
}

export async function startProtectedInferenceRecorder(options: {
  readonly bindHost: string;
  readonly port: number;
  readonly backendPort: number;
  readonly model: string;
}): Promise<ProtectedInferenceRecorder> {
  const token = randomBytes(24).toString("hex");
  let completedRequests = 0;
  const server = http.createServer(
    async (clientRequest: IncomingMessage, clientResponse: ServerResponse) => {
      if (clientRequest.url === RECEIPT_PATH) {
        if (clientRequest.method !== "GET" || !authorizedReceipt(clientRequest, token)) {
          clientResponse.writeHead(403).end();
          return;
        }
        clientResponse.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        clientResponse.end(JSON.stringify({ completedRequests }));
        return;
      }

      if (!authorizedToken(clientRequest, token)) {
        clientResponse.writeHead(401).end();
        return;
      }

      const modelPromise = requestModel(clientRequest);
      const headers = { ...clientRequest.headers, host: `127.0.0.1:${options.backendPort}` };
      const upstream = http.request({
        hostname: "127.0.0.1",
        port: options.backendPort,
        path: clientRequest.url,
        method: clientRequest.method,
        headers,
      });
      const fail = () => {
        if (clientResponse.writableEnded) return;
        if (clientResponse.headersSent) clientResponse.destroy();
        else clientResponse.writeHead(502).end();
      };
      upstream.on("response", (response) => {
        const success = (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300;
        clientResponse.writeHead(response.statusCode ?? 502, response.headers);
        clientResponse.once("finish", async () => {
          if (
            success &&
            clientRequest.method === "POST" &&
            clientRequest.url === "/v1/chat/completions" &&
            (await modelPromise) === options.model
          )
            completedRequests += 1;
        });
        response.once("error", fail);
        response.pipe(clientResponse);
      });
      upstream.once("error", fail);
      clientRequest.once("aborted", () => upstream.destroy());
      clientRequest.pipe(upstream);
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("protected inference recorder has no TCP address");
  return {
    port: address.port,
    token,
    get completedRequests() {
      return completedRequests;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
