import { createHash } from "node:crypto";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai/utils/streaming-json";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import type { InferenceJsonValue, RuntimeInferenceClient, RuntimeInferenceEnvelope, RuntimeInferenceRequest, RuntimeInferenceService, RuntimeInferenceUsage, RuntimeModel } from "@laun/protocol";
import { FileCredentialStore } from "./credentials.js";

export const INFERENCE_ADAPTER = "pi-ai@1.5.2";
export const MAX_INFERENCE_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_INFERENCE_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_INFERENCE_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_FRAMES = 65_536;
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InferenceProtocolError("invalid inference object");
  return value as Obj;
};
function keys(value: Obj, allowed: string[], required: string[] = []): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new InferenceProtocolError("unknown or missing inference fields");
}
export class InferenceProtocolError extends Error { readonly status = 400; }

/** Bounded canonical JSON; no toJSON hooks, prototypes, functions or cycles. */
function canonical(value: unknown, limit = MAX_INFERENCE_REQUEST_BYTES): string {
  let bytes = 0, nodes = 0; const seen = new Set<object>();
  const add = (value: string) => { bytes += Buffer.byteLength(value); if (bytes > limit) throw new InferenceProtocolError("inference JSON exceeds byte limit"); return value; };
  const visit = (value: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 48) throw new InferenceProtocolError("inference JSON exceeds structure limit");
    if (value === null || typeof value === "boolean") return add(String(value));
    if (typeof value === "string") return add(JSON.stringify(value));
    if (typeof value === "number" && Number.isFinite(value)) return add(JSON.stringify(value));
    if (typeof value !== "object" || !value || seen.has(value)) throw new InferenceProtocolError("inference payload must be plain finite JSON");
    seen.add(value);
    try {
      if (Array.isArray(value)) return add("[") + value.map((item, index) => (index ? add(",") : "") + visit(item, depth + 1)).join("") + add("]");
      const record = obj(value);
      return add("{") + Object.keys(record).sort().map((key, index) => (index ? add(",") : "") + add(JSON.stringify(key)) + add(":") + visit(record[key], depth + 1)).join("") + add("}");
    } finally { seen.delete(value); }
  };
  return visit(value, 0);
}
function envelope(payload: unknown): RuntimeInferenceEnvelope {
  return { adapter: INFERENCE_ADAPTER, version: 1, payload: JSON.parse(canonical(payload, MAX_INFERENCE_FRAME_BYTES)) as InferenceJsonValue };
}
function decode(value: unknown, limit = MAX_INFERENCE_REQUEST_BYTES): Obj {
  const record = obj(value); keys(record, ["adapter", "version", "payload"], ["adapter", "version", "payload"]);
  if (record.adapter !== INFERENCE_ADAPTER || record.version !== 1) throw new InferenceProtocolError("unsupported inference adapter version");
  canonical(record, limit); return obj(record.payload);
}
export function inferenceRequestId(value: RuntimeInferenceEnvelope): string { decode(value); return createHash("sha256").update(canonical(value)).digest("hex"); }
function string(value: unknown, max = 256_000): asserts value is string { if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new InferenceProtocolError("invalid inference text"); }
function timestamp(value: unknown): void { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new InferenceProtocolError("invalid inference timestamp"); }
function content(value: unknown, kinds: string[]): void {
  if (!Array.isArray(value) || value.length > 256) throw new InferenceProtocolError("invalid inference content");
  for (const item of value) {
    const block = obj(item); if (!kinds.includes(String(block.type))) throw new InferenceProtocolError("unsupported inference content type");
    if (block.type === "text") { keys(block, ["type", "text", "textSignature"], ["type", "text"]); string(block.text); if (block.textSignature !== undefined) string(block.textSignature); }
    if (block.type === "thinking") { keys(block, ["type", "thinking", "thinkingSignature", "redacted"], ["type", "thinking"]); string(block.thinking); if (block.thinkingSignature !== undefined) string(block.thinkingSignature); if (block.redacted !== undefined && typeof block.redacted !== "boolean") throw new InferenceProtocolError("invalid redacted thinking flag"); }
    if (block.type === "image") {
      keys(block, ["type", "data", "mimeType"], ["type", "data", "mimeType"]); string(block.data, MAX_INFERENCE_REQUEST_BYTES);
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(block.mimeType)) || Buffer.from(block.data as string, "base64").toString("base64") !== block.data) throw new InferenceProtocolError("inference image must be bounded inline base64");
    }
    if (block.type === "toolCall") { keys(block, ["type", "id", "name", "arguments", "thoughtSignature", "namespace", "argumentsError"], ["type", "id", "name", "arguments"]); string(block.id, 256); string(block.name, 256); obj(block.arguments); for (const key of ["thoughtSignature", "namespace", "argumentsError"]) if (block[key] !== undefined) string(block[key]); }
  }
}
function tools(value: unknown): void {
  if (!Array.isArray(value) || value.length > 128) throw new InferenceProtocolError("invalid inference tool declarations");
  for (const item of value) { const tool = obj(item); keys(tool, ["name", "description", "parameters", "constrainedSampling"], ["name", "description", "parameters"]); string(tool.name, 256); string(tool.description, 16_384); obj(tool.parameters); if (tool.constrainedSampling !== undefined && tool.constrainedSampling !== false) throw new InferenceProtocolError("relay does not accept executable or grammar sampling extensions"); }
}
function validateContext(value: unknown): Context {
  const context = obj(value); keys(context, ["systemPrompt", "messages", "tools"], ["messages"]);
  if (context.systemPrompt !== undefined) string(context.systemPrompt);
  if (context.tools !== undefined) tools(context.tools);
  if (!Array.isArray(context.messages) || context.messages.length > 512) throw new InferenceProtocolError("invalid inference transcript");
  for (const item of context.messages) {
    const message = obj(item); timestamp(message.timestamp);
    if (message.role === "system") {
      keys(message, ["role", "content", "sections", "toolsAdded", "toolsRemoved", "timestamp"], ["role", "content", "timestamp"]);
      if (typeof message.content === "string") string(message.content); else content(message.content, ["text"]);
      if (message.sections !== undefined) { const sections = obj(message.sections); if (Object.keys(sections).length > 128) throw new InferenceProtocolError("too many prompt sections"); for (const [key, value] of Object.entries(sections)) { string(key, 256); if (value !== null) string(value); } }
      if (message.toolsAdded !== undefined) tools(message.toolsAdded);
      if (message.toolsRemoved !== undefined) { if (!Array.isArray(message.toolsRemoved) || message.toolsRemoved.length > 128) throw new InferenceProtocolError("invalid removed tools"); for (const item of message.toolsRemoved) { const tool = obj(item); keys(tool, ["name"], ["name"]); string(tool.name, 256); } }
    } else if (message.role === "user") {
      keys(message, ["role", "content", "timestamp"], ["role", "content", "timestamp"]);
      if (typeof message.content === "string") string(message.content); else content(message.content, ["text", "image"]);
    } else if (message.role === "assistant") {
      keys(message, ["role", "content", "api", "provider", "model", "responseModel", "responseId", "providerThinkingLevel", "thinkingLevel", "diagnostics", "usage", "stopReason", "errorMessage", "rawStopReason", "endTurn", "timestamp", "durationMs"], ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"]);
      content(message.content, ["text", "thinking", "toolCall"]);
      for (const key of ["api", "provider", "model"]) string(message[key], 256);
      // Provider continuation IDs and diagnostics are not authority a worker
      // may borrow from another conversation or replay against shared auth.
      delete message.responseId; delete message.diagnostics;
    } else if (message.role === "toolResult") {
      keys(message, ["role", "toolCallId", "toolName", "content", "details", "usage", "nestedCalls", "isError", "timestamp", "durationMs"], ["role", "toolCallId", "toolName", "content", "isError", "timestamp"]);
      string(message.toolCallId, 256); string(message.toolName, 256); content(message.content, ["text", "image"]); if (typeof message.isError !== "boolean") throw new InferenceProtocolError("invalid tool result status");
    } else throw new InferenceProtocolError("unsupported inference message role");
  }
  return context as unknown as Context;
}
function validateOptions(value: unknown): Pick<SimpleStreamOptions, "temperature" | "maxTokens" | "reasoning"> {
  const options = obj(value); keys(options, ["temperature", "maxTokens", "reasoning"]);
  if (options.temperature !== undefined && (typeof options.temperature !== "number" || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new InferenceProtocolError("invalid inference temperature");
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || Number(options.maxTokens) < 1 || Number(options.maxTokens) > 65_536)) throw new InferenceProtocolError("invalid inference maxTokens");
  if (options.reasoning !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(options.reasoning))) throw new InferenceProtocolError("invalid inference reasoning level");
  return options as Pick<SimpleStreamOptions, "temperature" | "maxTokens" | "reasoning">;
}
/** May be called before durable admission; malformed requests never call a provider. */
export function validateInferenceRequest(value: unknown): RuntimeInferenceRequest {
  const request = obj(value); keys(request, ["requestId", "envelope"], ["requestId", "envelope"]);
  canonical(request);
  if (typeof request.requestId !== "string" || !/^[0-9a-f]{64}$/.test(request.requestId) || inferenceRequestId(request.envelope as RuntimeInferenceEnvelope) !== request.requestId) throw new InferenceProtocolError("inference request identity does not match its envelope");
  const payload = decode(request.envelope); keys(payload, ["context", "options"], ["context", "options"]);
  validateContext(JSON.parse(canonical(payload.context))); validateOptions(payload.options);
  return request as unknown as RuntimeInferenceRequest;
}

