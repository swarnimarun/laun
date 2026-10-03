import type { AgentEvent, SessionRecord } from "@cloudbear/protocol";

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
      return null;
  }
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
