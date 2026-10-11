import {
  channelCapabilityTypes,
  channelStateTypes,
  hashChannelState,
  messagingKeyCertificateTypes,
  messagingKeyDomain,
  stateProposalWireSchema,
  type Address,
  type Bytes32,
  type ChannelCapability,
  type ChannelState,
  type ChannelSummary,
  type EncryptedMessageRecord,
  type Hex,
  type MessagingKeyCertificate,
  type RegisteredMessagingKey,
  type StateProposalMessage,
} from "@offlane/protocol";
import {
  decryptMessageText,
  encryptMessage,
  generateMessagingKeyPair,
  OfflaneClient,
  WebSocketTransport,
  type MessagingKeyPair,
} from "@offlane/sdk";
import {
  createPublicClient,
  bytesToHex,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  connect as connectWallet,
  createConfig,
  disconnect as disconnectWallet,
  getConnectors,
  sendTransaction,
  signMessage,
  signTypedData as wagmiSignTypedData,
  watchAccount,
  watchConnectors,
  type Connector,
} from "@wagmi/core";

interface AppConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  relayUrl: string;
  manager: Address;
  token: Address;
}

interface ChannelIntent {
  protocolVersion: number;
  participantA: Address;
  participantB: Address;
  token: Address;
  depositA: bigint;
  depositB: bigint;
  challengeDuration: number;
  validUntil: number;
  salt: bigint;
}

const intentTypes = {
  ChannelIntent: [
    { name: "protocolVersion", type: "uint8" },
    { name: "participantA", type: "address" },
    { name: "participantB", type: "address" },
    { name: "token", type: "address" },
    { name: "depositA", type: "uint128" },
    { name: "depositB", type: "uint128" },
    { name: "challengeDuration", type: "uint32" },
    { name: "validUntil", type: "uint32" },
    { name: "salt", type: "uint256" },
  ],
} as const;

const erc20Abi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const managerAbi = [
  { type: "function", name: "computeChannelId", stateMutability: "view", inputs: [{ name: "intent", type: "tuple", components: intentTypes.ChannelIntent }], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "openChannel", stateMutability: "nonpayable", inputs: [{ name: "intent", type: "tuple", components: intentTypes.ChannelIntent }, { name: "signatureA", type: "bytes" }], outputs: [{ name: "channelId", type: "bytes32" }] },
  { type: "function", name: "joinChannel", stateMutability: "nonpayable", inputs: [{ name: "intent", type: "tuple", components: intentTypes.ChannelIntent }, { name: "signatureB", type: "bytes" }], outputs: [] },
] as const;

export async function initializeProduct(): Promise<() => void> {
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const config = (await fetch("/api/config").then((response) => response.json())) as AppConfig;
const moderato = defineChain({
  id: config.chainId,
  name: config.chainName,
  nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "Tempo Explorer", url: config.explorerUrl } },
  testnet: true,
});
const walletConfig = createConfig({
  chains: [moderato],
  transports: { [moderato.id]: http(config.rpcUrl) },
  multiInjectedProviderDiscovery: true,
});
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const domain = { name: "Tempo.ChannelManager", version: "1", chainId: config.chainId, verifyingContract: config.manager } as const;
let address: Address | undefined;
let activeConnector: Connector | undefined;
let changingConnector = false;
let resettingWallet = false;
let relay: OfflaneClient | undefined;
let unsubscribeRelayEvents: (() => void) | undefined;
let channels: ChannelSummary[] = [];
let channelsInitialized = false;
let channelFilter: "all" | "open" | "pending" = "all";
let activeChannelId: string | undefined;
let pendingProposal: StateProposalMessage | undefined;
let channelMessages: EncryptedMessageRecord[] = [];
let messagingIdentity: MessagingKeyPair | undefined;
const resolvedMessagingKeys = new Map<string, RegisteredMessagingKey>();
interface AgentCredentialExport {
  format: "offlane-agent-credentials";
  version: 1;
  createdAt: string;
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
    capability: {
      protocolVersion: number;
      channelId: Bytes32;
      participant: Address;
      delegatedSigner: Address;
      counterparty: Address;
      token: Address;
      baselineBalance: string;
      maxNetSpend: string;
      capabilityNonce: string;
    };
    capabilitySignature: Hex;
  };
  messaging: StoredMessagingIdentity;
  warning: string;
}

interface AuthorizedAgent {
  address: Address;
  channelId: string;
  limit: string;
  client: OfflaneClient;
  credentials: AgentCredentialExport;
}

const agents: AuthorizedAgent[] = [];
let selectedAgentExport: AuthorizedAgent | undefined;
type ActivityKind = "wallet" | "relay" | "channel" | "payment" | "message" | "agent";
interface ActivityEntry {
  id: string;
  time: string;
  kind: ActivityKind;
  message: string;
}
const activity: ActivityEntry[] = [];

function toast(message: string, error = false): void {
  const element = $("toast");
  element.textContent = message;
  element.className = error ? "show error" : "show";
  setTimeout(() => (element.className = ""), 3_500);
}

function activityStorageKey(): string | undefined {
  return address ? `offlane:activity:${config.chainId}:${address.toLowerCase()}` : undefined;
}