export interface PiInferenceOptions { authFile?: string; models?: unknown; enableFaux?: boolean; timeoutMs?: number; maxOutputTokens?: number }
function catalog(options: PiInferenceOptions): Models {
  const models = options.models as Models | undefined ?? builtinModels({ credentials: options.authFile ? new FileCredentialStore(options.authFile) : undefined });
  if (options.enableFaux && !options.models) { const faux = fauxProvider(); const response: FauxResponseFactory = async () => { faux.appendResponses([response]); return fauxAssistantMessage("Explicit controller inference demonstration."); }; faux.setResponses([response]); (models as ReturnType<typeof builtinModels>).setProvider(faux.provider); }
  return models;
}
function usage(message: AssistantMessage): RuntimeInferenceUsage {
  const value = { inputTokens: message.usage.input, outputTokens: message.usage.output, totalTokens: message.usage.totalTokens, costUsd: message.usage.cost.total };
  if (Object.values(value).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new Error("provider returned invalid authoritative usage"); return value;
}
function safeMessage(message: AssistantMessage, model: Model<string>, error = false): AssistantMessage {
  if (error) { const result = errorMessage(model, message.stopReason === "aborted"); result.usage = JSON.parse(JSON.stringify(message.usage)); usage(result); return result; }
  const { diagnostics: _, errorMessage: __, deferred: ___, ...safe } = message;
  const result = JSON.parse(canonical(JSON.parse(JSON.stringify({ ...safe, api: model.api, provider: model.provider, model: model.id })), MAX_INFERENCE_FRAME_BYTES)) as AssistantMessage;
  content(result.content, ["text", "thinking", "toolCall"]); usage(result); return result;
}
function errorMessage(model: Model<string>, aborted: boolean): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: aborted ? "Controller inference cancelled" : "Controller inference failed; inspect controller configuration", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function nextWithSignal<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("inference cancelled or deadline exceeded")); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(iterator.next()).then((value) => { signal.removeEventListener("abort", aborted); resolve(value); }, (error) => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

/** Controller-only model registry and credentials; no execution backend is needed. */
export function createPiInference(options: PiInferenceOptions = {}): RuntimeInferenceService {
  const models = catalog(options), timeoutMs = options.timeoutMs ?? 60_000, maxTokens = options.maxOutputTokens ?? 8192;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 65_536) throw new Error("invalid controller inference limits");
  const select = async (name: string, signal?: AbortSignal) => {
    signal?.throwIfAborted(); const split = name.indexOf("/"); if (split < 1 || split === name.length - 1 || name.length > 512) throw new InferenceProtocolError("invalid snapshotted inference model");
    const provider = name.slice(0, split), id = name.slice(split + 1);
    if (!models.getModel(provider, id)) await models.refresh({ providers: [provider], allowNetwork: true, signal });
    const model = models.getModel(provider, id); if (!model || !await models.checkAuth(provider, { signal })) throw new Error("controller model is unavailable or unconfigured");
    signal?.throwIfAborted(); return model;
  };
  return {
    async describe(name, signal) {
      const model = await select(name, signal);
      return envelope(JSON.parse(JSON.stringify({ kind: "model", model: { id: model.id, provider: model.provider, api: model.api, name: model.name, input: model.input, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: Math.min(maxTokens, model.maxTokens), cost: model.cost } })));
    },
    async *stream(name, input, signal, onUsage) {
      const request = validateInferenceRequest(input), payload = decode(request.envelope);
      const context = validateContext(JSON.parse(canonical(payload.context))), selected = validateOptions(payload.options);
      const controller = new AbortController(), aborted = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", aborted, { once: true }); if (signal?.aborted) aborted();
      const timer = setTimeout(() => controller.abort(new Error("controller inference deadline")), timeoutMs); timer.unref();
      let model: Model<string> | undefined, terminal = false, total = 0, count = 0;
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
      try {
        model = await select(name, controller.signal);
        const stream = models.streamSimple(model, context, { ...selected, maxTokens: Math.min(selected.maxTokens ?? maxTokens, maxTokens, model.maxTokens), maxRetries: 0, timeoutMs, signal: controller.signal, disableContinuation: true, transport: "sse" });
        iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = await nextWithSignal(iterator, controller.signal); if (next.done) break; const event = next.value;
          controller.signal.throwIfAborted(); let frame: RuntimeInferenceEnvelope;
          if (event.type === "done" || event.type === "error") {
            const message = safeMessage(event.type === "done" ? event.message : event.error, model, event.type === "error");
            if (event.type === "done" && event.reason === "deferred") throw new Error("deferred inference is not supported by this relay");
            await onUsage?.(usage(message)); terminal = true;
            frame = envelope(event.type === "done" ? { type: "done", reason: event.reason, message } : { type: "error", reason: event.reason, error: message });
          } else if (event.type === "start") {
            const message = safeMessage(event.partial, model); message.content = []; frame = envelope({ type: "start", partial: message });
          } else {
            const { partial, ...delta } = event;
            const block = (event.type.endsWith("_start") || event.type.endsWith("_end")) ? partial.content[event.contentIndex] : undefined;
            frame = envelope({ ...delta, ...(block ? { block } : {}) });
          }
          const size = Buffer.byteLength(JSON.stringify(frame)); total += size;
          if (++count > MAX_FRAMES || size > MAX_INFERENCE_FRAME_BYTES || total > MAX_INFERENCE_STREAM_BYTES) throw new Error("controller inference output limit exceeded");
          yield frame;
          if (terminal) return;
        }
        if (!terminal) throw new Error("controller inference ended without a terminal response");
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", aborted); controller.abort(); void iterator?.return?.().catch(() => {}); }
    },
    async listModels(): Promise<RuntimeModel[]> {
      const configured = new Set<string>(); for (const provider of models.getProviders()) { try { if (await models.checkAuth(provider.id)) configured.add(provider.id); } catch {} }
      return models.getModels().map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, provider: m.provider, configured: configured.has(m.provider) })).sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
    },
  };
}
export const createPiInferenceController = createPiInference;

