// Minimal JSON-RPC 2.0 client over a WebSocket to `goose serve` /acp.
// Full duplex is required: the server pushes `session/update`
// notifications and sends `session/request_permission` requests the
// client must answer. Auth is the `X-Secret-Key` header (never logged,
// never part of any error string).

import { GooseAcpError } from "./errors.js";

export const ACP_PROTOCOL_VERSION = 1;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: GooseAcpError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (method: string, params: unknown, id: string | number) => unknown | Promise<unknown>;

/** Convert an http(s) base URL to the ws(s) /acp endpoint. */
export function acpWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const ws = trimmed.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
  return ws.endsWith("/acp") ? ws : `${ws}/acp`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class AcpClient {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  private onNotif: NotificationHandler = () => {};
  private onReq: ServerRequestHandler | null = null;
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (ev) => this.onMessage(String(ev.data));
    socket.onerror = () => this.failAll(new GooseAcpError("protocol", "ACP connection error"));
    socket.onclose = () => this.failAll(new GooseAcpError("protocol", "ACP connection closed"));
  }

  /** Open the socket and resolve once established (bounded wait, no hang). */
  static async connect(baseUrl: string, secret: string, connectTimeoutMs: number): Promise<AcpClient> {
    const url = acpWebSocketUrl(baseUrl);
    return new Promise<AcpClient>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          socket.close();
        } catch {
          // ignore teardown races
        }
        reject(new GooseAcpError("connect", `ACP connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      // The secret travels as a header only; it never appears in the URL,
      // logs, or error strings.
      const socket = new WebSocket(url, { headers: { "X-Secret-Key": secret } } as unknown as string[]);
      socket.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(new AcpClient(socket));
      };
      socket.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new GooseAcpError("connect", "ACP connect failed"));
      };
    });
  }

  onNotification(handler: NotificationHandler): void {
    this.onNotif = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.onReq = handler;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and await its response (bounded wait, rejects on error). */
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new GooseAcpError("protocol", `ACP connection closed (${method})`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GooseAcpError("timeout", `ACP request timed out (${method})`));
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new GooseAcpError("protocol", `ACP send failed (${method}): ${errorMessage(e)}`));
      }
    });
  }

  /** Fire-and-forget notification (cancel). Never throws. */
  notify(method: string, params: Record<string, unknown>): void {
    try {
      if (!this.closed) this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    } catch {
      // best-effort: the socket is going away
    }
  }

  /** Close the socket and reject everything still pending. Never throws. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // already gone
    }
    this.failAll(new GooseAcpError("cancelled", "ACP connection closed"));
  }

  private failAll(e: GooseAcpError): void {
    if (this.pending.size === 0) return;
    const rest = [...this.pending.values()];
    this.pending.clear();
    for (const p of rest) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  }

  private onMessage(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // malformed frame: skip, keep the connection alive
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
    const rec = msg as Record<string, unknown>;
    const id = rec["id"];
    if ((typeof id === "string" || typeof id === "number") && ("result" in rec || "error" in rec)) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in rec && rec["error"] !== undefined && rec["error"] !== null) {
        const detail = errorDetail(rec["error"]);
        p.reject(new GooseAcpError("protocol", `ACP error: ${detail}`));
      } else {
        p.resolve(rec["result"]);
      }
      return;
    }
    const method = typeof rec["method"] === "string" ? (rec["method"] as string) : undefined;
    if (!method) return;
    if (id !== undefined && (typeof id === "string" || typeof id === "number")) {
      void this.answerServerRequest(method, rec["params"], id);
      return;
    }
    try {
      this.onNotif(method, rec["params"]);
    } catch {
      // a handler bug must never kill the connection
    }
  }

  private async answerServerRequest(method: string, params: unknown, id: string | number): Promise<void> {
    if (this.closed) return;
    try {
      const result = this.onReq ? await this.onReq(method, params, id) : undefined;
      if (this.onReq) {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
      } else {
        this.socket.send(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown server request: ${method}` } }),
        );
      }
    } catch (e) {
      try {
        this.socket.send(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: errorMessage(e) } }),
        );
      } catch {
        // socket going away
      }
    }
  }
}

function errorDetail(e: unknown): string {
  if (e === null || typeof e !== "object") return String(e);
  const rec = e as Record<string, unknown>;
  const msg = typeof rec["message"] === "string" ? rec["message"] : "unknown error";
  const data = rec["data"];
  if (data === undefined || data === null) return msg;
  try {
    return `${msg}: ${JSON.stringify(data).slice(0, 300)}`;
  } catch {
    return msg;
  }
}
