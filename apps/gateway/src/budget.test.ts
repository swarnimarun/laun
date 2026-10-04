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

function stubExecutor(): string {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/run" && req.method === "POST") {
        // Never-ending stream: the test drives state directly.
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.pathname === "/abort" && req.method === "POST") {
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

function gwAt(executorUrl: string, extra: Record<string, number> = {}): { gw: Gateway; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "laun-budget-"));
  const gw = createGateway(
    { port: 8080, gatewayToken: "t", executorUrl, dataDir: dir, publicDir: dir, ...extra },
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

describe("gateway concurrency cap", () => {
  test("runs past the ceiling are rejected with 429, nothing starts", async () => {
    const { gw } = gwAt(stubExecutor(), { maxConcurrentRuns: 1 });
    const a = gw.sessions.create({ goal: "a", model: "m", runtime: "pi" });
    const b = gw.sessions.create({ goal: "b", model: "m", runtime: "pi" });
    gw.running.add(a.id);
    expect(() => gw.sendMessage(b.id, { text: "hi" })).toThrow("too many concurrent runs");
    try {
      await gw.sendMessage(b.id, { text: "hi" });
      expect.unreachable("must throw");
    } catch (e) {
      expect((e as { status?: number }).status).toBe(429);
    }
    // 0 disables the cap entirely.
    const { gw: gw2 } = gwAt(stubExecutor(), { maxConcurrentRuns: 0 });
    const c = gw2.sessions.create({ goal: "c", model: "m", runtime: "pi" });
    const d = gw2.sessions.create({ goal: "d", model: "m", runtime: "pi" });
    gw2.running.add(c.id);
    gw2.running.add(d.id);
    const e = gw2.sessions.create({ goal: "e", model: "m", runtime: "pi" });
    expect(await gw2.sendMessage(e.id, { text: "hi" })).toEqual({ outcome: "started" });
  });

  test("creating a session past the ceiling fails before a record exists", () => {
    const { gw } = gwAt(stubExecutor(), { maxConcurrentRuns: 1 });
    const a = gw.sessions.create({ goal: "a", model: "m", runtime: "pi" });
    gw.running.add(a.id);
    const before = gw.sessions.list().length;
    expect(() => gw.createSession({ goal: "nope" })).toThrow("too many concurrent runs");
    expect(gw.sessions.list()).toHaveLength(before);
  });
});

describe("gateway token budget", () => {
  test("usage past the budget aborts the live run", async () => {
    const { gw, id } = gwAt(stubExecutor(), { maxSessionTokens: 100 });
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    gw.publish(id, { type: "usage", sessionId: id, inputTokens: 60, outputTokens: 30 });
    // 90 total: under budget, still running, no abort.
    expect(gw.running.has(id)).toBe(true);
    gw.publish(id, { type: "usage", sessionId: id, totalTokens: 20 });
    // 110 total: over budget → abort requested, budget event published.
    await pollFor(() => !gw.running.has(id), "budget abort cleared the run");
    const log = gw.log(id, 0);
    expect(log.events.some((e) => e.type === "status" && (e.message ?? "").includes("token budget exceeded"))).toBe(true);
    expect(log.events.some((e) => e.type === "status" && (e.message ?? "").includes("aborted by token budget"))).toBe(true);
  });

  test("no budget configured means usage never aborts", () => {
    const { gw, id } = gwAt(stubExecutor());
    gw.running.add(id);
    gw.publish(id, { type: "usage", sessionId: id, totalTokens: 10_000_000 });
    expect(gw.running.has(id)).toBe(true);
  });

  test("budget counts totalTokens, else input+output, ignoring garbage", async () => {
    const { gw, id } = gwAt(stubExecutor(), { maxSessionTokens: 10 });
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    gw.publish(id, { type: "usage", sessionId: id, inputTokens: "lots" as never, outputTokens: -5 });
    expect(gw.running.has(id)).toBe(true);
    gw.publish(id, { type: "usage", sessionId: id, inputTokens: 6, outputTokens: 5 });
    await pollFor(() => !gw.running.has(id), "budget abort on summed parts");
  });
});
