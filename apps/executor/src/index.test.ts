import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@cloudbear/protocol";
import { loadConfig } from "./config.js";
import { assertValidPrompt, assertValidSessionId, clampTimeout, resolveWorkdir } from "./paths.js";
import { buildPiArgs, MAX_TOOL_OUTPUT, parsePiJsonLine, runPiStreaming } from "./pi.js";

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
    // completion markers terminate Telegram polling
    expect(parsePiJsonLine(`{"type":"agent_end","messages":[]}`, sid)).toEqual({ type: "done", sessionId: sid });
    expect(parsePiJsonLine(`{"type":"agent_settled"}`, sid)).toEqual({ type: "done", sessionId: sid });
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
    expect(events).toEqual([]);
  });

  test("non-zero exit emits an error event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-pi-"));
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({ ...base, piBin: "false", piSessionDir: dir, workdir: dir, onEvent: (e) => events.push(e) });
    expect(r.exitCode).toBe(1);
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
    expect(events.some((e) => e.type === "error" && e.message.includes("failed to start"))).toBe(true);
  });
});
