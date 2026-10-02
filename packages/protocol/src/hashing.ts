import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  type TypedDataDomain,
} from "viem";
import type { Bytes32, ChannelState, PaymentMetadata } from "./types.js";

export const channelStateTypes = {
  ChannelState: [
    { name: "channelId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
    { name: "balanceA", type: "uint128" },
    { name: "balanceB", type: "uint128" },
    { name: "appDataHash", type: "bytes32" },
  ],
} as const;

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
