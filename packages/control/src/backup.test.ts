import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, ControlApproval, ControlBackupManifest, MowerRecord, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { captureCheckpoint, validateCheckpoint } from "@laun/storage";
import { createControlBackup, restoreControlBackup } from "./backup.js";
import { ensureAdviser } from "./adviser.js";
import { handleTelegramConnectorRequest } from "./connectors.js";
import { ControlService } from "./service.js";
import { ControlStore, hash } from "./store.js";

const dirs: string[] = [], stores: ControlStore[] = [], services: ControlService[] = [];
const p = { id: `user_${"a".repeat(32)}`, admin: false };
const telegram = { serviceToken: "fixture-bridge-token-not-in-backup", botId: "123", allowlist: ["456"] };
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "laun-backup-")); dirs.push(dir); return dir; };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function rewriteManifest(path: string) { const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as ControlBackupManifest;
  for (const file of manifest.files) { file.sha256 = digest(join(path, file.path)); file.bytes = statSync(join(path, file.path)).size; } writeFileSync(join(path, "manifest.json"), JSON.stringify(manifest)); }
function request(path: string, body: unknown, bridge = false) { return new Request(`http://fixture/api/v2${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(bridge ? { authorization: `Bearer ${telegram.serviceToken}` } : {}) } }); }
async function setup() {
  const root = scratch(), source = join(root, "source"); mkdirSync(source, { mode: 0o700 });
  const store = new ControlStore(join(source, "control.sqlite")); stores.push(store);
  const service = new ControlService({ store, dataDir: join(source, "control"), mode: "unconfigured" }); services.push(service);
  const mower = store.createMower(p, { name: "Fern" }), thread = store.createThread(p, { mowerId: mower.id, title: "Durable work" });
  const registered = store.registerWorker(p, { name: "Remote yard" }), worker = registered.worker; mower.workerId = worker.id; store.put("mower", mower);
  const active = store.submit(p, thread.id, { text: "active action", requestId: "active" }); const job = store.claim(worker)!;
  store.db.exec("CREATE TABLE IF NOT EXISTS inference_calls(run_id TEXT NOT NULL,generation INTEGER NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,generation,request_id))");
  for (const status of ["admitted", "done"]) store.db.query("INSERT INTO inference_calls VALUES(?,?,?,?,?,?,?)").run(active.id, job.run.generation, `inference-${status}`, hash(status), status, new Date().toISOString(), new Date().toISOString());
  store.setRunStatus(active.id, "waiting_permission"); const queued = store.submit(p, thread.id, { text: "queued at backup", requestId: "queued" });
  const approval: ControlApproval = { id: "approval-fixture", ownerId: p.id, profileId: mower.profileId, profileVersion: 1, status: "pending", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), detail: "Exact fixture command",
    action: { id: "action-fixture", principalId: p.id, mowerId: mower.id, threadId: thread.id, runId: active.id, workspaceId: thread.workspaceId, operation: "process.execute", resource: "workspace:own", argumentsDigest: hash("args") } };
  store.requestApproval(approval, "fingerprint-fixture");
  store.saveConnection({ id: "connection-fixture", ownerId: p.id, workspaceId: "default", name: "MCP fixture", transport: "http", url: "https://example.com/mcp", secretRef: "MCP_REPROVISION_SECRET", enabled: true });
  const threadRoot = join(root, "checkpoint-source"); mkdirSync(join(threadRoot, "session"), { recursive: true }); mkdirSync(join(threadRoot, "work"));
  writeFileSync(join(threadRoot, "session", "session.jsonl"), '{"type":"session","version":3}\n'); writeFileSync(join(threadRoot, "work", "result.txt"), "durable workspace bytes");
  const checkpoint = await captureCheckpoint(thread.id, threadRoot); store.db.query("INSERT INTO checkpoints VALUES(?,?,?)").run(thread.id, checkpoint, new Date().toISOString());
  const key = { id: "deadbeef", principalId: p.id, hash: hash("never-export-this-human-secret"), label: "human laptop", createdAt: new Date().toISOString() };
  writeFileSync(join(source, "keys.json"), JSON.stringify([key]), { mode: 0o600 });
  writeFileSync(join(source, ".env"), "GATEWAY_TOKEN=raw-installation-token-never-export"); writeFileSync(join(source, "provider-auth.json"), "raw-provider-auth-never-export");
  writeFileSync(join(source, "bridge-inbox.sqlite"), "separate-encrypted-bridge-inbox");
  ensureAdviser(service, p, "fixture/model");
  const link = await handleTelegramConnectorRequest(service, request("/identity/telegram-link", {}), telegram, p); const linked = await link!.json() as { code: string };
  const ingest = (updateId: number, text: string) => handleTelegramConnectorRequest(service, request("/connectors/telegram/ingest", { botId: "123", userId: "456", chatId: "456", updateId, text }, true), telegram);
  await ingest(1, `/link ${linked.code}`); await ingest(2, `/thread ${thread.id}`); await ingest(3, "/status");
  await handleTelegramConnectorRequest(service, request("/connectors/telegram/poll", { botId: "123", limit: 1 }, true), telegram);
  await service.close(); services.splice(services.indexOf(service), 1);
  return { root, source, store, mower, thread, worker, workerKey: registered.key, active, queued, job, approval, checkpoint, key, backup: join(root, "backup"), target: join(root, "restored") };
}

describe("offline v2 control backup and safe restore", () => {
  test("consistent SQLite archive preserves checkpoints, principals, profiles and references without exporting credential files", async () => {
    const f = await setup();
    const manifest = await createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true });
    expect(manifest.scope).toBe("laun-v2-control"); expect(manifest.files.map(file => file.path).sort()).toEqual(["control.sqlite", "keys.json"]);
    expect(readdirSync(f.backup).sort()).toEqual(["control.sqlite", "keys.json", "manifest.json"]);
    expect(statSync(f.backup).mode & 0o777).toBe(0o700);
    for (const file of ["control.sqlite", "keys.json", "manifest.json"]) expect(statSync(join(f.backup, file)).mode & 0o777).toBe(0o600);
    for (const file of manifest.files) { expect(digest(join(f.backup, file.path))).toBe(file.sha256); expect(statSync(join(f.backup, file.path)).size).toBe(file.bytes); }
    const bytes = Buffer.concat(manifest.files.map(file => readFileSync(join(f.backup, file.path))));
    for (const secret of ["raw-installation-token-never-export", "raw-provider-auth-never-export", "never-export-this-human-secret", f.workerKey, telegram.serviceToken, "separate-encrypted-bridge-inbox"]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const restored = await restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true });
    expect(restored.principals).toContainEqual({ principalId: p.id, keyIds: [f.key.id] });
    const store = new ControlStore(join(f.target, "control.sqlite")); stores.push(store);
    expect(store.get<MowerRecord>("mower", f.mower.id, p).ownerId).toBe(p.id);
    expect(store.get<ThreadRecord>("thread", f.thread.id, p).profileId).toBe(f.thread.profileId);
    expect(store.profile(f.mower.profileId, 1, p).rules).toEqual(f.store.profile(f.mower.profileId, 1, p).rules);
    expect(store.checkpoint(f.thread.id)).toBe(f.checkpoint);
    expect(validateCheckpoint(store.checkpoint(f.thread.id)!, f.thread.id).files.some(file => file.path === "work/result.txt")).toBe(true);
    expect(store.get("connection", "connection-fixture", p)).toMatchObject({ ownerId: p.id, secretRef: "MCP_REPROVISION_SECRET" });
    expect(() => store.get("thread", f.thread.id, { id: `user_${"b".repeat(32)}`, admin: false })).toThrow("not found");
  });

  test("old queued/running authority never replays; links, approvals and credentials must be renewed", async () => {
    const f = await setup(); await createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true });
    // The original yard later performed work represented as queued in the
    // snapshot. Restoring that snapshot must not execute it a second time.
    f.store.finish(f.active.id, f.worker.id, f.job.run.generation, "done", "effect already happened after backup");
    const later = f.store.claim(f.worker)!; expect(later.run.id).toBe(f.queued.id); f.store.finish(later.run.id, f.worker.id, later.run.generation, "done", "queued action also already happened");
    const result = await restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true });
    expect(result.safety.interruptedRuns).toBe(2); expect(result.safety.expiredApprovals).toBe(1); expect(result.safety.revokedWorkers).toBe(1); expect(result.safety.revokedHumanKeys).toBe(1);
    expect(result.safety.interruptedInferenceCalls).toBe(1);
    expect(result.safety.uncertainDeliveries).toBeGreaterThan(0);
    const store = new ControlStore(join(f.target, "control.sqlite")); stores.push(store);
    for (const runId of [f.active.id, f.queued.id]) { const run = store.run(runId, p); expect(run.status).toBe("interrupted"); expect(run.cancelRequested).toBe(true); expect(run.leaseUntil).toBeUndefined(); }
    expect(store.claim(f.worker)).toBeNull(); expect(store.authenticateWorker(f.workerKey)).toBeNull(); expect(store.approval(f.approval.id).status).toBe("expired");
    expect(store.get<ThreadRecord>("thread", f.thread.id).stoppedAt).toBeDefined(); expect(store.get<WorkerRecord>("worker", f.worker.id).status).toBe("revoked");
    const keys = JSON.parse(readFileSync(join(f.target, "keys.json"), "utf8")) as Array<Record<string, unknown>>; expect(keys[0]).toMatchObject({ id: f.key.id, principalId: p.id, hash: f.key.hash }); expect(keys[0]!.revokedAt).toBeString();
    for (const table of ["telegram_links", "telegram_link_codes", "telegram_handles", "telegram_routes", "telegram_subscriptions"]) expect(store.db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(store.db.query("SELECT count(*) n FROM outbox WHERE status IN('pending','sending')").get()).toEqual({ n: 0 });
    expect(store.db.query("SELECT status FROM inference_calls ORDER BY request_id").all()).toEqual([{ status: "interrupted" }, { status: "done" }]);
    let effects = 0; const runtime: AgentRuntime = { async run() { effects++; return { status: "done" }; }, cancel() {}, close() {} };
    const service = new ControlService({ store, runtime, dataDir: join(f.target, "control"), mode: "trusted-local" }); services.push(service);
    await service.tick(); await Bun.sleep(20); expect(effects).toBe(0);
    const deliveries = await handleTelegramConnectorRequest(service, request("/connectors/telegram/poll", { botId: "123" }, true), telegram);
    expect(await deliveries!.json()).toMatchObject({ deliveries: [] });
    expect(() => store.decide(p, f.approval.id, "approve")).toThrow("already settled");
  });

  test("tampering fails before publishing and never changes the original source or existing target", async () => {
    const f = await setup(); await createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true }); const before = digest(join(f.source, "control.sqlite"));
    writeFileSync(join(f.backup, "keys.json"), "[] ");
    await expect(restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true })).rejects.toThrow("checksum mismatch");
    expect(existsSync(f.target)).toBe(false); expect(digest(join(f.source, "control.sqlite"))).toBe(before);
    expect(readdirSync(f.root).some(file => file.startsWith(".restored.laun-"))).toBe(false);
    mkdirSync(f.target); writeFileSync(join(f.target, "keep.txt"), "original data");
    await expect(restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true })).rejects.toThrow("destination already exists");
    expect(readFileSync(join(f.target, "keep.txt"), "utf8")).toBe("original data");
    await expect(createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true })).rejects.toThrow("destination already exists");
  });

  test.each(["schema", "reference", "idempotency"])("valid hashes do not bypass %s validation", async kind => {
    const f = await setup(); await createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true });
    const db = new Database(join(f.backup, "control.sqlite"));
    if (kind === "schema") db.exec("CREATE TABLE future_automatic_effects(payload TEXT)");
    else if (kind === "reference") { const thread = f.store.get<ThreadRecord>("thread", f.thread.id); thread.ownerId = `user_${"b".repeat(32)}`; db.query("UPDATE objects SET owner_id=?,body=? WHERE kind='thread' AND id=?").run(thread.ownerId, JSON.stringify(thread), thread.id); }
    else db.exec("ALTER TABLE runs RENAME TO previous_runs; CREATE TABLE runs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,request_id TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,worker_id TEXT,generation INTEGER NOT NULL DEFAULT 0,lease_until TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,summary TEXT,model TEXT); INSERT INTO runs SELECT * FROM previous_runs; DROP TABLE previous_runs; CREATE INDEX run_queue ON runs(status,created_at)");
    db.close(); rewriteManifest(f.backup);
    await expect(restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true })).rejects.toThrow(kind === "schema" ? "unsupported database schema" : kind === "reference" ? "cross-owner" : "idempotency constraint");
    expect(existsSync(f.target)).toBe(false);
  });

  test("owner inventory survives even when no credential record remains", async () => {
    const f = await setup(); rmSync(join(f.source, "keys.json"));
    await createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true });
    const result = await restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true });
    expect(result.principals).toContainEqual({ principalId: p.id, keyIds: [] });
    expect(JSON.parse(readFileSync(join(f.target, "keys.json"), "utf8"))).toEqual([]);
  });

  test("symlinks, unknown payload files and absent explicit offline confirmation fail closed", async () => {
    const f = await setup();
    await expect(createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: false as true })).rejects.toThrow("confirmOffline");
    const link = join(f.root, "source-link"); symlinkSync(f.source, link);
    await expect(createControlBackup({ dataDir: link, destination: f.backup, confirmOffline: true })).rejects.toThrow("symlink");
    await createControlBackup({ dataDir: f.source, destination: f.backup, confirmOffline: true }); writeFileSync(join(f.backup, ".env"), "not a supported backup member");
    await expect(restoreControlBackup({ backupDir: f.backup, targetDir: f.target, confirmOffline: true })).rejects.toThrow("unexpected backup files");
    expect(existsSync(f.target)).toBe(false);
  });
});
