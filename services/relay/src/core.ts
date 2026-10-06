import { randomBytes } from "node:crypto";
import {
  authChallengeRequestWireSchema,
  authVerifyRequestWireSchema,
  capabilityRegistrationWireSchema,
  createRpcMessage,
  encodeChannelState,
  encodeEncryptedMessageRecord,
  encodeStateAuthorization,
  hashEncryptedEnvelope,
  hashChannelState,
  parseStateAcceptancePayload,
  parseStateProposalPayload,
  parseStateQueryPayload,
  messageAcknowledgementWireSchema,
  messageListWireSchema,
  messageSendWireSchema,
  protocolRequestMethods,
  resolveProposalCollision,
  RpcMessageType,
  stateRejectionWireSchema,
  validatePaymentTransition,
  type Address,
  type Bytes32,
  type ProtocolMethod,
  type RpcMessage,
  type RpcPayload,
  type StateAuthorization,
} from "@offlane/protocol";
import { type TypedDataDomain } from "viem";
import { RelayError } from "./errors.js";
import { SessionHub, type RelaySession } from "./hub.js";
import type { RelayChannel, RelayStore } from "./store.js";
import type { AuthorizationVerifier } from "./verifier.js";

interface Challenge {
  sessionId: string;
  signer: Address;
  message: string;
  expiresAt: number;
}

export interface RelayCoreOptions {
  challengeTtlMs?: number;
  maxRequestAgeMs?: number;
  now?: () => number;
}

export const relayRequestMethods = [...protocolRequestMethods] as const;

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function participantForSession(
  session: RelaySession,
  participant: Address,
  authorization: StateAuthorization,
  verifier: AuthorizationVerifier,
): void {
  if (!session.signer) {
    throw new RelayError("UNAUTHENTICATED", "authenticate before using channel methods");
  }
  const expected = verifier.authorizationSigner(participant, authorization);
  if (!sameAddress(session.signer, expected)) {
    throw new RelayError(
      "SIGNER_MISMATCH",
      "authenticated signer does not match the state authorization",
    );
  }
}

function counterparty(channel: RelayChannel, participant: Address): Address {
  if (sameAddress(participant, channel.participantA)) return channel.participantB;
  if (sameAddress(participant, channel.participantB)) return channel.participantA;
  throw new RelayError("UNKNOWN_PARTICIPANT", "address is not a channel participant");
}

