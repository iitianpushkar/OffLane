import { z } from "zod";
import { UINT128_MAX, UINT256_MAX, UINT64_MAX } from "./state.js";
import type {
  Address,
  Bytes32,
  ChannelCapability,
  ChannelState,
  EncryptedEnvelope,
  EncryptedMessageRecord,
  MessagingKeyCertificate,
  StateAuthorization,
} from "./types.js";

const canonicalUint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "must be a canonical unsigned decimal string")
  .transform((value) => BigInt(value));

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((value) => value as Address);

export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex value")
  .transform((value) => value as Bytes32);

export const hexSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, "must be byte-aligned hex")
  .transform((value) => value as `0x${string}`);

export const bytes24Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{48}$/, "must be a 24-byte hex value")
  .transform((value) => value as `0x${string}`);

export const uint64StringSchema = canonicalUint.refine(
  (value) => value <= UINT64_MAX,
  "must fit uint64",
);

export const uint128StringSchema = canonicalUint.refine(
  (value) => value <= UINT128_MAX,
  "must fit uint128",
);

export const uint256StringSchema = canonicalUint.refine(
  (value) => value <= UINT256_MAX,
  "must fit uint256",
);

export const channelStateWireSchema = z
  .object({
    channelId: bytes32Schema,
    nonce: uint64StringSchema,
    balanceA: uint128StringSchema,
    balanceB: uint128StringSchema,
    appDataHash: bytes32Schema,
  })
  .strict();

export const channelSummaryWireSchema = z
  .object({
    participantA: addressSchema,
    participantB: addressSchema,
    token: addressSchema,
    status: z.enum(["pending", "open", "closing"]),
    current: channelStateWireSchema,
  })
  .strict();

export const channelListResponseWireSchema = z
  .object({ channels: z.array(channelSummaryWireSchema).max(1_000) })
  .strict();

export const channelCapabilityWireSchema = z
  .object({
    protocolVersion: z.literal(1),
    channelId: bytes32Schema,
    participant: addressSchema,
    delegatedSigner: addressSchema,
    counterparty: addressSchema,
    token: addressSchema,
    baselineBalance: uint128StringSchema,
    maxNetSpend: uint128StringSchema,
    capabilityNonce: uint256StringSchema,
  })
  .strict()
  .refine(
    (capability) => capability.maxNetSpend <= capability.baselineBalance,
    { message: "maxNetSpend cannot exceed baselineBalance" },
  );

export const messagingKeyCertificateWireSchema = z
  .object({
    protocolVersion: z.literal(1),
    owner: addressSchema,
    publicKey: bytes32Schema,
    keyVersion: uint64StringSchema,
    validFrom: uint64StringSchema,
    validUntil: uint64StringSchema,
  })
  .strict()
  .refine((certificate) => certificate.validUntil > certificate.validFrom, {
    message: "validUntil must be later than validFrom",
  });

export const stateAuthorizationWireSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("direct"),
      stateSignature: hexSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("capability"),
      stateSignature: hexSchema,
      capability: channelCapabilityWireSchema,
      capabilitySignature: hexSchema,
    })
    .strict(),
]);

export const protocolRequestMethods = [
  "auth.v1.request_challenge",
  "auth.v1.verify",
  "node.v1.ping",
  "channels.v1.propose_state",
  "channels.v1.register_capability",
  "channels.v1.accept_state",
  "channels.v1.reject_state",
  "channels.v1.get_state",
  "channels.v1.get_pending",
  "channels.v1.list",
  "keys.v1.register",
  "keys.v1.resolve",
  "keys.v1.revoke",
  "messages.v1.send",
  "messages.v1.list",
  "messages.v1.acknowledge",
] as const;

export const protocolEventMethods = [
  "channels.v1.state_proposed",
  "channels.v1.state_rejected",
  "channels.v1.state_updated",
  "messages.v1.received",
  "messages.v1.acknowledged",
] as const;

export const protocolMethodSchema = z.enum([
  ...protocolRequestMethods,
  ...protocolEventMethods,
]);

export function encodeChannelState(state: ChannelState): {
  channelId: Bytes32;
  nonce: string;
  balanceA: string;
  balanceB: string;
  appDataHash: Bytes32;
} {
  return {
    channelId: state.channelId,
    nonce: state.nonce.toString(),
    balanceA: state.balanceA.toString(),
    balanceB: state.balanceB.toString(),
    appDataHash: state.appDataHash,
  };
}

export function encodeChannelCapability(capability: ChannelCapability): {
  protocolVersion: 1;
  channelId: Bytes32;
  participant: Address;
  delegatedSigner: Address;
  counterparty: Address;
  token: Address;
  baselineBalance: string;
  maxNetSpend: string;
  capabilityNonce: string;
} {
  if (capability.protocolVersion !== 1) {
    throw new Error("unsupported capability protocol version");
  }

  return {
    protocolVersion: 1,
    channelId: capability.channelId,
    participant: capability.participant,
    delegatedSigner: capability.delegatedSigner,
    counterparty: capability.counterparty,
    token: capability.token,
    baselineBalance: capability.baselineBalance.toString(),
    maxNetSpend: capability.maxNetSpend.toString(),
    capabilityNonce: capability.capabilityNonce.toString(),
  };
}

export function encodeMessagingKeyCertificate(certificate: MessagingKeyCertificate) {
  return {
    ...certificate,
    keyVersion: certificate.keyVersion.toString(),
    validFrom: certificate.validFrom.toString(),
    validUntil: certificate.validUntil.toString(),
  };
}

export function encodeStateAuthorization(authorization: StateAuthorization):
  | { kind: "direct"; stateSignature: `0x${string}` }
  | {
      kind: "capability";
      stateSignature: `0x${string}`;
      capability: ReturnType<typeof encodeChannelCapability>;
      capabilitySignature: `0x${string}`;
    } {
  if (authorization.kind === "direct") {
    return authorization;
  }

  return {
    ...authorization,
    capability: encodeChannelCapability(authorization.capability),
  };
}

export const encryptedEnvelopeWireSchema = z
  .object({
    protocolVersion: z.literal(1),
    messageId: bytes32Schema,
    channelId: bytes32Schema,
    sender: addressSchema,
    recipient: addressSchema,
    sequence: uint64StringSchema,
    stateNonce: uint64StringSchema,
    senderPublicKey: bytes32Schema,
    recipientPublicKey: bytes32Schema,
    encryptionNonce: bytes24Schema,
    ciphertext: hexSchema.refine((value) => value.length <= 131_106, {
      message: "ciphertext exceeds 64 KiB",
    }),
    contentType: z.string().min(1).max(128),
  })
  .strict();

export const messageDeliveryStatusSchema = z.enum([
  "sent",
  "delivered",
  "acknowledged",
]);

export const encryptedMessageRecordWireSchema = z
  .object({
    envelope: encryptedEnvelopeWireSchema,
    status: messageDeliveryStatusSchema,
    sentAt: z.number().int().nonnegative().safe(),
    deliveredAt: z.number().int().nonnegative().safe().optional(),
    acknowledgedAt: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

export function encodeEncryptedEnvelope(envelope: EncryptedEnvelope) {
  return {
    ...envelope,
    sequence: envelope.sequence.toString(),
    stateNonce: envelope.stateNonce.toString(),
  };
}

export function encodeEncryptedMessageRecord(record: EncryptedMessageRecord) {
  return { ...record, envelope: encodeEncryptedEnvelope(record.envelope) };
}
