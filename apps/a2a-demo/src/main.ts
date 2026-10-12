import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  channelCapabilityTypes,
  channelCapabilityWireSchema,
  channelStateTypes,
  channelStateWireSchema,
  hashChannelState,
  messagingKeyCertificateTypes,
  messagingKeyCertificateWireSchema,
  messagingKeyDomain,
  validateCapabilityForState,
  type Address,
  type Bytes32,
  type ChannelCapability,
  type ChannelState,
  type Hex,
  type MessagingKeyCertificate,
  type StateAuthorization,
} from "@offlane/protocol";
import {
  decryptMessageText,
  encryptMessage,
  OfflaneClient,
  WebSocketTransport,
  type MessagingKeyPair,
} from "@offlane/sdk";
import {
  bytesToHex,
  parseUnits,
  verifyTypedData,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebSocket } from "ws";

const MODERATO_CHAIN_ID = 42_431;

interface RawCredentialExport {
  format: string;
  version: number;
  network: {
    name: string;
    chainId: number;
    rpcUrl: string;
    relayUrl: string;
    channelManager: Address;
  };
  identity: {
    owner: Address;
    delegatedSigner: Address;
    delegatedPrivateKey: Hex;
  };
  channel: {
    channelId: Bytes32;
    counterparty: Address;
    token: Address;
    participantRole: "A" | "B";
  };
  authorization: {
    capability: Record<string, unknown>;
    capabilitySignature: Hex;
  };
  messaging: {
    keyPair: MessagingKeyPair;
    certificate: Record<string, unknown>;
    signature: Hex;
  };
}

