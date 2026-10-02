import { ProtocolValidationError } from "./errors.js";
import { validatePaymentTransition } from "./state.js";
import type {
  Address,
  Bytes32,
  ChannelContext,
  ProposalResolution,
  StateProposal,
} from "./types.js";

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isParticipant(context: ChannelContext, address: Address): boolean {
  return (
    sameAddress(context.participantA, address) ||
    sameAddress(context.participantB, address)
  );
}

/**
 * Deterministically serializes two concurrent proposals for the same next
 * nonce. Participant A has priority on odd nonces and participant B on even
 * nonces. This alternation prevents either peer from receiving permanent
 * priority. The losing payment is rebuilt against the accepted state.
 */
export function resolveProposalCollision(
  context: ChannelContext,
  currentStateHash: Bytes32,
  left: StateProposal,
  right: StateProposal,
): ProposalResolution {
  const expectedNonce = context.current.nonce + 1n;
  const channelId = context.current.channelId.toLowerCase();
  const validBase = (proposal: StateProposal): boolean =>
    proposal.state.channelId.toLowerCase() === channelId &&
    proposal.state.nonce === expectedNonce &&
    proposal.baseStateHash.toLowerCase() === currentStateHash.toLowerCase() &&
    isParticipant(context, proposal.proposer);

  if (!validBase(left) || !validBase(right)) {
    throw new ProtocolValidationError(
      "INVALID_PROPOSAL_BASE",
      "concurrent proposals must share the current state and target the next nonce",
    );
  }

  validatePaymentTransition(context, left.state);
  validatePaymentTransition(context, right.state);

  const preferred =
    expectedNonce % 2n === 1n
      ? context.participantA
      : context.participantB;
  const leftPreferred = sameAddress(left.proposer, preferred);
  const rightPreferred = sameAddress(right.proposer, preferred);

  if (leftPreferred !== rightPreferred) {
    return leftPreferred
      ? { winner: left, loser: right, reason: "nonce-priority" }
      : { winner: right, loser: left, reason: "nonce-priority" };
  }

  return left.proposalId.toLowerCase() <= right.proposalId.toLowerCase()
    ? { winner: left, loser: right, reason: "proposal-id" }
    : { winner: right, loser: left, reason: "proposal-id" };
}
