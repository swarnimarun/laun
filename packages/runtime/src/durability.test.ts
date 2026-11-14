import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { InferenceJsonValue, RuntimeDurabilityAppend, RuntimeDurabilityClient, RuntimeDurabilityRecord, RuntimeRunInput } from "@laun/protocol";
import { createPiRuntime } from "./index.js";
import { durabilityRequestId, openServerBackedStorage } from "./durability.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "laun-central-durable-")); directories.push(path); return path; }
const sortedJson = (value: InferenceJsonValue): InferenceJsonValue => Array.isArray(value) ? value.map(sortedJson) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key]!)])) : value;
function ledger(pageSize = 100) {
  const records: RuntimeDurabilityRecord[] = [];
  let intercept: ((request: RuntimeDurabilityAppend) => Promise<void>) | undefined;
  const client: RuntimeDurabilityClient = {
    async load(after) {
      const page = records.slice(after, after + pageSize);
      return { records: structuredClone(page), headSequence: records.length, nextSequence: after + page.length, hasMore: after + page.length < records.length };
    },
    async append(request) {
      if (request.expectedSequence !== records.length || request.requestId !== durabilityRequestId(records.length, request.envelope)) throw new Error("ledger conflict");
      await intercept?.(request);
      // Match the controller's canonical SQLite serialization, including key
      // ordering rather than accidentally preserving SDK insertion order.
      records.push({ sequence: records.length + 1, requestId: request.requestId, envelope: sortedJson(request.envelope as unknown as InferenceJsonValue) as unknown as RuntimeDurabilityRecord["envelope"] });
      return { sequence: records.length };
    },
  };
  return { records, client, intercept: (value: typeof intercept) => { intercept = value; } };
}

test("server ACK gates durability receipts and concurrent storage reads", async () => {
  const base = await directory(), central = ledger();
  const durable = await openServerBackedStorage(join(base, "session/pi"), central.client, new AbortController().signal);
  const id = await durable.storage.mintId<ConversationId>();
  let acknowledge!: () => void, entered!: () => void, received = false, read = false;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  central.intercept(async () => { entered(); await new Promise<void>((resolve) => { acknowledge = resolve; }); });
  const committing = durable.storage.commit([[{ type: "conversation", value: { id } }]], () => { received = true; }, BACKGROUND_CONTEXT);
  await waiting;
  const reading = durable.storage.conversation(id, BACKGROUND_CONTEXT).then((value) => { read = true; return value; });
  await Bun.sleep(10);
  expect(received).toBe(false); expect(read).toBe(false); expect(central.records).toHaveLength(1);
  acknowledge(); expect((await committing).stored).toBe(1); expect(received).toBe(true);
  expect((await reading)?.id).toBe(id); expect(central.records).toHaveLength(2);
  await durable.storage.close(BACKGROUND_CONTEXT);
});

test("lost append ACK poisons the writer, and replay ignores a corrupt local cache", async () => {
  const base = await directory(), central = ledger(1), path = join(base, "session/pi");
  const durable = await openServerBackedStorage(path, central.client, new AbortController().signal), id = await durable.storage.mintId<ConversationId>();
  const accepting = central.client.append;
  central.client.append = async (request, signal) => { await accepting(request, signal); throw new Error("ACK connection lost"); };
  let receipt = false;
  await expect(durable.storage.commit([[{ type: "conversation", value: { id } }]], () => { receipt = true; }, BACKGROUND_CONTEXT)).rejects.toThrow("no confirmed server acknowledgment");
  expect(receipt).toBe(false); expect(durable.uncertain()).toBe(true);
  await expect(durable.storage.conversation(id, BACKGROUND_CONTEXT)).rejects.toThrow("no confirmed server acknowledgment");
  await expect(durable.storage.close(BACKGROUND_CONTEXT)).rejects.toThrow("no confirmed server acknowledgment");
  await writeFile(join(path, "main.jsonl"), "local cache must not be trusted\n"); central.client.append = accepting;
  const restored = await openServerBackedStorage(path, central.client, new AbortController().signal);
  expect((await restored.storage.conversation(id, BACKGROUND_CONTEXT))?.id).toBe(id);
  const old = await readdir(join(base, "runtime-recovery")); expect(old).toHaveLength(1);
  expect(await readFile(join(base, "runtime-recovery", old[0]!, "main.jsonl"), "utf8")).toContain("local cache must not be trusted");
  expect((await readdir(join(base, "session"))).some((name) => name.includes("preserved"))).toBe(false);
  await restored.storage.close(BACKGROUND_CONTEXT);
});

