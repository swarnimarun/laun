import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat as inspect,
  open as openFile,
  readdir as entries,
  unlink as remove,
} from "node:fs/promises";
import { resolve, parse, sep } from "node:path";
import { JournalCompactor, type FinishAcknowledgement } from "./journal-retention.js";
import {
  isAgentEvent,
  type AgentEvent,
  type RuntimeResult,
} from "@laun/protocol";

export interface RunJournal {
  runId: string;
  threadId: string;
  generation: number;
  phase: "running" | "settled" | "interrupted" | "reported" | "fenced";
  nextSequence: number;
  events: Array<{ sequence: number; event: AgentEvent }>;
  outcome?: RuntimeResult;
  reason?: string;
  updatedAt: string;
  finishAcknowledged?: FinishAcknowledgement;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
function decode(raw: string, runId: string, generation: number): RunJournal {
  if (Buffer.byteLength(raw) > 8_388_608)
    throw new Error("worker journal exceeds 8 MiB; preserve for recovery");
  let value: RunJournal;
  try {
    value = JSON.parse(raw) as RunJournal;
  } catch {
    throw new Error("worker journal is corrupt; preserve for recovery");
  }
  if (
    !value ||
    typeof value !== "object" ||
    value.runId !== runId ||
    value.generation !== generation ||
    typeof value.threadId !== "string" ||
    !ID.test(value.threadId) ||
    !["running", "settled", "interrupted", "reported", "fenced"].includes(
      value.phase,
    ) ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence < 0 ||
    !Array.isArray(value.events) ||
    value.events.length > 1000 ||
    value.events.some(
      (e) =>
        !e ||
        !Number.isSafeInteger(e.sequence) ||
        e.sequence < 0 ||
        e.sequence >= value.nextSequence ||
        !isAgentEvent(e.event) ||
        e.event.sessionId !== value.threadId,
    )
  )
    throw new Error("invalid worker journal; preserve for recovery");
  if (
    value.outcome &&
    !["done", "error", "cancelled"].includes(value.outcome.status)
  )
    throw new Error("invalid worker journal outcome");
  return value;
}

/** Worker credentials are never written here. Events are persisted before dispatch. */
export class WorkerJournal {
  private compactor: JournalCompactor;
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.compactor = new JournalCompactor(directory, decode);
  }
  compactAcknowledged(runId: string, generation: number, signal?: AbortSignal) { return this.compactor.one(runId, generation, signal); }
  compactReportedBatch(options: { signal?: AbortSignal; beforeFinalInspect?: () => Promise<void> } = {}) { return this.compactor.batch(options); }
  closeMaintenance() { return this.compactor.close(); }
  private path(runId: string, generation: number): string {
    if (!ID.test(runId) || !Number.isSafeInteger(generation) || generation < 1)
      throw new Error("invalid journal run identity");
    return join(this.directory, `${runId}.${generation}.json`);
  }
  read(runId: string, generation: number): RunJournal | undefined {
    const path = this.path(runId, generation);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = fstatSync(descriptor),
        uid = process.getuid?.();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (uid !== undefined && info.uid !== uid) ||
        (info.mode & 0o077) !== 0 ||
        info.size > 8_388_608
      )
        throw new Error(
          "worker journal must be a bounded private owned regular file; preserve for inspection",
        );
      const chunks: Buffer[] = [];
      let length = 0;
      const buffer = Buffer.alloc(65536);
      for (;;) {
        const bytes = readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, 8_388_609 - length),
          null,
        );
        if (!bytes) break;
        length += bytes;
        if (length > 8_388_608)
          throw new Error(
            "worker journal exceeds 8 MiB; preserve for recovery",
          );
        chunks.push(Buffer.from(buffer.subarray(0, bytes)));
      }
      return decode(
        Buffer.concat(chunks, length).toString("utf8"),
        runId,
        generation,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  list(): RunJournal[] {
    const names = readdirSync(this.directory);
    if (names.length > 4096)
      throw new Error(
        "worker journal inventory exceeds its bounded recovery scan; preserve for inspection",
      );
    let bytes = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      bytes += lstatSync(join(this.directory, name)).size;
      if (bytes > 32 * 1024 * 1024)
        throw new Error(
          "worker journal recovery scan exceeds 32 MiB; preserve for inspection",
        );
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const match = name.match(/^([A-Za-z0-9_-]{1,64})\.(\d+)\.json$/);
        if (!match)
          throw new Error(
            "unexpected worker journal file; preserve for recovery",
          );
        return this.read(match[1]!, Number(match[2]))!;
      });
  }
  save(value: RunJournal): void {
    const path = this.path(value.runId, value.generation);
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 8_388_608 || value.events.length > 1000)
      throw new Error("worker event outbox limit reached");
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      // Acknowledged event intent survives process restart; directory sync also
      // protects the rename on supported Linux/WSL filesystems.
      const dir = openSync(this.directory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw error;
    }
  }
  /** Verified cleanup only; never infer ownership from a filename or raw text. */
  async pruneThread(
    threadId: string,
    options: {
      signal?: AbortSignal;
      activeRunIds?: ReadonlySet<string>;
      /** Trusted test scheduling seam; never job-supplied. */ beforeFinalInspect?: () => Promise<void>;
    } = {},
  ): Promise<{ removed: number; outstanding: string[] }> {
    if (!ID.test(threadId))
      throw new Error("invalid journal cleanup thread identity");
    const root = resolve(this.directory),
      uid = process.getuid?.(),
      outstanding: string[] = [];
    let removed = 0,
      bytes = 0;
    const result = () => ({
      removed,
      outstanding: [...new Set(outstanding)].slice(0, 100),
    });
    let current = parse(root).root;
    for (const part of root.slice(current.length).split(sep).filter(Boolean)) {
      options.signal?.throwIfAborted();
      current = join(current, part);
      const info = await inspect(current);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (uid !== undefined && info.uid !== 0 && info.uid !== uid) ||
        (current === root &&
          ((uid !== undefined && info.uid !== uid) ||
            (info.mode & 0o077) !== 0)) ||
        ((info.mode & 0o022) !== 0 &&
          !((info.mode & 0o1000) !== 0 && current !== root))
      ) {
        outstanding.push(
          "Worker journal directory ownership, privacy or real-path boundary could not be verified; files preserved.",
        );
        return result();
      }
    }
    const names = await entries(root);
    if (names.length > 4096) {
      outstanding.push(
        "Worker journal inventory exceeds the 4096-file cleanup bound; files preserved.",
      );
      return result();
    }
    for (const name of names.sort()) {
      options.signal?.throwIfAborted();
      const match = name.match(/^([A-Za-z0-9_-]{1,64})\.([1-9]\d*)\.json$/);
      if (!match || !Number.isSafeInteger(Number(match[2]))) {
        outstanding.push(
          "Unrecognized worker journal entries were preserved for operator inspection.",
        );
        continue;
      }
      const path = join(root, name);
      let handle: Awaited<ReturnType<typeof openFile>> | undefined;
      try {
        const before = await inspect(path);
        if (
          before.isSymbolicLink() ||
          !before.isFile() ||
          before.nlink !== 1 ||
          (uid !== undefined && before.uid !== uid) ||
          (before.mode & 0o077) !== 0 ||
          before.size > 8_388_608
        ) {
          outstanding.push(
            "Unsafe or oversized worker journal files were preserved.",
          );
          continue;
        }
        handle = await openFile(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const file = await handle.stat();
        if (
          !file.isFile() ||
          file.ino !== before.ino ||
          file.dev !== before.dev ||
          file.nlink !== 1 ||
          (uid !== undefined && file.uid !== uid) ||
          (file.mode & 0o077) !== 0 ||
          file.size > 8_388_608
        )
          throw new Error("journal changed before read");
        const chunks: Buffer[] = [];
        let length = 0;
        const buffer = Buffer.alloc(65536);
        for (;;) {
          options.signal?.throwIfAborted();
          const next = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, 8_388_609 - length),
            null,
          );
          if (!next.bytesRead) break;
          length += next.bytesRead;
          bytes += next.bytesRead;
          if (length > 8_388_608 || bytes > 32 * 1024 * 1024)
            throw new Error("journal cleanup read quota exceeded");
          chunks.push(Buffer.from(buffer.subarray(0, next.bytesRead)));
        }
        const value = decode(
          Buffer.concat(chunks, length).toString("utf8"),
          match[1]!,
          Number(match[2]),
        );
        if (value.threadId !== threadId) continue;
        if (
          value.phase === "running" ||
          options.activeRunIds?.has(value.runId)
        ) {
          outstanding.push(
            "A matching worker journal still has an active writer; it was preserved.",
          );
          continue;
        }
        options.signal?.throwIfAborted();
        await options.beforeFinalInspect?.();
        const latest = await inspect(path);
        if (
          latest.ino !== file.ino ||
          latest.dev !== file.dev ||
          latest.size !== file.size ||
          latest.mtimeMs !== file.mtimeMs ||
          latest.ctimeMs !== file.ctimeMs ||
          latest.nlink !== 1 ||
          (uid !== undefined && latest.uid !== uid) ||
          (latest.mode & 0o077) !== 0 ||
          latest.isSymbolicLink() ||
          !latest.isFile()
        )
          throw new Error("journal changed during cleanup");
        options.signal?.throwIfAborted();
        await remove(path);
        removed++;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        outstanding.push(
          "Unreadable, corrupt or changed worker journal files were preserved for review.",
        );
      } finally {
        await handle?.close();
      }
      if (bytes > 32 * 1024 * 1024) {
        outstanding.push(
          "Worker journal cleanup reached its 32 MiB read bound; remaining files were preserved.",
        );
        break;
      }
    }
    if (removed) {
      const directory = await openFile(
        root,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return result();
  }
}
