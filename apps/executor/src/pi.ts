import { spawn } from "node:child_process";
import type { AgentEvent } from "@cloudbear/protocol";

/** Cap on forwarded tool output — protects gateway memory and Telegram limits. */
export const MAX_TOOL_OUTPUT = 4000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

export interface PiRunOptions {
  sessionId: string;
  /** Absolute session dir for pi's own session files. */
  piSessionDir: string;
  /** Absolute cwd the agent works in. */
  workdir: string;
  model: string;
  prompt: string;
  piBin: string;
  openshellPrefix: string[];
  timeoutMs: number;
  onEvent: (e: AgentEvent) => void;
  /** When aborted, the child is killed (used by POST /abort in json mode). */
  signal?: AbortSignal;
}

export function buildPiArgs(o: { sessionId: string; piSessionDir: string; model: string; prompt: string }): string[] {
  return [
    "-p",
    "--mode",
    "json",
    "--session-id",
    o.sessionId,
    "--session-dir",
    o.piSessionDir,
    "--model",
    o.model,
    "--",
    o.prompt,
  ];
}

/**
 * Best-effort mapping of one pi `--mode json` output line to an AgentEvent.
 * Handles pi's real wire events (message_update/text_delta, tool_execution_*,
 * agent_end/agent_settled) plus generic fallbacks for other harnesses.
 * Unknown shapes without a message-like string field are ignored (null).
 * Deliberately drops duplicates: text_end/turn_end repeat text_delta content,
 * and thinking/toolcall progress is covered by tool_execution_* events.
 */
export function parsePiJsonLine(line: string, sessionId: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { type: "text", sessionId, delta: trimmed };
  }
  if (typeof obj === "string") return { type: "text", sessionId, delta: obj };
  if (obj === null || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const t = typeof rec["type"] === "string" ? (rec["type"] as string) : "";
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  // pi wire events (verified against pi 1.0 --mode json output).
  if (t === "message_update") {
    const ev = rec["assistantMessageEvent"];
    if (ev === null || typeof ev !== "object") return null;
    const inner = ev as Record<string, unknown>;
    if (inner["type"] === "text_delta") {
      const delta = str(inner["delta"]);
      return delta ? { type: "text", sessionId, delta } : null;
    }
    // Provider stream failures arrive here, not as a nonzero exit code.
    if (inner["type"] === "error") {
      return {
        type: "error",
        sessionId,
        message: str(inner["error"]) ?? str(inner["reason"]) ?? "provider stream error",
      };
    }
    return null;
  }
  if (t === "message_end") {
    // A failed or aborted assistant response does not make pi exit nonzero.
    const msg = rec["message"];
    if (msg === null || typeof msg !== "object") return null;
    const m = msg as Record<string, unknown>;
    if (m["role"] !== "assistant") return null;
    const stop = str(m["stopReason"]);
    if (stop === "error" || stop === "aborted") {
      return { type: "error", sessionId, message: `assistant response ${stop}` };
    }
    return null;
  }
  if (t === "extension_error") {
    return { type: "error", sessionId, message: str(rec["error"]) ?? "extension error" };
  }
  if (t === "tool_execution_start") {
    return {
      type: "tool_call",
      sessionId,
      name: str(rec["toolName"]) ?? "unknown",
      args: rec["args"],
    };
  }
  if (t === "tool_execution_end") {
    const result = rec["result"];
    let output: string | undefined;
    if (result !== null && typeof result === "object") {
      const content = (result as Record<string, unknown>)["content"];
      if (Array.isArray(content)) {
        const texts = content
          .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
          .map((b) => str(b["text"]))
          .filter((s): s is string => s !== undefined);
        if (texts.length > 0) output = truncate(texts.join("\n"), MAX_TOOL_OUTPUT);
      }
    }
    return {
      type: "tool_result",
      sessionId,
      name: str(rec["toolName"]) ?? "unknown",
      ok: rec["isError"] !== true,
      output,
    };
  }
  // agent_settled is the only real completion signal: agent_end can be
  // followed by retries, overflow recovery, compaction, or queued work.
  if (t === "agent_settled") {
    return { type: "done", sessionId };
  }
  if (
    t === "session" ||
    t === "agent_start" ||
    t === "agent_end" ||
    t === "turn_start" ||
    t === "message_start" ||
    t === "turn_end" ||
    t === "tool_execution_update" ||
    t === "queue_update" ||
    t === "session_info_changed" ||
    t === "thinking_level_changed" ||
    t === "entry_appended"
  ) {
    return null;
  }
  if (t === "compaction_start") {
    return { type: "status", sessionId, status: "running", message: `compacting (${str(rec["reason"]) ?? "unknown"})` };
  }
  if (t === "compaction_end") {
    if (rec["result"] === undefined) {
      return { type: "error", sessionId, message: `compaction failed: ${str(rec["errorMessage"]) ?? "unknown"}` };
    }
    return { type: "status", sessionId, status: "running", message: "compacted" };
  }
  if (t === "auto_retry_start") {
    const attempt = rec["attempt"] ?? "?";
    const max = rec["maxAttempts"] ?? "?";
    return {
      type: "status",
      sessionId,
      status: "running",
      message: `retrying (${attempt}/${max}): ${str(rec["errorMessage"]) ?? "provider error"}`,
    };
  }
  if (t === "auto_retry_end") {
    if (rec["success"] === false) {
      return { type: "error", sessionId, message: `retries exhausted: ${str(rec["finalError"]) ?? "unknown"}` };
    }
    return null;
  }

  if (t === "text" || t === "message" || t === "delta") {
    const delta = str(rec["delta"]) ?? str(rec["text"]) ?? str(rec["message"]) ?? str(rec["content"]);
    return delta === undefined ? null : { type: "text", sessionId, delta };
  }
  if (t === "tool_call" || t === "tool-call" || t === "tool_use") {
    const name = str(rec["name"]) ?? str(rec["tool"]) ?? "unknown";
    return { type: "tool_call", sessionId, name, args: rec["args"] ?? rec["input"] };
  }
  if (t === "tool_result" || t === "tool-result") {
    return {
      type: "tool_result",
      sessionId,
      name: str(rec["name"]) ?? "unknown",
      ok: rec["ok"] !== false && rec["error"] === undefined,
      output: str(rec["output"]) ?? str(rec["result"]),
    };
  }
  if (t === "approval_request" || t === "approval-request" || t === "permission_request") {
    const reason = str(rec["reason"]) ?? str(rec["message"]) ?? "agent requested approval";
    const requestId = str(rec["requestId"]) ?? str(rec["id"]) ?? `${Date.now()}`;
    return { type: "approval_request", sessionId, requestId, reason, detail: str(rec["detail"]) };
  }
  if (t === "done" || t === "result" || t === "complete") {
    return { type: "done", sessionId, summary: str(rec["summary"]) ?? str(rec["text"]) };
  }
  if (t === "error") {
    return { type: "error", sessionId, message: str(rec["message"]) ?? "agent error" };
  }
  // Unknown object: forward only if it carries an obvious message string.
  const fallback = str(rec["message"]) ?? str(rec["text"]) ?? str(rec["content"]) ?? str(rec["delta"]);
  return fallback === undefined ? null : { type: "text", sessionId, delta: fallback };
}

