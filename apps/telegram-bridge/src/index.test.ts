import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.js";
import { decodeApproval, encodeApproval, renderChunks, TG_MAX } from "./format.js";

describe("bridge config", () => {
  test("requires tokens", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow("TELEGRAM_BOT_TOKEN");
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "b" } as NodeJS.ProcessEnv),
    ).toThrow("GATEWAY_TOKEN");
  });

  test("parses allowlist", () => {
    const cfg = loadConfig({
      TELEGRAM_BOT_TOKEN: "b",
      GATEWAY_TOKEN: "g",
      TELEGRAM_ALLOWLIST_IDS: "123, 456",
    } as NodeJS.ProcessEnv);
    expect(cfg.allowlist).toEqual(["123", "456"]);
  });
});

describe("format", () => {
  test("approval payload round-trips", () => {
    const enc = encodeApproval("abc123", "req-9", "approve");
    expect(decodeApproval(enc)).toEqual({ sessionId: "abc123", requestId: "req-9", decision: "approve" });
    expect(decodeApproval("bogus")).toBeNull();
  });

  test("renderChunks batches + caps length", () => {
    const events = [
      { type: "text", sessionId: "s", delta: "hello" },
      { type: "tool_call", sessionId: "s", name: "bash" },
      { type: "tool_result", sessionId: "s", name: "bash", ok: true },
      { type: "status", sessionId: "s", status: "running" },
      { type: "done", sessionId: "s", summary: "all good" },
    ] as never;
    const chunks = renderChunks(events);
    expect(chunks.join("\n")).toContain("hello");
    expect(chunks.join("\n")).toContain("🔧 bash");
    expect(chunks.join("\n")).toContain("✅ done");
    expect(chunks.every((c) => c.length <= TG_MAX)).toBe(true);
  });

  test("long text gets chunked", () => {
    const big = { type: "text", sessionId: "s", delta: "x".repeat(TG_MAX + 100) } as never;
    const chunks = renderChunks([big]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.length <= TG_MAX)).toBe(true);
  });
});
