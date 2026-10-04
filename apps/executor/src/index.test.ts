import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@cloudbear/protocol";
import { loadConfig } from "./config.js";
import { assertValidPrompt, assertValidSessionId, clampTimeout, resolveWorkdir } from "./paths.js";
import {
  buildPiArgs,
  extractThinkingText,
  handlePiLine,
  MAX_TOOL_OUTPUT,
  parsePiJsonLine,
  parsePiUsageLine,
  runPiStreaming,
  THINKING_FLUSH_CHARS,
  ThinkingCoalescer,
} from "./pi.js";
import { buildRpcArgs, RpcManager } from "./rpc.js";
import {
  DEFAULT_RECOVERY_ATTEMPTS,
  DEFAULT_RECOVERY_BACKOFF_MS,
  RECOVERY_CONTINUATION_PROMPT,
  recoveryExhaustedMessage,
  retryingMessage,
  runWithRecovery,
  sleepAbortable,
  type RecoveryAttemptResult,
} from "./recovery.js";
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
    // Poll for the run to finish rather than sleeping a fixed amount: under load
    // 2.5s was not always enough, which made this test flaky in CI.
    const deadline = Date.now() + 20_000;
    while (handler.busy.size !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
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
  }, 30_000);

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


describe("recovery config", () => {
  test("defaults to 2 attempts and 2000ms backoff", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "s" } as NodeJS.ProcessEnv);
    expect(cfg.recoveryAttempts).toBe(2);
    expect(cfg.recoveryBackoffMs).toBe(2000);
    expect(DEFAULT_RECOVERY_ATTEMPTS).toBe(2);
    expect(DEFAULT_RECOVERY_BACKOFF_MS).toBe(2000);
  });

  test("parses custom recovery values, including 0 (disabled)", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "s", RUN_RECOVERY_ATTEMPTS: "0", RUN_RECOVERY_BACKOFF_MS: "0" } as NodeJS.ProcessEnv);
    expect(cfg.recoveryAttempts).toBe(0);
    expect(cfg.recoveryBackoffMs).toBe(0);
    const cfg2 = loadConfig({
      GATEWAY_TOKEN: "s",
      RUN_RECOVERY_ATTEMPTS: "10",
      RUN_RECOVERY_BACKOFF_MS: "60000",
    } as NodeJS.ProcessEnv);
    expect(cfg2.recoveryAttempts).toBe(10);
    expect(cfg2.recoveryBackoffMs).toBe(60000);
  });

  test("rejects out-of-range recovery values", () => {
    for (const v of ["-1", "11", "nope", "1.5"]) {
      expect(() => loadConfig({ GATEWAY_TOKEN: "s", RUN_RECOVERY_ATTEMPTS: v } as NodeJS.ProcessEnv)).toThrow(
        "RUN_RECOVERY_ATTEMPTS",
      );
    }
    for (const v of ["-1", "60001", "nope"]) {
      expect(() => loadConfig({ GATEWAY_TOKEN: "s", RUN_RECOVERY_BACKOFF_MS: v } as NodeJS.ProcessEnv)).toThrow(
        "RUN_RECOVERY_BACKOFF_MS",
      );
    }
  });
});

