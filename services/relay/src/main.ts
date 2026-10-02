import { type Address } from "@offlane/protocol";
import { RelayCore } from "./core.js";
import { RelayServer } from "./server.js";
import { MemoryRelayStore } from "./store.js";
import { ViemAuthorizationVerifier } from "./verifier.js";

const chainId = Number(process.env.OFFLANE_CHAIN_ID ?? "42431");
const verifyingContract = process.env.OFFLANE_CHANNEL_MANAGER as Address | undefined;
if (!verifyingContract) {
  throw new Error("OFFLANE_CHANNEL_MANAGER is required");
}
const domain = {
  name: "Tempo.ChannelManager",
  version: "1",
  chainId,
  verifyingContract,
} as const;
const store = new MemoryRelayStore();
const verifier = new ViemAuthorizationVerifier(domain);
const core = new RelayCore(store, verifier, domain);
const server = new RelayServer(core, {
  port: Number(process.env.PORT ?? "7824"),
  host: process.env.HOST ?? "127.0.0.1",
});

await server.start();
console.log(`OffLane relay listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "7824"}`);
