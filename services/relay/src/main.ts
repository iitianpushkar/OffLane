import { type Address } from "@offlane/protocol";
import { RelayCore } from "./core.js";
import { ChannelIndexer, ViemChannelEventSource } from "./indexer.js";
import { RelayServer } from "./server.js";
import { SqliteRelayStore } from "./sqlite-store.js";
import { ViemAuthorizationVerifier } from "./verifier.js";

const chainId = Number(process.env.OFFLANE_CHAIN_ID ?? "42431");
const verifyingContract = process.env.OFFLANE_CHANNEL_MANAGER as Address | undefined;
if (!verifyingContract) {
  throw new Error("OFFLANE_CHANNEL_MANAGER is required");
}
const rpcUrl = process.env.OFFLANE_RPC_URL;
if (!rpcUrl) throw new Error("OFFLANE_RPC_URL is required");
const deploymentBlock = process.env.OFFLANE_DEPLOYMENT_BLOCK;
if (!deploymentBlock) throw new Error("OFFLANE_DEPLOYMENT_BLOCK is required");
const domain = {
  name: "Tempo.ChannelManager",
  version: "1",
  chainId,
  verifyingContract,
} as const;
const store = new SqliteRelayStore(
  process.env.OFFLANE_DATABASE_PATH ?? "./offlane-relay.sqlite",
);
const verifier = new ViemAuthorizationVerifier(domain);
const core = new RelayCore(store, verifier, domain);
const indexer = new ChannelIndexer(
  store,
  new ViemChannelEventSource(rpcUrl, verifyingContract),
  {
    chainId,
    contractAddress: verifyingContract,
    deploymentBlock: BigInt(deploymentBlock),
    confirmations: BigInt(process.env.OFFLANE_CONFIRMATIONS ?? "2"),
    pollIntervalMs: Number(process.env.OFFLANE_POLL_INTERVAL_MS ?? "2000"),
  },
);
const server = new RelayServer(core, {
  port: Number(process.env.PORT ?? "7824"),
  host: process.env.HOST ?? "127.0.0.1",
});

await indexer.syncOnce();
indexer.start((error) => console.error("channel indexer failed", error));
await server.start();
console.log(`OffLane relay listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "7824"}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  indexer.stop();
  await server.close();
  store.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
