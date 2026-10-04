// Optional live smoke against a real `goose serve`. NEVER required for
// green: runs only with GOOSE_ACP_LIVE=1 and a `goose` binary present.
// Uses a TEST-ONLY sentinel secret on loopback; kills the server after.

import { describe, expect, test } from "bun:test";
import { runGoose, clearSessionCacheForTests, type AgentEvent } from "./index.js";

const LIVE = process.env["GOOSE_ACP_LIVE"] === "1";
const HAS_GOOSE = Bun.which("goose") !== null;
const RUN = LIVE && HAS_GOOSE;

function mustPort(p: number | undefined, what = "server"): number {
  if (p === undefined) throw new Error(`stub ${what} got no port`);
  return p;
}

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const p = mustPort(s.port, "probe");
  s.stop(true);
  return p;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

(RUN ? describe : describe.skip)("goose live smoke (GOOSE_ACP_LIVE=1)", () => {
  test("prompt against goose serve completes with done", async () => {
    clearSessionCacheForTests();
    const port = freePort();
    const secret = "TEST-ONLY-LIVE-SMOKE-SECRET";
    const child = Bun.spawn(["goose", "serve", "--host", "127.0.0.1", "--port", String(port)], {
      env: { ...process.env, GOOSE_SERVER__SECRET_KEY: secret },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // Ready when /acp answers (401 without the header proves it is up).
      await waitFor(async () => {
        try {
          await fetch(`http://127.0.0.1:${port}/acp`);
          return true;
        } catch {
          return false;
        }
      }, 20_000, "goose serve to listen");
      const events: AgentEvent[] = [];
      const res = await runGoose({
        config: { baseUrl: `http://127.0.0.1:${port}`, secret, workdir: "/tmp" },
        sessionId: "live-smoke",
        prompt: "reply with exactly: hi",
        timeoutMs: 60_000,
        onEvent: (e) => events.push(e),
      });
      expect(res.sawDone).toBe(true);
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await Promise.race([
        child.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }
  }, 90_000);
});
