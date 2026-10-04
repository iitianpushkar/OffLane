import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Bytes32 } from "@offlane/protocol";
import type { RelayStore } from "./store.js";

export type ChannelEvent =
  | {
      eventName: "ChannelOpened";
      blockNumber: bigint;
      logIndex: number;
      transactionHash: Hex;
      args: {
        channelId: Bytes32;
        participantA: Address;
        participantB: Address;
        token: Address;
        depositA: bigint;
        depositB: bigint;
        challengeDuration: number;
        validUntil: number;
      };
    }
  | {
      eventName: "ChannelJoined";
      blockNumber: bigint;
      logIndex: number;
      transactionHash: Hex;
      args: { channelId: Bytes32; depositB: bigint };
    }
  | {
      eventName: "ChannelCancelled" | "ChannelSettled";
      blockNumber: bigint;
      logIndex: number;
      transactionHash: Hex;
      args: { channelId: Bytes32 };
    }
  | {
      eventName: "CloseInitiated" | "StateChallenged";
      blockNumber: bigint;
      logIndex: number;
      transactionHash: Hex;
      args: { channelId: Bytes32 };
    };

export interface ChannelEventSource {
  getBlockNumber(): Promise<bigint>;
  getEvents(fromBlock: bigint, toBlock: bigint): Promise<ChannelEvent[]>;
}

export interface ChannelIndexerOptions {
  chainId: number;
  contractAddress: Address;
  deploymentBlock?: bigint;
  confirmations?: bigint;
  blockBatchSize?: bigint;
  pollIntervalMs?: number;
}

const channelManagerEvents = parseAbi([
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address token, uint128 depositA, uint128 depositB, uint32 challengeDuration, uint32 validUntil)",
  "event ChannelJoined(bytes32 indexed channelId, uint128 depositB)",
  "event ChannelCancelled(bytes32 indexed channelId)",
  "event CloseInitiated(bytes32 indexed channelId, uint64 nonce, uint128 balanceA, uint128 balanceB, uint64 challengeExpireAt)",
  "event StateChallenged(bytes32 indexed channelId, uint64 nonce, uint128 balanceA, uint128 balanceB, uint64 challengeExpireAt)",
  "event ChannelSettled(bytes32 indexed channelId, uint128 payoutA, uint128 payoutB)",
]);

export class ViemChannelEventSource implements ChannelEventSource {
  private readonly client: PublicClient;

  constructor(
    rpcUrl: string,
    private readonly contractAddress: Address,
  ) {
    this.client = createPublicClient({ transport: http(rpcUrl) });
  }

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async getEvents(fromBlock: bigint, toBlock: bigint): Promise<ChannelEvent[]> {
    const logs = await this.client.getLogs({
      address: this.contractAddress,
      events: channelManagerEvents,
      fromBlock,
      toBlock,
      strict: true,
    });

    return logs.map((log) => ({
      eventName: log.eventName,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      args: log.args,
    })) as ChannelEvent[];
  }
}

export class ChannelIndexer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing = false;
  private readonly deploymentBlock: bigint;
  private readonly confirmations: bigint;
  private readonly blockBatchSize: bigint;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly store: RelayStore,
    private readonly source: ChannelEventSource,
    private readonly options: ChannelIndexerOptions,
  ) {
    this.deploymentBlock = options.deploymentBlock ?? 0n;
    this.confirmations = options.confirmations ?? 2n;
    this.blockBatchSize = options.blockBatchSize ?? 2_000n;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    if (
      this.deploymentBlock < 0n ||
      this.confirmations < 0n ||
      this.blockBatchSize <= 0n ||
      this.pollIntervalMs <= 0
    ) {
      throw new Error("invalid channel indexer configuration");
    }
  }

  async syncOnce(): Promise<void> {
    const head = await this.source.getBlockNumber();
    if (head < this.confirmations) return;
    const confirmedHead = head - this.confirmations;
    const cursor = await this.store.getIndexerCursor(
      this.options.chainId,
      this.options.contractAddress,
    );
    let fromBlock = cursor === undefined ? this.deploymentBlock : cursor + 1n;
    if (fromBlock > confirmedHead) return;

    while (fromBlock <= confirmedHead) {
      const toBlock =
        fromBlock + this.blockBatchSize - 1n < confirmedHead
          ? fromBlock + this.blockBatchSize - 1n
          : confirmedHead;
      const events = await this.source.getEvents(fromBlock, toBlock);
      events.sort((left, right) => {
        if (left.blockNumber === right.blockNumber) {
          return left.logIndex - right.logIndex;
        }
        return left.blockNumber < right.blockNumber ? -1 : 1;
      });
      for (const event of events) await this.apply(event);
      await this.store.setIndexerCursor({
        chainId: this.options.chainId,
        contractAddress: this.options.contractAddress,
        lastBlock: toBlock,
      });
      fromBlock = toBlock + 1n;
    }
  }

  start(onError: (error: unknown) => void = console.error): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.syncing) return;
      this.syncing = true;
      void this.syncOnce()
        .catch(onError)
        .finally(() => {
          this.syncing = false;
        });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async apply(event: ChannelEvent): Promise<void> {
    switch (event.eventName) {
      case "ChannelOpened":
        await this.store.createChannelFromChain({
          participantA: event.args.participantA,
          participantB: event.args.participantB,
          token: event.args.token,
          status: "pending",
          current: {
            channelId: event.args.channelId,
            nonce: 0n,
            balanceA: event.args.depositA,
            balanceB: 0n,
            appDataHash: `0x${"00".repeat(32)}`,
          },
        });
        return;
      case "ChannelJoined":
        await this.store.markChannelOpen(event.args.channelId, event.args.depositB);
        return;
      case "CloseInitiated":
      case "StateChallenged":
        await this.store.markChannelClosing(event.args.channelId);
        return;
      case "ChannelCancelled":
      case "ChannelSettled":
        await this.store.deleteChannel(event.args.channelId);
    }
  }
}
