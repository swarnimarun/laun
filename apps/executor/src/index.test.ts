import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@cloudbear/protocol";
import { loadConfig } from "./config.js";
import { assertValidPrompt, assertValidSessionId, clampTimeout, resolveWorkdir } from "./paths.js";
import { buildPiArgs, MAX_TOOL_OUTPUT, parsePiJsonLine, runPiStreaming } from "./pi.js";
import { buildRpcArgs, RpcManager } from "./rpc.js";
import { createHandler } from "./server.js";

describe("executor config", () => {
  test("requires GATEWAY_TOKEN", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow("GATEWAY_TOKEN");
  });

  test("openshell without prefix fails closed", () => {
    expect(() =>
      loadConfig({ GATEWAY_TOKEN: "x", OPENSHELL_ENABLED: "true" } as NodeJS.ProcessEnv),
    ).toThrow("OPENSHELL_PREFIX");
  });

  test("loads minimal config", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "secret" } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(8081);
    expect(cfg.piBin).toBe("pi");
    expect(cfg.openshellEnabled).toBe(false);
  });
});

describe("paths", () => {
  test("rejects bad session ids", () => {
    expect(() => assertValidSessionId("../evil")).toThrow();
    expect(() => assertValidSessionId("")).toThrow();
    assertValidSessionId("abc-123_X");
  });

  test("rejects empty/oversize prompts", () => {
    expect(() => assertValidPrompt("  ")).toThrow();
    expect(() => assertValidPrompt("x".repeat(8001))).toThrow();
  });

  test("workdir stays inside sessionDir", () => {
    const w = resolveWorkdir("./data/sessions", "abc");
    expect(w.endsWith("abc/work")).toBe(true);
    expect(() => resolveWorkdir("./data/sessions", "..")).toThrow();
  });

  test("clampTimeout bounds", () => {
    expect(clampTimeout(1_000, 600_000)).toBe(30_000);
    expect(clampTimeout(99_999_999, 600_000)).toBe(1_800_000);
    expect(clampTimeout(undefined, 600_000)).toBe(600_000);
  });
});

