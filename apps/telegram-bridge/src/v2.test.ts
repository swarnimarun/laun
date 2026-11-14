import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService, ControlStore, handleTelegramConnectorRequest, type TelegramConnectorOptions } from "@laun/control";
import type { TelegramDelivery, TelegramInboundUpdate, ThreadRecord } from "@laun/protocol";
import type { BridgeConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { V2GatewayClient } from "./v2client.js";
import { V2Delivery, type TelegramSender } from "./v2delivery.js";
import { TelegramInbox } from "./v2inbox.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { id: "key_owner", admin: false }, other = { id: "key_other", admin: false };
function directory() { const dir = mkdtempSync(join(tmpdir(), "laun-telegram-v2-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
let update = 0;
function incoming(text: string, extra: Partial<TelegramInboundUpdate> = {}): TelegramInboundUpdate { return { botId: "123", userId: "1", chatId: "1", updateId: ++update, text, ...extra }; }
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); } }
function fixture(overrides: Partial<TelegramConnectorOptions> = {}) {
  const dir = directory(); const path = join(dir, "control.sqlite");
  const open = () => { const store = new ControlStore(path); const service = new ControlService({ store, dataDir: join(dir, "control"), mode: "unconfigured" }); return { store, service }; };
  let current = open();
  const options: TelegramConnectorOptions = { serviceToken: "bridge-secret", botId: "123", allowlist: ["1", "2"], allowChats: ["-100"], defaultModel: "faux/faux-1", ...overrides };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const auth = req.headers.get("authorization");
    return await handleTelegramConnectorRequest(current.service, req, options, auth === "Bearer human" ? owner : auth === "Bearer other-human" ? other : null) ?? new Response("not found", { status: 404 });
  } });
  cleanups.push(async () => { server.stop(true); await current.service.close(); current.store.close(); });
  const base = `http://127.0.0.1:${server.port}`;
  const client = new V2GatewayClient(base, "bridge-secret", "123");
  const human = async (path: string, body?: unknown, auth = "human", method = "POST") => {
    const response = await fetch(base + "/api/v2" + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${auth}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { response, data: await response.json() as Record<string, unknown> };
  };
  const link = async (userId = "1", auth = "human") => {
    const { data } = await human("/identity/telegram-link", {}, auth);
    const code = String(data.code); await client.ingest(incoming(`/link ${code}`, { userId, chatId: userId })); return code;
  };
  const drain = async () => {
    const all: TelegramDelivery[] = [];
    for (let n = 0; n < 20; n++) { const { deliveries } = await client.poll(); if (!deliveries.length) break; all.push(...deliveries); for (const delivery of deliveries) await client.ack(delivery, { status: "delivered", messageId: String(n + 1) }); }
    return all;
  };
  return { base, client, options, human, link, drain, get store() { return current.store; }, get service() { return current.service; },
    restart: async () => { await current.service.close(); current.store.close(); current = open(); } };
}
function bridgeConfig(base: string, dir = directory()): BridgeConfig {
  return { botToken: `123:${"x".repeat(40)}`, gatewayToken: "bridge-secret", gatewayUrl: base, allowlist: ["1", "2"], defaultModel: "faux/faux-1", pollMs: 500, controlV2: true, dataDir: dir, inboxKey: "stable-test-inbox-encryption-key-123456789" };
}