test("only the prefix accepted by upstream storage enters the central ledger", async () => {
  const base = await directory(), central = ledger();
  const durable = await openServerBackedStorage(join(base, "session/pi"), central.client, new AbortController().signal), id = await durable.storage.mintId<ConversationId>();
  const writes = [{ type: "conversation" as const, value: { id } }], receipts: number[] = [];
  const result = await durable.storage.commit([writes, writes], (index) => { receipts.push(index); }, BACKGROUND_CONTEXT);
  expect(result.stored).toBe(1); expect(result.refused).toBeDefined(); expect(receipts).toEqual([0]);
  const payload = central.records[1]!.envelope.payload as { batches: unknown[] }; expect(payload.batches).toHaveLength(1);
  await durable.storage.close(BACKGROUND_CONTEXT);
});

test("three runtime reopens reuse identical ACKed caches without growing recovery archives", async () => {
  const base = await directory(), central = ledger(2), models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("third")]);
  const input: RuntimeRunInput = { threadId: "thread", runId: "one", prompt: "remember progress", model: "faux/faux-1", workspaceRoot: join(base, "work"), sessionDir: join(base, "session") };
  for (let run = 1; run <= 3; run++) {
    const runtime = createPiRuntime({ models, trustedLocal: true });
    expect((await runtime.run({ ...input, runId: `run-${run}` }, { emit() {}, authorize: async () => {}, durability: central.client })).status).toBe("done");
    await runtime.close(); expect(existsSync(join(base, "runtime-recovery"))).toBe(false);
  }
  const hashes = async () => Promise.all((await readdir(join(base, "session/pi"))).sort().map(async (name) => [name, await Bun.file(join(base, "session/pi", name)).text()]));
  const native = await hashes(), restored = await openServerBackedStorage(join(base, "session/pi"), central.client, new AbortController().signal);
  expect(await hashes()).toEqual(native); expect(existsSync(join(base, "runtime-recovery"))).toBe(false); await restored.storage.close(BACKGROUND_CONTEXT);
});

test("binary and executable SDK payloads fail before a local or server commit", async () => {
  for (const invalid of [new Uint8Array([1, 2]), new Date(), { toJSON: () => { throw new Error("must not invoke serialization hooks"); } }]) {
    const base = await directory(), central = ledger(), durable = await openServerBackedStorage(join(base, "session/pi"), central.client, new AbortController().signal);
    const id = await durable.storage.mintId<ConversationId>();
    const writes = [{ type: "conversation", value: { id, unexpected: invalid } }] as unknown as StorageWrite[];
    let receipt = false;
    await expect(durable.storage.commit([writes], () => { receipt = true; }, BACKGROUND_CONTEXT)).rejects.toThrow("no confirmed server acknowledgment");
    expect(receipt).toBe(false); expect(central.records).toHaveLength(1); await durable.storage.close(BACKGROUND_CONTEXT).catch(() => {});
  }
});

test("seed snapshots reject non-Pi files before transferring any local credential data", async () => {
  const base = await directory(), central = ledger(), path = join(base, "session/pi");
  await mkdir(path, { recursive: true }); await writeFile(join(path, "auth.json"), '{"secret":"must not upload"}');
  await expect(openServerBackedStorage(path, central.client, new AbortController().signal)).rejects.toThrow("could not be confirmed");
  expect(central.records).toHaveLength(0); expect(await readFile(join(path, "auth.json"), "utf8")).toContain("must not upload");
});

test("a malformed authoritative snapshot cannot replace the surviving local cache", async () => {
  const base = await directory(), central = ledger(), path = join(base, "session/pi");
  const durable = await openServerBackedStorage(path, central.client, new AbortController().signal); await durable.storage.close(BACKGROUND_CONTEXT);
  await writeFile(join(path, "local-evidence"), "preserve me");
  const record = central.records[0]!;
  record.envelope.payload = { kind: "snapshot", files: [{ path: "../outside", content: "", sha256: "0".repeat(64) }] };
  record.requestId = durabilityRequestId(0, record.envelope);
  await expect(openServerBackedStorage(path, central.client, new AbortController().signal)).rejects.toThrow("could not be confirmed");
  expect(await readFile(join(path, "local-evidence"), "utf8")).toBe("preserve me"); expect(existsSync(join(base, "session/outside"))).toBe(false);
});