describe("pi", () => {
  test("buildPiArgs uses print+json+session flags", () => {
    const args = buildPiArgs({ sessionId: "s1", piSessionDir: "/d/s1", model: "opencode-go/muse-spark-1.3-contributor", prompt: "hi" });
    expect(args).toEqual([
      "-p",
      "--mode",
      "json",
      "--session-id",
      "s1",
      "--session-dir",
      "/d/s1",
      "--model",
      "opencode-go/muse-spark-1.3-contributor",
      "--",
      "hi",
    ]);
  });

  test("parsePiJsonLine maps generic shapes", () => {
    const sid = "s1";
    expect(parsePiJsonLine(`{"type":"text","text":"hello"}`, sid)).toEqual({ type: "text", sessionId: sid, delta: "hello" });
    expect(parsePiJsonLine(`{"type":"tool_call","name":"bash","args":{"cmd":"ls"}}`, sid)).toEqual({
      type: "tool_call",
      sessionId: sid,
      name: "bash",
      args: { cmd: "ls" },
    });
    expect(parsePiJsonLine(`{"type":"mystery","n":1}`, sid)).toBeNull();
    expect(parsePiJsonLine(`plain log line`, sid)).toEqual({ type: "text", sessionId: sid, delta: "plain log line" });
    expect(parsePiJsonLine(`   `, sid)).toBeNull();
  });

  test("parsePiJsonLine maps real pi wire events", () => {
    const sid = "s1";
    // streaming text
    expect(
      parsePiJsonLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"hi"}}`, sid),
    ).toEqual({ type: "text", sessionId: sid, delta: "hi" });
    // thinking + text_end + turn_end are deduped away (covered by deltas / ignored)
    expect(parsePiJsonLine(`{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}`, sid)).toBeNull();
    expect(parsePiJsonLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"hi"}}`, sid)).toBeNull();
    expect(parsePiJsonLine(`{"type":"turn_end","message":{"role":"assistant","content":[]}}`, sid)).toBeNull();
    // lifecycle noise
    for (const t of ["session", "agent_start", "turn_start", "message_start", "message_end", "tool_execution_update"]) {
      expect(parsePiJsonLine(`{"type":"${t}"}`, sid)).toBeNull();
    }
    // tool calls with args + results
    expect(
      parsePiJsonLine(`{"type":"tool_execution_start","toolCallId":"c1","toolName":"read","args":{"path":"a.txt"}}`, sid),
    ).toEqual({ type: "tool_call", sessionId: sid, name: "read", args: { path: "a.txt" } });
    expect(
      parsePiJsonLine(
        `{"type":"tool_execution_end","toolCallId":"c1","toolName":"read","result":{"content":[{"type":"text","text":"hello"}]},"isError":false}`,
        sid,
      ),
    ).toEqual({ type: "tool_result", sessionId: sid, name: "read", ok: true, output: "hello" });
    const errRes = parsePiJsonLine(
      `{"type":"tool_execution_end","toolCallId":"c1","toolName":"read","result":{"content":[{"type":"text","text":"nope"}]},"isError":true}`,
      sid,
    );
    expect(errRes?.type).toBe("tool_result");
    if (errRes?.type === "tool_result") expect(errRes.ok).toBe(false);
    // agent_end can be followed by retries/compaction, so only agent_settled ends a run
    expect(parsePiJsonLine(`{"type":"agent_end","messages":[],"willRetry":false}`, sid)).toBeNull();
    expect(parsePiJsonLine(`{"type":"agent_settled"}`, sid)).toEqual({ type: "done", sessionId: sid });
  });

  test("parsePiJsonLine surfaces failures that exit 0", () => {
    const sid = "s1";
    // pi exits 0 for a failed or aborted assistant response.
    expect(parsePiJsonLine(`{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}`, sid)).toEqual({
      type: "error",
      sessionId: sid,
      message: "assistant response error",
    });
    expect(parsePiJsonLine(`{"type":"message_end","message":{"role":"assistant","stopReason":"aborted"}}`, sid)?.type).toBe("error");
    // normal assistant stop is not an error
    expect(parsePiJsonLine(`{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}`, sid)).toBeNull();
    // user messages are not errors
    expect(parsePiJsonLine(`{"type":"message_end","message":{"role":"user","stopReason":"error"}}`, sid)).toBeNull();
    // provider stream error inside message_update
    expect(
      parsePiJsonLine(`{"type":"message_update","assistantMessageEvent":{"type":"error","reason":"aborted","error":"upstream 500"}}`, sid),
    ).toEqual({ type: "error", sessionId: sid, message: "upstream 500" });
    expect(parsePiJsonLine(`{"type":"extension_error","error":"boom"}`, sid)).toEqual({ type: "error", sessionId: sid, message: "boom" });
  });

  test("parsePiJsonLine reports compaction and retries as status", () => {
    const sid = "s1";
    expect(parsePiJsonLine(`{"type":"compaction_start","reason":"threshold"}`, sid)).toEqual({
      type: "status",
      sessionId: sid,
      status: "running",
      message: "compacting (threshold)",
    });
    expect(parsePiJsonLine(`{"type":"compaction_end","reason":"threshold","result":{"summary":"s"}}`, sid)).toEqual({
      type: "status",
      sessionId: sid,
      status: "running",
      message: "compacted",
    });
    expect(parsePiJsonLine(`{"type":"compaction_end","reason":"threshold","aborted":false,"errorMessage":"nope"}`, sid)).toEqual({
      type: "error",
      sessionId: sid,
      message: "compaction failed: nope",
    });
    expect(parsePiJsonLine(`{"type":"auto_retry_end","success":false,"finalError":"529"}`, sid)).toEqual({
      type: "error",
      sessionId: sid,
      message: "retries exhausted: 529",
    });
    expect(parsePiJsonLine(`{"type":"auto_retry_end","success":true}`, sid)).toBeNull();
  });

  test("parsePiJsonLine truncates huge tool output", () => {
    const big = "x".repeat(MAX_TOOL_OUTPUT + 100);
    const ev = parsePiJsonLine(
      JSON.stringify({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [{ type: "text", text: big }] } }),
      "s1",
    );
    expect(ev?.type).toBe("tool_result");
    const out = (ev as { output: string }).output;
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT + 20);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});

