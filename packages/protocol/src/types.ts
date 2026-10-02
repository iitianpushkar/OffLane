export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;

export interface ChannelState {
  channelId: Bytes32;
  nonce: bigint;
  balanceA: bigint;
  balanceB: bigint;
  appDataHash: Bytes32;
}

export interface ChannelContext {
  participantA: Address;
  participantB: Address;
  current: ChannelState;
}

export interface PaymentTransfer {
  payer: Address;
  payee: Address;
  amount: bigint;
}

export interface StateProposal {
  proposalId: Bytes32;
  proposer: Address;
  baseStateHash: Bytes32;
  state: ChannelState;
}

export interface PaymentMetadata {
  protocolVersion: number;
  channelId: Bytes32;
  quoteId: Bytes32;
  requestHash: Bytes32;
  serviceId: Bytes32;
  payer: Address;
  payee: Address;
  units: bigint;
  amount: bigint;
  previousStateHash: Bytes32;
}

export interface ProposalResolution {
  winner: StateProposal;
  loser: StateProposal;
  reason: "nonce-priority" | "proposal-id";
}
