import { demoRuntime } from "@/lib/demo-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  let client: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = controller;
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const event of demoRuntime.history) {
        controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      demoRuntime.clients.add(controller);
    },
    cancel() {
      if (client) demoRuntime.clients.delete(client);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
