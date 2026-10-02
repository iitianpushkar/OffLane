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
  current: ChannelState;
  authorizationA?: StateAuthorization;
  authorizationB?: StateAuthorization;
}

export interface PendingProposal {
  proposal: StateProposalMessage;
  createdAt: number;
}

export interface RelayStore {
  getChannel(channelId: Bytes32): Promise<RelayChannel | undefined>;
  saveChannel(channel: RelayChannel): Promise<void>;
  getPendingByChannel(channelId: Bytes32): Promise<PendingProposal | undefined>;
  getPending(proposalId: Bytes32): Promise<PendingProposal | undefined>;
  savePending(pending: PendingProposal): Promise<void>;
  deletePending(proposalId: Bytes32): Promise<void>;
  commitAccepted(
    channel: RelayChannel,
    proposalId: Bytes32,
    acceptance: StateAcceptanceMessage,
  ): Promise<void>;
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

  async getChannel(channelId: Bytes32): Promise<RelayChannel | undefined> {
    return this.channels.get(channelKey(channelId));
  }

  async saveChannel(channel: RelayChannel): Promise<void> {
    this.channels.set(channelKey(channel.current.channelId), channel);
  }

  async getPendingByChannel(channelId: Bytes32): Promise<PendingProposal | undefined> {
    const id = this.proposalByChannel.get(channelKey(channelId));
    return id ? this.proposals.get(id) : undefined;
  }

  async getPending(proposalId: Bytes32): Promise<PendingProposal | undefined> {
    return this.proposals.get(proposalKey(proposalId));
  }

  async savePending(pending: PendingProposal): Promise<void> {
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
    const pending = await this.getPending(proposalId);
    if (!pending) throw new Error("pending proposal disappeared before commit");

    const proposerIsA =
      pending.proposal.proposer.toLowerCase() === channel.participantA.toLowerCase();
    const next: RelayChannel = {
      ...channel,
      current: pending.proposal.state,
      authorizationA: proposerIsA
        ? pending.proposal.authorization
        : acceptance.authorization,
      authorizationB: proposerIsA
        ? acceptance.authorization
        : pending.proposal.authorization,
    };
    await this.saveChannel(next);
    await this.deletePending(proposalId);
  }
}