describe("runWithRecovery (unit)", () => {
  const okNext =
    (prompts: string[], script: RecoveryAttemptResult[]): ((prompt: string, timeoutMs: number) => Promise<RecoveryAttemptResult>) =>
    async (prompt) => {
      prompts.push(prompt);
      return script[Math.min(prompts.length - 1, script.length - 1)]!;
    };
  const fail = (msg = "boom"): RecoveryAttemptResult => ({ sawError: true, sawDone: false, aborted: false, firstError: msg });
  const done: RecoveryAttemptResult = { sawError: false, sawDone: true, aborted: false, firstError: null };
  const loopOpts = (over: Partial<Parameters<typeof runWithRecovery>[0]> = {}) => ({
    maxRetries: 2,
    backoffMs: 10,
    timeoutMs: 5000,
    deadline: Date.now() + 5000,
    initialPrompt: "original",
    onRetrying: () => {},
    attempt: okNext([], [done]),
    ...over,
  });

  test("a clean first attempt never retries", async () => {
    const prompts: string[] = [];
    let retries = 0;
    const r = await runWithRecovery(loopOpts({ attempt: okNext(prompts, [done]), onRetrying: () => retries++ }));
    expect(r.totalRuns).toBe(1);
    expect(retries).toBe(0);
    expect(prompts).toEqual(["original"]);
    expect(r.sawDone).toBe(true);
  });

  test("an error-only run retries once with the continuation prompt", async () => {
    const prompts: string[] = [];
    const seen: Array<[number, number, string]> = [];
    const r = await runWithRecovery(
      loopOpts({
        attempt: okNext(prompts, [fail("socket closed"), done]),
        onRetrying: (i, n, err) => seen.push([i, n, err]),
      }),
    );
    expect(r.totalRuns).toBe(2);
    expect(r.sawDone).toBe(true);
    // Continuation, not repetition: the retry prompt is the exported
    // constant, never the original prompt verbatim.
    expect(prompts).toEqual(["original", RECOVERY_CONTINUATION_PROMPT]);
    expect(RECOVERY_CONTINUATION_PROMPT).not.toContain("original");
    expect(seen).toEqual([[1, 2, "socket closed"]]);
  });

  test("a settled-then-errored run is finished, never recovered", async () => {
    const prompts: string[] = [];
    let retries = 0;
    const r = await runWithRecovery(
      loopOpts({
        attempt: okNext(prompts, [{ sawError: true, sawDone: true, aborted: false, firstError: "late" }]),
        onRetrying: () => retries++,
      }),
    );
    expect(r.totalRuns).toBe(1);
    expect(retries).toBe(0);
  });

  test("an aborted run is never recovered", async () => {
    const prompts: string[] = [];
    let retries = 0;
    const r = await runWithRecovery(
      loopOpts({
        attempt: okNext(prompts, [{ sawError: true, sawDone: false, aborted: true, firstError: "x" }]),
        onRetrying: () => retries++,
      }),
    );
    expect(r.totalRuns).toBe(1);
    expect(retries).toBe(0);
    expect(r.aborted).toBe(true);
  });

  test("retries stop at the bound: 2 retries means at most 3 runs", async () => {
    const prompts: string[] = [];
    const seen: number[] = [];
    const r = await runWithRecovery(
      loopOpts({ maxRetries: 2, attempt: okNext(prompts, [fail()]), onRetrying: (i) => seen.push(i) }),
    );
    expect(r.totalRuns).toBe(3);
    expect(seen).toEqual([1, 2]);
    expect(r.sawError).toBe(true);
    expect(r.sawDone).toBe(false);
  });

  test("attempts=0 disables recovery entirely", async () => {
    const prompts: string[] = [];
    let retries = 0;
    const r = await runWithRecovery(loopOpts({ maxRetries: 0, attempt: okNext(prompts, [fail()]), onRetrying: () => retries++ }));
    expect(r.totalRuns).toBe(1);
    expect(retries).toBe(0);
  });

  test("the shared deadline bounds the whole sequence, not each attempt", async () => {
    const budgets: number[] = [];
    const start = Date.now();
    const r = await runWithRecovery(
      loopOpts({
        maxRetries: 10,
        backoffMs: 150,
        timeoutMs: 400,
        deadline: start + 400,
        attempt: async (_prompt, budget) => {
          budgets.push(budget);
          return fail();
        },
      }),
    );
    const elapsed = Date.now() - start;
    // Retries happened (more than one run) but the 10-retry budget was cut
    // short by the 400ms wall-clock deadline.
    expect(r.totalRuns).toBeGreaterThan(1);
    expect(r.totalRuns).toBeLessThan(11);
    expect(elapsed).toBeLessThan(2000);
    // Each attempt gets the *remaining* budget, never a fresh full timeout.
    expect(budgets[0]).toBe(400);
    expect(budgets[1]!).toBeLessThan(budgets[0]!);
  });

  test("an abort during backoff stops the loop with no further attempt", async () => {
    const ctl = new AbortController();
    const prompts: string[] = [];
    const r = await runWithRecovery(
      loopOpts({
        maxRetries: 5,
        backoffMs: 5000,
        signal: ctl.signal,
        attempt: okNext(prompts, [fail()]),
        // Abort the moment the loop parks in backoff: no wall-clock wait.
        onRetrying: () => ctl.abort(),
      }),
    );
    expect(r.totalRuns).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(r.aborted).toBe(true);
  });

  test("recovery message contracts", () => {
    expect(retryingMessage(1, 2, "socket closed")).toBe("retrying (1/2): socket closed");
    expect(retryingMessage(1, 2, "x").startsWith("retrying (")).toBe(true);
    expect(recoveryExhaustedMessage(3, "socket closed")).toContain("3 attempts");
    expect(recoveryExhaustedMessage(3, "socket closed")).toContain("socket closed");
    // The continuation prompt names the cause and forbids redoing work.
    expect(RECOVERY_CONTINUATION_PROMPT).toContain("transport error");
    expect(RECOVERY_CONTINUATION_PROMPT).toContain("without redoing completed work");
  });

  test("sleepAbortable wakes early on abort", async () => {
    const pre = new AbortController();
    pre.abort();
    const t0 = Date.now();
    await sleepAbortable(5000, pre.signal);
    expect(Date.now() - t0).toBeLessThan(500);
    const mid = new AbortController();
    setTimeout(() => mid.abort(), 50);
    const t1 = Date.now();
    await sleepAbortable(5000, mid.signal);
    expect(Date.now() - t1).toBeLessThan(2000);
  });
});

