import { ProtocolValidationError } from "./errors.js";
import { channelTotal } from "./state.js";
import type {
  Address,
  ChannelCapability,
  ChannelState,
  ChannelTerms,
} from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Mirrors ChannelManager's non-cryptographic capability checks. */
export function validateCapabilityForState(
  terms: ChannelTerms,
  capability: ChannelCapability,
  state: ChannelState,
): { participantBalance: bigint; minimumBalance: bigint } {
  const participantIsA = sameAddress(
    capability.participant,
    terms.participantA,
  );
  const participantIsB = sameAddress(
    capability.participant,
    terms.participantB,
  );
  const expectedCounterparty = participantIsA
    ? terms.participantB
    : terms.participantA;

  if (
    capability.protocolVersion !== 1 ||
    capability.channelId.toLowerCase() !== state.channelId.toLowerCase() ||
    (!participantIsA && !participantIsB) ||
    !sameAddress(capability.counterparty, expectedCounterparty) ||
    !sameAddress(capability.token, terms.token) ||
    capability.delegatedSigner.toLowerCase() === ZERO_ADDRESS ||
    capability.maxNetSpend > capability.baselineBalance ||
    capability.baselineBalance > channelTotal(state)
  ) {
    throw new ProtocolValidationError(
      "INVALID_CAPABILITY",
      "capability does not match the channel terms",
    );
  }

  const participantBalance = participantIsA
    ? state.balanceA
    : state.balanceB;
  const minimumBalance =
    capability.baselineBalance - capability.maxNetSpend;

  if (participantBalance < minimumBalance) {
    throw new ProtocolValidationError(
      "CAPABILITY_SPEND_EXCEEDED",
      "state exceeds the capability's maximum net spend",
    );
  }

  return { participantBalance, minimumBalance };
}
