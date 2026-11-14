import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage, StorageWrite, Seq } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { InferenceJsonValue, RuntimeDurabilityAppend, RuntimeDurabilityClient, RuntimeDurabilityEnvelope } from "@laun/protocol";
import { captureWorkspace, materializeWorkspace, type WorkspaceManifest } from "./workspace.js";

export const DURABILITY_ADAPTER = "pi-durable@1.5.2";
export const MAX_DURABILITY_COMMIT_BYTES = 2 * 1024 * 1024;
export const MAX_DURABILITY_SNAPSHOT_BYTES = 48 * 1024 * 1024;
export const MAX_DURABILITY_LEDGER_BYTES = 128 * 1024 * 1024;
const MAX_RECORDS = 100_000, DEADLINE_MS = 60_000;
const FILE = /^(?:main|(?:doc|task)-(?:0|[1-9]\d*))\.jsonl$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (value: Record<string, unknown>, names: string[]) => {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) throw new Error("invalid durable envelope fields");
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** JSONL-compatible detachment with stable key order and no executable/binary coercion. */
function orderedJson(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 128) throw new Error("durable batch nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("durable batch contains non-JSON values");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) throw new Error("durable batch contains symbol fields");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error("durable batch contains a sparse or extended array");
      return value.map((item) => orderedJson(item, seen, depth + 1));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("durable batch contains a non-JSON object");
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(property, "value")) throw new Error("durable batch contains an accessor");
      // JSONL omits optional undefined object fields. Undefined array values,
      // binary buffers, dates, hooks and functions are rejected, not coerced.
      if (property.value === undefined) continue;
      Object.defineProperty(result, key, { value: orderedJson(property.value, seen, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { seen.delete(value); }
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 128) throw new Error("durable envelope nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (!object(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error("durable envelope must contain plain JSON");
  return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name], depth + 1)}`).join(",")}}`;
}
export function durabilityRequestId(expectedSequence: number, envelope: RuntimeDurabilityEnvelope): string {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) throw new Error("invalid durable ledger sequence");
  return sha(canonical({ expectedSequence, envelope }));
}
/** A failed/ambiguous server write permanently invalidates this runtime writer. */
export class DurableStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "DurableStorageError"; }
}
type CommitPayload = { kind: "commits"; batches: Array<{ seq: number; writes: StorageWrite[] }> };
type SnapshotPayload = { kind: "snapshot"; files: WorkspaceManifest["files"] };
function envelope(payload: SnapshotPayload | CommitPayload): RuntimeDurabilityEnvelope {
  // Match JSONL's serialization boundary: optional undefined SDK fields are
  // omitted, while stored values are detached from the publishing Session.
  const value = { adapter: DURABILITY_ADAPTER, version: 1 as const, payload: JSON.parse(JSON.stringify(payload)) as InferenceJsonValue };
  validateDurabilityEnvelope(value); return value;
}
/** SDK-specific records remain opaque outside this adapter. */
export function validateDurabilityEnvelope(value: unknown): SnapshotPayload | CommitPayload {
  if (!object(value)) throw new Error("invalid durable envelope");
  keys(value, ["adapter", "version", "payload"]);
  if (value.adapter !== DURABILITY_ADAPTER || value.version !== 1 || !object(value.payload)) throw new Error("unsupported durable adapter envelope");
  const payload = value.payload, serialized = canonical(value);
  if (payload.kind === "snapshot") {
    keys(payload, ["kind", "files"]);
    if (!Array.isArray(payload.files) || payload.files.length > 2048 || Buffer.byteLength(serialized) > MAX_DURABILITY_SNAPSHOT_BYTES) throw new Error("durable snapshot size limit exceeded");
    for (const file of payload.files) {
      if (!object(file)) throw new Error("invalid durable snapshot file");
      keys(file, ["path", "content", "sha256"]);
      if (typeof file.path !== "string" || !FILE.test(file.path) || typeof file.content !== "string" || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("invalid durable snapshot file");
    }
  } else if (payload.kind === "commits") {
    keys(payload, ["kind", "batches"]);
    if (!Array.isArray(payload.batches) || !payload.batches.length || payload.batches.length > 4096 || Buffer.byteLength(serialized) > MAX_DURABILITY_COMMIT_BYTES) throw new Error("durable commit size limit exceeded");
    for (const batch of payload.batches) {
      if (!object(batch)) throw new Error("invalid durable commit batch");
      keys(batch, ["seq", "writes"]);
      if (!Number.isSafeInteger(batch.seq) || Number(batch.seq) < 1 || !Array.isArray(batch.writes) || !batch.writes.length || batch.writes.length > 65_536 || batch.writes.some((write) => !object(write) || typeof write.type !== "string" || !["conversation", "entry", "task", "submission", "document.create", "document.copy", "document.change", "document.retire"].includes(write.type))) throw new Error("invalid durable commit writes");
    }
  } else throw new Error("unknown durable envelope kind");
  return payload as unknown as SnapshotPayload | CommitPayload;
}

/** Race even a faulty transport against abort/deadline; never retry an append. */
async function call<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("durable storage deadline exceeded")), DEADLINE_MS); timer.unref();
  try {
    controller.signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new DurableStorageError("durable storage cancelled or deadline exceeded"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => fn(controller.signal)).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", aborted));
      if (controller.signal.aborted) aborted();
    });
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
}
async function syncDirectory(path: string): Promise<void> { const fd = await open(path, "r"); try { await fd.sync(); } finally { await fd.close(); } }
async function snapshot(directory: string): Promise<SnapshotPayload> {
  if (!existsSync(directory)) return { kind: "snapshot", files: [] };
  const manifest = await captureWorkspace(directory);
  if (manifest.omittedPaths.length || manifest.files.some((file) => !FILE.test(file.path)) || (await readdir(directory, { withFileTypes: true })).some((entry) => !entry.isFile())) throw new Error("Pi storage snapshot contains unexpected files");
  return { kind: "snapshot", files: manifest.files };
}
async function restoreSnapshot(payload: SnapshotPayload, stage: string): Promise<void> {
  await materializeWorkspace({ version: 1, files: payload.files, omittedPaths: [] }, stage);
}
async function sameCache(first: string, second: string): Promise<boolean> {
  try {
    const identity = (value: SnapshotPayload) => canonical(value.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
    return identity(await snapshot(first)) === identity(await snapshot(second));
  } catch { return false; } // Unknown, torn or poisoned caches need preserved evidence.
}
export interface ServerBackedStorage { storage: Storage; uncertain(): boolean }

/**
 * Rebuild only from server-acknowledged state before Harness.open can schedule
 * tasks. Local JSONL remains a disposable cache; the old cache is preserved.
 */
export async function openServerBackedStorage(directory: string, client: RuntimeDurabilityClient, signal: AbortSignal): Promise<ServerBackedStorage> {
  const stage = `${directory}.rebuild-${randomUUID()}`;
  let replay: Awaited<ReturnType<typeof openNodeJsonlStorage>> | undefined, head: number | undefined, cursor = 0, bytes = 0;
  try {
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    for (;;) {
      const page = await call(signal, (abort) => client.load(cursor, abort));
      if (!object(page)) throw new Error("invalid durable ledger page");
      keys(page, ["records", "headSequence", "nextSequence", "hasMore"]);
      if (!Array.isArray(page.records) || page.records.length > 1024 || !Number.isSafeInteger(page.headSequence) || page.headSequence < cursor || page.headSequence > MAX_RECORDS || !Number.isSafeInteger(page.nextSequence) || typeof page.hasMore !== "boolean" || (head !== undefined && head !== page.headSequence)) throw new Error("inconsistent durable ledger head");
      head = page.headSequence;
      for (const record of page.records) {
        if (!object(record)) throw new Error("invalid durable ledger record");
        keys(record, ["sequence", "requestId", "envelope"]);
        if (record.sequence !== cursor + 1 || record.sequence > head || record.requestId !== durabilityRequestId(cursor, record.envelope)) throw new Error("durable ledger sequence or request identity mismatch");
        const payload = validateDurabilityEnvelope(record.envelope);
        bytes += Buffer.byteLength(canonical(record.envelope)); if (bytes > MAX_DURABILITY_LEDGER_BYTES) throw new Error("durable ledger replay size limit exceeded");
        if (cursor === 0) {
          if (payload.kind !== "snapshot") throw new Error("durable ledger must begin with a snapshot");
          await restoreSnapshot(payload, stage);
          replay = await openNodeJsonlStorage(stage, BACKGROUND_CONTEXT, { fsync: true });
        } else {
          if (payload.kind !== "commits" || !replay) throw new Error("durable snapshot may occur only once");
          const received: number[] = [];
          const result = await replay.commit(payload.batches.map((batch) => batch.writes), (index, seq) => { received[index] = seq; }, BACKGROUND_CONTEXT);
          if (result.stored !== payload.batches.length || payload.batches.some((batch, index) => received[index] !== batch.seq)) throw new Error("durable SDK commit replay mismatch");
        }
        cursor++;
      }
      if (page.nextSequence !== cursor || page.hasMore !== (cursor < head) || (page.hasMore && !page.records.length)) throw new Error("invalid durable ledger pagination");
      if (!page.hasMore) break;
    }
    if (!head) {
      // Upgrade a previously server-checkpointed thread without running it.
      // No provider configuration or arbitrary directories enter this seed.
      const initial = await snapshot(directory); await restoreSnapshot(initial, stage);
      replay = await openNodeJsonlStorage(stage, BACKGROUND_CONTEXT, { fsync: true });
      await replay.close(BACKGROUND_CONTEXT); replay = undefined;
      const seed = envelope(await snapshot(stage));
      const request: RuntimeDurabilityAppend = { expectedSequence: 0, requestId: durabilityRequestId(0, seed), envelope: seed };
      const accepted = await call(signal, (abort) => client.append(request, abort));
      if (!object(accepted) || Object.keys(accepted).length !== 1 || accepted.sequence !== 1) throw new Error("durable seed acknowledgment mismatch");
      head = 1;
    }
    await replay?.close(BACKGROUND_CONTEXT); replay = undefined;
    let reuse = false;
    if (existsSync(directory)) {
      const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid local Pi storage directory");
      reuse = await sameCache(directory, stage);
      if (!reuse) {
        // Preserve genuinely divergent evidence outside session/work. An
        // identical already-ACKed cache needs no duplicate on every reopen.
        const recovery = join(dirname(dirname(directory)), "runtime-recovery");
        await mkdir(recovery, { recursive: true, mode: 0o700 });
        await rename(directory, join(recovery, `pi-${randomUUID()}`)); await syncDirectory(recovery);
      }
    }
    if (!reuse) { await rename(stage, directory); await syncDirectory(dirname(directory)); }
    const local = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, { fsync: true });
    return acknowledgedStorage(local, client, head, signal);
  } catch (cause) {
    throw new DurableStorageError("server-owned thread storage could not be confirmed; reconcile before retry", { cause });
  } finally { await replay?.close(BACKGROUND_CONTEXT).catch(() => {}); await rm(stage, { recursive: true, force: true }); }
}