describe("json recovery (stub pi binaries)", () => {
  function jsonRecoveryHandler(dir: string, piBin: string, extra: Record<string, unknown> = {}) {
    return createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin,
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [],
      defaultTimeoutMs: 30_000,
      recoveryAttempts: 2,
      recoveryBackoffMs: 50,
      ...extra,
    } as Parameters<typeof createHandler>[0]);
  }

  function writeArgvLog(dir: string): void {
    writeFileSync(join(dir, "argv.log"), "");
    writeFileSync(join(dir, "pids.log"), "");
    process.env["CB_ARGV"] = join(dir, "argv.log");
    process.env["CB_PIDS"] = join(dir, "pids.log");
  }

  function clearArgvLog(): void {
    delete process.env["CB_ARGV"];
    delete process.env["CB_PIDS"];
  }

  function argvLines(dir: string): string[] {
    return readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean);
  }

  function pidLines(dir: string): number[] {
    return readFileSync(join(dir, "pids.log"), "utf8").trim().split("\n").filter(Boolean).map(Number);
  }

  function isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  /** Fails the first spawn (transport error), succeeds on the continuation prompt. */
  function writeFailoverStub(dir: string, name: string): string {
    const p = join(dir, name);
    writeFileSync(
      p,
      "#!/bin/sh\n" +
        'echo "$*" >> "${CB_ARGV:-/dev/null}"\n' +
        'echo "$$" >> "${CB_PIDS:-/dev/null}"\n' +
        'case "$*" in\n' +
        "  *transport*)\n" +
        '    echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"resumed"}}\';\n' +
        '    echo \'{"type":"agent_settled"}\';\n' +
        "    exit 0;;\n" +
        "  *)\n" +
        '    echo \'{"type":"message_update","assistantMessageEvent":{"type":"error","reason":"socket","error":"The socket connection was closed unexpectedly"}}\';\n' +
        "    exit 1;;\n" +
        "esac\n",
    );
    chmodSync(p, 0o755);
    return p;
  }

  function runJson(handler: ReturnType<typeof createHandler>, sessionId: string, prompt: string): Promise<Response> {
    return handler.handleRun(
      new Request("http://x/run", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ sessionId, prompt }),
      }),
    );
  }

  function msg(e: AgentEvent): string {
    return (e as { message?: string }).message ?? "";
  }

  /** Read stream chunks until `needle` appears (Bun yields string chunks here). */
  async function readStreamUntil(reader: ReadableStreamDefaultReader<any>, needle: string): Promise<string> {
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (typeof value === "string") text += value;
      else if (value) text += dec.decode(value as Uint8Array, { stream: true });
      if (done || text.includes(needle)) return text;
    }
  }

  async function readStreamRest(reader: ReadableStreamDefaultReader<any>, first: string): Promise<string> {
    const dec = new TextDecoder();
    let text = first;
    for (;;) {
      const { done, value } = await reader.read();
      if (typeof value === "string") text += value;
      else if (value) text += dec.decode(value as Uint8Array, { stream: true });
      if (done) return text;
    }
  }

  test("a transport error recovers with the continuation prompt and ends done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-json-"));
    writeArgvLog(dir);
    const handler = jsonRecoveryHandler(dir, writeFailoverStub(dir, "pi.sh"));
    try {
      const events = await readNdjson(await runJson(handler, "srec", "do the thing ALPHA"));
      // Terminal status is done, and the resumed output arrived.
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
      expect(events.some((e) => e.type === "text" && (e as { delta: string }).delta === "resumed")).toBe(true);
      // The original transport error is visible in the stream.
      expect(events.some((e) => e.type === "error" && msg(e).includes("socket connection was closed"))).toBe(true);
      // The retrying status sits between the error and the terminal done, in order.
      const idxErr = events.findIndex((e) => e.type === "error");
      const idxRetry = events.findIndex((e) => e.type === "status" && msg(e).startsWith("retrying ("));
      const idxDone = events.findIndex((e) => e.type === "status" && e.status === "done");
      expect(idxErr).toBeGreaterThanOrEqual(0);
      expect(idxRetry).toBeGreaterThan(idxErr);
      expect(idxDone).toBeGreaterThan(idxRetry);
      expect(msg(events[idxRetry]!)).toContain("socket connection was closed");
      // Two spawns with the same --session-id; the retry continues instead
      // of replaying the original prompt verbatim.
      const argv = argvLines(dir);
      expect(argv).toHaveLength(2);
      for (const line of argv) expect(line).toContain("--session-id srec");
      expect(argv[0]).toContain("ALPHA");
      expect(argv[1]).not.toContain("ALPHA");
      expect(argv[1]).toContain("transport");
      expect(handler.busy.size).toBe(0);
    } finally {
      clearArgvLog();
      handler.close();
    }
  });

  test("an always-failing run stops after the configured attempts and names the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-json-fail-"));
    writeArgvLog(dir);
    const stub = join(dir, "fail.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        'echo "$*" >> "${CB_ARGV:-/dev/null}"\n' +
        'echo "$$" >> "${CB_PIDS:-/dev/null}"\n' +
        'echo \'{"type":"error","message":"always broken"}\';\n' +
        "exit 1\n",
    );
    chmodSync(stub, 0o755);
    // A long backoff proves the wait is honoured: elapsed must cover both gaps.
    const handler = jsonRecoveryHandler(dir, stub, { recoveryBackoffMs: 400 });
    try {
      const t0 = Date.now();
      const events = await readNdjson(await runJson(handler, "sfail", "hi"));
      const elapsed = Date.now() - t0;
      // Exactly 3 spawns for 2 configured retries — never more.
      expect(argvLines(dir)).toHaveLength(3);
      const retrying = events.filter((e) => e.type === "status" && msg(e).startsWith("retrying ("));
      expect(retrying).toHaveLength(2);
      expect(msg(retrying[0]!)).toBe("retrying (1/2): always broken");
      expect(msg(retrying[1]!)).toBe("retrying (2/2): always broken");
      // Terminal error names the attempt count plus the original error.
      expect(events.at(-1)).toMatchObject({ type: "status", status: "error" });
      expect(msg(events.at(-1)!)).toContain("3 attempts");
      expect(msg(events.at(-1)!)).toContain("always broken");
      expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(false);
      // Backoff between attempts was honoured (two ~400ms gaps minimum).
      // Scheduling lag can only stretch this, never shrink it.
      expect(elapsed).toBeGreaterThanOrEqual(750);
      // No orphaned children: every attempt's child exited and was reaped.
      const pids = pidLines(dir);
      expect(pids).toHaveLength(3);
      for (const pid of pids) expect(isDead(pid)).toBe(true);
      expect(handler.busy.size).toBe(0);
    } finally {
      clearArgvLog();
      handler.close();
    }
  });

  test("attempts=0 disables recovery: single run, legacy terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-json-off-"));
    writeArgvLog(dir);
    const stub = join(dir, "fail.sh");
    writeFileSync(stub, "#!/bin/sh\n" + 'echo "$*" >> "${CB_ARGV:-/dev/null}"\n' + "exit 1\n");
    chmodSync(stub, 0o755);
    const handler = jsonRecoveryHandler(dir, stub, { recoveryAttempts: 0 });
    try {
      const events = await readNdjson(await runJson(handler, "s0", "hi"));
      expect(argvLines(dir)).toHaveLength(1);
      expect(events.some((e) => e.type === "status" && msg(e).startsWith("retrying ("))).toBe(false);
      // Byte-identical terminal to the pre-recovery behaviour.
      expect(events.at(-1)).toEqual({ type: "status", sessionId: "s0", status: "error", message: "run exited 1" });
    } finally {
      clearArgvLog();
      handler.close();
    }
  });

  test("a run that settles then errors is finished, not recovered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-json-settled-"));
    writeArgvLog(dir);
    const stub = join(dir, "late.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        'echo "$*" >> "${CB_ARGV:-/dev/null}"\n' +
        'echo \'{"type":"agent_settled"}\';\n' +
        'echo \'{"type":"error","message":"late failure"}\';\n' +
        "exit 0\n",
    );
    chmodSync(stub, 0o755);
    const handler = jsonRecoveryHandler(dir, stub);
    try {
      const events = await readNdjson(await runJson(handler, "sset", "hi"));
      // Not recovered: one spawn, no retrying, and the settle stands.
      expect(argvLines(dir)).toHaveLength(1);
      expect(events.some((e) => e.type === "status" && msg(e).startsWith("retrying ("))).toBe(false);
      expect(events.some((e) => e.type === "done")).toBe(true);
      // Terminal keeps the inherited semantics: the late error event poisons
      // it even though the run settled (pre-recovery behaviour, unchanged).
      expect(events.at(-1)).toEqual({ type: "status", sessionId: "sset", status: "error", message: "run exited 0" });
    } finally {
      clearArgvLog();
      handler.close();
    }
  });

  test("operator abort during backoff ends the run with no further attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-json-abort-"));
    writeArgvLog(dir);
    const stub = join(dir, "fail.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        'echo "$*" >> "${CB_ARGV:-/dev/null}"\n' +
        'echo \'{"type":"error","message":"first broken"}\';\n' +
        "exit 1\n",
    );
    chmodSync(stub, 0o755);
    // Long backoff: the abort must land inside it, cutting it short.
    const handler = jsonRecoveryHandler(dir, stub, { recoveryBackoffMs: 5000 });
    try {
      const res = await runJson(handler, "sabortbo", "hi");
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      // Deterministic: the retrying status is only emitted once the loop is
      // parked in backoff, so the abort below always lands mid-backoff.
      const first = await readStreamUntil(reader, "retrying (");
      expect(first).toContain("retrying (");
      const abortRes = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sabortbo" }),
        }),
      );
      expect(abortRes.status).toBe(200);
      const text = await readStreamRest(reader, first);
      const events = text.trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.some((e) => e.type === "status" && msg(e) === "aborted by user")).toBe(true);
      expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "error" });
      // The stream closed after the loop exited, so this count is final: no
      // second attempt ever started, and the continuation never ran.
      expect(argvLines(dir)).toHaveLength(1);
      expect(argvLines(dir)[0]).not.toContain("transport");
      expect(handler.busy.size).toBe(0);
    } finally {
      clearArgvLog();
      handler.close();
    }
  });
});

