// runGoose integration tests against a stub ACP server (Bun.serve +
// WebSocket). No live goose: every test must fail if the feature it
// covers is deleted. TEST-ONLY sentinel secret, never a real value.

import { beforeEach, describe, expect, test } from "bun:test";
import { clearSessionCacheForTests, runGoose, type AgentEvent } from "./index.js";

/** TEST-ONLY sentinel: asserts the header is sent, never a real secret. */
const SENTINEL = "TEST-ONLY-SENTINEL-SECRET";

type Send = (msg: unknown) => void;
type Ws = { send: (data: string) => void };
type PromptHandler = (ws: Ws, send: Send, msg: { id: number | string; params: Record<string, unknown> }) => void;

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mustPort(p: number | undefined): number {
  if (p === undefined) throw new Error("stub server got no port");
  return p;
}

function chunk(sid: unknown, text: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  };
}

/** Minimal ACP server: handshake + scripted prompt behavior per test. */
class StubAcpServer {
  readonly server;
  readonly port: number;
  seenSecret: string | null = null;
  cancels: unknown[] = [];
  loads: unknown[] = [];
  permissionAnswers: unknown[] = [];
  promptSeen = false;

  constructor(private onPrompt: PromptHandler) {
    const self = this;
    this.server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("websocket only", { status: 426 });
        }
        self.seenSecret = req.headers.get("x-secret-key");
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 500 });
      },
      websocket: {
        message(ws: Ws, data: string) {
          let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
          try {
            msg = JSON.parse(String(data));
          } catch {
            return;
          }
          const send: Send = (m) => ws.send(JSON.stringify(m));
          const result = (r: unknown) => send({ jsonrpc: "2.0", id: msg.id, result: r });
          if (msg.method === "initialize") {
            result({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "stub" } });
            return;
          }
          if (msg.method === "session/new") {
            result({ sessionId: "acp-s1" });
            return;
          }
          if (msg.method === "session/load") {
            self.loads.push(msg.params ?? {});
            result({ sessionId: "acp-s1" });
            return;
          }
          if (msg.method === "session/prompt") {
            self.promptSeen = true;
            self.onPrompt(ws, send, { id: msg.id as number | string, params: msg.params ?? {} });
            return;
          }
          if (msg.method === "session/cancel") {
            self.cancels.push(msg.params ?? {});
            return;
          }
          if (msg.id !== undefined && msg.method === undefined) {
            self.permissionAnswers.push(msg);
          }
        },
      },
    });
    this.port = mustPort(this.server.port);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

function cfg(stub: StubAcpServer) {
  return { baseUrl: stub.url(), secret: SENTINEL, workdir: "/tmp" };
}

beforeEach(() => {
  clearSessionCacheForTests();
});

