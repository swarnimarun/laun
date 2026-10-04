import type { AgentEvent, SessionRecord } from "@laun/protocol";

/** Max Telegram message length; we chunk below it. */
export const TG_MAX = 4000;

/** Encode approval button payload: "appr:<sessionId>:<requestId>:<approve|deny>". */
export function encodeApproval(sessionId: string, requestId: string, decision: "approve" | "deny"): string {
  return `appr:${sessionId}:${requestId}:${decision}`;
}

export function decodeApproval(data: string): { sessionId: string; requestId: string; decision: "approve" | "deny" } | null {
  const m = data.match(/^appr:([A-Za-z0-9_-]{1,64}):(.+):(approve|deny)$/);
  if (!m) return null;
  return { sessionId: m[1], requestId: m[2], decision: m[3] as "approve" | "deny" };
}

function oneLine(e: AgentEvent): string | null {
  if (!e || typeof (e as { type?: unknown }).type !== "string") return null;
  switch (e.type) {
    case "text":
      return e.delta;
    case "tool_call":
      return `🔧 ${e.name}`;
    case "tool_result":
      return e.ok ? null : `⚠️ ${e.name} failed${e.output ? `: ${e.output.slice(0, 200)}` : ""}`;
    case "approval_request":
      return `🛑 approval needed: ${e.reason}`;
    case "done":
      return e.summary ? `✅ done: ${e.summary}` : `✅ done`;
    case "error":
      return `❌ ${e.message}`;
    case "status":
      return null; // noisy; session lifecycle shown via session messages instead
    default:
      return extraLine(e); // thinking/usage/future types: render or skip, never crash
  }
}

/**
 * Forward-tolerant rendering: known extra event kinds render, anything else
 * is skipped — never a crash, even against a newer gateway.
 */
function extraLine(e: AgentEvent): string | null {
  const t = (e as unknown as { type?: unknown }).type;
  if (t === "thinking") {
    const delta = (e as unknown as { delta?: unknown }).delta;
    return `💭 ${typeof delta === "string" && delta ? delta.slice(0, 500) : "(thinking)"}`;
  }
  if (t === "usage") {
    return usageLine(e as unknown as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown; costUsd?: unknown });
  }
  return null;
}

/**
 * One compact accounting line, or null when there is nothing worth saying.
 * Zero/empty usage (the common case — the harness emits zero-filled usage
 * objects on every message) renders as nothing: a bare "usage" line is noise.
 */
export function usageLine(u: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  costUsd?: unknown;
}): string | null {
  const parts: string[] = [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  const total = num(u.totalTokens);
  const cost = num(u.costUsd);
  if (input !== null) parts.push(`${input} in`);
  if (output !== null) parts.push(`${output} out`);
  if (total !== null) parts.push(`${total} total`);
  if (cost !== null) parts.push(`$${cost}`);
  return parts.length ? `📊 usage: ${parts.join(", ")}` : null;
}

/** Batch renderable events into Telegram-sized plain-text chunks. */
export function renderChunks(events: AgentEvent[]): string[] {
  const chunks: string[] = [];
  let cur = "";
  const push = (line: string) => {
    const add = cur ? "\n" + line : line;
    if ((cur + add).length > TG_MAX) {
      if (cur) chunks.push(cur);
      cur = line.length > TG_MAX ? line.slice(0, TG_MAX) : line;
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  };
  for (const e of events) {
    const line = oneLine(e);
    if (line) push(line);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function sessionLine(s: SessionRecord): string {
  return `🧸 session ${s.id} [${s.status}] model=${s.model}\n${s.goal.slice(0, 300)}`;
}