test("a changed replay head is rejected before the rebuilt cache is installed", async () => {
  const base = await directory(), central = ledger(1), path = join(base, "session/pi");
  const durable = await openServerBackedStorage(path, central.client, new AbortController().signal), id = await durable.storage.mintId<ConversationId>();
  await durable.storage.commit([[{ type: "conversation", value: { id } }]], () => {}, BACKGROUND_CONTEXT); await durable.storage.close(BACKGROUND_CONTEXT);
  await writeFile(join(path, "local-evidence"), "preserve me");
  const loading = central.client.load;
  central.client.load = async (after, signal) => { const page = await loading(after, signal); if (after) page.headSequence++; return page; };
  await expect(openServerBackedStorage(path, central.client, new AbortController().signal)).rejects.toThrow("could not be confirmed");
  expect(await readFile(join(path, "local-evidence"), "utf8")).toBe("preserve me");
});

test("an existing checkpoint seeds once, and later host loss still deduplicates its durable answer", async () => {
  const base = await directory(), central = ledger(2), models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Completed before central-ledger upgrade.")]);
  const input: RuntimeRunInput = { threadId: "thread", runId: "run", prompt: "remember this", model: "faux/faux-1", workspaceRoot: join(base, "work"), sessionDir: join(base, "session") };
  const callbacks = { emit() {}, authorize: async () => {} };
  const original = createPiRuntime({ models, trustedLocal: true }); expect((await original.run(input, callbacks)).status).toBe("done"); await original.close();
  const count = faux.state.callCount, upgraded = createPiRuntime({ models, trustedLocal: true });
  expect((await upgraded.run(input, { ...callbacks, durability: central.client })).summary).toBe("Completed before central-ledger upgrade."); await upgraded.close();
  expect(faux.state.callCount).toBe(count); expect(central.records[0]!.envelope.payload).toMatchObject({ kind: "snapshot" });
  await rm(input.sessionDir, { recursive: true, force: true });
  const recovered = createPiRuntime({ models, trustedLocal: true });
  expect((await recovered.run(input, { ...callbacks, durability: central.client })).summary).toBe("Completed before central-ledger upgrade.");
  expect(faux.state.callCount).toBe(count); await recovered.close();
});

test("a stalled server ACK cancels without a model call, tool effect, or done event", async () => {
  const base = await directory(), central = ledger(), models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage("must not answer")]);
  let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
  central.intercept(async (request) => { if ((request.envelope.payload as { kind: string }).kind === "commits") { entered(); await new Promise<void>(() => {}); } });
  const runtime = createPiRuntime({ models, trustedLocal: true }), events: string[] = [];
  const input: RuntimeRunInput = { threadId: "thread", runId: "run", prompt: "must wait", model: "faux/faux-1", workspaceRoot: join(base, "work"), sessionDir: join(base, "session") };
  const result = runtime.run(input, { emit: (event) => { events.push(event.type); }, authorize: async () => {}, durability: central.client });
  await waiting; expect(faux.state.callCount).toBe(0); await runtime.cancel(input.threadId);
  expect((await result).status).toBe("interrupted"); expect(events).not.toContain("done"); expect(faux.state.callCount).toBe(0);
});

test("unsafe tool execution cannot start before its claimed task reaches the server", async () => {
  const base = await directory(), central = ledger(), models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("write_file", { path: "after-ack.txt", content: "confirmed" }, { id: "write" }), { stopReason: "toolUse" }), fauxAssistantMessage("Confirmed write.")]);
  let enter!: () => void, acknowledge!: () => void, gated = false, authorized = 0, toolEvents = 0;
  const waiting = new Promise<void>((resolve) => { enter = resolve; });
  central.intercept(async (request) => {
    const payload = request.envelope.payload as { kind: string; batches?: Array<{ writes: Array<{ type: string; value?: { kind?: string; state?: { status?: string } } }> }> };
    if (!gated && payload.kind === "commits" && payload.batches?.some((batch) => batch.writes.some((write) => write.type === "task" && write.value?.kind === "pi.tool" && write.value.state?.status === "running"))) {
      gated = true; enter(); await new Promise<void>((resolve) => { acknowledge = resolve; });
    }
  });
  const runtime = createPiRuntime({ models, trustedLocal: true }), input: RuntimeRunInput = { threadId: "thread", runId: "run", prompt: "write once", model: "faux/faux-1", workspaceRoot: join(base, "work"), sessionDir: join(base, "session") };
  const running = runtime.run(input, { durability: central.client, emit: (event) => { if (event.type === "tool_call") toolEvents++; }, authorize: async () => { authorized++; } });
  await waiting; await Bun.sleep(20);
  expect(authorized).toBe(0); expect(toolEvents).toBe(0); expect(existsSync(join(input.workspaceRoot, "after-ack.txt"))).toBe(false);
  acknowledge(); expect((await running).status).toBe("done"); expect(authorized).toBe(1); expect(await readFile(join(input.workspaceRoot, "after-ack.txt"), "utf8")).toBe("confirmed"); await runtime.close();
}, 15_000);

