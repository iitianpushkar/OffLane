import type { Address, Bytes32, Hex } from "@offlane/protocol";
import { describe, expect, it } from "vitest";
import {
  ChannelIndexer,
  type ChannelEvent,
  type ChannelEventSource,
} from "./indexer.js";
import { MemoryRelayStore } from "./store.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const TOKEN = "0x0000000000000000000000000000000000000020" as Address;
const MANAGER = "0x00000000000000000000000000000000000000d4" as Address;
const CHANNEL = `0x${"11".repeat(32)}` as Bytes32;
const TX = `0x${"99".repeat(32)}` as Hex;

class FakeEventSource implements ChannelEventSource {
  head = 13n;
  readonly calls: Array<[bigint, bigint]> = [];

  constructor(readonly events: ChannelEvent[]) {}

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getEvents(fromBlock: bigint, toBlock: bigint): Promise<ChannelEvent[]> {
    this.calls.push([fromBlock, toBlock]);
    return this.events.filter(
      (event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock,
    );
  }
}

describe("ChannelIndexer", () => {
  it("replays confirmed lifecycle events and resumes from its cursor", async () => {
    const events: ChannelEvent[] = [
      {
        eventName: "ChannelOpened",
        blockNumber: 10n,
        logIndex: 1,
        transactionHash: TX,
        args: {
          channelId: CHANNEL,
          participantA: A,
          participantB: B,
          token: TOKEN,
          depositA: 100n,
          depositB: 100n,
          challengeDuration: 3600,
          validUntil: 2_000_000_000,
        },
      },
      {
        eventName: "ChannelJoined",
        blockNumber: 11n,
        logIndex: 0,
        transactionHash: TX,
        args: { channelId: CHANNEL, depositB: 100n },
      },
      {
        eventName: "CloseInitiated",
        blockNumber: 13n,
        logIndex: 0,
        transactionHash: TX,
        args: { channelId: CHANNEL },
      },
      {
        eventName: "ChannelSettled",
        blockNumber: 14n,
        logIndex: 0,
        transactionHash: TX,
        args: { channelId: CHANNEL },
      },
    ];
    const store = new MemoryRelayStore();
    const source = new FakeEventSource(events);
    const indexer = new ChannelIndexer(store, source, {
      chainId: 42431,
      contractAddress: MANAGER,
      deploymentBlock: 10n,
      confirmations: 2n,
      blockBatchSize: 2n,
    });

    await indexer.syncOnce();
    expect(await store.getChannel(CHANNEL)).toMatchObject({
      status: "open",
      current: { balanceA: 100n, balanceB: 100n },
    });
    expect(await store.getIndexerCursor(42431, MANAGER)).toBe(11n);

    await store.saveChannel({
      participantA: A,
      participantB: B,
      token: TOKEN,
      status: "open",
      current: {
        channelId: CHANNEL,
        nonce: 1n,
        balanceA: 90n,
        balanceB: 110n,
        appDataHash: `0x${"55".repeat(32)}`,
      },
    });
    await store.setIndexerCursor({
      chainId: 42431,
      contractAddress: MANAGER,
      lastBlock: 9n,
    });
    await indexer.syncOnce();
    expect((await store.getChannel(CHANNEL))?.current).toMatchObject({
      nonce: 1n,
      balanceA: 90n,
      balanceB: 110n,
    });

    source.head = 15n;
    await indexer.syncOnce();
    expect((await store.getChannel(CHANNEL))?.status).toBe("closing");
    expect(source.calls.at(-1)?.[0]).toBe(12n);

    source.head = 16n;
    await indexer.syncOnce();
    expect(await store.getChannel(CHANNEL)).toBeUndefined();
    expect(await store.getIndexerCursor(42431, MANAGER)).toBe(14n);
    store.close();
  });
});
