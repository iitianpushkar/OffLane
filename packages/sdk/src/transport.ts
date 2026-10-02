export interface TransportHandlers {
  message(data: string): void;
  close(error?: Error): void;
}

export interface RpcTransport {
  connect(handlers: TransportHandlers): Promise<void>;
  send(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketTransportOptions {
  handshakeTimeoutMs?: number;
  factory?: WebSocketFactory;
}

export class WebSocketTransport implements RpcTransport {
  private socket: WebSocketLike | undefined;
  private readonly handshakeTimeoutMs: number;
  private readonly factory: WebSocketFactory;

  constructor(
    private readonly url: string,
    options: WebSocketTransportOptions = {},
  ) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
    this.factory =
      options.factory ??
      ((socketUrl) => {
        if (typeof globalThis.WebSocket === "undefined") {
          throw new Error("WebSocket is unavailable; provide a WebSocket factory");
        }
        return new globalThis.WebSocket(socketUrl) as WebSocketLike;
      });
  }

  async connect(handlers: TransportHandlers): Promise<void> {
    if (this.socket) {
      throw new Error("transport is already connected");
    }

    const socket = this.factory(this.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => {
        this.socket = undefined;
        socket.close();
        reject(new Error("WebSocket handshake timed out"));
      }, this.handshakeTimeoutMs);

      socket.onopen = () => {
        opened = true;
        clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        const error = new Error("WebSocket connection failed");
        if (!opened) {
          this.socket = undefined;
          reject(error);
        } else {
          handlers.close(error);
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          handlers.close(new Error("relay sent a non-text WebSocket frame"));
          return;
        }
        handlers.message(event.data);
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        this.socket = undefined;
        if (!opened) {
          reject(new Error("WebSocket closed during handshake"));
        } else {
          handlers.close();
        }
      };
    });
  }

  async send(data: string): Promise<void> {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    this.socket.send(data);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
}
