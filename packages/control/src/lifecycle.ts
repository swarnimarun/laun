import { canDelegateProfile } from "@laun/policy";
import { checkpointReference } from "@laun/storage";
import type { ControlPrincipal, MowerRecord, StoredProfile, ThreadLifecycleResult, ThreadProfileRebase, ThreadRecord, ThreadWorkerMove, WorkerRecord } from "@laun/protocol";
import { ControlError, ControlStore, id, now, record, text } from "./store.js";

const owner = (thread: ThreadRecord): ControlPrincipal => ({ id: thread.ownerId, admin: false });
function confirmed(input: Record<string, unknown>): void { if (input.confirmedStopped !== true) throw new ControlError("confirm the prior execution has stopped before changing this thread", 409); }
function subject(store: ControlStore, principal: ControlPrincipal, threadId: string): ThreadRecord {
  const thread = store.get<ThreadRecord>("thread", threadId, principal), mower = store.get<MowerRecord>("mower", thread.mowerId, owner(thread));
  if (thread.archivedAt || mower.archivedAt) throw new ControlError("thread or mower archived", 409);
  if (mower.role === "adviser") throw new ControlError("Gatekeeper keeps its dedicated isolated profile and placement", 409);
  return thread;
}
function assertIdle(store: ControlStore, threads: ThreadRecord[]): void {
  for (const thread of threads) if (store.db.query("SELECT id FROM runs WHERE thread_id=? AND status IN('queued','running','waiting_permission','interrupted') LIMIT 1").get(thread.id)) throw new ControlError("thread family must have no queued, active or interrupted attempts; stop and reconcile them first", 409);
}
function family(store: ControlStore, thread: ThreadRecord): { all: ThreadRecord[]; subtree: ThreadRecord[]; ancestors: ThreadRecord[] } {
  const p = owner(thread), ancestors: ThreadRecord[] = []; let root = thread;
  const seen = new Set([thread.id]);
  while (root.parentThreadId) { if (seen.has(root.parentThreadId) || seen.size >= 9) throw new ControlError("invalid thread ancestry", 409); seen.add(root.parentThreadId); root = store.get<ThreadRecord>("thread", root.parentThreadId, p); ancestors.push(root); }
  const owned = store.list<ThreadRecord>("thread", p), children = new Map<string, ThreadRecord[]>();
  for (const item of owned) if (item.parentThreadId) { const list = children.get(item.parentThreadId) ?? []; list.push(item); children.set(item.parentThreadId, list); }
  const collect = (start: ThreadRecord): ThreadRecord[] => { const result: ThreadRecord[] = [], visited = new Set<string>(), queue = [start];
    for (const item of queue) { if (visited.has(item.id)) throw new ControlError("invalid thread ancestry", 409); visited.add(item.id); result.push(item); queue.push(...children.get(item.id) ?? []); } return result; };
  return { all: collect(root), subtree: collect(thread), ancestors };
}
function profile(store: ControlStore, thread: ThreadRecord): StoredProfile { return store.profile(thread.profileId, thread.profileVersion, owner(thread)); }
function expireApprovals(store: ControlStore, thread: ThreadRecord): void {
  for (const row of store.db.query("SELECT id FROM runs WHERE thread_id=?").iterate(thread.id) as Iterable<{ id: string }>) store.expireRunApprovals(row.id);
}
/** Bind a reviewed immutable revision to an idle thread, preserving delegation ceilings. */
export function rebaseThreadProfile(store: ControlStore, principal: ControlPrincipal, threadId: string, input: ThreadProfileRebase | unknown): ThreadLifecycleResult {
  const b = record(input); confirmed(b);
  const profileId = text(b.profileId, "profileId", 100), version = Number(b.profileVersion);
  const expectedId = text(b.expectedProfileId, "expectedProfileId", 100), expectedVersion = Number(b.expectedProfileVersion);
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ControlError("invalid profile version");
  return store.transaction(() => {
    const thread = subject(store, principal, threadId), p = owner(thread);
    if (thread.profileId !== expectedId || thread.profileVersion !== expectedVersion) throw new ControlError("thread profile changed; reload before applying a revision", 409);
    const next = store.profile(profileId, version, p); if (next.revokedAt) throw new ControlError("target profile revoked", 409);
    const group = family(store, thread); assertIdle(store, group.all);
    let child = next;
    for (const ancestor of group.ancestors) { const ceiling = profile(store, ancestor);
      if (ancestor.archivedAt || ceiling.revokedAt || store.get<MowerRecord>("mower", ancestor.mowerId, p).archivedAt) throw new ControlError("ancestor is archived or its profile was revoked", 409);
      if (!canDelegateProfile(ceiling, child)) throw new ControlError("profile would exceed an ancestor's permission ceiling", 409); child = ceiling;
    }
    const candidates = new Map(group.subtree.map(item => [item.id, item.id === thread.id ? next : profile(store, item)]));
    const inactive = new Set<string>();
    for (const descendant of group.subtree.slice(1)) {
      const value = candidates.get(descendant.id)!;
      if (inactive.has(descendant.parentThreadId!) || descendant.archivedAt || value.revokedAt || store.get<MowerRecord>("mower", descendant.mowerId, p).archivedAt) { inactive.add(descendant.id); continue; }
      const ceiling = candidates.get(descendant.parentThreadId!)!;
      if (!canDelegateProfile(ceiling, value)) throw new ControlError("profile would leave a descendant above its permission ceiling; rebase that descendant first", 409);
    }
    const at = now();
    for (const item of group.subtree) { if (item.id === thread.id) { item.profileId = next.id; item.profileVersion = next.version; } item.stoppedAt = at; item.updatedAt = at; expireApprovals(store, item); store.put("thread", item); }
    const updated = store.get<ThreadRecord>("thread", thread.id, p);
    const event = store.event(thread.id, "system", { text: `Applied permission profile ${next.name} revision ${next.version}. This thread and its descendants remain stopped until direct user input.`, profileId: next.id, profileVersion: next.version, previousProfileId: expectedId, previousProfileVersion: expectedVersion, stoppedThreadIds: group.subtree.map(item => item.id) });
    return { thread: updated, event };
  });
}

