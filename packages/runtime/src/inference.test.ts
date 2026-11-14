import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { RuntimeInferenceClient, RuntimeInferenceEnvelope, RuntimeInferenceRequest, RuntimeInferenceUsage } from "@laun/protocol";
import { createPiInference, createPiRuntime, inferenceRequestId, INFERENCE_ADAPTER, validateInferenceRequest } from "./index.js";
import { createRemoteInferenceModels } from "./inference.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), "laun-inference-")); dirs.push(root); return root; };
const request = (payload: unknown): RuntimeInferenceRequest => {
  const envelope = { adapter: INFERENCE_ADAPTER, version: 1, payload } as RuntimeInferenceEnvelope;
  return { requestId: inferenceRequestId(envelope), envelope };
};
const base = () => ({ context: { messages: [{ role: "user" as const, content: "Reply briefly", timestamp: 1 }] }, options: {} });
function controller(responses: FauxResponseStep[] = [fauxAssistantMessage("Controller answer")], limit = 1000) {
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses(responses);
  const service = createPiInference({ models, timeoutMs: limit });
  const charged: RuntimeInferenceUsage[] = [];
  const client: RuntimeInferenceClient = { describe: (signal) => service.describe("faux/faux-1", signal), stream: (r, signal) => service.stream("faux/faux-1", r, signal, (usage) => { charged.push(usage); }) };
  return { models, faux, service, client, charged };
}
async function collect(stream: AsyncIterable<RuntimeInferenceEnvelope>) { const values: RuntimeInferenceEnvelope[] = []; for await (const frame of stream) values.push(frame); return values; }

