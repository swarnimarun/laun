import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";

function testGw() {
  const dir = mkdtempSync(join(tmpdir(), "cb-gw-"));
  const store = new SessionStore(dir);
  return createGateway(
    { port: 8080, gatewayToken: "t", executorUrl: "http://localhost:9", dataDir: dir },
    store,
  );
}

describe("gateway config", () => {
  test("requires GATEWAY_TOKEN", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow("GATEWAY_TOKEN");
  });
});

describe("session store", () => {
  test("create/get/list/setStatus round-trip + persist", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-store-"));
    const s = new SessionStore(dir);
    const rec = s.create({ goal: "do thing", model: "m", runtime: "pi" });
    expect(rec.id).toHaveLength(8);
    expect(s.get(rec.id)?.goal).toBe("do thing");
    s.setStatus(rec.id, "done");
    expect(s.get(rec.id)?.status).toBe("done");
    const s2 = new SessionStore(dir);
    expect(s2.get(rec.id)?.status).toBe("done");
  });
});

describe("gateway logic (no executor calls)", () => {
  test("auth checks bearer", () => {
    const gw = testGw();
    expect(gw.auth(new Request("http://x/", { headers: { authorization: "Bearer t" } }))).toBe(true);
    expect(gw.auth(new Request("http://x/"))).toBe(false);
  });

  test("approval decision needs pending request", () => {
    const gw = testGw();
    // createSession triggers a background executor call that will fail (bad URL) —
    // approval logic itself is what we test; wait a tick for the failure path to settle.
    const rec = gw.createSession({ goal: "hi" });
    expect(() => gw.decideApproval(rec.id, { requestId: "nope", decision: "approve" })).toThrow("approval request not found");
    gw.publish(rec.id, { type: "approval_request", sessionId: rec.id, requestId: "r1", reason: "need sudo" });
    gw.decideApproval(rec.id, { requestId: "r1", decision: "deny" }, "tester");
    expect(gw.pendingApprovals(rec.id)).toEqual([]);
    const log = gw.log(rec.id, 0);
    expect(log.events.some((e) => e.type === "status" && (e.message ?? "").includes("r1 deny"))).toBe(true);
  });

  test("sendMessage validates", () => {
    const gw = testGw();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    expect(() => gw.sendMessage("missing", { text: "hi" })).toThrow("session not found");
    expect(() => gw.sendMessage(rec.id, { text: "   " })).toThrow("text is required");
  });
});
