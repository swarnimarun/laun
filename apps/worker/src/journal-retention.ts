import { constants, type Dir, type Stats } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RunJournal } from "./journal.js";

type Terminal = "done" | "error" | "cancelled";
export interface FinishAcknowledgement {
  version: 1; runId: string; threadId: string; generation: number; workerId: string;
  nextSequence: number; outcomeStatus: Terminal; serverStatus: Terminal; at: string;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/, terminal = (v: unknown): v is Terminal => ["done", "error", "cancelled"].includes(String(v));
const NAME = /^([A-Za-z0-9_-]{1,64})\.([1-9]\d*)\.json$/;
const MAX_FILE = 8_388_608, MAX_BYTES = 8_388_608, MAX_ENTRIES = 128;
const stable = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.uid === b.uid && a.nlink === b.nlink && a.mode === b.mode;
const privateFile = (v: Stats) => v.isFile() && !v.isSymbolicLink() && v.nlink === 1 && v.uid === process.getuid?.() && !(v.mode & 0o077) && v.size <= MAX_FILE;

/** Old supported writers persisted reported only after positive controller ACK.
 * A terminal outcome + empty outbox + ABSENT reason distinguishes finish ACK
 * from interrupted/lost/fenced paths. Unknown future fields stay preserved. */
function eligible(value: RunJournal, allowLegacy: boolean): boolean {
  const fields = new Set(["runId", "threadId", "generation", "phase", "nextSequence", "events", "outcome", "reason", "updatedAt", "finishAcknowledged"]);
  if (Object.keys(value).some(key => !fields.has(key)) || value.phase !== "reported" || value.reason !== undefined || value.events.length || !value.outcome || !terminal(value.outcome.status)
    || Object.keys(value.outcome).some(key => !["status", "summary"].includes(key)) || (value.outcome.summary !== undefined && typeof value.outcome.summary !== "string")
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  const marker = value.finishAcknowledged;
  if (!marker) return allowLegacy && !Object.hasOwn(value, "finishAcknowledged");
  return Object.keys(marker).length === 9 && Object.keys(marker).every(key => ["version", "runId", "threadId", "generation", "workerId", "nextSequence", "outcomeStatus", "serverStatus", "at"].includes(key))
    && marker.version === 1 && marker.runId === value.runId && marker.threadId === value.threadId && marker.generation === value.generation && ID.test(marker.workerId)
    && marker.nextSequence === value.nextSequence && marker.outcomeStatus === value.outcome.status && terminal(marker.serverStatus) && typeof marker.at === "string" && Number.isFinite(Date.parse(marker.at));
}

export interface JournalCompactionResult { scanned: number; removed: number; complete: boolean }
/** Supervisor-only retention; never selects files using a job-supplied path. */
export class JournalCompactor {
  private root: string;
  private identity?: Stats;
  private cursor?: Dir;
  private pendingName?: string;
  private batchTask?: Promise<JournalCompactionResult>;
  constructor(directory: string, private decode: (raw: string, runId: string, generation: number) => RunJournal) { this.root = resolve(directory); }
  private async boundary(): Promise<void> {
    let path = this.root;
    for (;;) {
      const info = await lstat(path), uid = process.getuid?.();
      if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022 && !(path !== this.root && info.uid === 0 && info.mode & 0o1000))) throw new Error("journal compaction boundary is unverified");
      if (path === this.root) {
        if (info.uid !== uid || (info.mode & 0o077) || (this.identity && (info.dev !== this.identity.dev || info.ino !== this.identity.ino))) throw new Error("journal compaction root is not the same private supervisor directory");
        this.identity ??= info;
      }
      const parent = dirname(path); if (parent === path) return; path = parent;
    }
  }
  private async remove(name: string, options: { signal?: AbortSignal; allowLegacy: boolean; remainingBytes: number; beforeFinalInspect?: () => Promise<void> }): Promise<{ removed: boolean; bytes: number; deferred?: true }> {
    options.signal?.throwIfAborted();
    const match = name.match(NAME); if (!match || !Number.isSafeInteger(Number(match[2]))) return { removed: false, bytes: 0 };
    let file: Awaited<ReturnType<typeof open>> | undefined; let bytes = 0;
    try {
      await this.boundary(); options.signal?.throwIfAborted();
      const path = join(this.root, name), before = await lstat(path);
      if (!privateFile(before)) return { removed: false, bytes: 0 };
      if (before.size > options.remainingBytes) return { removed: false, bytes: 0, deferred: true };
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const start = await file.stat(); if (!privateFile(start) || !stable(start, before)) return { removed: false, bytes: 0 };
      const chunks: Buffer[] = [], buffer = Buffer.alloc(65536);
      for (;;) {
        options.signal?.throwIfAborted();
        const next = await file.read(buffer, 0, Math.min(buffer.length, MAX_FILE + 1 - bytes, options.remainingBytes + 1 - bytes), null);
        if (!next.bytesRead) break;
        bytes += next.bytesRead; if (bytes > MAX_FILE || bytes > options.remainingBytes) return { removed: false, bytes };
        chunks.push(Buffer.from(buffer.subarray(0, next.bytesRead)));
      }
      const value = this.decode(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)), match[1]!, Number(match[2]));
      if (!eligible(value, options.allowLegacy)) return { removed: false, bytes };
      await options.beforeFinalInspect?.();
      await this.boundary();
      const latest = await lstat(path); if (!privateFile(latest) || !stable(latest, start)) return { removed: false, bytes };
      options.signal?.throwIfAborted(); await unlink(path);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      return { removed: true, bytes };
    } catch (error) { if (options.signal?.aborted) throw error; return { removed: false, bytes }; }
    finally { await file?.close(); }
  }
  async one(runId: string, generation: number, signal?: AbortSignal): Promise<boolean> {
    if (!ID.test(runId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid acknowledged journal identity");
    return (await this.remove(`${runId}.${generation}.json`, { signal, allowLegacy: false, remainingBytes: MAX_BYTES })).removed;
  }
  batch(options: { signal?: AbortSignal; beforeFinalInspect?: () => Promise<void> } = {}): Promise<JournalCompactionResult> {
    if (this.batchTask) return this.batchTask;
    const task = this.scan(options); this.batchTask = task;
    void task.finally(() => { if (this.batchTask === task) this.batchTask = undefined; }).catch(() => {});
    return task;
  }
  private async scan(options: { signal?: AbortSignal; beforeFinalInspect?: () => Promise<void> }): Promise<JournalCompactionResult> {
    let scanned = 0, removed = 0, bytes = 0;
    try {
      options.signal?.throwIfAborted(); await this.boundary(); options.signal?.throwIfAborted();
      this.cursor ??= await opendir(this.root, { bufferSize: 16 });
      while (scanned < MAX_ENTRIES && bytes < MAX_BYTES) {
        options.signal?.throwIfAborted();
        const name = this.pendingName ?? (await this.cursor.read())?.name; this.pendingName = undefined;
        options.signal?.throwIfAborted();
        if (!name) { await this.boundary(); await this.closeCursor(); return { scanned, removed, complete: true }; }
        scanned++;
        const result = await this.remove(name, { ...options, allowLegacy: true, remainingBytes: MAX_BYTES - bytes });
        if (result.deferred) { this.pendingName = name; await this.boundary(); return { scanned, removed, complete: false }; }
        bytes += result.bytes; if (result.removed) removed++;
      }
      await this.boundary(); return { scanned, removed, complete: false };
    } catch (error) { await this.closeCursor(); throw error; }
  }
  private async closeCursor() { const cursor = this.cursor; this.cursor = undefined; this.pendingName = undefined; await cursor?.close(); }
  async close(): Promise<void> { await this.batchTask?.catch(() => {}); await this.closeCursor(); }
}
