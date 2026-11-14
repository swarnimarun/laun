import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService, ControlStore, handleControlRequest, moveThreadWorker } from "@laun/control";
import { checkpointReference } from "@laun/storage";
import type { AgentRuntime, RuntimeCallbacks, RuntimeRunInput } from "@laun/protocol";
import { createPiRuntime, createPiInference } from "@laun/runtime";
import type { RuntimeInferenceService } from "@laun/protocol";
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

function controller(options: { loseEventAck?: boolean;loseDurableAck?:boolean;loseFinishAck?:boolean;inference?:RuntimeInferenceService } = {}) {
  const dir = directory();
  const store = new ControlStore(join(dir, "control.sqlite"));
  const service = new ControlService({ store,inference:options.inference, dataDir: join(dir, "controller"), mode: "unconfigured" });
  const { worker, key } = store.registerWorker(principal, { name: "WSL test yard", capacity: 2 });
  const mower = store.createMower(principal, { name: "Fern", model: "faux/faux-1", workerId: worker.id });
  const thread = store.createThread(principal, { mowerId: mower.id, title: "Remote thread" });
  let lost = false,lostDurable=false,lostFinish=false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const response = await handleControlRequest(service, req, principal);
    if(options.loseFinishAck&&!lostFinish&&new URL(req.url).pathname.endsWith("/worker/finish")&&response.ok){lostFinish=true;return Response.json({error:"test proxy dropped final acknowledgement"},{status:503});}
    if(options.loseDurableAck&&!lostDurable&&new URL(req.url).pathname.endsWith("/worker/durable-append")&&response.ok){lostDurable=true;return Response.json({error:"test proxy dropped a durable acknowledgement"},{status:503});}
    if (options.loseEventAck && !lost && new URL(req.url).pathname.endsWith("/worker/events") && response.ok) {
      lost = true; return Response.json({ error: "test proxy dropped the stored event acknowledgement" }, { status: 503 });
    }
    return response;
  } });
  cleanups.push(async () => { server.stop(true); await service.close(); store.close(); });
  return { store, service, worker, key, thread, url: `http://127.0.0.1:${server.port}` };
}
function runtime(run: (input: RuntimeRunInput, callbacks: RuntimeCallbacks) => ReturnType<AgentRuntime["run"]>): AgentRuntime {
  return { run, cancel() {}, close() {},durabilityAdapter:{adapter:"fixture@1",version:1} };
}
function yard(c: ReturnType<typeof controller>, agent: AgentRuntime, dir = directory()) {
  const worker = new OutboundWorker({ controllerUrl: c.url, workerKey: c.key, dataDir: dir, runtime: agent, heartbeatMs: 100, approvalTimeoutMs: 5000 });
  cleanups.push(() => worker.close()); return { worker, dir };
}

