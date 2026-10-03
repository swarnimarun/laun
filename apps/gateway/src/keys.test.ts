import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentKey } from "@cloudbear/protocol";
import { AgentKeyStore } from "./keys.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "cb-keys-"));
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
    expect(s.verify(`cb_${record.id}_${"A".repeat(43)}`)).toBeNull();
    // unknown id
    expect(s.verify(`cb_${"0".repeat(8)}_${parts!.secret}`)).toBeNull();
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
    const regenerated = `cb_${record.id}_${"B".repeat(43)}`;
    expect(s.importKey(regenerated).id).toBe(record.id);
    expect(s.list()).toHaveLength(1);
    expect(s.verify(regenerated)?.id).toBe(record.id);
    expect(s.verify(key)).toBeNull();

    expect(() => s.importKey("not-a-key")).toThrow("CLOUDBEAR_KEY");
    expect(() => new AgentKeyStore(dir)).not.toThrow();
  });

  test("revoke removes the key and persists", () => {
    const dir = tmpDataDir();
    const s = new AgentKeyStore(dir);
    const { key, record } = s.add();
    expect(s.revoke(record.id)).toBe(true);
    expect(s.verify(key)).toBeNull();
    expect(s.revoke(record.id)).toBe(false);
    expect(new AgentKeyStore(dir).list()).toEqual([]);
  });
});