function acknowledgedStorage(local: Storage, client: RuntimeDurabilityClient, initialHead: number, signal: AbortSignal): ServerBackedStorage {
  let head = initialHead, poisoned: DurableStorageError | undefined, queue = Promise.resolve(), closed = false, closing = false;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(poisoned ?? new Error("durable storage is closing"));
    const next = queue.then(() => { if (poisoned) throw poisoned; if (closed) throw new Error("durable storage is closed"); return fn(); });
    queue = next.then(() => {}, () => {}); return next;
  };
  const commit: Storage["commit"] = (batches, receive, context) => enqueue(async () => {
    try {
      const normalized = orderedJson(batches) as StorageWrite[][];
      const receipts: Array<{ index: number; seq: Seq }> = [];
      const result = await local.commit(normalized, (index, seq) => { receipts.push({ index, seq }); }, context);
      if (receipts.length !== result.stored || receipts.some((receipt, index) => receipt.index !== index)) throw new Error("invalid local durability receipts");
      if (receipts.length) {
        const value = envelope({ kind: "commits", batches: receipts.map(({ index, seq }) => ({ seq, writes: normalized[index]! })) });
        const request: RuntimeDurabilityAppend = { expectedSequence: head, requestId: durabilityRequestId(head, value), envelope: value };
        const accepted = await call(signal, (abort) => client.append(request, abort));
        if (!object(accepted) || Object.keys(accepted).length !== 1 || accepted.sequence !== head + 1) throw new Error("durable commit acknowledgment mismatch");
        head = accepted.sequence;
        // Withholding these receipts prevents Session publication, including
        // scheduling a model/tool or exposing its committed progress.
        for (const receipt of receipts) receive(receipt.index, receipt.seq);
      }
      return result;
    } catch (cause) { poisoned ??= new DurableStorageError("thread commit has no confirmed server acknowledgment; reconcile before retry", { cause }); throw poisoned; }
  });
  const storage = new Proxy(local, { get(target, name) {
    if (name === "commit") return commit;
    if (name === "close") return async (context: Parameters<Storage["close"]>[0]) => { closing = true; await queue; if (!closed) { closed = true; await local.close(context); } if (poisoned) throw poisoned; };
    const value = Reflect.get(target, name, target);
    return typeof value === "function" ? (...args: unknown[]) => enqueue(() => Promise.resolve(Reflect.apply(value, target, args))) : value;
  } }) as Storage;
  return { storage, uncertain: () => !!poisoned };
}
