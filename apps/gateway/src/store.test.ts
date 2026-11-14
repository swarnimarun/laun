import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";

const dirs: string[] = [];
function dir() { const p = mkdtempSync(join(tmpdir(), "laun-store-integrity-")); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
const input = { goal: "durable", model: "m", runtime: "pi" as const };

describe("session index integrity", () => {
  test.each(["{", "{}", '[{"id":"../escape"}]', '[{"id":"x","status":"running"}]'])("refuses corrupt index %s without rewriting it", (raw) => {
    const p = dir();
    writeFileSync(join(p, "index.json"), raw);
    expect(() => new SessionStore(p)).toThrow("invalid session index");
    expect(readFileSync(join(p, "index.json"), "utf8")).toBe(raw);
  });

  test("rejects duplicate ids and migrates legacy runtime explicitly", () => {
    const p = dir();
    const store = new SessionStore(p);
    const rec = store.create(input);
    const { runtime, ...legacy } = rec;
    writeFileSync(join(p, "index.json"), JSON.stringify([legacy]));
    expect(new SessionStore(p).get(rec.id)?.runtime).toBe("pi");
    writeFileSync(join(p, "index.json"), JSON.stringify([rec, rec]));
    expect(() => new SessionStore(p)).toThrow("invalid session index");
  });

  test("failed writes do not publish mutations in memory", () => {
    const p = dir();
    const store = new SessionStore(p);
    const rec = store.create(input);
    rmSync(join(p, "index.json"));
    mkdirSync(join(p, "index.json")); // rename into a directory must fail on all supported hosts
    expect(() => store.setStatus(rec.id, "done")).toThrow();
    expect(store.get(rec.id)?.status).toBe("pending");
    expect(() => store.delete(rec.id)).toThrow();
    expect(store.get(rec.id)).toBeDefined();
    expect(() => store.create(input)).toThrow();
    expect(store.list()).toHaveLength(1);
  });

  test("returned records cannot mutate persisted state and index is private", () => {
    const p = dir();
    const store = new SessionStore(p);
    const rec = store.create(input);
    rec.goal = "tampered";
    store.get(rec.id)!.status = "done";
    store.list()[0].model = "tampered";
    expect(store.get(rec.id)).toMatchObject({ goal: "durable", model: "m", status: "pending" });
    expect(new SessionStore(p).get(rec.id)).toEqual(store.get(rec.id));
    expect(statSync(join(p, "index.json")).mode & 0o777).toBe(0o600);
  });
});
