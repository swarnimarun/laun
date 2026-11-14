import { randomUUID } from "node:crypto";
import type { BrokerConnection, McpProtocolVersion } from "@laun/protocol";
import { canonicalJson, isRecord } from "./canonical.js";
import { postPinned, type PinnedEndpoint } from "./network.js";
import { BrokerOutcomeUnknownError } from "./error.js";

interface HeaderBinding { name: string; path: string[]; type: "string" | "boolean" | "integer"; }
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "laun", version: "0.1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

export function headerValue(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value) || value.trim() !== value || (value.startsWith("=?base64?") && value.endsWith("?="))) {
    return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
  }
  return value;
}

/** Reject header annotations outside statically reachable property paths. */
export function schemaHeaderBindings(schema: Record<string, unknown>): HeaderBinding[] {
  const result: HeaderBinding[] = [];
  const names = new Set<string>();
  const visit = (node: unknown, path: string[], reachable: boolean, depth: number) => {
    if (depth > 32) throw new Error("tool schema nesting limit exceeded");
    if (!isRecord(node) && !Array.isArray(node)) return;
    if (Array.isArray(node)) { for (const entry of node) visit(entry, path, false, depth + 1); return; }
    if (Object.hasOwn(node, "x-mcp-header")) {
      const name = node["x-mcp-header"];
      if (!reachable || path.length === 0 || typeof name !== "string" || name.length > 128 ||
        !/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(name) || names.has(name.toLowerCase()) ||
        !["string", "boolean", "integer"].includes(String(node.type))) throw new Error("invalid MCP parameter header annotation");
      names.add(name.toLowerCase());
      result.push({ name, path, type: node.type as HeaderBinding["type"] });
      if (result.length > 64) throw new Error("too many MCP parameter headers");
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isRecord(value) && reachable) {
        for (const [property, child] of Object.entries(value)) visit(child, [...path, property], true, depth + 1);
      } else if (key !== "x-mcp-header") visit(value, path, false, depth + 1);
    }
  };
  visit(schema, [], true, 0);
  return result;
}

export function parameterHeaders(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const binding of schemaHeaderBindings(schema)) {
    let value: unknown = args;
    for (const property of binding.path) {
      if (!isRecord(value) || !Object.hasOwn(value, property)) { value = undefined; break; }
      value = value[property];
    }
    if (value === undefined || value === null) continue;
    if ((binding.type === "integer" && !Number.isSafeInteger(value)) ||
      (binding.type !== "integer" && typeof value !== binding.type)) throw new Error("MCP header argument has the wrong type");
    headers[`Mcp-Param-${binding.name}`] = headerValue(String(value));
  }
  return headers;
}

function parseEnvelope(text: string, id: string): unknown {
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { throw new Error("connector sent malformed JSON"); }
  if (!isRecord(envelope) || envelope.jsonrpc !== "2.0") throw new Error("connector sent invalid JSON-RPC");
  if (typeof envelope.method === "string") {
    if (Object.hasOwn(envelope, "id")) throw new Error("connector-initiated requests are not permitted");
    if (!["notifications/progress", "notifications/message"].includes(envelope.method)) throw new Error("connector catalog changed or unsupported notification; rediscover before another call");
    return undefined;
  }
  if (envelope.id !== id) throw new Error("connector response request ID mismatch");
  if (isRecord(envelope.error)) throw new Error(`connector rejected request (JSON-RPC ${String(envelope.error.code)})`);
  if (!Object.hasOwn(envelope, "result")) throw new Error("connector response has no result");
  const result = envelope.result;
  if (isRecord(result) && (result.resultType === "input_required" || Object.hasOwn(result, "inputRequests"))) {
    throw new Error("connector requested unsupported sampling/elicitation/roots; no automatic response was sent");
  }
  return result;
}

function responseResult(body: string, contentType: string, id: string): unknown {
  if (contentType.toLowerCase().includes("application/json")) {
    const result = parseEnvelope(body, id);
    if (result === undefined) throw new Error("connector ended without a response");
    return result;
  }
  if (!contentType.toLowerCase().includes("text/event-stream")) throw new Error("connector response must be JSON or SSE");
  let result: unknown;
  let sawResult = false;
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    const value = parseEnvelope(data, id);
    if (value !== undefined) {
      if (sawResult) throw new Error("connector sent multiple final responses");
      result = value; sawResult = true;
    }
  }
  if (!sawResult) throw new Error("connector stream ended without a response");
  return result;
}