describe("runPiStreaming (stub binaries, no model needed)", () => {
  const base = {
    sessionId: "s1",
    model: "x",
    prompt: "hi",
    openshellPrefix: [] as string[],
    timeoutMs: 10_000,
  };

  test("exit 0 resolves cleanly with no events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-pi-"));
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({ ...base, piBin: "true", piSessionDir: dir, workdir: dir, onEvent: (e) => events.push(e) });
    expect(r.exitCode).toBe(0);
    expect(r.sawError).toBe(false);
    expect(r.sawDone).toBe(false);
    expect(events).toEqual([]);
  });

  test("non-zero exit emits an error event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-pi-"));
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({ ...base, piBin: "false", piSessionDir: dir, workdir: dir, onEvent: (e) => events.push(e) });
    expect(r.exitCode).toBe(1);
    expect(r.sawError).toBe(true);
    expect(events.some((e) => e.type === "error" && e.message.includes("code 1"))).toBe(true);
  });

  test("missing binary emits a start error, not a hang", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-pi-"));
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({
      ...base,
      piBin: "cloudbear-definitely-not-a-binary",
      piSessionDir: dir,
      workdir: dir,
      timeoutMs: 5000,
      onEvent: (e) => events.push(e),
    });
    expect(r.exitCode).toBeNull();
    expect(r.sawError).toBe(true);
    expect(events.some((e) => e.type === "error" && e.message.includes("failed to start"))).toBe(true);
  });

  test("child stdin is not left open (an open pipe makes pi wait for EOF)", async () => {
    // Regression: spawn() defaults stdin to a pipe nobody closes, and pi 1.0.2
    // blocks until EOF — every run hung forever with no output. The stub only
    // reaches its done event if stdin is already at EOF (i.e. "ignore").
    const dir = mkdtempSync(join(tmpdir(), "cb-stdin-"));
    const stub = join(dir, "stub.sh");
    writeFileSync(stub, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"agent_settled"}\'\nexit 0\n');
    chmodSync(stub, 0o755);
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({
      ...base,
      piBin: stub,
      piSessionDir: dir,
      workdir: dir,
      timeoutMs: 8000,
      onEvent: (e) => events.push(e),
    });
    expect(r.exitCode).toBe(0);
    expect(r.sawDone).toBe(true);
    expect(r.sawError).toBe(false);
  });
});

describe("POST /run terminal status (stub binaries)", () => {
  function testHandler(piBin: string) {
    const dir = mkdtempSync(join(tmpdir(), "cb-run-"));
    return createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin,
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [],
      defaultTimeoutMs: 30_000,
    });
  }

  async function run(handler: ReturnType<typeof testHandler>): Promise<AgentEvent[]> {
    const res = await handler.handleRun(
      new Request("http://x/run", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(200);
    return (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AgentEvent);
  }

  test("failing agent ends with status error, never done", async () => {
    const events = await run(testHandler("false"));
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
    expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(false);
  });

  test("clean agent ends with status done", async () => {
    const events = await run(testHandler("true"));
    expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(true);
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(false);
  });

  test("a consumer that disconnects mid-run does not crash the run", async () => {
    // Regression: enqueue() after the consumer cancelled threw "Invalid state:
    // Controller is already closed" from pi's stdout handler, which took down
    // the whole executor process — every in-flight run with it.
    const dir = mkdtempSync(join(tmpdir(), "cb-cancel-"));
    const stub = join(dir, "slow.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        "echo '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"first\"}}'\n" +
        "sleep 1\n" +
        "echo '{\"type\":\"agent_settled\"}'\n",
    );
    chmodSync(stub, 0o755);
    const handler = createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin: stub,
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [],
      defaultTimeoutMs: 30_000,
    });
    const res = await handler.handleRun(
      new Request("http://x/run", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "scancel", prompt: "hi" }),
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // first event arrives
    await reader.cancel(); // consumer goes away while the agent keeps emitting
    await new Promise((r) => setTimeout(r, 2500));
    expect(handler.busy.size).toBe(0); // run completed instead of crashing
  });

  test("rejects a bad bearer token before spawning", async () => {
    const handler = testHandler("true");
    const res = await handler.handleRun(
      new Request("http://x/run", {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("executor config rpc", () => {
  test("defaults to json mode and 300s idle TTL", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "secret" } as NodeJS.ProcessEnv);
    expect(cfg.executorMode).toBe("json");
    expect(cfg.rpcIdleTtlMs).toBe(300_000);
  });

  test("parses rpc mode and custom TTL", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "s", EXECUTOR_MODE: "rpc", RPC_IDLE_TTL_MS: "5000" } as NodeJS.ProcessEnv);
    expect(cfg.executorMode).toBe("rpc");
    expect(cfg.rpcIdleTtlMs).toBe(5000);
  });

  test("rejects invalid EXECUTOR_MODE", () => {
    expect(() => loadConfig({ GATEWAY_TOKEN: "s", EXECUTOR_MODE: "bogus" } as NodeJS.ProcessEnv)).toThrow("EXECUTOR_MODE");
  });

  test("buildRpcArgs uses rpc+session flags", () => {
    expect(buildRpcArgs({ sessionId: "s1", piSessionDir: "/d/s1", model: "m" })).toEqual([
      "--mode",
      "rpc",
      "--session-id",
      "s1",
      "--session-dir",
      "/d/s1",
      "--model",
      "m",
    ]);
  });
});

