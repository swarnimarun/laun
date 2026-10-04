import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionRecord } from "@cloudbear/protocol";
import { follow, isTerminal, renderEvent, sessionLine } from "./agent.js";
import { GatewayClient, GatewayError } from "./client.js";
import { main, type Io } from "./index.js";

const record: SessionRecord = {
  id: "s1",
  goal: "fix the failing tests",
  model: "m",
  runtime: "pi",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const seenAuth: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seenAuth.push(req.headers.get("authorization") ?? "");
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (url.pathname !== "/health" && token === "revoked") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, service: "gateway", executor: "http://x" });
      if (url.pathname === "/sessions" && req.method === "GET") return Response.json({ sessions: [record] });
      if (url.pathname === "/sessions" && req.method === "POST") {
        return Response.json(record, { status: 201 });
      }
      if (url.pathname === "/sessions/s1/messages") {
        if (token === "busy") return Response.json({ error: "session already running" }, { status: 409 });
        return Response.json({ accepted: true, sessionId: "s1" });
      }
      if (url.pathname === "/sessions/s1") {
        return Response.json({ session: record, pendingApprovals: [] });
      }
      if (url.pathname === "/sessions/s1/log") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const events: AgentEvent[] =
          since === 0
            ? [
                { type: "text", sessionId: "s1", delta: "hello" },
                { type: "done", sessionId: "s1" },
              ]
            : [];
        return Response.json({ sessionId: "s1", events, next: 2 });
      }
      if (url.pathname === "/keys" && req.method === "POST") {
        if (token === "agent-key") return Response.json({ error: "service token required" }, { status: 403 });
        return Response.json({ key: "cb_aabbccdd_" + "x".repeat(30), record: { id: "aabbccdd", label: "l", createdAt: "now" } }, { status: 201 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("GatewayClient", () => {
  test("sends the bearer token and parses documented routes", async () => {
    seenAuth.length = 0;
    const c = new GatewayClient(base, "cb_aabbccdd_" + "x".repeat(30));
    const { sessions } = await c.listSessions();
    expect(sessions[0]?.id).toBe("s1");
    expect(seenAuth.every((a) => a.startsWith("Bearer cb_"))).toBe(true);
    expect((await c.health()).service).toBe("gateway");
  });

  test("401 and 409 become typed errors with actionable messages", async () => {
    const revoked = new GatewayClient(base, "revoked");
    await expect(revoked.listSessions()).rejects.toThrow(/unauthorized/);
    try {
      await revoked.listSessions();
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).status).toBe(401);
    }
    const busy = new GatewayClient(base, "busy");
    try {
      await busy.sendMessage("s1", "hi");
    } catch (e) {
      expect((e as GatewayError).status).toBe(409);
    }
  });

  test("an unreachable host is reported, not thrown as a raw fetch error", async () => {
    const c = new GatewayClient("http://127.0.0.1:9", "k");
    await expect(c.health()).rejects.toThrow(/cannot reach/);
  });

  test("service-only key routes are rejected for agent keys", async () => {
    const c = new GatewayClient(base, "agent-key");
    try {
      await c.createKey();
    } catch (e) {
      expect((e as GatewayError).status).toBe(403);
    }
  });
});

describe("agent rendering + follow", () => {
  test("renders each event kind and stays quiet on empty status", () => {
    expect(renderEvent({ type: "text", sessionId: "s", delta: "hi" })).toEqual(["hi"]);
    expect(renderEvent({ type: "tool_call", sessionId: "s", name: "bash" })).toEqual(["🔧 bash"]);
    expect(renderEvent({ type: "tool_result", sessionId: "s", name: "bash", ok: true })).toEqual([]);
    expect(renderEvent({ type: "tool_result", sessionId: "s", name: "bash", ok: false, output: "boom" })).toEqual(["⚠️ bash failed: boom"]);
    expect(renderEvent({ type: "status", sessionId: "s", status: "running" })).toEqual([]);
    expect(renderEvent({ type: "status", sessionId: "s", status: "running", message: "compacting" })).toEqual(["· compacting"]);
    expect(renderEvent({ type: "done", sessionId: "s" })).toEqual(["✅ done"]);
    expect(renderEvent({ type: "error", sessionId: "s", message: "nope" })).toEqual(["❌ nope"]);
    expect(renderEvent({ type: "approval_request", sessionId: "s", requestId: "r1", reason: "needs sudo" })).toEqual([
      "🛑 needs sudo",
      "   approve: cloudbear agent approve s r1",
    ]);
  });

  test("session line is one trimmed row", () => {
    expect(sessionLine(record)).toContain("s1");
    expect(sessionLine(record)).toContain("running");
  });

  test("follow stops on done and preserves order", async () => {
    const emitted: AgentEvent[] = [];
    const fake = {
      log: async (_id: string, since: number) => ({
        sessionId: "s1",
        events: since === 0 ? ([{ type: "text", sessionId: "s1", delta: "a" }, { type: "done", sessionId: "s1" }] as AgentEvent[]) : [],
        next: 2,
      }),
    } as unknown as GatewayClient;
    const next = await follow(fake, "s1", { onEvent: (e) => emitted.push(e) });
    expect(next).toBe(2);
    expect(emitted.map((e) => e.type)).toEqual(["text", "done"]);
    expect(isTerminal(emitted[1]!)).toBe(true);
  });

  test("follow stops on error too", async () => {
    const fake = {
      log: async () => ({ sessionId: "s1", events: [{ type: "error", sessionId: "s1", message: "boom" }] as AgentEvent[], next: 1 }),
    } as unknown as GatewayClient;
    expect(await follow(fake, "s1")).toBe(1);
  });

  test("follow gives up after maxMs instead of hanging", async () => {
    let calls = 0;
    const fake = {
      log: async () => {
        calls++;
        return { sessionId: "s1", events: [] as AgentEvent[], next: 0 };
      },
      getSession: async () => ({ session: record, pendingApprovals: [] }),
    } as unknown as GatewayClient;
    await follow(fake, "s1", { maxMs: -1, sleep: async () => {} });
    expect(calls).toBe(1);
  });

  test("follow exits when the session record says done without a terminal event", async () => {
    const fake = {
      log: async () => ({ sessionId: "s1", events: [] as AgentEvent[], next: 0 }),
      getSession: async () => ({ session: { ...record, status: "done" }, pendingApprovals: [] }),
    } as unknown as GatewayClient;
    const seen: AgentEvent[] = [];
    await follow(fake, "s1", { pollMs: 0, maxMs: 60_000, sleep: async () => {}, onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([]);
  });
});

describe("main dispatch", () => {
  function io(): Io & { lines: string[]; errs: string[]; written: string[] } {
    const lines: string[] = [];
    const errs: string[] = [];
    const written: string[] = [];
    return { lines, errs, written, out: (l) => void lines.push(l), err: (l) => void errs.push(l), write: (t) => void written.push(t) };
  }

  test("help and version", async () => {
    const a = io();
    expect(await main(["--help"], {} as NodeJS.ProcessEnv, a)).toBe(0);
    expect(a.lines.join("\n")).toContain("cloudbear setup ssh");
    const b = io();
    expect(await main(["--version"], {} as NodeJS.ProcessEnv, b)).toBe(0);
    expect(b.lines[0]).toContain("cloudbear");
  });

  test("unknown commands exit 2 with usage", async () => {
    const a = io();
    expect(await main(["frobnicate"], {} as NodeJS.ProcessEnv, a)).toBe(2);
    expect(a.errs.join("\n")).toContain("unknown command");
  });

  test("keys commands refuse to run without the service token", async () => {
    const a = io();
    expect(await main(["keys", "ls"], {} as NodeJS.ProcessEnv, a)).toBe(2);
    expect(a.errs.join("\n")).toContain("GATEWAY_TOKEN");
  });

  test("setup ssh requires an identity file", async () => {
    const a = io();
    expect(await main(["setup", "ssh", "1.2.3.4"], {} as NodeJS.ProcessEnv, a)).toBe(2);
    expect(a.errs.join("\n")).toContain("-i <identity>");
  });

  test("agent commands without a target explain how to connect", async () => {
    const a = io();
    // $HOME with no auth file: nothing saved, nothing in env
    const env = { HOME: mkdtempSync(join(tmpdir(), "cb-nohome-")) } as NodeJS.ProcessEnv;
    expect(await main(["agent", "ls"], env, a)).toBe(2);
    expect(a.errs.join("\n")).toContain("agent auth");
  });
});