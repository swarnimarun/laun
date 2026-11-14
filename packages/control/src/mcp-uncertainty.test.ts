import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiRuntime } from "@laun/runtime";
import { createToolBroker, toolDigest, toolResource } from "@laun/broker";
import type { BrokerConnection, CapabilityRule, WorkerRecord } from "@laun/protocol";
import { ControlStore } from "./store.js";
import { ControlService } from "./service.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const owner = { id: "mcp-unknown-owner", admin: false };
async function until(predicate: () => boolean) { const deadline = Date.now() + 10_000; while (!predicate()) { if (Date.now() > deadline) throw new Error("MCP uncertainty condition timed out"); await Bun.sleep(5); } }

for (const mode of ["drop", "tool-error", "metadata-failure"] as const) test(`local real Pi stops before a second model or tool after MCP ${mode}`, async () => {
  let effects = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: string };
    effects++; if (mode !== "tool-error") { response.destroy(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "partial mutation PRIVATE_CONNECTOR_DIAGNOSTIC" }], isError: true } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const dir = mkdtempSync(join(tmpdir(), "laun-mcp-unknown-")), store = new ControlStore(join(dir, "control.sqlite"));
  const models = createModels(), provider = fauxProvider(); models.setProvider(provider.provider);
  const runtime = createPiRuntime({ trustedLocal: true, models, maxTurns: 4 }), service = new ControlService({ store, runtime, dataDir: dir, mode: "trusted-local", minFreeDiskBytes: 0 });
  cleanup.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const connection: BrokerConnection = { id: "effect", name: "Effect", ownerId: owner.id, workspaceId: "default", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, allowLocal: true };
  const definition = { name: "write", inputSchema: { type: "object" } }, schemaDigest = toolDigest(connection, definition), resource = toolResource(connection.id, definition.name, schemaDigest);
  connection.tools = [{ name: definition.name, inputSchema: definition.inputSchema, definition, schemaDigest, resource }]; store.saveConnection(connection);
  const rules: CapabilityRule[] = [{ operation: "mcp.invoke", resource, effect: "allow" }, { operation: "network.connect", resource: new URL(connection.url).origin, effect: "allow" }];
  const profile = store.createProfile(owner, { name: "Exact MCP fixture", mode: "manual", rules }), mower = store.createMower(owner, { name: "Fern", model: "faux/faux-1", profileId: profile.id, profileVersion: profile.version }), thread = store.createThread(owner, { mowerId: mower.id });
  service.broker = createToolBroker({ allowLoopback: true, loadConnection: id => store.get<BrokerConnection>("connection", id), authorize: (context, operation, resource, args, signal) => service.authorize(context, { operation, resource, arguments: args, signal }), assertActive: context => { store.fence(context.runId, "local", context.generation!); } });
  const args = { connectionId: connection.id, tool: definition.name, schemaDigest, arguments: {} };
  let failureStatus: number | undefined;
  if(mode==="metadata-failure"){
    store.db.exec("CREATE TRIGGER reject_unknown_event BEFORE INSERT ON events WHEN NEW.kind='system' AND json_extract(NEW.payload,'$.text') LIKE '%Connector tool outcome is unknown%' BEGIN SELECT RAISE(ABORT,'PRIVATE_SQLITE_FAILURE'); END");
    const invoke=service.invoke.bind(service);service.invoke=async(...args)=>{try{return await invoke(...args);}catch(error){failureStatus=(error as {status?:number}).status;throw error;}};
  }
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp_call", args, { id: "first-effect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("mcp_call", args, { id: "must-not-retry" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("MUST_NOT_COMPLETE"),
  ]);
  const run = store.submit(owner, thread.id, { text: "Perform the external operation", requestId: "one" }), later = store.submit(owner, thread.id, { text: "Remain queued", requestId: "two" });
  await service.tick();
  if(mode==="metadata-failure"){
    await until(()=>failureStatus!==undefined);expect(failureStatus).toBe(503);
    // The event failure rolls the row update back. The process fence must
    // still reject finish, inference and another effect after storage recovers.
    expect(store.run(run.id).status).toBe("running");expect(()=>store.fence(run.id,"local",store.run(run.id).generation)).toThrow("could not be persisted");
    store.db.exec("DROP TRIGGER reject_unknown_event");
    await expect(service.invoke(service.context(store.run(run.id)),"mcp_call",args)).rejects.toThrow("could not be persisted");
    await expect(service.authorize(service.context(store.run(run.id)),{operation:"mcp.invoke",resource,arguments:{}})).rejects.toThrow("could not be persisted");
  }else await until(() => store.run(run.id).status === "interrupted");
  await service.close();
  expect(effects).toBe(1); expect(provider.state.callCount).toBe(1); expect(store.run(run.id).cancelRequested).toBe(true);
  if(mode!=="metadata-failure")expect(store.run(run.id).leaseUntil).toBeUndefined();
  expect(store.run(later.id).status).toBe("queued");
  expect(store.db.query("SELECT COUNT(*) n FROM inference_calls").get()).toEqual({ n: 1 });
  expect(JSON.stringify(store.events(owner, thread.id))).not.toContain("PRIVATE_CONNECTOR_DIAGNOSTIC");
  await expect(service.invoke(service.context(store.run(run.id)), "mcp_call", args)).rejects.toThrow("run inactive"); expect(effects).toBe(1);
  expect(() => store.finish(run.id, "local", store.run(run.id).generation, "done", "false success")).toThrow();
  const context = service.context(store.run(run.id)), oldGeneration = context.generation!;
  // The interrupted generation remains unreplayable through a new controller.
  const worker = store.get<WorkerRecord>("worker", "local"); expect(store.claim(worker)).toBeNull(); expect(store.run(run.id).generation).toBe(oldGeneration);
});

test("a stale unknown generation cannot replace or clear the current generation's fence", () => {
  const store=new ControlStore(":memory:");cleanup.push(()=>store.close());
  const mower=store.createMower(owner,{name:"Generation fixture",model:"fixture/model"}),thread=store.createThread(owner,{mowerId:mower.id});
  const worker:WorkerRecord={id:"local",ownerId:"service",name:"Local fixture",local:true,status:"online",labels:[],capacity:1,createdAt:new Date().toISOString()};store.put("worker",worker);
  const run=store.submit(owner,thread.id,{text:"One explicit intent",requestId:"generation"}),job=store.claim(worker)!;
  store.markRunUncertain(run.id,job.run.generation);expect(()=>store.fence(run.id,worker.id,job.run.generation)).toThrow("could not be persisted");
  // A new epoch requires explicit reconciliation; a fence from its old epoch
  // must neither stop it nor clear an unknown outcome in the newer epoch.
  const next=job.run.generation+1;store.db.query("UPDATE runs SET generation=? WHERE id=?").run(next,run.id);
  expect(store.fence(run.id,worker.id,next).generation).toBe(next);
  store.markRunUncertain(run.id,next);store.markRunUncertain(run.id,job.run.generation);
  expect(()=>store.fence(run.id,worker.id,next)).toThrow("could not be persisted");expect(()=>store.fence(run.id,worker.id,job.run.generation)).toThrow();
});