// Helpers for rpc stub children (no model or network needed). Stubs speak
// strict JSONL on stdin/stdout split only on LF and log every command line
// they receive so tests can assert set_auto_retry / get_state / steer.
function writeRpcStub(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

function basicRpcStub(): string {
  return (
    "#!/bin/sh\n" +
    'LOG="${RPC_LOG:-/dev/null}"\n' +
    'while IFS= read -r line; do\n' +
    '  echo "$line" >> "$LOG"\n' +
    '  case "$line" in\n' +
    "    *set_auto_retry*) ;;\n" +
    '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
    '    *prompt*)\n' +
    '      echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello rpc"}}\';\n' +
    '      echo \'{"type":"agent_end","willRetry":false}\';\n' +
    '      echo \'{"type":"agent_settled"}\';\n' +
    "      ;;\n" +
    '    *abort*) echo \'{"type":"agent_settled"}\' ;;\n' +
    "  esac\n" +
    "done\n"
  );
}

function rpcHandler(dir: string, piBin: string, extra: Record<string, unknown> = {}) {
  return createHandler({
    port: 0,
    gatewayToken: "t",
    sessionDir: dir,
    piBin,
    defaultModel: "m",
    openshellEnabled: false,
    openshellPrefix: [],
    defaultTimeoutMs: 30_000,
    executorMode: "rpc",
    rpcIdleTtlMs: 300_000,
    ...extra,
  } as Parameters<typeof createHandler>[0]);
}

async function readNdjson(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AgentEvent);
}