describe("rpc recovery (stub rpc child)", () => {
  function rpcRecoveryHandler(dir: string, piBin: string, extra: Record<string, unknown> = {}) {
    return rpcHandler(dir, piBin, { recoveryAttempts: 2, recoveryBackoffMs: 50, ...extra });
  }

  function msg(e: AgentEvent): string {
    return (e as { message?: string }).message ?? "";
  }

  /** Errors on the original prompt (then dies), succeeds on the continuation. */
  function writeFailoverStub(dir: string): string {
    return writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'LOG="${RPC_LOG:-/dev/null}"\n' +
        'echo "spawn $$" >> "$LOG"\n' +
        'while IFS= read -r line; do\n' +
        '  echo "$line" >> "$LOG"\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        "    *transport*)\n" +
        '      echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"resumed"}}\';\n' +
        '      echo \'{"type":"agent_settled"}\';;\n' +
        "    *prompt*)\n" +
        '      echo \'{"type":"message_update","assistantMessageEvent":{"type":"error","reason":"socket","error":"The socket connection was closed unexpectedly"}}\';\n' +
        "      exit 1;;\n" +
        "    *abort*) echo '{\"type\":\"agent_settled\"}' ;;\n" +
        "  esac\n" +
        "done\n",
    );
  }

  function writeAlwaysFailStub(dir: string): string {
    return writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'LOG="${RPC_LOG:-/dev/null}"\n' +
        'echo "spawn $$" >> "$LOG"\n' +
        'while IFS= read -r line; do\n' +
        '  echo "$line" >> "$LOG"\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*)\n' +
        '      echo \'{"type":"error","message":"rpc always broken"}\';\n' +
        "      exit 1;;\n" +
        "  esac\n" +
        "done\n",
    );
  }

  function runRpc(handler: ReturnType<typeof createHandler>, sessionId: string, prompt: string): Promise<Response> {
    return handler.handleRun(
      new Request("http://x/run", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ sessionId, prompt }),
      }),
    );
  }

  function logLines(dir: string): string[] {
    return readFileSync(join(dir, "cmds.log"), "utf8").split("\n").filter(Boolean);
  }

  test("a transport error re-issues the continuation prompt and ends done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-rpc-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const handler = rpcRecoveryHandler(dir, writeFailoverStub(dir));
    process.env["RPC_LOG"] = log;
    try {
      const res = await runRpc(handler, "srec", "do the thing ALPHA");
      expect(res.status).toBe(200);
      const events = await readNdjson(res);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
      expect(events.some((e) => e.type === "text" && (e as { delta: string }).delta === "resumed")).toBe(true);
      const idxErr = events.findIndex((e) => e.type === "error");
      const idxRetry = events.findIndex((e) => e.type === "status" && msg(e).startsWith("retrying ("));
      const idxDone = events.findIndex((e) => e.type === "status" && e.status === "done");
      expect(idxErr).toBeGreaterThanOrEqual(0);
      expect(idxRetry).toBeGreaterThan(idxErr);
      expect(idxDone).toBeGreaterThan(idxRetry);
      // The prompt went through the rpc channel: original once, the
      // exported continuation prompt exactly once — never replayed verbatim.
      const lines = logLines(dir);
      const prompts = lines.filter((l) => l.includes('"type":"prompt"'));
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("ALPHA");
      expect(prompts[0]).not.toContain("transport");
      const continuations = readFileSync(log, "utf8").split(RECOVERY_CONTINUATION_PROMPT).length - 1;
      expect(continuations).toBe(1);
      // The dead child was replaced, not leaked: exactly two spawns, and the
      // first pid is gone while the run itself completed.
      const spawns = lines.filter((l) => l.startsWith("spawn "));
      expect(spawns).toHaveLength(2);
      expect(handler.busy.size).toBe(0);
    } finally {
      delete process.env["RPC_LOG"];
      handler.close();
    }
  });

  test("an always-failing rpc run stops at the bound and names the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-rpc-fail-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const handler = rpcRecoveryHandler(dir, writeAlwaysFailStub(dir), { recoveryAttempts: 1, recoveryBackoffMs: 50 });
    process.env["RPC_LOG"] = log;
    try {
      const events = await readNdjson(await runRpc(handler, "sfail", "hi"));
      // Exactly 2 spawns for 1 configured retry — never more.
      const lines = logLines(dir);
      expect(lines.filter((l) => l.startsWith("spawn "))).toHaveLength(2);
      expect(lines.filter((l) => l.includes('"type":"prompt"'))).toHaveLength(2);
      const retrying = events.filter((e) => e.type === "status" && msg(e).startsWith("retrying ("));
      expect(retrying).toHaveLength(1);
      expect(msg(retrying[0]!)).toBe("retrying (1/1): rpc always broken");
      expect(events.at(-1)).toMatchObject({ type: "status", status: "error" });
      expect(msg(events.at(-1)!)).toContain("2 attempts");
      expect(msg(events.at(-1)!)).toContain("rpc always broken");
      expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(false);
      // No orphaned children: both generations exited; close() reaps the idle one.
      const pids = lines.filter((l) => l.startsWith("spawn ")).map((l) => Number(l.split(" ")[1]));
      expect(pids).toHaveLength(2);
      handler.close();
      await pollFor(
        () => pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }),
        "rpc recovery children reaped",
      );
      expect(handler.busy.size).toBe(0);
    } finally {
      delete process.env["RPC_LOG"];
      handler.close();
    }
  });

  test("attempts=0 disables rpc recovery: single prompt, legacy terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-rpc-off-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const handler = rpcRecoveryHandler(dir, writeAlwaysFailStub(dir), { recoveryAttempts: 0 });
    process.env["RPC_LOG"] = log;
    try {
      const events = await readNdjson(await runRpc(handler, "s0", "hi"));
      const lines = logLines(dir);
      expect(lines.filter((l) => l.includes('"type":"prompt"'))).toHaveLength(1);
      expect(events.some((e) => e.type === "status" && msg(e).startsWith("retrying ("))).toBe(false);
      // Byte-identical terminal to the pre-recovery behaviour.
      expect(events.at(-1)).toEqual({ type: "status", sessionId: "s0", status: "error", message: "run failed" });
    } finally {
      delete process.env["RPC_LOG"];
      handler.close();
    }
  });

  test("an rpc run that settles then errors is finished, not recovered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-rpc-settled-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'LOG="${RPC_LOG:-/dev/null}"\n' +
        'echo "spawn $$" >> "$LOG"\n' +
        'while IFS= read -r line; do\n' +
        '  echo "$line" >> "$LOG"\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*)\n' +
        '      echo \'{"type":"agent_settled"}\';\n' +
        '      echo \'{"type":"error","message":"late failure"}\';;\n' +
        "  esac\n" +
        "done\n",
    );
    const handler = rpcRecoveryHandler(dir, stub);
    process.env["RPC_LOG"] = log;
    try {
      const events = await readNdjson(await runRpc(handler, "sset", "hi"));
      const lines = logLines(dir);
      expect(lines.filter((l) => l.includes('"type":"prompt"'))).toHaveLength(1);
      expect(events.some((e) => e.type === "status" && msg(e).startsWith("retrying ("))).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
    } finally {
      delete process.env["RPC_LOG"];
      handler.close();
    }
  });

  test("operator abort during rpc backoff ends the run with no further prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-rec-rpc-abort-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    const handler = rpcRecoveryHandler(dir, writeAlwaysFailStub(dir), { recoveryBackoffMs: 5000 });
    process.env["RPC_LOG"] = log;
    try {
      const res = await runRpc(handler, "sabortbo", "hi");
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const append = (text: string, value: unknown): string =>
        typeof value === "string" ? text + value : value ? text + dec.decode(value as Uint8Array, { stream: true }) : text;
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        text = append(text, value);
        if (done || text.includes("retrying (")) break;
      }
      // The retrying status is only emitted once the loop is parked in
      // backoff, so the abort below always lands mid-backoff.
      expect(text).toContain("retrying (");
      const abortRes = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sabortbo" }),
        }),
      );
      expect(abortRes.status).toBe(200);
      for (;;) {
        const { done, value } = await reader.read();
        text = append(text, value);
        if (done) break;
      }
      const events = text.trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.some((e) => e.type === "status" && msg(e) === "aborted by user")).toBe(true);
      expect(events.some((e) => e.type === "status" && e.status === "done")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "error" });
      // The stream closed after the loop exited, so these counts are final:
      // the continuation was never re-issued and no child was spawned for it.
      const lines = logLines(dir);
      expect(lines.filter((l) => l.startsWith("spawn "))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('"type":"prompt"'))).toHaveLength(1);
      expect(readFileSync(log, "utf8").split(RECOVERY_CONTINUATION_PROMPT).length - 1).toBe(0);
      expect(handler.busy.size).toBe(0);
    } finally {
      delete process.env["RPC_LOG"];
      handler.close();
    }
  });
});

