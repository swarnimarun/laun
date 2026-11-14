import type { InferenceJsonValue } from "./inference.js";

/** Runtime-owned data only. Controllers never execute or interpret SDK records. */
export interface RuntimeDurabilityEnvelope { adapter: string; version: 1; payload: InferenceJsonValue }
export interface RuntimeDurabilityRecord { sequence: number; requestId: string; envelope: RuntimeDurabilityEnvelope }
export interface RuntimeDurabilityPage {
  records: RuntimeDurabilityRecord[];
  /** Stable head captured when this page was read. A replay rejects a changed head. */
  headSequence: number;
  nextSequence: number;
  hasMore: boolean;
}
export interface RuntimeDurabilityAppend {
  expectedSequence: number;
  requestId: string;
  envelope: RuntimeDurabilityEnvelope;
}
/** Authenticated transport is fenced to one thread, run and generation. No automatic retries. */
export interface RuntimeDurabilityClient {
  load(afterSequence: number, signal?: AbortSignal): Promise<RuntimeDurabilityPage>;
  append(request: RuntimeDurabilityAppend, signal?: AbortSignal): Promise<{ sequence: number }>;
}
