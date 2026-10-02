import { z } from "zod";
import { UINT128_MAX, UINT256_MAX, UINT64_MAX } from "./state.js";
import type {
  Address,
  Bytes32,
  ChannelCapability,
  ChannelState,
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

export const protocolMethodSchema = z.enum([
  "channel.state.propose",
  "channel.state.accept",
  "channel.state.reject",
  "channel.state.sync",
]);

export const protocolEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["request", "response", "event", "error"]),
    id: z.string().min(1).max(128),
    method: protocolMethodSchema,
    timestamp: z.number().int().nonnegative(),
    sequence: uint64StringSchema,
    payload: z.unknown(),
    signature: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(),
  })
  .strict();

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
