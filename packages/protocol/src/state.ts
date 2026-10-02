import { ProtocolValidationError } from "./errors.js";
import type {
  Address,
  Bytes32,
  ChannelContext,
  ChannelState,
  PaymentTransfer,
} from "./types.js";

export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT128_MAX = (1n << 128n) - 1n;

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertUint(value: bigint, maximum: bigint, field: string): void {
  if (value < 0n || value > maximum) {
    throw new ProtocolValidationError(
      "BALANCE_OUT_OF_RANGE",
      `${field} is outside its unsigned integer range`,
    );
  }
}

export function channelTotal(state: ChannelState): bigint {
  return state.balanceA + state.balanceB;
}

export function assertChannelStateBounds(state: ChannelState): void {
  if (state.nonce < 0n || state.nonce > UINT64_MAX) {
    throw new ProtocolValidationError(
      "INVALID_NONCE",
      "nonce is outside the uint64 range",
    );
  }

  assertUint(state.balanceA, UINT128_MAX, "balanceA");
  assertUint(state.balanceB, UINT128_MAX, "balanceB");
}

export function validatePaymentTransition(
  context: ChannelContext,
  next: ChannelState,
): PaymentTransfer {
  const current = context.current;
  assertChannelStateBounds(current);
  assertChannelStateBounds(next);

  if (next.channelId.toLowerCase() !== current.channelId.toLowerCase()) {
    throw new ProtocolValidationError(
      "CHANNEL_MISMATCH",
      "proposed state belongs to a different channel",
    );
  }

  if (next.nonce !== current.nonce + 1n) {
    throw new ProtocolValidationError(
      "INVALID_NONCE",
      "off-chain payments must advance the nonce by exactly one",
    );
  }

  if (channelTotal(next) !== channelTotal(current)) {
    throw new ProtocolValidationError(
      "BALANCE_SUM_MISMATCH",
      "a payment must preserve total channel collateral",
    );
  }

  const deltaA = next.balanceA - current.balanceA;
  if (deltaA === 0n) {
    throw new ProtocolValidationError(
      "ZERO_VALUE_PAYMENT",
      "a payment state must transfer a positive amount",
    );
  }

  if (deltaA < 0n) {
    return {
      payer: context.participantA,
      payee: context.participantB,
      amount: -deltaA,
    };
  }

  return {
    payer: context.participantB,
    payee: context.participantA,
    amount: deltaA,
  };
}

export function buildPaymentState(
  context: ChannelContext,
  payer: Address,
  amount: bigint,
  appDataHash: Bytes32,
): ChannelState {
  if (amount <= 0n) {
    throw new ProtocolValidationError(
      "ZERO_VALUE_PAYMENT",
      "payment amount must be positive",
    );
  }

  const payerIsA = sameAddress(payer, context.participantA);
  const payerIsB = sameAddress(payer, context.participantB);
  if (!payerIsA && !payerIsB) {
    throw new ProtocolValidationError(
      "UNKNOWN_PARTICIPANT",
      "payer is not a participant in this channel",
    );
  }

  const available = payerIsA
    ? context.current.balanceA
    : context.current.balanceB;
  if (amount > available) {
    throw new ProtocolValidationError(
      "INSUFFICIENT_BALANCE",
      "payer does not have enough channel balance",
    );
  }

  const next: ChannelState = {
    channelId: context.current.channelId,
    nonce: context.current.nonce + 1n,
    balanceA: payerIsA
      ? context.current.balanceA - amount
      : context.current.balanceA + amount,
    balanceB: payerIsB
      ? context.current.balanceB - amount
      : context.current.balanceB + amount,
    appDataHash,
  };

  validatePaymentTransition(context, next);
  return next;
}
