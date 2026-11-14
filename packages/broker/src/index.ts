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
  authorize(context: BrokerContext, operation: PermissionOperation, resource: string, args: unknown): Promise<void>;
  loadConnection(id: string): BrokerConnection | undefined | Promise<BrokerConnection | undefined>;
  saveConnection(connection: BrokerConnection): void | Promise<void>;
  resolveSecret?(reference: string, context: BrokerContext): string | undefined | Promise<string | undefined>;
  /** Developer controller exception; connection.allowLocal must also be explicit. */
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  orchestration?(context: BrokerContext, operation: "mower.spawn" | "task.handoff", resource: string, args: Record<string, unknown>): Promise<unknown>;
  warn?(message: string): void;
}

function validIdentity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function assertContext(context: BrokerContext): void {
  if (!context || ![context.principalId, context.workspaceId, context.mowerId, context.threadId, context.runId].every(validIdentity)) throw new Error("invalid broker identity context");
}

/** Endpoint identity is part of each discovered tool's immutable authorization resource. */
export function toolDigest(connection: BrokerConnection, definition: Record<string, unknown>): string {
  return sha256(canonicalJson({ endpoint: new URL(connection.url).href, protocol: connection.protocolVersion ?? "2026-07-28", definition }, 262_144));
}

export function toolResource(connectionId: string, name: string, digest: string): string {
  return `mcp:${connectionId}:${encodeURIComponent(name)}:${digest}`;
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

  private async connection(context: BrokerContext, id: string): Promise<BrokerConnection> {
    assertContext(context);
    if (!validIdentity(id)) throw new Error("invalid connector ID");
    const value = await this.options.loadConnection(id);
    if (!value || value.id !== id || value.workspaceId !== context.workspaceId || value.ownerId !== context.principalId) throw new Error("connector not found");
    if (value.transport !== "http") throw new Error("unsupported connector transport; executable plugins require a sandbox adapter");
    if (value.enabled === false) throw new Error("connector is disabled");
    if (value.protocolVersion !== undefined && value.protocolVersion !== "2026-07-28" && value.protocolVersion !== "2025-11-25") throw new Error("unsupported explicit MCP protocol version");
    // Snapshot prevents in-process mutations from changing the endpoint between
    // authorization, DNS lookup and dispatch. Store changes invalidate catalogs.
    return JSON.parse(canonicalJson(value, 2_097_152)) as BrokerConnection;
  }

  private async withClient<T>(context: BrokerContext, connection: BrokerConnection, work: (client: McpHttpClient, secret?: string) => Promise<T>): Promise<T> {
    let url: URL;
    try { url = new URL(connection.url); } catch { throw new Error("connector endpoint must be a valid URL"); }
    if (url.username || url.password || url.hash) throw new Error("connector endpoint must not contain credentials or a fragment");
    await this.options.authorize(context, "network.connect", url.origin, { endpoint: url.href, connectorId: connection.id });
    const endpoint = await pinEndpoint(url.href, this.options.allowLoopback === true && connection.allowLocal === true);
    let secret: string | undefined;
    if (connection.secretRef) {
      if (!this.options.resolveSecret) throw new Error("connector credential resolver is not configured");
      secret = await this.options.resolveSecret(connection.secretRef, context);
      if (!secret || /[\r\n]/.test(secret) || secret.length > 8192) throw new Error("connector credential is unavailable or invalid");
    }
    const client = new McpHttpClient(endpoint, connection, secret, this.limits);
    try {
      await client.initialize();
      return await work(client, secret);
    } finally { await client.close(); }
  }

  async discover(context: BrokerContext, id: string): Promise<BrokerConnection> {
    const connection = await this.connection(context, id);
    const tools = await this.withClient(context, connection, async (client, secret) => {
      const tools: BrokerTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 32; page++) {
        const result = redactSecrets(await client.call("tools/list", cursor ? { cursor } : {}), secret ? [secret] : []);
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
    });
    const updated: BrokerConnection = { ...connection, tools, catalogDigest: sha256(canonicalJson(tools.map((tool) => tool.schemaDigest))), discoveredAt: new Date().toISOString() };
    // A concurrent endpoint update must not be overwritten by stale discovery.
    const latest = await this.connection(context, id);
    if (latest.url !== connection.url || latest.protocolVersion !== connection.protocolVersion || latest.secretRef !== connection.secretRef) throw new Error("connector changed during discovery; retry the read-only discovery");
    await this.options.saveConnection(updated);
    return updated;
  }

  async invoke(context: BrokerContext, id: string, name: string, args: unknown, expectedSchemaDigest: string): Promise<BrokerToolResult> {
    const connection = await this.connection(context, id);
    const tool = connection.tools?.find((item) => item.name === name);
    if (!tool || !/^[0-9a-f]{64}$/.test(expectedSchemaDigest) || tool.schemaDigest !== expectedSchemaDigest ||
      toolDigest(connection, tool.definition) !== tool.schemaDigest || tool.resource !== toolResource(id, name, tool.schemaDigest)) {
      throw new Error("connector tool schema changed or was not discovered; rediscover and authorize the new tool identity");
    }
    if (!isRecord(args)) throw new Error("connector arguments must be a JSON object");
    const canonicalArgs = JSON.parse(canonicalJson(args)) as Record<string, unknown>;
    // Authorization precedes DNS, secret acquisition and all external traffic.
    await this.options.authorize(context, "mcp.invoke", tool.resource, { connectorId: id, tool: name, schemaDigest: tool.schemaDigest,
      arguments: canonicalArgs, argumentsDigest: argumentsDigest(canonicalArgs) });
    return await this.withClient(context, connection, async (client, secret) => {
      const value = redactSecrets(await client.call("tools/call", { name, arguments: canonicalArgs }, tool.inputSchema), secret ? [secret] : []);
      if (!isRecord(value) || !Array.isArray(value.content) || (value.isError !== undefined && typeof value.isError !== "boolean") ||
        (value.structuredContent !== undefined && !isRecord(value.structuredContent))) throw new Error("connector returned an invalid tool result");
      return { content: value.content, ...(value.isError !== undefined ? { isError: value.isError as boolean } : {}),
        ...(value.structuredContent ? { structuredContent: value.structuredContent as Record<string, unknown> } : {}) };
    });
  }

  async dispatch(context: BrokerContext, operation: "mower.spawn" | "task.handoff", resource: string, args: Record<string, unknown>): Promise<unknown> {
    assertContext(context);
    if (operation !== "mower.spawn" && operation !== "task.handoff") throw new Error("unsupported broker orchestration operation");
    if (!this.options.orchestration) throw new Error("orchestration adapter is unavailable");
    const snapshot = JSON.parse(canonicalJson(args)) as Record<string, unknown>;
    await this.options.authorize(context, operation, resource, snapshot);
    return await this.options.orchestration(context, operation, resource, snapshot);
  }
}

export const createToolBroker = (options: ToolBrokerOptions) => new ToolBroker(options);
