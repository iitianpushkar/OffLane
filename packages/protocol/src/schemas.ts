import { z } from "zod";
import { UINT128_MAX, UINT64_MAX } from "./state.js";
import type { Address, Bytes32, ChannelState } from "./types.js";

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

export const uint64StringSchema = canonicalUint.refine(
  (value) => value <= UINT64_MAX,
  "must fit uint64",
);

export const uint128StringSchema = canonicalUint.refine(
  (value) => value <= UINT128_MAX,
  "must fit uint128",
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