/** Poll `cond` every 25ms until true or 5s elapses (throws on timeout). */
async function pollFor(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("rpc mode: prompt -> agent_settled (stub child)", () => {
  test("prompt streams text and completes only on agent_settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-basic-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      process.env["RPC_LOG"] = log;
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(true);
      expect(r.sawError).toBe(false);
      expect(events.some((e) => e.type === "text" && (e as { delta: string }).delta === "hello rpc")).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(true);
      // agent_end is ignored: only one done (from agent_settled).
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain("set_auto_retry");
      expect(logged).toContain("get_state");
      expect(logged).toContain('"type":"prompt"');
    } finally {
      delete process.env["RPC_LOG"];
      mgr.close();
    }
  });

  test("agent_end alone never completes a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-noend-"));
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*) echo \'{"type":"agent_end","willRetry":false}\'; sleep 3 ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 1200,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(false);
      expect(r.timedOut).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(false);
    } finally {
      mgr.close();
    }
  });

  test("strict LF framing preserves U+2028 inside JSON strings", async () => {
    // pi docs warn against readline: it also splits on U+2028/U+2029, which
    // are valid inside JSON strings. A delta containing U+2028 must arrive
    // intact in a single text event.
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-u2028-"));
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "a b" },
    });
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        `    *prompt*) echo '${line}'; echo '{"type":"agent_settled"}'; ;;\n` +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(true);
      const text = events.find((e) => e.type === "text");
      expect(text).toBeDefined();
      expect((text as { delta: string }).delta).toBe("a b");
    } finally {
      mgr.close();
    }
  });

  test("provider error with retry heals to done and surfaces retry status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-retry-"));
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*)\n' +
        '      echo \'{"type":"message_update","assistantMessageEvent":{"type":"error","reason":"socket","error":"The socket connection was closed unexpectedly"}}\';\n' +
        '      echo \'{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"errorMessage":"socket closed"}\';\n' +
        '      echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"recovered"}}\';\n' +
        '      echo \'{"type":"agent_settled"}\';\n' +
        "      ;;\n" +
        '    *abort*) echo \'{"type":"agent_settled"}\' ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(events.some((e) => e.type === "status" && (e as { message?: string }).message?.includes("retrying"))).toBe(true);
      // Healed: retry forgives the transient error, settled completes as done.
      expect(r.sawDone).toBe(true);
      expect(r.sawError).toBe(false);
    } finally {
      mgr.close();
    }
  });

  test("exhausted retries surface an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-exhaust-"));
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*)\n' +
        '      echo \'{"type":"auto_retry_start","attempt":3,"maxAttempts":3,"errorMessage":"529"}\';\n' +
        '      echo \'{"type":"auto_retry_end","success":false,"finalError":"529"}\';\n' +
        '      echo \'{"type":"agent_settled"}\';\n' +
        "      ;;\n" +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("529"))).toBe(true);
      expect(r.sawError).toBe(true);
    } finally {
      mgr.close();
    }
  });

  test("reuses the same child across runs and reaps it after idle TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-reuse-"));
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 250 });
    try {
      await mgr.run({ sessionId: "s1", piSessionDir: dir, workdir: dir, model: "m", prompt: "one", timeoutMs: 10_000, onEvent: () => {} });
      const pid1 = mgr.pidOf("s1");
      expect(pid1).toBeDefined();
      await mgr.run({ sessionId: "s1", piSessionDir: dir, workdir: dir, model: "m", prompt: "two", timeoutMs: 10_000, onEvent: () => {} });
      expect(mgr.pidOf("s1")).toBe(pid1);
      await new Promise((r) => setTimeout(r, 700));
      expect(mgr.has("s1")).toBe(false);
      await mgr.run({ sessionId: "s1", piSessionDir: dir, workdir: dir, model: "m", prompt: "three", timeoutMs: 10_000, onEvent: () => {} });
      expect(mgr.has("s1")).toBe(true);
      expect(mgr.pidOf("s1")).not.toBe(pid1);
    } finally {
      mgr.close();
    }
  });

  test("openshell prefix applies to the rpc child argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-shell-"));
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const ok = new RpcManager({ piBin: stub, openshellPrefix: ["env"], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await ok.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(true);
    } finally {
      ok.close();
    }
    // A prefix that replaces the command proves it is really prepended.
    const bad = new RpcManager({ piBin: stub, openshellPrefix: ["false"], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await bad.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 5000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(false);
    } finally {
      bad.close();
    }
  });

  test("uses steer when pi reports streaming", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-steer-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'LOG="${RPC_LOG:-/dev/null}"\n' +
        'while IFS= read -r line; do\n' +
        '  echo "$line" >> "$LOG"\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":true}\' ;;\n' +
        '    *prompt*) echo \'{"type":"agent_settled"}\' ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      process.env["RPC_LOG"] = log;
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: () => {},
      });
      expect(r.sawDone).toBe(true);
      expect(readFileSync(log, "utf8")).toContain("steer");
    } finally {
      delete process.env["RPC_LOG"];
      mgr.close();
    }
  });
});

describe("POST /run in rpc mode", () => {
  test("prompt streams NDJSON and ends with done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-run-"));
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const handler = rpcHandler(dir, stub);
    try {
      const res = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1", prompt: "hi" }),
        }),
      );
      expect(res.status).toBe(200);
      const events = await readNdjson(res);
      expect(events[0]).toMatchObject({ type: "status", status: "running" });
      expect(events.some((e) => e.type === "text")).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
      expect(handler.busy.size).toBe(0);
    } finally {
      handler.close();
    }
  });

  test("concurrent run returns 409", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-busy-"));
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*) echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"working"}}\'; sleep 2; echo \'{"type":"agent_settled"}\'; ;;\n' +
        '    *abort*) echo \'{"type":"agent_settled"}\' ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const handler = rpcHandler(dir, stub);
    try {
      const first = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1", prompt: "hi" }),
        }),
      );
      expect(first.status).toBe(200);
      const textP = first.text(); // start consuming so the run proceeds
      await new Promise((r) => setTimeout(r, 400));
      const second = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1", prompt: "again" }),
        }),
      );
      expect(second.status).toBe(409);
      await textP;
      expect(handler.busy.size).toBe(0);
    } finally {
      handler.close();
    }
  });

  test("a consumer that disconnects mid-run does not crash the rpc run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-cancel-"));
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*) echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"first"}}\'; sleep 1; echo \'{"type":"agent_settled"}\'; ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const handler = rpcHandler(dir, stub);
    try {
      const res = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "scancel", prompt: "hi" }),
        }),
      );
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      // Poll for run completion instead of a fixed sleep: spawn overhead
      // varies (~0.6s here), so a fixed delay is flaky under load.
      await pollFor(() => handler.busy.size === 0, "rpc run completion after disconnect");
      expect(handler.busy.size).toBe(0);
    } finally {
      handler.close();
    }
  });
});

