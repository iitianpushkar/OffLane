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

export interface ChannelCapability {
  protocolVersion: number;
  channelId: Bytes32;
  participant: Address;
  delegatedSigner: Address;
  counterparty: Address;
  token: Address;
  baselineBalance: bigint;
  maxNetSpend: bigint;
  capabilityNonce: bigint;
}

export interface EncryptedEnvelope {
  protocolVersion: 1;
  messageId: Bytes32;
  channelId: Bytes32;
  sender: Address;
  recipient: Address;
  sequence: bigint;
  stateNonce: bigint;
  senderPublicKey: Bytes32;
  recipientPublicKey: Bytes32;
  encryptionNonce: Hex;
  ciphertext: Hex;
  contentType: string;
}

export type MessageDeliveryStatus = "sent" | "delivered" | "acknowledged";

export interface EncryptedMessageRecord {
  envelope: EncryptedEnvelope;
  status: MessageDeliveryStatus;
  sentAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

export type StateAuthorization =
  | {
      kind: "direct";
      stateSignature: Hex;
    }
  | {
      kind: "capability";
      stateSignature: Hex;
      capability: ChannelCapability;
      capabilitySignature: Hex;
    };

export interface ChannelContext {
  participantA: Address;
  participantB: Address;
  current: ChannelState;
}

export interface ChannelTerms {
  participantA: Address;
  participantB: Address;
  token: Address;
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
