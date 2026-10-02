import { describe, expect, it } from "vitest";
import {
  buildPaymentState,
  channelCapabilityWireSchema,
  channelStateWireSchema,
  encodeChannelCapability,
  encodeChannelState,
  createRpcMessage,
  decodeRpcMessage,
  encodeRpcMessage,
  hashChannelCapability,
  hashPaymentMetadata,
  ProtocolValidationError,
  resolveProposalCollision,
  RpcMessageType,
  stateAuthorizationWireSchema,
  validateCapabilityForState,
  validatePaymentTransition,
  type Address,
  type Bytes32,
  type ChannelContext,
  type ChannelCapability,
  type PaymentMetadata,
  type StateProposal,
} from "./index.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const CHANNEL = `0x${"11".repeat(32)}` as Bytes32;
const EMPTY_HASH = `0x${"00".repeat(32)}` as Bytes32;
const TOKEN = "0x0000000000000000000000000000000000000020" as Address;
const AGENT = "0x00000000000000000000000000000000000000c3" as Address;

function context(nonce = 0n, balanceA = 100n, balanceB = 100n): ChannelContext {
  return {
    participantA: A,
    participantB: B,
    current: {
      channelId: CHANNEL,
      nonce,
      balanceA,
      balanceB,
      appDataHash: EMPTY_HASH,
    },
  };
}

function proposal(
  base: ChannelContext,
  proposer: Address,
  proposalByte: string,
  payer: Address,
): StateProposal {
  return {
    proposalId: `0x${proposalByte.repeat(64)}` as Bytes32,
    proposer,
    baseStateHash: EMPTY_HASH,
    state: buildPaymentState(base, payer, 1n, EMPTY_HASH),
  };
}

describe("bidirectional payment states", () => {
  it("builds an A-to-B payment", () => {
    const base = context();
    const next = buildPaymentState(base, A, 30n, EMPTY_HASH);

    expect(next).toMatchObject({ nonce: 1n, balanceA: 70n, balanceB: 130n });
    expect(validatePaymentTransition(base, next)).toEqual({
      payer: A,
      payee: B,
      amount: 30n,
    });
  });

  it("builds a later B-to-A payment over the same channel", () => {
    const first = buildPaymentState(context(), A, 30n, EMPTY_HASH);
    const secondContext: ChannelContext = {
      participantA: A,
      participantB: B,
      current: first,
    };
    const second = buildPaymentState(secondContext, B, 50n, EMPTY_HASH);

    expect(second).toMatchObject({ nonce: 2n, balanceA: 120n, balanceB: 80n });
    expect(validatePaymentTransition(secondContext, second)).toEqual({
      payer: B,
      payee: A,
      amount: 50n,
    });
  });

  it("rejects overspending and collateral creation", () => {
    expect(() => buildPaymentState(context(), A, 101n, EMPTY_HASH)).toThrowError(
      new ProtocolValidationError(
        "INSUFFICIENT_BALANCE",
        "payer does not have enough channel balance",
      ),
    );

    const invalid = {
      ...context().current,
      nonce: 1n,
      balanceA: 90n,
      balanceB: 120n,
    };
    expect(() => validatePaymentTransition(context(), invalid)).toThrowError(
      /preserve total channel collateral/,
    );
  });

  it("requires exactly one nonce step", () => {
    const invalid = {
      ...context().current,
      nonce: 2n,
      balanceA: 90n,
      balanceB: 110n,
    };
    expect(() => validatePaymentTransition(context(), invalid)).toThrowError(
      /exactly one/,
    );
  });
});

describe("wire encoding", () => {
  it("round-trips bigint fields as canonical JSON decimal strings", () => {
    const state = buildPaymentState(context(), A, 30n, EMPTY_HASH);
    const decoded = channelStateWireSchema.parse(encodeChannelState(state));
    expect(decoded).toEqual(state);
  });

  it("rejects non-canonical amounts", () => {
    expect(() =>
      channelStateWireSchema.parse({
        ...encodeChannelState(context().current),
        balanceA: "0100",
      }),
    ).toThrow();
  });

  it("round-trips a constrained channel capability", () => {
    const capability: ChannelCapability = {
      protocolVersion: 1,
      channelId: CHANNEL,
      participant: A,
      delegatedSigner: AGENT,
      counterparty: B,
      token: TOKEN,
      baselineBalance: 100n,
      maxNetSpend: 20n,
      capabilityNonce: 7n,
    };

    expect(
      channelCapabilityWireSchema.parse(encodeChannelCapability(capability)),
    ).toEqual(capability);

    const authorization = stateAuthorizationWireSchema.parse({
      kind: "capability",
      stateSignature: "0x1234",
      capability: encodeChannelCapability(capability),
      capabilitySignature: "0xabcd",
    });
    expect(authorization.capability).toEqual(capability);
  });

  it("rejects a capability whose limit exceeds its baseline", () => {
    const encoded = encodeChannelCapability({
      protocolVersion: 1,
      channelId: CHANNEL,
      participant: A,
      delegatedSigner: AGENT,
      counterparty: B,
      token: TOKEN,
      baselineBalance: 100n,
      maxNetSpend: 101n,
      capabilityNonce: 8n,
    });

    expect(() => channelCapabilityWireSchema.parse(encoded)).toThrowError(
      /cannot exceed baselineBalance/,
    );
  });

  it("round-trips the compact versioned RPC frame", () => {
    const message = createRpcMessage(
      RpcMessageType.Request,
      42,
      "channels.v1.get_state",
      { channelId: CHANNEL },
      1_700_000_000_000,
    );

    const encoded = encodeRpcMessage(message);
    expect(JSON.parse(encoded)).toEqual([
      1,
      42,
      "channels.v1.get_state",
      { channelId: CHANNEL },
      1_700_000_000_000,
    ]);
    expect(decodeRpcMessage(encoded)).toEqual(message);
  });

  it("rejects unknown RPC methods and unsafe request IDs", () => {
    expect(() =>
      decodeRpcMessage('[1,1,"channels.v2.unknown",{},1700000000000]'),
    ).toThrow();
    expect(() =>
      decodeRpcMessage(
        `[1,${Number.MAX_SAFE_INTEGER + 1},"node.v1.ping",{},1700000000000]`,
      ),
    ).toThrow();
  });
});

