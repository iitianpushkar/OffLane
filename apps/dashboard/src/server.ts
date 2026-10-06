import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";

const host = process.env.OFFLANE_DASHBOARD_HOST ?? "127.0.0.1";
const port = Number(process.env.OFFLANE_DASHBOARD_PORT ?? "4173");
const root = resolve(import.meta.dirname, "../../..");
const publicDirectory = resolve(import.meta.dirname, "client");
const clients = new Set<ServerResponse>();
const history: DashboardEvent[] = [];
let demo: ChildProcess | undefined;
let productRelay: ChildProcess | undefined;
let runId = 0;

interface DashboardEvent {
  id: number;
  runId: number;
  type: "reset" | "status" | "log" | "field" | "error";
  key?: string;
  value?: string | number | boolean;
  message?: string;
  timestamp: number;
}

function emit(event: Omit<DashboardEvent, "id" | "runId" | "timestamp">): void {
  const complete: DashboardEvent = {
    ...event,
    id: history.length + 1,
    runId,
    timestamp: Date.now(),
  };
  history.push(complete);
  const frame = `id: ${complete.id}\ndata: ${JSON.stringify(complete)}\n\n`;
  for (const client of clients) client.write(frame);
}

function field(key: string, value: string | number | boolean): void {
  emit({ type: "field", key, value });
}

function parseDemoLine(line: string, stream: "stdout" | "stderr"): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  emit({ type: stream === "stderr" ? "error" : "log", message: trimmed });

  const pair = trimmed.match(/^([^:]+):\s*(.+)$/);
  if (pair?.[1] && pair[2]) {
    const mappings: Record<string, string> = {
      "Moderato chain": "chainId",
      ChannelManager: "manager",
      Channel: "channelId",
      "Alice agent": "agent",
      "Alice messaging key": "aliceMessagingKey",
      "Bob messaging key": "bobMessagingKey",
      "Alice approval": "aliceApprovalTx",
      "Bob approval": "bobApprovalTx",
      Open: "openTx",
      Join: "joinTx",
      "Encrypted request commitment": "requestCommitment",
      "Encrypted response commitment": "responseCommitment",
      "Cooperative close": "closeTx",
      "Emergency cooperative close": "closeTx",
    };
    const key = mappings[pair[1]];
    if (key) field(key, pair[2]);

    if (pair[1] === "Bob decrypted request") {
      field("requestPlaintext", pair[2]);
      field("requestStatus", "acknowledged");
    }
    if (pair[1] === "Alice agent decrypted response") {
      field("responsePlaintext", pair[2]);
      field("responseStatus", "acknowledged");
    }
  }

  if (trimmed.includes("Accepted A -> B payment")) {
    field("nonce", 1);
    field("aliceBalance", 8);
    field("bobBalance", 12);
    field("phase", "request-paid");
  } else if (trimmed.includes("Accepted B -> A payment")) {
    field("nonce", 2);
    field("aliceBalance", 9);
    field("bobBalance", 11);
    field("phase", "response-paid");
  } else if (trimmed.startsWith("SQLite restart recovery")) {
    field("relayRecovered", true);
    field("phase", "recovered");
  } else if (trimmed.startsWith("Encrypted messages and acknowledgements recovered")) {
    field("messagesRecovered", true);
  } else if (trimmed.startsWith("On-chain settlement verified")) {
    field("settled", true);
    field("phase", "settled");
  }
}

function startDemo(response: ServerResponse): void {
  if (demo && demo.exitCode === null) {
    json(response, 409, { error: "A demo run is already active." });
    return;
  }

  runId += 1;
  history.length = 0;
  emit({ type: "reset", message: "Starting a fresh Moderato channel run." });
  field("phase", "starting");
  field("nonce", 0);
  field("aliceBalance", 10);
  field("bobBalance", 10);
  field("requestStatus", "waiting");
  field("responseStatus", "waiting");
  field("relayRecovered", false);
  field("messagesRecovered", false);
  field("settled", false);
  emit({ type: "status", key: "run", value: "running" });

  demo = spawn("pnpm", ["--filter", "@offlane/agent-demo", "start"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = createInterface({ input: demo.stdout! });
  const stderr = createInterface({ input: demo.stderr! });
  stdout.on("line", (line) => parseDemoLine(line, "stdout"));
  stderr.on("line", (line) => parseDemoLine(line, "stderr"));
  demo.once("error", (error) => {
    emit({ type: "error", message: error.message });
    emit({ type: "status", key: "run", value: "failed" });
  });
  demo.once("exit", (code) => {
    emit({
      type: "status",
      key: "run",
      value: code === 0 ? "complete" : "failed",
      message: code === 0 ? "Live demo completed." : `Demo exited with code ${code}.`,
    });
  });
  json(response, 202, { runId });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    for (const event of history) {
      response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/run") {
    startDemo(response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    json(response, 200, {
      active: Boolean(demo && demo.exitCode === null),
      runId,
      chainId: process.env.OFFLANE_CHAIN_ID ?? null,
      manager: process.env.OFFLANE_CHANNEL_MANAGER ?? null,
      configured: Boolean(process.env.ALICE_PK && process.env.BOB_PK && process.env.OFFLANE_RPC_URL),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    json(response, 200, {
      chainId: 42_431,
      chainName: "Tempo Moderato",
      rpcUrl: "https://rpc.moderato.tempo.xyz",
      explorerUrl: "https://explore.tempo.xyz",
      relayUrl: process.env.OFFLANE_BROWSER_RELAY_URL ?? "ws://127.0.0.1:7824/ws",
      manager: process.env.OFFLANE_CHANNEL_MANAGER,
      token: "0x20C0000000000000000000000000000000000000",
    });
    return;
  }

  const routes: Record<string, string> = {
    "/": "index.html",
    "/app": "app/index.html",
    "/app/": "app/index.html",
    "/demo": "demo/index.html",
    "/demo/": "demo/index.html",
  };
  const relative = routes[url.pathname] ?? url.pathname.slice(1);
  const path = resolve(publicDirectory, relative);
  if (!path.startsWith(`${publicDirectory}/`) && path !== resolve(publicDirectory, "index.html")) {
    response.writeHead(403).end();
    return;
  }
  if (!existsSync(path)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": mimeTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(response);
});

async function ensureProductRelay(): Promise<void> {
  const relayPort = Number(process.env.PORT ?? "7824");
  try {
    const health = await fetch(`http://127.0.0.1:${relayPort}/health`);
    if (health.ok) return;
  } catch {}
  productRelay = spawn(process.execPath, [resolve(root, "services/relay/dist/main.js")], {
    cwd: resolve(root, "services/relay"),
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  productRelay.once("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`Product relay exited with code ${code}`);
  });
}

await ensureProductRelay();
server.listen(port, host, () => {
  console.log(`OffLane dashboard: http://${host}:${port}`);
  console.log("Private keys remain in the local server process and are never sent to the browser.");
});

function shutdown(): void {
  demo?.kill("SIGTERM");
  productRelay?.kill("SIGTERM");
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
