import {
  authChallengeResponseWireSchema,
  authVerifyResponseWireSchema,
  capabilityRegistrationWireSchema,
  createRpcMessage,
  decodeRpcMessage,
  encodeChannelCapability,
  encodeChannelState,
  encodeEncryptedEnvelope,
  encodeRpcMessage,
  encodeStateAuthorization,
  rpcErrorPayloadSchema,
  RpcMessageType,
  messageListResponseWireSchema,
  stateAcceptanceWireSchema,
  stateProposalWireSchema,
  type ProtocolMethod,
  type Address,
  type Bytes32,
  type ChannelCapability,
  type EncryptedEnvelope,
  type EncryptedMessageRecord,
  type Hex,
  type RpcMessage,
  type RpcPayload,
  type StateAcceptanceMessage,
  type StateProposalMessage,
} from "@offlane/protocol";
import { RpcClientError } from "./errors.js";
import type { RpcTransport } from "./transport.js";

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OfflaneClientOptions {
  requestTimeoutMs?: number;
  maxMessageAgeMs?: number;
  now?: () => number;
}

interface PendingRequest {
  method: ProtocolMethod;
  resolve(message: RpcMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export type EventListener = (message: RpcMessage) => void;
export type ProtocolErrorListener = (error: RpcClientError) => void;

export interface RelayAuthSigner {
  address: Address;
  signMessage(message: string): Promise<Hex>;
}

export class OfflaneClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly errorListeners = new Set<ProtocolErrorListener>();
  private readonly requestTimeoutMs: number;
  private readonly maxMessageAgeMs: number;
  private readonly now: () => number;
  private nextRequestId = 1;
  private connected = false;

  constructor(
    private readonly transport: RpcTransport,
    options: OfflaneClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxMessageAgeMs = options.maxMessageAgeMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (this.requestTimeoutMs <= 0 || this.maxMessageAgeMs <= 0) {
      throw new Error("RPC timeout and message age limits must be positive");
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new RpcClientError("ALREADY_CONNECTED", "client is already connected");
    }

    await this.transport.connect({
      message: (data) => this.handleMessage(data),
      close: (error) => this.handleClose(error),
    });
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onProtocolError(listener: ProtocolErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async call(
    method: ProtocolMethod,
    payload: RpcPayload = {},
    options: RpcCallOptions = {},
  ): Promise<RpcPayload> {
    if (!this.connected) {
      throw new RpcClientError("NOT_CONNECTED", "client is not connected");
    }
    if (options.signal?.aborted) {
      throw new RpcClientError("REQUEST_ABORTED", "request was aborted");
    }

    const requestId = this.allocateRequestId();
    const message = createRpcMessage(
      RpcMessageType.Request,
      requestId,
      method,
      payload,
      this.now(),
    );

    const response = new Promise<RpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new RpcClientError(
            "REQUEST_TIMEOUT",
            `request ${requestId} timed out after ${options.timeoutMs ?? this.requestTimeoutMs}ms`,
          ),
        );
      }, options.timeoutMs ?? this.requestTimeoutMs);

      const pending: PendingRequest = { method, resolve, reject, timeout };
      if (options.signal) {
        const abort = () => {
          this.clearPending(requestId);
          reject(new RpcClientError("REQUEST_ABORTED", `request ${requestId} was aborted`));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(requestId, pending);
    });

    try {
      await this.transport.send(encodeRpcMessage(message));
    } catch (error) {
      this.rejectPending(
        requestId,
        error instanceof Error ? error : new Error("transport send failed"),
      );
    }

    return (await response).payload;
  }

  async ping(options?: RpcCallOptions): Promise<void> {
    await this.call("node.v1.ping", {}, options);
  }

  async authenticate(
    signer: RelayAuthSigner,
    options?: RpcCallOptions,
  ): Promise<Address> {
    const challenge = authChallengeResponseWireSchema.parse(
      await this.call(
        "auth.v1.request_challenge",
        { signer: signer.address },
        options,
      ),
    );
    const signature = await signer.signMessage(challenge.message);
    const verified = authVerifyResponseWireSchema.parse(
      await this.call(
        "auth.v1.verify",
        {
          challengeId: challenge.challengeId,
          signer: signer.address,
          signature,
        },
        options,
      ),
    );
    return verified.signer;
  }

  async proposeState(
    proposal: StateProposalMessage,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    const payload = {
      ...proposal,
      state: encodeChannelState(proposal.state),
      authorization: encodeStateAuthorization(proposal.authorization),
    };
    stateProposalWireSchema.parse(payload);
    return this.call(
      "channels.v1.propose_state",
      payload,
      options,
    );
  }

  async registerCapability(
    capability: ChannelCapability,
    capabilitySignature: Hex,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    const payload = {
      capability: encodeChannelCapability(capability),
      capabilitySignature,
    };
    capabilityRegistrationWireSchema.parse(payload);
    return this.call("channels.v1.register_capability", payload, options);
  }