export class McpHttpClient {
  readonly protocol: McpProtocolVersion;
  private sessionId: string | undefined;
  constructor(private endpoint: PinnedEndpoint, connection: BrokerConnection,
    private secret: string | undefined, private limits: { timeoutMs: number; maxBytes: number },
    private controls: { signal?: AbortSignal; beforeRequest?(): void | Promise<void>; onToolDispatch?(): void } = {}) {
    this.protocol = connection.protocolVersion ?? "2026-07-28";
  }

  private signal(other?: AbortSignal): AbortSignal | undefined {
    return other && this.controls.signal ? AbortSignal.any([other, this.controls.signal]) : other ?? this.controls.signal;
  }
  private async check(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await this.controls.beforeRequest?.(); signal?.throwIfAborted();
  }
  private async request(body: string | undefined, headers: Record<string, string>, signal?: AbortSignal, method?: "DELETE", dispatch?: () => void) {
    const abort = this.signal(signal); await this.check(abort);
    // This is the last boundary before an attempted socket write. Once crossed,
    // even a timeout, revoked authority or malformed reply cannot prove no effect.
    dispatch?.();
    const result = await postPinned(this.endpoint, body, headers, { ...this.limits, signal: abort, ...(method ? { method, timeoutMs: Math.min(this.limits.timeoutMs, 2_000) } : {}) });
    await this.check(abort); return result;
  }

  private headers(method?: string, toolName?: string): Record<string, string> {
    return {
      "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.protocol,
      ...(this.secret ? { authorization: `Bearer ${this.secret}` } : {}),
      ...(this.protocol === "2026-07-28" && method ? { "Mcp-Method": method, ...(toolName ? { "Mcp-Name": headerValue(toolName) } : {}) } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.check(this.signal(signal));
    if (this.protocol === "2026-07-28") return;
    const id = randomUUID();
    const reply = await this.request(canonicalJson({ jsonrpc: "2.0", id, method: "initialize", params: {
      protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: "laun", version: "0.1.0" },
    } }), this.headers(), signal);
    if (reply.status < 200 || reply.status >= 300) throw new Error(`connector initialization HTTP ${reply.status}`);
    const result = responseResult(reply.body, reply.contentType, id);
    if (!isRecord(result) || result.protocolVersion !== this.protocol) throw new Error("connector protocol version mismatch; choose a supported explicit version");
    if (reply.sessionId) {
      if (!/^[\x21-\x7e]{1,256}$/.test(reply.sessionId)) throw new Error("connector returned an invalid session ID");
      this.sessionId = reply.sessionId;
    }
    const notification = await this.request(canonicalJson({ jsonrpc: "2.0", method: "notifications/initialized" }), this.headers(), signal);
    if (notification.status !== 202 && notification.status !== 204) throw new Error("connector refused initialization notification");
  }

  async call(method: "tools/list" | "tools/call", params: Record<string, unknown>, schema?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = randomUUID();
    const modern = this.protocol === "2026-07-28";
    const args = canonicalJson({ jsonrpc: "2.0", id, method, params: { ...params, ...(modern ? { _meta: META } : {}) } }, 262_144);
    const headers = this.headers(method, typeof params.name === "string" ? params.name : undefined);
    if (modern && method === "tools/call" && schema && isRecord(params.arguments)) Object.assign(headers, parameterHeaders(schema, params.arguments));
    let dispatched = false;
    try {
      const reply = await this.request(args, headers, signal, undefined, method === "tools/call" ? () => {
        dispatched = true; this.controls.onToolDispatch?.();
      } : undefined);
      if (reply.status < 200 || reply.status >= 300) throw new Error(`connector HTTP ${reply.status}; operation was not retried`);
      return responseResult(reply.body, reply.contentType, id);
    } catch (cause) {
      if (dispatched) throw new BrokerOutcomeUnknownError({ cause });
      throw cause;
    }
  }

  async close(signal?: AbortSignal): Promise<void> {
    if (!this.sessionId) return;
    const headers = this.headers();
    this.sessionId = undefined;
    // End only our own negotiated legacy session. Failure never retries a tool.
    await this.request(undefined, headers, signal, "DELETE").catch(() => {});
  }
}
