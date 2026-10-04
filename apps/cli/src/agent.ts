import type { AgentEvent, SessionRecord } from "@cloudbear/protocol";
import { UsageError } from "./args.js";
import { GatewayError, type GatewayClient, type PendingApproval } from "./client.js";

/** Human line(s) for one agent event. `status` without a message stays quiet. */
export function renderEvent(e: AgentEvent): string[] {
  switch (e.type) {
    case "text":
      return [e.delta];
    case "tool_call":
      // Show WHAT is running, not just that a tool ran: during a long job
      // (research, builds) the tool calls are the only visible activity, and
      // "🔧 bash" alone reads as a hang.
      return [`🔧 ${e.name}${summarizeArgs(e.args)}`];
    case "tool_result":
      return e.ok ? [] : [`⚠️ ${e.name} failed${e.output ? `: ${e.output}` : ""}`];
    case "status":
      return e.message ? [`· ${e.message}`] : [];
    case "thinking": {
      return e.delta ? [`💭 ${e.delta}`] : [];
    }
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


/** Compact one-line view of a tool's arguments: the command, path, or prompt. */
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else {
    const o = args as Record<string, unknown>;
    const picked = o["command"] ?? o["cmd"] ?? o["path"] ?? o["file_path"] ?? o["prompt"];
    text = typeof picked === "string" ? picked : safeJson(args);
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 120 ? ` ${text.slice(0, 117)}…` : ` ${text}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function sessionLine(s: SessionRecord): string {
  return `${s.id}  ${s.status.padEnd(16)} ${s.model}  ${s.goal.replace(/\s+/g, " ").slice(0, 60)}`;
}

export function isTerminal(e: AgentEvent): boolean {
  return e.type === "done" || e.type === "error";
}

export interface TranscriptIo {
  /** Print a complete line. */
  out: (line: string) => void;
  /** Write raw text with no trailing newline (streaming deltas). */
  write: (text: string) => void;
}

/**
 * Stream events to a terminal as a human would read them: text deltas are
 * concatenated as they arrive (pi emits a delta per token, so printing each one
 * as a line shreds paragraphs), thinking chunks coalesce the same way behind
 * a single 💭 prefix, and every other event starts a fresh line.
 */
export function createTranscript(io: TranscriptIo, asJson = false): (e: AgentEvent) => void {
  let inText = false;
  let inThinking = false;
  const endText = () => {
    if (inText) {
      io.write("\n");
      inText = false;
    }
  };
  const endThinking = () => {
    if (inThinking) {
      io.write("\n");
      inThinking = false;
    }
  };
  return (e: AgentEvent) => {
    if (asJson) {
      endText();
      endThinking();
      io.out(JSON.stringify(e));
      return;
    }
    if (e.type === "text") {
      endThinking();
      io.write(e.delta);
      inText = true;
      return;
    }
    if (e.type === "thinking") {
      const chunk = e.delta;
      if (!chunk) return;
      endText();
      if (!inThinking) {
        io.write("💭 ");
        inThinking = true;
      }
      io.write(chunk);
      return;
    }
    endText();
    endThinking();
    for (const line of renderEvent(e)) io.out(line);
  };
}

export interface FollowOptions {
  since?: number;
  /**
   * Start from the end of the log instead of replaying it. Needed because a
   * session's history usually already contains a done/error event, which would
   * otherwise end the follow immediately and hide the run you asked to watch.
   */
  fromLatest?: boolean;
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
  if (opts.fromLatest) {
    try {
      const head = await client.log(sessionId, since);
      since = head.next;
    } catch {
      // gateway hiccup: fall back to replaying from `since`
    }
  }
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

/**
 * Parse a CLI duration: a bare number is milliseconds, otherwise a number
 * with a unit (`500ms`, `30s`, `5m`, `1h`). Throws UsageError (exit 2).
 */
export function parseDurationMs(raw: string): number {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) throw new UsageError(`invalid duration "${raw}" (examples: 5000, 500ms, 30s, 5m, 1h)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60 * 1000 : 60 * 60 * 1000;
  const ms = n * mult;
  if (!Number.isFinite(ms) || ms <= 0) throw new UsageError(`invalid duration "${raw}" (must be > 0)`);
  return ms;
}

export interface WatchOptions {
  pollMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WatchIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Wait for a run to settle and report how it ended. Exit codes: 0 done,
 * 1 error (or unknown session), 2 timeout. Prints the settling event line
 * and nothing more; quiet while waiting so a cloud agent can block on it.
 *
 * A record that already reads done/error is reported from history (no
 * waiting); a live run is followed from the end of the log, so a stale
 * terminal event from an earlier run can never end the watch early.
 */
export async function watchSession(
  client: GatewayClient,
  sessionId: string,
  io: WatchIo,
  opts: WatchOptions = {},
): Promise<number> {
  let record: SessionRecord;
  try {
    record = (await client.getSession(sessionId)).session;
  } catch (e) {
    // Unknown id must fail fast: without this the log polls below would
    // retry until the timeout and a typo would hang the terminal for free.
    if (e instanceof GatewayError && e.status === 404) {
      io.err(`no such session: ${sessionId}`);
      return 1;
    }
    // Any other hiccup: fall through and let follow() retry the log.
    record = { id: sessionId, goal: "", model: "", runtime: "pi", status: "running", createdAt: "", updatedAt: "" };
  }

  if (record.status === "done" || record.status === "error") {
    // Already settled: replay history once to print the settling event line.
    try {
      const hist = await client.log(sessionId, 0);
      const settled = [...hist.events].reverse().find(isTerminal);
      if (settled) {
        for (const line of renderEvent(settled)) io.out(line);
        return settled.type === "done" ? 0 : 1;
      }
    } catch {
      // fall through to the record below
    }
    // Settled with no terminal event in the log (restart, crash): the
    // record is the only truth left, so report it instead of hanging.
    io.out(sessionLine(record));
    return record.status === "done" ? 0 : 1;
  }

  let settled: Extract<AgentEvent, { type: "done" | "error" }> | undefined;
  await follow(client, sessionId, {
    pollMs: opts.pollMs,
    maxMs: opts.maxMs,
    sleep: opts.sleep,
    fromLatest: true,
    onEvent: (e) => {
      if (e.type === "done" || e.type === "error") settled = e;
    },
  });
  if (settled) {
    for (const line of renderEvent(settled)) io.out(line);
    return settled.type === "done" ? 0 : 1;
  }
  // follow() returned without a terminal event: either the session record
  // flipped (restart, crash) or the timeout fired. Re-read the record once
  // so a settle is never reported as a timeout.
  try {
    const { session } = await client.getSession(sessionId);
    if (session.status === "done" || session.status === "error") {
      io.out(sessionLine(session));
      return session.status === "done" ? 0 : 1;
    }
  } catch {
    // fall through to the timeout below
  }
  io.err(`timed out waiting for session ${sessionId} to settle`);
  return 2;
}

/** Gateway reachability for `cloudbear doctor` (null = skipped, no target). */
export type DoctorGateway = { ok: true; service: string } | { ok: false; error: string };

/** Everything `cloudbear doctor` reports on. Built by the caller so tests
 * can stub the gateway probe; values (keys, tokens) never appear here. */
export interface DoctorProbe {
  version: string;
  /** How commands would connect, or null when nothing is configured. */
  target: { url: string; source: string; keyId?: string } | null;
  savedPresent: boolean;
  keyPresent: boolean;
  gateway: DoctorGateway | null;
}

/** Render the doctor report. Returns the lines and whether all is well. */
export function renderDoctor(p: DoctorProbe): { lines: string[]; healthy: boolean } {
  const lines = [`cloudbear doctor (cli ${p.version})`];
  const problems: string[] = [];
  if (p.target) {
    lines.push(`target: ${p.target.url} (from ${p.target.source})`);
    lines.push(`key: present${p.target.keyId ? ` (id ${p.target.keyId})` : ""}`);
  } else {
    lines.push("target: none");
    problems.push("no target — connect first: cloudbear agent auth --host <ip> --key <key>");
  }
  lines.push(`saved target file: ${p.savedPresent ? "present" : "missing (env override or nothing configured)"}`);
  if (!p.keyPresent && p.target) problems.push("target has no key — re-run cloudbear agent auth with a fresh key");
  if (p.gateway === null) {
    lines.push("gateway: skipped (no target)");
  } else if (p.gateway.ok) {
    lines.push(`gateway: reachable (${p.gateway.service})`);
  } else {
    lines.push(`gateway: unreachable: ${p.gateway.error}`);
    problems.push(`gateway unreachable: ${p.gateway.error}`);
  }
  if (problems.length > 0) {
    lines.push("problems:");
    for (const problem of problems) lines.push(`  - ${problem}`);
  } else {
    lines.push("healthy: all checks pass");
  }
  // Always printed: the failures this report exists to shortcut.
  lines.push("common failures + fixes:");
  lines.push("  - cannot reach a local gateway: start the stack (bun run dev:executor, bun run dev:gateway)");
  lines.push("  - cannot reach a remote gateway: providers block 8080 by default — tunnel: ssh -N -L 18080:localhost:8080 user@<host>, then auth against 127.0.0.1:18080");
  lines.push("  - unauthorized (wrong or revoked key): re-run cloudbear agent auth --host <host> --key <key>");
  return { lines, healthy: problems.length === 0 };
}

/** Print the doctor report. Exit 0 healthy / 1 problems found. */
export async function runDoctor(io: WatchIo, probe: () => Promise<DoctorProbe>): Promise<number> {
  const { lines, healthy } = renderDoctor(await probe());
  for (const line of lines) io.out(line);
  return healthy ? 0 : 1;
}