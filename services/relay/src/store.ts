import type {
  Address,
  Bytes32,
  ChannelState,
  StateAcceptanceMessage,
  StateAuthorization,
  StateProposalMessage,
} from "@offlane/protocol";

export interface RelayChannel {
  participantA: Address;
  participantB: Address;
  token: Address;
  status: RelayChannelStatus;
  current: ChannelState;
  authorizationA?: StateAuthorization;
  authorizationB?: StateAuthorization;
}

export type RelayChannelStatus = "pending" | "open" | "closing";

export interface IndexerCursor {
  chainId: number;
  contractAddress: Address;
  lastBlock: bigint;
}

export interface PendingProposal {
  proposal: StateProposalMessage;
  createdAt: number;
}

export interface RelayStore {
  getChannel(channelId: Bytes32): Promise<RelayChannel | undefined>;
  saveChannel(channel: RelayChannel): Promise<void>;
  deleteChannel(channelId: Bytes32): Promise<void>;
  getPendingByChannel(channelId: Bytes32): Promise<PendingProposal | undefined>;
  getPending(proposalId: Bytes32): Promise<PendingProposal | undefined>;
  savePending(pending: PendingProposal): Promise<void>;
  deletePending(proposalId: Bytes32): Promise<void>;
  commitAccepted(
    channel: RelayChannel,
    proposalId: Bytes32,
    acceptance: StateAcceptanceMessage,
  ): Promise<void>;
  createChannelFromChain(channel: RelayChannel): Promise<void>;
  markChannelOpen(channelId: Bytes32, balanceB: bigint): Promise<void>;
  markChannelClosing(channelId: Bytes32): Promise<void>;
  getIndexerCursor(
    chainId: number,
    contractAddress: Address,
  ): Promise<bigint | undefined>;
  setIndexerCursor(cursor: IndexerCursor): Promise<void>;
  close(): void;
}

function channelKey(channelId: Bytes32): string {
  return channelId.toLowerCase();
}

function proposalKey(proposalId: Bytes32): string {
  return proposalId.toLowerCase();
}

/** In-memory adapter used by tests and the first runnable relay. */
export class MemoryRelayStore implements RelayStore {
  private readonly channels = new Map<string, RelayChannel>();
  private readonly proposals = new Map<string, PendingProposal>();
  private readonly proposalByChannel = new Map<string, string>();
  private readonly cursors = new Map<string, bigint>();

  async getChannel(channelId: Bytes32): Promise<RelayChannel | undefined> {
    return this.channels.get(channelKey(channelId));
  }

  async saveChannel(channel: RelayChannel): Promise<void> {
    this.channels.set(channelKey(channel.current.channelId), channel);
  }

  async deleteChannel(channelId: Bytes32): Promise<void> {
    const key = channelKey(channelId);
    const proposalId = this.proposalByChannel.get(key);
    if (proposalId) this.proposals.delete(proposalId);
    this.proposalByChannel.delete(key);
    this.channels.delete(key);
  }

  async createChannelFromChain(channel: RelayChannel): Promise<void> {
    const key = channelKey(channel.current.channelId);
    if (!this.channels.has(key)) this.channels.set(key, channel);
  }

  async markChannelOpen(channelId: Bytes32, balanceB: bigint): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) return;
    this.channels.set(channelKey(channelId), {
      ...channel,
      status: "open",
      current:
        channel.current.nonce === 0n
          ? { ...channel.current, balanceB }
          : channel.current,
    });
  }

  async markChannelClosing(channelId: Bytes32): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) return;
    this.channels.set(channelKey(channelId), { ...channel, status: "closing" });
    const proposalId = this.proposalByChannel.get(channelKey(channelId));
    if (proposalId) this.proposals.delete(proposalId);
    this.proposalByChannel.delete(channelKey(channelId));
  }

  async getIndexerCursor(
    chainId: number,
    contractAddress: Address,
  ): Promise<bigint | undefined> {
    return this.cursors.get(`${chainId}:${contractAddress.toLowerCase()}`);
  }

  async setIndexerCursor(cursor: IndexerCursor): Promise<void> {
    this.cursors.set(
      `${cursor.chainId}:${cursor.contractAddress.toLowerCase()}`,
      cursor.lastBlock,
    );
  }

  close(): void {}

  async getPendingByChannel(channelId: Bytes32): Promise<PendingProposal | undefined> {
    const id = this.proposalByChannel.get(channelKey(channelId));
    return id ? this.proposals.get(id) : undefined;
  }

  async getPending(proposalId: Bytes32): Promise<PendingProposal | undefined> {
    return this.proposals.get(proposalKey(proposalId));
  }

  async savePending(pending: PendingProposal): Promise<void> {
    const tracked = this.channels.get(channelKey(pending.proposal.state.channelId));
    if (!tracked || tracked.status !== "open") {
      throw new Error("channel changed before proposal commit");
    }
    const id = proposalKey(pending.proposal.proposalId);
    const channel = channelKey(pending.proposal.state.channelId);
    const previous = this.proposalByChannel.get(channel);
    if (previous && previous !== id) this.proposals.delete(previous);
    this.proposals.set(id, pending);
    this.proposalByChannel.set(channel, id);
  }

  async deletePending(proposalId: Bytes32): Promise<void> {
    const id = proposalKey(proposalId);
    const pending = this.proposals.get(id);
    if (!pending) return;
    this.proposals.delete(id);
    const channel = channelKey(pending.proposal.state.channelId);
    if (this.proposalByChannel.get(channel) === id) {
      this.proposalByChannel.delete(channel);
    }
  }

  async commitAccepted(
    channel: RelayChannel,
    proposalId: Bytes32,
    acceptance: StateAcceptanceMessage,
  ): Promise<void> {
    const pending = this.proposals.get(proposalKey(proposalId));
    if (!pending) throw new Error("pending proposal disappeared before commit");
    const tracked = this.channels.get(channelKey(channel.current.channelId));
    if (
      !tracked ||
      tracked.status !== "open" ||
      tracked.current.nonce !== channel.current.nonce
    ) {
      throw new Error("channel changed before acceptance commit");
    }

    const proposerIsA =
      pending.proposal.proposer.toLowerCase() === channel.participantA.toLowerCase();
    const next: RelayChannel = {
      ...tracked,
      current: pending.proposal.state,
      authorizationA: proposerIsA
        ? pending.proposal.authorization
        : acceptance.authorization,
      authorizationB: proposerIsA
        ? acceptance.authorization
        : pending.proposal.authorization,
    };
    this.channels.set(channelKey(next.current.channelId), next);
    const id = proposalKey(proposalId);
    this.proposals.delete(id);
    if (this.proposalByChannel.get(channelKey(next.current.channelId)) === id) {
      this.proposalByChannel.delete(channelKey(next.current.channelId));
    }
  }
}
