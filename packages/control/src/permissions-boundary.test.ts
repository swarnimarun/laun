import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolBroker, toolDigest, toolResource } from "@laun/broker";
import type { BrokerConnection, CapabilityRule, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { rebaseThreadProfile } from "./lifecycle.js";
import { ControlService } from "./service.js";
import { ControlStore } from "./store.js";

const p = { id: `user_${"a".repeat(32)}`, admin: false };
const dirs: string[] = [], services: ControlService[] = [], stores: ControlStore[] = [], servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(true); for (const service of services.splice(0)) await service.close(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("delegation, MCP and profile revisions cannot turn denied workspace/network access into effects", async () => {
  let networkRequests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { networkRequests++; return Response.json({ unexpected: true }); } }); servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), "laun-permission-boundary-")); dirs.push(dir); const store = new ControlStore(join(dir, "control.sqlite")); stores.push(store);
  const connection: BrokerConnection = { id: "local-tool", ownerId: p.id, workspaceId: "default", name: "MCP command fixture", transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, allowLocal: true, enabled: true };
  const definition = { name: "command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }, digest = toolDigest(connection, definition), resource = toolResource(connection.id, definition.name, digest);
  connection.tools = [{ name: definition.name, inputSchema: definition.inputSchema, definition, schemaDigest: digest, resource }]; store.saveConnection(connection);
  const rules: CapabilityRule[] = [
    { operation: "workspace.read", resource: "workspace:own", effect: "allow" }, { operation: "workspace.write", resource: "workspace:own", effect: "deny" },
    { operation: "process.execute", resource: "workspace:own", effect: "allow" }, { operation: "mower.spawn", resource: "mowers:own", effect: "allow" },
    { operation: "mcp.invoke", resource, effect: "allow" }, { operation: "network.connect", resource: new URL(connection.url).origin, effect: "deny" },
  ];
  const profile = store.createProfile(p, { name: "Denied external effects", mode: "manual", rules });
  const mower = store.createMower(p, { name: "Director", role: "director", profileId: profile.id, profileVersion: 1 }); const thread = store.createThread(p, { mowerId: mower.id, title: "Root" });
  const worker: WorkerRecord = { id: "local", ownerId: "service", name: "Fixture", local: true, status: "online", labels: [], capacity: 2, createdAt: new Date().toISOString() }; store.put("worker", worker);
  const run = store.submit(p, thread.id, { text: "delegate", requestId: "root" }); store.claim(worker);
  const service = new ControlService({ store, dataDir: dir, mode: "unconfigured" }); services.push(service);
  let secretReads = 0;
  service.broker = createToolBroker({ allowLoopback: true, loadConnection: () => connection, saveConnection() {}, resolveSecret() { secretReads++; return "must-not-be-read"; }, authorize: (context, operation, scope, args) => service.authorize(context, { operation, resource: scope, arguments: args }) });
  const spawned = await service.invoke(service.context(store.run(run.id)), "mower_spawn", { name: "Child", goal: "try another tool", requestId: "child" }) as { thread: ThreadRecord; run: { id: string } };
  expect(spawned.thread.profileId).toBe(profile.id); const childJob = store.claim(worker)!; expect(childJob.run.id).toBe(spawned.run.id);
  const context = service.context(store.run(childJob.run.id));
  await expect(service.authorize(context, { operation: "process.execute", resource: "workspace:own", arguments: { command: "bash -c 'echo bypass > file; curl https://example.com'" } })).rejects.toThrow("explicit_deny");
  await expect(service.invoke(context, "mcp_call", { connectionId: connection.id, tool: definition.name, schemaDigest: digest, arguments: { command: "write via MCP" } })).rejects.toThrow("explicit_deny");
  expect(networkRequests).toBe(0); expect(secretReads).toBe(0); expect(store.approvals(p)).toHaveLength(0);
  const broader = store.createProfile(p, { mode: "manual", rules: rules.map(rule => rule.operation === "workspace.write" || rule.operation === "network.connect" ? { ...rule, effect: "allow" } : rule) }, profile);
  expect(() => rebaseThreadProfile(store, p, spawned.thread.id, { profileId: broader.id, profileVersion: broader.version, expectedProfileId: profile.id, expectedProfileVersion: 1, confirmedStopped: true })).toThrow("family");
  const broadMower = store.createMower(p, { name: "Broader existing mower", profileId: broader.id, profileVersion: broader.version });
  await expect(service.invoke(context, "mower_spawn", { mowerId: broadMower.id, goal: "try broader child", requestId: "broader-child" })).rejects.toThrow("exceeds parent authority");
  expect(store.list<ThreadRecord>("thread", p).some(value => value.mowerId === broadMower.id)).toBe(false);
  await expect(service.invoke(context, "profile_update", { profileId: broader.id, profileVersion: 2 })).rejects.toThrow("unknown broker tool");
  expect(store.get<ThreadRecord>("thread", spawned.thread.id).profileVersion).toBe(1); expect(networkRequests).toBe(0);
});
