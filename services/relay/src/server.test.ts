import {
  createRpcMessage,
  decodeRpcMessage,
  encodeRpcMessage,
  RpcMessageType,
  type Address,
} from "@offlane/protocol";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { RelayCore } from "./core.js";
import { RelayServer } from "./server.js";
import { MemoryRelayStore } from "./store.js";
import { ViemAuthorizationVerifier } from "./verifier.js";

const domain = {
  name: "Tempo.ChannelManager",
  version: "1",
  chainId: 42431,
  verifyingContract:
    "0x00000000000000000000000000000000000000d4" as Address,
} as const;

describe("RelayServer", () => {
  it("serves compact RPC frames over a real WebSocket", async () => {
    const core = new RelayCore(
      new MemoryRelayStore(),
      new ViemAuthorizationVerifier(domain),
      domain,
    );
    const server = new RelayServer(core, { port: 0 });
    await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${server.listeningPort()}/ws`);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const response = new Promise<string>((resolve, reject) => {
        socket.once("message", (data) => resolve(data.toString()));
        socket.once("error", reject);
      });
      socket.send(
        encodeRpcMessage(
          createRpcMessage(
            RpcMessageType.Request,
            7,
            "node.v1.ping",
            {},
          ),
        ),
      );

      expect(decodeRpcMessage(await response)).toMatchObject({
        type: RpcMessageType.Response,
        requestId: 7,
        method: "node.v1.ping",
        payload: { ok: true },
      });
    } finally {
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", resolve));
      await server.close();
    }
  });
});
