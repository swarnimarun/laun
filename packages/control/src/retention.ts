import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { requireDiskReserve } from "@laun/storage";
import type { ControlPrincipal, HostCleanupPlan, ThreadPurgeInput, ThreadPurgeJob, ThreadPurgePreview, ThreadRecord } from "@laun/protocol";
import { canonical, ControlError, ControlStore, hash, id, now, record, text } from "./store.js";
import { hasRetentionTable as has, purgedOwner } from "./retention-guard.js";

type Row = Record<string, unknown>;
interface Selection {
  runIds: string[]; approvalIds: string[]; taskIds: string[]; adviceRunIds: string[];
  outboxIds: string[]; routeKeys: string[]; selectedRouteKeys: string[]; receiptRefs: Array<{ ownerId: string; keyHash: string }>; legacyIds: string[];
  familyRootId: string; tokens: number; cost: number;
}
interface JobBody { job: ThreadPurgeJob; selection: Selection; phase: number }
const MAX_METADATA = 100_000;
const LIVE = new Set(["queued", "running", "waiting_permission", "interrupted"]);
const RETAINED_WARNING = "Remove controller copy only. Parent conversations may retain quoted results. Original imports, exports, backups, Telegram messages and bridge inboxes are separate copies. Known worker caches and sandboxes remain until their explicit cleanup plans finish; unknown hosts may retain copies.";

