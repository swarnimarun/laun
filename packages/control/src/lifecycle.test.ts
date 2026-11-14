import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRule, ThreadRecord, WorkerRecord } from "@laun/protocol";
import { captureCheckpoint, checkpointReference } from "@laun/storage";
import { ensureAdviser } from "./adviser.js";
import { effectiveThreadWorkerId, moveThreadWorker, rebaseThreadProfile } from "./lifecycle.js";
import { ControlService } from "./service.js";
import { ControlStore } from "./store.js";

const p = { id: `user_${"a".repeat(32)}`, admin: false }, other = { id: `user_${"b".repeat(32)}`, admin: false };
const stores: ControlStore[] = [], dirs: string[] = [], services: ControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "laun-lifecycle-")); dirs.push(dir); const store = new ControlStore(join(dir, "control.sqlite")); stores.push(store);
  const worker = (name: string) => { const item = store.registerWorker(p, { name }).worker; item.checkpointVersion = "pi-durable@1.5.2"; store.put("worker", item); store.heartbeat(item.id); return store.get<WorkerRecord>("worker", item.id); };
  const a = worker("Yard A"), b = worker("Yard B");
  const rules: CapabilityRule[] = [{ operation: "workspace.read", resource: "workspace:own", effect: "allow" }, { operation: "workspace.write", resource: "workspace:own", effect: "allow" }, { operation: "process.execute", resource: "workspace:own", effect: "allow" }];
  const broad = store.createProfile(p, { name: "Director", mode: "manual", rules });
  const narrow = store.createProfile(p, { name: "Crew", mode: "manual", rules: rules.map(rule => rule.operation === "process.execute" ? { ...rule, effect: "ask" } : rule) });
  const director = store.createMower(p, { name: "Director", role: "director", profileId: broad.id, profileVersion: 1, workerId: a.id });
  const mower = store.createMower(p, { name: "Fern", profileId: narrow.id, profileVersion: 1, workerId: a.id });
  const root = store.createThread(p, { mowerId: director.id, title: "Root" });
  const thread = store.createThread(p, { mowerId: mower.id, title: "Child", parentThreadId: root.id });
  const grandchild = store.createThread(p, { mowerId: mower.id, title: "Grandchild", parentThreadId: thread.id });
  const sibling = store.createThread(p, { mowerId: mower.id, title: "Sibling", parentThreadId: root.id });
  const rebase = (target: ThreadRecord, profileId: string, profileVersion: number) => rebaseThreadProfile(store, p, target.id, { profileId, profileVersion, expectedProfileId: target.profileId, expectedProfileVersion: target.profileVersion, confirmedStopped: true });
  return { store, dir, a, b, broad, narrow, root, thread, grandchild, sibling, mower, rules, rebase };
}
async function checkpoint(f: ReturnType<typeof setup>, omissions = false) {
  const root = join(f.dir, "archive"); mkdirSync(join(root, "session"), { recursive: true }); mkdirSync(join(root, "work"), { recursive: true }); writeFileSync(join(root, "session", "state.jsonl"), '{"type":"session"}\n');
  if (omissions) { mkdirSync(join(root, "work", "node_modules"), { recursive: true }); writeFileSync(join(root, "work", "node_modules", "generated"), "rebuild me"); }
  const raw = await captureCheckpoint(f.thread.id, root); f.store.db.query("INSERT INTO checkpoints VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at").run(f.thread.id, raw, new Date().toISOString()); return checkpointReference(raw, f.thread.id);
}
function history(f: ReturnType<typeof setup>) { const run = f.store.submit(p, f.thread.id, { text: "completed work", requestId: "history" }); const job = f.store.claim(f.a)!; expect(job.run.id).toBe(run.id); f.store.finish(run.id, f.a.id, job.run.generation, "done"); return run; }

