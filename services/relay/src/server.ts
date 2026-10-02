import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createRpcMessage,
  decodeRpcMessage,
  encodeRpcMessage,
  RpcMessageType,
  type RpcMessage,
} from "@offlane/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { RelayCore } from "./core.js";
import { RelayError } from "./errors.js";
import type { RelaySession } from "./hub.js";

export interface RelayServerOptions {
  port: number;
  host?: string;
  maxPayloadBytes?: number;
}

export class RelayServer {
  private readonly http: HttpServer;
  private readonly websocket: WebSocketServer;

  constructor(
    private readonly core: RelayCore,
    private readonly options: RelayServerOptions,
  ) {
    this.http = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(404).end();
    });
    this.websocket = new WebSocketServer({
      server: this.http,
      path: "/ws",
      maxPayload: this.options.maxPayloadBytes ?? 1_048_576,
    });
    this.websocket.on("connection", (socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
        this.http.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.websocket.clients) client.close();
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      this.http.close((error) => (error ? reject(error) : resolve())),
    );
  }

  listeningPort(): number {
    const address = this.http.address();
    if (!address || typeof address === "string") {
      throw new Error("relay server is not listening on a TCP port");
    }
    return (address as AddressInfo).port;
  }

  private handleConnection(socket: WebSocket): void {
    const session: RelaySession = {
      id: randomUUID(),
      signer: undefined,
      participants: new Set(),
      send: (message) => socket.send(encodeRpcMessage(message)),
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "text frames required");
        return;
      }
      void this.handleRequest(session, data.toString());
    });
    socket.on("close", () => this.core.disconnect(session));
  }

  private async handleRequest(session: RelaySession, raw: string): Promise<void> {
    let request: RpcMessage | undefined;
    try {
      request = decodeRpcMessage(raw);
      const payload = await this.core.handle(session, request);
      session.send(
        createRpcMessage(
          RpcMessageType.Response,
          request.requestId,
          request.method,
          payload,
        ),
      );
    } catch (error) {
      if (!request) return;
      const relayError =
        error instanceof RelayError
          ? error
          : new RelayError(
              "INVALID_REQUEST",
              error instanceof Error ? error.message : "request failed",
            );
      session.send(
        createRpcMessage(
          RpcMessageType.Error,
          request.requestId,
          request.method,
          { code: relayError.code, message: relayError.message },
        ),
      );
    }
  }
}
