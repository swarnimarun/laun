import { describe, expect, test } from "bun:test";
import { STREAMING_SERVE_OPTIONS } from "./serve.js";

describe("gateway streaming serve options", () => {
  // The gateway's SSE sends a heartbeat every 15s, which is SLOWER than Bun's
  // default 10s idle timeout — without this, SSE connections were being killed
  // mid-session. The behavioural proof for the shared semantics lives in
  // apps/executor/src/serve.test.ts; this guards the gateway's own copy.
  test("idle timeout disabled so long-lived SSE survives", () => {
    expect(STREAMING_SERVE_OPTIONS.idleTimeout).toBe(0);
  });
});
