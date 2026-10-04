import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

function gwAt(executorUrl: string, extra: Record<string, unknown> = {}): { gw: Gateway; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "laun-resume-"));
  const gw = createGateway(
    { port: 8080, gatewayToken: "t", executorUrl, dataDir: dir, publicDir: dir, stallMs: 150, ...extra },
    new SessionStore(dir),
  );
  const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
  return { gw, id: rec.id };
}

async function pollFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("stall sweeper", () => {
  test("a silent run past the ceiling is aborted with a note", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    gw.publish(id, { type: "status", sessionId: id, status: "running", message: "start" });
    // Silence exceeds stallMs (150ms); the 1s-floor sweeper must abort it.
    await pollFor(() => !gw.running.has(id), "sweeper cleared the stalled run", 8000);
    expect(stub.aborts).toHaveLength(1);
    expect(JSON.parse(stub.aborts[0]!)).toEqual({ sessionId: id });
    const log = gw.log(id, 0);
    expect(log.events.some((e) => e.type === "status" && (e.message ?? "").includes("stalled"))).toBe(true);
  });

  test("an unreachable executor leaves the stalled record alone", async () => {
    const { gw, id } = gwAt("http://127.0.0.1:1", { stallMs: 150 });
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    gw.publish(id, { type: "status", sessionId: id, status: "running", message: "start" });
    // Let two sweep windows pass; the record must survive (abort 502s).
    await new Promise((r) => setTimeout(r, 2500));
    expect(gw.running.has(id)).toBe(true);
  });

  test("stallMs 0 disables the sweeper", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url, { stallMs: 0 });
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    gw.publish(id, { type: "status", sessionId: id, status: "running", message: "start" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(gw.running.has(id)).toBe(true);
    expect(stub.aborts).toHaveLength(0);
  });
});
