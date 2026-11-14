import type { AgentEvent, ExecutorRunRequest } from "@laun/protocol";
import { isAgentEvent, isTerminalAgentEvent } from "@laun/protocol";

/** Bound each decoded JSONL record, including an unfinished final line. */
export const MAX_EXECUTOR_EVENT_CHARS = 1_048_576;

/** POSTs a run to the executor and yields AgentEvents from the NDJSON stream. */
export async function* streamExecutorRun(
  executorUrl: string,
  token: string,
  req: ExecutorRunRequest,
): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${executorUrl}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`executor ${res.status}: ${detail.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("executor returned no event stream");
  yield* readExecutorEvents(res.body, req.sessionId);
}

/** Stream framing is separate from HTTP so cancellation and split records can be verified. */
export async function* readExecutorEvents(
  stream: ReadableStream<Uint8Array>,
  sessionId: string,
): AsyncGenerator<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buf = "";
  let consumed = false;
  let terminal = false;
  const parse = (line: string): AgentEvent | null => {
    if (line.length > MAX_EXECUTOR_EVENT_CHARS) throw new Error("executor event exceeds record limit");
    const ev = parseEventLine(line, sessionId);
    // Recovery can emit error then running; only the final record settles a run.
    if (ev) terminal = isTerminalAgentEvent(ev);
    return ev;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        consumed = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let start = 0;
      let end: number;
      while ((end = buf.indexOf("\n", start)) !== -1) {
        const ev = parse(buf.slice(start, end));
        start = end + 1;
        if (ev) yield ev;
      }
      buf = buf.slice(start);
      if (buf.length > MAX_EXECUTOR_EVENT_CHARS) throw new Error("executor event exceeds record limit");
    }
    const ev = parse(buf + decoder.decode());
    if (ev) yield ev;
    if (!terminal) throw new Error("executor stream ended without a terminal event");
  } finally {
    if (!consumed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseEventLine(line: string, sessionId: string): AgentEvent | null {
  const t = line.trim();
  if (!t) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    throw new Error("executor stream contains malformed JSON");
  }
  if (!isAgentEvent(obj)) throw new Error("executor stream contains an invalid event");
  if (obj.sessionId !== sessionId) throw new Error("executor event session mismatch");
  return obj;
}

/**
 * Ask the executor to kill an active run.
 *
 * A 404 is ambiguous: an executor without the abort route (not yet rebuilt or
 * redeployed) answers 404 with `{"error":"not found"}`, while one that has the
 * route but no such run answers `{"error":"unknown session"}`. Treating both as
 * success would let `stop` report a kill that never happened, so the body is
 * what decides.
 */
export async function abortExecutorRun(
  executorUrl: string,
  token: string,
  sessionId: string,
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${executorUrl}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId }),
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  }
}

/** True only when the executor demonstrably has an abort endpoint. */
export function executorKnowsAbort(result: { status: number; body: string }): boolean {
  if (result.status === 200 || result.status === 409) return true;
  if (result.status !== 404) return false;
  return /unknown session/i.test(result.body);
}

/**
 * Ask a busy executor to steer its live run with new direction.
 *
 * Executor-side contract (implemented by the executor; the gateway never
 * assumes it): `POST /steer {sessionId, text}` → 200 when a live run
 * consumed the text, 409 when the session exists but has no live run,
 * 404 `{"error":"unknown session"}` for unknown ids. A 404 with a
 * route-shaped body means the build has no steer endpoint at all (same
 * disambiguation as abort). Steer never starts a run — only redirects one.
 */
export async function steerExecutorRun(
  executorUrl: string,
  token: string,
  sessionId: string,
  text: string,
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${executorUrl}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId, text }),
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  }
}

/** True when the response proves a steer endpoint exists (any run state). */
export function executorKnowsSteer(result: { status: number; body: string }): boolean {
  if (result.status === 200 || result.status === 409) return true;
  if (result.status !== 404) return false;
  return /unknown session/i.test(result.body);
}

/**
 * Deliver a human approval decision to a parked executor run.
 * Best-effort by design: the gateway's local record is authoritative for the
 * UI, so a dead executor (or a run that already settled) never fails the
 * human's click — the outcome is published as an event either way.
 */
export async function approveExecutorDecision(
  executorUrl: string,
  token: string,
  sessionId: string,
  requestId: string,
  decision: "approve" | "deny",
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${executorUrl}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId, requestId, decision }),
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  }
}
