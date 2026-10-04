/** Typed errors for the goose ACP adapter. Never carries the secret. */

export type GooseAcpErrorCode =
  | "connect"
  | "initialize"
  | "session"
  | "prompt"
  | "protocol"
  | "timeout"
  | "aborted"
  | "cancelled";

export class GooseAcpError extends Error {
  readonly code: GooseAcpErrorCode;
  constructor(code: GooseAcpErrorCode, message: string) {
    super(message);
    this.name = "GooseAcpError";
    this.code = code;
  }
}