function loadActivity(): void {
  activity.splice(0);
  const key = activityStorageKey();
  if (!key) return renderActivity();
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as ActivityEntry[];
    activity.push(...stored.filter((entry) =>
      typeof entry.id === "string" &&
      typeof entry.time === "string" &&
      typeof entry.message === "string" &&
      ["wallet", "relay", "channel", "payment", "message", "agent"].includes(entry.kind),
    ).slice(0, 100));
  } catch {
    localStorage.removeItem(key);
  }
  renderActivity();
}

function log(message: string, kind: ActivityKind = "relay"): void {
  activity.unshift({
    id: `${Date.now()}-${crypto.randomUUID()}`,
    time: new Date().toISOString(),
    kind,
    message,
  });
  activity.splice(100);
  const key = activityStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(activity));
  renderActivity();
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

interface StoredMessagingIdentity {
  keyPair: MessagingKeyPair;
  certificate: {
    protocolVersion: 1;
    owner: Address;
    publicKey: Bytes32;
    keyVersion: string;
    validFrom: string;
    validUntil: string;
  };
  signature: Hex;
}

function messagingIdentityStorageKey(): string {
  return `offlane:messaging-identity:${config.chainId}:${address?.toLowerCase()}`;
}

function nextMessageSequence(channelId: string): bigint {
  const key = `${messagingIdentityStorageKey()}:${channelId.toLowerCase()}:sequence`;
  const previous = BigInt(localStorage.getItem(key) ?? "0");
  const timestampFloor = BigInt(Date.now()) * 1_000n;
  const next = previous >= timestampFloor ? previous + 1n : timestampFloor;
  localStorage.setItem(key, next.toString());
  return next;
}

function decodeStoredCertificate(stored: StoredMessagingIdentity): MessagingKeyCertificate {
  return {
    ...stored.certificate,
    keyVersion: BigInt(stored.certificate.keyVersion),
    validFrom: BigInt(stored.certificate.validFrom),
    validUntil: BigInt(stored.certificate.validUntil),
  };
}

function storedMessagingIdentity(): StoredMessagingIdentity {
  const raw = localStorage.getItem(messagingIdentityStorageKey());
  if (!raw) throw new Error("Create and register the wallet messaging identity first.");
  const stored = JSON.parse(raw) as StoredMessagingIdentity;
  decodeStoredCertificate(stored);
  return stored;
}

async function ensureMessagingIdentity(): Promise<void> {
  if (!relay || !address || !activeConnector) throw new Error("Authenticate the wallet first.");
  const storageKey = messagingIdentityStorageKey();
  const raw = localStorage.getItem(storageKey);
  let stored: StoredMessagingIdentity | undefined;
  if (raw) {
    try {
      const candidate = JSON.parse(raw) as StoredMessagingIdentity;
      decodeStoredCertificate(candidate);
      if (!/^0x[0-9a-fA-F]{64}$/.test(candidate.keyPair.privateKey)) throw new Error("invalid private key");
      if (!/^0x[0-9a-fA-F]{64}$/.test(candidate.keyPair.publicKey)) throw new Error("invalid public key");
      stored = candidate;
    } catch {
      localStorage.removeItem(storageKey);
    }
  }
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (
    stored &&
    same(stored.certificate.owner, address) &&
    stored.certificate.publicKey === stored.keyPair.publicKey &&
    BigInt(stored.certificate.validUntil) > now + 86_400n
  ) {
    messagingIdentity = stored.keyPair;
    await relay.registerMessagingKey(decodeStoredCertificate(stored), stored.signature);
    return;
  }

  const keyPair = stored?.keyPair ?? generateMessagingKeyPair();
  const previousVersion = stored ? BigInt(stored.certificate.keyVersion) : 0n;
  const certificate: MessagingKeyCertificate = {
    protocolVersion: 1,
    owner: address,
    publicKey: keyPair.publicKey,
    keyVersion: previousVersion >= BigInt(Date.now()) ? previousVersion + 1n : BigInt(Date.now()),
    validFrom: now - 60n,
    validUntil: now + 30n * 24n * 60n * 60n,
  };
  const signature = await wagmiSignTypedData(walletConfig, {
    account: address,
    connector: activeConnector,
    domain: messagingKeyDomain(domain),
    types: messagingKeyCertificateTypes,
    primaryType: "MessagingKeyCertificate",
    message: certificate,
  });
  await relay.registerMessagingKey(certificate, signature);
  messagingIdentity = keyPair;
  localStorage.setItem(storageKey, JSON.stringify({
    keyPair,
    certificate: {
      ...certificate,
      keyVersion: certificate.keyVersion.toString(),
      validFrom: certificate.validFrom.toString(),
      validUntil: certificate.validUntil.toString(),
    },
    signature,
  } satisfies StoredMessagingIdentity));
  log(`Registered wallet-bound messaging key ${short(keyPair.publicKey)}.`, "message");
}

async function resolveMessagingKey(owner: Address): Promise<RegisteredMessagingKey | undefined> {
  if (!relay) return undefined;
  const registration = await relay.resolveMessagingKey(owner);
  if (!registration) return undefined;
  const valid = await verifyTypedData({
    address: owner,
    domain: messagingKeyDomain(domain),
    types: messagingKeyCertificateTypes,
    primaryType: "MessagingKeyCertificate",
    message: registration.certificate,
    signature: registration.signature,
  });
  if (!valid) throw new Error("Counterparty messaging certificate has an invalid wallet signature.");
  resolvedMessagingKeys.set(owner.toLowerCase(), registration);
  return registration;
}