export class RelayCore {
  private readonly challenges = new Map<string, Challenge>();
  private readonly challengeBySession = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly challengeTtlMs: number;
  private readonly maxRequestAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: RelayStore,
    private readonly verifier: AuthorizationVerifier,
    private readonly domain: TypedDataDomain,
    private readonly hub = new SessionHub(),
    options: RelayCoreOptions = {},
  ) {
    this.challengeTtlMs = options.challengeTtlMs ?? 60_000;
    this.maxRequestAgeMs = options.maxRequestAgeMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (this.challengeTtlMs <= 0 || this.maxRequestAgeMs <= 0) {
      throw new Error("relay time limits must be positive");
    }
  }

  disconnect(session: RelaySession): void {
    const challengeKey = this.challengeBySession.get(session.id);
    if (challengeKey) this.challenges.delete(challengeKey);
    this.challengeBySession.delete(session.id);
    this.hub.remove(session);
  }

  async handle(session: RelaySession, request: RpcMessage): Promise<RpcPayload> {
    if (request.type !== RpcMessageType.Request) {
      throw new RelayError("INVALID_MESSAGE", "relay accepts request messages only");
    }
    if (Math.abs(this.now() - request.timestamp) > this.maxRequestAgeMs) {
      throw new RelayError("STALE_REQUEST", "request timestamp is outside the allowed window");
    }

    switch (request.method) {
      case "auth.v1.request_challenge":
        return this.requestChallenge(session, request.payload);
      case "auth.v1.verify":
        return this.verifyChallenge(session, request.payload);
      case "node.v1.ping":
        return { ok: true };
      case "channels.v1.propose_state":
        return this.proposeState(session, request.payload);
      case "channels.v1.register_capability":
        return this.registerCapability(session, request.payload);
      case "channels.v1.accept_state":
        return this.acceptState(session, request.payload);
      case "channels.v1.reject_state":
        return this.rejectState(session, request.payload);
      case "channels.v1.get_state":
        return this.getState(session, request.payload);
      case "messages.v1.send":
        return this.sendMessage(session, request.payload);
      case "messages.v1.list":
        return this.listMessages(session, request.payload);
      case "messages.v1.acknowledge":
        return this.acknowledgeMessage(session, request.payload);
      default:
        throw new RelayError("METHOD_NOT_FOUND", `unsupported method: ${request.method}`);
    }
  }

  private requestChallenge(session: RelaySession, payload: RpcPayload): RpcPayload {
    const { signer } = authChallengeRequestWireSchema.parse(payload);
    const challengeId = `0x${randomBytes(32).toString("hex")}` as Bytes32;
    const oldChallengeKey = this.challengeBySession.get(session.id);
    if (oldChallengeKey) this.challenges.delete(oldChallengeKey);
    const expiresAt = this.now() + this.challengeTtlMs;
    const message = [
      "OffLane relay authentication",
      `Session: ${session.id}`,
      `Signer: ${signer.toLowerCase()}`,
      `Challenge: ${challengeId}`,
      `Expires: ${expiresAt}`,
    ].join("\n");
    this.challenges.set(challengeId.toLowerCase(), {
      sessionId: session.id,
      signer,
      message,
      expiresAt,
    });
    this.challengeBySession.set(session.id, challengeId.toLowerCase());
    return { challengeId, message, expiresAt };
  }

  private async verifyChallenge(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const parsed = authVerifyRequestWireSchema.parse(payload);
    const key = parsed.challengeId.toLowerCase();
    const challenge = this.challenges.get(key);
    this.challenges.delete(key);
    if (this.challengeBySession.get(session.id) === key) {
      this.challengeBySession.delete(session.id);
    }
    if (
      !challenge ||
      challenge.sessionId !== session.id ||
      !sameAddress(challenge.signer, parsed.signer) ||
      challenge.expiresAt < this.now()
    ) {
      throw new RelayError("INVALID_CHALLENGE", "challenge is missing, expired, or mismatched");
    }
    if (
      !(await this.verifier.verifyRelayChallenge(
        parsed.signer,
        challenge.message,
        parsed.signature,
      ))
    ) {
      throw new RelayError("INVALID_SIGNATURE", "challenge signature is invalid");
    }
    this.hub.authenticate(session, parsed.signer);
    return { signer: parsed.signer };
  }

  private async proposeState(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const proposal = parseStateProposalPayload(payload);
    return this.withChannelLock(proposal.state.channelId, async () => {
      const channel = await this.requireOpenChannel(proposal.state.channelId);
      const recipient = counterparty(channel, proposal.proposer);
      participantForSession(session, proposal.proposer, proposal.authorization, this.verifier);
      const currentHash = hashChannelState(this.domain, channel.current);
      if (proposal.baseStateHash.toLowerCase() !== currentHash.toLowerCase()) {
        throw new RelayError("STALE_STATE", "proposal is not based on the latest signed state");
      }
      validatePaymentTransition(channel, proposal.state);
      if (proposal.state.appDataHash !== `0x${"00".repeat(32)}`) {
        const message = await this.store.getMessage(proposal.state.appDataHash);
        if (
          !message ||
          message.envelope.channelId.toLowerCase() !== proposal.state.channelId.toLowerCase() ||
          message.envelope.stateNonce !== proposal.state.nonce ||
          !sameAddress(message.envelope.sender, proposal.proposer) ||
          !sameAddress(message.envelope.recipient, recipient)
        ) {
          throw new RelayError(
            "INVALID_APP_DATA",
            "state appDataHash is not a matching encrypted message commitment",
          );
        }
      }
      if (
        !(await this.verifier.verifyStateAuthorization(
          channel,
          proposal.proposer,
          proposal.state,
          proposal.authorization,
        ))
      ) {
        throw new RelayError("INVALID_SIGNATURE", "proposal authorization is invalid");
      }
      this.hub.authorizeParticipant(session, proposal.proposer);

      const duplicate = await this.store.getPending(proposal.proposalId);
      if (duplicate) {
        throw new RelayError("DUPLICATE_PROPOSAL", "proposal ID is already pending");
      }
      const existing = await this.store.getPendingByChannel(proposal.state.channelId);
      if (
        existing &&
        existing.proposal.proposalId.toLowerCase() !== proposal.proposalId.toLowerCase()
      ) {
        const resolution = resolveProposalCollision(
          channel,
          currentHash,
          existing.proposal,
          proposal,
        );
        if (resolution.winner.proposalId !== proposal.proposalId) {
          throw new RelayError("PROPOSAL_CONFLICT", "another proposal won deterministic ordering");
        }
        await this.store.deletePending(existing.proposal.proposalId);
        this.publish(
          existing.proposal.proposer,
          "channels.v1.state_rejected",
          {
            proposalId: existing.proposal.proposalId,
            channelId: proposal.state.channelId,
            reason: "superseded by deterministic proposal ordering",
          },
        );
      }

      await this.store.savePending({ proposal, createdAt: this.now() });
      this.publish(recipient, "channels.v1.state_proposed", {
        ...proposal,
        state: encodeChannelState(proposal.state),
        authorization: encodeStateAuthorization(proposal.authorization),
      });
      return { proposalId: proposal.proposalId, status: "pending" };
    });
  }

  private async registerCapability(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    if (!session.signer) {
      throw new RelayError("UNAUTHENTICATED", "authenticate before registering a capability");
    }
    const { capability, capabilitySignature } =
      capabilityRegistrationWireSchema.parse(payload);
    const channel = await this.requireOpenChannel(capability.channelId);
    if (!sameAddress(session.signer, capability.delegatedSigner)) {
      throw new RelayError(
        "SIGNER_MISMATCH",
        "authenticated signer is not the capability delegate",
      );
    }
    counterparty(channel, capability.participant);
    if (
      !(await this.verifier.verifyCapability(
        channel,
        channel.current,
        capability,
        capabilitySignature,
      ))
    ) {
      throw new RelayError("INVALID_CAPABILITY", "capability authorization is invalid");
    }
    this.hub.authorizeParticipant(session, capability.participant);
    return {
      channelId: capability.channelId,
      participant: capability.participant,
      delegatedSigner: capability.delegatedSigner,
      status: "registered",
    };
  }

  private async acceptState(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const acceptance = parseStateAcceptancePayload(payload);
    return this.withChannelLock(acceptance.state.channelId, async () => {
      const channel = await this.requireOpenChannel(acceptance.state.channelId);
      const pending = await this.store.getPending(acceptance.proposalId);
      if (!pending) throw new RelayError("PROPOSAL_NOT_FOUND", "pending proposal was not found");
      if (
        hashChannelState(this.domain, pending.proposal.state).toLowerCase() !==
        hashChannelState(this.domain, acceptance.state).toLowerCase()
      ) {
        throw new RelayError("STATE_MISMATCH", "accepted state differs from the proposal");
      }
      const expectedAccepter = counterparty(channel, pending.proposal.proposer);
      if (!sameAddress(acceptance.accepter, expectedAccepter)) {
        throw new RelayError("UNKNOWN_PARTICIPANT", "only the counterparty may accept a proposal");
      }
      participantForSession(session, acceptance.accepter, acceptance.authorization, this.verifier);
      if (
        !(await this.verifier.verifyStateAuthorization(
          channel,
          acceptance.accepter,
          acceptance.state,
          acceptance.authorization,
        ))
      ) {
        throw new RelayError("INVALID_SIGNATURE", "acceptance authorization is invalid");
      }
      this.hub.authorizeParticipant(session, acceptance.accepter);

      await this.store.commitAccepted(channel, acceptance.proposalId, acceptance);
      const updated = await this.requireChannel(acceptance.state.channelId);
      const eventPayload = this.channelPayload(updated);
      this.publish(updated.participantA, "channels.v1.state_updated", eventPayload);
      this.publish(updated.participantB, "channels.v1.state_updated", eventPayload);
      return { proposalId: acceptance.proposalId, status: "accepted" };
    });
  }

  private async rejectState(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const rejection = stateRejectionWireSchema.parse(payload);
    return this.withChannelLock(rejection.channelId, async () => {
      const channel = await this.requireChannel(rejection.channelId);
      const pending = await this.store.getPending(rejection.proposalId);
      if (!pending) throw new RelayError("PROPOSAL_NOT_FOUND", "pending proposal was not found");
      if (
        pending.proposal.state.channelId.toLowerCase() !== rejection.channelId.toLowerCase()
      ) {
        throw new RelayError("CHANNEL_MISMATCH", "proposal belongs to a different channel");
      }
      const rejectingParticipant = counterparty(channel, pending.proposal.proposer);
      if (!this.hub.isAuthorized(session, rejectingParticipant)) {
        throw new RelayError("SIGNER_MISMATCH", "only the counterparty may reject a proposal");
      }
      await this.store.deletePending(rejection.proposalId);
      this.publish(
        pending.proposal.proposer,
        "channels.v1.state_rejected",
        rejection,
      );
      return { proposalId: rejection.proposalId, status: "rejected" };
    });
  }

  private async getState(session: RelaySession, payload: RpcPayload): Promise<RpcPayload> {
    const { channelId } = parseStateQueryPayload(payload);
    const channel = await this.requireChannel(channelId);
    if (
      !this.hub.isAuthorized(session, channel.participantA) &&
      !this.hub.isAuthorized(session, channel.participantB)
    ) {
      throw new RelayError("UNAUTHORIZED", "only a channel participant may read its state");
    }
    return this.channelPayload(channel);
  }

  private async sendMessage(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const { envelope } = messageSendWireSchema.parse(payload);
    const channel = await this.requireOpenChannel(envelope.channelId);
    const recipient = counterparty(channel, envelope.sender);
    if (!sameAddress(recipient, envelope.recipient)) {
      throw new RelayError("UNKNOWN_PARTICIPANT", "message recipient is not the counterparty");
    }
    if (!this.hub.isAuthorized(session, envelope.sender)) {
      throw new RelayError("SIGNER_MISMATCH", "session is not authorized for message sender");
    }
    if (envelope.stateNonce !== channel.current.nonce + 1n) {
      throw new RelayError("INVALID_NONCE", "message must bind the next channel state nonce");
    }
    if (
      hashEncryptedEnvelope(envelope).toLowerCase() !==
      envelope.messageId.toLowerCase()
    ) {
      throw new RelayError("INVALID_MESSAGE", "encrypted message commitment is invalid");
    }
    const sentAt = this.now();
    await this.store.saveMessage({ envelope, status: "sent", sentAt });
    const delivered = this.publish(envelope.recipient, "messages.v1.received", {
      envelope: encodeEncryptedMessageRecord({ envelope, status: "sent", sentAt }).envelope,
    });
    if (delivered > 0) {
      await this.store.markMessageDelivered(envelope.messageId, this.now());
    }
    return {
      messageId: envelope.messageId,
      status: delivered > 0 ? "delivered" : "sent",
    };
  }

  private async listMessages(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const { channelId, afterSequence } = messageListWireSchema.parse(payload);
    const channel = await this.requireChannel(channelId);
    const recipient = this.authorizedParticipant(session, channel);
    let messages = await this.store.listMessages(channelId, recipient, afterSequence);
    const deliveredAt = this.now();
    for (const message of messages) {
      if (message.status === "sent") {
        await this.store.markMessageDelivered(message.envelope.messageId, deliveredAt);
      }
    }
    messages = await this.store.listMessages(channelId, recipient, afterSequence);
    return { messages: messages.map(encodeEncryptedMessageRecord) };
  }

  private async acknowledgeMessage(
    session: RelaySession,
    payload: RpcPayload,
  ): Promise<RpcPayload> {
    const { channelId, messageId } = messageAcknowledgementWireSchema.parse(payload);
    const message = await this.store.getMessage(messageId);
    if (!message || message.envelope.channelId.toLowerCase() !== channelId.toLowerCase()) {
      throw new RelayError("MESSAGE_NOT_FOUND", "encrypted message was not found");
    }
    if (!this.hub.isAuthorized(session, message.envelope.recipient)) {
      throw new RelayError("SIGNER_MISMATCH", "only the recipient may acknowledge a message");
    }
    const acknowledgedAt = this.now();
    await this.store.acknowledgeMessage(messageId, acknowledgedAt);
    this.publish(message.envelope.sender, "messages.v1.acknowledged", {
      channelId,
      messageId,
      acknowledgedAt,
    });
    return { channelId, messageId, status: "acknowledged", acknowledgedAt };
  }

  private authorizedParticipant(session: RelaySession, channel: RelayChannel): Address {
    if (this.hub.isAuthorized(session, channel.participantA)) return channel.participantA;
    if (this.hub.isAuthorized(session, channel.participantB)) return channel.participantB;
    throw new RelayError("UNAUTHORIZED", "session is not authorized for this channel");
  }

  private channelPayload(channel: RelayChannel): RpcPayload {
    return {
      participantA: channel.participantA,
      participantB: channel.participantB,
      token: channel.token,
      state: encodeChannelState(channel.current),
      ...(channel.authorizationA
        ? { authorizationA: encodeStateAuthorization(channel.authorizationA) }
        : {}),
      ...(channel.authorizationB
        ? { authorizationB: encodeStateAuthorization(channel.authorizationB) }
        : {}),
    };
  }

  private publish(
    signer: Address,
    method: ProtocolMethod,
    payload: RpcPayload,
  ): number {
    return this.hub.publish(
      signer,
      createRpcMessage(RpcMessageType.Event, 0, method, payload, this.now()),
    );
  }

  private async requireChannel(channelId: Bytes32): Promise<RelayChannel> {
    const channel = await this.store.getChannel(channelId);
    if (!channel) throw new RelayError("CHANNEL_NOT_FOUND", "channel is not tracked by the relay");
    return channel;
  }

  private async requireOpenChannel(channelId: Bytes32): Promise<RelayChannel> {
    const channel = await this.requireChannel(channelId);
    if (channel.status !== "open") {
      throw new RelayError("CHANNEL_NOT_OPEN", "channel is not open for off-chain updates");
    }
    return channel;
  }

  private async withChannelLock<T>(channelId: Bytes32, action: () => Promise<T>): Promise<T> {
    const key = channelId.toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
