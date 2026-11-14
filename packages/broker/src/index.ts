import type { BrokerConnection, BrokerContext, BrokerTool, BrokerToolResult, PermissionOperation } from "@laun/protocol";
import { argumentsDigest, canonicalJson, isRecord, redactSecrets, sha256 } from "./canonical.js";
import { McpHttpClient, schemaHeaderBindings } from "./client.js";
import { pinEndpoint } from "./network.js";

export { argumentsDigest, canonicalJson, redactSecrets } from "./canonical.js";
export { isPublicAddress, isLoopback, pinEndpoint } from "./network.js";
export { headerValue, parameterHeaders, schemaHeaderBindings } from "./client.js";
export { proposePermissionChange } from "./adviser.js";

export interface ToolBrokerOptions {
  /** Must reject unless the current server authority allows this exact intent. */
  authorize(context: BrokerContext, operation: PermissionOperation, resource: string, args: unknown, signal?: AbortSignal): Promise<void>;
  /** Trusted current-authority check only; it must never consume another grant. */
  assertActive?(context: BrokerContext, signal?: AbortSignal): void | Promise<void>;
  loadConnection(id: string): BrokerConnection | undefined | Promise<BrokerConnection | undefined>;
  /** Legacy storage seam; discovery requires the atomic catalog operation below. */
  saveConnection?(connection: BrokerConnection): void | Promise<void>;
  /** Compare expected binding AND prior catalog atomically; merge only these fields into latest metadata. */
  saveCatalog?(expected: BrokerConnection, catalog: Required<Pick<BrokerConnection, "tools" | "catalogDigest" | "discoveredAt">>): BrokerConnection | Promise<BrokerConnection>;
  resolveSecret?(reference: string, context: BrokerContext): string | undefined | Promise<string | undefined>;
  /** Developer controller exception; connection.allowLocal must also be explicit. */
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Trusted resolver seam; production uses the checked/pinned implementation. */
  resolveEndpoint?: typeof pinEndpoint;
  orchestration?(context: BrokerContext, operation: "mower.spawn" | "task.handoff", resource: string, args: Record<string, unknown>): Promise<unknown>;
  warn?(message: string): void;
}

