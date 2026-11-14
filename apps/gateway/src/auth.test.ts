import { describe, expect, test } from "bun:test";
import { fsyncSync, fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKeyStore, isKeyPrincipalId, type PublicAgentKeyRecord } from "./keys.js";
import type { ControlState, MowerRecord, ThreadRecord } from "@laun/protocol";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";

function gwWithKeys(bootstrapKey?: string) {
  const dir = mkdtempSync(join(tmpdir(), "laun-auth-"));
  const keys = new AgentKeyStore(dir);
  const gw = createGateway(
    { port: 8080, gatewayToken: "service-token", executorUrl: "http://localhost:9", dataDir: dir, bootstrapKey, publicDir: dir },
    new SessionStore(dir),
    keys,
  );
  return { gw, keys, dir };
}

function req(authorization?: string): Request {
  return new Request("http://x/", authorization ? { headers: { authorization } } : undefined);
}

describe("gateway auth: service token vs agent key", () => {
  test("service token is recognised and can manage keys", () => {
    const { gw } = gwWithKeys();
    const id = gw.authenticate(req("Bearer service-token"));
    expect(id).toEqual({ kind: "service" });
    expect(gw.auth(req("Bearer service-token"))).toBe(true);
  });

  test("agent keys authenticate humans and report their key id", () => {
    const { gw, keys } = gwWithKeys();
    const { key, record } = keys.add("phone");
    expect(gw.authenticate(req(`Bearer ${key}`))).toEqual({ kind: "agent", keyId: record.id, label: "phone" });
    // the web UI/CLI may send the key with any casing of "bearer"
    expect(gw.auth(req(`bearer ${key}`))).toBe(true);
  });

  test("garbage, missing, and revoked credentials fail closed", () => {
    const { gw, keys } = gwWithKeys();
    const { key, record } = keys.add();
    expect(gw.authenticate(req())).toBeNull();
    expect(gw.authenticate(req("Bearer"))).toBeNull();
    expect(gw.authenticate(req("Bearer nope"))).toBeNull();
    expect(gw.authenticate(req("Basic abc"))).toBeNull();
    // the service token must not be accepted as an agent key and vice versa
    expect(gw.authenticate(req(`Bearer laun_${record.id}_${"Z".repeat(43)}`))).toBeNull();
    keys.revoke(record.id);
    expect(gw.authenticate(req(`Bearer ${key}`))).toBeNull();
  });

  test("a bootstrap key from .env is usable on first boot", () => {
    const { gw, keys } = gwWithKeys();
    const { key, record } = keys.add("bootstrap-source");
    // simulate: setup wrote this key into .env, gateway restarts and imports it
    const dir2 = mkdtempSync(join(tmpdir(), "laun-auth2-"));
    const gw2 = createGateway(
      {
        port: 8080,
        gatewayToken: "service-token",
        executorUrl: "http://localhost:9",
        dataDir: dir2,
        bootstrapKey: key,
        publicDir: dir2,
      },
      new SessionStore(dir2),
      new AgentKeyStore(dir2),
    );
    expect(gw2.authenticate(req(`Bearer ${key}`))).toEqual({ kind: "agent", keyId: record.id, label: "bootstrap" });
  });

  test("an invalid LAUN_KEY refuses to start", () => {
    expect(() => gwWithKeys("garbage")).toThrow("LAUN_KEY");
  });

  test("restart with a stale bootstrap env key preserves revocation", () => {
    const { keys, dir } = gwWithKeys();
    const { key, record } = keys.add("bootstrap");
    keys.revoke(record.id);
    const restarted = createGateway(
      { port: 8080, gatewayToken: "service-token", executorUrl: "http://localhost:9", dataDir: dir, bootstrapKey: key, publicDir: dir },
      new SessionStore(dir), new AgentKeyStore(dir),
    );
    expect(restarted.authenticate(req(`Bearer ${key}`))).toBeNull();
    expect(restarted.authenticate(req("Bearer service-token"))).toEqual({ kind: "service" });
    expect(restarted.keys.list()).toEqual([]);
  });
});

