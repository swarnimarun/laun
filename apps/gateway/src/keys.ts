import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatAgentKey, parseAgentKey } from "@laun/protocol";

/**
 * A stored agent key. Only the sha256 of the secret half is kept — the
 * plaintext exists exactly twice: in the operator's .env and in whatever
 * client they pasted it into.
 */
export interface AgentKeyRecord {
  id: string;
  /** sha256 hex of the secret half. Never the secret. */
  hash: string;
  label: string;
  createdAt: string;
}

export type PublicAgentKeyRecord = Omit<AgentKeyRecord, "hash">;

function newKeyId(): string {
  return randomBytes(4).toString("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Tiny JSON-file agent-key index, same atomic-write pattern as SessionStore. */
export class AgentKeyStore {
  private keys = new Map<string, AgentKeyRecord>();
  private indexPath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.indexPath = join(dataDir, "keys.json");
    try {
      const arr = JSON.parse(readFileSync(this.indexPath, "utf8")) as AgentKeyRecord[];
      for (const k of arr) {
        if (k && typeof k.id === "string" && typeof k.hash === "string") this.keys.set(k.id, k);
      }
    } catch {
      // fresh start
    }
  }

  private persist(): void {
    const tmp = this.indexPath + ".tmp";
    writeFileSync(tmp, JSON.stringify([...this.keys.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  /** Mint a key. The plaintext is returned once and never stored. */
  add(label = "default"): { key: string; record: PublicAgentKeyRecord } {
    let id = newKeyId();
    while (this.keys.has(id)) id = newKeyId();
    const secret = newSecret();
    const record: AgentKeyRecord = {
      id,
      hash: hashSecret(secret),
      label: label.trim() || "default",
      createdAt: new Date().toISOString(),
    };
    this.keys.set(id, record);
    this.persist();
    return { key: formatAgentKey(id, secret), record: this.public(record) };
  }

  /**
   * Import a key minted before the gateway started (setup writes LAUN_KEY
   * into .env). Idempotent: the same key is a no-op, a regenerated key for the
   * same id replaces the stored hash. Throws on a malformed key (fail closed at
   * boot rather than starting with a silently unusable credential).
   */
  importKey(raw: string, label = "bootstrap"): PublicAgentKeyRecord {
    const parsed = parseAgentKey(raw);
    if (!parsed) throw new Error("LAUN_KEY is not a valid agent key (expected laun_<id>_<secret>)");
    const hash = hashSecret(parsed.secret);
    const existing = this.keys.get(parsed.id);
    if (existing && existing.hash === hash) return this.public(existing);
    const record: AgentKeyRecord = {
      id: parsed.id,
      hash,
      label: existing?.label ?? label,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.keys.set(record.id, record);
    this.persist();
    return this.public(record);
  }

  /**
   * Verify a presented key. Returns the record or null. Never throws for
   * malformed input. Comparison happens on hashes with timingSafeEqual.
   */
  verify(raw: string | null | undefined): PublicAgentKeyRecord | null {
    const parsed = parseAgentKey(raw);
    if (!parsed) return null;
    const record = this.keys.get(parsed.id);
    if (!record) return null;
    const got = Buffer.from(hashSecret(parsed.secret), "hex");
    const want = Buffer.from(record.hash, "hex");
    if (got.length !== want.length) return null;
    return timingSafeEqual(got, want) ? this.public(record) : null;
  }

  list(): PublicAgentKeyRecord[] {
    return [...this.keys.values()]
      .map((k) => this.public(k))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  revoke(id: string): boolean {
    const had = this.keys.delete(id);
    if (had) this.persist();
    return had;
  }

  private public(record: AgentKeyRecord): PublicAgentKeyRecord {
    const { hash: _hash, ...rest } = record;
    return rest;
  }
}