function validIdentity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function assertContext(context: BrokerContext): void {
  if (!context || ![context.principalId, context.workspaceId, context.mowerId, context.threadId, context.runId].every(validIdentity)) throw new Error("invalid broker identity context");
  if (context.generation !== undefined && (!Number.isSafeInteger(context.generation) || context.generation < 0)) throw new Error("invalid broker generation");
}
async function cancellable<T>(value: T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await value;
  if (signal.aborted) { void Promise.resolve(value).catch(() => {}); signal.throwIfAborted(); }
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("broker operation cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

/** Endpoint identity is part of each discovered tool's immutable authorization resource. */
export function toolDigest(connection: BrokerConnection, definition: Record<string, unknown>): string {
  return sha256(canonicalJson({ endpoint: new URL(connection.url).href, protocol: connection.protocolVersion ?? "2026-07-28", secretRef: connection.secretRef ?? null, allowLocal: connection.allowLocal === true, definition }, 262_144));
}

export function toolResource(connectionId: string, name: string, digest: string): string {
  return `mcp:${connectionId}:${encodeURIComponent(name)}:${digest}`;
}

/** Storage CAS identity: names may change; security binding and prior catalog may not. */
export function catalogStorageIdentity(connection: BrokerConnection): string {
  return canonicalJson({ id: connection.id, ownerId: connection.ownerId, workspaceId: connection.workspaceId, transport: connection.transport,
    endpoint: new URL(connection.url).href, protocol: connection.protocolVersion ?? "2026-07-28", secretRef: connection.secretRef ?? null,
    allowLocal: connection.allowLocal === true, enabled: connection.enabled !== false, tools: connection.tools ?? null,
    catalogDigest: connection.catalogDigest ?? null, discoveredAt: connection.discoveredAt ?? null }, 2_097_152);
}

export class ToolBroker {
  private readonly limits: { timeoutMs: number; maxBytes: number };
  constructor(private options: ToolBrokerOptions) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 300_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8_388_608) throw new Error("invalid broker limits");
    this.limits = { timeoutMs, maxBytes };
  }

  private async active(context: BrokerContext, signal?: AbortSignal): Promise<void> {
    assertContext(context);
    signal?.throwIfAborted(); await cancellable(this.options.assertActive?.(context, signal), signal); signal?.throwIfAborted();
  }

  private async connection(context: BrokerContext, id: string, signal?: AbortSignal): Promise<BrokerConnection> {
    await this.active(context, signal);
    if (!validIdentity(id)) throw new Error("invalid connector ID");
    const value = await cancellable(this.options.loadConnection(id), signal);
    await this.active(context, signal);
    if (!value || value.id !== id || value.workspaceId !== context.workspaceId || value.ownerId !== context.principalId) throw new Error("connector not found");
    if (value.transport !== "http") throw new Error("unsupported connector transport; executable plugins require a sandbox adapter");
    if (value.enabled === false) throw new Error("connector is disabled");
    if (value.protocolVersion !== undefined && value.protocolVersion !== "2026-07-28" && value.protocolVersion !== "2025-11-25") throw new Error("unsupported explicit MCP protocol version");
    // Snapshot prevents in-process mutations from changing the endpoint between
    // authorization, DNS lookup and dispatch. Store changes invalidate catalogs.
    return JSON.parse(canonicalJson(value, 2_097_152)) as BrokerConnection;
  }

  private binding(connection: BrokerConnection): string {
    return canonicalJson({ id: connection.id, ownerId: connection.ownerId, workspaceId: connection.workspaceId, transport: connection.transport,
      endpoint: new URL(connection.url).href, protocol: connection.protocolVersion ?? "2026-07-28", secretRef: connection.secretRef ?? null, allowLocal: connection.allowLocal === true });
  }
  private tool(connection: BrokerConnection, name: string, expectedSchemaDigest: string): BrokerTool {
    const tool = connection.tools?.find((item) => item.name === name);
    if (!tool || !/^[0-9a-f]{64}$/.test(expectedSchemaDigest) || tool.schemaDigest !== expectedSchemaDigest ||
      toolDigest(connection, tool.definition) !== tool.schemaDigest || tool.resource !== toolResource(connection.id, name, tool.schemaDigest) ||
      !isRecord(tool.definition.inputSchema) || canonicalJson(tool.inputSchema) !== canonicalJson(tool.definition.inputSchema)) {
      throw new Error("connector tool schema changed or was not discovered; rediscover and authorize the new tool identity");
    }
    return tool;
  }
  private async current(context: BrokerContext, snapshot: BrokerConnection, signal?: AbortSignal, selected?: { name: string; digest: string }): Promise<BrokerConnection> {
    const latest = await this.connection(context, snapshot.id, signal);
    if (this.binding(latest) !== this.binding(snapshot)) throw new Error("connector changed during operation; rediscover and review the current binding");
    if (selected) this.tool(latest, selected.name, selected.digest);
    return latest;
  }

  private async withClient<T>(context: BrokerContext, connection: BrokerConnection, work: (client: McpHttpClient, secret?: string) => Promise<T>, signal?: AbortSignal,
    selected?: { name: string; digest: string }): Promise<T> {
    const check = async () => { await this.current(context, connection, signal, selected); };
    await check();
    let url: URL;
    try { url = new URL(connection.url); } catch { throw new Error("connector endpoint must be a valid URL"); }
    if (url.username || url.password || url.hash) throw new Error("connector endpoint must not contain credentials or a fragment");
    await cancellable(this.options.authorize(context, "network.connect", url.origin, { endpoint: url.href, connectorId: connection.id }, signal), signal);
    await check();
    const endpoint = await cancellable((this.options.resolveEndpoint ?? pinEndpoint)(url.href, this.options.allowLoopback === true && connection.allowLocal === true, signal), signal);
    await check();
    let secret: string | undefined;
    if (connection.secretRef) {
      if (!this.options.resolveSecret) throw new Error("connector credential resolver is not configured");
      secret = await cancellable(this.options.resolveSecret(connection.secretRef, context), signal);
      await check();
      if (!secret || /[\r\n]/.test(secret) || secret.length > 8192) throw new Error("connector credential is unavailable or invalid");
    }
    await check();
    const client = new McpHttpClient(endpoint, connection, secret, this.limits, { signal, beforeRequest: check });
    try {
      await client.initialize(signal); await check();
      const result = await work(client, secret); await check(); return result;
    } finally { await client.close(signal); }
  }

  async discover(context: BrokerContext, id: string, signal?: AbortSignal): Promise<BrokerConnection> {
    context = { ...context };
    if (!this.options.saveCatalog) throw new Error("atomic connector catalog storage is required before discovery");
    const connection = await this.connection(context, id, signal);
    const tools = await this.withClient(context, connection, async (client, secret) => {
      const tools: BrokerTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 32; page++) {
        const result = redactSecrets(await client.call("tools/list", cursor ? { cursor } : {}, undefined, signal), secret ? [secret] : []);
        if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error("connector sent invalid tool catalog");
        for (const definition of result.tools) {
          if (!isRecord(definition) || typeof definition.name !== "string" || definition.name.length < 1 || definition.name.length > 128 ||
            /[\u0000-\u001f\u007f]/.test(definition.name) || !isRecord(definition.inputSchema)) throw new Error("connector sent invalid tool definition");
          if (names.has(definition.name)) throw new Error("connector catalog has duplicate tool names");
          names.add(definition.name);
          if (tools.length >= 512) throw new Error("connector tool catalog limit exceeded");
          try { schemaHeaderBindings(definition.inputSchema); }
          catch {
            this.options.warn?.(`Excluded invalid MCP header schema for tool ${definition.name}`);
            continue;
          }
          const digest = toolDigest(connection, definition);
          tools.push({ name: definition.name, ...(typeof definition.description === "string" ? { description: definition.description } : {}),
            inputSchema: definition.inputSchema, definition, schemaDigest: digest, resource: toolResource(id, definition.name, digest) });
        }
        if (result.nextCursor === undefined) return tools.sort((a, b) => a.name.localeCompare(b.name));
        if (typeof result.nextCursor !== "string" || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw new Error("invalid or repeated connector catalog cursor");
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      throw new Error("connector catalog pagination limit exceeded");
    }, signal);
    // A concurrent endpoint update must not be overwritten by stale discovery.
    await this.current(context, connection, signal);
    // Compare against the snapshot from BEFORE discovery, not a fresh read:
    // another completed discovery must not be overwritten by an older list.
    return await cancellable(this.options.saveCatalog(connection, { tools, catalogDigest: sha256(canonicalJson(tools.map((tool) => tool.schemaDigest))), discoveredAt: new Date().toISOString() }), signal);
  }

  async invoke(context: BrokerContext, id: string, name: string, args: unknown, expectedSchemaDigest: string, signal?: AbortSignal): Promise<BrokerToolResult> {
    context = { ...context };
    const connection = await this.connection(context, id, signal);
    const tool = this.tool(connection, name, expectedSchemaDigest);
    if (!isRecord(args)) throw new Error("connector arguments must be a JSON object");
    const canonicalArgs = JSON.parse(canonicalJson(args)) as Record<string, unknown>;
    // Authorization precedes DNS, secret acquisition and all external traffic.
    await cancellable(this.options.authorize(context, "mcp.invoke", tool.resource, { connectorId: id, tool: name, schemaDigest: tool.schemaDigest,
      arguments: canonicalArgs, argumentsDigest: argumentsDigest(canonicalArgs) }, signal), signal);
    await this.current(context, connection, signal, { name, digest: expectedSchemaDigest });
    return await this.withClient(context, connection, async (client, secret) => {
      const value = redactSecrets(await client.call("tools/call", { name, arguments: canonicalArgs }, tool.inputSchema, signal), secret ? [secret] : []);
      if (!isRecord(value) || !Array.isArray(value.content) || (value.isError !== undefined && typeof value.isError !== "boolean") ||
        (value.structuredContent !== undefined && !isRecord(value.structuredContent))) throw new Error("connector returned an invalid tool result");
      return { content: value.content, ...(value.isError !== undefined ? { isError: value.isError as boolean } : {}),
        ...(value.structuredContent ? { structuredContent: value.structuredContent as Record<string, unknown> } : {}) };
    }, signal, { name, digest: expectedSchemaDigest });
  }

  async dispatch(context: BrokerContext, operation: "mower.spawn" | "task.handoff", resource: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    context = { ...context }; await this.active(context, signal);
    if (operation !== "mower.spawn" && operation !== "task.handoff") throw new Error("unsupported broker orchestration operation");
    if (!this.options.orchestration) throw new Error("orchestration adapter is unavailable");
    const snapshot = JSON.parse(canonicalJson(args)) as Record<string, unknown>;
    await cancellable(this.options.authorize(context, operation, resource, snapshot, signal), signal); await this.active(context, signal);
    return await this.options.orchestration(context, operation, resource, snapshot);
  }
}

export const createToolBroker = (options: ToolBrokerOptions) => new ToolBroker(options);
