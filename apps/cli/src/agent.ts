import type { AgentEvent, SessionRecord } from "@cloudbear/protocol";
import type { GatewayClient, PendingApproval } from "./client.js";

/** Human line(s) for one agent event. `status` without a message stays quiet. */
export function renderEvent(e: AgentEvent): string[] {
  switch (e.type) {
    case "text":
      return [e.delta];
    case "tool_call":
      return [`🔧 ${e.name}`];
    case "tool_result":
      return e.ok ? [] : [`⚠️ ${e.name} failed${e.output ? `: ${e.output}` : ""}`];
    case "status":
      return e.message ? [`· ${e.message}`] : [];
    case "approval_request":
      return [`🛑 ${e.reason}`, `   approve: cloudbear agent approve ${e.sessionId} ${e.requestId}`];
    case "done":
      return [e.summary ? `✅ done: ${e.summary}` : "✅ done"];
    case "error":
      return [`❌ ${e.message}`];
    default:
      return [];
  }
}

export function sessionLine(s: SessionRecord): string {
  return `${s.id}  ${s.status.padEnd(16)} ${s.model}  ${s.goal.replace(/\s+/g, " ").slice(0, 60)}`;
}

export function isTerminal(e: AgentEvent): boolean {
  return e.type === "done" || e.type === "error";
}

export interface FollowOptions {
  since?: number;
  pollMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: AgentEvent) => void;
}

/**
 * Poll the gateway log until the run finishes. Stops on a done or error event,
 * and always after maxMs (default 30 minutes) so a stuck session cannot keep a
 * terminal attached forever. Returns the next cursor.
 */
export async function follow(
  client: GatewayClient,
  sessionId: string,
  opts: FollowOptions = {},
): Promise<number> {
  const pollMs = opts.pollMs ?? 2000;
  const maxMs = opts.maxMs ?? 30 * 60 * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + maxMs;
  let since = opts.since ?? 0;
  let idle = 0;
  for (;;) {
    let log: { events: AgentEvent[]; next: number };
    try {
      log = await client.log(sessionId, since);
    } catch {
      await sleep(pollMs);
      continue;
    }
    since = log.next;
    for (const e of log.events) {
      opts.onEvent?.(e);
      if (isTerminal(e)) return since;
    }
    idle++;
    if (Date.now() >= deadline) return since;
    // Fall back to the session record: a run that ended without a terminal
    // event (restart, crash) must not be followed forever.
    if (idle % 5 === 0) {
      try {
        const { session } = await client.getSession(sessionId);
        if (session.status === "done" || session.status === "error") {
          const tail = await client.log(sessionId, since);
          since = tail.next;
          for (const e of tail.events) {
            opts.onEvent?.(e);
            if (isTerminal(e)) return since;
          }
          return since;
        }
      } catch {
        // keep polling
      }
    }
    await sleep(pollMs);
  }
}

export function formatApprovals(approvals: PendingApproval[]): string[] {
  if (approvals.length === 0) return [];
  const lines = [`pending approvals: ${approvals.length}`];
  for (const a of approvals) {
    lines.push(`  🛑 ${a.requestId}  ${a.reason}`);
    lines.push(`     cloudbear agent approve ${a.sessionId} ${a.requestId}`);
  }
  return lines;
}