export interface PiRunResult {
  exitCode: number | null;
  /** An error event reached the caller (provider failure, timeout, bad exit). */
  sawError: boolean;
  /** agent_settled arrived — the run finished without automatic work left. */
  sawDone: boolean;
}

export async function runPiStreaming(opts: PiRunOptions): Promise<PiRunResult> {
  const argv = [...opts.openshellPrefix, opts.piBin, ...buildPiArgs(opts)];
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    let finished = false;
    let sawError = false;
    let sawDone = false;
    const emit = (e: AgentEvent) => {
      if (e.type === "error") sawError = true;
      if (e.type === "done") sawDone = true;
      opts.onEvent(e);
    };
    const finish = (r: { exitCode: number | null }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        opts.signal?.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
      resolve({ ...r, sawError, sawDone });
    };
    const child = spawn(cmd!, args, {
      cwd: opts.workdir,
      env: process.env,
      // stdin MUST be /dev/null: spawn defaults it to an open pipe nobody ever
      // closes, and pi waits for EOF on a piped stdin — so every run hung forever
      // with no output. Confirmed against pi 1.0.2 in the executor image.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onAbort = () => {
      // POST /abort in json mode: terminate the one-shot child.
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      emit({ type: "error", sessionId: opts.sessionId, message: `run timed out after ${opts.timeoutMs}ms` });
      child.kill("SIGKILL");
      finish({ exitCode: null });
    }, opts.timeoutMs);

    let stdoutBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const ev = parsePiJsonLine(line, opts.sessionId);
        if (ev) emit(ev);
      }
    });

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (err) => {
      emit({ type: "error", sessionId: opts.sessionId, message: `failed to start agent: ${err.message}` });
      finish({ exitCode: null });
    });
    child.on("close", (code) => {
      if (stdoutBuf.trim()) {
        const ev = parsePiJsonLine(stdoutBuf, opts.sessionId);
        if (ev) emit(ev);
      }
      if (code !== 0) {
        const detail = stderrTail.trim().split("\n").slice(-5).join("\n");
        emit({
          type: "error",
          sessionId: opts.sessionId,
          message: `agent exited with code ${code}${detail ? `: ${detail}` : ""}`,
        });
      }
      finish({ exitCode: code });
    });
  });
}
