// Pure ACP frame -> AgentEvent mapping. Every entry point is total:
// unknown or malformed frames return null (skip), never throw. Verified
// against goose 1.53.0 `serve` plus the ACP schema (protocolVersion 1):
// session/update kinds seen live include agent_message_chunk,
// agent_thought_chunk, tool_call, tool_call_update, usage_update (goose
// shape {used,size,cost}), session_info_update, available_commands_update.

import type { AgentEvent } from "@laun/protocol";

/** Text is released in >=300-char chunks (executor ThinkingCoalescer parity). */
export const TEXT_FLUSH_CHARS = 300;

/** Cap on forwarded tool output (executor MAX_TOOL_OUTPUT parity). */
export const TOOL_OUTPUT_MAX = 4000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Per-run accumulator that coalesces agent message text into bounded
 * events. A 10_000-char stream yields ceil(10000/300) = 34 events, never
 * thousands, so a later lane can forward them without flooding.
 */
export class TextCoalescer {
  private buf = "";
  constructor(private sessionId: string) {}
  /** Feed raw text; returns the coalesced events now due (often none). */
  push(text: string): AgentEvent[] {
    if (!text) return [];
    this.buf += text;
    const out: AgentEvent[] = [];
    while (this.buf.length >= TEXT_FLUSH_CHARS) {
      out.push({ type: "text", sessionId: this.sessionId, delta: this.buf.slice(0, TEXT_FLUSH_CHARS) });
      this.buf = this.buf.slice(TEXT_FLUSH_CHARS);
    }
    return out;
  }
  /** Release the buffered remainder (null when empty). Idempotent. */
  flush(): AgentEvent | null {
    if (!this.buf) return null;
    const delta = this.buf;
    this.buf = "";
    return { type: "text", sessionId: this.sessionId, delta };
  }
  /** Chars still buffered (for tests). */
  get pending(): number {
    return this.buf.length;
  }
}

/**
 * Per-run accumulator for agent reasoning (agent_thought_chunk), mirroring
 * the executor's ThinkingCoalescer: >=300-char chunks, flush the remainder
 * before completion/abort/timeout.
 */
export class ThinkingCoalescer {
  private buf = "";
  constructor(private sessionId: string) {}
  /** Feed raw reasoning text; returns the coalesced events now due. */
  push(text: string): AgentEvent[] {
    if (!text) return [];
    this.buf += text;
    const out: AgentEvent[] = [];
    while (this.buf.length >= TEXT_FLUSH_CHARS) {
      out.push({ type: "thinking", sessionId: this.sessionId, delta: this.buf.slice(0, TEXT_FLUSH_CHARS) });
      this.buf = this.buf.slice(TEXT_FLUSH_CHARS);
    }
    return out;
  }
  /** Release the buffered remainder (null when empty). Idempotent. */
  flush(): AgentEvent | null {
    if (!this.buf) return null;
    const delta = this.buf;
    this.buf = "";
    return { type: "thinking", sessionId: this.sessionId, delta };
  }
  /** Chars still buffered (for tests). */
  get pending(): number {
    return this.buf.length;
  }
}

/** A streamed text chunk and which stream it belongs to. */
export interface StreamChunk {
  kind: "text" | "thinking";
  text: string;
}

/**
 * Pull streamed text out of a `session/update` notification's `update`
 * payload. Recognizes `agent_message_chunk` (text) and
 * `agent_thought_chunk` (thinking); anything else returns null.
 * Content extraction is tolerant: a single `{type:"text",text}` block, an
 * array of blocks, or a bare string field. Never throws.
 */
export function extractStreamChunk(update: unknown): StreamChunk | null {
  try {
    const rec = asRecord(update);
    if (!rec) return null;
    const kind = optStr(rec["sessionUpdate"]);
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return null;
    const text = extractContentText(rec["content"]) ?? optStr(rec["text"]);
    if (!text) return null;
    return { kind: kind === "agent_message_chunk" ? "text" : "thinking", text };
  } catch {
    return null;
  }
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  const block = asRecord(content);
  if (block) {
    // Canonical: {type:"text",text}. Tolerant: any string payload field.
    const t = optStr(block["text"]) ?? optStr(block["content"]) ?? optStr(block["message"]);
    return t || undefined;
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => b !== null)
      .map((b) => optStr(b["text"]))
      .filter((s): s is string => s !== undefined && s.length > 0);
    return texts.length > 0 ? texts.join("") : undefined;
  }
  return undefined;
}

/**
 * Map a non-chunk `session/update` payload to an AgentEvent:
 * `tool_call` -> tool_call, terminal `tool_call_update` -> tool_result,
 * goose `usage_update` ({used,size,cost}) -> usage. Everything else
 * (session_info_update, available_commands_update, plan, progress-only
 * tool updates, unknown kinds) returns null. Never throws.
 */