describe("Telegram identity, durable routing and callback authority", () => {
  test("requires one-time linking and keeps bot/chat/topic/user routes independent across restart", async () => {
    const c = fixture();
    await c.client.ingest(incoming("/new unlinked work"));
    expect(c.store.list("mower", owner)).toHaveLength(0);
    const code = await c.link(); await c.link("2", "other-human");
    expect(JSON.stringify(c.store.db.query("SELECT * FROM telegram_link_codes").all())).not.toContain(code);
    const a = incoming("/new Fern | topic ten", { chatId: "-100", topicId: "10" });
    await c.client.ingest(a); await c.client.ingest(a);
    await c.client.ingest(incoming("/new Clover | topic twenty", { chatId: "-100", topicId: "20" }));
    await c.client.ingest(incoming("/new Willow | other user", { userId: "2", chatId: "-100", topicId: "10" }));
    await c.client.ingest(incoming("follow ten", { chatId: "-100", topicId: "10" }));
    const threads = c.store.list<ThreadRecord>("thread", owner);
    expect(threads).toHaveLength(2); expect(c.store.list("thread", other)).toHaveLength(1);
    const ten = threads.find((t) => t.title === "topic ten")!;
    expect(c.store.runs(owner).filter((r) => r.threadId === ten.id).map((r) => r.prompt).sort()).toEqual(["follow ten", "topic ten"]);
    await expect(c.client.ingest({ ...a, text: "conflicting duplicate" })).rejects.toThrow("identity conflict");
    await c.restart();
    await c.client.ingest(incoming("after controller restart", { chatId: "-100", topicId: "20" }));
    expect(c.store.runs(owner).filter((r) => r.prompt === "after controller restart")[0]!.threadId).toBe(threads.find((t) => t.title === "topic twenty")!.id);
    expect(c.store.list("thread", owner)).toHaveLength(2);
  });

  test("service credential cannot bypass server bot/user/group allowlists", async () => {
    const c = fixture();
    await expect(c.client.ingest(incoming("/help", { userId: "999", chatId: "999" }))).rejects.toThrow("not allowed");
    await expect(c.client.ingest(incoming("/help", { chatId: "-200" }))).rejects.toThrow("not allowlisted");
    await expect(c.client.ingest(incoming("/help", { botId: "999" }))).rejects.toThrow("bot identity mismatch");
    await expect(new V2GatewayClient(c.base, "human", "123").ingest(incoming("/help"))).rejects.toThrow("unauthorized bridge");
    const mint = await c.human("/identity/telegram-link", {}, "unknown"); expect(mint.response.status).toBe(401);
  });

  test("used/expired link codes cannot rebind a Telegram user", async () => {
    const c = fixture(); const code = await c.link();
    await c.client.ingest(incoming(`/link ${code}`, { userId: "2", chatId: "2" }));
    const links = c.store.db.query("SELECT * FROM telegram_links").all(); expect(links).toHaveLength(1);
    const next = await c.human("/identity/telegram-link", {}, "other-human");
    c.store.db.query("UPDATE telegram_link_codes SET expires_at=? WHERE owner_id=?").run("2000-01-01T00:00:00Z", other.id);
    await c.client.ingest(incoming(`/link ${String(next.data.code)}`, { userId: "2", chatId: "2" }));
    expect(c.store.db.query("SELECT * FROM telegram_links").all()).toHaveLength(1);
  });

  test("private-chat topics retain independent routing and allow a private account link",async()=>{
    const c=fixture(),code=String((await c.human("/identity/telegram-link",{})).data.code);
    await c.client.ingest(incoming(`/link ${code}`,{topicId:"10"}));
    await c.client.ingest(incoming("/new Fern | private topic ten",{topicId:"10"}));await c.client.ingest(incoming("/new Clover | private topic twenty",{topicId:"20"}));
    await c.client.ingest(incoming("follow private ten",{topicId:"10"}));await c.client.ingest(incoming("follow private twenty",{topicId:"20"}));
    const threads=c.store.list<ThreadRecord>("thread",owner),ten=threads.find(t=>t.title==="private topic ten")!,twenty=threads.find(t=>t.title==="private topic twenty")!;expect(threads).toHaveLength(2);
    expect(c.store.runs(owner).find(r=>r.prompt==="follow private ten")!.threadId).toBe(ten.id);expect(c.store.runs(owner).find(r=>r.prompt==="follow private twenty")!.threadId).toBe(twenty.id);
    const replies=await c.drain();expect(replies.some(d=>d.topicId==="10")).toBe(true);expect(replies.some(d=>d.topicId==="20")).toBe(true);
    await expect(c.client.ingest(incoming("/help",{chatId:"2",topicId:"10"}))).rejects.toThrow("invalid private");
  });

  test("approval handles bind exact user/chat/topic before granting", async () => {
    const c = fixture(); await c.link(); await c.link("2", "other-human");
    await c.client.ingest(incoming("/new Echo | gated command"));
    const thread = c.store.list<ThreadRecord>("thread", owner)[0]!;
    const registered = c.store.registerWorker(owner, { name: "Approval fixture" });
    const job = c.store.claim(registered.worker)!;
    const pending = c.service.authorize(c.service.context(job.run), { operation: "process.execute", resource: "workspace:own", arguments: { command: "echo exact command" } });
    await until(() => c.store.approvals(owner).some((a) => a.status === "pending"));
    await c.client.ingest(incoming("/status"));
    const deliveries = await c.drain(); const prompt = deliveries.find((d) => d.buttons?.some((b) => b.callbackData.startsWith("laun:a:")))!;
    expect(prompt.text).toContain("echo exact command");
    const callback = prompt.buttons![0]!.callbackData; expect(callback.length).toBeLessThanOrEqual(64);
    await c.client.ingest({ botId: "123", userId: "2", chatId: "2", updateId: ++update, callbackData: callback });
    expect(c.store.approvals(owner)[0]!.status).toBe("pending");
    await c.client.ingest({ botId: "123", userId: "1", chatId: "-100", topicId: "99", updateId: ++update, callbackData: callback });
    expect(c.store.approvals(owner)[0]!.status).toBe("pending");
    await c.client.ingest({ botId: "123", userId: "1", chatId: "1", updateId: ++update, callbackData: callback });
    await pending;
    expect(c.store.approvals(owner)[0]!.status).toBe("consumed");
    expect(c.store.get<ThreadRecord>("thread", thread.id, owner).ownerId).toBe(owner.id);
  }, 10_000);

  test("expired permission handles cannot grant an otherwise pending action", async () => {
    const c = fixture(); await c.link(); await c.client.ingest(incoming("/new Gate | expire this request"));
    const registered = c.store.registerWorker(owner, { name: "Expiry fixture" }); const job = c.store.claim(registered.worker)!;
    const pending = c.service.authorize(c.service.context(job.run), { operation: "process.execute", resource: "workspace:own", arguments: { command: "echo do not run" } });
    const rejected = pending.catch((error) => error as Error);
    await until(() => c.store.approvals(owner).some((a) => a.status === "pending"));
    await c.client.ingest(incoming("/status"));
    const prompt = (await c.drain()).find((d) => d.buttons?.some((b) => b.callbackData.startsWith("laun:a:")))!;
    const callback = prompt.buttons![0]!.callbackData;
    c.store.db.query("UPDATE telegram_handles SET expires_at='2000-01-01T00:00:00Z'").run();
    await c.client.ingest({ botId: "123", userId: "1", chatId: "1", updateId: ++update, callbackData: callback });
    expect(c.store.approvals(owner)[0]!.status).toBe("pending");
    c.store.decide(owner, c.store.approvals(owner)[0]!.id, "deny");
    expect(await rejected).toBeInstanceOf(Error);
  }, 10_000);

  test("delegation is idempotent and child threads can be addressed directly", async () => {
    const c = fixture(); await c.link(); await c.client.ingest(incoming("/new coordinate the project"));
    const parent = c.store.list<ThreadRecord>("thread", owner)[0]!;
    const task = incoming("/delegate Clover | implement a bounded part");
    await c.client.ingest(task); await c.client.ingest(task);
    const children = c.store.list<ThreadRecord>("thread", owner).filter((t) => t.parentThreadId === parent.id);
    expect(children).toHaveLength(1); expect(c.store.list("task", owner)).toHaveLength(1);
    await c.client.ingest(incoming("still tell the director"));
    expect(c.store.runs(owner).find((r) => r.prompt === "still tell the director")!.threadId).toBe(parent.id);
    await c.client.ingest(incoming(`/thread ${children[0]!.id}`));
    await c.client.ingest(incoming("direct child feedback"));
    expect(c.store.runs(owner).find((r) => r.prompt === "direct child feedback")!.threadId).toBe(children[0]!.id);
  });

  test("outbox claims are durable, chunked, and an expired send requires explicit retry", async () => {
    const c = fixture(); await c.link(); await c.client.ingest(incoming("/new Fern | watch results")); await c.drain();
    const thread = c.store.list<ThreadRecord>("thread", owner)[0]!;
    c.store.event(thread.id, "agent", { event: { type: "text", sessionId: thread.id, delta: "🌱".repeat(4000) } });
    const first = (await c.client.poll()).deliveries;
    expect(first).toHaveLength(1); expect(first.every((d) => d.text.length <= 3500)).toBe(true);
    const again = (await c.client.poll()).deliveries; expect(again).toHaveLength(0);
    await c.restart();
    c.store.db.query("UPDATE telegram_deliveries SET lease_until=? WHERE id=?").run("2000-01-01T00:00:00Z", first[0]!.id);
    expect((await c.client.poll()).deliveries).toHaveLength(0);
    const { data } = await c.human("/identity/telegram-deliveries", undefined, "human", "GET");
    expect((data.deliveries as Array<{ status: string }>).some((d) => d.status === "uncertain")).toBe(true);
    await c.client.ingest(incoming(`/retry ${first[0]!.id}`));
    const retried = (await c.client.poll()).deliveries.find((d) => d.id === first[0]!.id)!;
    expect(retried).toBeDefined(); expect(retried.leaseId).not.toBe(first[0]!.leaseId);
    await expect(c.client.ack(first[0]!, { status: "delivered", messageId: "old" })).rejects.toThrow("stale Telegram delivery lease");
  });

  test("revoked pending routes cannot permanently starve later valid messages", async () => {
    const c = fixture();
    for (let n = 0; n < 64; n++) await c.client.ingest(incoming("/help", { userId: "2", chatId: "2" }));
    c.options.allowlist = ["1"];
    await c.link();
    const next = (await c.client.poll()).deliveries;
    expect(next.some((d) => d.chatId === "1" && d.text.includes("Linked"))).toBe(true);
    for(let n=0;n<64;n++)await c.client.poll();
    expect(c.store.db.query("SELECT COUNT(*) n FROM outbox WHERE owner_id='telegram_123_2' AND status='pending'").get()).toEqual({ n: 0 });
  }, 10_000);

  test("durable Unicode output beyond 24k is completely delivered in ordered chunks", async () => {
    const c = fixture(); await c.link(); await c.client.ingest(incoming("/new Fern | preserve the full answer")); await c.drain();
    const thread = c.store.list<ThreadRecord>("thread", owner)[0]!;
    const full = "🌱".repeat(16_000) + " complete tail";
    c.store.event(thread.id, "agent", { event: { type: "text", sessionId: thread.id, delta: full } });
    const messages = await c.drain();
    expect(messages.length).toBeGreaterThan(8);
    expect(messages.every((d) => d.text.length <= 3500 && !/[\uD800-\uDBFF]$/.test(d.text))).toBe(true);
    expect(messages.map((d) => d.text).join("")).toBe(`[Fern · preserve the full answer]\n${full}`);
  });

  test("edited and unsupported updates are durable notices without admitting agent work",async()=>{
    const c=fixture();await c.link();await c.drain();
    const edited:TelegramInboundUpdate={botId:"123",userId:"1",chatId:"1",updateId:++update,notice:"edited"};await c.client.ingest(edited);await c.client.ingest(edited);
    await c.client.ingest({...edited,updateId:++update,notice:"unsupported"});
    expect(c.store.runs(owner)).toHaveLength(0);expect(c.store.list("mower",owner)).toHaveLength(0);
    const replies=await c.drain();expect(replies).toHaveLength(2);expect(replies[0]!.text).toContain("immutable");expect(replies[1]!.text).toContain("not downloaded");
    await expect(c.client.ingest({...edited,text:"must not run"})).rejects.toThrow("exactly one");
  });

  test("pre-send verification rejects revoked identities and expired or replaced leases",async()=>{
    const c=fixture();await c.link();const delivery=(await c.client.poll()).deliveries[0]!;
    const verify=()=>c.human("/connectors/telegram/verify",{botId:"123",id:delivery.id,leaseId:delivery.leaseId},"bridge-secret");
    // This fixture's human helper can send the dedicated bridge token directly.
    expect((await verify()).data).toEqual({authorized:true});
    c.options.allowlist=[];expect((await verify()).response.status).toBe(403);c.options.allowlist=["1","2"];
    c.store.db.query("UPDATE telegram_deliveries SET lease_until='2000-01-01T00:00:00Z' WHERE id=?").run(delivery.id);expect((await verify()).response.status).toBe(409);
    c.store.db.query("UPDATE telegram_deliveries SET lease_until=? WHERE id=?").run(new Date(Date.now()+60_000).toISOString(),delivery.id);
    await c.human("/identity/telegram-link",{userId:"1"},"human","DELETE");expect((await verify()).response.status).toBe(409);
  });

  test("rate-limited content cannot be overtaken while reconciliation commands remain deliverable",async()=>{
    const c=fixture();await c.link();await c.client.ingest(incoming("/new Fern | ordered content"));await c.drain();
    const thread=c.store.list<ThreadRecord>("thread",owner)[0]!,full="content ".repeat(1200);c.store.event(thread.id,"agent",{event:{type:"text",sessionId:thread.id,delta:full}});
    const first=(await c.client.poll()).deliveries[0]!;await c.client.ack(first,{status:"retry",retryAfterMs:60_000});expect((await c.client.poll()).deliveries).toHaveLength(0);
    await c.client.ingest(incoming("/deliveries"));const control=(await c.client.poll()).deliveries;expect(control).toHaveLength(1);expect(control[0]!.text).toContain("No uncertain");await c.client.ack(control[0]!,{status:"delivered",messageId:"control"});expect((await c.client.poll()).deliveries).toHaveLength(0);
    c.store.db.query("UPDATE telegram_deliveries SET next_at='2000-01-01T00:00:00Z' WHERE id=?").run(first.id);const retry=(await c.client.poll()).deliveries[0]!;expect(retry.id).toBe(first.id);await c.client.ack(retry,{status:"delivered",messageId:"first"});
    const rest=await c.drain();expect([retry,...rest].map(d=>d.text).join("")).toBe(`[Fern · ordered content]\n${full}`);
  });

  test("Telegram status reads a thread's own history beyond the global recent-run window",async()=>{
    const c=fixture();await c.link();await c.client.ingest(incoming("/new Fern | old work"));const thread=c.store.list<ThreadRecord>("thread",owner)[0]!,worker=c.store.registerWorker(owner,{name:"History fixture"}).worker,job=c.store.claim(worker)!;
    c.store.finish(job.run.id,worker.id,job.run.generation,"done","old terminal result remains visible");
    const other=c.store.createThread(owner,{mowerId:thread.mowerId});const at=new Date(Date.now()+1000).toISOString();
    c.store.transaction(()=>{const insert=c.store.db.query("INSERT INTO runs(id,owner_id,thread_id,request_id,prompt,status,created_at,updated_at,model) VALUES(?,?,?,?,?,'done',?,?,?)");for(let n=0;n<1001;n++)insert.run(`recent-${n}`,owner.id,other.id,`recent-${n}`,"later history",at,at,"faux/faux-1");});
    await c.drain();await c.client.ingest(incoming(`/status ${thread.id}`));const replies=await c.drain();expect(replies.some(d=>d.text.includes("old terminal result remains visible"))).toBe(true);
  });
});

