import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@laun/protocol";
import { MAX_EXECUTOR_EVENT_CHARS, readExecutorEvents } from "./executorClient.js";

const encoder = new TextEncoder();
const id = "thread1";
const record = (event: unknown) => JSON.stringify(event) + "\n";
const done = { type: "done", sessionId: id } satisfies AgentEvent;

function source(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of readExecutorEvents(stream, id)) events.push(event);
  return events;
}

describe("executor event stream", () => {
  test("decodes UTF-8 split inside a character and accepts CRLF / complete final JSON", async () => {
    const text = { type: "text", sessionId: id, delta: "mower 🌱" } satisfies AgentEvent;
    const bytes = encoder.encode(record(text).replace("\n", "\r\n") + JSON.stringify(done));
    const split = bytes.indexOf(0xf0) + 2;
    const stream = source([bytes.slice(0, split), bytes.slice(split)]);
    expect(await collect(stream)).toEqual([text, done]);
    expect(stream.locked).toBe(false);
  });

  test("rejects EOF after partial output instead of reporting success", async () => {
    await expect(collect(source([encoder.encode(record({ type: "text", sessionId: id, delta: "partial" }))])))
      .rejects.toThrow("without a terminal event");
    await expect(collect(source([]))).rejects.toThrow("without a terminal event");
  });

  test("interim errors during recovery do not excuse a truncated resumed run", async () => {
    const events: AgentEvent[] = [
      { type: "error", sessionId: id, message: "provider disconnected" },
      { type: "status", sessionId: id, status: "running", message: "retrying" },
    ];
    await expect(collect(source([encoder.encode(events.map(record).join(""))])))
      .rejects.toThrow("without a terminal event");
    const terminal = { type: "status", sessionId: id, status: "error", message: "retries exhausted" } satisfies AgentEvent;
    expect(await collect(source([encoder.encode([...events, terminal].map(record).join(""))])))
      .toEqual([...events, terminal]);
  });

  test("rejects cross-session and malformed event payloads", async () => {
    for (const [event, reason] of [
      [{ type: "done", sessionId: "sibling" }, "session mismatch"],
      [{ type: "done", sessionId: id, summary: 3 }, "invalid event"],
      [{ type: "status", sessionId: id, status: "success" }, "invalid event"],
      [{ type: "usage", sessionId: id, totalTokens: -10 }, "invalid event"],
      [{ type: "tool_result", sessionId: id, name: "bash", ok: "yes" }, "invalid event"],
      [{ type: "future_unknown", sessionId: id }, "invalid event"],
    ] as const) {
      await expect(collect(source([encoder.encode(record(event))]))).rejects.toThrow(reason);
    }
  });

  test("rejects malformed JSON and invalid UTF-8", async () => {
    await expect(collect(source([encoder.encode('{"type":"done"')]))).rejects.toThrow("malformed JSON");
    await expect(collect(source([new Uint8Array([0xff])]))).rejects.toThrow();
  });

  test("bounds complete and unterminated records before parsing", async () => {
    for (const suffix of ["", "\n"]) {
      const bytes = encoder.encode("x".repeat(MAX_EXECUTOR_EVENT_CHARS + 1) + suffix);
      await expect(collect(source([bytes]))).rejects.toThrow("record limit");
    }
  });

  test("cancels upstream and releases the lock when consumer leaves early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(record({ type: "text", sessionId: id, delta: "hello" })));
      },
      cancel() { cancelled = true; },
    });
    for await (const event of readExecutorEvents(stream, id)) {
      expect(event.type).toBe("text");
      break;
    }
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("cancels malformed live streams and releases the lock", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("malformed\n")); },
      cancel() { cancelled = true; },
    });
    await expect(collect(stream)).rejects.toThrow("malformed JSON");
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
