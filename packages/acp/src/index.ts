// Goose ACP adapter scaffold (lane fills this in — see the research brief at
// .pi-subagents/handoffs/research-goose-acp.md and the lane spec).
// Target: talk to `goose serve` (/acp, X-Secret-Key) and translate ACP
// JSON-RPC into protocol AgentEvents behind the executor's runtime seam.

import type { AgentEvent } from "@laun/protocol";

export interface GooseConfig {
  /** e.g. http://127.0.0.1:3284 */
  baseUrl: string;
  /** Sent as X-Secret-Key (never logged, never printed). */
  secret: string;
  /** Absolute cwd new ACP sessions start in. */
  workdir: string;
}

export interface GooseRunOptions {
  sessionId: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface GooseRunResult {
  sawError: boolean;
  sawDone: boolean;
  aborted: boolean;
  timedOut: boolean;
}

/** Run one prompt against goose and stream AgentEvents. Lane implements. */
export async function runGoose(_opts: GooseRunOptions & { config: GooseConfig }): Promise<GooseRunResult> {
  throw new Error("goose ACP adapter not implemented (lane-owned)");
}