async function connect(connector: Connector): Promise<void> {
  if (activeConnector) {
    changingConnector = true;
    try {
      await disconnectWallet(walletConfig, { connector: activeConnector });
    } finally {
      changingConnector = false;
    }
  }
  const { accounts } = await connectWallet(walletConfig, { connector, chainId: moderato.id });
  if (!accounts[0]) throw new Error("Wallet did not return an account.");
  address = accounts[0];
  activeConnector = connector;
  loadActivity();
  $("connectGate").hidden = true;
  $("product").hidden = false;
  $("walletButton").textContent = short(address);
  $("addressLine").textContent = `Wallet connected as ${address}. Approve the relay authentication signature.`;
  $("relayState").textContent = "● Authenticating relay…";
  $("relayState").classList.remove("online");
  ($("walletDialog") as HTMLDialogElement).close();
  log(`Wallet ${short(address)} connected. Waiting for relay authentication.`, "wallet");

  relay?.close().catch(() => undefined);
  relay = new OfflaneClient(new WebSocketTransport(config.relayUrl));
  try {
    await relay.connect();
    await relay.authenticate({
      address,
      signMessage: (message) => signMessage(walletConfig, { message, account: address!, connector }),
    });
    unsubscribeRelayEvents?.();
    unsubscribeRelayEvents = relay.onEvent(handleRelayEvent);
    $("addressLine").textContent = `Authenticated as ${address}. Approve the messaging identity once.`;
    $("relayState").textContent = "● Registering messaging key…";
    await ensureMessagingIdentity();
  } catch (error) {
    await relay.close().catch(() => undefined);
    relay = undefined;
    $("relayState").textContent = "● Connection setup failed";
    $("addressLine").textContent = `Wallet connected as ${address}. Reconnect to retry wallet setup.`;
    log(`Wallet setup failed for ${short(address)}.`, "wallet");
    throw error;
  }
  $("relayState").textContent = "● Relay connected";
  $("relayState").classList.add("online");
  $("addressLine").textContent = `Authenticated as ${address}`;
  log(`Wallet ${short(address)} authenticated with the relay.`, "wallet");
  await refreshChannels();
}

function renderWalletOptions(): void {
  const options = getConnectors(walletConfig);
  $("walletOptions").innerHTML = options.length
    ? options.map((connector) => `<button class="wallet-option" data-connector="${connector.uid}">${connector.icon ? `<img class="wallet-icon wallet-image" src="${connector.icon}" alt=""/>` : `<span class="wallet-icon">${connector.name.slice(0, 1).toUpperCase()}</span>`}<span><b>${connector.name}</b><small>${connector.type === "injected" ? "Browser wallet" : connector.type}</small></span></button>`).join("")
    : `<div class="wallet-empty">No browser wallet was detected.<br/>Install a Tempo-compatible wallet, then reload this page.</div>`;
}

function openWalletModal(): void {
  renderWalletOptions();
  ($("walletDialog") as HTMLDialogElement).showModal();
}

async function disconnectForAccountChange(): Promise<void> {
  if (resettingWallet) return;
  resettingWallet = true;
  await relay?.close().catch(() => undefined);
  await disconnectWallet(walletConfig).catch(() => undefined);
  relay = undefined;
  address = undefined;
  activeConnector = undefined;
  messagingIdentity = undefined;
  resolvedMessagingKeys.clear();
  channels = [];
  channelsInitialized = false;
  activity.splice(0);
  renderActivity();
  $("product").hidden = true;
  $("connectGate").hidden = false;
  $("relayState").textContent = "● Relay offline";
  $("relayState").classList.remove("online");
  $("walletButton").textContent = "Connect wallet";
  toast("Wallet account changed. Connect the selected account to authenticate it.");
  resettingWallet = false;
}

async function refreshChannels(): Promise<void> {
  if (!relay) return;
  const previous = new Map(channels.map((channel) => [channel.current.channelId.toLowerCase(), channel]));
  const nextChannels = await relay.listChannels();
  if (channelsInitialized) {
    for (const channel of nextChannels) {
      const before = previous.get(channel.current.channelId.toLowerCase());
      if (!before) {
        log(`Relay discovered channel ${short(channel.current.channelId)} with status ${channel.status}.`, "channel");
        continue;
      }
      if (before.status !== channel.status) {
        log(`Channel ${short(channel.current.channelId)} changed from ${before.status} to ${channel.status}.`, "channel");
      }
      if (channel.current.nonce > before.current.nonce) {
        log(`Channel ${short(channel.current.channelId)} committed payment state nonce ${channel.current.nonce}.`, "payment");
      }
    }
  }
  channels = nextChannels;
  channelsInitialized = true;
  renderChannels();
}

function channelCard(channel: ChannelSummary): string {
  const mineA = address ? same(address, channel.participantA) : false;
  const peer = mineA ? channel.participantB : channel.participantA;
  const mine = mineA ? channel.current.balanceA : channel.current.balanceB;
  const theirs = mineA ? channel.current.balanceB : channel.current.balanceA;
  return `<article class="card" data-channel="${channel.current.channelId}"><div class="top"><span class="pill">${channel.status}</span><code>${short(channel.current.channelId)}</code></div><h3>${short(peer)}</h3><p>Counterparty · nonce ${channel.current.nonce}</p><div class="balances"><div><b>${Number(mine)/1e6}</b><small>Your PathUSD</small></div><div><b>${Number(theirs)/1e6}</b><small>Peer PathUSD</small></div></div></article>`;
}

