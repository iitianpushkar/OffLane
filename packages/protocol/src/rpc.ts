import { z } from "zod";
import {
  addressSchema,
  bytes32Schema,
  channelCapabilityWireSchema,
  channelStateWireSchema,
  encryptedEnvelopeWireSchema,
  encryptedMessageRecordWireSchema,
  hexSchema,
  messagingKeyCertificateWireSchema,
  protocolMethodSchema,
  stateAuthorizationWireSchema,
  uint64StringSchema,
} from "./schemas.js";
import type {
  Address,
  Bytes32,
  ChannelState,
  StateAuthorization,
  StateProposal,
} from "./types.js";

export const RPC_PROTOCOL_VERSION = 1 as const;

export enum RpcMessageType {
  Request = 1,
  Response = 2,
  Event = 3,
  Error = 4,
}

export type ProtocolMethod = z.infer<typeof protocolMethodSchema>;
export type RpcPayload = Record<string, unknown>;

export interface RpcMessage {
  type: RpcMessageType;
  requestId: number;
  method: ProtocolMethod;
  payload: RpcPayload;
  timestamp: number;
}

const safeIntegerSchema = z.number().int().nonnegative().safe();
const rpcPayloadSchema = z.record(z.string(), z.unknown());

/**
 * Compact Nitrolite-style frame:
 * [message type, request ID, versioned method, payload, unix milliseconds].
 */
export const rpcFrameSchema = z.tuple([
  z.enum(RpcMessageType),
  safeIntegerSchema,
  protocolMethodSchema,
  rpcPayloadSchema,
  safeIntegerSchema,
]);

export const stateProposalWireSchema = z
  .object({
    proposalId: bytes32Schema,
    proposer: addressSchema,
    baseStateHash: bytes32Schema,
    state: channelStateWireSchema,
    authorization: stateAuthorizationWireSchema,
  })
  .strict();

export const pendingProposalResponseWireSchema = z
  .object({ proposal: stateProposalWireSchema.nullable() })
  .strict();

export const messagingKeyRegistrationWireSchema = z
  .object({
    certificate: messagingKeyCertificateWireSchema,
    signature: hexSchema,
  })
  .strict();

export const messagingKeyResolutionWireSchema = z
  .object({ owner: addressSchema })
  .strict();

export const messagingKeyRevocationWireSchema = z
  .object({
    owner: addressSchema,
    keyVersion: uint64StringSchema,
  })
  .strict();

export const messagingKeyResolutionResponseWireSchema = z
  .object({
    registration: z
      .object({
        certificate: messagingKeyCertificateWireSchema,
        signature: hexSchema,
        registeredAt: safeIntegerSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const capabilityRegistrationWireSchema = z
  .object({
    capability: channelCapabilityWireSchema,
    capabilitySignature: hexSchema,
  })
  .strict();

export const stateAcceptanceWireSchema = z
  .object({
    proposalId: bytes32Schema,
    accepter: addressSchema,
    state: channelStateWireSchema,
    authorization: stateAuthorizationWireSchema,
  })
  .strict();

export const stateRejectionWireSchema = z
  .object({
    proposalId: bytes32Schema,
    channelId: bytes32Schema,
    reason: z.string().min(1).max(256),
  })
  .strict();

export const stateQueryWireSchema = z
  .object({ channelId: bytes32Schema })
  .strict();

export const messageSendWireSchema = z
  .object({ envelope: encryptedEnvelopeWireSchema })
  .strict();

export const messageListWireSchema = z
  .object({
    channelId: bytes32Schema,
    afterSequence: uint64StringSchema.optional(),
  })
  .strict();

export const messageAcknowledgementWireSchema = z
  .object({
    channelId: bytes32Schema,
    messageId: bytes32Schema,
  })
  .strict();

export const messageListResponseWireSchema = z
  .object({ messages: z.array(encryptedMessageRecordWireSchema).max(1_000) })
  .strict();

export const rpcErrorPayloadSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  })
  .strict();

export const authChallengeRequestWireSchema = z
  .object({ signer: addressSchema })
  .strict();

export const authChallengeResponseWireSchema = z
  .object({
    challengeId: bytes32Schema,
    message: z.string().min(1).max(1024),
    expiresAt: safeIntegerSchema,
  })
  .strict();

export const authVerifyRequestWireSchema = z
  .object({
    challengeId: bytes32Schema,
    signer: addressSchema,
    signature: hexSchema,
  })
  .strict();

export const authVerifyResponseWireSchema = z
  .object({ signer: addressSchema })
  .strict();

export interface StateProposalMessage extends StateProposal {
  authorization: StateAuthorization;
}

export interface StateAcceptanceMessage {
  proposalId: Bytes32;
  accepter: Address;
  state: ChannelState;
  authorization: StateAuthorization;
}

export function encodeRpcMessage(message: RpcMessage): string {
  const frame = rpcFrameSchema.parse([
    message.type,
    message.requestId,
    message.method,
    message.payload,
    message.timestamp,
  ]);
  return JSON.stringify(frame);
}

export function decodeRpcMessage(data: string): RpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("invalid RPC message: expected JSON");
  }

  const [type, requestId, method, payload, timestamp] =
    rpcFrameSchema.parse(parsed);
  return { type, requestId, method, payload, timestamp };
}

export function createRpcMessage(
  type: RpcMessageType,
  requestId: number,
  method: ProtocolMethod,
  payload: RpcPayload,
  timestamp = Date.now(),
): RpcMessage {
  return rpcFrameSchema.transform(([frameType, id, frameMethod, body, time]) => ({
    type: frameType,
    requestId: id,
    method: frameMethod,
    payload: body,
    timestamp: time,
  })).parse([type, requestId, method, payload, timestamp]);
}

export function parseStateProposalPayload(payload: RpcPayload): StateProposalMessage {
  return stateProposalWireSchema.parse(payload);
}

export function parseStateAcceptancePayload(payload: RpcPayload): StateAcceptanceMessage {
  return stateAcceptanceWireSchema.parse(payload);
}

export function parseStateQueryPayload(payload: RpcPayload): { channelId: Bytes32 } {
  return stateQueryWireSchema.parse(payload);
}

export function parseWireNonce(value: unknown): bigint {
  return uint64StringSchema.parse(value);
}