export function mapSessionUpdate(update: unknown, sessionId: string): AgentEvent | null {
  try {
    const rec = asRecord(update);
    if (!rec) return null;
    const kind = optStr(rec["sessionUpdate"]);
    if (kind === "tool_call") {
      return {
        type: "tool_call",
        sessionId,
        name: optStr(rec["name"]) ?? optStr(rec["title"]) ?? "unknown",
        args: rec["arguments"] ?? rec["args"] ?? rec["input"],
      };
    }
    if (kind === "tool_call_update") {
      const status = optStr(rec["status"]);
      const terminal = status === "completed" || status === "failed";
      if (!terminal && rec["content"] === undefined && rec["rawOutput"] === undefined) return null;
      const output = extractToolOutput(rec["content"]) ?? optStr(rec["rawOutput"]);
      return {
        type: "tool_result",
        sessionId,
        name: optStr(rec["name"]) ?? optStr(rec["title"]) ?? optStr(rec["toolCallId"]) ?? "unknown",
        ok: status !== "failed",
        output: output === undefined ? undefined : truncate(output, TOOL_OUTPUT_MAX),
      };
    }
    if (kind === "usage_update") {
      // Goose shape: {used,size,cost:{amount,currency}}. Canonical ACP has
      // no usage_update; forward best-effort, omit the rest.
      const used = optNum(rec["used"]);
      const cost = asRecord(rec["cost"]);
      const amount = cost ? optNum(cost["amount"]) : undefined;
      if (used === undefined && amount === undefined) return null;
      return {
        type: "usage",
        sessionId,
        ...(used === undefined ? {} : { totalTokens: used }),
        ...(amount === undefined ? {} : { costUsd: amount }),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function extractToolOutput(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return content || undefined;
  if (Array.isArray(content)) {
    const texts = content.flatMap((b): string[] => {
      const r = asRecord(b);
      if (!r) return [];
      const t = optStr(r["text"]);
      return t ? [t] : [];
    });
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

export interface ParsedPermission {
  /** Human reason for the approval_request event. */
  reason: string;
  /** Compact option listing for the approval_request detail. */
  detail: string;
  /** Option ids in server order (for a later lane's decision mapping). */
  optionIds: string[];
}

/**
 * Tolerant parse of `session/request_permission` params. Canonical options
 * are {optionId,name,kind}; version-skewed servers may send {id,label},
 * {value,title}, or bare strings — accept all, never hardcode one shape.
 * Returns null when params are not an object. Never throws.
 */
export function parsePermissionRequest(params: unknown): ParsedPermission | null {
  try {
    const rec = asRecord(params);
    if (!rec) return null;
    const tool = asRecord(rec["toolCall"]);
    const title = tool ? (optStr(tool["title"]) ?? optStr(tool["name"])) : undefined;
    const reason = title ? `permission requested: ${title}` : "agent requested approval";
    const raw = rec["options"];
    const options: Array<{ id: string; label: string }> = [];
    if (Array.isArray(raw)) {
      for (const o of raw) {
        if (typeof o === "string") {
          if (o) options.push({ id: o, label: o });
          continue;
        }
        const r = asRecord(o);
        if (!r) continue;
        const id = optStr(r["optionId"]) ?? optStr(r["id"]) ?? optStr(r["value"]);
        const label = optStr(r["name"]) ?? optStr(r["label"]) ?? optStr(r["title"]) ?? id;
        if (id && label) options.push({ id, label });
      }
    }
    return {
      reason,
      detail: options.length > 0 ? JSON.stringify(options) : "no options provided",
      optionIds: options.map((o) => o.id),
    };
  } catch {
    return null;
  }
}

/**
 * Map a `session/prompt` result's `usage` ({totalTokens,inputTokens,
 * outputTokens}, all optional) to a usage event. Null when absent or
 * non-numeric. Never throws.
 */
export function mapPromptUsage(result: unknown, sessionId: string): AgentEvent | null {
  try {
    const rec = asRecord(result);
    const usage = rec ? asRecord(rec["usage"]) : null;
    if (!usage) return null;
    const ev: Extract<AgentEvent, { type: "usage" }> = { type: "usage", sessionId };
    let found = false;
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const v = optNum(usage[key]);
      if (v !== undefined) {
        ev[key] = v;
        found = true;
      }
    }
    return found ? ev : null;
  } catch {
    return null;
  }
}

/** Terminal stop reasons that mean the turn really completed. */
const COMPLETION_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests"]);

const NON_COMPLETION_REASONS = new Set(["cancelled", "refusal"]);

/**
 * Classify a prompt `stopReason`. Returns "done" for real completion
 * (including unknown-but-terminal reasons — the turn did end), "refusal"
 * for refusal, and "cancelled" for cancellation. Never throws.
 */
export function classifyStopReason(reason: unknown): "done" | "refusal" | "cancelled" {
  if (reason === "cancelled") return "cancelled";
  if (reason === "refusal") return "refusal";
  if (typeof reason === "string") {
    if (NON_COMPLETION_REASONS.has(reason)) return reason === "refusal" ? "refusal" : "cancelled";
    if (COMPLETION_REASONS.has(reason)) return "done";
    // Unknown string reason: the turn terminated; treat as completion so
    // the run resolves instead of hanging on a future reason name.
    return "done";
  }
  // Missing/non-string reason on a successful response: completed.
  return "done";
}
