import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CredentialExport {
  format: "offlane-agent-credentials";
  version: 1;
  network: { chainId: 42_431 };
  channel: { participantRole: "A" | "B"; channelId: string };
}

function validateCredentialExport(value: unknown): asserts value is CredentialExport {
  if (!value || typeof value !== "object") throw new Error("Credential export must be a JSON object.");
  const credential = value as {
    format?: unknown;
    version?: unknown;
    network?: { chainId?: unknown };
    channel?: { participantRole?: unknown; channelId?: unknown };
  };
  if (credential.format !== "offlane-agent-credentials" || credential.version !== 1) {
    throw new Error("Only OffLane agent credential v1 exports can be saved.");
  }
  if (credential.network?.chainId !== 42_431) {
    throw new Error("The local A2A demo only accepts Tempo Moderato credentials.");
  }
  if (credential.channel?.participantRole !== "A" && credential.channel?.participantRole !== "B") {
    throw new Error("Credential participant role must be A or B.");
  }
  if (typeof credential.channel.channelId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(credential.channel.channelId)) {
    throw new Error("Credential channel ID is invalid.");
  }
}

export async function POST(request: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json(
      { error: "Automatic A2A credential saving is available only from the local dashboard." },
      { status: 403 },
    );
  }

  try {
    const origin = request.headers.get("origin");
    const requestHost = request.headers.get("host");
    if (origin && (!requestHost || new URL(origin).host !== requestHost)) {
      return NextResponse.json({ error: "Cross-origin credential saving is not allowed." }, { status: 403 });
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new Error("Credential export must be sent as application/json.");
    }
    const credential: unknown = await request.json();
    validateCredentialExport(credential);
    const serialized = `${JSON.stringify(credential, null, 2)}\n`;
    if (serialized.length > 100_000) throw new Error("Credential export is unexpectedly large.");

    const role = credential.channel.participantRole.toLowerCase();
    const directory = resolve(process.cwd(), "../a2a-demo/credentials");
    const filename = `agent-${role}.json`;
    const destination = resolve(directory, filename);
    const temporary = resolve(directory, `.${filename}.tmp`);
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);

    return NextResponse.json({
      saved: true,
      role: credential.channel.participantRole,
      path: `apps/a2a-demo/credentials/${filename}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
