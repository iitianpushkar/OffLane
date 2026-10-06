import {
  channelCapabilityTypes,
  channelStateTypes,
  createRpcMessage,
  encodeChannelCapability,
  encodeChannelState,
  encodeEncryptedEnvelope,
  encodeStateAuthorization,
  hashChannelState,
  hashEncryptedEnvelope,
  protocolRequestMethods,
  RpcMessageType,
  type Address,
  type Bytes32,
  type ChannelCapability,
  type ChannelState,
  type EncryptedEnvelope,
  type ProtocolMethod,
  type RpcMessage,
  type RpcPayload,
  type StateAuthorization,
} from "@offlane/protocol";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { RelayCore, relayRequestMethods } from "./core.js";
import type { RelaySession } from "./hub.js";
import { MemoryRelayStore } from "./store.js";
import { ViemAuthorizationVerifier } from "./verifier.js";

const CHANNEL = `0x${"11".repeat(32)}` as Bytes32;
const EMPTY_HASH = `0x${"00".repeat(32)}` as Bytes32;
const TOKEN = "0x0000000000000000000000000000000000000020" as Address;
const MANAGER = "0x00000000000000000000000000000000000000d4" as Address;
const NOW = 1_700_000_000_000;
const domain = {
  name: "Tempo.ChannelManager",
  version: "1",
  chainId: 42431,
  verifyingContract: MANAGER,
} as const;

const alice = privateKeyToAccount(`0x${"01".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"02".repeat(32)}`);
const aliceAgent = privateKeyToAccount(`0x${"03".repeat(32)}`);

function session(id: string): RelaySession & { events: RpcMessage[] } {
  const events: RpcMessage[] = [];
  return {
    id,
    signer: undefined,
    participants: new Set(),
    events,
    send: (message) => events.push(message),
  };
}

let requestId = 1;
function request(method: ProtocolMethod, payload: RpcPayload): RpcMessage {
  return createRpcMessage(RpcMessageType.Request, requestId++, method, payload, NOW);
}

async function authenticate(
  core: RelayCore,
  relaySession: RelaySession,
  account: PrivateKeyAccount,
): Promise<void> {
  const challenge = await core.handle(
    relaySession,
    request("auth.v1.request_challenge", { signer: account.address }),
  );
  const message = challenge.message as string;
  const signature = await account.signMessage({ message });
  await core.handle(
    relaySession,
    request("auth.v1.verify", {
      challengeId: challenge.challengeId,
      signer: account.address,
      signature,
    }),
  );
}

async function directAuthorization(
  account: PrivateKeyAccount,
  state: ChannelState,
): Promise<StateAuthorization> {
  return {
    kind: "direct",
    stateSignature: await account.signTypedData({
      domain,
      types: channelStateTypes,
      primaryType: "ChannelState",
      message: state,
    }),
  };
}

async function capabilityAuthorization(
  capability: ChannelCapability,
  state: ChannelState,
): Promise<StateAuthorization> {
  const [capabilitySignature, stateSignature] = await Promise.all([
    alice.signTypedData({
      domain,
      types: channelCapabilityTypes,
      primaryType: "ChannelCapability",
      message: capability,
    }),
    aliceAgent.signTypedData({
      domain,
      types: channelStateTypes,
      primaryType: "ChannelState",
      message: state,
    }),
  ]);
  return { kind: "capability", capability, capabilitySignature, stateSignature };
}

function proposalPayload(
  proposalId: Bytes32,
  proposer: Address,
  baseStateHash: Bytes32,
  state: ChannelState,
  authorization: StateAuthorization,
): RpcPayload {
  return {
    proposalId,
    proposer,
    baseStateHash,
    state: encodeChannelState(state),
    authorization: encodeStateAuthorization(authorization),
  };
}

function acceptancePayload(
  proposalId: Bytes32,
  accepter: Address,
  state: ChannelState,
  authorization: StateAuthorization,
): RpcPayload {
  return {
    proposalId,
    accepter,
    state: encodeChannelState(state),
    authorization: encodeStateAuthorization(authorization),
  };
}