describe("POST /abort", () => {
  function slowJsonStub(dir: string): string {
    const stub = join(dir, "slow.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        // Touch a sentinel so the test can poll for startup instead of
        // sleeping a fixed wall-clock delay before aborting.
        `touch "${join(dir, "started")}"\n` +
        "echo '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"working\"}}'\n" +
        // Sleep well past the abort (sent on startup poll, ~0.6s here): a
        // missing kill lets the stub reach settled and flips the terminal
        // assertions below from error to done. Note the SIGKILLed shell
        // leaves its `sleep` orphan holding the stdout pipe, so stream
        // close still waits out the sleep; keep it short enough for the
        // 5s test budget with margin.
        "sleep 2\n" +
        "echo '{\"type\":\"agent_settled\"}'\n",
    );
    chmodSync(stub, 0o755);
    return stub;
  }

  function slowRpcStub(dir: string): string {
    return writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'LOG="${RPC_LOG:-/dev/null}"\n' +
        'while IFS= read -r line; do\n' +
        '  echo "$line" >> "$LOG"\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*) echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"working"}}\'; sleep 2; echo \'{"type":"agent_settled"}\'; ;;\n' +
        '    *abort*) echo \'{"type":"agent_settled"}\' ;;\n' +
        "  esac\n" +
        "done\n",
    );
  }

  test("json mode: abort returns 200 and emits aborted status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-abort-json-"));
    const handler = createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin: slowJsonStub(dir),
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [],
      defaultTimeoutMs: 30_000,
    });
    const res = await handler.handleRun(
      new Request("http://x/run", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sabort", prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(200);
    const textP = res.text();
    // Wait for the child to actually start (sentinel), not a fixed sleep.
    await pollFor(() => existsSync(join(dir, "started")), "json stub startup");
    const abortRes = await handler.handleAbort(
      new Request("http://x/abort", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sabort" }),
      }),
    );
    expect(abortRes.status).toBe(200);
    expect(await abortRes.json()).toEqual({ ok: true });
    const events = (await textP).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
    expect(events.some((e) => e.type === "status" && (e as { message?: string }).message === "aborted by user")).toBe(true);
    // Proves the child actually died: without the SIGKILL the 5s stub
    // would run to agent_settled and the stream would end done, not error.
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(false);
    expect(events.some((e) => e.type === "status" && e.status === "error")).toBe(true);
    // Never leaves busy set, even with the kill racing the run.
    expect(handler.busy.size).toBe(0);
    handler.close();
  });

  test("rpc mode: abort returns 200, emits aborted status, keeps child for reuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-abort-rpc-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const handler = rpcHandler(dir, slowRpcStub(dir));
    process.env["RPC_LOG"] = log;
    try {
      const res = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sabort", prompt: "hi" }),
        }),
      );
      expect(res.status).toBe(200);
      const textP = res.text();
      // Poll until the prompt reached the child (no fixed sleep).
      await pollFor(() => readFileSync(log, "utf8").includes('"type":"prompt"'), "rpc prompt delivery");
      const pidBefore = handler.rpc.pidOf("sabort");
      expect(pidBefore).toBeDefined();
      const abortRes = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sabort" }),
        }),
      );
      expect(abortRes.status).toBe(200);
      expect(await abortRes.json()).toEqual({ ok: true });
      expect(handler.busy.size).toBe(0);
      const events = (await textP).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.some((e) => e.type === "status" && (e as { message?: string }).message === "aborted by user")).toBe(true);
      // Proves the abort command actually reached the child: without the
      // writeJson({type:"abort"}) the stub log would contain only prompt.
      await pollFor(() => readFileSync(log, "utf8").includes('"type":"abort"'), "rpc abort delivery");
      expect(readFileSync(log, "utf8")).toContain('"type":"abort"');
      // Abort resolves the run but keeps the long-lived child (same pid, idle).
      expect(handler.rpc.has("sabort")).toBe(true);
      expect(handler.rpc.isRunning("sabort")).toBe(false);
      expect(handler.rpc.pidOf("sabort")).toBe(pidBefore);
    } finally {
      delete process.env["RPC_LOG"];
      handler.close();
    }
  });

  test("a stale settled from an aborted run never completes the next run", async () => {
    // Regression for the abort/timeout race: abort() resolves immediately
    // while pi still owes a trailing settled. The next prompt must gate
    // until that stale event is consumed idle; otherwise it lands mid-run
    // and completes the new generation early with a false sawDone.
    const dir = mkdtempSync(join(tmpdir(), "cb-rpc-stale-"));
    const marker = join(dir, "order.log");
    writeFileSync(marker, "");
    const stub = writeRpcStub(
      dir,
      "rpc.js",
      "#!/usr/bin/env bun\n" +
        'import { appendFileSync } from "node:fs";\n' +
        'const marker = process.env.RPC_MARKER ?? "/dev/null";\n' +
        'let buf = "";\n' +
        'process.stdin.setEncoding("utf8");\n' +
        'process.stdin.on("data", (c) => {\n' +
        "  buf += c;\n" +
        "  let i;\n" +
        '  while ((i = buf.indexOf("\\n")) >= 0) {\n' +
        "    const line = buf.slice(0, i);\n" +
        "    buf = buf.slice(i + 1);\n" +
        "    if (!line.trim()) continue;\n" +
        "    let m = null;\n" +
        "    try { m = JSON.parse(line); } catch { continue; }\n" +
        '    if (m.type === "set_auto_retry") continue;\n' +
        '    if (m.type === "get_state") {\n' +
        '      const r = typeof m.id === "string" ? { id: m.id, type: "state", isStreaming: false } : { type: "state", isStreaming: false };\n' +
        '      process.stdout.write(JSON.stringify(r) + "\\n");\n' +
        "      continue;\n" +
        "    }\n" +
        '    if (m.type === "abort") {\n' +
        "      setTimeout(() => {\n" +
        "        appendFileSync(marker, \"STALE\\n\");\n" +
        "        process.stdout.write('{\"type\":\"agent_settled\"}\\n');\n" +
        "      }, 800);\n" +
        "      continue;\n" +
        "    }\n" +
        '    if (m.type === "prompt") {\n' +
        '      const t = typeof m.message === "string" ? m.message : "";\n' +
        '      if (t.includes("first")) {\n' +
        `        process.stdout.write('{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"first-working\"}}\\n');\n` +
        "        continue;\n" +
        "      }\n" +
        '      if (t.includes("second")) {\n' +
        '        appendFileSync(marker, "PROMPT2\\n");\n' +
        "        setTimeout(() => {\n" +
        `          process.stdout.write('{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"second-ok\"}}\\n');\n` +
        "          process.stdout.write('{\"type\":\"agent_settled\"}\\n');\n" +
        "        }, 1000);\n" +
        "        continue;\n" +
        "      }\n" +
        "      process.stdout.write('{\"type\":\"agent_settled\"}\\n');\n" +
        "      continue;\n" +
        "    }\n" +
        "  }\n" +
        "});\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    process.env["RPC_MARKER"] = marker;
    try {
      const firstEvents: AgentEvent[] = [];
      const p1 = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "first",
        timeoutMs: 15_000,
        onEvent: (e) => firstEvents.push(e),
      });
      await pollFor(() => firstEvents.some((e) => e.type === "text"), "first prompt delivery");
      expect(mgr.abort("s1")).toBe(true);
      const r1 = await p1;
      expect(r1.aborted).toBe(true);
      // Immediately start the next generation with no sleep: the stub's
      // stale settled for the abort is still in flight (800ms).
      const secondEvents: AgentEvent[] = [];
      const r2 = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "second",
        timeoutMs: 15_000,
        onEvent: (e) => secondEvents.push(e),
      });
      // Without the fix this completes early on the stale event and never
      // sees the second generation's own output. Content (not timing)
      // proves correct attribution.
      expect(r2.sawDone).toBe(true);
      expect(r2.sawError).toBe(false);
      expect(secondEvents.some((e) => e.type === "text" && (e as { delta: string }).delta === "second-ok")).toBe(true);
      // Proves the gate itself: the second prompt must reach the child only
      // after the stale settled was emitted (consumed idle before sending).
      // Without gating, PROMPT2 lands first and this ordering flips.
      const order = readFileSync(marker, "utf8");
      expect(order.indexOf("STALE") >= 0 && order.indexOf("PROMPT2") >= 0).toBe(true);
      expect(order.indexOf("STALE")).toBeLessThan(order.indexOf("PROMPT2"));
    } finally {
      delete process.env["RPC_MARKER"];
      mgr.close();
    }
  });

  test("abort returns 404 for unknown sessions and 409 when idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-abort-codes-"));
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const handler = rpcHandler(dir, stub);
    try {
      const unknown = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "never-seen-xyz" }),
        }),
      );
      expect(unknown.status).toBe(404);
      // Known (ran once, now idle) but not running -> 409.
      const runRes = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sidle", prompt: "hi" }),
        }),
      );
      await readNdjson(runRes);
      const idle = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sidle" }),
        }),
      );
      expect(idle.status).toBe(409);
      expect(await idle.json()).toEqual({ error: "session not running" });
    } finally {
      handler.close();
    }
  });

  test("abort validates auth and body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-abort-auth-"));
    const handler = rpcHandler(dir, writeRpcStub(dir, "rpc.sh", basicRpcStub()));
    try {
      const badToken = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer nope", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s1" }),
        }),
      );
      expect(badToken.status).toBe(401);
      const badBody = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "../evil" }),
        }),
      );
      expect(badBody.status).toBe(400);
    } finally {
      handler.close();
    }
  });
});

