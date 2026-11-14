import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService, ControlStore, handleControlRequest } from "@laun/control";
import type { AgentRuntime, RuntimeCallbacks, RuntimeRunInput } from "@laun/protocol";
import { createPiRuntime } from "@laun/runtime";
import { controllerUrl, loadWorkerConfig } from "./config.js";
import { WorkerJournal } from "./journal.js";
import { OutboundWorker } from "./worker.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const principal = { id: "owner", admin: false };
function directory() { const p = mkdtempSync(join(tmpdir(), "laun-yard-test-")); cleanups.push(() => rmSync(p, { recursive: true, force: true })); return p; }
async function until(predicate: () => boolean, label: string) {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > until) throw new Error(`timeout: ${label}`); await Bun.sleep(5); }
}

function controller(options: { loseEventAck?: boolean } = {}) {
  const dir = directory();
  const store = new ControlStore(join(dir, "control.sqlite"));
  const service = new ControlService({ store, dataDir: join(dir, "controller"), mode: "unconfigured" });
  const { worker, key } = store.registerWorker(principal, { name: "WSL test yard", capacity: 2 });
  const mower = store.createMower(principal, { name: "Fern", model: "faux/faux-1", workerId: worker.id });
  const thread = store.createThread(principal, { mowerId: mower.id, title: "Remote thread" });
  let lost = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const response = await handleControlRequest(service, req, principal);
    if (options.loseEventAck && !lost && new URL(req.url).pathname.endsWith("/worker/events") && response.ok) {
      lost = true; return Response.json({ error: "test proxy dropped the stored event acknowledgement" }, { status: 503 });
    }
    return response;
  } });
  cleanups.push(async () => { server.stop(true); await service.close(); store.close(); });
  return { store, service, worker, key, thread, url: `http://127.0.0.1:${server.port}` };
}
function runtime(run: (input: RuntimeRunInput, callbacks: RuntimeCallbacks) => ReturnType<AgentRuntime["run"]>): AgentRuntime {
  return { run, cancel() {}, close() {} };
}
function yard(c: ReturnType<typeof controller>, agent: AgentRuntime, dir = directory()) {
  const worker = new OutboundWorker({ controllerUrl: c.url, workerKey: c.key, dataDir: dir, runtime: agent, heartbeatMs: 100, approvalTimeoutMs: 5000 });
  cleanups.push(() => worker.close()); return { worker, dir };
}