interface AgentCredentials {
  source: string;
  network: RawCredentialExport["network"];
  owner: Address;
  account: LocalAccount;
  channel: RawCredentialExport["channel"];
  capability: ChannelCapability;
  capabilitySignature: Hex;
  messagingKeyPair: MessagingKeyPair;
  messagingCertificate: MessagingKeyCertificate;
  messagingCertificateSignature: Hex;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireHex(value: unknown, bytes: number, field: string): Hex {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${field} must be ${bytes} bytes of hex`);
  }
  return value as Hex;
}

async function readCredentials(path: string): Promise<AgentCredentials> {
  let raw: RawCredentialExport;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as RawCredentialExport;
  } catch (error) {
    throw new Error(`Cannot read agent credentials at ${path}: ${String(error)}`);
  }
  if (raw.format !== "offlane-agent-credentials" || raw.version !== 1) {
    throw new Error(`${path} is not an OffLane agent credential v1 export`);
  }
  if (raw.network.chainId !== MODERATO_CHAIN_ID) {
    throw new Error(`${path} targets chain ${raw.network.chainId}; this demo only runs on Tempo Moderato ${MODERATO_CHAIN_ID}`);
  }
  const privateKey = requireHex(raw.identity.delegatedPrivateKey, 32, "delegatedPrivateKey");
  const account = privateKeyToAccount(privateKey);
  if (!same(account.address, raw.identity.delegatedSigner)) {
    throw new Error(`${path} delegated private key does not match delegatedSigner`);
  }
  const capability = channelCapabilityWireSchema.parse(raw.authorization.capability);
  const certificate = messagingKeyCertificateWireSchema.parse(raw.messaging.certificate);
  const messagingPrivateKey = requireHex(raw.messaging.keyPair.privateKey, 32, "messaging.privateKey") as Bytes32;
  const messagingPublicKey = requireHex(raw.messaging.keyPair.publicKey, 32, "messaging.publicKey") as Bytes32;
  if (
    !same(capability.participant, raw.identity.owner) ||
    !same(capability.delegatedSigner, account.address) ||
    !same(capability.channelId, raw.channel.channelId) ||
    !same(capability.counterparty, raw.channel.counterparty) ||
    !same(capability.token, raw.channel.token)
  ) {
    throw new Error(`${path} capability does not match its exported identity and channel`);
  }
  if (!same(certificate.owner, raw.identity.owner) || !same(certificate.publicKey, messagingPublicKey)) {
    throw new Error(`${path} messaging certificate does not match its exported messaging identity`);
  }
  const domain = contractDomain(raw.network.chainId, raw.network.channelManager);
  const [validCapability, validMessagingCertificate] = await Promise.all([
    verifyTypedData({
      address: raw.identity.owner,
      domain,
      types: channelCapabilityTypes,
      primaryType: "ChannelCapability",
      message: capability,
      signature: raw.authorization.capabilitySignature,
    }),
    verifyTypedData({
      address: raw.identity.owner,
      domain: messagingKeyDomain(domain),
      types: messagingKeyCertificateTypes,
      primaryType: "MessagingKeyCertificate",
      message: certificate,
      signature: raw.messaging.signature,
    }),
  ]);
  if (!validCapability) throw new Error(`${path} has an invalid wallet capability signature`);
  if (!validMessagingCertificate) throw new Error(`${path} has an invalid messaging certificate signature`);
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (certificate.validFrom > now || certificate.validUntil <= now) {
    throw new Error(`${path} messaging certificate is not currently valid`);
  }
  return {
    source: path,
    network: raw.network,
    owner: raw.identity.owner,
    account,
    channel: raw.channel,
    capability,
    capabilitySignature: raw.authorization.capabilitySignature,
    messagingKeyPair: { privateKey: messagingPrivateKey, publicKey: messagingPublicKey },
    messagingCertificate: certificate,
    messagingCertificateSignature: raw.messaging.signature,
  };
}

function contractDomain(chainId: number, manager: Address): TypedDataDomain {
  return {
    name: "Tempo.ChannelManager",
    version: "1",
    chainId,
    verifyingContract: manager,
  };
}

function relayClient(url: string): OfflaneClient {
  return new OfflaneClient(
    new WebSocketTransport(url, {
      factory: (socketUrl) => new WebSocket(socketUrl) as never,
    }),
    { requestTimeoutMs: 15_000 },
  );
}

async function connectAgent(credentials: AgentCredentials): Promise<OfflaneClient> {
  const client = relayClient(credentials.network.relayUrl);
  await client.connect();
  await client.authenticate({
    address: credentials.account.address,
    signMessage: (message) => credentials.account.signMessage({ message }),
  });
  await client.registerCapability(credentials.capability, credentials.capabilitySignature);
  return client;
}

async function signState(
  credentials: AgentCredentials,
  domain: TypedDataDomain,
  state: ChannelState,
): Promise<StateAuthorization> {
  return {
    kind: "capability",
    stateSignature: await credentials.account.signTypedData({
      domain,
      types: channelStateTypes,
      primaryType: "ChannelState",
      message: state,
    }),
    capability: credentials.capability,
    capabilitySignature: credentials.capabilitySignature,
  };
}

async function currentState(client: OfflaneClient, channelId: Bytes32): Promise<ChannelState> {
  const response = await client.getState(channelId);
  return channelStateWireSchema.parse(response.state);
}

function moveBalance(
  state: ChannelState,
  payer: AgentCredentials,
  amount: bigint,
  appDataHash: Bytes32,
): ChannelState {
  if (amount <= 0n) throw new Error("payment amount must be positive");
  const payerIsA = payer.channel.participantRole === "A";
  const available = payerIsA ? state.balanceA : state.balanceB;
  if (amount > available) throw new Error(`${payer.source} does not have enough channel balance`);
  return {
    ...state,
    nonce: state.nonce + 1n,
    balanceA: payerIsA ? state.balanceA - amount : state.balanceA + amount,
    balanceB: payerIsA ? state.balanceB + amount : state.balanceB - amount,
    appDataHash,
  };
}

async function exchangeAndPay(input: {
  label: string;
  sender: AgentCredentials;
  recipient: AgentCredentials;
  senderClient: OfflaneClient;
  recipientClient: OfflaneClient;
  domain: TypedDataDomain;
  amount: bigint;
  sequence: bigint;
  payload: Record<string, unknown>;
}): Promise<ChannelState> {
  const before = await currentState(input.senderClient, input.sender.channel.channelId);
  const pending = await input.senderClient.getPendingProposal(before.channelId);
  if (pending) {
    throw new Error(`channel already has pending proposal ${pending.proposalId}; resolve it before running the A2A demo`);
  }
  const envelope = encryptMessage({
    channelId: before.channelId,
    sender: input.sender.owner,
    recipient: input.recipient.owner,
    sequence: input.sequence,
    stateNonce: before.nonce + 1n,
    senderKeyPair: input.sender.messagingKeyPair,
    recipientPublicKey: input.recipient.messagingKeyPair.publicKey,
    plaintext: JSON.stringify(input.payload),
  });
  const next = moveBalance(before, input.sender, input.amount, envelope.messageId);
  const terms = {
    participantA: input.sender.channel.participantRole === "A" ? input.sender.owner : input.recipient.owner,
    participantB: input.sender.channel.participantRole === "B" ? input.sender.owner : input.recipient.owner,
    token: input.sender.channel.token,
  };
  validateCapabilityForState(terms, input.sender.capability, next);
  validateCapabilityForState(terms, input.recipient.capability, next);
  await input.senderClient.sendMessage(envelope);
  const proposalId = bytesToHex(randomBytes(32)) as Bytes32;
  await input.senderClient.proposeState({
    proposalId,
    proposer: input.sender.owner,
    baseStateHash: hashChannelState(input.domain, before),
    state: next,
    authorization: await signState(input.sender, input.domain, next),
  });

  const inbox = await input.recipientClient.listMessages(before.channelId);
  const received = inbox.find((record) => same(record.envelope.messageId, envelope.messageId));
  if (!received) throw new Error(`${input.label}: recipient did not receive the encrypted message`);
  const plaintext = decryptMessageText(received.envelope, input.recipient.messagingKeyPair);
  const recovered = JSON.parse(plaintext) as { type?: string };
  if (recovered.type !== input.payload.type) {
    throw new Error(`${input.label}: decrypted payload type does not match`);
  }
  await input.recipientClient.acceptState({
    proposalId,
    accepter: input.recipient.owner,
    state: next,
    authorization: await signState(input.recipient, input.domain, next),
  });
  await input.recipientClient.acknowledgeMessage(before.channelId, envelope.messageId);
  const committed = await currentState(input.recipientClient, before.channelId);
  if (committed.nonce !== next.nonce) throw new Error(`${input.label}: relay did not commit the accepted state`);
  console.log(`${input.label}: ${input.payload.type} decrypted and ${formatPathUsd(input.amount)} PathUSD accepted at nonce ${committed.nonce}`);
  return committed;
}

function formatPathUsd(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function assertPair(first: AgentCredentials, second: AgentCredentials): [AgentCredentials, AgentCredentials] {
  if (!same(first.network.relayUrl, second.network.relayUrl)) throw new Error("exports use different relay URLs");
  if (!same(first.network.channelManager, second.network.channelManager)) throw new Error("exports use different ChannelManager contracts");
  if (!same(first.channel.channelId, second.channel.channelId)) throw new Error("exports belong to different channels");
  if (!same(first.channel.counterparty, second.owner) || !same(second.channel.counterparty, first.owner)) {
    throw new Error("exports are not counterparties of one another");
  }
  if (first.channel.participantRole === second.channel.participantRole) {
    throw new Error("exports claim the same channel participant role");
  }
  return first.channel.participantRole === "A" ? [first, second] : [second, first];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  let [firstPath, secondPath, aToBInput = "0.10", bToAInput = "0.05"] = args;
  if (args.length === 0) {
    firstPath = fileURLToPath(new URL("../credentials/agent-a.json", import.meta.url));
    secondPath = fileURLToPath(new URL("../credentials/agent-b.json", import.meta.url));
    console.log("Using dashboard-saved credentials from apps/a2a-demo/credentials.");
  } else if (!firstPath || !secondPath) {
    throw new Error("usage: pnpm a2a [-- <agent-a.json> <agent-b.json> [a-to-b PathUSD] [b-to-a PathUSD]]");
  }
  const [first, second] = await Promise.all([readCredentials(firstPath), readCredentials(secondPath)]);
  const [agentA, agentB] = assertPair(first, second);
  const amountAtoB = parseUnits(aToBInput, 6);
  const amountBtoA = parseUnits(bToAInput, 6);
  const domain = contractDomain(agentA.network.chainId, agentA.network.channelManager);
  console.log(`Channel: ${agentA.channel.channelId}`);
  console.log(`Agent A: ${agentA.account.address} for ${agentA.owner}`);
  console.log(`Agent B: ${agentB.account.address} for ${agentB.owner}`);
  console.log(`Relay: ${agentA.network.relayUrl}`);

  let clientA: OfflaneClient | undefined;
  let clientB: OfflaneClient | undefined;
  try {
    [clientA, clientB] = await Promise.all([connectAgent(agentA), connectAgent(agentB)]);
    console.log("Both delegated agents authenticated and registered their wallet-signed capabilities.");
    const sequenceBase = BigInt(Date.now()) * 1_000n;
    const taskId = bytesToHex(randomBytes(16));
    await exchangeAndPay({
      label: "A → B",
      sender: agentA,
      recipient: agentB,
      senderClient: clientA,
      recipientClient: clientB,
      domain,
      amount: amountAtoB,
      sequence: sequenceBase,
      payload: {
        type: "a2a.task.request",
        taskId,
        service: "summarize",
        input: "Explain OffLane in one sentence.",
      },
    });
    const final = await exchangeAndPay({
      label: "B → A",
      sender: agentB,
      recipient: agentA,
      senderClient: clientB,
      recipientClient: clientA,
      domain,
      amount: amountBtoA,
      sequence: sequenceBase + 1n,
      payload: {
        type: "a2a.task.response",
        taskId,
        result: "OffLane lets agents exchange encrypted work and bounded off-chain payments on Tempo.",
        paymentReason: "verification reward",
      },
    });
    console.log(`Final balances: A=${formatPathUsd(final.balanceA)} PathUSD, B=${formatPathUsd(final.balanceB)} PathUSD`);
    console.log("A2A credential simulation completed successfully.");
  } finally {
    await Promise.all([clientA?.close(), clientB?.close()]);
  }
}

await main().catch((error) => {
  console.error(`A2A demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
