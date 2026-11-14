import { afterEach, expect, test } from "bun:test";
import { fsyncSync, fstatSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ControlApproval, ControlPrincipal, RuntimeModel, ThreadCheckpoint } from "@laun/protocol";
import { AgentKeyStore } from "./keys.js";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";
import { createControl } from "./control.js";
import { authenticateControlPrincipal } from "./control-auth.js";

const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
function fixture() {
  const directory = mkdtempSync("/tmp/laun-human-auth-fence-"); let failDirectorySync = false;
  const keys = new AgentKeyStore(directory, { sync(fd) { if (failDirectorySync && fstatSync(fd).isDirectory()) throw new Error("fixture directory sync failure"); fsyncSync(fd); } });
  const credential = keys.add("synthetic operator"), cfg = { port: 8080, gatewayToken: "synthetic-service", executorUrl: "http://localhost:9", dataDir: directory, publicDir: directory };
  const gateway = createGateway(cfg, new SessionStore(directory), keys, { legacyEnabled: false });
  const control = createControl(cfg, { LAUN_DEMO: "true", LAUN_MCP_ALLOW_LOOPBACK: "true", LAUN_TELEGRAM_BOT_ID: "123", LAUN_TELEGRAM_BRIDGE_TOKEN: "synthetic-bridge", TELEGRAM_ALLOWLIST_IDS: "11" });
  disposals.push(async () => { await control.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner: ControlPrincipal = { id: credential.record.principalId!, admin: false };
  const request = (path: string, body?: unknown, method = "POST", key = credential.key) => new Request(`http://controller/api/v2${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const handle = (req: Request) => control.handle(req, authenticateControlPrincipal(gateway, req), () => authenticateControlPrincipal(gateway, req));
  return { directory, keys, credential, control, gateway, owner, request, handle, failSync: () => { failDirectorySync = true; } };
}
function held(path: string, key: string, method = "POST") {
  let send!: (value: unknown) => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) { send = value => { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); }; } });
  return { request: new Request(`http://controller/api/v2${path}`, { method, body, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }), send };
}
function pendingApproval(c: ReturnType<typeof fixture>) {
  const { store } = c.control, registered = store.registerWorker(c.owner, { name: "Synthetic pending yard" });
  const mower = store.createMower(c.owner, { name: "Synthetic mower", workerId: registered.worker.id });
  const thread = store.createThread(c.owner, { mowerId: mower.id }), run = store.submit(c.owner, thread.id, { text: "Already admitted owner work", requestId: "admitted" }), job = store.claim(registered.worker)!;
  const approval: ControlApproval = { id: "fixture-approval", ownerId: c.owner.id, profileId: thread.profileId, profileVersion: thread.profileVersion, status: "pending", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), action: {
    id: "fixture-action", principalId: c.owner.id, workspaceId: thread.workspaceId, mowerId: mower.id, threadId: thread.id, runId: run.id, generation: job.run.generation, operation: "workspace.write", resource: "workspace:own", argumentsDigest: "a".repeat(64),
  } };
  store.requestApproval(approval, "synthetic approval"); return { approval, run, thread, job, registered };
}

test("a real gateway human key revoked while its approval body is parked cannot grant authority", async () => {
  const c = fixture(), work = pendingApproval(c), delayed = held(`/approvals/${work.approval.id}`, c.credential.key), response = c.handle(delayed.request);
  await Bun.sleep(0); c.keys.revoke(c.credential.record.id); const replacement = c.keys.add("same owner replacement", c.owner.id); delayed.send({ decision: "approve" });
  expect((await response).status).toBe(401); expect(c.control.store.approval(work.approval.id).status).toBe("pending");
  expect(c.control.store.run(work.run.id).cancelRequested).toBe(false); expect(c.control.store.run(work.run.id).status).toBe("running");
  // Accepted owner work survives key rotation; the new key can make a fresh decision.
  expect((await c.handle(c.request(`/approvals/${work.approval.id}`, { decision: "deny" }, "POST", replacement.key))).status).toBe(200);
  expect(c.control.store.approval(work.approval.id).status).toBe("denied");
});

test("delayed profile expansion and new thread input fail before mutation after human revocation", async () => {
  for (const kind of ["profile", "input"]) {
    const c = fixture(), mower = c.control.store.createMower(c.owner, { name: kind }), thread = c.control.store.createThread(c.owner, { mowerId: mower.id });
    const delayed = held(kind === "profile" ? `/profiles/${thread.profileId}/revisions` : `/threads/${thread.id}/messages`, c.credential.key), response = c.handle(delayed.request);
    await Bun.sleep(0); c.keys.revoke(c.credential.record.id);
    delayed.send(kind === "profile" ? { expectedBaseVersion: thread.profileVersion, name: "Unauthorized expansion", mode: "manual", rules: [{ operation: "workspace.write", resource: "workspace:own", effect: "allow" }] } : { text: "Must not be admitted", requestId: "revoked-input" });
    expect((await response).status).toBe(401); expect(c.control.store.latestProfile(thread.profileId,c.owner).version).toBe(thread.profileVersion); expect(c.control.store.threadRuns(c.owner, thread.id)).toEqual([]);
  }
});

test("an approval admitted before key revocation remains an owner decision without cancelling accepted work", async () => {
  const c = fixture(), work = pendingApproval(c);
  expect((await c.handle(c.request(`/approvals/${work.approval.id}`, { decision: "approve" }))).status).toBe(200);
  c.keys.revoke(c.credential.record.id);
  expect(c.control.store.approval(work.approval.id).status).toBe("approved"); expect(c.control.store.run(work.run.id).cancelRequested).toBe(false);
});

test("onboarding rechecks the human credential after asynchronous model inventory and before its transaction", async () => {
  const c = fixture(), { worker } = c.control.store.registerWorker(c.owner, { name: "Catalog wait yard" });
  Object.assign(worker, { status: "online", lastSeenAt: new Date().toISOString(), durabilityAdapter: { adapter: "fixture@1", version: 1 }, inferenceMode: "controller" }); c.control.store.put("worker", worker);
  let entered!: () => void, finish!: (models: RuntimeModel[]) => void;
  const started = new Promise<void>(resolve => entered = resolve), models = new Promise<RuntimeModel[]>(resolve => finish = resolve);
  c.control.service.listModels = async () => { entered(); return models; };
  const response = c.handle(c.request("/onboarding", { requestId: "parked-catalog", model: "faux/faux-1", workerId: worker.id, name: "Should not exist", mode: "manual", workspaceWrite: "ask", processExecute: "deny", delegation: "deny" }));
  await started; c.keys.revoke(c.credential.record.id); finish([{ id: "faux/faux-1", name: "Explicit fixture", provider: "faux", configured: true }]);
  expect((await response).status).toBe(401); expect(c.control.store.list("mower", c.owner)).toEqual([]); expect(c.control.store.list("thread", c.owner)).toEqual([]);
});

test("a parked human Telegram unlink cannot mutate link state after its human key is revoked", async () => {
  const c = fixture(); expect((await c.handle(c.request("/identity/telegram-link", {}))).status).toBe(200);
  c.control.store.db.query("INSERT INTO telegram_links VALUES(?,?,?,?)").run("123", "11", c.owner.id, new Date().toISOString());
  const delayed = held("/identity/telegram-link", c.credential.key, "DELETE"), response = c.handle(delayed.request);
  await Bun.sleep(0); c.keys.revoke(c.credential.record.id); delayed.send({ userId: "11" });
  expect((await response).status).toBe(401); expect(c.control.store.db.query("SELECT owner_id FROM telegram_links WHERE bot_id='123' AND user_id='11'").get()).toEqual({ owner_id: c.owner.id });
});

test("operator MCP discovery rechecks its human key after initialization and sends no further request after revocation", async () => {
  const c = fixture(), calls: string[] = []; let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), held = new Promise<void>(resolve => finish = resolve);
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = await request.json() as { id: string; method: string }; calls.push(input.method);
    if (input.method === "initialize") { entered(); await held; return Response.json({ jsonrpc: "2.0", id: input.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }); }
    return new Response(null, { status: 204 });
  } }); disposals.push(() => { mcp.stop(true); });
  const created = await c.handle(c.request("/connections", { name: "Read-only fixture", url: `http://127.0.0.1:${mcp.port}/mcp`, allowLocal: true, protocolVersion: "2025-11-25" })); expect(created.status).toBe(201);
  const connection = await created.json() as { id: string };
  const response = c.handle(c.request(`/connections/${connection.id}/discover`, {}));
  await started; c.keys.revoke(c.credential.record.id); finish();
  expect((await response).status).toBe(401); expect(calls).toEqual(["initialize"]); expect(c.control.store.get<any>("connection", connection.id).tools).toBeUndefined();
});