export function effectiveThreadWorkerId(store: ControlStore, thread: ThreadRecord): string | null {
  if (thread.workerId) return thread.workerId;
  const previous = store.db.query("SELECT worker_id FROM runs WHERE thread_id=? AND worker_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(thread.id) as { worker_id: string } | null;
  return previous?.worker_id ?? store.get<MowerRecord>("mower", thread.mowerId, owner(thread)).workerId ?? null;
}

/** Change placement only after explicit reconciliation and checkpoint inspection. */
export function moveThreadWorker(store: ControlStore, principal: ControlPrincipal, threadId: string, input: ThreadWorkerMove | unknown): ThreadLifecycleResult {
  const b = record(input); confirmed(b); const workerId = text(b.workerId, "workerId", 100);
  if (b.expectedWorkerId !== null && (typeof b.expectedWorkerId !== "string" || !b.expectedWorkerId || b.expectedWorkerId.length > 100)) throw new ControlError("expectedWorkerId must be the reviewed current worker ID or null");
  return store.transaction(() => {
    const thread = subject(store, principal, threadId), p = owner(thread); assertIdle(store, [thread]);
    const previous = effectiveThreadWorkerId(store, thread);
    if (previous !== b.expectedWorkerId) throw new ControlError("thread placement changed; reload before moving it", 409);
    const worker = store.get<WorkerRecord>("worker", workerId);
    if (!worker.local && worker.ownerId !== thread.ownerId) throw new ControlError("worker not found", 404);
    const age = worker.lastSeenAt ? Date.now() - Date.parse(worker.lastSeenAt) : Infinity;
    if (worker.status !== "online" || !Number.isFinite(age) || age < -5000 || age > 60_000) throw new ControlError("target worker must be online with a recent authenticated heartbeat", 409);
    const hasHistory = !!store.db.query("SELECT id FROM runs WHERE thread_id=? AND generation>0 LIMIT 1").get(thread.id);
    let checkpoint: ThreadLifecycleResult["checkpoint"];
    if (hasHistory) {
      const raw = store.checkpoint(thread.id); if (!raw) throw new ControlError("a server checkpoint is required before moving a thread with execution history", 409);
      checkpoint = checkpointReference(raw, thread.id);
      if (b.checkpointSha256 !== checkpoint.sha256) throw new ControlError("checkpoint changed or was not reviewed; supply its current SHA-256", 409);
      if (!worker.checkpointVersion || worker.checkpointVersion !== checkpoint.runtimeVersion) throw new ControlError("target worker does not advertise the exact checkpoint runtime version", 409);
      if (checkpoint.omittedPaths?.length && b.confirmedOmissions !== true) throw new ControlError("checkpoint omits generated workspace paths; inspect omittedPaths and explicitly confirmOmissions", 409);
    }
    const at = now(); thread.workerId = worker.id; thread.placementId = id(); thread.stoppedAt = at; thread.updatedAt = at; expireApprovals(store, thread); store.put("thread", thread);
    const event = store.event(thread.id, "system", { text: `Moved placement to ${worker.name}. No prompt was replayed; direct user input is required to continue.`, previousWorkerId: previous, workerId: worker.id, placementId: thread.placementId, checkpointSha256: checkpoint?.sha256, omittedPaths: checkpoint?.omittedPaths ?? [] });
    return { thread, event, checkpoint };
  });
}
