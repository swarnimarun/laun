import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentKey } from "@laun/protocol";
import { AgentKeyStore } from "./keys.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "laun-keys-"));
}

describe("AgentKeyStore", () => {
  test("mint -> verify round trip, wrong or unknown keys fail", () => {
    const s = new AgentKeyStore(tmpDataDir());
    const { key, record } = s.add("laptop");
    expect(record.label).toBe("laptop");
    expect(record.id).toMatch(/^[0-9a-f]{8}$/);
    const parts = parseAgentKey(key);
    expect(parts?.id).toBe(record.id);

    expect(s.verify(key)?.id).toBe(record.id);
    // wrong secret, same id
    expect(s.verify(`laun_${record.id}_${"A".repeat(43)}`)).toBeNull();
    // unknown id
    expect(s.verify(`laun_${"0".repeat(8)}_${parts!.secret}`)).toBeNull();
    // malformed / empty / null
    expect(s.verify("nope")).toBeNull();
    expect(s.verify("")).toBeNull();
    expect(s.verify(null)).toBeNull();
    expect(s.verify(undefined)).toBeNull();
  });

  test("never stores the plaintext secret", () => {
    const dir = tmpDataDir();
    const s = new AgentKeyStore(dir);
    const { key } = s.add();
    const secret = parseAgentKey(key)!.secret;

    const raw = readFileSync(join(dir, "keys.json"), "utf8");
    expect(raw).not.toContain(secret);
    expect(statSync(join(dir, "keys.json")).mode & 0o777).toBe(0o600);
    // list() must not leak the hash either
    expect(JSON.stringify(s.list())).not.toContain("hash");
  });

  test("survives a restart", () => {
    const dir = tmpDataDir();
    const { key, record } = new AgentKeyStore(dir).add("vps");
    const reloaded = new AgentKeyStore(dir);
    expect(reloaded.verify(key)?.id).toBe(record.id);
    expect(reloaded.list().map((k) => k.id)).toEqual([record.id]);
  });

  test("importKey is idempotent and rejects malformed keys", () => {
    const dir = tmpDataDir();
    const s = new AgentKeyStore(dir);
    const { key, record } = s.add("generated");
    // Re-importing the same key (as setup does on every boot) is a no-op...
    expect(s.importKey(key).id).toBe(record.id);
    expect(s.list()).toHaveLength(1);
    // ...and a regenerated key for the same id replaces the stored hash.
    const regenerated = `laun_${record.id}_${"B".repeat(43)}`;
    expect(s.importKey(regenerated).id).toBe(record.id);
    expect(s.list()).toHaveLength(1);
    expect(s.verify(regenerated)?.id).toBe(record.id);
    expect(s.verify(key)).toBeNull();

    expect(() => s.importKey("not-a-key")).toThrow("LAUN_KEY");
    expect(() => new AgentKeyStore(dir)).not.toThrow();
  });

  test("revoke disables the key and persists", () => {
    const dir = tmpDataDir();
    const s = new AgentKeyStore(dir);
    const { key, record } = s.add();
    expect(s.revoke(record.id)).toBe(true);
    expect(s.verify(key)).toBeNull();
    expect(s.revoke(record.id)).toBe(false);
    expect(new AgentKeyStore(dir).list()).toEqual([]);
  });

  test("revoked bootstrap identity cannot resurrect on import or after restart", () => {
    const dir = tmpDataDir();
    const initial = new AgentKeyStore(dir);
    const { key, record } = initial.add("bootstrap");
    initial.revoke(record.id);
    const replacement = `laun_${record.id}_${"C".repeat(43)}`;
    for (const store of [initial, new AgentKeyStore(dir)]) {
      expect(store.importKey(key).revokedAt).toBeDefined();
      expect(store.importKey(replacement).revokedAt).toBeDefined();
      expect(store.verify(key)).toBeNull();
      expect(store.verify(replacement)).toBeNull();
      expect(store.list()).toEqual([]);
    }
    const restarted = new AgentKeyStore(dir);
    expect(restarted.verify(key)).toBeNull();
    const fresh = restarted.add("rotation with new identity");
    expect(fresh.record.id).not.toBe(record.id);
    expect(restarted.verify(fresh.key)?.id).toBe(fresh.record.id);
  });

  test("missing store is fresh; corrupt, malformed, duplicate or unreadable records stop startup", () => {
    const dir = tmpDataDir();
    const valid = new AgentKeyStore(dir);
    valid.add();
    const index = join(dir, "keys.json");
    const rows = JSON.parse(readFileSync(index, "utf8")) as Record<string, unknown>[];
    for (const raw of ["{", "null", "{}", "[1]", JSON.stringify([{ ...rows[0], hash: "invalid" }]),
      JSON.stringify([{ ...rows[0], createdAt: "invalid" }]), JSON.stringify([{ ...rows[0], revokedAt: "invalid" }]),
      JSON.stringify([{ ...rows[0], id: "../bad" }]), JSON.stringify([rows[0], rows[0]])]) {
      writeFileSync(index, raw);
      expect(() => new AgentKeyStore(dir)).toThrow(/key store/);
      expect(readFileSync(index, "utf8")).toBe(raw);
    }
    const unreadable = tmpDataDir();
    mkdirSync(join(unreadable, "keys.json"));
    expect(() => new AgentKeyStore(unreadable)).toThrow("cannot read key store");
    expect(new AgentKeyStore(tmpDataDir()).list()).toEqual([]);
  });

  test("failed persistence leaves add, replacement and revoke unapplied in memory", () => {
    const dir = tmpDataDir();
    const store = new AgentKeyStore(dir);
    const { key, record } = store.add("existing");
    const index = join(dir, "keys.json");
    const backup = join(dir, "keys.backup.json");
    renameSync(index, backup);
    // Rename onto a directory fails deterministically even when tests run as root.
    mkdirSync(index);
    try {
      expect(() => store.add("must not become active")).toThrow();
      expect(store.list()).toEqual([record]);
      const replacement = `laun_${record.id}_${"D".repeat(43)}`;
      expect(() => store.importKey(replacement)).toThrow();
      expect(store.verify(replacement)).toBeNull();
      expect(store.verify(key)?.id).toBe(record.id);
      expect(() => store.revoke(record.id)).toThrow();
      expect(store.verify(key)?.id).toBe(record.id);
    } finally {
      rmdirSync(index);
      renameSync(backup, index);
    }
    expect(new AgentKeyStore(dir).verify(key)?.id).toBe(record.id);
  });
});
