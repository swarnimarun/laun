import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionRecord, SessionStatus } from "@cloudbear/protocol";

/** Tiny JSON-file session index. Atomic writes (tmp + rename). */
export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private indexPath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.indexPath = join(dataDir, "index.json");
    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const arr = JSON.parse(raw) as SessionRecord[];
      for (const s of arr) this.sessions.set(s.id, s);
    } catch {
      // fresh start
    }
  }

  private persist(): void {
    const tmp = this.indexPath + ".tmp";
    writeFileSync(tmp, JSON.stringify([...this.sessions.values()], null, 2));
    renameSync(tmp, this.indexPath);
  }

  create(input: { goal: string; repo?: string; model: string; runtime: SessionRecord["runtime"] }): SessionRecord {
    let id = randomUUID().slice(0, 8);
    while (this.sessions.has(id)) id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id,
      goal: input.goal,
      repo: input.repo,
      model: input.model,
      runtime: input.runtime,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, rec);
    this.persist();
    return rec;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  setStatus(id: string, status: SessionStatus): SessionRecord | undefined {
    const rec = this.sessions.get(id);
    if (!rec) return undefined;
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    this.persist();
    return rec;
  }
}