describe("outbound yard with real controller HTTP", () => {
  test("lost durable acknowledgement stops before model cost and resumes only after operator reconciliation",async()=>{
    let calls=0;const inference=createPiInference({enableFaux:true}),stream=inference.stream.bind(inference);inference.stream=async function*(...args){calls++;yield* stream(...args);};
    const c=controller({loseDurableAck:true,inference}),dir=directory();
    let worker=new OutboundWorker({controllerUrl:c.url,workerKey:c.key,dataDir:dir,inferenceMode:"controller",runtime:createPiRuntime({trustedLocal:true}),heartbeatMs:100});const original=worker;cleanups.push(()=>original.close());
    const run=c.store.submit(principal,c.thread.id,{text:"Only after journal ACK",requestId:"lost-durable-ack"});await worker.tick();await worker.whenIdle();expect(c.store.run(run.id).status).toBe("interrupted");expect(calls).toBe(0);expect((c.store.db.query("SELECT COUNT(*) n FROM durable_commits").get() as {n:number}).n).toBe(1);await worker.close();
    const response=await fetch(`${c.url}/api/v2/runs/${run.id}/resume`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({confirmedStopped:true})});expect(response.status).toBe(200);
    worker=new OutboundWorker({controllerUrl:c.url,workerKey:c.key,dataDir:dir,inferenceMode:"controller",runtime:createPiRuntime({trustedLocal:true}),heartbeatMs:100});const resumed=worker;cleanups.push(()=>resumed.close());await worker.tick();await worker.whenIdle();expect(c.store.run(run.id).status).toBe("done");expect(calls).toBe(1);expect(c.store.run(run.id).generation).toBe(2);
  },20_000);
  test("remote Pi uses the controller model registry without worker model credentials or a local fallback",async()=>{
    const c=controller({inference:createPiInference({enableFaux:true})});
    const worker=new OutboundWorker({controllerUrl:c.url,workerKey:c.key,dataDir:directory(),inferenceMode:"controller",runtime:createPiRuntime({trustedLocal:true,authFile:join(directory(),"unprovisioned-auth.json")}),heartbeatMs:100});cleanups.push(()=>worker.close());
    const run=c.store.submit(principal,c.thread.id,{text:"Central inference without secrets on the yard",requestId:"central-real-pi"});
    await worker.tick();await worker.whenIdle();expect(c.store.run(run.id).status).toBe("done");expect(c.store.run(run.id).summary).toContain("controller inference demonstration");
    expect(c.store.db.query("SELECT status,COUNT(*) n FROM inference_calls GROUP BY status").all()).toEqual([{status:"done",n:1}]);
    expect(c.store.get<any>("worker",c.worker.id).inferenceMode).toBe("controller");
    const usage=c.store.events(principal,c.thread.id).events.filter(e=>e.payload.event?.type==="usage");expect(usage).toHaveLength(1);expect(usage[0]!.payload.source).toBe("inference-controller");
  },20_000);
  test("A to B to A placement restores B's newest durable history instead of A's stale cache",async()=>{
    const c=controller(),aDir=directory();
    let a=yard(c,createPiRuntime({trustedLocal:true,enableFaux:true}),aDir).worker;
    const first=c.store.submit(principal,c.thread.id,{text:"first on A",requestId:"place-a1"});await a.tick();await a.whenIdle();expect(c.store.run(first.id).status).toBe("done");await a.close();
    const bRegistration=c.store.registerWorker(principal,{name:"Second yard"}),bDir=directory();
    const b=new OutboundWorker({controllerUrl:c.url,workerKey:bRegistration.key,dataDir:bDir,runtime:createPiRuntime({trustedLocal:true,enableFaux:true}),heartbeatMs:100});cleanups.push(()=>b.close());
    await b.tick();
    moveThreadWorker(c.store,principal,c.thread.id,{workerId:bRegistration.worker.id,expectedWorkerId:c.worker.id,checkpointSha256:checkpointReference(c.store.checkpoint(c.thread.id)!,c.thread.id).sha256,confirmedStopped:true,confirmedOmissions:true});
    const second=c.store.submit(principal,c.thread.id,{text:"second on B ONLY",requestId:"place-b1"});await b.tick();await b.whenIdle();expect(c.store.run(second.id).status).toBe("done");await b.close();
    a=yard(c,createPiRuntime({trustedLocal:true,enableFaux:true}),aDir).worker;await a.tick();
    moveThreadWorker(c.store,principal,c.thread.id,{workerId:c.worker.id,expectedWorkerId:bRegistration.worker.id,checkpointSha256:checkpointReference(c.store.checkpoint(c.thread.id)!,c.thread.id).sha256,confirmedStopped:true,confirmedOmissions:true});
    const third=c.store.submit(principal,c.thread.id,{text:"third returning to A",requestId:"place-a2"});await a.tick();await a.whenIdle();expect(c.store.run(third.id).status).toBe("done");
    const archive=JSON.parse(c.store.checkpoint(c.thread.id)!) as {files:Array<{content:string}>};
    const content=archive.files.map(f=>Buffer.from(f.content,"base64").toString("utf8")).join("\n");expect(content).toContain("second on B ONLY");expect(content).toContain("third returning to A");
    expect(readdirSync(join(aDir,"threads")).some(name=>name.startsWith(`${c.thread.id}.recovery-`))).toBe(true);
  },30_000);
  test("real Pi Durable adapter works through an outbound yard across worker reopen", async () => {
    const c = controller(); const dir = directory();
    const first = yard(c, createPiRuntime({ trustedLocal: true, enableFaux: true }), dir).worker;
    const a = c.store.submit(principal, c.thread.id, { text: "first durable mower message", requestId: "durable-1" });
    await first.tick(); await first.whenIdle();
    expect(c.store.run(a.id).status).toBe("done");
    expect(c.store.run(a.id).summary).toContain("first durable mower message");
    expect(c.store.checkpoint(c.thread.id)).toBeDefined();
    expect(new WorkerJournal(join(dir, "journal")).list()).toEqual([]);
    const storedCheckpoint = c.store.checkpoint(c.thread.id), storedHistory = JSON.stringify(c.store.events(principal, c.thread.id));
    await first.tick();
    expect(c.store.checkpoint(c.thread.id)).toBe(storedCheckpoint); expect(JSON.stringify(c.store.events(principal, c.thread.id))).toBe(storedHistory);
    await first.close();
    // Prove the server owns a restorable Pi history, not just display events.
    rmSync(join(dir,"threads"),{recursive:true,force:true});
    const second = yard(c, createPiRuntime({ trustedLocal: true, enableFaux: true }), dir).worker;
    const b = c.store.submit(principal, c.thread.id, { text: "second durable mower message", requestId: "durable-2" });
    await second.tick(); await second.whenIdle();
    expect(c.store.run(b.id).status).toBe("done");
    expect(c.store.run(b.id).summary).toContain("second durable mower message");
    expect(readdirSync(join(dir, "threads", c.thread.id, "session", "pi")).length).toBeGreaterThan(0);
    const archive=JSON.parse(c.store.checkpoint(c.thread.id)!);
    expect(archive.files.some((f:{content:string})=>Buffer.from(f.content,"base64").toString("utf8").includes("first durable mower message"))).toBe(true);
    expect(archive.files.every((f:{content:string})=>!Buffer.from(f.content,"base64").toString("utf8").includes(c.key))).toBe(true);
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
    expect(new WorkerJournal(join(dir, "journal")).list()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(c.key);
    await worker.tick(); expect(effects).toBe(1);
  }, 10_000);

  test("a lost finish ACK preserves the local outcome across restart despite a terminal controller run", async () => {
    const c = controller({ loseFinishAck: true }), dir = directory(); let calls = 0;
    const agent = () => runtime(async () => { calls++; return { status: "done", summary: "stored centrally" }; });
    const first = yard(c, agent(), dir).worker;
    const run = c.store.submit(principal, c.thread.id, { text: "Finish once", requestId: "lost-finish" }); await first.tick(); await first.whenIdle();
    expect(c.store.run(run.id).status).toBe("done");
    const local = new WorkerJournal(join(dir, "journal")).list(); expect(local).toHaveLength(1); expect(local[0]!.finishAcknowledged).toBeUndefined();
    const history = JSON.stringify(c.store.events(principal, c.thread.id)); await first.close();
    const second = yard(c, agent(), dir).worker; await second.tick(); expect(calls).toBe(1); expect(new WorkerJournal(join(dir, "journal")).list()).toHaveLength(1); expect(JSON.stringify(c.store.events(principal, c.thread.id))).toBe(history);
  });

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

  test("runtime failures cannot persist the enrolled worker key in journals", async () => {
    const c = controller();
    const { worker, dir } = yard(c, runtime(async () => { throw new Error(`bad transport echoed ${c.key}`); }));
    c.store.submit(principal, c.thread.id, { text: "Handle sensitive diagnostic", requestId: "redact-1" });
    await worker.tick(); await worker.whenIdle();
    const raw = readFileSync(join(dir, "journal", readdirSync(join(dir, "journal"))[0]!), "utf8");
    expect(raw).not.toContain(c.key); expect(raw).toContain("[REDACTED]");
  }, 10_000);

  test("cancelled assignment is settled without spending runtime work", async () => {
    const c = controller(); let calls = 0;
    const run = c.store.submit(principal, c.thread.id, { text: "Cancel before process starts", requestId: "cancel-early" });
    c.store.claim(c.worker); c.store.cancel(principal, c.thread.id);
    const { worker } = yard(c, runtime(async () => { calls++; return { status: "done" }; }));
    await worker.tick(); await worker.whenIdle();
    expect(calls).toBe(0); expect(c.store.run(run.id).status).toBe("cancelled");
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