describe("runGoose round trip", () => {
  test("initialize/new/prompt/chunks/done maps to the exact event sequence", async () => {
    const stub = new StubAcpServer((_ws, send, msg) => {
      send(chunk(msg.params["sessionId"], "hello "));
      send(chunk(msg.params["sessionId"], "world"));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    try {
      const events: AgentEvent[] = [];
      const res = await runGoose({
        config: cfg(stub),
        sessionId: "s1",
        prompt: "say hi",
        timeoutMs: 5000,
        onEvent: (e) => events.push(e),
      });
      expect(res).toEqual({ sawError: false, sawDone: true, aborted: false, timedOut: false });
      expect(events).toEqual([
        { type: "text", sessionId: "s1", delta: "hello world" },
        { type: "done", sessionId: "s1" },
      ]);
      expect(stub.seenSecret).toBe(SENTINEL);
    } finally {
      stub.stop();
    }
  }, 10_000);

  test("prompt usage is forwarded before done", async () => {
    const stub = new StubAcpServer((_ws, send, msg) => {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { totalTokens: 10, inputTokens: 9, outputTokens: 1 } },
      });
    });
    try {
      const events: AgentEvent[] = [];
      await runGoose({ config: cfg(stub), sessionId: "s1", prompt: "hi", timeoutMs: 5000, onEvent: (e) => events.push(e) });
      expect(events).toEqual([
        { type: "usage", sessionId: "s1", inputTokens: 9, outputTokens: 1, totalTokens: 10 },
        { type: "done", sessionId: "s1" },
      ]);
    } finally {
      stub.stop();
    }
  }, 10_000);

  test("a second run reloads the cached session without session/list", async () => {
    const stub = new StubAcpServer((_ws, send, msg) => {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    try {
      const noop = () => {};
      await runGoose({ config: cfg(stub), sessionId: "s1", prompt: "one", timeoutMs: 5000, onEvent: noop });
      expect(stub.loads).toHaveLength(0);
      await runGoose({ config: cfg(stub), sessionId: "s1", prompt: "two", timeoutMs: 5000, onEvent: noop });
      expect(stub.loads).toHaveLength(1);
      expect(stub.loads[0]).toMatchObject({ sessionId: "acp-s1" });
    } finally {
      stub.stop();
    }
  }, 10_000);
});

describe("runGoose chunk coalescing", () => {
  test("10k chars of chunks yield bounded ordered events with full text", async () => {
    const stub = new StubAcpServer((_ws, send, msg) => {
      for (let i = 0; i < 100; i++) send(chunk(msg.params["sessionId"], "x".repeat(100)));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    try {
      const events: AgentEvent[] = [];
      const res = await runGoose({
        config: cfg(stub),
        sessionId: "s1",
        prompt: "flood",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(res.sawDone).toBe(true);
      const texts = events.filter((e) => e.type === "text");
      expect(texts).toHaveLength(34); // ceil(10000/300): 33 full + 100-char tail
      expect(texts.slice(0, -1).every((e) => e.type === "text" && e.delta.length === 300)).toBe(true);
      expect(texts.map((e) => (e.type === "text" ? e.delta : "")).join("")).toBe("x".repeat(10_000));
      expect(events.at(-1)).toEqual({ type: "done", sessionId: "s1" });
    } finally {
      stub.stop();
    }
  }, 15_000);
});

describe("runGoose cancel", () => {
  test("signal aborts via session/cancel and resolves aborted", async () => {
    const stub = new StubAcpServer(() => {
      // Silent: never answer the prompt.
    });
    try {
      const ctl = new AbortController();
      const events: AgentEvent[] = [];
      const p = runGoose({
        config: cfg(stub),
        sessionId: "s1",
        prompt: "hang",
        timeoutMs: 10_000,
        signal: ctl.signal,
        onEvent: (e) => events.push(e),
      });
      await waitFor(() => stub.promptSeen, 3000, "prompt to arrive");
      ctl.abort();
      const res = await p;
      expect(res).toEqual({ sawError: true, sawDone: false, aborted: true, timedOut: false });
      // The cancel frame is sent before close but flushes asynchronously:
      // poll with a deadline instead of assuming it already landed.
      await waitFor(() => stub.cancels.length > 0, 3000, "session/cancel");
      expect(stub.cancels).toEqual([{ sessionId: "acp-s1" }]);
      expect(events.at(-1)).toEqual({ type: "status", sessionId: "s1", status: "error", message: "aborted by user" });
    } finally {
      stub.stop();
    }
  }, 15_000);
});

describe("runGoose permissions", () => {
  test("request_permission maps to approval_request and is answered fail-closed", async () => {
    const stub = new StubAcpServer((ws, send, msg) => {
      const sid = msg.params["sessionId"];
      send({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: { title: "run tests" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { id: "deny", label: "Deny" },
          ],
        },
      });
      void (async () => {
        await waitFor(() => stub.permissionAnswers.length > 0, 3000, "permission answer");
        send(chunk(sid, "ok"));
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      })();
    });
    try {
      const events: AgentEvent[] = [];
      const res = await runGoose({
        config: cfg(stub),
        sessionId: "s1",
        prompt: "do it",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(res.sawDone).toBe(true);
      expect(events[0]).toMatchObject({ type: "approval_request", sessionId: "s1", requestId: "7" });
      const reason = events[0].type === "approval_request" ? events[0].reason : "";
      const detail = events[0].type === "approval_request" ? (events[0].detail ?? "") : "";
      expect(reason).toContain("run tests");
      expect(detail).toContain("Allow once");
      expect(detail).toContain("Deny");
      expect(stub.permissionAnswers).toHaveLength(1);
      expect(stub.permissionAnswers[0]).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { outcome: { outcome: "cancelled" } },
      });
    } finally {
      stub.stop();
    }
  }, 15_000);
});

describe("runGoose timeout and transport errors", () => {
  test("silent server yields a timeout error with timedOut and no hang", async () => {
    const stub = new StubAcpServer(() => {
      // Handshake completes; the prompt is never answered.
    });
    try {
      const events: AgentEvent[] = [];
      const res = await runGoose({
        config: cfg(stub),
        sessionId: "s1",
        prompt: "hang",
        timeoutMs: 300,
        onEvent: (e) => events.push(e),
      });
      expect(res).toEqual({ sawError: true, sawDone: false, aborted: false, timedOut: true });
      expect(events).toContainEqual({ type: "error", sessionId: "s1", message: "run timed out after 300ms" });
      await waitFor(() => stub.cancels.length > 0, 3000, "session/cancel");
      expect(stub.cancels).toEqual([{ sessionId: "acp-s1" }]);
    } finally {
      stub.stop();
    }
  }, 10_000);

  test("connect failure reports an error without ever leaking the secret", async () => {
    const probe = new StubAcpServer(() => {});
    const deadPort = probe.port;
    probe.stop();
    const events: AgentEvent[] = [];
    const res = await runGoose({
      config: { baseUrl: `http://127.0.0.1:${deadPort}`, secret: SENTINEL, workdir: "/tmp" },
      sessionId: "s1",
      prompt: "hi",
      timeoutMs: 3000,
      onEvent: (e) => events.push(e),
    });
    expect(res.sawError).toBe(true);
    expect(res.sawDone).toBe(false);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  }, 10_000);

  test("missing secret fails fast without connecting", async () => {
    const stub = new StubAcpServer((_ws, send, msg) => {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    try {
      const events: AgentEvent[] = [];
      const res = await runGoose({
        config: { baseUrl: stub.url(), secret: "", workdir: "/tmp" },
        sessionId: "s1",
        prompt: "hi",
        timeoutMs: 3000,
        onEvent: (e) => events.push(e),
      });
      expect(res.sawError).toBe(true);
      expect(res.sawDone).toBe(false);
      expect(stub.promptSeen).toBe(false);
    } finally {
      stub.stop();
    }
  }, 10_000);
});
