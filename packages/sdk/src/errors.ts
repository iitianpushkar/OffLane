export class RpcClientError extends Error {
  constructor(
    public readonly code:
      | "NOT_CONNECTED"
      | "ALREADY_CONNECTED"
      | "REQUEST_TIMEOUT"
      | "REQUEST_ABORTED"
      | "CONNECTION_CLOSED"
      | "INVALID_MESSAGE"
      | "UNEXPECTED_RESPONSE"
      | "METHOD_MISMATCH"
      | "REMOTE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "RpcClientError";
  }
}
