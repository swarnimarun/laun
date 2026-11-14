import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ControlApproval, ThreadPurgeJob, ThreadRecord } from "@laun/protocol";
import { captureCheckpoint } from "@laun/storage";
import { beginThreadPurge, continueThreadPurge, inspectThreadPurge, listHostCleanupPlans, previewThreadPurge } from "./retention.js";
import { ControlError, ControlStore, hash } from "./store.js";
import { ControlService } from "./service.js";
import { createControlBackup, restoreControlBackup } from "./backup.js";
import { ensureAdviser, requestAdvice } from "./adviser.js";
import { handleTelegramConnectorRequest } from "./connectors.js";

const p = { id: `user_${"a".repeat(32)}`, admin: false }, other = { id: `user_${"b".repeat(32)}`, admin: false }, admin = { id: "service", admin: true };
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "laun-retention-")), store = new ControlStore(join(dir, "control.sqlite"));
  const worker = store.registerWorker(p, { name: "Yard" }).worker;
  const mower = store.createMower(p, { name: "Director", role: "director", workerId: worker.id });
  const root = store.createThread(p, { mowerId: mower.id, title: "Keep parent" });
  const thread = store.createThread(p, { mowerId: mower.id, parentThreadId: root.id, title: "Private child title" });
  const run = store.submit(p, thread.id, { text: "Private prompt", requestId: "original-input" }), job = store.claim(worker)!;
  store.event(thread.id, "agent", { event: { type: "usage", sessionId: thread.id, totalTokens: 120, costUsd: 0.25 } }, run.id);
  store.finish(run.id, worker.id, job.run.generation, "done", "Private result");
  store.cancel(p, thread.id); const archived = store.get<ThreadRecord>("thread", thread.id); archived.archivedAt = new Date().toISOString(); store.put("thread", archived);
  close.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const preview = () => previewThreadPurge(store, p, thread.id);
  const begin = (requestId = "purge-one") => beginThreadPurge(store, p, thread.id, { requestId, expectedDigest: preview().digest, confirmedStopped: true, confirmedControllerCopyOnly: true });
  return { dir, store, worker, mower, root, thread, run, preview, begin };
}
function finish(f: ReturnType<typeof fixture>, job: ThreadPurgeJob, maxRows = 2) {
  for (let attempts = 0; job.status !== "done" && attempts < 1000; attempts++) job = continueThreadPurge(f.store, p, job.id, { maxRows });
  expect(job.status).toBe("done"); return job;
}
function status(fn: () => unknown) { try { fn(); return 200; } catch (error) { return (error as ControlError).status; } }
function approval(f: ReturnType<typeof fixture>): ControlApproval {
  const at = new Date().toISOString();
  const value: ControlApproval = { id: "approval-one", ownerId: p.id, profileId: f.thread.profileId, profileVersion: 1, status: "expired", createdAt: at, expiresAt: at,
    action: { id: "action-one", principalId: p.id, workspaceId: f.thread.workspaceId, mowerId: f.mower.id, threadId: f.thread.id, runId: f.run.id, operation: "process.execute", resource: "workspace:own", argumentsDigest: hash("command") }, detail: "run private command" };
  f.store.requestApproval(value, hash("approval")); return value;
}