function openChannelWorkspace(channelId: string): void {
  const channel = channels.find((item) => item.current.channelId === channelId);
  if (!channel || !address) return;
  const mineA = same(address, channel.participantA);
  const peer = mineA ? channel.participantB : channel.participantA;
  $("detailTitle").textContent = short(channel.current.channelId);
  $("detailStatus").textContent = channel.status.toUpperCase();
  $("detailNonce").textContent = channel.current.nonce.toString();
  $("detailMine").textContent = `${Number(mineA ? channel.current.balanceA : channel.current.balanceB)/1e6} PathUSD`;
  $("detailPeer").textContent = `${Number(mineA ? channel.current.balanceB : channel.current.balanceA)/1e6} PathUSD`;
  ($("detailId") as HTMLInputElement).value = channel.current.channelId;
  ($("detailCounterparty") as HTMLInputElement).value = peer;
  ($("detailCommitment") as HTMLInputElement).value = channel.current.appDataHash;
  ($("contractLink") as HTMLAnchorElement).href = `${config.explorerUrl}/address/${config.manager}`;
  ($("detailAgent") as HTMLButtonElement).disabled = channel.status !== "open";
  activeChannelId = channelId;
  if (pendingProposal && !same(pendingProposal.state.channelId, channelId)) pendingProposal = undefined;
  channelMessages = [];
  $("detailMyKey").textContent = messagingIdentity ? short(messagingIdentity.publicKey) : "Unavailable";
  $("detailMyKeyStatus").textContent = messagingIdentity ? "Wallet verified" : "Not registered";
  $("detailPeerKey").textContent = "Resolving from wallet address…";
  $("detailPeerKeyStatus").textContent = "Resolving";
  ($("sendPayment") as HTMLButtonElement).disabled = true;
  renderChannelTraffic();
  void Promise.all([
    refreshChannelTraffic(),
    resolveWorkspaceCounterparty(peer, channel.status === "open"),
  ]).catch((error) => toast(String((error as Error).message ?? error), true));
  const dialog = $("channelDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

async function resolveWorkspaceCounterparty(peer: Address, channelOpen: boolean): Promise<void> {
  const registration = await resolveMessagingKey(peer);
  if (!registration) {
    $("detailPeerKey").textContent = "The counterparty has not registered a messaging key yet.";
    $("detailPeerKeyStatus").textContent = "Waiting for registration";
    ($("sendPayment") as HTMLButtonElement).disabled = true;
    return;
  }
  $("detailPeerKey").textContent = short(registration.certificate.publicKey);
  $("detailPeerKeyStatus").textContent = "Wallet verified";
  ($("sendPayment") as HTMLButtonElement).disabled = !channelOpen;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderChannelTraffic(): void {
  if (!activeChannelId || !address) return;
  $("messageList").innerHTML = channelMessages.length
    ? channelMessages.map((record) => {
        let plaintext = "Unable to decrypt with this browser key.";
        try {
          if (messagingIdentity) plaintext = decryptMessageText(record.envelope, messagingIdentity);
        } catch {}
        return `<div class="traffic-message"><div><b>${short(record.envelope.sender)}</b><span>${record.status}</span></div><p>${escapeHtml(plaintext)}</p><small>nonce ${record.envelope.stateNonce} · ${short(record.envelope.messageId)}</small></div>`;
      }).join("")
    : `<p class="empty">No received messages yet.</p>`;

  if (!pendingProposal || same(pendingProposal.proposer, address)) {
    $("pendingProposal").innerHTML = `<p class="empty">No payment proposal awaiting your approval.</p>`;
    return;
  }
  const channel = channels.find((item) => item.current.channelId === pendingProposal!.state.channelId);
  if (!channel) return;
  const proposerIsA = same(pendingProposal.proposer, channel.participantA);
  const amount = proposerIsA
    ? channel.current.balanceA - pendingProposal.state.balanceA
    : channel.current.balanceB - pendingProposal.state.balanceB;
  $("pendingProposal").innerHTML = `<div class="proposal-review"><b>${Number(amount) / 1e6} PathUSD payment</b><p>${short(pendingProposal.proposer)} proposes nonce ${pendingProposal.state.nonce}.</p><div class="two"><button id="rejectPayment" class="secondary">Reject</button><button id="acceptPayment" class="primary">Sign and accept</button></div></div>`;
}

async function refreshChannelTraffic(): Promise<void> {
  if (!relay || !activeChannelId) return;
  const [messages, proposal] = await Promise.all([
    relay.listMessages(activeChannelId as Bytes32),
    relay.getPendingProposal(activeChannelId as Bytes32),
  ]);
  channelMessages = messages;
  pendingProposal = proposal;
  renderChannelTraffic();
}

function handleRelayEvent(message: { method: string; payload: Record<string, unknown> }): void {
  if (message.method === "channels.v1.state_proposed") {
    pendingProposal = stateProposalWireSchema.parse(message.payload);
    log(`Received payment proposal ${short(pendingProposal.proposalId)} from ${short(pendingProposal.proposer)}.`, "payment");
    toast("A counterparty payment proposal is ready for review.");
    if (activeChannelId && same(pendingProposal.state.channelId, activeChannelId)) {
      void refreshChannelTraffic().catch(() => renderChannelTraffic());
    }
  }
  if (message.method === "channels.v1.state_rejected") {
    pendingProposal = undefined;
    log("The counterparty rejected the pending payment proposal.", "payment");
    toast("Payment proposal rejected by the counterparty.", true);
    renderChannelTraffic();
  }
  if (message.method === "channels.v1.state_updated") {
    pendingProposal = undefined;
    void refreshChannels().then(() => {
      if (!activeChannelId) return;
      openChannelWorkspace(activeChannelId);
    }).catch(() => undefined);
  }
  if (message.method === "messages.v1.received") {
    const envelope = message.payload.envelope as { channelId?: unknown } | undefined;
    const receivedChannel = typeof envelope?.channelId === "string" ? envelope.channelId : activeChannelId;
    log(receivedChannel ? `Received an encrypted message for channel ${short(receivedChannel)}.` : "Received an encrypted channel message.", "message");
    if (activeChannelId && receivedChannel && same(activeChannelId, receivedChannel)) {
      void refreshChannelTraffic().catch(() => undefined);
    }
  }
}

async function proposePayment(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!relay || !address || !activeChannelId) throw new Error("Connect and authenticate with the relay first.");
  const channel = channels.find((item) => item.current.channelId === activeChannelId);
  if (!channel || channel.status !== "open") throw new Error("Select an open channel.");
  if (!messagingIdentity) throw new Error("Your wallet-bound messaging key is unavailable.");
  const existingProposal = await relay.getPendingProposal(activeChannelId as Bytes32);
  if (existingProposal) throw new Error("This channel already has a payment awaiting approval.");
  const amount = parseUnits(($("paymentAmount") as HTMLInputElement).value, 6);
  const mineA = same(address, channel.participantA);
  const available = mineA ? channel.current.balanceA : channel.current.balanceB;
  if (amount <= 0n || amount > available) throw new Error("Payment must be positive and no greater than your channel balance.");
  const recipient = mineA ? channel.participantB : channel.participantA;
  const peerRegistration =
    resolvedMessagingKeys.get(recipient.toLowerCase()) ?? await resolveMessagingKey(recipient);
  if (!peerRegistration) {
    throw new Error("The counterparty must connect to OffLane once to register a messaging key.");
  }
  const nextNonce = channel.current.nonce + 1n;
  const envelope = encryptMessage({
    channelId: activeChannelId as Bytes32,
    sender: address,
    recipient,
    sequence: nextMessageSequence(activeChannelId),
    stateNonce: nextNonce,
    senderKeyPair: messagingIdentity,
    recipientPublicKey: peerRegistration.certificate.publicKey,
    plaintext: ($("paymentMessage") as HTMLTextAreaElement).value,
    contentType: "text/plain",
  });
  const state: ChannelState = {
    channelId: activeChannelId as Bytes32,
    nonce: nextNonce,
    balanceA: mineA ? channel.current.balanceA - amount : channel.current.balanceA + amount,
    balanceB: mineA ? channel.current.balanceB + amount : channel.current.balanceB - amount,
    appDataHash: envelope.messageId,
  };
  const authorization = { kind: "direct" as const, stateSignature: await signTypedData(channelStateTypes, "ChannelState", state) };
  const proposalId = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Bytes32;
  await relay.sendMessage(envelope);
  await relay.proposeState({ proposalId, proposer: address, baseStateHash: hashChannelState(domain, channel.current), state, authorization });
  log(`Proposed ${Number(amount) / 1e6} PathUSD to ${short(recipient)} at nonce ${nextNonce}.`, "payment");
  ($("paymentMessage") as HTMLTextAreaElement).value = "";
  toast("Encrypted message sent. Waiting for the counterparty to accept the payment.");
}

async function acceptPendingPayment(): Promise<void> {
  if (!relay || !address || !pendingProposal) return;
  const proposal = pendingProposal;
  const authorization = { kind: "direct" as const, stateSignature: await signTypedData(channelStateTypes, "ChannelState", proposal.state) };
  await relay.acceptState({ proposalId: proposal.proposalId, accepter: address, state: proposal.state, authorization });
  const matching = channelMessages.find((record) => same(record.envelope.messageId, proposal.state.appDataHash));
  if (matching) await relay.acknowledgeMessage(proposal.state.channelId, matching.envelope.messageId);
  pendingProposal = undefined;
  log(`Accepted payment proposal ${short(proposal.proposalId)} at nonce ${proposal.state.nonce}.`, "payment");
  toast("Payment accepted and the channel state was updated.");
  await refreshChannels();
  openChannelWorkspace(proposal.state.channelId);
}

async function rejectPendingPayment(): Promise<void> {
  if (!relay || !pendingProposal) return;
  const rejected = pendingProposal;
  await relay.rejectState(rejected.proposalId, rejected.state.channelId, "Rejected by counterparty");
  pendingProposal = undefined;
  log(`Rejected payment proposal ${short(rejected.proposalId)}.`, "payment");
  renderChannelTraffic();
  toast("Payment proposal rejected.");
}

function renderChannels(): void {
  const visibleChannels = channelFilter === "all"
    ? channels
    : channels.filter((channel) => channel.status === channelFilter);
  const cards = visibleChannels.length
    ? visibleChannels.map(channelCard).join("")
    : `<p class="empty">No ${channelFilter === "all" ? "" : `${channelFilter} `}channels found.</p>`;
  $("allChannels").innerHTML = cards;
  document.querySelectorAll<HTMLElement>("[data-channel-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.channelFilter === channelFilter);
  });
  $("recentChannels").innerHTML = channels.length
    ? channels.slice(0, 4).map((channel) => `<div class="channel-row"><div><code>${short(channel.current.channelId)}</code><small>${short(same(address!, channel.participantA) ? channel.participantB : channel.participantA)}</small></div><span class="pill">${channel.status}</span><div>${Number(channel.current.balanceA + channel.current.balanceB)/1e6}<small>PathUSD locked</small></div><div>nonce ${channel.current.nonce}</div></div>`).join("")
    : `<p class="empty">Your confirmed channels will appear here.</p>`;
  $("openCount").textContent = String(channels.filter((channel) => channel.status === "open").length);
  const total = channels.reduce((sum, channel) => sum + channel.current.balanceA + channel.current.balanceB, 0n);
  $("lockedTotal").innerHTML = `${Number(total)/1e6} <small>PathUSD</small>`;
  const select = $("agentChannel") as HTMLSelectElement;
  select.innerHTML = channels.filter((channel) => channel.status === "open").map((channel) => `<option value="${channel.current.channelId}">${short(channel.current.channelId)}</option>`).join("");
}

function renderAgents(): void {
  $("agentCount").textContent = String(agents.length);
  $("agentCards").innerHTML = agents.length ? agents.map((agent, index) => `<article class="card"><div class="top"><span class="pill">authorized</span><code>${short(agent.channelId)}</code></div><h3>${short(agent.address)}</h3><p>Delegated payment signer + wallet-certified messaging identity</p><div class="balances"><div><b>${agent.limit}</b><small>PathUSD spend cap</small></div><div><b>JSON</b><small>Agent compatible</small></div></div><button type="button" class="secondary agent-export" data-agent-export="${index}">Export credentials</button></article>`).join("") : `<p class="empty">No agent keys in this tab. Authorize one for an open channel.</p>`;
}

function agentCredentialsJson(agent: AuthorizedAgent): string {
  return JSON.stringify(agent.credentials, null, 2);
}

function showAgentExport(agent: AuthorizedAgent): void {
  selectedAgentExport = agent;
  ($("agentExportOutput") as HTMLTextAreaElement).value = agentCredentialsJson(agent);
  const dialog = $("agentExportDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

function downloadAgentCredentials(agent: AuthorizedAgent): void {
  const blob = new Blob([agentCredentialsJson(agent)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `offlane-agent-${agent.address.slice(2, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  log(`Exported credentials for agent ${short(agent.address)}.`, "agent");
  toast("Agent credentials downloaded. Keep the file private.");
}

function renderActivity(): void {
  $("activityList").innerHTML = activity.length
    ? activity.map((event) => `<div class="event"><time>${new Date(event.time).toLocaleString()}</time><b>${event.kind}</b><span>${escapeHtml(event.message)}</span></div>`).join("")
    : `<p class="empty">No recorded activity for this wallet yet.</p>`;
}

async function signTypedData(types: object, primaryType: string, message: object): Promise<Hex> {
  if (!activeConnector || !address) throw new Error("Connect your wallet first.");
  return wagmiSignTypedData(walletConfig, {
    account: address,
    connector: activeConnector,
    domain,
    types: types as Record<string, readonly { name: string; type: string }[]>,
    primaryType,
    message: message as Record<string, unknown>,
  });
}

async function sendContract(to: Address, data: Hex): Promise<Hex> {
  if (!activeConnector || !address) throw new Error("Connect your wallet first.");
  const hash = await sendTransaction(walletConfig, {
    account: address,
    connector: activeConnector,
    chainId: moderato.id,
    to,
    data,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function openChannel(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!address) return;
  const counterparty = ($("counterparty") as HTMLInputElement).value as Address;
  if (same(address, counterparty)) throw new Error("Counterparty must be a different address.");
  const intent: ChannelIntent = {
    protocolVersion: 1, participantA: address, participantB: counterparty, token: config.token,
    depositA: parseUnits(($("depositA") as HTMLInputElement).value, 6),
    depositB: parseUnits(($("depositB") as HTMLInputElement).value, 6),
    challengeDuration: 3_600, validUntil: Math.floor(Date.now()/1000)+3_600,
    salt: BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))),
  };
  const button = (event.submitter as HTMLButtonElement); button.disabled = true; button.textContent = "Waiting for signatures…";
  try {
    const signature = await signTypedData(intentTypes, "ChannelIntent", intent);
    const channelId = await publicClient.readContract({ address: config.manager, abi: managerAbi, functionName: "computeChannelId", args: [intent] });
    toast("Approve PathUSD in your wallet.");
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.manager, intent.depositA] });
    const approveTx = await sendContract(config.token, approve);
    log(`PathUSD approval confirmed: ${short(approveTx)}.`, "channel");
    toast("Submit the channel open transaction.");
    const open = encodeFunctionData({ abi: managerAbi, functionName: "openChannel", args: [intent, signature] });
    const openTx = await sendContract(config.manager, open);
    log(`Channel ${short(channelId)} opened: ${short(openTx)}.`, "channel");
    const invitation = `offlane://invite/${btoa(JSON.stringify(intent, (_, value) => typeof value === "bigint" ? value.toString() : value))}`;
    ($("inviteOutput") as HTMLTextAreaElement).value = invitation;
    ($("createDialog") as HTMLDialogElement).close();
    ($("inviteDialog") as HTMLDialogElement).showModal();
    toast("Channel opened. Share the invite with your counterparty.");
    setTimeout(() => refreshChannels().catch(() => undefined), 2_500);
  } finally { button.disabled = false; button.textContent = "Review and open channel"; }
}

function decodeInvite(value: string): ChannelIntent {
  const prefix = "offlane://invite/";
  if (!value.startsWith(prefix)) throw new Error("This is not an OffLane invite.");
  const parsed = JSON.parse(atob(value.slice(prefix.length))) as Record<string, unknown>;
  return { ...parsed, depositA: BigInt(String(parsed.depositA)), depositB: BigInt(String(parsed.depositB)), salt: BigInt(String(parsed.salt)) } as unknown as ChannelIntent;
}

async function joinChannel(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!address) return;
  const intent = decodeInvite(($("inviteInput") as HTMLTextAreaElement).value.trim());
  if (!same(address, intent.participantB)) throw new Error("This invite was created for a different counterparty.");
  const signature = await signTypedData(intentTypes, "ChannelIntent", intent);
  toast("Approve your PathUSD deposit.");
  await sendContract(config.token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.manager, intent.depositB] }));
  toast("Submit the join transaction.");
  const hash = await sendContract(config.manager, encodeFunctionData({ abi: managerAbi, functionName: "joinChannel", args: [intent, signature] }));
  log(`Joined a channel in transaction ${short(hash)}.`, "channel");
  ($("joinDialog") as HTMLDialogElement).close();
  toast("Channel joined successfully.");
  setTimeout(() => refreshChannels().catch(() => undefined), 2_500);
}

