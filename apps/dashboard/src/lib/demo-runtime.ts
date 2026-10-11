import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

export interface DashboardEvent {
  id: number;
  runId: number;
  type: "reset" | "status" | "log" | "field" | "error";
  key?: string;
  value?: string | number | boolean;
  message?: string;
  timestamp: number;
}

class DemoRuntime {
  readonly history: DashboardEvent[] = [];
  readonly clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  demo?: ChildProcessWithoutNullStreams;
  runId = 0;

  emit(event: Omit<DashboardEvent, "id" | "runId" | "timestamp">) {
    const complete: DashboardEvent = {
      ...event,
      id: this.history.length + 1,
      runId: this.runId,
      timestamp: Date.now(),
    };
    this.history.push(complete);
    const frame = new TextEncoder().encode(`id: ${complete.id}\ndata: ${JSON.stringify(complete)}\n\n`);
    for (const client of this.clients) client.enqueue(frame);
  }

  field(key: string, value: string | number | boolean) {
    this.emit({ type: "field", key, value });
  }

  parseLine(line: string, stream: "stdout" | "stderr") {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.emit({ type: stream === "stderr" ? "error" : "log", message: trimmed });
    const pair = trimmed.match(/^([^:]+):\s*(.+)$/);
    if (pair?.[1] && pair[2]) {
      const mappings: Record<string, string> = {
        "Moderato chain": "chainId", ChannelManager: "manager", Channel: "channelId",
        "Alice agent": "agent", "Alice messaging key": "aliceMessagingKey", "Bob messaging key": "bobMessagingKey",
        "Alice approval": "aliceApprovalTx", "Bob approval": "bobApprovalTx", Open: "openTx", Join: "joinTx",
        "Encrypted request commitment": "requestCommitment", "Encrypted response commitment": "responseCommitment",
        "Cooperative close": "closeTx", "Emergency cooperative close": "closeTx",
      };
      const key = mappings[pair[1]];
      if (key) this.field(key, pair[2]);
      if (pair[1] === "Bob decrypted request") {
        this.field("requestPlaintext", pair[2]);
        this.field("requestStatus", "acknowledged");
      }
      if (pair[1] === "Alice agent decrypted response") {
        this.field("responsePlaintext", pair[2]);
        this.field("responseStatus", "acknowledged");
      }
    }
    if (trimmed.includes("Accepted A -> B payment")) {
      this.field("nonce", 1); this.field("aliceBalance", 8); this.field("bobBalance", 12); this.field("phase", "request-paid");
    } else if (trimmed.includes("Accepted B -> A payment")) {
      this.field("nonce", 2); this.field("aliceBalance", 9); this.field("bobBalance", 11); this.field("phase", "response-paid");
    } else if (trimmed.startsWith("SQLite restart recovery")) {
      this.field("relayRecovered", true); this.field("phase", "recovered");
    } else if (trimmed.startsWith("Encrypted messages and acknowledgements recovered")) {
      this.field("messagesRecovered", true);
    } else if (trimmed.startsWith("On-chain settlement verified")) {
      this.field("settled", true); this.field("phase", "settled");
    }
  }

  start(): { runId: number } {
    if (process.env.VERCEL) throw new Error("The live demo runner needs a persistent Node host. Use the product UI on Vercel and deploy the relay separately.");
    if (this.demo && this.demo.exitCode === null) throw new Error("A demo run is already active.");
    this.runId += 1;
    this.history.length = 0;
    this.emit({ type: "reset", message: "Starting a fresh Moderato channel run." });
    this.field("phase", "starting"); this.field("nonce", 0); this.field("aliceBalance", 10); this.field("bobBalance", 10);
    this.field("requestStatus", "waiting"); this.field("responseStatus", "waiting"); this.field("relayRecovered", false);
    this.field("messagesRecovered", false); this.field("settled", false);
    this.emit({ type: "status", key: "run", value: "running" });

    const root = resolve(process.cwd(), "../..");
    this.demo = spawn("pnpm", ["--filter", "@offlane/agent-demo", "start"], { cwd: root, env: process.env });
    createInterface({ input: this.demo.stdout }).on("line", (line) => this.parseLine(line, "stdout"));
    createInterface({ input: this.demo.stderr }).on("line", (line) => this.parseLine(line, "stderr"));
    this.demo.once("error", (error) => {
      this.emit({ type: "error", message: error.message });
      this.emit({ type: "status", key: "run", value: "failed" });
    });
    this.demo.once("exit", (code) => this.emit({
      type: "status", key: "run", value: code === 0 ? "complete" : "failed",
      message: code === 0 ? "Live demo completed." : `Demo exited with code ${code}.`,
    }));
    return { runId: this.runId };
  }
}

const globalRuntime = globalThis as typeof globalThis & { offlaneDemoRuntime?: DemoRuntime };
export const demoRuntime = globalRuntime.offlaneDemoRuntime ??= new DemoRuntime();