describe("thinking extraction (lane-exec-think)", () => {
  const sid = "s1";
  const thinkLine = (delta: string) =>
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });

  test("recognizes thinking wire shapes generically", () => {
    expect(extractThinkingText(thinkLine("deep thought"))).toBe("deep thought");
    // Any inner type starting with "thinking" counts; text pulled generically.
    expect(
      extractThinkingText(
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_custom", text: "alt field" } }),
      ),
    ).toBe("alt field");
    // Any top-level thinking* type counts too.
    expect(extractThinkingText(JSON.stringify({ type: "thinking", text: "top" }))).toBe("top");
    expect(extractThinkingText(JSON.stringify({ type: "thinking_delta", delta: "d" }))).toBe("d");
  });

  test("non-thinking and malformed lines yield null", () => {
    expect(
      extractThinkingText(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } })),
    ).toBeNull();
    expect(
      extractThinkingText(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } })),
    ).toBeNull();
    expect(extractThinkingText(JSON.stringify({ type: "text", text: "hi" }))).toBeNull();
    expect(extractThinkingText(JSON.stringify({ type: "mystery", n: 1 }))).toBeNull();
    expect(extractThinkingText("plain log line")).toBeNull();
    expect(extractThinkingText("   ")).toBeNull();
    expect(extractThinkingText("[1,2]")).toBeNull();
  });

  test("thinking wire events never double-emit as text", () => {
    // The coalescer owns thinking; the single-event parser stays silent so
    // one wire line cannot produce both a text event and a thinking event.
    expect(parsePiJsonLine(JSON.stringify({ type: "thinking", text: "t" }), sid)).toBeNull();
    expect(parsePiJsonLine(JSON.stringify({ type: "thinking_delta", delta: "t" }), sid)).toBeNull();
    expect(parsePiJsonLine(thinkLine("t"), sid)).toBeNull();
  });
});

