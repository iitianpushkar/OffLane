import {
  createRpcMessage,
  decodeRpcMessage,
  encodeRpcMessage,
  RpcMessageType,
  type Address,
  type Bytes32,
  type RpcMessage,
} from "@offlane/protocol";
import { describe, expect, it } from "vitest";
import { OfflaneClient } from "./client.js";
import { RpcClientError } from "./errors.js";
import type { RpcTransport, TransportHandlers } from "./transport.js";

const NOW = 1_700_000_000_000;
const CHANNEL = `0x${"11".repeat(32)}` as Bytes32;
const EMPTY_HASH = `0x${"00".repeat(32)}` as Bytes32;
const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;

class MemoryTransport implements RpcTransport {
  handlers?: TransportHandlers;
  sent: RpcMessage[] = [];

  async connect(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(data: string): Promise<void> {
    this.sent.push(decodeRpcMessage(data));
  }

  async close(): Promise<void> {
    this.handlers?.close();
  }

  receive(message: RpcMessage): void {
    this.handlers?.message(encodeRpcMessage(message));
  }
}

function response(request: RpcMessage, payload: Record<string, unknown> = {}): RpcMessage {
  return createRpcMessage(
    RpcMessageType.Response,
    request.requestId,
    request.method,
    payload,
    NOW,
  );
}

describe("OfflaneClient", () => {
  it("correlates an RPC response with its request", async () => {
    const transport = new MemoryTransport();
    const client = new OfflaneClient(transport, { now: () => NOW });
    await client.connect();

    const pending = client.call("channels.v1.get_state", { channelId: CHANNEL });
    const request = transport.sent[0]!;
    transport.receive(response(request, { found: true }));

    await expect(pending).resolves.toEqual({ found: true });
    expect(request.requestId).toBe(1);
  });

  it("uses one proposal path for A-to-B and B-to-A states", async () => {
    const transport = new MemoryTransport();
    const client = new OfflaneClient(transport, { now: () => NOW });
    await client.connect();

    for (const [proposer, balanceA, balanceB, nonce] of [
      [A, 90n, 110n, 1n],
      [B, 105n, 95n, 2n],
    ] as const) {
      const pending = client.proposeState({
        proposalId: `0x${nonce.toString().padStart(64, "0")}` as Bytes32,
        proposer,
        baseStateHash: EMPTY_HASH,
        state: { channelId: CHANNEL, nonce, balanceA, balanceB, appDataHash: EMPTY_HASH },
        authorization: { kind: "direct", stateSignature: "0x1234" },
      });
      const request = transport.sent.at(-1)!;
      transport.receive(response(request, { accepted: true }));
      await expect(pending).resolves.toEqual({ accepted: true });
    }

    expect(transport.sent.map((message) => message.method)).toEqual([
      "channels.v1.propose_state",
      "channels.v1.propose_state",
    ]);
    expect(transport.sent.map((message) => message.payload.proposer)).toEqual([A, B]);
  });

  it("routes unsolicited events without consuming pending requests", async () => {
    const transport = new MemoryTransport();
    const client = new OfflaneClient(transport, { now: () => NOW });
    const events: RpcMessage[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    transport.receive(
      createRpcMessage(
        RpcMessageType.Event,
        0,
        "channels.v1.state_updated",
        { channelId: CHANNEL },
        NOW,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.requestId).toBe(0);
  });

  it("rejects method-confused and remote-error responses", async () => {
    const transport = new MemoryTransport();
    const client = new OfflaneClient(transport, { now: () => NOW });
    await client.connect();

    const mismatched = client.ping();
    const ping = transport.sent.at(-1)!;
    transport.receive({ ...response(ping), method: "channels.v1.get_state" });
    await expect(mismatched).rejects.toMatchObject({ code: "METHOD_MISMATCH" });

    const failed = client.ping();
    const secondPing = transport.sent.at(-1)!;
    transport.receive(
      createRpcMessage(
        RpcMessageType.Error,
        secondPing.requestId,
        secondPing.method,
        { code: "UNAUTHORIZED", message: "signature required" },
        NOW,
      ),
    );
    await expect(failed).rejects.toEqual(
      new RpcClientError("REMOTE_ERROR", "UNAUTHORIZED: signature required"),
    );
  });

  it("rejects stale responses and reports later duplicates", async () => {
    const transport = new MemoryTransport();
    const client = new OfflaneClient(transport, {
      now: () => NOW,
      requestTimeoutMs: 5,
      maxMessageAgeMs: 100,
    });
    const errors: RpcClientError[] = [];
    client.onProtocolError((error) => errors.push(error));
    await client.connect();

    const pending = client.ping();
    const request = transport.sent[0]!;
    transport.receive({ ...response(request), timestamp: NOW - 101 });
    await expect(pending).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    transport.receive(response(request));

    expect(errors.map((error) => error.code)).toEqual([
      "INVALID_MESSAGE",
      "UNEXPECTED_RESPONSE",
    ]);
  });

  it("times out a request that receives no response", async () => {
    const client = new OfflaneClient(new MemoryTransport(), {
      now: () => NOW,
      requestTimeoutMs: 5,
    });
    await client.connect();

    await expect(client.ping()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });
});