describe("Telegram bridge admission and actual outbox delivery", () => {
  test("a dedicated v2 bridge credential does not require an administrative gateway token", () => {
    expect(loadConfig({ LAUN_CONTROL_V2: "true", LAUN_TELEGRAM_BRIDGE_TOKEN: "bridge-only-token" }).gatewayToken).toBe("bridge-only-token");
    expect(() => loadConfig({ LAUN_CONTROL_V2: "false", LAUN_TELEGRAM_BRIDGE_TOKEN: "bridge-only-token" })).toThrow("GATEWAY_TOKEN");
  });

  test("encrypted local inbox survives bridge restart while controller is unavailable", async () => {
    const c = fixture(); const dir = directory(); const cfg = bridgeConfig(c.base, dir);
    const code = String((await c.human("/identity/telegram-link", {})).data.code);
    const blocked = new V2GatewayClient(c.base, "bridge-secret", "123", (async () => { throw new Error("offline fixture"); }) as unknown as typeof fetch);
    const sender: TelegramSender = { sendMessage: async () => ({ message_id: 1 }) };
    const first = new V2Delivery(cfg, sender, { client: blocked, minChatIntervalMs: 0 });
    first.accept(incoming(`/link ${code}`)); await first.pump().catch(() => {}); await first.stop();
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file)).includes(Buffer.from(code))).toBe(false);
    const second = new V2Delivery(cfg, sender, { minChatIntervalMs: 0 }); cleanups.push(() => second.stop());
    await second.pump();
    expect(c.store.db.query("SELECT owner_id FROM telegram_links WHERE bot_id='123' AND user_id='1'").get()).toEqual({ owner_id: owner.id });
    const inbox = new TelegramInbox(join(dir, "inbox.sqlite"), cfg.inboxKey!); expect(inbox.pending()).toEqual([]); inbox.close();
  });

  test("Telegram429 retries only after server delay; transport ambiguity never resends", async () => {
    const c = fixture(); let sends = 0;
    const sender: TelegramSender = { sendMessage: async () => { sends++; if (sends === 1) throw { error_code: 429, parameters: { retry_after: 1 } }; return { message_id: 99 }; } };
    const delivery = new V2Delivery(bridgeConfig(c.base), sender, { minChatIntervalMs: 0 }); cleanups.push(() => delivery.stop());
    delivery.accept(incoming("/start")); await delivery.pump(); expect(sends).toBe(1);
    await delivery.pump(); expect(sends).toBe(1);
    c.store.db.query("UPDATE telegram_deliveries SET next_at='2000-01-01T00:00:00Z'").run();
    await delivery.pump(); expect(sends).toBe(2);
    expect(c.store.db.query("SELECT status FROM outbox").get()).toEqual({ status: "delivered" });
    const uncertainController = fixture(); let uncertainSends = 0;
    const uncertain = new V2Delivery(bridgeConfig(uncertainController.base), { sendMessage: async () => { uncertainSends++; throw new Error("send committed but reply lost"); } }, { minChatIntervalMs: 0 });
    cleanups.push(() => uncertain.stop()); uncertain.accept(incoming("/start")); await uncertain.pump(); await uncertain.pump();
    expect(uncertainSends).toBe(1); expect(uncertainController.store.db.query("SELECT status FROM outbox").get()).toEqual({ status: "uncertain" });
  });
});
