import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, type Gateway } from "./server.js";
import { SessionStore } from "./store.js";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop(true);
});

function stubExecutor(): { url: string; aborts: string[] } {
  const aborts: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/abort" && req.method === "POST") {
        aborts.push(await req.text());
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}`, aborts };
}

function gwAt(executorUrl: string): { gw: Gateway; id: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "laun-del-"));
  const gw = createGateway(
    { port: 8080, gatewayToken: "t", executorUrl, dataDir: dir, publicDir: dir },
    new SessionStore(dir),
  );
  const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
  return { gw, id: rec.id, dir };
}

describe("session delete", () => {
  test("unknown session is 404", async () => {
    const stub = stubExecutor();
    const { gw } = gwAt(stub.url);
    await expect(gw.deleteSession("missing1")).rejects.toMatchObject({ status: 404 });
  });

  test("idle session deletes record, bus, and log file", async () => {
    const stub = stubExecutor();
    const { gw, id, dir } = gwAt(stub.url);
    gw.publish(id, { type: "text", sessionId: id, delta: "hi" });
    await gw.deleteSession(id);
    expect(gw.sessions.get(id)).toBeUndefined();
    expect(gw.log(id, 0)).toEqual({ events: [], next: 0 });
    expect(existsSync(join(dir, `events-${id}.jsonl`))).toBe(false);
    expect(stub.aborts).toHaveLength(0);
  });

  test("running session is aborted first, then deleted", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    await gw.deleteSession(id, "tester");
    expect(stub.aborts).toHaveLength(1);
    expect(JSON.parse(stub.aborts[0]!)).toEqual({ sessionId: id });
    expect(gw.sessions.get(id)).toBeUndefined();
    expect(gw.running.has(id)).toBe(false);
  });

  test("store.delete removes the record and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-delstore-"));
    const s = new SessionStore(dir);
    const rec = s.create({ goal: "g", model: "m", runtime: "pi" });
    expect(s.delete(rec.id)).toBe(true);
    expect(s.get(rec.id)).toBeUndefined();
    expect(s.delete(rec.id)).toBe(false);
    const s2 = new SessionStore(dir);
    expect(s2.get(rec.id)).toBeUndefined();
  });
});
