import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  /** Retained tombstone prevents stale bootstrap credentials being reimported. */
  revokedAt?: string;
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

function validRecord(value: unknown): value is AgentKeyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => ["id", "hash", "label", "createdAt", "revokedAt"].includes(key)) &&
    typeof record.id === "string" && /^[0-9a-f]{8,32}$/.test(record.id) &&
    typeof record.hash === "string" && /^[0-9a-f]{64}$/.test(record.hash) &&
    typeof record.label === "string" && record.label.trim().length > 0 &&
    typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)) &&
    (record.revokedAt === undefined || (typeof record.revokedAt === "string" && Number.isFinite(Date.parse(record.revokedAt))));
}

/** Tiny JSON-file agent-key index, same atomic-write pattern as SessionStore. */
export class AgentKeyStore {
  private keys = new Map<string, AgentKeyRecord>();
  private indexPath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.indexPath = join(dataDir, "keys.json");
    let raw: string;
    try {
      raw = readFileSync(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("cannot read key store; refusing to reset credentials", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("invalid key store JSON; refusing to reset credentials", { cause: error });
    }
    // Preserve the legacy array format; revokedAt is an additive field.
    if (!Array.isArray(parsed) || !parsed.every(validRecord)) throw new Error("invalid key store records; refusing to reset credentials");
    for (const record of parsed) {
      if (this.keys.has(record.id)) throw new Error("duplicate key store identity; refusing to reset credentials");
      this.keys.set(record.id, record);
    }
  }

  private persist(next: Map<string, AgentKeyRecord>): void {
    const tmp = `${this.indexPath}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(tmp, JSON.stringify([...next.values()], null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.indexPath);
      // A failed disk write/rename must never change live authentication state.
      this.keys = next;
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* no temp file, or cleanup unavailable */ }
      throw error;
    }
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
    const next = new Map(this.keys);
    next.set(id, record);
    this.persist(next);
    return { key: formatAgentKey(id, secret), record: this.public(record) };
  }

  /**
   * Import a key minted before the gateway started (setup writes LAUN_KEY
   * into .env). Idempotent: the same key is a no-op, a regenerated key for the
   * same active id replaces the stored hash. A revoked id stays revoked even
   * if setup regenerates its secret: rotation must mint a new id. Throws on a
   * malformed key (fail closed at boot instead of silently unusable auth).
   */
  importKey(raw: string, label = "bootstrap"): PublicAgentKeyRecord {
    const parsed = parseAgentKey(raw);
    if (!parsed) throw new Error("LAUN_KEY is not a valid agent key (expected laun_<id>_<secret>)");
    const hash = hashSecret(parsed.secret);
    const existing = this.keys.get(parsed.id);
    if (existing?.revokedAt) return this.public(existing);
    if (existing && existing.hash === hash) return this.public(existing);
    const record: AgentKeyRecord = {
      id: parsed.id,
      hash,
      label: existing?.label ?? (label.trim() || "bootstrap"),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = new Map(this.keys);
    next.set(record.id, record);
    this.persist(next);
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
    if (!record || record.revokedAt) return null;
    const got = Buffer.from(hashSecret(parsed.secret), "hex");
    const want = Buffer.from(record.hash, "hex");
    if (got.length !== want.length) return null;
    return timingSafeEqual(got, want) ? this.public(record) : null;
  }

  list(): PublicAgentKeyRecord[] {
    return [...this.keys.values()]
      .filter((record) => !record.revokedAt)
      .map((k) => this.public(k))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  revoke(id: string): boolean {
    const existing = this.keys.get(id);
    if (!existing || existing.revokedAt) return false;
    const next = new Map(this.keys);
    next.set(id, { ...existing, revokedAt: new Date().toISOString() });
    this.persist(next);
    return true;
  }

  private public(record: AgentKeyRecord): PublicAgentKeyRecord {
    const { hash: _hash, ...rest } = record;
    return rest;
  }
}