describe("concurrent proposal ordering", () => {
  it("alternates participant priority by nonce", () => {
    const oddBase = context(0n);
    const odd = resolveProposalCollision(
      oddBase,
      EMPTY_HASH,
      proposal(oddBase, B, "1", B),
      proposal(oddBase, A, "f", A),
    );
    expect(odd.winner.proposer).toBe(A);

    const evenBase = context(1n);
    const even = resolveProposalCollision(
      evenBase,
      EMPTY_HASH,
      proposal(evenBase, A, "1", A),
      proposal(evenBase, B, "f", B),
    );
    expect(even.winner.proposer).toBe(B);
  });

  it("rejects a proposal built from a different base state", () => {
    const base = context();
    const stale = {
      ...proposal(base, A, "1", A),
      baseStateHash: `0x${"99".repeat(32)}` as Bytes32,
    };

    expect(() =>
      resolveProposalCollision(
        base,
        EMPTY_HASH,
        stale,
        proposal(base, B, "2", B),
      ),
    ).toThrowError(/share the current state/);
  });
});

describe("application-data commitment", () => {
  it("is deterministic and binds payment direction", () => {
    const metadata: PaymentMetadata = {
      protocolVersion: 1,
      channelId: CHANNEL,
      quoteId: `0x${"22".repeat(32)}`,
      requestHash: `0x${"33".repeat(32)}`,
      serviceId: `0x${"44".repeat(32)}`,
      payer: A,
      payee: B,
      units: 5n,
      amount: 30n,
      previousStateHash: `0x${"55".repeat(32)}`,
    };

    const forward = hashPaymentMetadata(metadata);
    expect(hashPaymentMetadata(metadata)).toBe(forward);
    expect(hashPaymentMetadata({ ...metadata, payer: B, payee: A })).not.toBe(
      forward,
    );
  });
});

describe("agent capability commitment", () => {
  it("binds the delegate, channel and maximum net spend", () => {
    const domain = {
      name: "Tempo.ChannelManager",
      version: "1",
      chainId: 42431,
      verifyingContract:
        "0x00000000000000000000000000000000000000d4" as Address,
    };
    const capability: ChannelCapability = {
      protocolVersion: 1,
      channelId: CHANNEL,
      participant: A,
      delegatedSigner: AGENT,
      counterparty: B,
      token: TOKEN,
      baselineBalance: 100n,
      maxNetSpend: 20n,
      capabilityNonce: 9n,
    };

    const digest = hashChannelCapability(domain, capability);
    expect(hashChannelCapability(domain, capability)).toBe(digest);
    expect(
      hashChannelCapability(domain, { ...capability, maxNetSpend: 21n }),
    ).not.toBe(digest);
    expect(
      hashChannelCapability(domain, {
        ...capability,
        channelId: `0x${"12".repeat(32)}`,
      }),
    ).not.toBe(digest);
  });

  it("mirrors the contract's balance floor in both directions", () => {
    const terms = { participantA: A, participantB: B, token: TOKEN };
    const aliceCapability: ChannelCapability = {
      protocolVersion: 1,
      channelId: CHANNEL,
      participant: A,
      delegatedSigner: AGENT,
      counterparty: B,
      token: TOKEN,
      baselineBalance: 100n,
      maxNetSpend: 20n,
      capabilityNonce: 10n,
    };
    const alicePays = buildPaymentState(context(), A, 20n, EMPTY_HASH);

    expect(
      validateCapabilityForState(terms, aliceCapability, alicePays),
    ).toEqual({ participantBalance: 80n, minimumBalance: 80n });

    const overspend = buildPaymentState(context(), A, 21n, EMPTY_HASH);
    expect(() =>
      validateCapabilityForState(terms, aliceCapability, overspend),
    ).toThrowError(/maximum net spend/);

    const bobCapability: ChannelCapability = {
      ...aliceCapability,
      participant: B,
      delegatedSigner:
        "0x00000000000000000000000000000000000000d5" as Address,
      counterparty: A,
      maxNetSpend: 10n,
      capabilityNonce: 11n,
    };
    const bobPays = buildPaymentState(context(), B, 10n, EMPTY_HASH);
    expect(validateCapabilityForState(terms, bobCapability, bobPays)).toEqual(
      { participantBalance: 90n, minimumBalance: 90n },
    );
  });
});
