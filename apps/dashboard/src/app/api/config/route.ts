import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    chainId: 42_431,
    chainName: "Tempo Moderato",
    rpcUrl: process.env.OFFLANE_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
    explorerUrl: process.env.OFFLANE_EXPLORER_URL ?? "https://explore.tempo.xyz",
    relayUrl: process.env.OFFLANE_BROWSER_RELAY_URL ?? "ws://127.0.0.1:7824/ws",
    manager: process.env.OFFLANE_CHANNEL_MANAGER,
    token: process.env.OFFLANE_TOKEN_ADDRESS ?? "0x20C0000000000000000000000000000000000000",
  });
}
