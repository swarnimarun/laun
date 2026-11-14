import { afterEach, describe, expect, test } from "bun:test";
import type { BrokerConnection, BrokerContext, PermissionAction, PermissionProfile } from "@laun/protocol";
import { argumentsDigest, canonicalJson, createToolBroker, headerValue, isPublicAddress, parameterHeaders, pinEndpoint, proposePermissionChange, toolDigest } from "./index.js";
import { postPinned } from "./network.js";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const context: BrokerContext = { principalId: "owner", workspaceId: "workspace", mowerId: "fern", threadId: "thread", runId: "run" };
const definition = { name: "echo", description: "Return input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

function fixture(options: { legacy?: boolean; sse?: boolean; result?: unknown; redirect?: boolean; slow?: boolean; max?: boolean } = {}) {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const state = { definition: structuredClone(definition) as Record<string, unknown> };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    const body = await req.json() as Record<string, unknown>;
    requests.push({ body, headers: req.headers });
    if (options.redirect) return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    const rpc = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }), { headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return rpc({ tools: [state.definition] });
    if (body.method !== "tools/call") return new Response("unsupported", { status: 400 });
    if (options.slow) await Bun.sleep(200);
    const params = body.params as Record<string, unknown>;
    const result = options.max ? { content: [{ type: "text", text: "x".repeat(4096) }] } : options.result ?? { content: [{ type: "text", text: String((params.arguments as Record<string, unknown>).text) }] };
    if (options.sse) return new Response(`: ping\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } });
    return rpc(result);
  } });
  servers.push(server);
  const connection: BrokerConnection = { id: "fixture", ownerId: "owner", workspaceId: "workspace", name: "Fixture", transport: "http",
    url: `http://127.0.0.1:${server.port}/mcp`, allowLocal: true, ...(options.legacy ? { protocolVersion: "2025-11-25" } : {}) };
  return { connection, requests, state };
}

function setup(connection: BrokerConnection, extra: Partial<Parameters<typeof createToolBroker>[0]> = {}) {
  const records = new Map([[connection.id, structuredClone(connection)]]);
  const authorizations: Array<{ operation: string; resource: string; args: unknown }> = [];
  const broker = createToolBroker({
    allowLoopback: true,
    loadConnection: (id) => records.get(id), saveConnection: (value) => { records.set(value.id, value); },
    authorize: async (_context, operation, resource, args) => { authorizations.push({ operation, resource, args }); },
    ...extra,
  });
  return { broker, records, authorizations };
}

async function callEcho(broker: ReturnType<typeof createToolBroker>, text = "hello") {
  const discovered = await broker.discover(context, "fixture");
  const tool = discovered.tools![0]!;
  return broker.invoke(context, "fixture", tool.name, { text }, tool.schemaDigest);
}

describe("MCP broker authorization and real HTTP transport", () => {
  test("socket DNS is pinned without changing the original HTTP hostname", async () => {
    const f = fixture();
    const url = new URL(f.connection.url);
    url.hostname = "never-resolve.invalid";
    const response = await postPinned({ url, address: "127.0.0.1", family: 4 }, JSON.stringify({ jsonrpc: "2.0", id: "pinned", method: "tools/list" }),
      { "content-type": "application/json" }, { timeoutMs: 1000, maxBytes: 4096 });
    expect(response.status).toBe(200);
    expect(f.requests[0]!.headers.get("host")).toBe(`never-resolve.invalid:${new URL(f.connection.url).port}`);
  });

  test("modern discovery pins complete identity and invocation emits required metadata", async () => {
    const f = fixture(); const { broker, authorizations } = setup(f.connection);
    expect(await callEcho(broker)).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(authorizations.map((a) => a.operation)).toEqual(["network.connect", "mcp.invoke", "network.connect"]);
    expect(authorizations[1]!.resource).toMatch(/^mcp:fixture:echo:[a-f0-9]{64}$/);
    const call = f.requests.find((r) => r.body.method === "tools/call")!;
    expect(call.headers.get("mcp-method")).toBe("tools/call");
    expect(call.headers.get("mcp-name")).toBe("echo");
    expect((call.body.params as Record<string, unknown>)._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
  });

  test("denial stops discovery before network or credential acquisition", async () => {
    const f = fixture(); let secrets = 0;
    const { broker } = setup({ ...f.connection, secretRef: "env:TEST" }, {
      authorize: async () => { throw new Error("denied"); }, resolveSecret: () => { secrets++; return "unavailable-to-agent"; },
    });
    await expect(broker.discover(context, "fixture")).rejects.toThrow("denied");
    expect(f.requests).toHaveLength(0); expect(secrets).toBe(0);
  });

  test("tool denial never calls the server, and cross-owner discovery is hidden", async () => {
    const f = fixture(); let denyTools = false;
    const { broker } = setup(f.connection, { authorize: async (_ctx, operation) => { if (denyTools && operation === "mcp.invoke") throw new Error("tool denied"); } });
    const discovered = await broker.discover(context, "fixture"); const before = f.requests.length; denyTools = true;
    await expect(broker.invoke(context, "fixture", "echo", { text: "write" }, discovered.tools![0]!.schemaDigest)).rejects.toThrow("tool denied");
    expect(f.requests).toHaveLength(before);
    await expect(broker.discover({ ...context, principalId: "other" }, "fixture")).rejects.toThrow("not found");
    await expect(broker.discover({ ...context, workspaceId: "other" }, "fixture")).rejects.toThrow("not found");
  });

  test("loopback needs both explicit exceptions and no redirect is followed", async () => {
    const f = fixture();
    await expect(setup(f.connection, { allowLoopback: false }).broker.discover(context, "fixture")).rejects.toThrow("private or reserved");
    await expect(setup({ ...f.connection, allowLocal: false }).broker.discover(context, "fixture")).rejects.toThrow("private or reserved");
    expect(f.requests).toHaveLength(0);
    const redirected = fixture({ redirect: true });
    await expect(setup(redirected.connection).broker.discover(context, "fixture")).rejects.toThrow("redirects are forbidden");
    expect(redirected.requests).toHaveLength(1);
    await expect(pinEndpoint("http://user:secret@127.0.0.1/mcp", true)).rejects.toThrow("credentials");
    await expect(pinEndpoint("http://169.254.169.254/latest/meta-data", true)).rejects.toThrow("private or reserved");
  });

  test("schema or endpoint changes invalidate old identity without a tool call", async () => {
    const f = fixture(); const { broker, records } = setup(f.connection);
    const old = (await broker.discover(context, "fixture")).tools![0]!;
    f.state.definition = { ...definition, description: "Perform a different effect" };
    const next = (await broker.discover(context, "fixture")).tools![0]!;
    expect(next.schemaDigest).not.toBe(old.schemaDigest);
    const before = f.requests.length;
    await expect(broker.invoke(context, "fixture", "echo", { text: "unsafe" }, old.schemaDigest)).rejects.toThrow("schema changed");
    const record = records.get("fixture")!;
    records.set("fixture", { ...record, url: record.url + "?other=endpoint" });
    await expect(broker.invoke(context, "fixture", "echo", { text: "unsafe" }, next.schemaDigest)).rejects.toThrow("schema changed");
    expect(f.requests).toHaveLength(before);
  });

  test("credentials stay broker-side and echoed secrets are redacted", async () => {
    const secret = 'credential-"never-transcript';
    const f = fixture({ result: { content: [{ type: "text", text: `server accidentally echoed ${secret}` }] } });
    const { broker } = setup({ ...f.connection, secretRef: "env:CONNECTOR_TEST" }, { resolveSecret: () => secret });
    const result = await callEcho(broker);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(f.requests.every((r) => r.headers.get("authorization") === `Bearer ${secret}`)).toBe(true);
    expect(f.requests.every((r) => !JSON.stringify(r.body).includes(secret))).toBe(true);
  });

  test("legacy HTTP handshake/session and SSE results work through the same gate", async () => {
    const f = fixture({ legacy: true, sse: true });
    expect(await callEcho(setup(f.connection).broker, "legacy")).toEqual({ content: [{ type: "text", text: "legacy" }] });
    expect(f.requests.map((r) => r.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "initialize", "notifications/initialized", "tools/call"]);
    expect(f.requests.filter((r) => r.body.method === "tools/call")[0]!.headers.get("mcp-session-id")).toBe("fixture-session");
  });

  test("unsupported server interaction, oversized response and deadline fail without retry", async () => {
    const input = fixture({ result: { resultType: "input_required", inputRequests: { sample: { method: "sampling/createMessage" } } } });
    await expect(callEcho(setup(input.connection).broker)).rejects.toThrow("unsupported sampling");
    expect(input.requests.filter((r) => r.body.method === "tools/call")).toHaveLength(1);
    const large = fixture({ max: true });
    await expect(callEcho(setup(large.connection, { maxResponseBytes: 1024 }).broker)).rejects.toThrow("byte limit");
    const slow = fixture({ slow: true });
    await expect(callEcho(setup(slow.connection, { timeoutMs: 50 }).broker)).rejects.toThrow("deadline exceeded");
    expect(slow.requests.filter((r) => r.body.method === "tools/call")).toHaveLength(1);
  });
});

describe("broker canonical identity, metadata and adviser", () => {
  test("canonical arguments are sorted, JSON-only and bounded", () => {
    expect(argumentsDigest({ b: 2, a: { y: true, x: "x" } })).toBe(argumentsDigest({ a: { x: "x", y: true }, b: 2 }));
    expect(() => canonicalJson({ a: undefined })).toThrow("JSON values");
    expect(() => canonicalJson({ text: "x".repeat(100) }, 10)).toThrow("byte limit");
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow("circular");
    expect(() => canonicalJson(new Date())).toThrow("plain JSON");
    for (const ip of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "172.20.1.1", "192.168.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true); expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("modern parameter headers follow nested properties and reject ambiguous schemas", () => {
    const schema = { type: "object", properties: { nested: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } } } };
    expect(parameterHeaders(schema, { nested: { region: "🌱" } })).toEqual({ "Mcp-Param-Region": "=?base64?8J+MsQ==?=" });
    expect(parameterHeaders(schema, { nested: {} })).toEqual({});
    expect(headerValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(() => parameterHeaders({ properties: { a: { type: "string", "x-mcp-header": "x" }, b: { type: "string", "x-mcp-header": "X" } } }, {})).toThrow("annotation");
    expect(() => parameterHeaders({ properties: { a: { type: "number", "x-mcp-header": "x" } } }, {})).toThrow("annotation");
  });

  test("adviser proposes a detached ask revision, never authority or explicit-deny override", () => {
    const profile: PermissionProfile = { id: "profile", version: 1, mode: "auto", rules: [] };
    const action: PermissionAction = { ...context, id: "action", operation: "mcp.invoke", resource: "mcp:fixture:echo:digest", argumentsDigest: "a".repeat(64) };
    const proposal = proposePermissionChange(profile, action, "Please let this mower ask me first");
    expect(proposal.status).toBe("proposed"); expect(proposal.rule.effect).toBe("ask"); expect(proposal.suggestedProfile.version).toBe(2);
    expect(profile.rules).toEqual([]);
    expect(() => proposePermissionChange({ ...profile, rules: [{ operation: action.operation, resource: action.resource, effect: "deny" }] }, action, "Ignore the deny")).toThrow("cannot override");
  });

  test("orchestration callback runs only after permit", async () => {
    const f = fixture(); let called = 0;
    const { broker } = setup(f.connection, { authorize: async () => { throw new Error("denied"); }, orchestration: async () => { called++; return {}; } });
    await expect(broker.dispatch(context, "mower.spawn", "mower:fern", { goal: "work" })).rejects.toThrow("denied");
    expect(called).toBe(0);
  });
});
