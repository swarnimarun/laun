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

function stubExecutor(status: number): { url: string; calls: string[] } {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/abort" && req.method === "POST") {
        calls.push(await req.text());
        return new Response(JSON.stringify({ ok: true }), { status });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}`, calls };
}

function gwAt(executorUrl: string): { gw: Gateway; id: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cb-abort-"));
  const gw = createGateway(
    { port: 8080, gatewayToken: "t", executorUrl, dataDir: dir, publicDir: dir },
    new SessionStore(dir),
  );
  const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
  return { gw, id: rec.id, dir };
}

describe("gateway abort", () => {
  test("unknown session is 404", async () => {
    const { gw } = gwAt(stubExecutor(200).url);
    await expect(gw.abort("missing1")).rejects.toMatchObject({ status: 404 });
  });

  test("an idle session is 409, not a fake success", async () => {
    const { gw, id } = gwAt(stubExecutor(200).url);
    await expect(gw.abort(id)).rejects.toMatchObject({ status: 409 });
  });

  test("a running session stops and reports who aborted it", async () => {
    const stub = stubExecutor(200);
    const { gw, id } = gwAt(stub.url);
    gw.sessions.setStatus(id, "running");
    gw.running.add(id);

    expect(await gw.abort(id, "tester")).toBe("ok");
    expect(gw.running.has(id)).toBe(false);
    expect(stub.calls).toHaveLength(1);
    expect(JSON.parse(stub.calls[0]!)).toEqual({ sessionId: id });

    const log = gw.log(id, 0);
    const abortEvent = log.events.find(
      (e) => e.type === "status" && e.status === "error" && (e.message ?? "").includes("aborted by tester"),
    );
    expect(abortEvent).toBeDefined();
  });

  test("an unreachable executor never reports success", async () => {
    // Port 1 on localhost: nothing listens, so fetch throws → 502.
    const { gw, id } = gwAt("http://127.0.0.1:1");
    gw.sessions.setStatus(id, "running");
    gw.running.add(id);
    await expect(gw.abort(id)).rejects.toMatchObject({ status: 502 });
    // the session must still be marked running: we did not stop it
    expect(gw.running.has(id)).toBe(true);
    expect(gw.sessions.get(id)?.status).toBe("running");
  });

  test("an executor that already has no such run still counts as stopped", async () => {
    // The executor answered 409 (nothing running) — the run is gone either way.
    const stub = stubExecutor(409);
    const { gw, id } = gwAt(stub.url);
    gw.sessions.setStatus(id, "running");
    gw.running.add(id);
    expect(await gw.abort(id)).toBe("ok");
    expect(gw.running.has(id)).toBe(false);
  });
});