describe("controller-only inference relay", () => {
  test("works without a tool runtime and exposes no provider endpoint, headers or credentials", async () => {
    const f = controller();
    const original = f.faux.getModel();
    f.models.setProvider({ ...f.faux.provider, getModels: () => [{ ...original, baseUrl: "https://private.invalid/central-secret", headers: { authorization: "Bearer central-secret-value" } }] });
    const metadata = await f.service.describe("faux/faux-1");
    expect(JSON.stringify(metadata)).not.toMatch(/baseUrl|headers|central-secret/);
    const frames = await collect(f.client.stream(request(base())));
    expect(frames.some((frame) => (frame.payload as { type?: string }).type === "done")).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("central-secret");
    expect(f.charged).toHaveLength(1); expect(f.charged[0]!.totalTokens).toBeGreaterThan(0);
    expect((await f.service.listModels!())[0]).toMatchObject({ id: "faux/faux-1", configured: true });
  });

  test.each(["baseUrl", "headers", "apiKey", "env", "onPayload", "samplingParams", "model", "maxRetries"])("rejects worker-controlled %s before provider dispatch", async (field) => {
    const f = controller(), body = base();
    const options = { ...body.options, [field]: field === "maxRetries" ? 99 : "untrusted" };
    await expect(collect(f.client.stream(request({ ...body, options })))).rejects.toThrow("inference");
    expect(f.faux.state.callCount).toBe(0);
    await expect(collect(f.client.stream(request({ ...body, [field]: "untrusted" })))).rejects.toThrow("inference");
    expect(f.faux.state.callCount).toBe(0);
  });

  test("request IDs bind canonical context/options and cannot be reused after tampering", () => {
    const a = request(base()), b = request({ options: {}, context: { messages: [{ timestamp: 1, content: "Reply briefly", role: "user" }] } });
    expect(a.requestId).toBe(b.requestId);
    expect(validateInferenceRequest(a).requestId).toBe(a.requestId);
    const changed = structuredClone(a); (changed.envelope.payload as { options: object }).options = { maxTokens: 99 };
    expect(() => validateInferenceRequest(changed)).toThrow("identity");
    expect(() => request({ ...base(), invalid: "x".repeat(2 * 1024 * 1024) })).toThrow("byte limit");
    expect(() => inferenceRequestId({ adapter: "other", version: 1, payload: {} })).toThrow("version");
  });

  test("actual Durable worker uses only the controller provider and still mediates allow/deny tools", async () => {
    const root = await fixture();
    const f = controller([
      fauxAssistantMessage(fauxToolCall("write_file", { path: "approved.txt", content: "approved remotely" }, { id: "allow" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write_file", { path: "denied.txt", content: "must not write" }, { id: "deny" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The approved write completed; the denied write was skipped."),
    ], 10_000);
    const local = createModels(), poison = fauxProvider(); local.setProvider(poison.provider); poison.setResponses([fauxAssistantMessage("LOCAL PROVIDER MUST NOT RUN")]);
    const runtime = createPiRuntime({ trustedLocal: true, models: local, authFile: join(root, "work", "must-never-read-auth.json") });
    const permissions: string[] = [], events: string[] = [];
    const result = await runtime.run({ threadId: "remote", runId: "run", prompt: "Make the approved change, skip denied changes.", model: "faux/faux-1", workspaceRoot: join(root, "work"), sessionDir: join(root, "session") }, {
      inference: f.client, emit(event) { events.push(event.type); }, authorize: async (action) => { permissions.push(action.operation); if ((action.arguments as { path?: string }).path === "denied.txt") throw new Error("denied by controller approval"); },
    });
    expect(result).toEqual({ status: "done", summary: "The approved write completed; the denied write was skipped." });
    expect(await readFile(join(root, "work", "approved.txt"), "utf8")).toBe("approved remotely");
    await expect(readFile(join(root, "work", "denied.txt"))).rejects.toThrow();
    expect(permissions).toEqual(["workspace.write", "workspace.write"]); expect(events).toContain("done");
    expect(poison.state.callCount).toBe(0); expect(f.faux.state.callCount).toBe(3); expect(f.charged).toHaveLength(3);
  }, 15_000);

  test("provider knobs are controller-capped and API retries/continuation are disabled", async () => {
    let selected: Record<string, unknown> | undefined;
    const f = controller([(_context, options) => { selected = options as unknown as Record<string, unknown>; return fauxAssistantMessage("Bounded"); }]);
    await collect(f.client.stream(request({ ...base(), options: { temperature: 0.2, maxTokens: 65_536, reasoning: "low" } })));
    expect(selected).toMatchObject({ maxRetries: 0, maxTokens: 8192, disableContinuation: true, transport: "sse", temperature: 0.2 });
  });

  test("controller deadline aborts even a provider that never resolves its next event", async () => {
    let providerSignal: AbortSignal | undefined;
    const f = controller([async (_context, options) => { providerSignal = options?.signal; return new Promise(() => {}); }], 25);
    await expect(collect(f.client.stream(request(base())))).rejects.toThrow("deadline");
    expect(providerSignal?.aborted).toBe(true); expect(f.faux.state.callCount).toBe(1); expect(f.charged).toHaveLength(0);
  });

  test("provider error frames redact raw diagnostics and run remains interrupted without retry or local fallback", async () => {
    const root = await fixture(), secret = "CENTRAL_ONLY_TEST_SECRET";
    const f = controller([fauxAssistantMessage("", { stopReason: "error", errorMessage: secret })], 5000);
    const frames = await collect(f.client.stream(request(base()))); expect(JSON.stringify(frames)).not.toContain(secret);
    const failed = controller([fauxAssistantMessage("", { stopReason: "error", errorMessage: secret })], 5000);
    const runtime = createPiRuntime({ trustedLocal: true, enableFaux: true });
    const events: string[] = [];
    const result = await runtime.run({ threadId: "remote", runId: "run", prompt: "Reply", model: "faux/faux-1", workspaceRoot: join(root, "work"), sessionDir: join(root, "session") }, { inference: failed.client, emit(event) { events.push(event.type); }, authorize: async () => {} });
    expect(result.status).toBe("interrupted"); expect(events).not.toContain("done"); expect(failed.faux.state.callCount).toBe(1);
  }, 10_000);

  test("bounded output aborts the provider rather than buffering an unlimited response", async () => {
    const f = controller(); let providerSignal: AbortSignal | undefined;
    f.models.setProvider({ ...f.faux.provider, streamSimple(_model, _context, options) {
      providerSignal = options?.signal; const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { const message = fauxAssistantMessage(""); stream.push({ type: "start", partial: message }); for (let index = 0; index < 1000; index++) stream.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(20_000), partial: message }); });
      return stream;
    } });
    await expect(collect(f.client.stream(request(base())))).rejects.toThrow("output limit"); expect(providerSignal?.aborted).toBe(true);
  });

  test("a terminal model payload cannot commit until the transport confirms clean EOF", async () => {
    const f = controller(); let release!: () => void, reached!: () => void;
    const eof = new Promise<void>((resolve) => { release = resolve; }), waiting = new Promise<void>((resolve) => { reached = resolve; });
    const client: RuntimeInferenceClient = { describe: f.client.describe, async *stream(r, signal) { for await (const frame of f.client.stream(r, signal)) yield frame; reached(); await eof; } };
    const proxy = await createRemoteInferenceModels("faux/faux-1", client, new AbortController().signal);
    const stream = proxy.models.streamSimple(proxy.models.getModel("faux", "faux-1")!, base().context);
    let settled = false; const result = stream.result().then((value) => { settled = true; return value; });
    await waiting; await Bun.sleep(10); expect(settled).toBe(false);
    release(); expect((await result).stopReason).toBe("stop"); expect(proxy.uncertain()).toBe(false);
  });

  test.each(["disconnect", "extra-frame"])("%s after a terminal payload remains interrupted and never becomes a successful answer", async (kind) => {
    const f = controller();
    const client: RuntimeInferenceClient = { describe: f.client.describe, async *stream(r, signal) { for await (const frame of f.client.stream(r, signal)) yield frame; if (kind === "disconnect") throw new Error("socket lost before transport confirmation"); yield { adapter: INFERENCE_ADAPTER, version: 1, payload: { type: "unexpected" } }; } };
    const proxy = await createRemoteInferenceModels("faux/faux-1", client, new AbortController().signal);
    const stream = proxy.models.streamSimple(proxy.models.getModel("faux", "faux-1")!, base().context);
    expect((await stream.result()).stopReason).toBe("error"); expect(proxy.uncertain()).toBe(true); expect(f.faux.state.callCount).toBe(1);
  });
});