describe("outbound yard with real controller HTTP", () => {
  test("real Pi Durable adapter works through an outbound yard across worker reopen", async () => {
    const c = controller(); const dir = directory();
    const first = yard(c, createPiRuntime({ trustedLocal: true, enableFaux: true }), dir).worker;
    const a = c.store.submit(principal, c.thread.id, { text: "first durable mower message", requestId: "durable-1" });
    await first.tick(); await first.whenIdle();
    expect(c.store.run(a.id).status).toBe("done");
    expect(c.store.run(a.id).summary).toContain("first durable mower message");
    await first.close();
    const second = yard(c, createPiRuntime({ trustedLocal: true, enableFaux: true }), dir).worker;
    const b = c.store.submit(principal, c.thread.id, { text: "second durable mower message", requestId: "durable-2" });
    await second.tick(); await second.whenIdle();
    expect(c.store.run(b.id).status).toBe("done");
    expect(c.store.run(b.id).summary).toContain("second durable mower message");
    expect(readdirSync(join(dir, "threads", c.thread.id, "session", "pi")).length).toBeGreaterThan(0);
  }, 20_000);

  test("remote run awaits an exact central approval and finishes with durable events", async () => {
    const c = controller(); let effects = 0;
    const { worker, dir } = yard(c, runtime(async (input, callbacks) => {
      await callbacks.emit({ type: "text", sessionId: input.threadId, delta: "Preparing command" });
      await callbacks.authorize({ operation: "process.execute", resource: "workspace:own", arguments: { command: "create marker" } });
      effects++;
      await callbacks.emit({ type: "done", sessionId: input.threadId, summary: "Approved work completed" });
      return { status: "done", summary: "Approved work completed" };
    }));
    const run = c.store.submit(principal, c.thread.id, { text: "Do approved work", requestId: "input-1" });
    await worker.tick();
    await until(() => c.store.approvals(principal).some((a) => a.status === "pending"), "permission request");
    expect(effects).toBe(0);
    const approval = c.store.approvals(principal)[0]!;
    expect(approval.action.operation).toBe("process.execute");
    c.store.decide(principal, approval.id, "approve");
    await worker.whenIdle();
    expect(effects).toBe(1); expect(c.store.run(run.id).status).toBe("done");
    expect(c.store.approval(approval.id).status).toBe("consumed");
    const events = c.store.events(principal, c.thread.id).events;
    expect(events.filter((e) => e.kind === "agent")).toHaveLength(2);
    const journals = new WorkerJournal(join(dir, "journal")).list();
    expect(journals[0]!.nextSequence).toBe(2); expect(journals[0]!.phase).toBe("reported");
    expect(readFileSync(join(dir, "journal", readdirSync(join(dir, "journal"))[0]!), "utf8")).not.toContain(c.key);
    await worker.tick(); expect(effects).toBe(1);
  }, 10_000);

  test("denied permission never reaches the remote side effect", async () => {
    const c = controller(); let effects = 0;
    const { worker } = yard(c, runtime(async (_input, callbacks) => {
      try { await callbacks.authorize({ operation: "process.execute", resource: "workspace:own", arguments: { command: "blocked" } }); }
      catch { return { status: "error", summary: "Permission denied; command was not executed" }; }
      effects++; return { status: "done" };
    }));
    const run = c.store.submit(principal, c.thread.id, { text: "Ask first", requestId: "deny-1" });
    await worker.tick();
    await until(() => c.store.approvals(principal).some((a) => a.status === "pending"), "pending decision");
    c.store.decide(principal, c.store.approvals(principal)[0]!.id, "deny");
    await worker.whenIdle();
    expect(effects).toBe(0); expect(c.store.run(run.id).status).toBe("error");
  }, 10_000);

  test("lost event acknowledgement deduplicates the outbox and stops subsequent effects", async () => {
    const c = controller({ loseEventAck: true }); let effects = 0;
    const { worker, dir } = yard(c, runtime(async (input, callbacks) => {
      await callbacks.emit({ type: "text", sessionId: input.threadId, delta: "Exactly one durable event" });
      await callbacks.authorize({ operation: "workspace.write", resource: "workspace:own", arguments: { path: "marker" } });
      effects++; return { status: "done" };
    }));
    const run = c.store.submit(principal, c.thread.id, { text: "Network fault", requestId: "fault-1" });
    await worker.tick(); await worker.whenIdle();
    expect(effects).toBe(0); expect(c.store.run(run.id).status).toBe("interrupted");
    const events = c.store.events(principal, c.thread.id).events.filter((e) => e.kind === "agent");
    expect(events).toHaveLength(1);
    expect(new WorkerJournal(join(dir, "journal")).list()[0]!.phase).toBe("reported");
  }, 10_000);

  test("restart with a running journal requires reconciliation instead of replay", async () => {
    const c = controller(); const dir = directory(); let calls = 0;
    const run = c.store.submit(principal, c.thread.id, { text: "Interrupted work", requestId: "restart-1" });
    const job = c.store.claim(c.worker)!;
    new WorkerJournal(join(dir, "journal")).save({ runId: job.run.id, threadId: c.thread.id, generation: job.run.generation,
      phase: "running", nextSequence: 0, events: [], updatedAt: new Date().toISOString() });
    const { worker } = yard(c, runtime(async () => { calls++; return { status: "done" }; }), dir);
    await worker.tick(); expect(calls).toBe(0); expect(c.store.run(run.id).status).toBe("interrupted");
    const reply = await fetch(`${c.url}/api/v2/runs/${run.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmedStopped: true }) });
    expect(reply.ok).toBe(true);
    await worker.tick(); await worker.whenIdle();
    expect(calls).toBe(1); expect(c.store.run(run.id).generation).toBe(2); expect(c.store.run(run.id).status).toBe("done");
  }, 10_000);
});

describe("worker setup and transport guardrails", () => {
  test("rejects plaintext remote URLs, credentials and absent trust choice", () => {
    expect(controllerUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(controllerUrl("https://controller.example")).toBe("https://controller.example");
    for (const value of ["http://192.168.1.2:8080", "http://example.com", "https://key@example.com", "https://example.com/path", "https://example.com?token=secret"]) expect(() => controllerUrl(value)).toThrow();
    const key = `yard_00000000-0000-0000-0000-000000000000_${"a".repeat(43)}`;
    expect(() => loadWorkerConfig({ LAUN_WORKER_KEY: key })).toThrow("choose OpenShell");
    expect(loadWorkerConfig({ LAUN_WORKER_KEY: key, LAUN_TRUSTED_LOCAL: "true" }).runtime.openshellEnabled).toBe(false);
    expect(() => loadWorkerConfig({ LAUN_WORKER_KEY: key, OPENSHELL_ENABLED: "true" })).toThrow("SANDBOX_IMAGE");
  });
});
