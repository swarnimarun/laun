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

interface StubOpts {
  runEvents?: string[];
  runCalls?: string[];
  steerStatus?: number;
  steerBody?: string;
  approvalsStatus?: number;
  approvalsCalls?: string[];
  steerCalls?: string[];
  abortStatus?: number;
  abortCalls?: string[];
}

/** Stub executor with a recording /run stream and a configurable /steer. */
function stubExecutor(o: StubOpts = {}): { url: string; calls: { runCalls: string[]; steerCalls: string[]; abortCalls: string[]; approvalsCalls: string[] } } {
  const runCalls: string[] = [];
  const steerCalls: string[] = [];
  const abortCalls: string[] = [];
  const approvalsCalls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/run" && req.method === "POST") {
        const body = await req.text();
        runCalls.push(body);
        const events = o.runEvents ?? [
          JSON.stringify({ type: "status", sessionId: "x", status: "done" }),
        ];
        return new Response(events.join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.pathname === "/steer" && req.method === "POST") {
        steerCalls.push(await req.text());
        return new Response(o.steerBody ?? '{"ok":true}', { status: o.steerStatus ?? 200 });
      }
      if (url.pathname === "/approvals" && req.method === "POST") {
        approvalsCalls.push(await req.text());
        return new Response('{"ok":true}', { status: o.approvalsStatus ?? 200 });
      }
      if (url.pathname === "/abort" && req.method === "POST") {
        abortCalls.push(await req.text());
        return new Response('{"ok":true}', { status: o.abortStatus ?? 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}`, calls: { runCalls, steerCalls, abortCalls, approvalsCalls } };
}

function gwAt(executorUrl: string): { gw: Gateway; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "laun-steer-"));
  const gw = createGateway(
    { port: 8080, gatewayToken: "t", executorUrl, dataDir: dir, publicDir: dir },
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

describe("gateway steer/queue", () => {
  test("idle message starts a run (unchanged)", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    expect(await gw.sendMessage(id, { text: "hi" })).toEqual({ outcome: "started" });
    await pollFor(() => stub.calls.runCalls.length === 1, "run started");
    expect(JSON.parse(stub.calls.runCalls[0]!).prompt).toBe("hi");
  });

  test("busy without mode still 409s (bridge contract locked)", () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    expect(() => gw.sendMessage(id, { text: "hi" })).toThrow("session already running");
    expect(stub.calls.runCalls).toHaveLength(0);
    expect(stub.calls.steerCalls).toHaveLength(0);
  });

  test("invalid mode is a 400", () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    expect(() => gw.sendMessage(id, { text: "hi", mode: "yeet" } as never)).toThrow('mode must be "steer" or "queue"');
  });

  test("busy + steer reaches the executor and publishes", async () => {
    const stub = stubExecutor({ steerStatus: 200 });
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    expect(await gw.sendMessage(id, { text: "go left", mode: "steer" })).toEqual({ outcome: "steered" });
    expect(stub.calls.steerCalls).toHaveLength(1);
    expect(JSON.parse(stub.calls.steerCalls[0]!)).toEqual({ sessionId: id, text: "go left" });
    expect(stub.calls.runCalls).toHaveLength(0);
    const log = gw.log(id, 0);
    expect(log.events.some((e) => e.type === "status" && (e.message ?? "").includes("steered"))).toBe(true);
  });

  test("steer on a desynced slot starts fresh instead of stranding", async () => {
    // Executor answers 409 (no live run) while we believed busy: clear and
    // start the text as a fresh run rather than repeating the old wedge.
    const stub = stubExecutor({ steerStatus: 409, steerBody: '{"error":"session not running"}' });
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    expect(await gw.sendMessage(id, { text: "go", mode: "steer" })).toEqual({ outcome: "started" });
    await pollFor(() => stub.calls.runCalls.length === 1, "fresh run started");
    expect(JSON.parse(stub.calls.runCalls[0]!).prompt).toBe("go");
  });

  test("steer against a build without the route is a 502, never silent", async () => {
    const stub = stubExecutor({ steerStatus: 404, steerBody: '{"error":"not found"}' });
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    await expect(gw.sendMessage(id, { text: "go", mode: "steer" })).rejects.toMatchObject({ status: 502 });
    expect(gw.running.has(id)).toBe(true);
  });

  test("queue stores one slot, newer replaces older, drain starts it", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    // Fake a busy slot (no real stream) to set queue state deterministically.
    gw.running.add(id);
    expect(await gw.sendMessage(id, { text: "first", mode: "queue" })).toEqual({ outcome: "queued" });
    expect(await gw.sendMessage(id, { text: "second", mode: "queue" })).toEqual({ outcome: "queued" });
    const log = gw.log(id, 0);
    expect(log.events.some((e) => e.type === "status" && (e.message ?? "").includes("replaces older"))).toBe(true);
    // Free the fake slot; a fresh idle run consumes the instant stub stream,
    // and its finally must drain the queued text as run #2.
    gw.running.delete(id);
    expect(await gw.sendMessage(id, { text: "starter" })).toEqual({ outcome: "started" });
    await pollFor(() => stub.calls.runCalls.length >= 2, "drained run started");
    const prompts = stub.calls.runCalls.map((c) => JSON.parse(c).prompt as string);
    expect(prompts).toEqual(["starter", "second"]);
  });

  test("abort clears a queued follow-up", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    gw.running.add(id);
    gw.sessions.setStatus(id, "running");
    expect(await gw.sendMessage(id, { text: "later", mode: "queue" })).toEqual({ outcome: "queued" });
    expect(await gw.abort(id, "tester")).toBe("ok");
    // A fresh run afterwards must carry only its own prompt — the cancelled
    // intent stays cancelled.
    expect(await gw.sendMessage(id, { text: "fresh" })).toEqual({ outcome: "started" });
    await pollFor(() => stub.calls.runCalls.length >= 1, "fresh run sent");
    await pollFor(() => !gw.running.has(id), "run settled");
    const prompts = stub.calls.runCalls.map((c) => JSON.parse(c).prompt as string);
    expect(prompts).toEqual(["fresh"]);
  });

  test("repo and runtime thread through to the executor run", async () => {
    const stub = stubExecutor();
    const { gw } = gwAt(stub.url);
    const rec = gw.createSession({ goal: "g", repo: "https://example.com/r.git", runtime: "goose" });
    await pollFor(() => stub.calls.runCalls.length >= 1, "run sent");
    const body = JSON.parse(stub.calls.runCalls[0]!);
    expect(body.repo).toBe("https://example.com/r.git");
    expect(body.runtime).toBe("goose");
    await pollFor(() => !gw.running.has(rec.id), "run settled");
  });

  test("approval decisions forward to the executor, failures noted not thrown", async () => {
    const stub = stubExecutor();
    const { gw, id } = gwAt(stub.url);
    gw.publish(id, { type: "approval_request", sessionId: id, requestId: "r1", reason: "sudo?" });
    gw.decideApproval(id, { requestId: "r1", decision: "approve" }, "tester");
    await pollFor(() => stub.calls.approvalsCalls.length >= 1, "forwarded");
    expect(JSON.parse(stub.calls.approvalsCalls[0]!)).toEqual({
      sessionId: id,
      requestId: "r1",
      decision: "approve",
    });
    // No failure note on success.
    expect(gw.log(id, 0).events.some((e) => e.type === "status" && (e.message ?? "").includes("executor"))).toBe(false);
  });

  test("unreachable executor keeps the local decision and notes it", async () => {
    const { gw, id } = gwAt("http://127.0.0.1:1");
    gw.publish(id, { type: "approval_request", sessionId: id, requestId: "r1", reason: "sudo?" });
    gw.decideApproval(id, { requestId: "r1", decision: "deny" }, "tester");
    await pollFor(
      () => gw.log(id, 0).events.some((e) => e.type === "status" && (e.message ?? "").includes("executor unreachable")),
      "failure noted",
    );
    expect(gw.pendingApprovals(id)).toEqual([]);
  });
});