  async acceptState(
    acceptance: StateAcceptanceMessage,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    const payload = {
      ...acceptance,
      state: encodeChannelState(acceptance.state),
      authorization: encodeStateAuthorization(acceptance.authorization),
    };
    stateAcceptanceWireSchema.parse(payload);
    return this.call(
      "channels.v1.accept_state",
      payload,
      options,
    );
  }

  async rejectState(
    proposalId: Bytes32,
    channelId: Bytes32,
    reason: string,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    return this.call(
      "channels.v1.reject_state",
      { proposalId, channelId, reason },
      options,
    );
  }

  async getState(
    channelId: Bytes32,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    return this.call("channels.v1.get_state", { channelId }, options);
  }

  async sendMessage(
    envelope: EncryptedEnvelope,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    return this.call(
      "messages.v1.send",
      { envelope: encodeEncryptedEnvelope(envelope) },
      options,
    );
  }

  async listMessages(
    channelId: Bytes32,
    afterSequence?: bigint,
    options?: RpcCallOptions,
  ): Promise<EncryptedMessageRecord[]> {
    const response = messageListResponseWireSchema.parse(
      await this.call(
        "messages.v1.list",
        {
          channelId,
          ...(afterSequence === undefined
            ? {}
            : { afterSequence: afterSequence.toString() }),
        },
        options,
      ),
    );
    return response.messages.map((record) => ({
      envelope: record.envelope,
      status: record.status,
      sentAt: record.sentAt,
      ...(record.deliveredAt === undefined
        ? {}
        : { deliveredAt: record.deliveredAt }),
      ...(record.acknowledgedAt === undefined
        ? {}
        : { acknowledgedAt: record.acknowledgedAt }),
    }));
  }

  async acknowledgeMessage(
    channelId: Bytes32,
    messageId: Bytes32,
    options?: RpcCallOptions,
  ): Promise<RpcPayload> {
    return this.call(
      "messages.v1.acknowledge",
      { channelId, messageId },
      options,
    );
  }

  async close(): Promise<void> {
    this.handleClose();
    await this.transport.close();
  }

  private allocateRequestId(): number {
    const start = this.nextRequestId;
    do {
      const candidate = this.nextRequestId;
      this.nextRequestId =
        this.nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : this.nextRequestId + 1;
      if (!this.pending.has(candidate)) return candidate;
    } while (this.nextRequestId !== start);

    throw new Error("all RPC request IDs are in use");
  }

  private handleMessage(data: string): void {
    let message: RpcMessage;
    try {
      message = decodeRpcMessage(data);
    } catch (error) {
      this.emitProtocolError(
        new RpcClientError(
          "INVALID_MESSAGE",
          error instanceof Error ? error.message : "relay sent an invalid message",
        ),
      );
      return;
    }

    if (Math.abs(this.now() - message.timestamp) > this.maxMessageAgeMs) {
      const error = new RpcClientError(
        "INVALID_MESSAGE",
        "relay message timestamp is outside the allowed window",
      );
      this.emitProtocolError(error);
      if (
        message.type === RpcMessageType.Response ||
        message.type === RpcMessageType.Error
      ) {
        this.rejectPending(message.requestId, error);
      }
      return;
    }

    if (message.type === RpcMessageType.Event) {
      for (const listener of this.eventListeners) listener(message);
      return;
    }

    if (
      message.type !== RpcMessageType.Response &&
      message.type !== RpcMessageType.Error
    ) {
      this.emitProtocolError(
        new RpcClientError("INVALID_MESSAGE", "client received a non-response RPC message"),
      );
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.emitProtocolError(
        new RpcClientError(
          "UNEXPECTED_RESPONSE",
          `no request is pending for response ${message.requestId}`,
        ),
      );
      return;
    }
    this.clearPending(message.requestId);

    if (pending.method !== message.method) {
      pending.reject(
        new RpcClientError(
          "METHOD_MISMATCH",
          `response method ${message.method} does not match ${pending.method}`,
        ),
      );
      return;
    }

    if (message.type === RpcMessageType.Error) {
      const remote = rpcErrorPayloadSchema.safeParse(message.payload);
      pending.reject(
        new RpcClientError(
          "REMOTE_ERROR",
          remote.success
            ? `${remote.data.code}: ${remote.data.message}`
            : "relay returned a malformed error",
        ),
      );
      return;
    }

    pending.resolve(message);
  }

  private handleClose(error?: Error): void {
    if (!this.connected && this.pending.size === 0) return;
    this.connected = false;
    for (const [requestId, pending] of this.pending) {
      this.clearPending(requestId);
      pending.reject(
        new RpcClientError(
          "CONNECTION_CLOSED",
          error?.message ?? "relay connection closed",
        ),
      );
    }
  }

  private clearPending(requestId: number): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    this.pending.delete(requestId);
  }

  private rejectPending(requestId: number, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.clearPending(requestId);
    pending.reject(error);
  }

  private emitProtocolError(error: RpcClientError): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