test("an indeterminate key-store write fails a parked approval closed with HTTP503", async () => {
  const c = fixture(), work = pendingApproval(c), delayed = held(`/approvals/${work.approval.id}`, c.credential.key), response = c.handle(delayed.request);
  await Bun.sleep(0); c.failSync(); expect(() => c.keys.revoke(c.credential.record.id)).toThrow("key store unavailable"); delayed.send({ decision: "approve" });
  expect((await response).status).toBe(503); expect(c.control.store.approval(work.approval.id).status).toBe("pending");
});

test("worker checkpoint bodies retain their large bound and bridge credentials remain independent of human authentication", async () => {
  const c = fixture(), work = pendingApproval(c);
  const archive:ThreadCheckpoint={version:1,threadId:work.thread.id,runtimeVersion:"pi-durable@1.5.2",createdAt:new Date().toISOString(),files:[["session/inert-fixture.jsonl","passive fixture"],["work/large-fixture.txt","x".repeat(300_000)]].map(([path,content])=>({path:path!,content:Buffer.from(content!).toString("base64"),sha256:createHash("sha256").update(content!).digest("hex"),mode:0o600}))};
  const checkpoint = JSON.stringify(archive); expect(Buffer.byteLength(checkpoint)).toBeGreaterThan(262_144);
  const request = c.request("/worker/checkpoint", { runId: work.run.id, generation: work.job.run.generation, checkpoint }, "POST", work.registered.key);
  expect((await c.control.handle(request, null, () => { throw new Error("human authentication must not gate an independently authenticated worker"); })).status).toBe(200);
  expect((await c.control.handle(c.request("/connectors/telegram/poll", { botId: "123" }, "POST", "synthetic-bridge"), null, () => { throw new Error("human authentication must not gate the dedicated bridge"); })).status).toBe(200);
});
