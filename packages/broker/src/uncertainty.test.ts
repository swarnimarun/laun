import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { BrokerConnection, BrokerContext } from "@laun/protocol";
import { BrokerOutcomeUnknownError, createToolBroker, toolDigest, toolResource } from "./index.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const context: BrokerContext = { principalId: "owner", workspaceId: "workspace", mowerId: "mower", threadId: "thread", runId: "run" };

for (const mode of ["drop", "http", "malformed", "jsonrpc", "tool", "invalid"] as const) {
  test(`a committed connector effect followed by ${mode} is unknown and never transport-retried`, async () => {
    let effects = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; method: string };
      expect(body.method).toBe("tools/call"); effects++;
      if (mode === "drop") { response.destroy(); return; }
      response.setHeader("content-type", "application/json");
      if (mode === "http") { response.writeHead(503); response.end("PRIVATE_CONNECTOR_DIAGNOSTIC"); return; }
      if (mode === "malformed") { response.end("PRIVATE_CONNECTOR_DIAGNOSTIC"); return; }
      if (mode === "jsonrpc") { response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: "PRIVATE_CONNECTOR_DIAGNOSTIC" } })); return; }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: mode === "tool" ? { content: [], isError: true } : { invalid: true } }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
    const connection: BrokerConnection = { id: "fixture", name: "Fixture", ownerId: context.principalId, workspaceId: context.workspaceId, transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, allowLocal: true };
    const definition = { name: "write", inputSchema: { type: "object" } }, schemaDigest = toolDigest(connection, definition);
    connection.tools = [{ name: definition.name, inputSchema: definition.inputSchema, definition, schemaDigest, resource: toolResource(connection.id, definition.name, schemaDigest) }];
    const broker = createToolBroker({ allowLoopback: true, loadConnection: () => connection, authorize: async () => {} });
    let failure: unknown; try { await broker.invoke(context, connection.id, definition.name, {}, schemaDigest); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BrokerOutcomeUnknownError);
    expect((failure as Error).message).not.toContain("PRIVATE_CONNECTOR_DIAGNOSTIC"); expect(effects).toBe(1);
  });
}
