import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore, ControlService, handleControlRequest } from "@laun/control";
import type { AgentRuntime, BrokerConnection, CapabilityRule, RuntimeInferenceService } from "@laun/protocol";
import { createToolBroker, toolDigest, toolResource } from "../../../packages/broker/src/index.js";
import { OutboundWorker } from "./worker.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

test("an outbound worker fences a connector partial mutation before another model/tool or false completion", async () => {
  let effects = 0, modelCalls = 0, modelDenied = false, toolDenied = false;
  const connector = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the one committed request. */ }
    effects++; response.destroy();
  });
  await new Promise<void>(resolve => connector.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { connector.closeAllConnections(); await new Promise<void>(resolve => connector.close(() => resolve())); });
  const address = connector.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const dir = mkdtempSync(join(tmpdir(), "laun-yard-mcp-unknown-")), store = new ControlStore(join(dir, "control.sqlite")), owner = { id: "remote-owner", admin: false };
  const inference: RuntimeInferenceService = { async describe() { return { adapter: "fixture", version: 1, payload: {} }; }, async *stream() { modelCalls++; yield { adapter: "fixture", version: 1, payload: { answer: "choose a tool" } }; } };
  const service = new ControlService({ store, inference, dataDir: join(dir, "controller"), mode: "unconfigured", minFreeDiskBytes: 0 });
  cleanup.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const connection: BrokerConnection = { id: "remote-effect", name: "Effect", ownerId: owner.id, workspaceId: "default", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, allowLocal: true };
  const definition = { name: "write", inputSchema: { type: "object" } }, schemaDigest = toolDigest(connection, definition), resource = toolResource(connection.id, definition.name, schemaDigest);
  connection.tools = [{ name: definition.name, inputSchema: definition.inputSchema, definition, schemaDigest, resource }]; store.saveConnection(connection);
  const rules: CapabilityRule[] = [{ operation: "mcp.invoke", resource, effect: "allow" }, { operation: "network.connect", resource: new URL(connection.url).origin, effect: "allow" }];
  const profile = store.createProfile(owner, { name: "Remote MCP", mode: "manual", rules }), registration = store.registerWorker(owner, { name: "Remote yard" });
  const mower = store.createMower(owner, { name: "Remote Fern", model: "fixture/model", profileId: profile.id, profileVersion: profile.version, workerId: registration.worker.id }), thread = store.createThread(owner, { mowerId: mower.id });
  service.broker = createToolBroker({ allowLoopback: true, loadConnection: id => store.get<BrokerConnection>("connection", id), authorize: (context, operation, resource, args, signal) => service.authorize(context, { operation, resource, arguments: args, signal }), assertActive: context => { store.fence(context.runId, registration.worker.id, context.generation!); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handleControlRequest(service, request, owner) }); cleanup.push(() => server.stop(true));
  const args = { connectionId: connection.id, tool: definition.name, schemaDigest, arguments: {} };
  const runtime: AgentRuntime = {
    durabilityAdapter: { adapter: "fixture@1", version: 1 },
    async run(_input, callbacks) {
      const envelope = { adapter: "fixture", version: 1 as const, payload: {} };
      for await (const _frame of callbacks.inference!.stream({ requestId: "a".repeat(64), envelope })) { /* One provider charge. */ }
      try { await callbacks.invokeTool!("mcp_call", args); } catch { /* A hostile/retrying model must remain fenced. */ }
      try { for await (const _frame of callbacks.inference!.stream({ requestId: "b".repeat(64), envelope })) {} } catch { modelDenied = true; }
      try { await callbacks.invokeTool!("mcp_call", args); } catch { toolDenied = true; }
      return { status: "done", summary: "MUST_NOT_COMPLETE" };
    }, cancel() {}, close() {},
  };
  const worker = new OutboundWorker({ controllerUrl: `http://127.0.0.1:${server.port}`, workerKey: registration.key, dataDir: join(dir, "yard"), runtime, inferenceMode: "controller", heartbeatMs: 100 }); cleanup.push(() => worker.close());
  const run = store.submit(owner, thread.id, { text: "Perform the external operation", requestId: "one" }), later = store.submit(owner, thread.id, { text: "Remain queued", requestId: "two" });
  await worker.tick(); await worker.whenIdle();
  expect(effects).toBe(1); expect(modelCalls).toBe(1); expect(modelDenied).toBe(true); expect(toolDenied).toBe(true);
  expect(store.run(run.id).status).toBe("interrupted"); expect(store.run(run.id).cancelRequested).toBe(true); expect(store.run(run.id).leaseUntil).toBeUndefined(); expect(store.run(later.id).status).toBe("queued");
  await worker.tick(); await worker.whenIdle(); expect(effects).toBe(1); expect(modelCalls).toBe(1);
}, 20_000);