async function authorizeAgent(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!address) return;
  if (!messagingIdentity) throw new Error("The wallet messaging identity is not ready.");
  const channelId = ($("agentChannel") as HTMLSelectElement).value;
  const channel = channels.find((item) => item.current.channelId === channelId);
  if (!channel) throw new Error("Select an open channel first.");
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key);
  const participantIsA = same(address, channel.participantA);
  const baselineBalance = participantIsA ? channel.current.balanceA : channel.current.balanceB;
  const maxNetSpend = parseUnits(($("agentLimit") as HTMLInputElement).value, 6);
  const capability: ChannelCapability = {
    protocolVersion: 1, channelId: channel.current.channelId, participant: address,
    delegatedSigner: agent.address, counterparty: participantIsA ? channel.participantB : channel.participantA,
    token: channel.token, baselineBalance, maxNetSpend,
    capabilityNonce: BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))),
  };
  const signature = await signTypedData(channelCapabilityTypes, "ChannelCapability", capability);
  const client = new OfflaneClient(new WebSocketTransport(config.relayUrl));
  await client.connect();
  await client.authenticate({ address: agent.address, signMessage: (message) => agent.signMessage({ message }) });
  await client.registerCapability(capability, signature);
  const credentials: AgentCredentialExport = {
    format: "offlane-agent-credentials",
    version: 1,
    createdAt: new Date().toISOString(),
    network: {
      name: config.chainName,
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      relayUrl: config.relayUrl,
      channelManager: config.manager,
    },
    identity: {
      owner: address,
      delegatedSigner: agent.address,
      delegatedPrivateKey: key,
    },
    channel: {
      channelId: channel.current.channelId,
      counterparty: participantIsA ? channel.participantB : channel.participantA,
      token: channel.token,
      participantRole: participantIsA ? "A" : "B",
    },
    authorization: {
      capability: {
        ...capability,
        baselineBalance: capability.baselineBalance.toString(),
        maxNetSpend: capability.maxNetSpend.toString(),
        capabilityNonce: capability.capabilityNonce.toString(),
      },
      capabilitySignature: signature,
    },
    messaging: storedMessagingIdentity(),
    warning: "Plaintext credentials for Tempo Moderato testnet. Contains delegated and messaging private keys. Never share publicly or use with mainnet funds.",
  };
  const authorized = { address: agent.address, channelId, limit: ($("agentLimit") as HTMLInputElement).value, client, credentials } satisfies AuthorizedAgent;
  agents.push(authorized);
  renderAgents();
  log(`Agent ${short(agent.address)} authorized for channel ${short(channelId)}.`, "agent");
  ($("agentDialog") as HTMLDialogElement).close();
  showAgentExport(authorized);
  toast("Agent authorized. Export its credentials now.");
}

