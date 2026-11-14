import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./server.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "laun-history-")); dirs.push(dir);
  const config = { port: 0, gatewayToken: "t", executorUrl: "http://localhost:9", dataDir: dir, publicDir: dir, autoResume: false };
  return { config, gw: createGateway(config) };
}

describe("bounded display history with lifetime state", () => {
  test("absolute cursors advance through eviction and remain stable after reopen", () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    for (let i = 0; i < 2100; i++) gw.publish(rec.id, { type: "text", sessionId: rec.id, delta: String(i) });
    expect(gw.log(rec.id, 0)).toMatchObject({ next: 2100, oldest: 100 });
    expect(gw.log(rec.id, 0).events).toHaveLength(2000);
    const cursor = gw.log(rec.id, 0).next;
    gw.publish(rec.id, { type: "text", sessionId: rec.id, delta: "new" });
    expect(gw.log(rec.id, cursor).events).toEqual([{ type: "text", sessionId: rec.id, delta: "new" }]);
    const restored = createGateway(config);
    expect(restored.log(rec.id, cursor)).toEqual(gw.log(rec.id, cursor));
    expect(restored.log(rec.id, 2101).events).toEqual([]);
  });

  test("usage and pending approvals survive display eviction and replay", () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw.publish(rec.id, { type: "usage", sessionId: rec.id, totalTokens: 95 });
    gw.publish(rec.id, { type: "approval_request", sessionId: rec.id, requestId: "old", reason: "pending" });
    for (let i = 0; i < 2100; i++) gw.publish(rec.id, { type: "text", sessionId: rec.id, delta: "work" });
    gw.publish(rec.id, { type: "usage", sessionId: rec.id, inputTokens: 10, outputTokens: 5 });
    gw.sessions.setStatus(rec.id, "done");
    expect(gw.sessionTokens(rec.id)).toBe(110);
    const restored = createGateway(config);
    expect(restored.sessionTokens(rec.id)).toBe(110);
    expect(restored.pendingApprovals(rec.id).map((a) => a.requestId)).toEqual(["old"]);
    expect(restored.log(rec.id, 0).events.some((e) => e.type === "approval_request")).toBe(false);
  });

  test("timeout denial settles an evicted approval live and after reopen", () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw.publish(rec.id, { type: "approval_request", sessionId: rec.id, requestId: "old", reason: "pending" });
    for (let i = 0; i < 2100; i++) gw.publish(rec.id, { type: "text", sessionId: rec.id, delta: "work" });
    gw.publish(rec.id, { type: "status", sessionId: rec.id, status: "running", message: "approval old denied (timeout)" });
    gw.sessions.setStatus(rec.id, "done");
    expect(gw.pendingApprovals(rec.id)).toEqual([]);
    expect(createGateway(config).pendingApprovals(rec.id)).toEqual([]);
  });

  test("boot recovery with restored over-budget usage initializes before aborting", async () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw.publish(rec.id, { type: "usage", sessionId: rec.id, totalTokens: 110 });
    gw.sessions.setStatus(rec.id, "running");
    const restored = createGateway({ ...config, autoResume: true, maxSessionTokens: 100 });
    // Both executor calls fail asynchronously: the important invariant is no TDZ
    // rejection before runAgent's try/finally, which used to leave running stuck.
    for (let n = 0; n < 100 && restored.running.has(rec.id); n++) await Bun.sleep(5);
    expect(restored.running.has(rec.id)).toBe(false);
    expect(restored.sessions.get(rec.id)?.status).toBe("error");
  });

  test("failed index deletion preserves the session and its event history", async () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw.publish(rec.id, { type: "text", sessionId: rec.id, delta: "preserve me" });
    rmSync(join(config.dataDir, "index.json"));
    mkdirSync(join(config.dataDir, "index.json"));
    await expect(gw.deleteSession(rec.id)).rejects.toThrow();
    expect(gw.sessions.get(rec.id)).toBeDefined();
    expect(existsSync(join(config.dataDir, `events-${rec.id}.jsonl`))).toBe(true);
    expect(gw.log(rec.id, 0).events).toEqual([{ type: "text", sessionId: rec.id, delta: "preserve me" }]);
  });

  test("failed startup status persistence releases the detached run slot", async () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    rmSync(join(config.dataDir, "index.json"));
    mkdirSync(join(config.dataDir, "index.json"));
    await gw.sendMessage(rec.id, { text: "cannot start" });
    expect(gw.running.has(rec.id)).toBe(false);
  });

  test("corrupt authoritative history refuses replay rather than losing usage", () => {
    const { config, gw } = setup();
    const rec = gw.sessions.create({ goal: "g", model: "m", runtime: "pi" });
    gw.publish(rec.id, { type: "usage", sessionId: rec.id, totalTokens: 99 });
    const path = join(config.dataDir, `events-${rec.id}.jsonl`);
    appendFileSync(path, '{"type":"usage"');
    const original = readFileSync(path, "utf8");
    const restored = createGateway(config);
    expect(() => restored.sessionTokens(rec.id)).toThrow("cannot replay session events");
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