describe("json mode unchanged (regression)", () => {
  test("one-shot json emits the exact NDJSON byte sequence", async () => {
    // Independent of the lane under test: a fixed shell stub must produce
    // these exact bytes. Comparing two handlers built from the same code
    // would pass even if the json path had diverged, so the bytes below
    // are the spec (captured from the parent's one-shot behaviour).
    const dir = mkdtempSync(join(tmpdir(), "cb-json-compat-"));
    const stub = join(dir, "ok.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        "echo '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"hi\"}}'\n" +
        "echo '{\"type\":\"agent_settled\"}'\n",
    );
    chmodSync(stub, 0o755);
    const handler = createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin: stub,
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [] as string[],
      defaultTimeoutMs: 30_000,
    });
    try {
      const res = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "scompat", prompt: "hi" }),
        }),
      );
      expect(res.status).toBe(200);
      const expected =
        '{"type":"status","sessionId":"scompat","status":"running","message":"model m"}\n' +
        '{"type":"text","sessionId":"scompat","delta":"hi"}\n' +
        '{"type":"done","sessionId":"scompat"}\n' +
        '{"type":"status","sessionId":"scompat","status":"done"}\n';
      expect(await res.text()).toBe(expected);
    } finally {
      handler.close();
    }
  });

  test("default handler stays byte-for-byte compatible with one-shot json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-json-compat-"));
    const stub = join(dir, "ok.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        "echo '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"hi\"}}'\n" +
        "echo '{\"type\":\"agent_settled\"}'\n",
    );
    chmodSync(stub, 0o755);
    const base = {
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin: stub,
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [] as string[],
      defaultTimeoutMs: 30_000,
    };
    const implicit = createHandler({ ...base });
    const explicit = createHandler({ ...base, executorMode: "json" as const });
    async function eventsFor(h: ReturnType<typeof createHandler>, sessionId: string): Promise<string> {
      const res = await h.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId, prompt: "hi" }),
        }),
      );
      return await res.text();
    }
    // Same sessionId sequentially: one-shot json has no persistent child, so
    // both handlers must produce byte-identical NDJSON.
    expect(await eventsFor(implicit, "scompat")).toBe(await eventsFor(explicit, "scompat"));
    implicit.close();
    explicit.close();
  });
});