function showView(name: string): void {
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === name));
  document.querySelectorAll("[data-view]").forEach((element) => element.classList.toggle("active", (element as HTMLElement).dataset.view === name && Boolean(element.closest("aside"))));
  $("crumb").textContent = name.toUpperCase();
}

const closeButtons = [...document.querySelectorAll<HTMLButtonElement>("dialog .dialog-head > button")];
const closeDialog = (event: Event) => {
  event.preventDefault();
  const dialog = (event.currentTarget as HTMLButtonElement).closest<HTMLDialogElement>("dialog");
  dialog?.close();
};
for (const button of closeButtons) {
  button.type = "button";
  button.addEventListener("click", closeDialog);
}

document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => showView(element.dataset.view!)));
document.querySelectorAll<HTMLElement>("[data-open]").forEach((element) => element.addEventListener("click", () => ($(element.dataset.open + "Dialog") as HTMLDialogElement).showModal()));
const unwatchConnectors = watchConnectors(walletConfig, { onChange: () => {
  if (($("walletDialog") as HTMLDialogElement).open) renderWalletOptions();
} });
const unwatchAccount = watchAccount(walletConfig, { onChange: (account, previous) => {
  if (!changingConnector && previous.address && account.address !== previous.address) void disconnectForAccountChange();
} });
$("walletButton").addEventListener("click", openWalletModal);
$("gateConnect").addEventListener("click", openWalletModal);
$("walletOptions").addEventListener("click", (event) => {
  const option = (event.target as HTMLElement).closest<HTMLElement>("[data-connector]");
  const selected = getConnectors(walletConfig).find((connector) => connector.uid === option?.dataset.connector);
  if (!option || !selected) return;
  option.querySelector("small")!.textContent = "Waiting for wallet…";
  void connect(selected).catch((error) => {
    renderWalletOptions();
    toast(String((error as Error).message ?? error), true);
  });
});
$("refreshChannels").addEventListener("click", () => refreshChannels().catch((error) => toast(String(error.message ?? error), true)));
document.querySelectorAll<HTMLElement>("[data-channel-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.channelFilter;
    if (filter === "all" || filter === "open" || filter === "pending") {
      channelFilter = filter;
      renderChannels();
    }
  });
});
$("createForm").addEventListener("submit", (event) => openChannel(event as SubmitEvent).catch((error) => toast(String(error.message ?? error), true)));
$("joinForm").addEventListener("submit", (event) => joinChannel(event as SubmitEvent).catch((error) => toast(String(error.message ?? error), true)));
$("agentForm").addEventListener("submit", (event) => authorizeAgent(event as SubmitEvent).catch((error) => toast(String(error.message ?? error), true)));
$("agentCards").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-agent-export]");
  if (!button) return;
  const agent = agents[Number(button.dataset.agentExport)];
  if (agent) showAgentExport(agent);
});
$("copyAgentCredentials").addEventListener("click", () => {
  if (!selectedAgentExport) return;
  void navigator.clipboard.writeText(agentCredentialsJson(selectedAgentExport))
    .then(() => toast("Agent credentials copied. Keep them private."))
    .catch((error) => toast(String((error as Error).message ?? error), true));
});
$("downloadAgentCredentials").addEventListener("click", () => {
  if (selectedAgentExport) downloadAgentCredentials(selectedAgentExport);
});
$("sendPaymentForm").addEventListener("submit", (event) => proposePayment(event as SubmitEvent).catch((error) => toast(String((error as Error).message ?? error), true)));
$("refreshPeerKey").addEventListener("click", () => {
  if (!activeChannelId || !address) return;
  const channel = channels.find((item) => item.current.channelId === activeChannelId);
  if (!channel) return;
  const peer = same(address, channel.participantA) ? channel.participantB : channel.participantA;
  resolvedMessagingKeys.delete(peer.toLowerCase());
  $("detailPeerKeyStatus").textContent = "Resolving";
  $("detailPeerKey").textContent = "Resolving from wallet address…";
  void resolveWorkspaceCounterparty(peer, channel.status === "open")
    .catch((error) => toast(String((error as Error).message ?? error), true));
});
$("refreshTraffic").addEventListener("click", () => refreshChannelTraffic().catch((error) => toast(String((error as Error).message ?? error), true)));
$("pendingProposal").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("#acceptPayment")) void acceptPendingPayment().catch((error) => toast(String((error as Error).message ?? error), true));
  if (target.closest("#rejectPayment")) void rejectPendingPayment().catch((error) => toast(String((error as Error).message ?? error), true));
});
$("copyInvite").addEventListener("click", () => navigator.clipboard.writeText(($('inviteOutput') as HTMLTextAreaElement).value).then(() => toast("Invite copied.")));
$("allChannels").addEventListener("click", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>("[data-channel]");
  if (card?.dataset.channel) openChannelWorkspace(card.dataset.channel);
});
$("detailAgent").addEventListener("click", () => {
  const channelId = ($("detailId") as HTMLInputElement).value;
  ($("agentChannel") as HTMLSelectElement).value = channelId;
  ($("channelDialog") as HTMLDialogElement).close();
  ($("agentDialog") as HTMLDialogElement).showModal();
});
renderChannels(); renderAgents(); renderActivity();
const closeClients = () => { relay?.close(); for (const agent of agents) agent.client.close(); };
window.addEventListener("beforeunload", closeClients);
return () => {
  unwatchConnectors();
  unwatchAccount();
  unsubscribeRelayEvents?.();
  for (const button of closeButtons) button.removeEventListener("click", closeDialog);
  window.removeEventListener("beforeunload", closeClients);
  closeClients();
};
}
