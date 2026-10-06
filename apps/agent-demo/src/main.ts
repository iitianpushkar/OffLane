import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  channelCapabilityTypes,
  channelStateTypes,
  channelStateWireSchema,
  hashChannelState,
  type Address,
  type Bytes32,
  type ChannelCapability,
  type ChannelState,
  type Hex,
  type StateAuthorization,
} from "@offlane/protocol";
import {
  decryptMessageText,
  encryptMessage,
  generateMessagingKeyPair,
  OfflaneClient,
  WebSocketTransport,
  type RelayAuthSigner,
} from "@offlane/sdk";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WebSocket } from "ws";

const MODERATO_CHAIN_ID = 42_431;
const PATHUSD = "0x20C0000000000000000000000000000000000000" as Address;
const ZERO_HASH = `0x${"00".repeat(32)}` as Bytes32;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const DEPOSIT = 10_000_000n;
const A_TO_B = 2_000_000n;
const B_TO_A = 1_000_000n;
const AGENT_SPEND_LIMIT = 3_000_000n;

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

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

const channelManagerAbi = [
  {
    type: "function",
    name: "computeChannelId",
    stateMutability: "view",
    inputs: [{ name: "intent", type: "tuple", components: intentComponents() }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "openChannel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intent", type: "tuple", components: intentComponents() },
      { name: "signatureA", type: "bytes" },
    ],
    outputs: [{ name: "channelId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "joinChannel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intent", type: "tuple", components: intentComponents() },
      { name: "signatureB", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cooperativeCloseWithCapabilities",
    stateMutability: "nonpayable",
    inputs: [
      { name: "state", type: "tuple", components: stateComponents() },
      { name: "authorizationA", type: "tuple", components: authorizationComponents() },
      { name: "authorizationB", type: "tuple", components: authorizationComponents() },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cooperativeClose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "state", type: "tuple", components: stateComponents() },
      { name: "signatureA", type: "bytes" },
      { name: "signatureB", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getChannel",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "participantA", type: "address" },
          { name: "challengeDuration", type: "uint32" },
          { name: "status", type: "uint8" },
          { name: "validUntil", type: "uint32" },
          { name: "participantB", type: "address" },
          { name: "nonce", type: "uint64" },
          { name: "token", type: "address" },
          { name: "challengeExpireAt", type: "uint64" },
          { name: "balanceA", type: "uint128" },
          { name: "balanceB", type: "uint128" },
        ],
      },
    ],
  },
] as const;

function intentComponents() {
  return [
    { name: "protocolVersion", type: "uint8" },
    { name: "participantA", type: "address" },
    { name: "participantB", type: "address" },
    { name: "token", type: "address" },
    { name: "depositA", type: "uint128" },
    { name: "depositB", type: "uint128" },
    { name: "challengeDuration", type: "uint32" },
    { name: "validUntil", type: "uint32" },
    { name: "salt", type: "uint256" },
  ] as const;
}

