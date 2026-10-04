import { describe, expect, test } from "bun:test";
import { STREAMING_SERVE_OPTIONS } from "./serve.js";

describe("streaming serve options", () => {
  test("a silent streaming response survives longer than Bun's 10s default idle timeout", async () => {
    // Regression: Bun closes an idle connection after 10s by default. POST /run
    // writes nothing while a blocking tool runs, so responses died ~10s into the
    // tool and every terminal status event was lost (curl exit 18, runs invisible
    // to the gateway). This test uses the exact options we ship and must fail if
    // `idleTimeout: 0` is removed — then the connection dies at ~10s and the
    // second chunk never arrives.
    const server = Bun.serve({
      port: 0,
      ...STREAMING_SERVE_OPTIONS,
      async fetch() {
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(enc.encode("first\n"));
              await new Promise((r) => setTimeout(r, 12_000)); // silent past the default window
              controller.enqueue(enc.encode("second\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
      },
    });
    try {
      const res = await fetch(`http://localhost:${server.port}/`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();

      const first = await reader.read();
      expect(dec.decode(first.value)).toContain("first");

      // Still silent past 10s: the server must not have torn the connection down.
      const second = await reader.read();
      expect(second.done).toBe(false);
      expect(dec.decode(second.value)).toContain("second");

      const end = await reader.read();
      expect(end.done).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("the timeout is explicitly disabled, not merely lenient", () => {
    expect(STREAMING_SERVE_OPTIONS.idleTimeout).toBe(0);
  });
});