test("deferred streamed progress stays hidden until its storage flush is server-acknowledged", async () => {
  const base = await directory(), central = ledger(), models = createModels(), faux = fauxProvider({ tokensPerSecond: 150, tokenSize: { min: 1, max: 1 } }); models.setProvider(faux.provider);
  const answer = "ACK_stream_progress_is_durable ".repeat(5); faux.setResponses([fauxAssistantMessage(answer)]);
  let enter!: () => void, acknowledge!: () => void, gated = false, text = "";
  const confirmed = new MemoryStorage(), storing = central.client.append;
  let appendFailure: unknown;
  central.client.append = async (request, signal) => {
    try {
      const ack = await storing(request, signal), payload = request.envelope.payload as { kind: string; batches?: Array<{ writes: StorageWrite[] }> };
      if (payload.kind === "commits") { const applied = await confirmed.commit(payload.batches!.map((batch) => batch.writes), () => {}, BACKGROUND_CONTEXT); if (applied.refused) throw applied.refused; }
      return ack;
    } catch (error) { appendFailure = error; throw error; }
  };
  const waiting = new Promise<void>((resolve) => { enter = resolve; });
  central.intercept(async (request) => {
    if (!gated && faux.state.callCount > 0 && JSON.stringify(request.envelope.payload).includes('"message"')) { gated = true; enter(); await new Promise<void>((resolve) => { acknowledge = resolve; }); }
  });
  const runtime = createPiRuntime({ models, trustedLocal: true }), input: RuntimeRunInput = { threadId: "thread", runId: "run", prompt: "stream the test answer", model: "faux/faux-1", workspaceRoot: join(base, "work"), sessionDir: join(base, "session") };
  const running = runtime.run(input, { durability: central.client, emit: async (event) => {
    if (event.type !== "text") return;
    const conversation = (await confirmed.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]!;
    const live = await confirmed.findDocument({ kind: "pi.live", scope: { kind: "conversation", conversationId: conversation.id } }, "current", BACKGROUND_CONTEXT);
    const doc = live && await confirmed.document(live.id, "current", BACKGROUND_CONTEXT);
    const value = doc?.value as { generation?: { message?: { content: Array<{ type: string; text?: string }> } } } | undefined;
    const partial = value?.generation?.message?.content.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
    const entries = await confirmed.scanEntries({ conversationId: conversation.id }, 100, undefined, BACKGROUND_CONTEXT);
    const final = entries.items.find((entry) => entry.kind === "pi.assistant")?.model?.flatMap((message) => message.role === "assistant" ? message.content.filter((block) => block.type === "text").map((block) => block.text) : []).join("") ?? "";
    expect((final || partial).startsWith(text + event.delta)).toBe(true);
    text += event.delta;
  }, authorize: async () => {} });
  await Promise.race([waiting, running.then((result) => { throw new Error(`stream ended before the progress gate: ${JSON.stringify(result)}; ${String(appendFailure)}`); })]); await Bun.sleep(50); expect(text).toBe("");
  acknowledge(); expect((await running).status).toBe("done"); expect(text).toBe(answer); await runtime.close(); await confirmed.close(BACKGROUND_CONTEXT);
}, 15_000);

