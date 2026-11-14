import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPermissionProfile } from "@laun/policy";
import { validateCheckpoint } from "@laun/storage";
import type { ControlBackupManifest, ControlRestoreResult, PublicAgentKeyRecord } from "@laun/protocol";

export interface ControlBackupOptions { dataDir: string; destination: string; confirmOffline: true }
export interface ControlRestoreOptions { backupDir: string; targetDir: string; confirmOffline: true }
interface KeyRecord extends PublicAgentKeyRecord { hash: string }
type Row = Record<string, unknown>;
const CORE: Record<string, string[]> = {
  metadata: ["key", "value"], objects: ["kind", "id", "owner_id", "body"], worker_auth: ["id", "hash"],
  runs: ["id", "owner_id", "thread_id", "request_id", "prompt", "status", "worker_id", "generation", "lease_until", "created_at", "updated_at", "cancel_requested", "summary", "model", "instructions"],
  events: ["sequence", "thread_id", "run_id", "created_at", "kind", "payload"], approvals: ["id", "owner_id", "run_id", "fingerprint", "status", "body"],
  receipts: ["owner_id", "key", "fingerprint", "body"], worker_sequences: ["run_id", "generation", "next_sequence"],
  routing: ["key", "owner_id", "thread_id"], checkpoints: ["thread_id", "body", "updated_at"], outbox: ["id", "owner_id", "destination", "body", "status"],
};
const TELEGRAM: Record<string, string[]> = {
  telegram_link_codes: ["hash", "owner_id", "expires_at", "used_at"], telegram_links: ["bot_id", "user_id", "owner_id", "created_at"],
  telegram_routes: ["route_key", "bot_id", "user_id", "chat_id", "topic_id", "owner_id", "thread_id"], telegram_subscriptions: ["route_key", "thread_id", "cursor"],
  telegram_inbox: ["bot_id", "update_id", "fingerprint", "body"], telegram_handles: ["handle", "route_key", "owner_id", "approval_id", "expires_at", "can_approve", "used_at"],
  telegram_deliveries: ["id", "bot_id", "lease_id", "lease_until", "next_at", "updated_at", "attempts", "message_id"],
};
const ADVISER: Record<string, string[]> = {
  permission_advisers: ["owner_id", "mower_id", "thread_id", "profile_id", "profile_version"],
  permission_advice: ["run_id", "owner_id", "thread_id", "approval_id", "base_profile", "action_fingerprint", "feedback", "body"],
};
const INFERENCE: Record<string, string[]> = { inference_calls: ["run_id", "generation", "request_id", "fingerprint", "status", "created_at", "updated_at"] };
const PRIMARY: Record<string, string[]> = {
  metadata: ["key"], objects: ["kind", "id"], worker_auth: ["id"], runs: ["id"], events: ["sequence"], approvals: ["id"], receipts: ["owner_id", "key"],
  worker_sequences: ["run_id", "generation"], routing: ["key"], checkpoints: ["thread_id"], outbox: ["id"], telegram_link_codes: ["hash"], telegram_links: ["bot_id", "user_id"],
  telegram_routes: ["route_key"], telegram_subscriptions: ["route_key", "thread_id"], telegram_inbox: ["bot_id", "update_id"], telegram_handles: ["handle"], telegram_deliveries: ["id"],
  permission_advisers: ["owner_id"], permission_advice: ["run_id"],
  inference_calls: ["run_id", "generation", "request_id"],
};
const EXTRA_UNIQUE: Record<string, string[]> = { runs: ["thread_id", "request_id"], approvals: ["run_id", "fingerprint"], telegram_handles: ["route_key", "approval_id"] };
function fail(message: string): never { throw new Error(`control backup: ${message}`); }
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : fail("invalid record");
const parse = (value: unknown): Row => { if (typeof value !== "string") return fail("invalid stored JSON"); try { return object(JSON.parse(value)); } catch { return fail("invalid stored JSON"); } };
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const owner = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\0]/.test(value);
function assertOffline(value: unknown) { if (value !== true) fail("stop the controller, bridge and workers, then explicitly confirmOffline"); }
function directory(path: string): string {
  const full = resolve(path); const stat = lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(full) !== full) fail("directory must be a real directory without symlink ancestors");
  return full;
}
function regular(path: string): void { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) fail("refusing a symlink or special file"); }
function syncFile(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function syncDir(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** Memory use is bounded by a single 64 KiB buffer while files are copied/hashed. */
function transfer(source: string, destination?: string): { bytes: number; sha256: string } {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const before = fstatSync(input); if (!before.isFile()) fail("refusing a special source file");
    if (destination) output = openSync(destination, "wx", 0o600);
    const buffer = Buffer.alloc(65536), digest = createHash("sha256"); let bytes = 0;
    for (;;) { const size = readSync(input, buffer, 0, buffer.length, null); if (!size) break; const chunk = buffer.subarray(0, size); digest.update(chunk); bytes += size;
      if (output !== undefined) { let offset = 0; while (offset < size) offset += writeSync(output, chunk, offset, size - offset); }
    }
    const after = fstatSync(input);
    if (before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || bytes !== before.size) fail("source changed while copying; keep services stopped");
    if (output !== undefined) fsyncSync(output);
    return { bytes, sha256: digest.digest("hex") };
  } finally { closeSync(input); if (output !== undefined) closeSync(output); }
}
function writePrivate(path: string, value: unknown): void { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); } }
function readKeys(path: string): KeyRecord[] {
  regular(path); const stat = lstatSync(path); if (stat.size > 16 * 1024 * 1024) fail("key index exceeds supported limit");
  let value: unknown; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return fail("invalid key index JSON"); }
  if (!Array.isArray(value)) return fail("invalid key index"); const seen = new Set<string>();
  for (const item of value) { const row = object(item);
    if (Object.keys(row).some(key => !["id", "principalId", "hash", "label", "createdAt", "revokedAt"].includes(key)) || typeof row.id !== "string" || !/^[0-9a-f]{8,32}$/.test(row.id) || seen.has(row.id) ||
      typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash) || typeof row.label !== "string" || !row.label.trim() || !date(row.createdAt) ||
      (row.principalId !== undefined && (typeof row.principalId !== "string" || !/^(?:user_[0-9a-f]{32}|key_[0-9a-f]{8,32})$/.test(row.principalId))) ||
      (row.revokedAt !== undefined && !date(row.revokedAt))) fail("invalid key index record"); seen.add(row.id);
  }
  return value as KeyRecord[];
}
function has(db: Database, table: string): boolean { return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
function schema(db: Database): void {
  const integrity = db.query("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok" || db.query("PRAGMA foreign_key_check").all().length) fail("SQLite integrity check failed");
  const expected = { ...CORE, ...TELEGRAM, ...ADVISER, ...INFERENCE };
  for (const entry of db.query("SELECT type,name,sql FROM sqlite_master").iterate() as Iterable<{ type: string; name: string; sql: string | null }>) {
    if (entry.type === "index") { if (!(entry.name.startsWith("sqlite_autoindex_") && entry.sql === null) && !["run_queue", "thread_events"].includes(entry.name)) fail("unsupported database index"); continue; }
    if (entry.type === "table" && entry.name === "sqlite_sequence" && entry.sql === "CREATE TABLE sqlite_sequence(name,seq)") continue;
    if (entry.type !== "table" || !expected[entry.name] || !/^CREATE TABLE\b/i.test(entry.sql ?? "")) fail("unsupported database schema object");
    const columns = db.query(`PRAGMA table_info(${entry.name})`).all() as Array<{ name: string; pk: number; type: string }>;
    const names=columns.map(c=>c.name).join("|");
    const compatibleLegacyRuns=entry.name==="runs"&&names===CORE.runs!.slice(0,-1).join("|");
    if (names !== expected[entry.name]!.join("|")&&!compatibleLegacyRuns) fail(`unsupported ${entry.name} schema`);
    const integers = new Set(["sequence", "generation", "cancel_requested", "next_sequence", "update_id", "cursor", "can_approve", "attempts", "profile_version"]);
    if (columns.some(column => column.type.toUpperCase() !== (integers.has(column.name) ? "INTEGER" : "TEXT"))) fail(`unsupported ${entry.name} column types`);
    if (columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name).join("|") !== PRIMARY[entry.name]!.join("|")) fail(`unsupported ${entry.name} primary identity`);
    const unique = EXTRA_UNIQUE[entry.name]; if (unique) {
      const indexes = db.query(`PRAGMA index_list(${entry.name})`).all() as Array<{ name: string; unique: number }>;
      if (!indexes.some(index => index.unique && /^[A-Za-z0-9_]+$/.test(index.name) && (db.query(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(column => column.name).join("|") === unique.join("|"))) fail(`missing ${entry.name} idempotency constraint`);
    }
  }
  if (Object.keys(CORE).some(name => !has(db, name))) fail("missing core database tables");
  for (const group of [TELEGRAM, ADVISER]) { const count = Object.keys(group).filter(name => has(db, name)).length; if (count && count !== Object.keys(group).length) fail("incomplete optional database schema"); }
  const version = db.query("SELECT value FROM metadata WHERE key='schema'").get() as { value: string } | null;
  if (version?.value !== "1") fail("unsupported control database schema version");
}
function validateReferences(db: Database): void {
  const get = (kind: string, id: unknown, ownerId?: unknown): Row => {
    if (typeof id !== "string") return fail("invalid object reference");
    const row = db.query("SELECT owner_id,body FROM objects WHERE kind=? AND id=?").get(kind, id) as { owner_id: string; body: string } | null;
    if (!row || (ownerId !== undefined && row.owner_id !== ownerId)) return fail("missing or cross-owner object reference"); return parse(row.body);
  };
  const profile = (item: Row) => get("profile", `${item.profileId}:${item.profileVersion}`, item.ownerId);
  for (const row of db.query("SELECT * FROM objects").iterate() as Iterable<{ kind: string; id: string; owner_id: string; body: string }>) {
    const item = parse(row.body);
    if (!owner(item.ownerId) || item.ownerId !== row.owner_id || typeof item.id !== "string" || row.id !== (row.kind === "profile" ? `${item.id}:${item.version}` : item.id)) fail("invalid owned object identity");
    if (row.kind === "profile") { if (!isPermissionProfile(item)) fail("invalid permission profile"); }
    else if (row.kind === "mower") { profile(item); if(item.instructions!==undefined&&(typeof item.instructions!=="string"||item.instructions.length>16000||item.instructions.includes("\0")))fail("invalid mower instructions");if (!["mower", "director", "adviser"].includes(String(item.role))) fail("invalid mower role"); if (item.workerId) { const worker = get("worker", item.workerId); if (!worker.local && worker.ownerId !== item.ownerId) fail("cross-owner worker"); } }
    else if (row.kind === "thread") { get("mower", item.mowerId, item.ownerId); profile(item);
      if (item.workerId) { const worker = get("worker", item.workerId); if (!worker.local && worker.ownerId !== item.ownerId) fail("cross-owner thread worker"); }
      if (item.placementId !== undefined && (typeof item.placementId !== "string" || !/^[0-9a-f-]{36}$/.test(item.placementId))) fail("invalid placement epoch");
      let parent = item.parentThreadId; const seen = new Set([item.id]);
      while (parent) { if (typeof parent !== "string" || seen.has(parent) || seen.size >= 9) fail("invalid thread ancestry"); seen.add(parent); parent = get("thread", parent, item.ownerId).parentThreadId; }
    }
    else if (row.kind === "worker") { if (!["online", "offline", "revoked"].includes(String(item.status)) || typeof item.local !== "boolean") fail("invalid worker"); }
    else if (row.kind === "task") { get("thread", item.parentThreadId, item.ownerId); get("thread", item.threadId, item.ownerId); get("mower", item.mowerId, item.ownerId); }
    else if (row.kind === "connection") { let endpoint: URL; try { endpoint = new URL(String(item.url)); } catch { return fail("invalid connector endpoint"); }
      if (item.transport !== "http" || !["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash ||
        (item.secretRef !== undefined && (typeof item.secretRef !== "string" || !/^MCP_[A-Z0-9_]+$/.test(item.secretRef)))) fail("invalid credential reference or connector endpoint");
    } else fail("unsupported owned object kind");
  }
  const run = (id: unknown, ownerId?: unknown): Row => { const value = db.query("SELECT * FROM runs WHERE id=?").get(String(id)) as Row | null;
    if (!value || (ownerId !== undefined && value.owner_id !== ownerId)) return fail("missing or cross-owner run"); return value; };
  for (const row of db.query("SELECT * FROM runs").iterate() as Iterable<Row>) {
    get("thread", row.thread_id, row.owner_id);
    if(row.instructions!==undefined&&row.instructions!==null&&(typeof row.instructions!=="string"||row.instructions.length>16000||row.instructions.includes("\0")))fail("invalid admitted run instructions");
    if (!["queued", "running", "waiting_permission", "interrupted", "done", "error", "cancelled"].includes(String(row.status)) || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0) fail("invalid durable run");
    if (row.worker_id) { const worker = get("worker", row.worker_id); if (!worker.local && worker.ownerId !== row.owner_id) fail("cross-owner run worker"); }
  }
  for (const row of db.query("SELECT * FROM approvals").iterate() as Iterable<Row>) {
    const item = parse(row.body), action = object(item.action), parent = run(row.run_id, row.owner_id);
    if (item.id !== row.id || item.ownerId !== row.owner_id || item.status !== row.status || action.runId !== row.run_id || action.threadId !== parent.thread_id || action.principalId !== row.owner_id) fail("invalid approval authority binding");
    get("mower", action.mowerId, row.owner_id); get("profile", `${item.profileId}:${item.profileVersion}`, row.owner_id);
  }
  for (const row of db.query("SELECT thread_id,run_id,payload FROM events").iterate() as Iterable<Row>) { const thread = get("thread", row.thread_id); parse(row.payload); if (row.run_id) { const parent = run(row.run_id, thread.ownerId); if (parent.thread_id !== row.thread_id) fail("cross-thread event"); } }
  for (const row of db.query("SELECT * FROM worker_auth").iterate() as Iterable<Row>) { const worker = get("worker", row.id); if (worker.local || typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash)) fail("invalid worker credential hash"); }
  for (const row of db.query("SELECT * FROM checkpoints").iterate() as Iterable<Row>) { get("thread", row.thread_id); validateCheckpoint(String(row.body), String(row.thread_id)); }
  for (const row of db.query("SELECT * FROM routing").iterate() as Iterable<Row>) get("thread", row.thread_id, row.owner_id);
  for (const row of db.query("SELECT * FROM worker_sequences").iterate() as Iterable<Row>) run(row.run_id);
  if (has(db, "inference_calls")) for (const row of db.query("SELECT * FROM inference_calls").iterate() as Iterable<Row>) {
    const parent = run(row.run_id);
    if (!Number.isSafeInteger(row.generation) || Number(row.generation) < 0 || Number(row.generation) > Number(parent.generation) || typeof row.request_id !== "string" || !row.request_id ||
      typeof row.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.fingerprint) || !["admitted", "done", "interrupted"].includes(String(row.status)) || !date(row.created_at) || !date(row.updated_at)) fail("invalid inference admission");
  }
  for (const row of db.query("SELECT * FROM outbox").iterate() as Iterable<Row>) { const payload = parse(row.body); if (String(row.destination).startsWith("thread:")) get("thread", String(row.destination).slice(7), row.owner_id); if (!payload) fail("invalid outbox"); }
  if (has(db, "telegram_routes")) {
    for (const row of db.query("SELECT * FROM telegram_routes").iterate() as Iterable<Row>) get("thread", row.thread_id, row.owner_id);
    for (const row of db.query("SELECT * FROM telegram_subscriptions").iterate() as Iterable<Row>) { const route = db.query("SELECT owner_id FROM telegram_routes WHERE route_key=?").get(String(row.route_key)) as { owner_id: string } | null; if (!route) fail("missing Telegram route"); get("thread", row.thread_id, route.owner_id); }
    if (db.query("SELECT d.id FROM telegram_deliveries d LEFT JOIN outbox o ON o.id=d.id WHERE o.id IS NULL LIMIT 1").get()) fail("orphan Telegram delivery");
  }
  if (has(db, "permission_advisers")) {
    for (const row of db.query("SELECT * FROM permission_advisers").iterate() as Iterable<Row>) { get("mower", row.mower_id, row.owner_id); get("thread", row.thread_id, row.owner_id); get("profile", `${row.profile_id}:${row.profile_version}`, row.owner_id); }
    for (const row of db.query("SELECT * FROM permission_advice").iterate() as Iterable<Row>) { const parent = run(row.run_id, row.owner_id); if (parent.thread_id !== row.thread_id) fail("cross-thread advice"); if (!db.query("SELECT 1 FROM approvals WHERE id=? AND owner_id=?").get(String(row.approval_id), String(row.owner_id))) fail("missing advice approval"); parse(row.base_profile); parse(row.body); }
  }
}
function inspect(db: Database): void { schema(db); validateReferences(db); }
function prepareDestination(destination: string): { target: string; staging: string } {
  const target = resolve(destination); directory(dirname(target)); if (existsSync(target)) fail("destination already exists; nothing was overwritten");
  const staging = join(dirname(target), `.${target.split("/").at(-1)}.laun-${randomUUID()}`); mkdirSync(staging, { mode: 0o700 }); return { target, staging };
}
function publish(staging: string, target: string): void {
  // mkdir is exclusive, unlike rename-over-empty-directory. Never overwrite
  // an operator's existing target, even if another process created it late.
  mkdirSync(target, { mode: 0o700 });
  try { for (const name of readdirSync(staging)) renameSync(join(staging, name), join(target, name)); syncDir(target); syncDir(dirname(target)); }
  catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
  rmSync(staging, { recursive: true });
}

/** Offline backup of v2 metadata and server checkpoint archives only. */
export async function createControlBackup(options: ControlBackupOptions): Promise<ControlBackupManifest> {
  assertOffline(options.confirmOffline); const source = directory(options.dataDir); regular(join(source, "control.sqlite"));
  const { target, staging } = prepareDestination(options.destination);
  try {
    const db = new Database(join(source, "control.sqlite"), { readonly: true, strict: true });
    try { schema(db); db.query("VACUUM INTO ?").run(join(staging, "control.sqlite")); } finally { db.close(); }
    const fd = openSync(join(staging, "control.sqlite"), constants.O_RDONLY | constants.O_NOFOLLOW); try { fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
    const snapshot = new Database(join(staging, "control.sqlite"), { readonly: true, strict: true }); try { inspect(snapshot); } finally { snapshot.close(); }
    if (existsSync(join(source, "keys.json"))) { readKeys(join(source, "keys.json")); transfer(join(source, "keys.json"), join(staging, "keys.json")); readKeys(join(staging, "keys.json")); } else writePrivate(join(staging, "keys.json"), []);
    const manifest: ControlBackupManifest = { version: 1, scope: "laun-v2-control", createdAt: new Date().toISOString(), schemaVersion: "1",
      files: (["control.sqlite", "keys.json"] as const).map(path => ({ path, ...transfer(join(staging, path)) })) };
    writePrivate(join(staging, "manifest.json"), manifest); syncDir(staging); publish(staging, target); return manifest;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
function readManifest(backup: string): ControlBackupManifest {
  const path = join(backup, "manifest.json"); regular(path); if (lstatSync(path).size > 65536) fail("manifest too large");
  let value: Row; try { value = object(JSON.parse(readFileSync(path, "utf8"))); } catch { return fail("invalid manifest JSON"); }
  if (Object.keys(value).sort().join("|") !== "createdAt|files|schemaVersion|scope|version" || value.version !== 1 || value.scope !== "laun-v2-control" || value.schemaVersion !== "1" || !date(value.createdAt) || !Array.isArray(value.files) || value.files.length !== 2) fail("unsupported backup manifest");
  const names = new Set<string>(); for (const entry of value.files) { const file = object(entry); if (Object.keys(file).sort().join("|") !== "bytes|path|sha256" || typeof file.path !== "string" || !["control.sqlite", "keys.json"].includes(file.path) || names.has(file.path) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) fail("invalid backup file manifest"); names.add(file.path); }
  if (readdirSync(backup).sort().join("|") !== "control.sqlite|keys.json|manifest.json") fail("unexpected backup files; this is not a v2 control backup");
  return value as unknown as ControlBackupManifest;
}

/** Restore into a NEW directory; all recovered execution authority is inert. */
export async function restoreControlBackup(options: ControlRestoreOptions): Promise<ControlRestoreResult> {
  assertOffline(options.confirmOffline); const backup = directory(options.backupDir), manifest = readManifest(backup);
  const { target, staging } = prepareDestination(options.targetDir);
  try {
    for (const file of manifest.files) { const copied = transfer(join(backup, file.path), join(staging, file.path)); if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) fail(`checksum mismatch for ${file.path}`); }
    const keys = readKeys(join(staging, "keys.json")), at = new Date().toISOString();
    const safety: ControlRestoreResult["safety"] = { interruptedRuns: 0, interruptedInferenceCalls: 0, expiredApprovals: 0, revokedWorkers: 0, revokedHumanKeys: keys.filter(key => !key.revokedAt).length, stoppedThreads: 0, uncertainDeliveries: 0 };
    const principals = new Map<string, string[]>(); for (const key of keys) { const principalId = key.principalId ?? `key_${key.id}`; const list = principals.get(principalId) ?? []; list.push(key.id); principals.set(principalId, list); }
    const db = new Database(join(staging, "control.sqlite"), { strict: true });
    try {
      inspect(db); db.exec("PRAGMA synchronous=FULL");
      for (const row of db.query("SELECT DISTINCT owner_id FROM objects UNION SELECT DISTINCT owner_id FROM runs").iterate() as Iterable<{ owner_id: string }>) if (/^(?:user_[0-9a-f]{32}|key_[0-9a-f]{8,32})$/.test(row.owner_id) && !principals.has(row.owner_id)) principals.set(row.owner_id, []);
      db.transaction(() => {
        safety.interruptedRuns = db.query("UPDATE runs SET status='interrupted',cancel_requested=1,generation=generation+1,lease_until=NULL,updated_at=?,summary='Restored backup: reconcile the prior attempt before any resume' WHERE status IN ('queued','running','waiting_permission','interrupted')").run(at).changes;
        if (has(db, "inference_calls")) safety.interruptedInferenceCalls = db.query("UPDATE inference_calls SET status='interrupted',updated_at=? WHERE status='admitted'").run(at).changes;
        for (const row of db.query("SELECT * FROM objects WHERE kind IN ('thread','worker','task')").all() as Array<{ kind: string; id: string; body: string }>) { const item = parse(row.body);
          if (row.kind === "thread") { item.stoppedAt = at; safety.stoppedThreads++; }
          if (row.kind === "worker") { item.status = "revoked"; safety.revokedWorkers++; }
          if (row.kind === "task" && ["queued", "running"].includes(String(item.status))) { item.status = "cancelled"; item.updatedAt = at; }
          db.query("UPDATE objects SET body=? WHERE kind=? AND id=?").run(JSON.stringify(item), row.kind, row.id);
        }
        db.exec("DELETE FROM worker_auth");
        for (const row of db.query("SELECT id,body FROM approvals WHERE status IN('pending','approved')").all() as Array<{ id: string; body: string }>) { const item = parse(row.body); item.status = "expired"; item.expiresAt = at;
          db.query("UPDATE approvals SET status='expired',body=? WHERE id=?").run(JSON.stringify(item), row.id); safety.expiredApprovals++; }
        safety.uncertainDeliveries = db.query("UPDATE outbox SET status='uncertain' WHERE status IN('pending','sending') AND destination NOT LIKE 'thread:%'").run().changes;
        db.exec("UPDATE outbox SET status='cancelled' WHERE status IN('pending','sending') AND destination LIKE 'thread:%'");
        if (has(db, "telegram_links")) db.exec("DELETE FROM telegram_links; DELETE FROM telegram_link_codes; DELETE FROM telegram_handles; DELETE FROM telegram_subscriptions; DELETE FROM telegram_routes; UPDATE telegram_deliveries SET lease_id=NULL,lease_until=NULL");
        db.query("INSERT INTO metadata(key,value) VALUES('restored_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(at);
      }).immediate();
      inspect(db); db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    } finally { db.close(); }
    syncFile(join(staging, "control.sqlite"));
    // Copying has already verified the original hashes. The restored key file
    // intentionally differs: stale credentials never regain access by restore.
    rmSync(join(staging, "keys.json")); writePrivate(join(staging, "keys.json"), keys.map(key => ({ ...key, revokedAt: key.revokedAt ?? at })));
    const result: ControlRestoreResult = { targetDir: target, manifest, principals: [...principals].map(([principalId, keyIds]) => ({ principalId, keyIds })), safety };
    writePrivate(join(staging, "restore.json"), { restoredAt: at, ...result }); syncDir(staging); publish(staging, target); return result;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