describe("thinking coalescing (lane-exec-think)", () => {
  const sid = "s1";

  test("emits per >=300 chars, preserves order, flushes remainder", () => {
    const c = new ThinkingCoalescer(sid);
    expect(c.push("a".repeat(150))).toEqual([]);
    expect(c.pending).toBe(150);
    const first = c.push("b".repeat(150));
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ type: "thinking", sessionId: sid, delta: "a".repeat(150) + "b".repeat(150) });
    expect(c.pending).toBe(0);
    expect(c.push("c".repeat(100))).toEqual([]);
    const rest = c.flush();
    expect(rest).toEqual({ type: "thinking", sessionId: sid, delta: "c".repeat(100) });
    expect(c.flush()).toBeNull(); // idempotent
    expect(c.push("")).toEqual([]);
  });

  test("flood: 10k chars stay bounded and round-trip exactly", () => {
    const input = "abcdefghij".repeat(1000); // 10 000 chars
    const c = new ThinkingCoalescer(sid);
    const events: AgentEvent[] = [];
    // Odd chunk size so emissions split mid-chunk across boundaries.
    for (let i = 0; i < input.length; i += 7) {
      events.push(...c.push(input.slice(i, i + 7)));
    }
    const rest = c.flush();
    if (rest) events.push(rest);
    expect(events.length).toBeLessThanOrEqual(40);
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => e.type === "thinking")).toBe(true);
    expect(events.map((e) => (e as { delta: string }).delta).join("")).toBe(input);
  });

  test("handlePiLine flushes the remainder before done", () => {
    const events: AgentEvent[] = [];
    const c = new ThinkingCoalescer(sid);
    const emit = (e: AgentEvent) => events.push(e);
    handlePiLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "short" } }), sid, c, emit);
    expect(events).toEqual([]); // buffered, not yet emitted
    handlePiLine(JSON.stringify({ type: "agent_settled" }), sid, c, emit);
    expect(events).toEqual([
      { type: "thinking", sessionId: sid, delta: "short" },
      { type: "done", sessionId: sid },
    ]);
  });

  test("handlePiLine forwards usage lines alongside text", () => {
    const events: AgentEvent[] = [];
    const c = new ThinkingCoalescer(sid);
    handlePiLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
        usage: { inputTokens: 3 },
      }),
      sid,
      c,
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { type: "usage", sessionId: sid, inputTokens: 3 },
      { type: "text", sessionId: sid, delta: "hi" },
    ]);
  });
});