describe("explicit controller-copy retention", () => {
  test("preview, CAS, bounded restart and tombstones prevent retry and callback resurrection", () => {
    const f = fixture(), a = approval(f);
    for (let i = 0; i < 12; i++) f.store.event(f.thread.id, "system", { text: `Private output ${i}` });
    f.store.receipt(p, "spawn:old", hash("old"), () => ({ thread: f.thread, run: f.run }));
    f.store.receipt(admin, "user-task:admin", hash("admin"), () => ({ thread: f.thread, run: f.run }));
    const before = f.preview(); expect(before.eligible).toBe(true); expect(before.tokens).toBe(120); expect(before.cost).toBe(0.25); expect(before.workers.map(item => item.workerId)).toContain(f.worker.id);
    f.store.event(f.thread.id, "system", { text: "changed since preview" });
    expect(() => beginThreadPurge(f.store, p, f.thread.id, { requestId: "old-preview", expectedDigest: before.digest, confirmedStopped: true, confirmedControllerCopyOnly: true })).toThrow("preview changed");
    expect(status(() => previewThreadPurge(f.store, other, f.thread.id))).toBe(404);
    const job = f.begin(); expect(job.status).toBe("removing");
    for (const key of [p, admin]) { expect(status(() => f.store.get("thread", f.thread.id, key))).toBe(410); expect(status(() => f.store.run(f.run.id, key))).toBe(410); expect(status(() => f.store.approval(a.id, key))).toBe(410); }
    expect(status(() => f.store.get("thread", f.thread.id, other))).toBe(404); expect(status(() => f.store.run(f.run.id, other))).toBe(404);
    expect(status(() => f.store.submit(p, f.thread.id, { text: "Private prompt", requestId: "original-input" }))).toBe(410);
    expect(status(() => f.store.receipt(p, "spawn:old", hash("changed"), () => { throw new Error("must not execute"); }))).toBe(410);
    expect(status(() => f.store.receipt(admin, "user-task:admin", hash("admin"), () => { throw new Error("must not execute"); }))).toBe(410);
    expect(status(() => f.store.finish(f.run.id, f.worker.id, 1, "done"))).toBe(410); expect(status(() => f.store.heartbeat(f.worker.id, f.run.id, 1))).toBe(410);
    expect(status(() => f.store.put("thread", f.thread))).toBe(410); expect(status(() => f.store.event(f.thread.id, "system", { text: "late" }))).toBe(410);
    expect(f.store.list("thread", p).map(item => item.id)).toEqual([f.root.id]); expect(f.store.runs(p)).toHaveLength(0); expect(f.store.approvals(p)).toHaveLength(0);
    const batch = continueThreadPurge(f.store, p, job.id, { maxRows: 2 }); expect(batch.removed.events).toBe(2); expect(batch.status).toBe("removing");
    const reopened = new ControlStore(f.store.path); try { expect(inspectThreadPurge(reopened, p, job.id).id).toBe(job.id); expect(status(() => reopened.get("thread", f.thread.id, p))).toBe(410); } finally { reopened.close(); }
    const done = finish(f, batch); expect(done.removed.events).toBeGreaterThan(10); expect(done.pendingHostCopies).toBe(1); expect(listHostCleanupPlans(f.store, p)[0]).toMatchObject({ workerId: f.worker.id, status: "pending" });
    expect(beginThreadPurge(f.store, p, f.thread.id, { requestId: "purge-one", expectedDigest: before.digest, confirmedStopped: true, confirmedControllerCopyOnly: true }).id).toBe(job.id);
    expect(continueThreadPurge(f.store, p, job.id)).toEqual(inspectThreadPurge(f.store, p, job.id));
    expect(f.store.db.query("SELECT * FROM runs").all()).toHaveLength(0); expect(f.store.db.query("SELECT * FROM events WHERE thread_id=?").all(f.thread.id)).toHaveLength(0);
    expect(f.store.get("mower", f.mower.id)).toBeDefined(); expect(f.store.profile(f.thread.profileId, 1)).toBeDefined();
    const retained = JSON.stringify(f.store.db.query("SELECT * FROM thread_purges UNION ALL SELECT kind,id,owner_id,purge_id,NULL FROM purged_resources").all());
    expect(retained).not.toContain("Private child title"); expect(retained).not.toContain("Private prompt"); expect(retained).not.toContain("Private result");
  });
  test.each(["queued", "running", "waiting_permission", "interrupted"] as const)("%s generations cannot be removed", state => {
    const f = fixture(); f.store.setRunStatus(f.run.id, state); const preview = f.preview(); expect(preview.eligible).toBe(false); expect(() => f.begin()).toThrow("settled"); expect(f.store.get("thread", f.thread.id)).toBeDefined();
  });
  test("leaf, archive, delegation, unresolved inference and send outcomes are required independently", () => {
    const f = fixture(); const target = f.store.get<ThreadRecord>("thread", f.thread.id); delete target.archivedAt; f.store.put("thread", target); expect(f.preview().eligible).toBe(false);
    target.archivedAt = new Date().toISOString(); f.store.put("thread", target); const child = f.store.createThread(p, { mowerId: f.mower.id, parentThreadId: f.root.id });
    expect(previewThreadPurge(f.store, p, f.root.id).blockers.join()).toContain("leaf");
    f.store.db.query("INSERT INTO inference_calls VALUES(?,?,?,?,?,?,?)").run(f.run.id, 1, "unknown", hash("intent"), "admitted", new Date().toISOString(), new Date().toISOString()); expect(f.preview().blockers.join()).toContain("inference");
    f.store.db.query("UPDATE inference_calls SET status='interrupted'").run();
    for (const state of ["pending", "sending", "uncertain"]) { f.store.db.query("INSERT OR REPLACE INTO outbox VALUES(?,?,?,?,?)").run("delivery", p.id, `thread:${f.root.id}`, JSON.stringify({ sourceThreadId: f.thread.id, text: "Private result" }), state); expect(f.preview().blockers.join()).toContain("deliveries"); }
    f.store.db.query("UPDATE outbox SET status='cancelled'").run(); expect(f.preview().eligible).toBe(true); expect(child.id).not.toBe(f.thread.id);
  });
  test("active Gatekeeper discussions block source removal; the managed adviser itself is retained", async () => {
    const f = fixture(), a = approval(f), service = new ControlService({ store: f.store, dataDir: f.dir, mode: "unconfigured" }); close.push(() => service.close());
    const advice = requestAdvice(service, p, a.id, "What guardrails make sense?"); expect(f.preview().blockers.join()).toContain("Gatekeeper");
    f.store.setRunStatus(advice.run.id, "done"); expect(f.preview().eligible).toBe(true);
    const keeper = ensureAdviser(service, p, "fixture/model"), keeperThread = keeper.thread; keeperThread.stoppedAt = keeperThread.archivedAt = new Date().toISOString(); f.store.put("thread", keeperThread);
    expect(previewThreadPurge(f.store, p, keeperThread.id).blockers.join()).toContain("managed Gatekeeper");
    finish(f, f.begin()); expect(status(() => f.store.assertNotPurged("advice", advice.run.id, p))).toBe(410);
    expect(f.store.get("thread", keeperThread.id)).toBeDefined();
  });
  test("child usage remains debited exactly once and still stops a surviving family", async () => {
    const f = fixture(); const job = f.begin();
    const service = new ControlService({ store: f.store, dataDir: f.dir, mode: "unconfigured", maxFamilyTokens: 125 }); close.push(() => service.close());
    const run = f.store.submit(p, f.root.id, { text: "parent continuation", requestId: "parent" });
    const event = { type: "usage" as const, sessionId: f.root.id, totalTokens: 6 }; f.store.event(f.root.id, "agent", { event }, run.id); service.enforceBudget(f.root, run, event);
    expect(f.store.get<ThreadRecord>("thread", f.root.id).stoppedAt).toBeString(); expect(f.store.run(run.id).status).toBe("cancelled");
    finish(f, job); expect((f.store.db.query("SELECT SUM(tokens) n FROM family_usage_debits").get() as { n: number }).n).toBe(120);
  });
  test("partial removal cannot be backed up and completed tombstones and debit survive inert restore", async () => {
    const f = fixture(), a = approval(f); const source = join(f.dir, "checkpoint-source"); mkdirSync(join(source, "session"), { recursive: true }); mkdirSync(join(source, "work")); writeFileSync(join(source, "session", "state.jsonl"), '{"neutral":true}\n');
    f.store.db.query("INSERT INTO checkpoints VALUES(?,?,?)").run(f.thread.id, await captureCheckpoint(f.thread.id, source), new Date().toISOString());
    f.store.receipt(p, "old-action", hash("old-action"), () => ({ threadId: f.thread.id, approvalId: a.id }));
    const job = f.begin(), backup = join(f.dir, "backup"); await expect(createControlBackup({ dataDir: f.dir, destination: backup, confirmOffline: true })).rejects.toThrow("finish all controller removal");
    finish(f, job); await createControlBackup({ dataDir: f.dir, destination: backup, confirmOffline: true });
    const target = join(f.dir, "restored"); await restoreControlBackup({ backupDir: backup, targetDir: target, confirmOffline: true });
    const restored = new ControlStore(join(target, "control.sqlite")); try {
      expect(status(() => restored.get("thread", f.thread.id, p))).toBe(410); expect(status(() => restored.get("thread", f.thread.id, other))).toBe(404);
      expect(status(() => restored.receipt(p, "old-action", hash("old-action"), () => "must not happen"))).toBe(410);
      expect((restored.db.query("SELECT SUM(tokens) n FROM family_usage_debits").get() as { n: number }).n).toBe(120);
      expect(listHostCleanupPlans(restored, p).every(plan => plan.status === "blocked")).toBe(true); expect(restored.runs(p)).toHaveLength(0);
      const service=new ControlService({store:restored,dataDir:target,mode:"unconfigured",maxFamilyTokens:125});try{const root=restored.get<ThreadRecord>("thread",f.root.id,p),next=restored.submit(p,root.id,{text:"fresh reviewed work",requestId:"after-restore"}),event={type:"usage" as const,sessionId:root.id,totalTokens:6};restored.event(root.id,"agent",{event},next.id);service.enforceBudget(root,next,event);expect(restored.run(next.id).status).toBe("cancelled");}finally{await service.close();}
    } finally { restored.close(); }
  });
  test("Telegram route history requires explicit broader consent and inbound dedup remains intact", async () => {
    const f = fixture(), service = new ControlService({ store: f.store, dataDir: f.dir, mode: "unconfigured" }); close.push(() => service.close());
    const options = { serviceToken: "fixture-bridge-token", botId: "42", allowlist: ["10"] };
    await handleTelegramConnectorRequest(service, new Request("http://controller/api/v2/identity/telegram-link", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), options, p);
    const key = "route-fixture", at = new Date().toISOString(); f.store.db.query("INSERT INTO telegram_routes VALUES(?,?,?,?,?,?,?)").run(key, "42", "10", "10", "0", p.id, f.thread.id); f.store.db.query("INSERT INTO telegram_subscriptions VALUES(?,?,?)").run(key, f.thread.id, 0);
    f.store.db.query("INSERT INTO telegram_inbox VALUES(?,?,?,?)").run("42", 5, hash("old-update"), '{"accepted":true}');
    f.store.db.query("INSERT INTO outbox VALUES(?,?,?,?,?)").run("legacy-delivery", p.id, `telegram:${key}`, JSON.stringify({ routeKey: key, text: "Old untyped route history" }), "delivered");
    f.store.db.query("INSERT INTO telegram_deliveries(id,bot_id,next_at,updated_at) VALUES(?,?,?,?)").run("legacy-delivery", "42", at, at);
    const preview = f.preview(); expect(preview.legacyTelegramRoutes).toEqual([key]); expect(() => f.begin()).toThrow("unrelated settled history");
    const job = beginThreadPurge(f.store, p, f.thread.id, { requestId: "route-removal", expectedDigest: preview.digest, confirmedStopped: true, confirmedControllerCopyOnly: true, confirmedLegacyTelegramRouteCleanup: true }); finish(f, job);
    expect(f.store.db.query("SELECT * FROM telegram_routes").all()).toHaveLength(0); expect(f.store.db.query("SELECT * FROM telegram_subscriptions").all()).toHaveLength(0); expect(f.store.db.query("SELECT * FROM outbox").all()).toHaveLength(0); expect(f.store.db.query("SELECT * FROM telegram_inbox").all()).toHaveLength(1);
  });
  test("typed shared-route output is retained and a changed leased delivery invalidates the preview",async()=>{
    const f=fixture(),service=new ControlService({store:f.store,dataDir:f.dir,mode:"unconfigured"});close.push(()=>service.close());
    await handleTelegramConnectorRequest(service,new Request("http://controller/api/v2/identity/telegram-link",{method:"POST"}),{serviceToken:"bridge",botId:"42",allowlist:["10"]},p);
    const route="typed-route",at=new Date().toISOString();f.store.db.query("INSERT INTO telegram_routes VALUES(?,?,?,?,?,?,?)").run(route,"42","10","10","0",p.id,f.thread.id);f.store.db.query("INSERT INTO telegram_subscriptions VALUES(?,?,?)").run(route,f.thread.id,0);
    for(const [deliveryId,sourceThreadId]of[["child-output",f.thread.id],["parent-output",f.root.id]]){f.store.db.query("INSERT INTO outbox VALUES(?,?,?,?,?)").run(deliveryId!,p.id,`telegram:${route}`,JSON.stringify({routeKey:route,sourceThreadId,text:"typed output"}),"delivered");f.store.db.query("INSERT INTO telegram_deliveries(id,bot_id,next_at,updated_at) VALUES(?,?,?,?)").run(deliveryId!,"42",at,at);}
    const preview=f.preview();expect(preview.legacyTelegramRoutes).toHaveLength(0);expect(preview.counts.outbox).toBe(1);
    f.store.db.query("UPDATE telegram_deliveries SET lease_until=? WHERE id='parent-output'").run(new Date(Date.now()+60000).toISOString());
    expect(()=>beginThreadPurge(f.store,p,f.thread.id,{requestId:"stale-route",expectedDigest:preview.digest,confirmedStopped:true,confirmedControllerCopyOnly:true})).toThrow("preview changed");expect(f.preview().blockers.join()).toContain("lease");
    f.store.db.query("UPDATE telegram_deliveries SET lease_until=NULL").run();finish(f,f.begin());expect(f.store.db.query("SELECT id FROM outbox").all()).toEqual([{id:"parent-output"}]);
  });
  test("a failed batch rolls back only that batch and leaves the deletion fence resumable",()=>{
    const f=fixture(),job=f.begin();f.store.db.exec("CREATE TRIGGER fixture_failed_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
    const before=f.store.db.query("SELECT COUNT(*) n FROM events WHERE thread_id=?").get(f.thread.id);expect(()=>continueThreadPurge(f.store,p,job.id,{maxRows:1})).toThrow("fixture write failure");
    expect(f.store.db.query("SELECT COUNT(*) n FROM events WHERE thread_id=?").get(f.thread.id)).toEqual(before);expect(inspectThreadPurge(f.store,p,job.id).removed).toEqual({});expect(status(()=>f.store.get("thread",f.thread.id,p))).toBe(410);
    f.store.db.exec("DROP TRIGGER fixture_failed_delete");finish(f,job);
  });
  test("a child-only subscription does not delete the surviving route, other subscriptions or permission handles",async()=>{
    const f=fixture(),service=new ControlService({store:f.store,dataDir:f.dir,mode:"unconfigured"});close.push(()=>service.close());await handleTelegramConnectorRequest(service,new Request("http://controller/api/v2/identity/telegram-link",{method:"POST"}),{serviceToken:"bridge",botId:"42",allowlist:["10"]},p);
    const route="surviving-route",at=new Date().toISOString();f.store.db.query("INSERT INTO telegram_routes VALUES(?,?,?,?,?,?,?)").run(route,"42","10","10","0",p.id,f.root.id);for(const threadId of[f.thread.id,f.root.id])f.store.db.query("INSERT INTO telegram_subscriptions VALUES(?,?,?)").run(route,threadId,0);
    f.store.db.query("INSERT INTO telegram_handles VALUES(?,?,?,?,?,?,?)").run("parent-button",route,p.id,"parent-approval",at,0,null);
    f.store.db.query("INSERT INTO outbox VALUES(?,?,?,?,?)").run("parent-reply",p.id,`telegram:${route}`,JSON.stringify({routeKey:route,sourceThreadId:f.root.id,text:"keep parent output"}),"delivered");
    finish(f,f.begin());expect(f.store.db.query("SELECT thread_id FROM telegram_routes WHERE route_key=?").get(route)).toEqual({thread_id:f.root.id});expect(f.store.db.query("SELECT thread_id FROM telegram_subscriptions WHERE route_key=?").all(route)).toEqual([{thread_id:f.root.id}]);expect(f.store.db.query("SELECT handle FROM telegram_handles").all()).toEqual([{handle:"parent-button"}]);expect(f.store.db.query("SELECT id FROM outbox").all()).toEqual([{id:"parent-reply"}]);
  });
  test("unlinked old untyped history needs explicit broader consent without removing typed parent history",()=>{
    const f=fixture(),route="old-unlinked-route";for(const[deliveryId,payload]of[["old-untyped",{routeKey:route,botId:"42",chatId:"10",topicId:"0",text:"unattributed old content"}],["typed-parent",{routeKey:route,sourceThreadId:f.root.id,text:"keep typed parent"}],["new-static",{routeKey:route,sourceVersion:1,text:"static help response"}] ]as const)f.store.db.query("INSERT INTO outbox VALUES(?,?,?,?,?)").run(deliveryId,p.id,`telegram:${route}`,JSON.stringify(payload),"delivered");
    const preview=f.preview();expect(preview.legacyTelegramRoutes).toEqual([route]);expect(preview.legacyTelegramRouteDetails).toEqual([{routeKey:route,botId:"42",chatId:"10",topicId:"0",deliveries:1}]);expect(()=>f.begin()).toThrow("unrelated settled history");
    f.store.db.query("UPDATE outbox SET status='uncertain' WHERE id='old-untyped'").run();expect(f.preview().blockers.join()).toContain("deliveries");f.store.db.query("UPDATE outbox SET status='cancelled' WHERE id='old-untyped'").run();
    const job=beginThreadPurge(f.store,p,f.thread.id,{requestId:"old-history",expectedDigest:f.preview().digest,confirmedStopped:true,confirmedControllerCopyOnly:true,confirmedLegacyTelegramRouteCleanup:true});finish(f,job);expect(f.store.db.query("SELECT id FROM outbox ORDER BY id").all()).toEqual([{id:"new-static"},{id:"typed-parent"}]);
  });
});