function stateComponents() {
  return [
    { name: "channelId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
    { name: "balanceA", type: "uint128" },
    { name: "balanceB", type: "uint128" },
    { name: "appDataHash", type: "bytes32" },
  ] as const;
}

function capabilityComponents() {
  return [
    { name: "protocolVersion", type: "uint8" },
    { name: "channelId", type: "bytes32" },
    { name: "participant", type: "address" },
    { name: "delegatedSigner", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "token", type: "address" },
    { name: "baselineBalance", type: "uint128" },
    { name: "maxNetSpend", type: "uint128" },
    { name: "capabilityNonce", type: "uint256" },
  ] as const;
}

function authorizationComponents() {
  return [
    { name: "stateSignature", type: "bytes" },
    { name: "capability", type: "tuple", components: capabilityComponents() },
    { name: "capabilitySignature", type: "bytes" },
  ] as const;
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

interface DemoConfig {
  rpcUrl: string;
  manager: Address;
  deploymentBlock: bigint;
  aliceKey: Hex;
  bobKey: Hex;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKey(name: string): Hex {
  const value = required(name);
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized as Hex;
}

function config(): DemoConfig {
  if (Number(required("OFFLANE_CHAIN_ID")) !== MODERATO_CHAIN_ID) {
    throw new Error("agent demo is restricted to Tempo Moderato chain ID 42431");
  }
  return {
    rpcUrl: required("OFFLANE_RPC_URL"),
    manager: required("OFFLANE_CHANNEL_MANAGER") as Address,
    deploymentBlock: BigInt(required("OFFLANE_DEPLOYMENT_BLOCK")),
    aliceKey: privateKey("ALICE_PK"),
    bobKey: privateKey("BOB_PK"),
  };
}

function authSigner(account: LocalAccount): RelayAuthSigner {
  return {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
  };
}

function client(url: string): OfflaneClient {
  return new OfflaneClient(
    new WebSocketTransport(url, {
      factory: (socketUrl) => new WebSocket(socketUrl) as never,
    }),
    { requestTimeoutMs: 15_000 },
  );
}

async function signState(account: LocalAccount, domain: TypedDataDomain, state: ChannelState): Promise<Hex> {
  return account.signTypedData({
    domain,
    types: channelStateTypes,
    primaryType: "ChannelState",
    message: state,
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate demo port");
  const port = address.port;
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return port;
}

async function startRelay(
  root: string,
  database: string,
  port: number,
  deploymentBlock: bigint,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(root, "services/relay/dist/main.js")], {
    cwd: join(root, "services/relay"),
    env: {
      ...process.env,
      OFFLANE_DATABASE_PATH: database,
      OFFLANE_DEPLOYMENT_BLOCK: deploymentBlock.toString(),
      OFFLANE_CONFIRMATIONS: "0",
      OFFLANE_POLL_INTERVAL_MS: "250",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout?.on("data", (chunk) => (diagnostics += chunk.toString()));
  child.stderr?.on("data", (chunk) => (diagnostics += chunk.toString()));
  const health = `http://127.0.0.1:${port}/health`;
  const startupTimeoutMs = Number(
    process.env.OFFLANE_DEMO_RELAY_STARTUP_TIMEOUT_MS ?? "120000",
  );
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`relay exited during startup: ${diagnostics}`);
    try {
      const response = await fetch(health);
      if (response.ok) return child;
    } catch {}
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error(`relay did not become healthy: ${diagnostics}`);
}

async function stopRelay(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(5_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

async function emergencyClose(
  settings: DemoConfig,
  domain: TypedDataDomain,
  alice: LocalAccount,
  bob: LocalAccount,
  state: ChannelState,
): Promise<string> {
  const [signatureA, signatureB] = await Promise.all([
    signState(alice, domain, state),
    signState(bob, domain, state),
  ]);
  const data = encodeFunctionData({
    abi: channelManagerAbi,
    functionName: "cooperativeClose",
    args: [state, signatureA, signatureB],
  });
  return sendTempoTransaction(settings.rpcUrl, settings.aliceKey, settings.manager, data);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function sendTempoTransaction(
  rpcUrl: string,
  privateKeyValue: Hex,
  to: Address,
  data: Hex,
): Promise<string> {
  const args = [
    "send",
    to,
    "--data",
    data,
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKeyValue,
    "--tempo.fee-token",
    "PathUSD",
    "--json",
  ];
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn("cast", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`Tempo transaction failed: ${stderr || stdout}`));
    });
  });
  const receipt = JSON.parse(output) as { transactionHash?: string; status?: string };
  if (!receipt.transactionHash) throw new Error("cast did not return a transaction hash");
  return receipt.transactionHash;
}

async function waitForRelayState(
  relayClient: OfflaneClient,
  channelId: Bytes32,
  expectedNonce: bigint,
): Promise<ChannelState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const payload = await relayClient.getState(channelId);
      const state = channelStateWireSchema.parse(payload.state);
      if (state.nonce === expectedNonce) return state;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`relay did not expose nonce ${expectedNonce}: ${String(lastError)}`);
}

function directAuthorization(signature: Hex): StateAuthorization {
  return { kind: "direct", stateSignature: signature };
}

function onchainAuthorization(authorization: StateAuthorization) {
  if (authorization.kind === "capability") {
    return {
      stateSignature: authorization.stateSignature,
      capability: authorization.capability,
      capabilitySignature: authorization.capabilitySignature,
    };
  }
  return {
    stateSignature: authorization.stateSignature,
    capability: {
      protocolVersion: 0,
      channelId: ZERO_HASH,
      participant: ZERO_ADDRESS,
      delegatedSigner: ZERO_ADDRESS,
      counterparty: ZERO_ADDRESS,
      token: ZERO_ADDRESS,
      baselineBalance: 0n,
      maxNetSpend: 0n,
      capabilityNonce: 0n,
    },
    capabilitySignature: "0x" as Hex,
  };
}

async function main(): Promise<void> {
  const settings = config();
  const publicClient = createPublicClient({ transport: http(settings.rpcUrl) });
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== MODERATO_CHAIN_ID) {
    throw new Error(`refusing to run on chain ${liveChainId}; expected Moderato 42431`);
  }
  const demoDeploymentBlock = await publicClient.getBlockNumber();

  const alice = privateKeyToAccount(settings.aliceKey);
  const bob = privateKeyToAccount(settings.bobKey);
  const aliceAgent = privateKeyToAccount(generatePrivateKey());
  const aliceMessaging = generateMessagingKeyPair();
  const bobMessaging = generateMessagingKeyPair();
  const domain = {
    name: "Tempo.ChannelManager",
    version: "1",
    chainId: MODERATO_CHAIN_ID,
    verifyingContract: settings.manager,
  } as const;
  const intent: ChannelIntent = {
    protocolVersion: 1,
    participantA: alice.address,
    participantB: bob.address,
    token: PATHUSD,
    depositA: DEPOSIT,
    depositB: DEPOSIT,
    challengeDuration: 3_600,
    validUntil: Math.floor(Date.now() / 1_000) + 3_600,
    salt: BigInt(`0x${randomBytes(32).toString("hex")}`),
  };
  const channelId = (await publicClient.readContract({
    address: settings.manager,
    abi: channelManagerAbi,
    functionName: "computeChannelId",
    args: [intent],
  })) as Bytes32;
  const [signatureA, signatureB] = await Promise.all([
    alice.signTypedData({ domain, types: intentTypes, primaryType: "ChannelIntent", message: intent }),
    bob.signTypedData({ domain, types: intentTypes, primaryType: "ChannelIntent", message: intent }),
  ]);

  console.log(`Moderato chain: ${liveChainId}`);
  console.log(`ChannelManager: ${settings.manager}`);
  console.log(`Channel: ${channelId}`);
  console.log(`Alice agent: ${aliceAgent.address}`);

  for (const [label, account, key] of [
    ["Alice", alice, settings.aliceKey],
    ["Bob", bob, settings.bobKey],
  ] as const) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [settings.manager, DEPOSIT],
    });
    const transaction = await sendTempoTransaction(settings.rpcUrl, key, PATHUSD, approveData);
    console.log(`${label} approval: ${transaction}`);
  }

  const openData = encodeFunctionData({
    abi: channelManagerAbi,
    functionName: "openChannel",
    args: [intent, signatureA],
  });
  console.log(`Open: ${await sendTempoTransaction(settings.rpcUrl, settings.aliceKey, settings.manager, openData)}`);
  const joinData = encodeFunctionData({
    abi: channelManagerAbi,
    functionName: "joinChannel",
    args: [intent, signatureB],
  });
  console.log(`Join: ${await sendTempoTransaction(settings.rpcUrl, settings.bobKey, settings.manager, joinData)}`);

  const root = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "offlane-agent-demo-"));
  const database = join(temporary, "relay.sqlite");
  const port = await freePort();
  const socketUrl = `ws://127.0.0.1:${port}/ws`;
  let relay: ChildProcess | undefined;
  let agentClient: OfflaneClient | undefined;
  let bobClient: OfflaneClient | undefined;
  let settled = false;
  let latestAgreedState: ChannelState = {
    channelId,
    nonce: 0n,
    balanceA: DEPOSIT,
    balanceB: DEPOSIT,
    appDataHash: ZERO_HASH,
  };

  try {
    relay = await startRelay(root, database, port, demoDeploymentBlock);
    agentClient = client(socketUrl);
    bobClient = client(socketUrl);
    await Promise.all([agentClient.connect(), bobClient.connect()]);
    await Promise.all([
      agentClient.authenticate(authSigner(aliceAgent)),
      bobClient.authenticate(authSigner(bob)),
    ]);

    const capability: ChannelCapability = {
      protocolVersion: 1,
      channelId,
      participant: alice.address,
      delegatedSigner: aliceAgent.address,
      counterparty: bob.address,
      token: PATHUSD,
      baselineBalance: DEPOSIT,
      maxNetSpend: AGENT_SPEND_LIMIT,
      capabilityNonce: BigInt(`0x${randomBytes(32).toString("hex")}`),
    };
    const capabilitySignature = await alice.signTypedData({
      domain,
      types: channelCapabilityTypes,
      primaryType: "ChannelCapability",
      message: capability,
    });
    await agentClient.registerCapability(capability, capabilitySignature);
    const initial = await waitForRelayState(agentClient, channelId, 0n);

    const encryptedRequest = encryptMessage({
      channelId,
      sender: alice.address,
      recipient: bob.address,
      sequence: 1n,
      stateNonce: 1n,
      senderKeyPair: aliceMessaging,
      recipientPublicKey: bobMessaging.publicKey,
      plaintext: JSON.stringify({
        type: "agent.request",
        task: "summarize",
        input: "OffLane carries encrypted AI work with bidirectional payment.",
      }),
    });
    await agentClient.sendMessage(encryptedRequest);
    const bobInbox = await bobClient.listMessages(channelId);
    const receivedRequest = bobInbox.find(
      (record) => record.envelope.messageId === encryptedRequest.messageId,
    );
    if (!receivedRequest) throw new Error("Bob did not receive the encrypted request");
    const requestPlaintext = decryptMessageText(receivedRequest.envelope, bobMessaging);
    await bobClient.acknowledgeMessage(channelId, encryptedRequest.messageId);
    console.log(`Bob decrypted request: ${requestPlaintext}`);

    const stateOne: ChannelState = {
      ...initial,
      nonce: 1n,
      balanceA: initial.balanceA - A_TO_B,
      balanceB: initial.balanceB + A_TO_B,
      appDataHash: encryptedRequest.messageId,
    };
    const authorizationAOne: StateAuthorization = {
      kind: "capability",
      stateSignature: await signState(aliceAgent, domain, stateOne),
      capability,
      capabilitySignature,
    };
    const proposalOne = `0x${randomBytes(32).toString("hex")}` as Bytes32;
    const authorizationBOne = directAuthorization(await signState(bob, domain, stateOne));
    latestAgreedState = stateOne;
    await agentClient.proposeState({
      proposalId: proposalOne,
      proposer: alice.address,
      baseStateHash: hashChannelState(domain, initial),
      state: stateOne,
      authorization: authorizationAOne,
    });
    await bobClient.acceptState({
      proposalId: proposalOne,
      accepter: bob.address,
      state: stateOne,
      authorization: authorizationBOne,
    });
    console.log("Accepted A -> B payment: 2 PathUSD (nonce 1)");

    const encryptedResponse = encryptMessage({
      channelId,
      sender: bob.address,
      recipient: alice.address,
      sequence: 1n,
      stateNonce: 2n,
      senderKeyPair: bobMessaging,
      recipientPublicKey: aliceMessaging.publicKey,
      plaintext: JSON.stringify({
        type: "agent.response",
        result: "OffLane combines private messages with collateralized state updates.",
      }),
    });
    await bobClient.sendMessage(encryptedResponse);
    const aliceInbox = await agentClient.listMessages(channelId);
    const receivedResponse = aliceInbox.find(
      (record) => record.envelope.messageId === encryptedResponse.messageId,
    );
    if (!receivedResponse) throw new Error("Alice did not receive the encrypted response");
    const responsePlaintext = decryptMessageText(
      receivedResponse.envelope,
      aliceMessaging,
    );
    await agentClient.acknowledgeMessage(channelId, encryptedResponse.messageId);
    console.log(`Alice agent decrypted response: ${responsePlaintext}`);

    const stateTwo: ChannelState = {
      ...stateOne,
      nonce: 2n,
      balanceA: stateOne.balanceA + B_TO_A,
      balanceB: stateOne.balanceB - B_TO_A,
      appDataHash: encryptedResponse.messageId,
    };
    const authorizationBTwo = directAuthorization(await signState(bob, domain, stateTwo));
    const authorizationATwo: StateAuthorization = {
      kind: "capability",
      stateSignature: await signState(aliceAgent, domain, stateTwo),
      capability,
      capabilitySignature,
    };
    latestAgreedState = stateTwo;
    const proposalTwo = `0x${randomBytes(32).toString("hex")}` as Bytes32;
    await bobClient.proposeState({
      proposalId: proposalTwo,
      proposer: bob.address,
      baseStateHash: hashChannelState(domain, stateOne),
      state: stateTwo,
      authorization: authorizationBTwo,
    });
    await agentClient.acceptState({
      proposalId: proposalTwo,
      accepter: alice.address,
      state: stateTwo,
      authorization: authorizationATwo,
    });
    console.log("Accepted B -> A payment: 1 PathUSD (nonce 2)");

    await Promise.all([agentClient.close(), bobClient.close()]);
    await stopRelay(relay);
    relay = await startRelay(root, database, port, demoDeploymentBlock);
    agentClient = client(socketUrl);
    bobClient = client(socketUrl);
    await Promise.all([agentClient.connect(), bobClient.connect()]);
    await Promise.all([
      agentClient.authenticate(authSigner(aliceAgent)),
      bobClient.authenticate(authSigner(bob)),
    ]);
    await agentClient.registerCapability(capability, capabilitySignature);
    const recovered = await waitForRelayState(agentClient, channelId, 2n);
    if (recovered.balanceA !== 9_000_000n || recovered.balanceB !== 11_000_000n) {
      throw new Error("relay recovered unexpected balances after restart");
    }
    const [recoveredForAlice, recoveredForBob] = await Promise.all([
      agentClient.listMessages(channelId),
      bobClient.listMessages(channelId),
    ]);
    if (
      recoveredForAlice[0]?.status !== "acknowledged" ||
      recoveredForBob[0]?.status !== "acknowledged" ||
      decryptMessageText(recoveredForAlice[0].envelope, aliceMessaging) !==
        responsePlaintext ||
      decryptMessageText(recoveredForBob[0].envelope, bobMessaging) !==
        requestPlaintext
    ) {
      throw new Error("encrypted messages did not survive relay restart");
    }
    console.log("SQLite restart recovery: nonce 2, balances 9/11 PathUSD");
    console.log("Encrypted messages and acknowledgements recovered after restart");

    const closeData = encodeFunctionData({
      abi: channelManagerAbi,
      functionName: "cooperativeCloseWithCapabilities",
      args: [
        stateTwo,
        onchainAuthorization(authorizationATwo),
        onchainAuthorization(authorizationBTwo),
      ],
    });
    const closeTransaction = await sendTempoTransaction(
      settings.rpcUrl,
      settings.aliceKey,
      settings.manager,
      closeData,
    );
    settled = true;
    console.log(`Cooperative close: ${closeTransaction}`);

    const closed = await publicClient.readContract({
      address: settings.manager,
      abi: channelManagerAbi,
      functionName: "getChannel",
      args: [channelId],
    });
    if (closed.status !== 0) throw new Error(`channel status is ${closed.status}, expected VOID`);
    console.log("On-chain settlement verified: channel storage is VOID");
    console.log("AGENT DEMO PASSED");
  } catch (error) {
    if (!settled) {
      try {
        const recoveryTransaction = await emergencyClose(
          settings,
          domain,
          alice,
          bob,
          latestAgreedState,
        );
        settled = true;
        console.error(`Emergency cooperative close: ${recoveryTransaction}`);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "agent demo failed and emergency settlement also failed",
        );
      }
    }
    throw error;
  } finally {
    await Promise.allSettled([
      agentClient?.close() ?? Promise.resolve(),
      bobClient?.close() ?? Promise.resolve(),
    ]);
    if (relay) await stopRelay(relay);
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
