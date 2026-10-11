import { NextResponse } from "next/server";
import { demoRuntime } from "@/lib/demo-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST() {
  try {
    return NextResponse.json(demoRuntime.start(), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("already active") ? 409 : 503 });
  }
}
