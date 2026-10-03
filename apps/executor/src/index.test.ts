import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@cloudbear/protocol";
import { loadConfig } from "./config.js";
import { assertValidPrompt, assertValidSessionId, clampTimeout, resolveWorkdir } from "./paths.js";
import { buildPiArgs, MAX_TOOL_OUTPUT, parsePiJsonLine, runPiStreaming } from "./pi.js";
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
