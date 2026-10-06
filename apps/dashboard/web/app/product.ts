import {
  channelCapabilityTypes,
  type Address,
  type ChannelCapability,
  type ChannelSummary,
  type Hex,
} from "@offlane/protocol";
import {
  generateMessagingKeyPair,
  OfflaneClient,
  WebSocketTransport,
  type MessagingKeyPair,
} from "@offlane/sdk";
import {
  createPublicClient,
  bytesToHex,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  stringToHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

interface AppConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  relayUrl: string;
  manager: Address;
  token: Address;
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
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

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
const config = (await fetch("/api/config").then((response) => response.json())) as AppConfig;
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const domain = { name: "Tempo.ChannelManager", version: "1", chainId: config.chainId, verifyingContract: config.manager } as const;
let address: Address | undefined;
let relay: OfflaneClient | undefined;
let channels: ChannelSummary[] = [];
const agents: Array<{ address: Address; channelId: string; limit: string; client: OfflaneClient; messaging: MessagingKeyPair }> = [];
const activity: Array<{ time: Date; message: string }> = [];

function toast(message: string, error = false): void {
  const element = $("toast");
  element.textContent = message;
  element.className = error ? "show error" : "show";
  setTimeout(() => (element.className = ""), 3_500);
}

function log(message: string): void {
  activity.unshift({ time: new Date(), message });
  renderActivity();
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function switchToModerato(): Promise<void> {
  if (!provider) throw new Error("Install a Tempo-compatible browser wallet first.");
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${config.chainId.toString(16)}` }] });
  } catch {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: `0x${config.chainId.toString(16)}`, chainName: config.chainName, nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: [config.rpcUrl], blockExplorerUrls: [config.explorerUrl] }],
    });
  }
}

async function connect(): Promise<void> {
  if (!provider) throw new Error("No browser wallet found. Install a Tempo-compatible wallet.");
  await switchToModerato();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts[0]) throw new Error("Wallet did not return an account.");
  address = accounts[0];
  relay?.close().catch(() => undefined);
  relay = new OfflaneClient(new WebSocketTransport(config.relayUrl));
  await relay.connect();
  await relay.authenticate({
    address,
    signMessage: async (message) =>
      (await provider.request({ method: "personal_sign", params: [stringToHex(message), address] })) as Hex,
  });
  $("connectGate").hidden = true;
  $("product").hidden = false;
  $("relayState").textContent = "● Relay connected";
  $("relayState").classList.add("online");
  $("walletButton").textContent = short(address);
  $("addressLine").textContent = `Authenticated as ${address}`;
  log(`Wallet ${short(address)} authenticated with the relay.`);
  await refreshChannels();
}

async function refreshChannels(): Promise<void> {
  if (!relay) return;
  channels = await relay.listChannels();
  renderChannels();
  log(`Loaded ${channels.length} participant channel${channels.length === 1 ? "" : "s"}.`);
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
  ($("channelDialog") as HTMLDialogElement).showModal();
}

function renderChannels(): void {
  const cards = channels.length ? channels.map(channelCard).join("") : `<p class="empty">No channels yet. Open one or import a counterparty invite.</p>`;
  $("allChannels").innerHTML = cards;
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
  $("agentCards").innerHTML = agents.length ? agents.map((agent) => `<article class="card"><div class="top"><span class="pill">authorized</span><code>${short(agent.channelId)}</code></div><h3>${short(agent.address)}</h3><p>Ephemeral delegated signer</p><div class="balances"><div><b>${agent.limit}</b><small>PathUSD spend cap</small></div><div><b>Tab</b><small>Key lifetime</small></div></div></article>`).join("") : `<p class="empty">No agent keys in this tab. Authorize one for an open channel.</p>`;
}

function renderActivity(): void {
  $("activityList").innerHTML = activity.length ? activity.map((event) => `<div class="event"><time>${event.time.toLocaleTimeString()}</time><span>${event.message}</span></div>`).join("") : `<p class="empty">No session activity yet.</p>`;
}

async function signTypedData(types: object, primaryType: string, message: object): Promise<Hex> {
  if (!provider || !address) throw new Error("Connect your wallet first.");
  const payload = JSON.stringify({ domain, types: { ...types, EIP712Domain: [
    { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ] }, primaryType, message }, (_, value) => typeof value === "bigint" ? value.toString() : value);
  return (await provider.request({ method: "eth_signTypedData_v4", params: [address, payload] })) as Hex;
}

async function sendContract(to: Address, data: Hex): Promise<Hex> {
  if (!provider || !address) throw new Error("Connect your wallet first.");
  const hash = (await provider.request({ method: "eth_sendTransaction", params: [{ from: address, to, data }] })) as Hex;
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
    log(`PathUSD approval confirmed: ${short(approveTx)}.`);
    toast("Submit the channel open transaction.");
    const open = encodeFunctionData({ abi: managerAbi, functionName: "openChannel", args: [intent, signature] });
    const openTx = await sendContract(config.manager, open);
    log(`Channel ${short(channelId)} opened: ${short(openTx)}.`);
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
  log(`Joined a channel in transaction ${short(hash)}.`);
  ($("joinDialog") as HTMLDialogElement).close();
  toast("Channel joined successfully.");
  setTimeout(() => refreshChannels().catch(() => undefined), 2_500);
}

async function authorizeAgent(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!address) return;
  const channelId = ($("agentChannel") as HTMLSelectElement).value;
  const channel = channels.find((item) => item.current.channelId === channelId);
  if (!channel) throw new Error("Select an open channel first.");
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key);
  const messaging = generateMessagingKeyPair();
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
  agents.push({ address: agent.address, channelId, limit: ($("agentLimit") as HTMLInputElement).value, client, messaging });
  renderAgents();
  log(`Agent ${short(agent.address)} authorized for channel ${short(channelId)}.`);
  ($("agentDialog") as HTMLDialogElement).close();
  toast("Agent key authorized and authenticated.");
}

function showView(name: string): void {
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === name));
  document.querySelectorAll("[data-view]").forEach((element) => element.classList.toggle("active", (element as HTMLElement).dataset.view === name && Boolean(element.closest("aside"))));
  $("crumb").textContent = name.toUpperCase();
}

document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => showView(element.dataset.view!)));
document.querySelectorAll<HTMLElement>("[data-open]").forEach((element) => element.addEventListener("click", () => ($(element.dataset.open + "Dialog") as HTMLDialogElement).showModal()));
$("walletButton").addEventListener("click", () => connect().catch((error) => toast(String(error.message ?? error), true)));
$("gateConnect").addEventListener("click", () => connect().catch((error) => toast(String(error.message ?? error), true)));
$("refreshChannels").addEventListener("click", () => refreshChannels().catch((error) => toast(String(error.message ?? error), true)));
$("createForm").addEventListener("submit", (event) => openChannel(event as SubmitEvent).catch((error) => toast(String(error.message ?? error), true)));
$("joinForm").addEventListener("submit", (event) => joinChannel(event as SubmitEvent).catch((error) => toast(String(error.message ?? error), true)));
$("agentForm").addEventListener("submit", (event) => authorizeAgent(event as SubmitEvent).catch((error) => toast(String(error.message ?? error), true)));
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
window.addEventListener("beforeunload", () => { relay?.close(); for (const agent of agents) agent.client.close(); });