describe("reviewed thread profile assignments", () => {
  test("rebase is explicit, scoped, immutable and stops affected descendants", () => {
    const f = setup(); const next = f.store.createProfile(p, { mode: "manual", rules: f.rules }, f.narrow);
    const result = f.rebase(f.thread, next.id, next.version);
    expect(result.thread.profileVersion).toBe(2); expect(result.thread.stoppedAt).toBeString();
    expect(f.store.get<ThreadRecord>("thread", f.grandchild.id).stoppedAt).toBeString();
    expect(f.store.get<ThreadRecord>("thread", f.sibling.id).stoppedAt).toBeUndefined();
    expect(f.store.get<ThreadRecord>("thread", f.root.id).profileVersion).toBe(1);
    expect(f.store.profile(f.narrow.id, 1).rules).toEqual(f.narrow.rules); expect(f.store.get("mower", f.mower.id)).toMatchObject({ profileVersion: 1 });
    expect(f.store.runs(p)).toHaveLength(0); expect(result.event.payload.profileVersion).toBe(2);
    expect(() => f.rebase(f.thread, next.id, next.version)).toThrow("profile changed");
  });
  test("ancestor and descendant attenuation are revalidated, with no partial writes", () => {
    const f = setup(); const outOfScope = f.store.createProfile(p, { name: "Outside", mode: "manual", rules: [...f.rules, { operation: "network.connect", resource: "https://example.com", effect: "allow" }] });
    expect(() => f.rebase(f.thread, outOfScope.id, 1)).toThrow("ancestor");
    const deny = f.store.createProfile(p, { name: "Deny process", mode: "manual", rules: f.narrow.rules.map(rule => rule.operation === "process.execute" ? { ...rule, effect: "deny" } : rule) });
    expect(() => f.rebase(f.thread, deny.id, 1)).toThrow("descendant");
    expect(f.store.get<ThreadRecord>("thread", f.thread.id).profileId).toBe(f.narrow.id);
    f.rebase(f.grandchild, deny.id, 1); const result = f.rebase(f.thread, deny.id, 1); expect(result.thread.profileId).toBe(deny.id);
  });
  test("whole family must be idle, including siblings and interrupted attempts", () => {
    const f = setup(); const queued = f.store.submit(p, f.sibling.id, { text: "sibling work", requestId: "busy" });
    for (const status of ["queued", "running", "waiting_permission", "interrupted"] as const) { f.store.setRunStatus(queued.id, status); expect(() => f.rebase(f.thread, f.narrow.id, 1)).toThrow("family"); }
    expect(f.store.get<ThreadRecord>("thread", f.thread.id).stoppedAt).toBeUndefined();
  });
  test("foreign/revoked profiles, unconfirmed changes and Gatekeeper authority changes fail", () => {
    const f = setup(); const foreign = f.store.createProfile(other, { name: "Other", mode: "manual", rules: [] });
    expect(() => rebaseThreadProfile(f.store, { id: "service", admin: true }, f.thread.id, { profileId: foreign.id, profileVersion: 1, expectedProfileId: f.narrow.id, expectedProfileVersion: 1, confirmedStopped: true })).toThrow("not found");
    const revoked = f.store.createProfile(p, { name: "Revoked", mode: "manual", rules: [] }); revoked.revokedAt = new Date().toISOString(); f.store.db.query("UPDATE objects SET body=? WHERE kind='profile' AND id=?").run(JSON.stringify(revoked), `${revoked.id}:1`);
    expect(() => f.rebase(f.thread, revoked.id, 1)).toThrow("revoked");
    expect(() => rebaseThreadProfile(f.store, p, f.thread.id, {})).toThrow("confirm");
    const service = new ControlService({ store: f.store, dataDir: f.dir, mode: "unconfigured" }); services.push(service); const gatekeeper = ensureAdviser(service, p, "fixture/model");
    expect(() => f.rebase(gatekeeper.thread, f.narrow.id, 1)).toThrow("Gatekeeper");
  });
});