/** Worker-side proxy contains no provider implementation or credential lookup. */
export async function createRemoteInferenceModels(name: string, client: RuntimeInferenceClient, signal: AbortSignal): Promise<{ models: Models; uncertain(): boolean }> {
  let uncertain = false;
  const descriptor = decode(await client.describe(signal)); keys(descriptor, ["kind", "model"], ["kind", "model"]);
  if (descriptor.kind !== "model") throw new InferenceProtocolError("invalid controller model descriptor");
  const data = obj(descriptor.model); keys(data, ["id", "provider", "api", "name", "input", "reasoning", "contextWindow", "maxTokens", "cost"], ["id", "provider", "api", "name", "input", "reasoning", "contextWindow", "maxTokens", "cost"]);
  if (`${data.provider}/${data.id}` !== name || !["id", "provider", "api", "name"].every((key) => typeof data[key] === "string") || !Array.isArray(data.input) || data.input.some((v) => !["text", "image"].includes(String(v))) || typeof data.reasoning !== "boolean" || !Number.isSafeInteger(data.contextWindow) || Number(data.contextWindow) < 1 || !Number.isSafeInteger(data.maxTokens) || Number(data.maxTokens) < 1 || Number(data.maxTokens) > 65_536) throw new InferenceProtocolError("controller returned a different or invalid model");
  const model = { ...data, baseUrl: "https://controller.invalid" } as unknown as Model<string>;
  const streamSimple = (_model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const controller = new AbortController(), cancel = () => controller.abort(options?.signal?.reason ?? signal.reason);
      signal.addEventListener("abort", cancel, { once: true }); options?.signal?.addEventListener("abort", cancel, { once: true }); if (signal.aborted || options?.signal?.aborted) cancel();
      let partial: AssistantMessage | undefined, terminal = false, total = 0, count = 0;
      let terminalEvent: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
      let iterator: AsyncIterator<RuntimeInferenceEnvelope> | undefined;
      const arguments_ = new Map<number, ToolCallArgumentsStream>();
      try {
        const chosen = Object.fromEntries(["temperature", "maxTokens", "reasoning"].flatMap((key) => options?.[key as keyof SimpleStreamOptions] === undefined ? [] : [[key, options[key as keyof SimpleStreamOptions]]]));
        const body = envelope(JSON.parse(JSON.stringify({ context, options: chosen }))), request = { requestId: inferenceRequestId(body), envelope: body };
        validateInferenceRequest(request);
        iterator = client.stream(request, controller.signal)[Symbol.asyncIterator]();
        for (;;) {
          const next = await nextWithSignal(iterator, controller.signal); if (next.done) break; const value = next.value;
          controller.signal.throwIfAborted(); total += Buffer.byteLength(canonical(value, MAX_INFERENCE_FRAME_BYTES)); if (++count > MAX_FRAMES || total > MAX_INFERENCE_STREAM_BYTES) throw new Error("inference relay output limit exceeded");
          const event = decode(value, MAX_INFERENCE_FRAME_BYTES), type = event.type;
          if (terminal) throw new Error("inference frame after terminal response");
          if (type === "start") { if (partial) throw new Error("duplicate inference start"); partial = safeMessage(event.partial as AssistantMessage, model); partial.content = []; stream.push({ type: "start", partial }); continue; }
          if (type === "done" || type === "error") {
            if (type === "error") uncertain = true;
            const final = safeMessage((type === "done" ? event.message : event.error) as AssistantMessage, model, type === "error");
            if (type === "done" && !partial) throw new Error("inference done before start");
            terminalEvent = type === "done" ? { type: "done", reason: event.reason as "stop", message: final } : { type: "error", reason: event.reason as "error", error: final };
            terminal = true; continue;
          }
          if (!partial || !Number.isSafeInteger(event.contentIndex) || Number(event.contentIndex) < 0 || Number(event.contentIndex) >= 256) throw new Error("invalid inference event order/index");
          const index = Number(event.contentIndex);
          if (type === "text_start") { const block = event.block as { textSignature?: string } | undefined; partial.content[index] = { type: "text", text: "", ...(block?.textSignature ? { textSignature: block.textSignature } : {}) }; }
          else if (type === "thinking_start") { const block = event.block as { thinkingSignature?: string; redacted?: boolean; thinking?: string } | undefined; partial.content[index] = { type: "thinking", thinking: block?.redacted ? block.thinking ?? "" : "", ...(block?.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}), ...(block?.redacted ? { redacted: true } : {}) }; }
          else if (type === "toolcall_start") { const block = obj(event.block); partial.content[index] = { type: "toolCall", id: String(block.id), name: String(block.name), arguments: {} }; arguments_.set(index, new ToolCallArgumentsStream()); }
          else if (type === "text_delta") { const block = partial.content[index]; if (block?.type !== "text") throw new Error("text delta without start"); string(event.delta); block.text += event.delta; }
          else if (type === "thinking_delta") { const block = partial.content[index]; if (block?.type !== "thinking") throw new Error("thinking delta without start"); string(event.delta); block.thinking += event.delta; }
          else if (type === "toolcall_delta") { const block = partial.content[index]; if (block?.type !== "toolCall") throw new Error("tool delta without start"); string(event.delta); block.arguments = arguments_.get(index)!.append(event.delta); }
          else if (["text_end", "thinking_end", "toolcall_end"].includes(String(type))) { if (event.block) partial.content[index] = event.block as AssistantMessage["content"][number]; if (type === "toolcall_end") partial.content[index] = event.toolCall as unknown as ToolCall; }
          else throw new Error("unknown inference stream frame");
          const { block: _, ...forward } = event; stream.push({ ...forward, partial } as AssistantMessageEvent);
        }
        if (!terminal) throw new Error("inference relay disconnected before terminal response; reconcile admission before retry");
        // The transport's clean EOF follows durable controller settlement.
        // A terminal payload alone must not commit a Durable answer/tool call.
        stream.push(terminalEvent!); stream.end(terminalEvent!.type === "done" ? terminalEvent!.message : terminalEvent!.error);
      } catch { uncertain = true; const failure = errorMessage(model, controller.signal.aborted); stream.push({ type: "error", reason: controller.signal.aborted ? "aborted" : "error", error: failure }); stream.end(failure); }
      finally { signal.removeEventListener("abort", cancel); options?.signal?.removeEventListener("abort", cancel); controller.abort(); void iterator?.return?.().catch(() => {}); }
    });
    return stream;
  };
  const models = createModels(); models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: "Controller relay", resolve: async () => ({ auth: {} }) } }, api: { stream: streamSimple, streamSimple } }));
  return { models, uncertain: () => uncertain };
}
