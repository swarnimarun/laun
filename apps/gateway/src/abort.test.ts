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

function stubExecutor(status: number, body = '{"ok":true}'): { url: string; calls: string[] } {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/abort" && req.method === "POST") {
        calls.push(await req.text());
        return new Response(body, { status });
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

  test("an idle session asks the executor and reports not_running", async () => {
    // Changed semantics: the old code threw 409 off the local `running` set
    // without ever asking, which made a wedged executor slot unreachable.
    // Now the executor is always poked; "not_running" (HTTP 409, same CLI
    // message as before) means both sides agree nothing is live.
    const stub = stubExecutor(409, JSON.stringify({ error: "session not running" }));
    const { gw, id } = gwAt(stub.url);
    expect(await gw.abort(id)).toBe("not_running");
    expect(stub.calls).toHaveLength(1);
    expect(JSON.parse(stub.calls[0]!)).toEqual({ sessionId: id });
  });

  test("a wedged executor slot is reachable even when the record says idle", async () => {
    // Regression for the 41bb1ac8 wedge: the run timed out here (record
    // `error`, nothing in `running`) while the executor still held the slot
    // and answered 409 "already running" to every new run. `stop` used to
    // refuse without asking; now the executor kill goes through.
    const stub = stubExecutor(200);
    const { gw, id } = gwAt(stub.url);
    gw.sessions.setStatus(id, "error");
    expect(gw.running.has(id)).toBe(false);
    expect(await gw.abort(id, "tester")).toBe("ok");
    expect(stub.calls).toHaveLength(1);
    const log = gw.log(id, 0);
    const abortEvent = log.events.find(
      (e) => e.type === "status" && e.status === "error" && (e.message ?? "").includes("aborted by tester"),
    );
    expect(abortEvent).toBeDefined();
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

  test("an executor build without an abort route must not be reported as stopped", async () => {
    // Regression: a not-yet-rebuilt executor answers 404 {"error":"not found"}
    // for the missing route, which the gateway used to treat as "run is gone".
    // `stop` then claimed a kill that never happened.
    const stub = stubExecutor(404, JSON.stringify({ error: "not found" }));
    const { gw, id } = gwAt(stub.url);
    gw.sessions.setStatus(id, "running");
    gw.running.add(id);
    await expect(gw.abort(id)).rejects.toMatchObject({ status: 502 });
    expect(gw.running.has(id)).toBe(true);
    expect(gw.sessions.get(id)?.status).toBe("running");
  });

  test("404 from an executor that HAS the route still means the run is gone", async () => {
    const stub = stubExecutor(404, JSON.stringify({ error: "unknown session" }));
    const { gw, id } = gwAt(stub.url);
    gw.sessions.setStatus(id, "running");
    gw.running.add(id);
    expect(await gw.abort(id)).toBe("ok");
    expect(gw.running.has(id)).toBe(false);
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
