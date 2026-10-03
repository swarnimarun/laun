import { spawn } from "node:child_process";
import type { AgentEvent } from "@cloudbear/protocol";

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
 * pi's JSON schema is version-dependent, so unknown shapes with no
 * message-like string field are ignored (null) instead of forwarded.
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

export async function runPiStreaming(opts: PiRunOptions): Promise<{ exitCode: number | null }> {
  const argv = [...opts.openshellPrefix, opts.piBin, ...buildPiArgs(opts)];
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (r: { exitCode: number | null }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd!, args, { cwd: opts.workdir, env: process.env });
    const timer = setTimeout(() => {
      opts.onEvent({ type: "error", sessionId: opts.sessionId, message: `run timed out after ${opts.timeoutMs}ms` });
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
        if (ev) opts.onEvent(ev);
      }
    });

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (err) => {
      opts.onEvent({ type: "error", sessionId: opts.sessionId, message: `failed to start agent: ${err.message}` });
      finish({ exitCode: null });
    });
    child.on("close", (code) => {
      if (stdoutBuf.trim()) {
        const ev = parsePiJsonLine(stdoutBuf, opts.sessionId);
        if (ev) opts.onEvent(ev);
      }
      if (code !== 0) {
        const detail = stderrTail.trim().split("\n").slice(-5).join("\n");
        opts.onEvent({
          type: "error",
          sessionId: opts.sessionId,
          message: `agent exited with code ${code}${detail ? `: ${detail}` : ""}`,
        });
      }
      finish({ exitCode: code });
    });
  });
}
