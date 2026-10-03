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

describe("event persistence + boot recovery", () => {
  function gwAt(dir: string) {
    return createGateway(
      { port: 8080, gatewayToken: "t", executorUrl: "http://localhost:9", dataDir: dir },
      new SessionStore(dir),
    );
  }

  test("events survive a restart via JSONL replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-persist-"));
    const gw1 = gwAt(dir);
    const rec = gw1.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw1.publish(rec.id, { type: "text", sessionId: rec.id, delta: "hello" });
    gw1.publish(rec.id, { type: "approval_request", sessionId: rec.id, requestId: "r1", reason: "need x" });

    const gw2 = gwAt(dir);
    // boot recovery marked the waiting_approval session errored (its run died with gw1),
    // but the approval request itself still replays as pending.
    expect(gw2.sessions.get(rec.id)?.status).toBe("error");
    const log = gw2.log(rec.id, 0);
    expect(log.events.length).toBe(3);
    expect(gw2.pendingApprovals(rec.id).map((a) => a.requestId)).toEqual(["r1"]);
    // decided approvals are not resurrected
    gw2.decideApproval(rec.id, { requestId: "r1", decision: "approve" });
    const gw3 = gwAt(dir);
    expect(gw3.pendingApprovals(rec.id)).toEqual([]);
  });

  test("stale running sessions become errors on boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-stale-"));
    const gw1 = gwAt(dir);
    const rec = gw1.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw1.sessions.setStatus(rec.id, "running");

    const gw2 = gwAt(dir);
    expect(gw2.sessions.get(rec.id)?.status).toBe("error");
    expect(
      gw2.log(rec.id, 0).events.some((e) => e.type === "error" && e.message.includes("restarted")),
    ).toBe(true);
  });
});
