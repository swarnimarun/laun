import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@cloudbear/protocol";
import { loadConfig } from "./config.js";
import { assertValidPrompt, assertValidSessionId, clampTimeout, resolveWorkdir } from "./paths.js";
import { buildPiArgs, parsePiJsonLine, runPiStreaming } from "./pi.js";

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
    const args = buildPiArgs({ sessionId: "s1", piSessionDir: "/d/s1", model: "x-ai/grok-4.6", prompt: "hi" });
    expect(args).toEqual([
      "-p",
      "--mode",
      "json",
      "--session-id",
      "s1",
      "--session-dir",
      "/d/s1",
      "--model",
      "x-ai/grok-4.6",
      "--",
      "hi",
    ]);
  });

  test("parsePiJsonLine maps shapes", () => {
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
