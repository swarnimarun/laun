import type { RuntimeModel } from "./control.js";

/** Adapter-owned JSON, never provider SDK types or executable transport hooks. */
export type InferenceJsonValue = null | boolean | number | string | InferenceJsonValue[] | { [key: string]: InferenceJsonValue };
export interface RuntimeInferenceEnvelope { adapter: string; version: 1; payload: InferenceJsonValue }
export interface RuntimeInferenceRequest { requestId: string; envelope: RuntimeInferenceEnvelope }
/** Bounded NDJSON framing; a terminal adapter frame still requires `done`. */
export type WorkerInferenceStreamItem = {type:"frame";frame:RuntimeInferenceEnvelope}|{type:"done"}|{type:"error";error:string};
export interface RuntimeInferenceUsage { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number }
/** Bound by the worker transport to one authenticated run and generation. */
export interface RuntimeInferenceClient {
  describe(signal?: AbortSignal): Promise<RuntimeInferenceEnvelope>;
  stream(request: RuntimeInferenceRequest, signal?: AbortSignal): AsyncIterable<RuntimeInferenceEnvelope>;
}
/** The controller supplies the exact snapshotted model; the worker cannot choose endpoints or credentials. */
export interface RuntimeInferenceService {
  describe(model: string, signal?: AbortSignal): Promise<RuntimeInferenceEnvelope>;
  stream(model: string, request: RuntimeInferenceRequest, signal?: AbortSignal,
    onUsage?: (usage: RuntimeInferenceUsage) => void | Promise<void>): AsyncIterable<RuntimeInferenceEnvelope>;
  listModels?(): Promise<RuntimeModel[]>;
}
