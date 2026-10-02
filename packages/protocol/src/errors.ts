export type ProtocolErrorCode =
  | "CHANNEL_MISMATCH"
  | "INVALID_NONCE"
  | "BALANCE_OUT_OF_RANGE"
  | "BALANCE_SUM_MISMATCH"
  | "ZERO_VALUE_PAYMENT"
  | "UNKNOWN_PARTICIPANT"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_PROPOSAL_BASE"
  | "INVALID_CAPABILITY"
  | "CAPABILITY_SPEND_EXCEEDED";

export class ProtocolValidationError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}
