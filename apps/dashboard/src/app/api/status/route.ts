import { NextResponse } from "next/server";
import { demoRuntime } from "@/lib/demo-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    active: Boolean(demoRuntime.demo && demoRuntime.demo.exitCode === null),
    runId: demoRuntime.runId,
    chainId: process.env.OFFLANE_CHAIN_ID ?? null,
    manager: process.env.OFFLANE_CHANNEL_MANAGER ?? null,
    configured: !process.env.VERCEL && Boolean(process.env.ALICE_PK && process.env.BOB_PK && process.env.OFFLANE_RPC_URL),
  });
}