describe("usage passthrough (lane-exec-think)", () => {
  const sid = "s1";

  test("full usage object maps exactly", () => {
    expect(
      parsePiUsageLine(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.001 },
        }),
        sid,
      ),
    ).toEqual({ type: "usage", sessionId: sid, inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.001 });
  });

  test("partial and snake_case shapes forward what exists", () => {
    expect(parsePiUsageLine(JSON.stringify({ type: "message_update", usage: { inputTokens: 5 } }), sid)).toEqual({
      type: "usage",
      sessionId: sid,
      inputTokens: 5,
    });
    expect(
      parsePiUsageLine(JSON.stringify({ type: "usage", input_tokens: 1, output_tokens: 2, total_tokens: 3, cost_usd: 0.5 }), sid),
    ).toEqual({ type: "usage", sessionId: sid, inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.5 });
  });

  test("garbage shapes yield null and never throw", () => {
    expect(parsePiUsageLine(JSON.stringify({ type: "message_update", usage: "nope" }), sid)).toBeNull();
    expect(parsePiUsageLine(JSON.stringify({ type: "message_update", usage: { inputTokens: "lots" } }), sid)).toBeNull();
    expect(parsePiUsageLine(JSON.stringify({ type: "message_update", usage: {} }), sid)).toBeNull();
    expect(parsePiUsageLine(JSON.stringify({ type: "message_update" }), sid)).toBeNull();
    expect(parsePiUsageLine(JSON.stringify({ type: "text", text: "hi" }), sid)).toBeNull();
    expect(parsePiUsageLine("not json", sid)).toBeNull();
    expect(parsePiUsageLine("   ", sid)).toBeNull();
  });
});

describe("thinking end to end (lane-exec-think, stub binaries)", () => {
  test("json mode: 10k thinking coalesces, usage forwards, done stays last", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-think-json-"));
    const delta = "abcdefghij"; // 10 chars
    const lines = 1000; // 10 000 chars of reasoning
    const stub = join(dir, "think.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        `i=0\nwhile [ $i -lt ${lines} ]; do printf '%s\\n' '${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } })}'; i=$((i+1)); done\n` +
        `printf '%s\\n' '${JSON.stringify({ type: "message_update", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.001 } })}'\n` +
        "echo '{\"type\":\"agent_settled\"}'\n",
    );
    chmodSync(stub, 0o755);
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({
      sessionId: "s1",
      model: "m",
      prompt: "hi",
      openshellPrefix: [],
      timeoutMs: 15_000,
      piBin: stub,
      piSessionDir: dir,
      workdir: dir,
      onEvent: (e) => events.push(e),
    });
    expect(r.sawDone).toBe(true);
    expect(r.sawError).toBe(false);
    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking.length).toBeLessThanOrEqual(40);
    expect(thinking.length).toBeGreaterThan(1);
    expect(thinking.map((e) => (e as { delta: string }).delta).join("")).toBe(delta.repeat(lines));
    expect(events).toContainEqual({
      type: "usage",
      sessionId: "s1",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: 0.001,
    });
    expect(events.at(-1)).toEqual({ type: "done", sessionId: "s1" });
  });

  test("rpc mode: thinking coalesces through the shared helper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-think-rpc-"));
    const delta = "0123456789"; // 10 chars
    const lines = 1000;
    const thinkLine = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        "    *prompt*)\n" +
        `      i=0; while [ $i -lt ${lines} ]; do printf '%s\\n' '${thinkLine}'; i=$((i+1)); done\n` +
        `      printf '%s\\n' '${JSON.stringify({ type: "message_update", usage: { inputTokens: 7, outputTokens: 8 } })}'\n` +
        '      echo \'{"type":"agent_settled"}\'\n' +
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
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(true);
      expect(r.sawError).toBe(false);
      const thinking = events.filter((e) => e.type === "thinking");
      expect(thinking.length).toBeLessThanOrEqual(40);
      expect(thinking.map((e) => (e as { delta: string }).delta).join("")).toBe(delta.repeat(lines));
      expect(events).toContainEqual({ type: "usage", sessionId: "s1", inputTokens: 7, outputTokens: 8 });
      expect(events.at(-1)).toEqual({ type: "done", sessionId: "s1" });
    } finally {
      mgr.close();
    }
  });

  test("rpc abort flushes buffered thinking before the aborted status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-think-abort-"));
    const marker = join(dir, "emitted");
    const stub = writeRpcStub(
      dir,
      "rpc.sh",
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        "    *prompt*)\n" +
        `      echo '${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "partial-reasoning" } })}'\n` +
        `      touch "${marker}"\n` +
        "      sleep 5\n" +
        '      echo \'{"type":"agent_settled"}\'\n' +
        "      ;;\n" +
        '    *abort*) echo \'{"type":"agent_settled"}\' ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const p = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      // Wait for the stub to emit its (sub-threshold, still buffered) thinking.
      await pollFor(() => existsSync(marker), "rpc thinking emission");
      expect(mgr.abort("s1")).toBe(true);
      const r = await p;
      expect(r.aborted).toBe(true);
      const idxThink = events.findIndex((e) => e.type === "thinking");
      const idxAbort = events.findIndex((e) => e.type === "status" && (e as { message?: string }).message === "aborted by user");
      expect(idxThink).toBeGreaterThanOrEqual(0);
      expect(events[idxThink]).toEqual({ type: "thinking", sessionId: "s1", delta: "partial-reasoning" });
      expect(idxAbort).toBeGreaterThanOrEqual(0);
      expect(idxThink).toBeLessThan(idxAbort);
    } finally {
      mgr.close();
    }
  });
});

