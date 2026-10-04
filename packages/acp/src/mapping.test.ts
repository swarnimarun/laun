// Pure mapper tests: chunk coalescing bounds, tolerant parsing, and
// unknown/malformed frames that must skip (null), never throw.

import { describe, expect, test } from "bun:test";
import {
  TEXT_FLUSH_CHARS,
  TextCoalescer,
  ThinkingCoalescer,
  classifyStopReason,
  extractStreamChunk,
  mapPromptUsage,
  mapSessionUpdate,
  parsePermissionRequest,
} from "./mapping.js";

describe("TextCoalescer", () => {
  test("buffers below 300 chars and releases full chunks in order", () => {
    const acc = new TextCoalescer("s1");
    expect(acc.push("a".repeat(299))).toEqual([]);
    expect(acc.pending).toBe(299);
    const out = acc.push("b".repeat(50));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "text", sessionId: "s1", delta: "a".repeat(299) + "b" });
    expect(acc.pending).toBe(49);
  });

  test("flush releases the remainder once and is then empty", () => {
    const acc = new TextCoalescer("s1");
    acc.push("hi");
    expect(acc.flush()).toEqual({ type: "text", sessionId: "s1", delta: "hi" });
    expect(acc.flush()).toBeNull();
  });

  test("10k chars of chunks stay bounded like the executor", () => {
    const acc = new TextCoalescer("s1");
    const events: string[] = [];
    for (let i = 0; i < 100; i++) {
      for (const e of acc.push("x".repeat(100))) {
        if (e.type === "text") events.push(e.delta);
      }
    }
    const rest = acc.flush();
    if (rest && rest.type === "text") events.push(rest.delta);
    expect(events).toHaveLength(Math.ceil(10_000 / TEXT_FLUSH_CHARS));
    expect(events.slice(0, -1).every((d) => d.length === TEXT_FLUSH_CHARS)).toBe(true);
    expect(events.join("")).toBe("x".repeat(10_000));
  });

  test("empty pushes are ignored", () => {
    const acc = new TextCoalescer("s1");
    expect(acc.push("")).toEqual([]);
    expect(acc.flush()).toBeNull();
  });
});

describe("ThinkingCoalescer", () => {
  test("coalesces at the same 300-char bound with thinking events", () => {
    const acc = new ThinkingCoalescer("s1");
    expect(acc.push("t".repeat(600))).toHaveLength(2);
    expect(acc.flush()).toBeNull();
    acc.push("tail");
    expect(acc.flush()).toEqual({ type: "thinking", sessionId: "s1", delta: "tail" });
  });
});

describe("extractStreamChunk", () => {
  test("maps message and thought chunks, skips the rest", () => {
    expect(
      extractStreamChunk({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    ).toEqual({ kind: "text", text: "hi" });
    expect(
      extractStreamChunk({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
    ).toEqual({ kind: "thinking", text: "hmm" });
    expect(extractStreamChunk({ sessionUpdate: "session_info_update" })).toBeNull();
    expect(extractStreamChunk({ sessionUpdate: "available_commands_update", availableCommands: [] })).toBeNull();
  });

  test("tolerates array content and bare string payloads", () => {
    expect(
      extractStreamChunk({
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      }),
    ).toEqual({ kind: "text", text: "ab" });
    expect(extractStreamChunk({ sessionUpdate: "agent_message_chunk", content: "raw" })).toEqual({
      kind: "text",
      text: "raw",
    });
  });

  test("malformed frames return null without throwing", () => {
    const junk: unknown[] = [null, undefined, 42, "str", [], {}, { sessionUpdate: 7 }, { content: 1 }];
    for (const j of junk) expect(extractStreamChunk(j)).toBeNull();
  });
});

describe("mapSessionUpdate", () => {
  test("maps tool_call and terminal tool_call_update", () => {
    expect(mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", name: "bash" }, "s1")).toEqual({
      type: "tool_call",
      sessionId: "s1",
      name: "bash",
      args: undefined,
    });
    expect(
      mapSessionUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ text: "ok" }] },
        "s1",
      ),
    ).toEqual({ type: "tool_result", sessionId: "s1", name: "t1", ok: true, output: "ok" });
    expect(
      mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" }, "s1"),
    ).toEqual({ type: "tool_result", sessionId: "s1", name: "t1", ok: false, output: undefined });
  });

  test("drops progress-only tool updates and unknown kinds", () => {
    expect(
      mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }, "s1"),
    ).toBeNull();
    expect(mapSessionUpdate({ sessionUpdate: "plan", steps: [] }, "s1")).toBeNull();
    expect(mapSessionUpdate({ sessionUpdate: "nope" }, "s1")).toBeNull();
  });

  test("maps goose usage_update best-effort", () => {
    expect(
      mapSessionUpdate({ sessionUpdate: "usage_update", used: 100, size: 200, cost: { amount: 0.01 } }, "s1"),
    ).toEqual({ type: "usage", sessionId: "s1", totalTokens: 100, costUsd: 0.01 });
    expect(mapSessionUpdate({ sessionUpdate: "usage_update", size: 200 }, "s1")).toBeNull();
  });

  test("malformed frames return null without throwing", () => {
    const junk: unknown[] = [null, undefined, 0, "x", [], { sessionUpdate: null }, JSON.parse('{"a":1}')];
    for (const j of junk) expect(mapSessionUpdate(j, "s1")).toBeNull();
  });
});

describe("parsePermissionRequest", () => {
  test("parses canonical options", () => {
    const p = parsePermissionRequest({
      sessionId: "a",
      toolCall: { title: "run rm" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    expect(p?.reason).toContain("run rm");
    expect(p?.optionIds).toEqual(["allow", "deny"]);
    expect(p?.detail).toContain("Allow");
  });

  test("tolerates version-skewed option shapes instead of one allow/deny form", () => {
    const p = parsePermissionRequest({
      sessionId: "a",
      toolCall: {},
      options: [{ id: "d1", label: "Deny" }, "plain", 42, null, { value: "v", title: "V" }],
    });
    expect(p?.optionIds).toEqual(["d1", "plain", "v"]);
  });

  test("missing options still produce a fail-closed request", () => {
    expect(parsePermissionRequest({ sessionId: "a" })?.detail).toContain("no options");
    expect(parsePermissionRequest(null)).toBeNull();
    expect(parsePermissionRequest("junk")).toBeNull();
  });
});

describe("mapPromptUsage and classifyStopReason", () => {
  test("forwards numeric usage fields only", () => {
    expect(mapPromptUsage({ stopReason: "end_turn", usage: { totalTokens: 5, inputTokens: 4, outputTokens: 1 } }, "s1"))
      .toEqual({ type: "usage", sessionId: "s1", inputTokens: 4, outputTokens: 1, totalTokens: 5 });
    expect(mapPromptUsage({ stopReason: "end_turn" }, "s1")).toBeNull();
    expect(mapPromptUsage({ usage: { totalTokens: "lots" } }, "s1")).toBeNull();
    expect(mapPromptUsage(null, "s1")).toBeNull();
  });

  test("only real completion is done", () => {
    expect(classifyStopReason("end_turn")).toBe("done");
    expect(classifyStopReason("max_tokens")).toBe("done");
    expect(classifyStopReason("max_turn_requests")).toBe("done");
    expect(classifyStopReason("cancelled")).toBe("cancelled");
    expect(classifyStopReason("refusal")).toBe("refusal");
    expect(classifyStopReason("some_future_reason")).toBe("done");
    expect(classifyStopReason(undefined)).toBe("done");
  });
});
