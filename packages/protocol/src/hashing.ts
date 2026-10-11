import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  type TypedDataDomain,
} from "viem";
import type {
  Bytes32,
  ChannelCapability,
  ChannelState,
  EncryptedEnvelope,
  MessagingKeyCertificate,
  PaymentMetadata,
} from "./types.js";

export const channelStateTypes = {
  ChannelState: [
    { name: "channelId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
    { name: "balanceA", type: "uint128" },
    { name: "balanceB", type: "uint128" },
    { name: "appDataHash", type: "bytes32" },
  ],
} as const;

export const channelCapabilityTypes = {
  ChannelCapability: [
    { name: "protocolVersion", type: "uint8" },
    { name: "channelId", type: "bytes32" },
    { name: "participant", type: "address" },
    { name: "delegatedSigner", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "token", type: "address" },
    { name: "baselineBalance", type: "uint128" },
    { name: "maxNetSpend", type: "uint128" },
    { name: "capabilityNonce", type: "uint256" },
  ],
} as const;

export const messagingKeyCertificateTypes = {
  MessagingKeyCertificate: [
    { name: "protocolVersion", type: "uint8" },
    { name: "owner", type: "address" },
    { name: "publicKey", type: "bytes32" },
    { name: "keyVersion", type: "uint64" },
    { name: "validFrom", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export function messagingKeyDomain(domain: TypedDataDomain): TypedDataDomain {
  return {
    name: "OffLane Messaging",
    version: "1",
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
}

export function hashMessagingKeyCertificate(
  domain: TypedDataDomain,
  certificate: MessagingKeyCertificate,
): Bytes32 {
  return hashTypedData({
    domain: messagingKeyDomain(domain),
    types: messagingKeyCertificateTypes,
    primaryType: "MessagingKeyCertificate",
    message: certificate,
  });
}

export function hashChannelState(
  domain: TypedDataDomain,
  state: ChannelState,
): Bytes32 {
  return hashTypedData({
    domain,
    types: channelStateTypes,
    primaryType: "ChannelState",
    message: state,
  });
}

export function hashChannelCapability(
  domain: TypedDataDomain,
  capability: ChannelCapability,
): Bytes32 {
  return hashTypedData({
    domain,
    types: channelCapabilityTypes,
    primaryType: "ChannelCapability",
    message: capability,
  });
}

/** Hash committed into ChannelState.appDataHash for a paid service request. */
export function hashPaymentMetadata(metadata: PaymentMetadata): Bytes32 {
  const encoded = encodeAbiParameters(
    [
      { name: "protocolVersion", type: "uint8" },
      { name: "channelId", type: "bytes32" },
      { name: "quoteId", type: "bytes32" },
      { name: "requestHash", type: "bytes32" },
      { name: "serviceId", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "units", type: "uint128" },
      { name: "amount", type: "uint128" },
      { name: "previousStateHash", type: "bytes32" },
    ],
    [
      metadata.protocolVersion,
      metadata.channelId,
      metadata.quoteId,
      metadata.requestHash,
      metadata.serviceId,
      metadata.payer,
      metadata.payee,
      metadata.units,
      metadata.amount,
      metadata.previousStateHash,
    ],
  );

  return keccak256(encoded);
}

export function encodeEncryptedEnvelopeAad(
  envelope: Omit<EncryptedEnvelope, "messageId" | "encryptionNonce" | "ciphertext">,
): `0x${string}` {
  return encodeAbiParameters(
    [
      { name: "protocolVersion", type: "uint8" },
      { name: "channelId", type: "bytes32" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      { name: "sequence", type: "uint64" },
      { name: "stateNonce", type: "uint64" },
      { name: "senderPublicKey", type: "bytes32" },
      { name: "recipientPublicKey", type: "bytes32" },
      { name: "contentTypeHash", type: "bytes32" },
    ],
    [
      envelope.protocolVersion,
      envelope.channelId,
      envelope.sender,
      envelope.recipient,
      envelope.sequence,
      envelope.stateNonce,
      envelope.senderPublicKey,
      envelope.recipientPublicKey,
      keccak256(new TextEncoder().encode(envelope.contentType)),
    ],
  );
}

/** Canonical envelope commitment stored in ChannelState.appDataHash. */
export function hashEncryptedEnvelope(
  envelope: Omit<EncryptedEnvelope, "messageId">,
): Bytes32 {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "aadHash", type: "bytes32" },
        { name: "encryptionNonce", type: "bytes24" },
        { name: "ciphertextHash", type: "bytes32" },
      ],
      [
        keccak256(encodeEncryptedEnvelopeAad(envelope)),
        envelope.encryptionNonce,
        keccak256(envelope.ciphertext),
      ],
    ),
  );
}