describe("lane-exec-wedge: wedged-slot release (reproduce-first)", () => {
  function isDead(pid: number | undefined): boolean {
    if (pid === undefined) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  test("wedged rpc child that ignores abort is SIGKILLed and next run uses a fresh child", async () => {
    // Reproduce-first probe: stub answers get_state but ignores prompt/abort
    // and never emits agent_settled. First generation (spawn 1) wedges;
    // a respawned child (spawn >= 2) succeeds. Without the fix the first
    // child stays alive, settling stays true, and the second run reuses the
    // wedged pid and times out again.
    const dir = mkdtempSync(join(tmpdir(), "cb-wedge-kill-"));
    const log = join(dir, "spawns.log");
    writeFileSync(log, "");
    const stub = writeRpcStub(
      dir,
      "wedged.sh",
      "#!/bin/sh\n" +
        'LOG="${RPC_SPAWN_LOG:-/dev/null}"\n' +
        'echo spawn >> "$LOG"\n' +
        'COUNT=$(wc -l < "$LOG" | tr -d " ")\n' +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        '    *prompt*)\n' +
        '      if [ "$COUNT" -ge 2 ]; then\n' +
        '        echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"fresh-ok"}}\'\n' +
        '        echo \'{"type":"agent_settled"}\'\n' +
        "      fi\n" +
        "      ;;\n" +
        '    *abort*) ;;\n' +
        "  esac\n" +
        "done\n",
    );
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000 });
    process.env["RPC_SPAWN_LOG"] = log;
    try {
      const r1 = await mgr.run({
        sessionId: "wedge1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "first",
        timeoutMs: 800,
        onEvent: () => {},
      });
      expect(r1.timedOut).toBe(true);
      const pid1 = mgr.pidOf("wedge1");
      expect(pid1).toBeDefined();
      // Bounded grace (reuses the settle-wait shape, 5s): the wedged child
      // must die without any second run arriving. Poll, never sleep fixed.
      await pollFor(() => isDead(pid1), "wedged child SIGKILLed after grace");
      expect(isDead(pid1)).toBe(true);
      // Next run starts cleanly on a fresh child and sees its own output.
      const events: AgentEvent[] = [];
      const r2 = await mgr.run({
        sessionId: "wedge1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "second",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(r2.sawDone).toBe(true);
      expect(r2.sawError).toBe(false);
      expect(events.some((e) => e.type === "text" && (e as { delta: string }).delta === "fresh-ok")).toBe(true);
      const pid2 = mgr.pidOf("wedge1");
      expect(pid2).toBeDefined();
      expect(pid2).not.toBe(pid1);
    } finally {
      delete process.env["RPC_SPAWN_LOG"];
      mgr.close();
    }
  }, 30_000);

  test("an aborted json run never clobbers the next run's slot (generation guard)", async () => {
    // Slow stub: the SIGKILLed shell leaves its `sleep` orphan holding the
    // stdout pipe, so the aborted run's close (and its finally) is delayed
    // ~2s while the next run is already in flight. Without a generation
    // guard the old finally deletes the new run's busy entry, so a third
    // concurrent run wrongly succeeds (200) instead of 409.
    const dir = mkdtempSync(join(tmpdir(), "cb-wedge-clobber-"));
    const started = join(dir, "started");
    const stub = join(dir, "slow.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        `touch "${started}"\n` +
        "echo '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"working\"}}'\n" +
        "sleep 2\n" +
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
      recoveryAttempts: 0,
      recoveryBackoffMs: 50,
    } as Parameters<typeof createHandler>[0]);
    try {
      const res = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sclob", prompt: "first" }),
        }),
      );
      expect(res.status).toBe(200);
      const textP = res.text();
      await pollFor(() => existsSync(started), "slow stub startup");
      const abortRes = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sclob" }),
        }),
      );
      expect(abortRes.status).toBe(200);
      // Immediate second run starts while the aborted run's close is still
      // delayed by the orphaned sleep holding the pipe.
      try {
        unlinkSync(started);
      } catch {
        // already gone
      }
      const res2 = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sclob", prompt: "SECOND" }),
        }),
      );
      expect(res2.status).toBe(200);
      const text2P = res2.text();
      // Wait for the aborted first stream to finish closing (its finally
      // races here, after the second run already owns the slot).
      await textP;
      // While the second run is still in flight, a third run must 409.
      const res3 = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sclob", prompt: "third" }),
        }),
      );
      expect(res3.status).toBe(409);
      const events2 = (await text2P).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events2.some((e) => e.type === "status" && e.status === "done")).toBe(true);
      expect(handler.busy.size).toBe(0);
    } finally {
      handler.close();
    }
  }, 30_000);

  test("handleAbort on a busy-but-settled desync frees busy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-wedge-desync-"));
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const handler = rpcHandler(dir, stub);
    try {
      (handler.busy as Set<string>).add("ghost");
      expect(handler.busy.has("ghost")).toBe(true);
      const r = await handler.handleAbort(
        new Request("http://x/abort", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "ghost" }),
        }),
      );
      expect(r.status).toBe(409);
      expect(handler.busy.has("ghost")).toBe(false);
    } finally {
      handler.close();
    }
  });

  test("a synchronous exception between busy.add and the stream try still frees busy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-wedge-exc-"));
    const stub = writeRpcStub(dir, "rpc.sh", basicRpcStub());
    const handler = rpcHandler(dir, stub);
    const OrigStream = globalThis.ReadableStream;
    let calls = 0;
    (globalThis as unknown as { ReadableStream: unknown }).ReadableStream = class {
      constructor() {
        calls += 1;
        throw new Error("injected stream failure");
      }
    };
    try {
      let res: Response | null = null;
      let threw: unknown = null;
      try {
        res = await handler.handleRun(
          new Request("http://x/run", {
            method: "POST",
            headers: { authorization: "Bearer t", "content-type": "application/json" },
            body: JSON.stringify({ sessionId: "sexc", prompt: "hi" }),
          }),
        );
      } catch (e) {
        threw = e;
      }
      expect(calls).toBe(1);
      // Fixed code converts the sync throw into a 500 and frees the slot;
      // current code lets it propagate with busy still held.
      if (res) expect(res.status).toBe(500);
      else expect(threw).toBeNull();
      expect(handler.busy.has("sexc")).toBe(false);
    } finally {
      (globalThis as unknown as { ReadableStream: unknown }).ReadableStream = OrigStream;
      handler.close();
    }
  });
});