export function initializeRetention(store: ControlStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS thread_purges(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(owner_id,request_hash));
    CREATE TABLE IF NOT EXISTS purged_resources(kind TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL,purge_id TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS purged_receipts(owner_id TEXT NOT NULL,key_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,purge_id TEXT NOT NULL,PRIMARY KEY(owner_id,key_hash));
    CREATE TABLE IF NOT EXISTS purged_legacy_sources(owner_id TEXT NOT NULL,source_hash TEXT NOT NULL,purge_id TEXT NOT NULL,PRIMARY KEY(owner_id,source_hash));
    CREATE TABLE IF NOT EXISTS family_usage_debits(root_thread_id TEXT NOT NULL,purged_thread_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,tokens INTEGER NOT NULL,cost TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_cleanup_plans(id TEXT PRIMARY KEY,purge_id TEXT NOT NULL,owner_id TEXT NOT NULL,worker_id TEXT NOT NULL,thread_id TEXT NOT NULL,body TEXT NOT NULL);
  `);
}
function json(value: unknown): Row { try { return record(JSON.parse(String(value))); } catch { throw new ControlError("invalid stored retention reference", 409); } }
function asString(value: unknown): string { return typeof value === "string" ? value : ""; }
const unique = (values: string[]) => [...new Set(values)].sort();
function usage(event: Row): { tokens: number; cost: number } {
  const value = event.event as Row | undefined;
  if (!value || value.type !== "usage") return { tokens: 0, cost: 0 };
  const tokens = Number(value.totalTokens ?? (Number(value.inputTokens ?? 0) + Number(value.outputTokens ?? 0)));
  const cost = Number(value.costUsd ?? 0);
  return { tokens: Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0, cost: Number.isFinite(cost) && cost > 0 ? cost : 0 };
}
/** Exact typed IDs only. Never search arbitrary text for thread IDs. */
function references(value: unknown, ids: Set<string>, depth = 0): boolean {
  if (depth > 32 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => references(item, ids, depth + 1));
  for (const [key, item] of Object.entries(value as Row)) {
    if (["id", "threadId", "parentThreadId", "sourceThreadId", "adviserThreadId", "runId", "adviserRunId", "approvalId", "taskId"].includes(key) && typeof item === "string" && ids.has(item)) return true;
    if(key==="sourceThreadIds"&&Array.isArray(item)&&item.some(value=>typeof value==="string"&&ids.has(value)))return true;
    if (references(item, ids, depth + 1)) return true;
  }
  return false;
}
function snapshot(store: ControlStore, principal: ControlPrincipal, threadId: string): { preview: ThreadPurgePreview; selection: Selection } {
  const thread = store.get<ThreadRecord>("thread", threadId, principal);
  const ownerId = thread.ownerId, blockers: string[] = [], warnings = [RETAINED_WARNING];
  const selection: Selection = { runIds: [], approvalIds: [], taskIds: [], adviceRunIds: [], outboxIds: [], routeKeys: [], selectedRouteKeys: [], receiptRefs: [], legacyIds: [], familyRootId: thread.id, tokens: 0, cost: 0 };
  const counts: Record<string, number> = {}, digest = createHash("sha256"); let bytes = 0;
  const include = (table: string, row: Row) => { counts[table] = (counts[table] ?? 0) + 1; const raw = canonical(row); bytes += Buffer.byteLength(raw); digest.update(table).update("\0").update(raw).update("\n"); };
  digest.update("laun-controller-purge-v1\n"); include("objects", thread as unknown as Row);
  if (!thread.archivedAt || !thread.stoppedAt) blockers.push("Archive and stop this thread before removing its controller copy.");
  const allThreads = store.list<ThreadRecord>("thread", { id: ownerId, admin: false });
  if (allThreads.some(item => item.parentThreadId === thread.id)) blockers.push("Only leaf threads can be removed; remove settled descendants first.");
  let parent = thread;
  const ancestors = new Set<string>([thread.id]);
  while (parent.parentThreadId) { if (ancestors.has(parent.parentThreadId)) throw new ControlError("invalid thread ancestry", 409); parent = store.get<ThreadRecord>("thread", parent.parentThreadId); ancestors.add(parent.id); }
  selection.familyRootId = parent.id;
  const workerMap = new Map<string, { workerId: string; placementIds: string[]; unknownPlacements: boolean }>();
  const worker = (workerId: string, placementId?: string) => { if (!workerId) return; let entry = workerMap.get(workerId); if (!entry) { entry = { workerId, placementIds: [], unknownPlacements: false }; workerMap.set(workerId, entry); } if (placementId) entry.placementIds.push(placementId); else entry.unknownPlacements = true; };
  if (thread.workerId) worker(thread.workerId, thread.placementId);
  for (const row of store.db.query("SELECT * FROM runs WHERE thread_id=? ORDER BY id").iterate(thread.id) as Iterable<Row>) {
    include("runs", row); selection.runIds.push(asString(row.id)); if (LIVE.has(asString(row.status))) blockers.push("Queued, active or interrupted work must be settled before removal.");
    if (row.lease_until && Date.parse(String(row.lease_until)) > Date.now()) blockers.push("A worker lease is still active; wait for it to expire after stopping the worker.");
    if (row.worker_id) worker(asString(row.worker_id));
  }
  const runIds = new Set(selection.runIds);
  for (const row of store.db.query("SELECT * FROM approvals WHERE owner_id=? ORDER BY id").iterate(ownerId) as Iterable<Row>) if (runIds.has(asString(row.run_id))) { include("approvals", row); selection.approvalIds.push(asString(row.id)); }
  const approvalIds = new Set(selection.approvalIds);
  for (const row of store.db.query("SELECT * FROM events WHERE thread_id=? ORDER BY sequence").iterate(thread.id) as Iterable<Row>) {
    include("events", row); const event = json(row.payload), debit = usage(event); selection.tokens += debit.tokens; selection.cost += debit.cost;
    if (typeof event.workerId === "string") worker(event.workerId, typeof event.placementId === "string" ? event.placementId : undefined);
    if (typeof event.previousWorkerId === "string") worker(event.previousWorkerId);
  }
  if (!Number.isSafeInteger(selection.tokens) || !Number.isFinite(selection.cost)) blockers.push("Usage accounting exceeds supported numeric bounds; reconcile it before removal.");
  for (const table of ["worker_sequences", "inference_calls"]) if (has(store.db, table)) for (const row of store.db.query(`SELECT * FROM ${table} ORDER BY run_id,generation`).iterate() as Iterable<Row>) if (runIds.has(asString(row.run_id))) {
    include(table, row); if (table === "inference_calls" && row.status === "admitted") blockers.push("An inference admission has an unknown outcome; reconcile it before removal.");
  }
  for (const table of ["checkpoints", "durable_commits", "routing"]) if (has(store.db, table)) for (const row of store.db.query(`SELECT * FROM ${table} WHERE thread_id=? ORDER BY rowid`).iterate(thread.id) as Iterable<Row>) include(table, row);
  for (const row of store.db.query("SELECT * FROM objects WHERE kind='task' AND owner_id=? ORDER BY id").iterate(ownerId) as Iterable<Row>) {
    const task = json(row.body); if (task.threadId !== thread.id && task.parentThreadId !== thread.id) continue; include("tasks", row); selection.taskIds.push(asString(row.id));
    if (!["done", "error", "cancelled"].includes(asString(task.status))) blockers.push("Delegations referring to this thread must be settled before removal.");
  }
  if (has(store.db, "permission_advisers")) for (const row of store.db.query("SELECT * FROM permission_advisers WHERE thread_id=?").iterate(thread.id) as Iterable<Row>) { include("permission_advisers", row); blockers.push("The managed Gatekeeper thread cannot be removed; stop it to pause advice."); }
  if (has(store.db, "permission_advice")) for (const row of store.db.query("SELECT * FROM permission_advice WHERE owner_id=? ORDER BY run_id").iterate(ownerId) as Iterable<Row>) if (approvalIds.has(asString(row.approval_id)) || row.thread_id === thread.id) {
    include("permission_advice", row); selection.adviceRunIds.push(asString(row.run_id));
    const adviceRun = store.db.query("SELECT status FROM runs WHERE id=?").get(asString(row.run_id)) as { status: string } | null;
    if (adviceRun && LIVE.has(adviceRun.status)) blockers.push("Gatekeeper is still discussing this thread; settle that discussion first.");
    warnings.push("The Gatekeeper conversation may retain quoted context. Its structured proposal and lookup for this source will be removed.");
  }
  if (has(store.db, "legacy_imports")) for (const row of store.db.query("SELECT * FROM legacy_imports WHERE thread_id=? ORDER BY id").iterate(thread.id) as Iterable<Row>) { include("legacy_imports", row); selection.legacyIds.push(asString(row.id)); }
  if (counts.checkpoints || counts.durable_commits || counts.legacy_imports) worker("local");
  if (has(store.db, "owner_onboarding")) for (const row of store.db.query("SELECT * FROM owner_onboarding WHERE owner_id=?").iterate(ownerId) as Iterable<Row>) { if (json(row.body).primaryThreadId === thread.id) include("owner_onboarding", row); }
  const routes = new Set<string>();
  if (has(store.db, "telegram_routes")) {
    for (const row of store.db.query("SELECT * FROM telegram_routes WHERE owner_id=? ORDER BY route_key").iterate(ownerId) as Iterable<Row>) if (row.thread_id === thread.id) { routes.add(asString(row.route_key));selection.selectedRouteKeys.push(asString(row.route_key));include("telegram_routes", row); }
    for (const row of store.db.query("SELECT * FROM telegram_subscriptions WHERE thread_id=? ORDER BY route_key").iterate(thread.id) as Iterable<Row>) { routes.add(asString(row.route_key)); include("telegram_subscriptions", row); }
    for (const row of store.db.query("SELECT * FROM telegram_subscriptions WHERE thread_id!=? ORDER BY route_key,thread_id").iterate(thread.id) as Iterable<Row>) if(selection.selectedRouteKeys.includes(asString(row.route_key)))include("telegram_subscriptions",row);
    for (const row of store.db.query("SELECT * FROM telegram_handles WHERE owner_id=? ORDER BY handle").iterate(ownerId) as Iterable<Row>) if (approvalIds.has(asString(row.approval_id)) || selection.selectedRouteKeys.includes(asString(row.route_key))) include("telegram_handles", row);
    if(selection.selectedRouteKeys.length)warnings.push("Telegram routes currently selected to this removed thread will be unselected, including their subscription lists and expired approval buttons. Shared routes selected to a surviving thread keep their other subscriptions and buttons.");
  }
  selection.routeKeys = [...routes].sort();
  const ids = new Set([thread.id, ...selection.runIds, ...selection.approvalIds, ...selection.taskIds, ...selection.adviceRunIds, ...selection.legacyIds]);
  const legacyRoutes = new Set<string>();
  const legacyDetails=new Map<string,ThreadPurgePreview["legacyTelegramRouteDetails"][number]>();
  const untyped=(payload:Row)=>typeof payload.sourceThreadId!=="string"&&!(Array.isArray(payload.sourceThreadIds)&&payload.sourceThreadIds.every(value=>typeof value==="string"))&&payload.sourceVersion!==1;
  for(const row of store.db.query("SELECT destination,body FROM outbox WHERE owner_id=? ORDER BY id").iterate(ownerId) as Iterable<Row>){const payload=json(row.body),route=asString(payload.routeKey)||asString(row.destination).slice(9);if(asString(row.destination).startsWith("telegram:")&&untyped(payload)){legacyRoutes.add(route);let detail=legacyDetails.get(route);if(!detail){detail={routeKey:route,deliveries:0};for(const field of["botId","chatId","topicId"] as const)if(typeof payload[field]==="string"&&/^-?\d{1,20}$/.test(payload[field] as string))detail[field]=payload[field] as string;legacyDetails.set(route,detail);}detail.deliveries++;}}
  if(legacyRoutes.size)warnings.push("Older owner-scoped Telegram delivery history has no source-thread metadata, including routes no longer selected or linked. It cannot be attributed reliably. The separate broader consent removes ALL listed untyped history, including unrelated settled delivery history. New typed output from surviving threads is preserved.");
  for (const row of store.db.query("SELECT * FROM outbox WHERE owner_id=? ORDER BY id").iterate(ownerId) as Iterable<Row>) {
    const payload = json(row.body), route = asString(payload.routeKey), related = row.destination === `thread:${thread.id}` || references(payload, ids) || selection.taskIds.some(taskId => row.id === `task-result:${taskId}`);
    const routeAffected = routes.has(route);
    const ambiguous=asString(row.destination).startsWith("telegram:")&&untyped(payload);
    if (!related && !routeAffected&&!ambiguous) continue;
    const selected=related||ambiguous;
    include(selected?"outbox":"route_delivery_checks", row); if(selected)selection.outboxIds.push(asString(row.id));
    if (["pending", "sending", "uncertain"].includes(asString(row.status))) blockers.push("Related connector deliveries must be delivered, failed or explicitly cancelled after reconciliation.");
    if (has(store.db, "telegram_deliveries")) { const delivery = store.db.query("SELECT * FROM telegram_deliveries WHERE id=?").get(asString(row.id)) as Row | null; if (delivery) { include("telegram_deliveries", delivery); if (delivery.lease_until && Date.parse(String(delivery.lease_until)) > Date.now()) blockers.push("A Telegram send lease is still active."); } }
  }
  // Installation-administrator requests can create owner objects while their
  // replay receipt belongs to the administrator. Include those typed results.
  for (const row of store.db.query("SELECT * FROM receipts ORDER BY owner_id,key").iterate() as Iterable<Row>) if (references(json(row.body), ids) || [...selection.approvalIds].some(approvalId => asString(row.key).startsWith(`advice:${approvalId}:`))) { include("receipts", row); selection.receiptRefs.push({ ownerId: asString(row.owner_id), keyHash: hash(asString(row.key)) }); }
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) > MAX_METADATA) blockers.push("This thread exceeds the supported bounded removal plan. Keep its controller copy until a larger offline maintenance plan is implemented.");
  const workers = [...workerMap.values()].map(item => ({ ...item, placementIds: unique(item.placementIds) })).sort((a, b) => a.workerId.localeCompare(b.workerId));
  const preview: ThreadPurgePreview = { version: 1, threadId: thread.id, ownerId, digest: "", eligible: blockers.length === 0, blockers: unique(blockers), warnings: unique(warnings), counts, bytes, familyRootId: selection.familyRootId, tokens: selection.tokens, cost: selection.cost, workers, legacyTelegramRoutes: [...legacyRoutes].sort(),legacyTelegramRouteDetails:[...legacyDetails.values()].sort((a,b)=>a.routeKey.localeCompare(b.routeKey)) };
  digest.update(canonical({ blockers: preview.blockers, workers, legacyTelegramRoutes: preview.legacyTelegramRoutes, familyRootId: selection.familyRootId, tokens: selection.tokens, cost: selection.cost })); preview.digest = digest.digest("hex");
  return { preview, selection };
}
export function previewThreadPurge(store: ControlStore, principal: ControlPrincipal, threadId: string): ThreadPurgePreview {
  initializeRetention(store); return store.transaction(() => snapshot(store, principal, threadId).preview);
}
function readJob(store: ControlStore, p: ControlPrincipal, purgeId: string): JobBody {
  const row = store.db.query("SELECT owner_id,body FROM thread_purges WHERE id=?").get(purgeId) as { owner_id: string; body: string } | null;
  if (!row || (!p.admin && row.owner_id !== p.id)) throw new ControlError("purge not found", 404);
  return JSON.parse(row.body) as JobBody;
}
function saveJob(store: ControlStore, body: JobBody): void { body.job.updatedAt = now(); store.db.query("UPDATE thread_purges SET body=? WHERE id=?").run(JSON.stringify(body), body.job.id); }
function reserve(store: ControlStore): void { if (store.path !== ":memory:") requireDiskReserve(dirname(store.path), 192 * 1024 * 1024); }
export function beginThreadPurge(store: ControlStore, principal: ControlPrincipal, threadId: string, input: ThreadPurgeInput): ThreadPurgeJob {
  initializeRetention(store); const b = record(input), requestHash = hash(text(b.requestId, "requestId", 128));
  if (b.confirmedStopped !== true || b.confirmedControllerCopyOnly !== true) throw new ControlError("Explicitly confirm stopped execution and removal of the controller copy only");
  if (typeof b.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(b.expectedDigest)) throw new ControlError("review the current removal preview first");
  return store.transaction(() => {
    const previous = store.db.query("SELECT thread_id,body FROM thread_purges WHERE owner_id=? AND request_hash=?").get(principal.id, requestHash) as { thread_id: string; body: string } | null;
    if (previous) { if (previous.thread_id !== threadId) throw new ControlError("purge requestId conflict", 409); return (JSON.parse(previous.body) as JobBody).job; }
    reserve(store);
    const { preview, selection } = snapshot(store, principal, threadId);
    if (preview.ownerId !== principal.id) throw new ControlError("use a credential for this owner to confirm removal", 403);
    if (preview.digest !== b.expectedDigest) throw new ControlError("removal preview changed; review it again", 409);
    if (!preview.eligible) throw new ControlError(preview.blockers.join(" "), 409);
    if (preview.legacyTelegramRoutes.length && b.confirmedLegacyTelegramRouteCleanup !== true) throw new ControlError("Older Telegram output lacks source metadata; explicitly confirm broader removal of all listed untyped route delivery history, including unrelated settled history", 409);
    const at = now(), purgeId = id(), job: ThreadPurgeJob = { id: purgeId, ownerId: preview.ownerId, threadId, status: "removing", createdAt: at, updatedAt: at, removed: {}, pendingHostCopies: preview.workers.length, reclamation: "pending" };
    const body: JobBody = { job, selection, phase: 0 };
    store.db.query("INSERT INTO thread_purges VALUES(?,?,?,?,?)").run(purgeId, job.ownerId, threadId, requestHash, JSON.stringify(body));
    const gone = (kind: string, resourceId: string) => store.db.query("INSERT INTO purged_resources VALUES(?,?,?,?)").run(kind, resourceId, job.ownerId, purgeId);
    gone("thread", threadId); for (const resourceId of selection.runIds) gone("run", resourceId); for (const resourceId of selection.approvalIds) gone("approval", resourceId); for (const resourceId of selection.taskIds) gone("task", resourceId); for (const resourceId of selection.adviceRunIds) gone("advice", resourceId); for (const resourceId of selection.legacyIds) gone("legacy", resourceId);
    const receiptHashes = new Set(selection.receiptRefs.map(ref => `${ref.ownerId}:${ref.keyHash}`));
    for (const row of store.db.query("SELECT owner_id,key,fingerprint FROM receipts").iterate() as Iterable<{ owner_id: string; key: string; fingerprint: string }>) if (receiptHashes.has(`${row.owner_id}:${hash(row.key)}`)) store.db.query("INSERT INTO purged_receipts VALUES(?,?,?,?)").run(row.owner_id, hash(row.key), row.fingerprint, purgeId);
    if (has(store.db, "legacy_imports")) for (const row of store.db.query("SELECT source_hash FROM legacy_imports WHERE thread_id=?").iterate(threadId) as Iterable<{ source_hash: string }>) store.db.query("INSERT INTO purged_legacy_sources VALUES(?,?,?)").run(job.ownerId, row.source_hash, purgeId);
    store.db.query("INSERT INTO family_usage_debits VALUES(?,?,?,?,?)").run(selection.familyRootId, threadId, job.ownerId, selection.tokens, String(selection.cost));
    for (const placement of preview.workers) { const plan: HostCleanupPlan = { id: id(), purgeId, ownerId: job.ownerId, threadId, ...placement, status: "pending", createdAt: at, updatedAt: at }; store.db.query("INSERT INTO host_cleanup_plans VALUES(?,?,?,?,?,?)").run(plan.id, purgeId, job.ownerId, plan.workerId, threadId, JSON.stringify(plan)); }
    // Revoke producer references in the same commit as the tombstone. No task or
    // connector can regenerate a delivery after the deletion fence is visible.
    if (has(store.db, "telegram_routes")) {
      for (const route of selection.selectedRouteKeys) { store.db.query("DELETE FROM telegram_handles WHERE route_key=?").run(route); store.db.query("DELETE FROM telegram_subscriptions WHERE route_key=?").run(route); store.db.query("DELETE FROM telegram_routes WHERE route_key=?").run(route); }
      store.db.query("DELETE FROM telegram_subscriptions WHERE thread_id=?").run(threadId);
      for (const approval of selection.approvalIds) store.db.query("DELETE FROM telegram_handles WHERE approval_id=?").run(approval);
    }
    for (const taskId of selection.taskIds) store.db.query("DELETE FROM objects WHERE kind='task' AND id=?").run(taskId);
    if (has(store.db, "permission_advice")) for (const runId of selection.adviceRunIds) store.db.query("DELETE FROM permission_advice WHERE run_id=?").run(runId);
    if (has(store.db, "owner_onboarding")) { const row = store.db.query("SELECT body FROM owner_onboarding WHERE owner_id=?").get(job.ownerId) as { body: string } | null; if (row && json(row.body).primaryThreadId === threadId) store.db.query("DELETE FROM owner_onboarding WHERE owner_id=?").run(job.ownerId); }
    return job;
  });
}

export function inspectThreadPurge(store: ControlStore, principal: ControlPrincipal, purgeId: string): ThreadPurgeJob {
  initializeRetention(store); const value = readJob(store, principal, purgeId).job;
  value.pendingHostCopies = (store.db.query("SELECT COUNT(*) n FROM host_cleanup_plans WHERE purge_id=? AND json_extract(body,'$.status')!='done'").get(purgeId) as { n: number }).n;
  return value;
}
export function listThreadPurges(store:ControlStore,principal:ControlPrincipal):ThreadPurgeJob[]{
  initializeRetention(store);const rows=(principal.admin?store.db.query("SELECT id FROM thread_purges ORDER BY rowid DESC LIMIT 100").all():store.db.query("SELECT id FROM thread_purges WHERE owner_id=? ORDER BY rowid DESC LIMIT 100").all(principal.id)) as Array<{id:string}>;
  return rows.map(row=>inspectThreadPurge(store,principal,row.id));
}
export function listHostCleanupPlans(store: ControlStore, principal: ControlPrincipal, purgeId?: string): HostCleanupPlan[] {
  initializeRetention(store);
  return (store.db.query("SELECT owner_id,purge_id,body FROM host_cleanup_plans ORDER BY rowid").all() as Array<{ owner_id: string; purge_id: string; body: string }>).filter(row => (principal.admin || row.owner_id === principal.id) && (!purgeId || row.purge_id === purgeId)).map(row => JSON.parse(row.body) as HostCleanupPlan);
}

/** One bounded transaction per call. Failure leaves the fence and prior batches intact. */
export function continueThreadPurge(store: ControlStore, principal: ControlPrincipal, purgeId: string, options: { maxRows?: number } = {}): ThreadPurgeJob {
  initializeRetention(store); const maxRows = options.maxRows ?? 64;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 256) throw new ControlError("purge batch must contain 1 to 256 rows");
  if (readJob(store, principal, purgeId).job.status === "done") return inspectThreadPurge(store, principal, purgeId);
  reserve(store);
  const result = store.transaction(() => {
    const body = readJob(store, principal, purgeId), { job, selection } = body;
    if (job.status === "done") return job;
    const remove = (table: string, where: string, args: string[], maxBytes = 56 * 1024 * 1024): boolean => {
      if (!has(store.db, table)) return true;
      const rows = store.db.query(`SELECT rowid AS _retention_rowid,* FROM ${table} WHERE ${where} ORDER BY rowid LIMIT ?`).iterate(...args, maxRows) as Iterable<Row>;
      let used = 0, removed = 0;
      for (const row of rows) { const size = Buffer.byteLength(canonical(row)); if (removed && used + size > maxBytes) break; used += size; store.db.query(`DELETE FROM ${table} WHERE rowid=?`).run(Number(row._retention_rowid)); removed++; }
      job.removed[table] = (job.removed[table] ?? 0) + removed;
      return !store.db.query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...args);
    };
    // Largest rows are limited independently (48 MiB snapshot / 64 MiB checkpoint).
    const phases: Array<() => boolean> = [
      () => remove("events", "thread_id=?", [job.threadId]),
      () => remove("durable_commits", "thread_id=?", [job.threadId]),
      () => remove("checkpoints", "thread_id=?", [job.threadId]),
      () => remove("legacy_imports", "thread_id=?", [job.threadId]),
      () => remove("worker_sequences", "run_id IN(SELECT id FROM purged_resources WHERE kind='run' AND purge_id=?)", [job.id]),
      () => remove("inference_calls", "run_id IN(SELECT id FROM purged_resources WHERE kind='run' AND purge_id=?)", [job.id]),
      () => remove("approvals", "id IN(SELECT id FROM purged_resources WHERE kind='approval' AND purge_id=?)", [job.id]),
      () => { const refs = new Set(selection.receiptRefs.map(ref => `${ref.ownerId}:${ref.keyHash}`)); let removed = 0; for (const row of store.db.query("SELECT rowid,owner_id,key FROM receipts ORDER BY rowid").iterate() as Iterable<{ rowid: number; owner_id: string; key: string }>) { if (!refs.has(`${row.owner_id}:${hash(row.key)}`)) continue; store.db.query("DELETE FROM receipts WHERE rowid=?").run(row.rowid); removed++; if (removed >= maxRows) break; } job.removed.receipts = (job.removed.receipts ?? 0) + removed; return removed < maxRows; },
      () => { const ids = selection.outboxIds.slice(0, maxRows); for (const outboxId of ids) { if (has(store.db, "telegram_deliveries")) store.db.query("DELETE FROM telegram_deliveries WHERE id=?").run(outboxId); store.db.query("DELETE FROM outbox WHERE id=?").run(outboxId); } selection.outboxIds.splice(0, ids.length); job.removed.outbox = (job.removed.outbox ?? 0) + ids.length; return selection.outboxIds.length === 0; },
      () => remove("routing", "thread_id=?", [job.threadId]),
      () => remove("runs", "thread_id=?", [job.threadId]),
      () => { const count = store.db.query("DELETE FROM objects WHERE kind='thread' AND id=?").run(job.threadId).changes; job.removed.threads = Number(count); return true; },
    ];
    if (phases[body.phase]!()) body.phase++;
    if (body.phase >= phases.length) job.status = "done";
    saveJob(store, body); return job;
  });
  // Reclamation is maintenance after the logical transaction. A busy checkpoint
  // never changes an acknowledged logical deletion into a failed deletion.
  if (result.status === "done") try {
    const checkpoint = store.db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy?: number; log?: number; checkpointed?: number } | null;
    const vacuum = store.db.query("PRAGMA auto_vacuum").get() as Record<string, number> | null;
    if (vacuum && Object.values(vacuum)[0] === 2) store.db.exec("PRAGMA incremental_vacuum(128)");
    if (!checkpoint?.busy && Number(checkpoint?.log ?? 0) <= Number(checkpoint?.checkpointed ?? 0)) { const body = readJob(store, principal, purgeId); body.job.reclamation = "reusable"; saveJob(store, body); }
  } catch { /* Committed logical removal stands. The operator can compact later. */ }
  return inspectThreadPurge(store, principal, purgeId);
}