describe("RelayCore", () => {
  it("keeps its router aligned with every protocol request method", () => {
    expect([...relayRequestMethods].sort()).toEqual([...protocolRequestMethods].sort());
  });

  it("rejects stale requests before routing", async () => {
    const core = new RelayCore(
      new MemoryRelayStore(),
      new ViemAuthorizationVerifier(domain),
      domain,
      undefined,
      { now: () => NOW, maxRequestAgeMs: 100 },
    );
    const stale = createRpcMessage(
      RpcMessageType.Request,
      1,
      "node.v1.ping",
      {},
      NOW - 101,
    );

    await expect(core.handle(session("stale"), stale)).rejects.toMatchObject({
      code: "STALE_REQUEST",
    });
  });

  it("authenticates an agent and settles A-to-B then B-to-A off-chain", async () => {
    const store = new MemoryRelayStore();
    const initial: ChannelState = {
      channelId: CHANNEL,
      nonce: 0n,
      balanceA: 100n,
      balanceB: 100n,
      appDataHash: EMPTY_HASH,
    };
    await store.saveChannel({
      participantA: alice.address,
      participantB: bob.address,
      token: TOKEN,
      status: "open",
      current: initial,
    });
    const core = new RelayCore(
      store,
      new ViemAuthorizationVerifier(domain),
      domain,
      undefined,
      { now: () => NOW },
    );
    const aliceSession = session("alice-agent");
    const bobSession = session("bob");
    await authenticate(core, aliceSession, aliceAgent);
    await authenticate(core, bobSession, bob);

    const capability: ChannelCapability = {
      protocolVersion: 1,
      channelId: CHANNEL,
      participant: alice.address,
      delegatedSigner: aliceAgent.address,
      counterparty: bob.address,
      token: TOKEN,
      baselineBalance: 100n,
      maxNetSpend: 30n,
      capabilityNonce: 1n,
    };
    const capabilitySignature = await alice.signTypedData({
      domain,
      types: channelCapabilityTypes,
      primaryType: "ChannelCapability",
      message: capability,
    });
    await core.handle(
      aliceSession,
      request("channels.v1.register_capability", {
        capability: encodeChannelCapability(capability),
        capabilitySignature,
      }),
    );
    const agentView = await core.handle(
      aliceSession,
      request("channels.v1.get_state", { channelId: CHANNEL }),
    );
    expect(agentView.state).toEqual(encodeChannelState(initial));
    const aToB: ChannelState = {
      ...initial,
      nonce: 1n,
      balanceA: 90n,
      balanceB: 110n,
    };
    const proposalOne = `0x${"21".repeat(32)}` as Bytes32;
    const aliceAuthorization = await capabilityAuthorization(capability, aToB);
    await core.handle(
      aliceSession,
      request(
        "channels.v1.propose_state",
        proposalPayload(
          proposalOne,
          alice.address,
          hashChannelState(domain, initial),
          aToB,
          aliceAuthorization,
        ),
      ),
    );
    expect(bobSession.events.at(-1)?.method).toBe("channels.v1.state_proposed");

    const bobAcceptance = await directAuthorization(bob, aToB);
    await core.handle(
      bobSession,
      request(
        "channels.v1.accept_state",
        acceptancePayload(proposalOne, bob.address, aToB, bobAcceptance),
      ),
    );

    const bToA: ChannelState = {
      ...aToB,
      nonce: 2n,
      balanceA: 105n,
      balanceB: 95n,
    };
    const proposalTwo = `0x${"22".repeat(32)}` as Bytes32;
    const bobProposalAuthorization = await directAuthorization(bob, bToA);
    await core.handle(
      bobSession,
      request(
        "channels.v1.propose_state",
        proposalPayload(
          proposalTwo,
          bob.address,
          hashChannelState(domain, aToB),
          bToA,
          bobProposalAuthorization,
        ),
      ),
    );
    expect(aliceSession.events.at(-1)?.method).toBe("channels.v1.state_proposed");

    const aliceAcceptance = await capabilityAuthorization(capability, bToA);
    await core.handle(
      aliceSession,
      request(
        "channels.v1.accept_state",
        acceptancePayload(proposalTwo, alice.address, bToA, aliceAcceptance),
      ),
    );

    const stored = await store.getChannel(CHANNEL);
    expect(stored?.current).toEqual(bToA);
    expect(stored?.authorizationA?.kind).toBe("capability");
    expect(stored?.authorizationB?.kind).toBe("direct");
    expect(aliceSession.events.at(-1)?.method).toBe("channels.v1.state_updated");
    expect(bobSession.events.at(-1)?.method).toBe("channels.v1.state_updated");
  });

  it("rejects a capability that exceeds the agent's spending limit", async () => {
    const store = new MemoryRelayStore();
    const initial: ChannelState = {
      channelId: CHANNEL,
      nonce: 0n,
      balanceA: 100n,
      balanceB: 100n,
      appDataHash: EMPTY_HASH,
    };
    await store.saveChannel({
      participantA: alice.address,
      participantB: bob.address,
      token: TOKEN,
      status: "open",
      current: initial,
    });
    const core = new RelayCore(
      store,
      new ViemAuthorizationVerifier(domain),
      domain,
      undefined,
      { now: () => NOW },
    );
    const aliceSession = session("limited-agent");
    await authenticate(core, aliceSession, aliceAgent);
    const state: ChannelState = {
      ...initial,
      nonce: 1n,
      balanceA: 69n,
      balanceB: 131n,
    };
    const capability: ChannelCapability = {
      protocolVersion: 1,
      channelId: CHANNEL,
      participant: alice.address,
      delegatedSigner: aliceAgent.address,
      counterparty: bob.address,
      token: TOKEN,
      baselineBalance: 100n,
      maxNetSpend: 30n,
      capabilityNonce: 2n,
    };

    await expect(
      core.handle(
        aliceSession,
        request(
          "channels.v1.propose_state",
          proposalPayload(
            `0x${"23".repeat(32)}` as Bytes32,
            alice.address,
            hashChannelState(domain, initial),
            state,
            await capabilityAuthorization(capability, state),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
      message: "proposal authorization is invalid",
    });
  });

  it("routes, persists, acknowledges, and binds encrypted messages to states", async () => {
    const store = new MemoryRelayStore();
    const initial: ChannelState = {
      channelId: CHANNEL,
      nonce: 0n,
      balanceA: 100n,
      balanceB: 100n,
      appDataHash: EMPTY_HASH,
    };
    await store.saveChannel({
      participantA: alice.address,
      participantB: bob.address,
      token: TOKEN,
      status: "open",
      current: initial,
    });
    const core = new RelayCore(
      store,
      new ViemAuthorizationVerifier(domain),
      domain,
      undefined,
      { now: () => NOW },
    );
    const aliceSession = session("alice-message");
    const bobSession = session("bob-message");
    await authenticate(core, aliceSession, alice);
    await authenticate(core, bobSession, bob);

    const committed = {
      protocolVersion: 1 as const,
      channelId: CHANNEL,
      sender: alice.address,
      recipient: bob.address,
      sequence: 1n,
      stateNonce: 1n,
      senderPublicKey: `0x${"31".repeat(32)}` as Bytes32,
      recipientPublicKey: `0x${"32".repeat(32)}` as Bytes32,
      encryptionNonce: `0x${"33".repeat(24)}` as `0x${string}`,
      ciphertext: "0x1234" as `0x${string}`,
      contentType: "application/json",
    };
    const envelope: EncryptedEnvelope = {
      ...committed,
      messageId: hashEncryptedEnvelope(committed),
    };
    const sent = await core.handle(
      aliceSession,
      request("messages.v1.send", { envelope: encodeEncryptedEnvelope(envelope) }),
    );
    expect(sent.status).toBe("delivered");
    expect(bobSession.events.at(-1)?.method).toBe("messages.v1.received");

    const listed = await core.handle(
      bobSession,
      request("messages.v1.list", { channelId: CHANNEL }),
    );
    expect((listed.messages as unknown[])).toHaveLength(1);
    await core.handle(
      bobSession,
      request("messages.v1.acknowledge", {
        channelId: CHANNEL,
        messageId: envelope.messageId,
      }),
    );
    expect((await store.getMessage(envelope.messageId))?.status).toBe("acknowledged");
    expect(aliceSession.events.at(-1)?.method).toBe("messages.v1.acknowledged");

    const next: ChannelState = {
      ...initial,
      nonce: 1n,
      balanceA: 90n,
      balanceB: 110n,
      appDataHash: envelope.messageId,
    };
    const proposalId = `0x${"44".repeat(32)}` as Bytes32;
    await core.handle(
      aliceSession,
      request(
        "channels.v1.propose_state",
        proposalPayload(
          proposalId,
          alice.address,
          hashChannelState(domain, initial),
          next,
          await directAuthorization(alice, next),
        ),
      ),
    );
    await core.handle(
      bobSession,
      request(
        "channels.v1.accept_state",
        acceptancePayload(
          proposalId,
          bob.address,
          next,
          await directAuthorization(bob, next),
        ),
      ),
    );
    expect((await store.getChannel(CHANNEL))?.current.appDataHash).toBe(
      envelope.messageId,
    );
  });
});
