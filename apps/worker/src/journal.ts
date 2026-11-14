import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isAgentEvent, type AgentEvent, type RuntimeResult } from "@laun/protocol";

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
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Worker credentials are never written here. Events are persisted before dispatch. */
export class WorkerJournal {
  constructor(private directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private path(runId: string, generation: number): string {
    if (!ID.test(runId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid journal run identity");
    return join(this.directory, `${runId}.${generation}.json`);
  }
  read(runId: string, generation: number): RunJournal | undefined {
    const path = this.path(runId, generation);
    let raw: string;
    try { raw = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (Buffer.byteLength(raw) > 8_388_608) throw new Error("worker journal exceeds 8 MiB; preserve for recovery");
    let value: RunJournal;
    try { value = JSON.parse(raw) as RunJournal; } catch { throw new Error("worker journal is corrupt; preserve for recovery"); }
    if (value.runId !== runId || value.generation !== generation || !ID.test(value.threadId) ||
      !["running", "settled", "interrupted", "reported", "fenced"].includes(value.phase) ||
      !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0 || !Array.isArray(value.events) || value.events.length > 1000 ||
      value.events.some((e) => !Number.isSafeInteger(e.sequence) || e.sequence < 0 || e.sequence >= value.nextSequence || !isAgentEvent(e.event) || e.event.sessionId !== value.threadId)) throw new Error("invalid worker journal; preserve for recovery");
    if (value.outcome && !["done", "error", "cancelled"].includes(value.outcome.status)) throw new Error("invalid worker journal outcome");
    return value;
  }
  list(): RunJournal[] {
    return readdirSync(this.directory).filter((name) => name.endsWith(".json")).map((name) => {
      const match = name.match(/^([A-Za-z0-9_-]{1,64})\.(\d+)\.json$/);
      if (!match) throw new Error("unexpected worker journal file; preserve for recovery");
      return this.read(match[1]!, Number(match[2]))!;
    });
  }
  save(value: RunJournal): void {
    const path = this.path(value.runId, value.generation);
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 8_388_608 || value.events.length > 1000) throw new Error("worker event outbox limit reached");
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
      // Acknowledged event intent survives process restart; directory sync also
      // protects the rename on supported Linux/WSL filesystems.
      const dir = openSync(this.directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
  }
}