test("SIGKILL plus complete worker-data loss recovers an unsafe parked tool without replay", async () => {
  const base = await directory(), central = ledger(2), worker = join(base, "lost-worker"), marker = join(base, "parked");
  const input: RuntimeRunInput = { threadId: "thread", runId: "run", prompt: "write once", model: "faux/faux-1", workspaceRoot: join(worker, "work"), sessionDir: join(worker, "session") };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const value = await request.json() as { after?: number; append?: RuntimeDurabilityAppend };
    return Response.json(value.append ? await central.client.append(value.append) : await central.client.load(value.after ?? 0));
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const script = `
    import {createModels} from '@earendil-works/pi-ai/models';
    import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
    import {writeFile} from 'node:fs/promises';import {createPiRuntime} from './src/index.ts';
    const models=createModels(),faux=fauxProvider();models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall('write_file',{path:'never-replay.txt',content:'unsafe'},{id:'once'}),{stopReason:'toolUse'})]);
    const send=async value=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',body:JSON.stringify(value)});if(!r.ok)throw Error('test ledger unavailable');return r.json();};
    await createPiRuntime({models,trustedLocal:true}).run(${JSON.stringify(input)},{emit(){},durability:{load:after=>send({after}),append:append=>send({append})},authorize:async()=>{await writeFile(${JSON.stringify(marker)},'parked');await new Promise(()=>{});}});
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 10_000; while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true); child.kill("SIGKILL"); await child.exited;
    expect(central.records.length).toBeGreaterThan(5);
    await rm(worker, { recursive: true, force: true });
    const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage("Recovered from server history without replay.")]);
    let replayed = false; const runtime = createPiRuntime({ models, trustedLocal: true });
    const result = await runtime.run(input, { emit() {}, durability: central.client, authorize: async () => { replayed = true; } });
    expect(result).toEqual({ status: "done", summary: "Recovered from server history without replay." });
    expect(replayed).toBe(false); expect(existsSync(join(input.workspaceRoot, "never-replay.txt"))).toBe(false); await runtime.close();
  } finally { child.kill("SIGKILL"); await child.exited; await new Response(child.stdout).text(); await new Response(child.stderr).text(); server.stop(true); }
}, 20_000);

test("a fresh request cancels an old unclaimed tool before enabling recovery scheduling", async () => {
  const base = await directory(), central = ledger(2), worker = join(base, "lost-worker");
  const input: RuntimeRunInput = { threadId: "thread", runId: "old-run", prompt: "old abandoned write", model: "faux/faux-1", workspaceRoot: join(worker, "work"), sessionDir: join(worker, "session") };
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  central.intercept(async (request) => {
    const payload = request.envelope.payload as { kind: string; batches?: Array<{ writes: Array<{ type: string; value?: { kind?: string; state?: { status?: string } } }> }> };
    if (payload.kind === "commits" && payload.batches?.some((batch) => batch.writes.some((write) => write.type === "task" && write.value?.kind === "pi.tool" && write.value.state?.status === "running"))) {
      entered(); await new Promise<void>((resolve) => { release = resolve; }); throw new Error("test host was lost before the claim was admitted");
    }
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    try { const value = await request.json() as { after?: number; append?: RuntimeDurabilityAppend }; return Response.json(value.append ? await central.client.append(value.append) : await central.client.load(value.after ?? 0)); }
    catch { return Response.json({ error: "fixture writer lost" }, { status: 503 }); }
  } });
  const script = `
    import {createModels} from '@earendil-works/pi-ai/models';import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
    import {createPiRuntime} from './src/index.ts';const models=createModels(),faux=fauxProvider();models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall('write_file',{path:'abandoned.txt',content:'must never write'},{id:'old-write'}),{stopReason:'toolUse'})]);
    const send=async value=>{const r=await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}`)},{method:'POST',body:JSON.stringify(value)});if(!r.ok)throw Error('test ledger unavailable');return r.json();};
    await createPiRuntime({models,trustedLocal:true}).run(${JSON.stringify(input)},{emit(){},durability:{load:after=>send({after}),append:append=>send({append})},authorize:async()=>{throw Error('unclaimed tool must not execute');}});
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  try {
    await Promise.race([waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("old tool was not prepared")), 10_000))]);
    child.kill("SIGKILL"); await child.exited; release(); central.intercept(undefined);
    expect(existsSync(join(input.workspaceRoot, "abandoned.txt"))).toBe(false);
    await rm(worker, { recursive: true, force: true });
    const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Only the new request was performed.")]);
    let authorized = false; const runtime = createPiRuntime({ models, trustedLocal: true });
    const result = await runtime.run({ ...input, runId: "new-run", prompt: "The old task was abandoned. Answer only this new request without tools." }, { emit() {}, durability: central.client, authorize: async () => { authorized = true; } });
    expect(result).toEqual({ status: "done", summary: "Only the new request was performed." });
    expect(authorized).toBe(false); expect(existsSync(join(input.workspaceRoot, "abandoned.txt"))).toBe(false); expect(faux.state.callCount).toBe(1);
    await runtime.close();
  } finally { child.kill("SIGKILL"); await child.exited; release?.(); await new Response(child.stdout).text(); await new Response(child.stderr).text(); server.stop(true); }
}, 20_000);
