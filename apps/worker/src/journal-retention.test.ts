import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerJournal, type RunJournal } from "./journal.js";
import { OutboundWorker } from "./worker.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync("/tmp/laun-journal-retention-"); directories.push(root); return root; }
function state(runId: string, extra: Partial<RunJournal> = {}): RunJournal {
  return { runId, threadId: "thread", generation: 1, phase: "reported", nextSequence: 0, events: [], updatedAt: new Date().toISOString(), outcome: { status: "done", summary: "ACKed fixture" }, ...extra };
}
function acknowledged(runId: string): RunJournal {
  const value = state(runId);
  value.finishAcknowledged = { version: 1, runId, threadId: value.threadId, generation: 1, workerId: "worker", nextSequence: 0, outcomeStatus: "done", serverStatus: "done", at: new Date().toISOString() };
  return value;
}
test("direct compaction requires the persisted exact finish ACK marker; supported legacy finish ACKs migrate separately", async () => {
  const root = fixture(), journals = new WorkerJournal(root);
  journals.save(state("legacy")); expect(await journals.compactAcknowledged("legacy", 1)).toBe(false);
  journals.save(acknowledged("new")); expect(await journals.compactAcknowledged("new", 1)).toBe(true);
  const cancelled = acknowledged("server-cancelled"); cancelled.finishAcknowledged!.serverStatus = "cancelled"; journals.save(cancelled);
  expect(await journals.compactAcknowledged("server-cancelled", 1)).toBe(true);
  expect(await journals.compactReportedBatch()).toEqual({ scanned: 1, removed: 1, complete: true }); expect(journals.list()).toEqual([]); await journals.closeMaintenance();
});
test("running, unreported, interrupted, fenced, uncertain and malformed-marker records are always preserved", async () => {
  const root = fixture(), journals = new WorkerJournal(root);
  for (const phase of ["running", "settled", "interrupted", "fenced"] as const) journals.save(state(phase, { phase }));
  journals.save(state("uncertain", { reason: "controller ACKed interruption, side effects remain unknown" }));
  journals.save(state("no-outcome", { outcome: undefined }));
  journals.save(state("pending-events", { nextSequence: 1, events: [{ sequence: 0, event: { type: "text", sessionId: "thread", delta: "not ACKed" } }] }));
  const invalid = acknowledged("invalid-marker"); invalid.finishAcknowledged!.runId = "different"; journals.save(invalid);
  expect((await journals.compactReportedBatch()).removed).toBe(0); expect(journals.list()).toHaveLength(8); await journals.closeMaintenance();
});
test("FIFO, symlink, hardlinked, public, malformed and oversized files remain untouched without blocking a bounded safe scan", async () => {
  const root = fixture(), journals = new WorkerJournal(root); journals.save(state("safe")); journals.save(state("public")); chmodSync(join(root, "public.1.json"), 0o644);
  journals.save(state("linked")); linkSync(join(root, "linked.1.json"), join(root, "linked-copy.1.json"));
  const outside = join(fixture(), "outside"); writeFileSync(outside, JSON.stringify(state("symlink"))); symlinkSync(outside, join(root, "symlink.1.json"));
  writeFileSync(join(root, "malformed.1.json"), "{", { mode: 0o600 }); writeFileSync(join(root, "oversize.1.json"), "x".repeat(8_388_609), { mode: 0o600 });
  const process = Bun.spawn(["mkfifo", join(root, "fifo.1.json")]); expect(await process.exited).toBe(0);
  const batch = await journals.compactReportedBatch(); expect(batch.complete).toBe(true); expect(batch.removed).toBe(1); expect(readdirSync(root)).toHaveLength(7); expect(existsSync(outside)).toBe(true); await journals.closeMaintenance();
});
test("cancellation or changed privacy at the final async check prevents unlink", async () => {
  for (const mode of ["abort", "chmod", "hardlink"]) {
    const root = fixture(), journals = new WorkerJournal(root); journals.save(acknowledged("kept")); const controller = new AbortController();
    const batch = journals.compactReportedBatch({ signal: controller.signal, beforeFinalInspect: async () => {
      if (mode === "abort") controller.abort();
      else if (mode === "chmod") chmodSync(join(root, "kept.1.json"), 0o644);
      else linkSync(join(root, "kept.1.json"), join(root, "other-link"));
    } });
    if (mode === "abort") await expect(batch).rejects.toThrow(); else expect((await batch).removed).toBe(0);
    expect(existsSync(join(root, "kept.1.json"))).toBe(true); await journals.closeMaintenance();
  }
});
test("bounded streaming startup migration progresses beyond legacy inventory cap before admitting new work", async () => {
  const root = fixture(), path = join(root, "journal"); mkdirSync(path, { mode: 0o700 });
  for (let i = 0; i < 4100; i++) writeFileSync(join(path, `old-${i}.1.json`), JSON.stringify(state(`old-${i}`)), { mode: 0o600 });
  writeFileSync(join(path, "unknown.1.json"), JSON.stringify(state("unknown", { reason: "unknown result must remain" })), { mode: 0o600 });
  expect(() => new WorkerJournal(path).list()).toThrow("inventory");
  let polls = 0, calls = 0;
  const worker = new OutboundWorker({ controllerUrl: "http://127.0.0.1:18881", workerKey: `yard_${crypto.randomUUID()}_${"a".repeat(30)}`, dataDir: root,
    runtime: { async run() { calls++; return { status: "done" }; }, cancel() {}, close() {} },
    fetch: (async () => { polls++; return Response.json({ job: null }); }) as unknown as typeof fetch });
  try {
    await worker.tick(); expect(polls).toBe(0); expect(readdirSync(path).length).toBeGreaterThan(3900);
    for (let tick = 0; tick < 40 && !polls; tick++) await worker.tick();
    expect(polls).toBe(1); expect(calls).toBe(0); expect(readdirSync(path)).toEqual(["unknown.1.json"]); expect(new WorkerJournal(path).list()[0]!.reason).toContain("unknown");
  } finally { await worker.close(); }
}, 30_000);
test("byte-bound maintenance defers the next large record instead of losing it at the cursor", async () => {
  const root = fixture(), journals = new WorkerJournal(root);
  for (let n = 0; n < 6; n++) journals.save(state(`large-${n}`, { outcome: { status: "done", summary: "x".repeat(2_000_000) } }));
  const first = await journals.compactReportedBatch(); expect(first.complete).toBe(false); expect(first.removed).toBe(4);
  const second = await journals.compactReportedBatch(); expect(second.complete).toBe(true); expect(second.removed).toBe(2); expect(journals.list()).toEqual([]); await journals.closeMaintenance();
});