describe("checkpoint compatible explicit worker moves", () => {
  test("first claim pins legacy historical placement for clients without replaying or following changed defaults", () => {
    const f = setup(); history(f); const legacy = f.store.get<ThreadRecord>("thread", f.thread.id); delete legacy.workerId; f.store.put("thread", legacy);
    f.mower.workerId = f.b.id; f.store.put("mower", f.mower); f.store.submit(p, legacy.id, { text: "reviewed follow-up", requestId: "legacy" });
    expect(f.store.claim(f.b)).toBeNull(); const job = f.store.claim(f.a)!;
    expect(job.thread.workerId).toBe(f.a.id); expect(f.store.get<ThreadRecord>("thread", legacy.id).workerId).toBe(f.a.id);
    expect(f.store.runs(p)).toHaveLength(2);
  });
  test("new threads snapshot placement; explicit move wins over mower and historical host without queuing work", async () => {
    const f = setup(); expect(f.thread.workerId).toBe(f.a.id); f.mower.workerId = f.b.id; f.store.put("mower", f.mower);
    expect(effectiveThreadWorkerId(f.store, f.thread)).toBe(f.a.id);
    history(f); const archive = await checkpoint(f);
    const result = moveThreadWorker(f.store, p, f.thread.id, { workerId: f.b.id, expectedWorkerId: f.a.id, confirmedStopped: true, checkpointSha256: archive.sha256 });
    expect(result.thread.workerId).toBe(f.b.id); expect(result.thread.placementId).toMatch(/^[0-9a-f-]{36}$/); expect(result.thread.stoppedAt).toBeString(); expect(result.checkpoint?.sha256).toBe(archive.sha256);
    expect(f.store.runs(p)).toHaveLength(1); expect(f.store.claim(f.b)).toBeNull();
    const back = moveThreadWorker(f.store, p, f.thread.id, { workerId: f.a.id, expectedWorkerId: f.b.id, confirmedStopped: true, checkpointSha256: archive.sha256 });
    expect(back.thread.placementId).not.toBe(result.thread.placementId);
    const movedAgain = moveThreadWorker(f.store, p, f.thread.id, { workerId: f.b.id, expectedWorkerId: f.a.id, confirmedStopped: true, checkpointSha256: archive.sha256 });
    f.store.submit(p, f.thread.id, { text: "explicit new input", requestId: "continue" }); expect(f.store.claim(f.a)).toBeNull(); expect(f.store.claim(f.b)?.thread.placementId).toBe(movedAgain.thread.placementId);
  });
  test.each(["queued", "running", "waiting_permission", "interrupted"] as const)("%s work cannot move or lose its fence", status => {
    const f = setup(); const run = f.store.submit(p, f.thread.id, { text: "in flight", requestId: "busy" }); f.store.setRunStatus(run.id, status);
    expect(() => moveThreadWorker(f.store, p, f.thread.id, { workerId: f.b.id, expectedWorkerId: f.a.id, confirmedStopped: true })).toThrow("reconcile"); expect(f.store.get<ThreadRecord>("thread", f.thread.id).workerId).toBe(f.a.id);
  });
  test("history requires current checksum and exact advertised version, including acknowledged omissions", async () => {
    const f = setup(); history(f);
    const input = { workerId: f.b.id, expectedWorkerId: f.a.id, confirmedStopped: true };
    expect(() => moveThreadWorker(f.store, p, f.thread.id, input)).toThrow("checkpoint"); const archive = await checkpoint(f, true);
    expect(() => moveThreadWorker(f.store, p, f.thread.id, { ...input, checkpointSha256: "0".repeat(64) })).toThrow("SHA-256");
    const worker = f.store.get<WorkerRecord>("worker", f.b.id); delete worker.checkpointVersion; f.store.put("worker", worker);
    expect(() => moveThreadWorker(f.store, p, f.thread.id, { ...input, checkpointSha256: archive.sha256 })).toThrow("version");
    worker.checkpointVersion = "different-runtime"; f.store.put("worker", worker); expect(() => moveThreadWorker(f.store, p, f.thread.id, { ...input, checkpointSha256: archive.sha256 })).toThrow("version");
    worker.checkpointVersion = archive.runtimeVersion; f.store.put("worker", worker); expect(() => moveThreadWorker(f.store, p, f.thread.id, { ...input, checkpointSha256: archive.sha256 })).toThrow("confirmOmissions");
    expect(moveThreadWorker(f.store, p, f.thread.id, { ...input, checkpointSha256: archive.sha256, confirmedOmissions: true }).checkpoint?.omittedPaths).toEqual(["work/node_modules"]);
  });
  test("stale expected binding, foreign/offline/stale workers and unconfirmed requests fail closed", () => {
    const f = setup(); const input = { workerId: f.b.id, expectedWorkerId: f.a.id, confirmedStopped: true };
    expect(() => moveThreadWorker(f.store, p, f.thread.id, { ...input, expectedWorkerId: null })).toThrow("placement changed");
    const foreign = f.store.registerWorker(other, { name: "Other account" }).worker;
    expect(() => moveThreadWorker(f.store, { id: "service", admin: true }, f.thread.id, { ...input, workerId: foreign.id })).toThrow("not found");
    const worker = f.store.get<WorkerRecord>("worker", f.b.id); worker.lastSeenAt = "2000-01-01T00:00:00Z"; f.store.put("worker", worker);
    expect(() => moveThreadWorker(f.store, p, f.thread.id, input)).toThrow("heartbeat"); worker.lastSeenAt = new Date().toISOString(); worker.status = "revoked"; f.store.put("worker", worker);
    expect(() => moveThreadWorker(f.store, p, f.thread.id, input)).toThrow("heartbeat"); expect(() => moveThreadWorker(f.store, p, f.thread.id, { ...input, confirmedStopped: false })).toThrow("confirm");
  });
});
