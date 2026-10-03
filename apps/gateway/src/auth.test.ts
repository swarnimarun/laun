import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKeyStore } from "./keys.js";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";

function gwWithKeys(bootstrapKey?: string) {
  const dir = mkdtempSync(join(tmpdir(), "cb-auth-"));
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
    expect(gw.authenticate(req(`Bearer cb_${record.id}_${"Z".repeat(43)}`))).toBeNull();
    keys.revoke(record.id);
    expect(gw.authenticate(req(`Bearer ${key}`))).toBeNull();
  });

  test("a bootstrap key from .env is usable on first boot", () => {
    const { gw, keys } = gwWithKeys();
    const { key, record } = keys.add("bootstrap-source");
    // simulate: setup wrote this key into .env, gateway restarts and imports it
    const dir2 = mkdtempSync(join(tmpdir(), "cb-auth2-"));
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

  test("an invalid CLOUDBEAR_KEY refuses to start", () => {
    expect(() => gwWithKeys("garbage")).toThrow("CLOUDBEAR_KEY");
  });
});