describe("stable human principals", () => {
  test("failed file sync leaves prior credentials active and the original index unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-key-file-sync-"));
    let fail = false;
    const keys = new AgentKeyStore(dir, { sync(fd) { if (fail && fstatSync(fd).isFile()) throw new Error("injected file sync failure"); fsyncSync(fd); } });
    const initial = keys.add("existing");
    const original = readFileSync(join(dir, "keys.json"), "utf8");
    fail = true;
    expect(() => keys.revoke(initial.record.id)).toThrow("file sync");
    expect(keys.verify(initial.key)?.id).toBe(initial.record.id);
    expect(readFileSync(join(dir, "keys.json"), "utf8")).toBe(original);
    expect(keys.principalIdForKey(initial.record.id)).toBe(initial.record.principalId!);
    rmSync(dir, { recursive: true, force: true });
  });

  test("failed directory sync disables every key operation until persisted state is reopened", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-key-directory-sync-"));
    let fail = false;
    const keys = new AgentKeyStore(dir, { sync(fd) { if (fail && fstatSync(fd).isDirectory()) throw new Error("injected directory sync failure"); fsyncSync(fd); } });
    const initial = keys.add("must revoke");
    const gw = createGateway({ port: 8080, gatewayToken: "recovery-admin", executorUrl: "http://localhost:9", dataDir: dir, publicDir: dir }, new SessionStore(dir), keys);
    fail = true;
    expect(() => keys.revoke(initial.record.id)).toThrow("key store unavailable");
    for (const operation of [() => keys.verify(initial.key), () => keys.verify("malformed"), () => keys.principalIdForKey(initial.record.id),
      () => keys.list(), () => keys.add("new"), () => keys.importKey(initial.key), () => keys.revoke(initial.record.id)]) {
      expect(operation).toThrow("key store unavailable");
    }
    expect(gw.authenticate(req("Bearer recovery-admin"))).toEqual({ kind: "service" });
    expect(() => gw.authenticate(req(`Bearer ${initial.key}`))).toThrow("key store unavailable");
    const recovered = new AgentKeyStore(dir);
    expect(recovered.verify(initial.key)).toBeNull();
    expect(recovered.importKey(initial.key).revokedAt).toBeDefined();
    expect(recovered.principalIdForKey(initial.record.id)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("new credentials have separate owners; an explicit rotation preserves the owner through revoke/restart", () => {
    const { keys, dir } = gwWithKeys();
    const first = keys.add("old laptop");
    const owner = keys.principalIdForKey(first.record.id)!;
    expect(owner).toMatch(/^user_[0-9a-f]{32}$/);
    expect(first.record.principalId).toBe(owner);
    const separate = keys.add("separate account");
    expect(keys.principalIdForKey(separate.record.id)).not.toBe(owner);
    const replacement = keys.add("new laptop", owner);
    expect(keys.principalIdForKey(replacement.record.id)).toBe(owner);
    keys.revoke(first.record.id);
    expect(keys.principalIdForKey(first.record.id)).toBeNull();
    expect(keys.principalIdForKey("unknown")).toBeNull();
    const reloaded = new AgentKeyStore(dir);
    expect(reloaded.principalIdForKey(replacement.record.id)).toBe(owner);
    expect(reloaded.verify(replacement.key)?.principalId).toBe(owner);
    expect(reloaded.verify(first.key)).toBeNull();
    expect(reloaded.importKey(first.key).revokedAt).toBeDefined();
    expect(reloaded.verify(first.key)).toBeNull();
  });

  test("legacy arrays and initial bootstrap import keep key owners without rewriting the index", () => {
    const { keys, dir } = gwWithKeys();
    const source = keys.add("legacy");
    const index = join(dir, "keys.json");
    const rows = JSON.parse(readFileSync(index, "utf8")) as Array<Record<string, unknown>>;
    delete rows[0]!.principalId;
    const original = JSON.stringify(rows);
    writeFileSync(index, original);
    const reloaded = new AgentKeyStore(dir);
    expect(reloaded.principalIdForKey(source.record.id)).toBe(`key_${source.record.id}`);
    expect(reloaded.importKey(source.key).principalId).toBeUndefined();
    expect(readFileSync(index, "utf8")).toBe(original);
    const replacement = reloaded.add("rotation", `key_${source.record.id}`);
    expect(reloaded.principalIdForKey(replacement.record.id)).toBe(`key_${source.record.id}`);
    const fresh = new AgentKeyStore(mkdtempSync(join(tmpdir(), "laun-legacy-bootstrap-")));
    fresh.importKey(source.key);
    expect(fresh.principalIdForKey(source.record.id)).toBe(`key_${source.record.id}`);
  });

  test("bootstrap reimport and regenerated secrets cannot change an explicit owner mapping", () => {
    const { keys, dir } = gwWithKeys();
    const initial = keys.add("phone");
    const owner = initial.record.principalId!;
    const replacement = `laun_${initial.record.id}_${"R".repeat(43)}`;
    const reloaded = new AgentKeyStore(dir);
    expect(reloaded.importKey(initial.key).principalId).toBe(owner);
    expect(reloaded.importKey(replacement).principalId).toBe(owner);
    expect(reloaded.verify(initial.key)).toBeNull();
    const gw = createGateway(
      { port: 8080, gatewayToken: "service-token", executorUrl: "http://localhost:9", dataDir: dir, bootstrapKey: replacement, publicDir: dir },
      new SessionStore(dir), new AgentKeyStore(dir),
    );
    expect(gw.authenticate(req(`Bearer ${replacement}`))).toEqual({ kind: "agent", keyId: initial.record.id, label: "phone" });
    expect(gw.keys.principalIdForKey(initial.record.id)).toBe(owner);
  });

  test("malformed owner mappings stop startup and invalid supplied principals never persist", () => {
    const { keys, dir } = gwWithKeys();
    keys.add("existing");
    const index = join(dir, "keys.json");
    const original = readFileSync(index, "utf8");
    const row = (JSON.parse(original) as Array<Record<string, unknown>>)[0]!;
    const invalid: unknown[] = [null, 42, {}, [], "", "service", "local", "user_alice", "key_abc", "telegram_1_2", "worker_deadbeef", "key_deadbeef/path", " user_" + "a".repeat(32), "user_" + "A".repeat(32), "user_" + "a".repeat(33)];
    for (const principalId of invalid) {
      expect(isKeyPrincipalId(principalId)).toBe(false);
      expect(() => keys.add("invalid", principalId as string)).toThrow("principalId");
      expect(readFileSync(index, "utf8")).toBe(original);
      const corrupt = JSON.stringify([{ ...row, principalId }]);
      writeFileSync(index, corrupt);
      expect(() => new AgentKeyStore(dir)).toThrow("key store");
      expect(readFileSync(index, "utf8")).toBe(corrupt);
      writeFileSync(index, original);
    }
    expect(isKeyPrincipalId(`user_${"a".repeat(32)}`)).toBe(true);
    expect(isKeyPrincipalId("key_deadbeef")).toBe(true);
    expect(isKeyPrincipalId(`key_${"a".repeat(32)}`)).toBe(true);
  });

  test("production HTTP auth retains v2 ownership across rotation and bootstrap restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-principal-http-"));
    // The brief reservation asks the OS for a free loopback port for the real
    // production entry point, rather than duplicating its authentication router.
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
    const port = reservation.port!;
    reservation.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const serviceKey = "test-only-installation-token";
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let output: Promise<string>[] = [];
    const stop = async () => {
      if (child) { child.kill(); await child.exited; child = undefined; }
      await Promise.all(output); output = [];
    };
    const start = async (bootstrap = "") => {
      child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], { env: {
        PATH: process.env.PATH, GATEWAY_PORT: String(port), GATEWAY_BIND: "127.0.0.1",
        GATEWAY_TOKEN: serviceKey, DATA_DIR: dir, PUBLIC_DIR: dir, LAUN_KEY: bootstrap,
        OPENSHELL_ENABLED: "false", LAUN_TRUSTED_LOCAL: "false", LAUN_DEMO: "false", LAUN_MCP_ALLOW_LOOPBACK: "false",
        AUTO_RESUME: "false", MODEL: "fixture/model", PI_AUTH_FILE: join(dir, "unused-auth.json"),
      }, stdout: "pipe", stderr: "pipe" });
      output = [new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()];
      const deadline = Date.now() + 8000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`gateway fixture stopped before readiness (${child.exitCode})`);
        try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* starting */ }
        if (Date.now() > deadline) throw new Error("gateway fixture readiness timed out");
        await Bun.sleep(20);
      }
    };
    const call = (path: string, key: string, method = "GET", value?: unknown, extraHeaders: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extraHeaders },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(3000),
    });
    const createKey = async (label: string, principalId?: string) => {
      const response = await call("/keys", serviceKey, "POST", { label, ...(principalId ? { principalId } : {}) });
      expect(response.status).toBe(201);
      return await response.json() as { key: string; record: PublicAgentKeyRecord };
    };
    try {
      await start();
      const initial = await createKey("old credential");
      const separate = await createKey("different account");
      const owner = initial.record.principalId!;
      expect(owner).toMatch(/^user_[0-9a-f]{32}$/);
      const mowerResponse = await call("/api/v2/mowers", initial.key, "POST", { name: "Rotating mower" });
      expect(mowerResponse.status).toBe(201);
      const mower = await mowerResponse.json() as MowerRecord;
      expect(mower.ownerId).toBe(owner);
      const threadResponse = await call("/api/v2/threads", initial.key, "POST", { mowerId: mower.id, title: "Durable account work" });
      expect(threadResponse.status).toBe(201);
      const thread = await threadResponse.json() as ThreadRecord;
      expect(thread.ownerId).toBe(owner);
      expect((await call("/keys", initial.key, "POST", { principalId: owner })).status).toBe(403);
      expect((await call(`/keys/${separate.record.id}`, initial.key, "DELETE")).status).toBe(403);
      for (const principalId of ["service", "worker_deadbeef", "user_bad", null, {}]) {
        expect((await call("/keys", serviceKey, "POST", { principalId })).status).toBe(400);
      }
      expect((await call("/keys", serviceKey, "POST", { label: "bad", ownerId: owner })).status).toBe(400);
      const isolated = await (await call("/api/v2/state", separate.key, "GET", undefined, { "x-principal-id": owner })).json() as ControlState;
      expect(isolated.mowers).toHaveLength(0);
      expect(isolated.threads).toHaveLength(0);
      expect((await call(`/api/v2/threads/${thread.id}/events`, separate.key)).status).toBe(404);
      const replacement = await createKey("replacement credential", owner);
      expect(replacement.record.id).not.toBe(initial.record.id);
      expect((await call(`/keys/${initial.record.id}`, serviceKey, "DELETE")).status).toBe(200);
      expect((await call("/api/v2/state", initial.key)).status).toBe(401);
      const state = await (await call("/api/v2/state", replacement.key)).json() as ControlState;
      expect(state.mowers.map((m) => m.id)).toEqual([mower.id]);
      expect(state.threads.map((t) => t.id)).toEqual([thread.id]);
      expect((await call(`/api/v2/threads/${thread.id}/events`, replacement.key)).status).toBe(200);
      await stop();
      // A stale bootstrap variable cannot resurrect the revoked credential or
      // change the replacement credential's persisted account mapping.
      await start(initial.key);
      expect((await call("/api/v2/state", initial.key)).status).toBe(401);
      const restarted = await (await call("/api/v2/state", replacement.key)).json() as ControlState;
      expect(restarted.mowers.map((m) => m.id)).toEqual([mower.id]);
      expect(restarted.threads.map((t) => t.id)).toEqual([thread.id]);
      expect(new AgentKeyStore(dir).principalIdForKey(replacement.record.id)).toBe(owner);
    } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});
