import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeCreateSession, type SessionRecord, type SessionStatus } from "@laun/protocol";

const STATUSES = new Set<SessionStatus>(["pending", "running", "waiting_approval", "done", "error"]);

/** Single-writer JSON index. Corruption must never silently erase durable threads. */
export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private indexPath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.indexPath = join(dataDir, "index.json");
    let raw: string;
    try {
      raw = readFileSync(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("cannot read session index; restore access before starting", { cause: error });
    }
    try {
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error("expected array");
      for (const value of arr) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
        const s = value as Record<string, unknown>;
        if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id) || this.sessions.has(s.id)) {
          throw new Error("invalid or duplicate session id");
        }
        if (!STATUSES.has(s.status as SessionStatus)) throw new Error("invalid status");
        if (typeof s.createdAt !== "string" || !Number.isFinite(Date.parse(s.createdAt)) ||
            typeof s.updatedAt !== "string" || !Number.isFinite(Date.parse(s.updatedAt))) throw new Error("invalid timestamp");
        // Legacy records without runtime are explicitly migrated to the original Pi runtime.
        const input = normalizeCreateSession(s);
        this.sessions.set(s.id, { ...input, id: s.id, status: s.status as SessionStatus,
          createdAt: s.createdAt, updatedAt: s.updatedAt });
      }
    } catch (error) {
      throw new Error("invalid session index; preserve it and restore from backup before starting", { cause: error });
    }
  }

  private persist(next: Map<string, SessionRecord>): void {
    const tmp = `${this.indexPath}.tmp-${randomUUID()}`;
    // One server owns the index. Atomic rename protects the previous snapshot;
    // syncing the file protects contents, but this is not a multi-writer database.
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify([...next.values()], null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.indexPath);
      this.sessions = next;
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* no temp file, or cleanup unavailable */ }
      throw error;
    }
  }

  create(input: { goal: string; repo?: string; model: string; runtime: SessionRecord["runtime"] }): SessionRecord {
    const norm = normalizeCreateSession(input);
    let id = randomUUID().slice(0, 8);
    while (this.sessions.has(id)) id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const rec: SessionRecord = { ...norm, id, status: "pending", createdAt: now, updatedAt: now };
    const next = new Map(this.sessions);
    next.set(id, rec);
    this.persist(next);
    return { ...rec };
  }

  get(id: string): SessionRecord | undefined {
    const rec = this.sessions.get(id);
    return rec ? { ...rec } : undefined;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  setStatus(id: string, status: SessionStatus): SessionRecord | undefined {
    if (!STATUSES.has(status)) throw new Error("invalid session status");
    const rec = this.sessions.get(id);
    if (!rec) return undefined;
    const updated = { ...rec, status, updatedAt: new Date().toISOString() };
    const next = new Map(this.sessions);
    next.set(id, updated);
    this.persist(next);
    return { ...updated };
  }

  /** Remove a session record entirely. Event files are the caller's job. */
  delete(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    const next = new Map(this.sessions);
    next.delete(id);
    this.persist(next);
    return true;
  }
}
