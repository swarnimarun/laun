import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@cloudbear/protocol";
import { parsePiJsonLine } from "./pi.js";

export function buildRpcArgs(o: { sessionId: string; piSessionDir: string; model: string }): string[] {
  return ["--mode", "rpc", "--session-id", o.sessionId, "--session-dir", o.piSessionDir, "--model", o.model];
}

export interface RpcRunOptions {
  sessionId: string;
  /** Absolute session dir for pi's own session files. */
  piSessionDir: string;
  /** Absolute cwd the agent works in. */
  workdir: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  onEvent: (e: AgentEvent) => void;
}

export interface RpcRunResult {
  sawError: boolean;
  sawDone: boolean;
  aborted: boolean;
  timedOut: boolean;
}

interface ActiveRun {
  onEvent: (e: AgentEvent) => void;
  promptId: string;
  sawError: boolean;
  sawDone: boolean;
  aborted: boolean;
  timedOut: boolean;
  resolve: (r: RpcRunResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionState {
  sessionId: string;
  piSessionDir: string;
  workdir: string;
  model: string;
  child: ChildProcess;
  pid: number | undefined;
  stdoutBuf: string;
  stderrTail: string;
  streaming: boolean;
  currentRun: ActiveRun | null;
  pendingState: Map<string, (v: boolean | null) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  killed: boolean;
  /**
   * True after an abort/timeout until pi's trailing `agent_settled` for
   * the dead run is observed. A new run must not send its prompt until
   * this clears: otherwise the stale settled would land mid-run and
   * complete it early with a false sawDone. Cleared by the stale settled
   * itself, by child exit, or by the gate timeout (wedged child).
   */
  settling: boolean;
  settleWaiters: Array<() => void>;
}

/** Max time a new run waits for the previous run's stale settled. */
const SETTLE_WAIT_MS = 5000;

function extractIsStreaming(obj: Record<string, unknown>): boolean | null {
  const direct = obj["isStreaming"];
  if (typeof direct === "boolean") return direct;
  for (const key of ["data", "result", "state", "payload"]) {
    const nested = obj[key];
    if (nested !== null && typeof nested === "object") {
      const v = (nested as Record<string, unknown>)["isStreaming"];
      if (typeof v === "boolean") return v;
    }
  }
  return null;
}

export interface RpcManagerOptions {
  piBin: string;
  openshellPrefix: string[];
  idleTtlMs: number;
}

/**
 * One long-lived `pi --mode rpc` child per session, reused across messages.
 * Framing is strict JSONL over stdin/stdout split only on LF (never readline,
 * which also splits on U+2028/U+2029 valid inside JSON strings).
 * Completion is `agent_settled`, never `agent_end`. `set_auto_retry` is sent
 * at startup so transient provider failures heal with visible retry events.
 */
export class RpcManager {
  private sessions = new Map<string, SessionState>();
  constructor(private opts: RpcManagerOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && !s.exited;
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.streaming ?? false;
  }

  /** Active OS pid for a session, if the child is still alive. */
  pidOf(sessionId: string): number | undefined {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited || s.killed) return undefined;
    if (s.child.exitCode !== null) return undefined;
    return s.pid;
  }

  async run(o: RpcRunOptions): Promise<RpcRunResult> {
    let session = this.ensureSession(o.sessionId, o.piSessionDir, o.workdir, o.model);
    if (session.currentRun) {
      throw new Error("session already running");
    }
    // Gate: after an abort/timeout pi still owes one trailing settled for
    // the dead run. Do not send the next prompt until it is consumed (or
    // the wait times out for a wedged child); otherwise the stale settled
    // would complete this run early. Poll-free: woken by the event itself.
    if (session.settling) {
      await this.waitForSettled(session, SETTLE_WAIT_MS);
      const fresh = this.sessions.get(o.sessionId);
      if (!fresh || fresh.exited || fresh.child.exitCode !== null) {
        session = this.ensureSession(o.sessionId, o.piSessionDir, o.workdir, o.model);
      } else {
        session = fresh;
      }
      if (session.currentRun) {
        throw new Error("session already running");
      }
    }
    // Capture pre-run streaming state before marking busy, so abort() and
    // isRunning() work during the get_state roundtrip below.
    const prevStreaming = session.streaming;
    const promptId = randomUUID();
    return new Promise<RpcRunResult>((resolve) => {
      const timer = setTimeout(() => {
        const cur = session.currentRun;
        if (!cur || cur.promptId !== promptId) return;
        cur.timedOut = true;
        cur.sawError = true;
        try {
          cur.onEvent({ type: "error", sessionId: o.sessionId, message: `run timed out after ${o.timeoutMs}ms` });
        } catch {
          // consumer gone
        }
        this.writeJson(session, { type: "abort" });
        // pi still owes a trailing settled for the timed-out run; mark it
        // so the next run gates until it is consumed (see settling).
        session.settling = true;
        this.finishRun(session, { aborted: false, timedOut: true });
      }, o.timeoutMs);
      // Keep the timeout from holding the test process open on its own.
      (timer as unknown as { unref?: () => void }).unref?.();

      const run: ActiveRun = {
        onEvent: (e) => {
          if (e.type === "error") run.sawError = true;
          if (e.type === "done") run.sawDone = true;
          o.onEvent(e);
        },
        promptId,
        sawError: false,
        sawDone: false,
        aborted: false,
        timedOut: false,
        resolve,
        timer,
      };
      session.streaming = true;
      session.currentRun = run;
      // Ask pi whether it is still streaming (desync guard). Fall back to
      // the local flag when pi does not answer. A busy child requires steer
      // — omitting streamingBehavior on a busy session is a pi error.
      void (async () => {
        let isStreaming: boolean | null = null;
        try {
          isStreaming = await this.queryState(session);
        } catch {
          isStreaming = null;
        }
        const cur = session.currentRun;
        // Aborted or timed out while get_state was in flight: never send.
        if (!cur || cur.promptId !== promptId || cur.aborted || cur.timedOut) return;
        const busy = isStreaming ?? prevStreaming;
        const cmd: Record<string, unknown> = { id: promptId, type: "prompt", message: o.prompt };
        if (busy) cmd["streamingBehavior"] = "steer";
        if (!this.writeJson(session, cmd)) {
          const still = session.currentRun;
          if (still && still.promptId === promptId) {
            still.sawError = true;
            try {
              still.onEvent({ type: "error", sessionId: o.sessionId, message: "agent process unavailable (stdin closed)" });
            } catch {
              // consumer gone
            }
            this.finishRun(session, { aborted: false, timedOut: false });
          }
        }
      })();
    });
  }

  /**
   * Abort the active run for a session: send `{"type":"abort"}` and wait for
   * idle is handled by pi; here we emit the user-visible event and resolve
   * the run so the HTTP stream closes and the busy slot releases. The child
   * itself stays alive for reuse (idle TTL reaps it later). Returns true when
   * a run was actually aborted.
   */
  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;
    const run = session.currentRun;
    if (!run || !session.streaming) return false;
    this.writeJson(session, { type: "abort" });
    run.aborted = true;
    run.sawError = true;
    try {
      run.onEvent({ type: "status", sessionId, status: "error", message: "aborted by user" });
    } catch {
      // consumer gone; the run still needs to resolve
    }
    // pi still owes a trailing settled for the aborted run. Mark settling
    // before resolving so the next run() gates until it is consumed and a
    // stale settled can never complete the next generation early.
    session.settling = true;
    this.finishRun(session, { aborted: true, timedOut: false });
    return true;
  }

  /** Resolve when `settling` clears (stale settled consumed or child gone). */
  private waitForSettled(session: SessionState, timeoutMs: number): Promise<void> {
    if (!session.settling) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Wedged child that never settles: stop gating and proceed. Any
        // impossibly-late settled afterwards is still ignored while idle.
        const idx = session.settleWaiters.indexOf(wake);
        if (idx >= 0) session.settleWaiters.splice(idx, 1);
        this.clearSettling(session);
        resolve();
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      session.settleWaiters.push(wake);
    });
  }

  private clearSettling(session: SessionState): void {
    if (!session.settling) return;
    session.settling = false;
    const waiters = session.settleWaiters.splice(0);
    for (const w of waiters) {
      try {
        w();
      } catch {
        // ignore teardown races
      }
    }
  }

  close(): void {
    // Test/teardown path: force-kill everything, even live runs. The 'close'
    // handlers clean the map asynchronously; clear timers now so TTL/abort
    // cannot double-kill after a respawn reuses the session id.
    for (const session of [...this.sessions.values()]) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      for (const [, resolve] of session.pendingState) resolve(null);
      session.pendingState.clear();
      this.clearSettling(session);
      if (session.killed || session.exited) continue;
      session.killed = true;
      try {
        session.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  private ensureSession(sessionId: string, piSessionDir: string, workdir: string, model: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.exited) {
      if (existing.child.exitCode !== null) {
        this.sessions.delete(sessionId);
      } else {
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = null;
        }
        if (model && model !== existing.model) {
          existing.model = model;
          this.writeJson(existing, { type: "set_model", model });
        }
        return existing;
      }
    } else if (existing) {
      this.sessions.delete(sessionId);
    }
    return this.spawnSession(sessionId, piSessionDir, workdir, model);
  }

  private spawnSession(sessionId: string, piSessionDir: string, workdir: string, model: string): SessionState {
    const argv = [...this.opts.openshellPrefix, this.opts.piBin, ...buildRpcArgs({ sessionId, piSessionDir, model })];
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { cwd: workdir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const session: SessionState = {
      sessionId,
      piSessionDir,
      workdir,
      model,
      child,
      pid: child.pid,
      stdoutBuf: "",
      stderrTail: "",
      streaming: false,
      currentRun: null,
      pendingState: new Map(),
      idleTimer: null,
      exited: false,
      killed: false,
      settling: false,
      settleWaiters: [],
    };
    this.sessions.set(sessionId, session);
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(session, chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      session.stderrTail = (session.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (err) => {
      if (session.exited) return;
      session.exited = true;
      this.clearSettling(session);
      const run = session.currentRun;
      if (run) {
        run.sawError = true;
        try {
          run.onEvent({ type: "error", sessionId, message: `failed to start agent: ${(err as Error).message}` });
        } catch {
          // consumer gone
        }
        this.finishRun(session, { aborted: false, timedOut: false });
      }
      for (const [, resolve] of session.pendingState) resolve(null);
      session.pendingState.clear();
      this.sessions.delete(sessionId);
    });
    child.on("close", (code) => {
      if (session.exited && !session.currentRun && !this.sessions.has(sessionId)) return;
      const wasRunning = !!session.currentRun;
      session.exited = true;
      // Awaiters gated on the stale settled must not hang when the child
      // is gone: the replacement child starts with no stale pending.
      this.clearSettling(session);
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      for (const [, resolve] of session.pendingState) resolve(null);
      session.pendingState.clear();
      if (wasRunning && session.currentRun) {
        const run = session.currentRun;
        run.sawError = true;
        // Only report an exit when the run had not already settled: a clean
        // idle reap after settle has no currentRun and stays silent.
        const detail = session.stderrTail.trim().split("\n").slice(-5).join("\n");
        try {
          run.onEvent({
            type: "error",
            sessionId,
            message: `agent exited with code ${code}${detail ? `: ${detail}` : ""}`,
          });
        } catch {
          // consumer gone
        }
        this.finishRun(session, { aborted: false, timedOut: false });
      }
      this.sessions.delete(sessionId);
    });
    // Enable self-healing retries; fire-and-forget (no id, no response).
    this.writeJson(session, { type: "set_auto_retry", enabled: true });
    return session;
  }

  private queryState(session: SessionState): Promise<boolean | null> {
    if (session.exited) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingState.delete(id);
        resolve(null);
      }, 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
      session.pendingState.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      if (!this.writeJson(session, { id, type: "get_state" })) {
        clearTimeout(timer);
        session.pendingState.delete(id);
        resolve(null);
      }
    });
  }

  private writeJson(session: SessionState, obj: unknown): boolean {
    try {
      const stdin = session.child.stdin;
      if (!stdin || stdin.destroyed) return false;
      return stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      return false;
    }
  }

  private onStdout(session: SessionState, chunk: Buffer): void {
    // Strict JSONL split on LF only. Never use readline here: it also splits
    // on U+2028/U+2029, which are valid inside JSON strings.
    session.stdoutBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = session.stdoutBuf.indexOf("\n")) >= 0) {
      const line = session.stdoutBuf.slice(0, idx);
      session.stdoutBuf = session.stdoutBuf.slice(idx + 1);
      this.onLine(session, line);
    }
  }

  private onLine(session: SessionState, line: string): void {
    if (!line.trim()) return;
    let obj: unknown = null;
    try {
      obj = JSON.parse(line);
    } catch {
      // Fall through to parsePiJsonLine, which forwards raw text lines.
    }
    if (obj !== null && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const id = typeof rec["id"] === "string" ? (rec["id"] as string) : undefined;
      if (id && session.pendingState.has(id)) {
        const resolve = session.pendingState.get(id)!;
        session.pendingState.delete(id);
        resolve(extractIsStreaming(rec));
        return;
      }
      // Fallback for minimal stubs (and forward-compat with pi variants)
      // that answer get_state without echoing the request id: a bare state
      // object satisfies a lone pending query instead of timing out.
      if (!id && session.pendingState.size === 1) {
        const streaming = extractIsStreaming(rec);
        if (streaming !== null) {
          const [[onlyId, resolve]] = [...session.pendingState.entries()];
          session.pendingState.delete(onlyId!);
          resolve(streaming);
          return;
        }
      }
    }
    const ev = parsePiJsonLine(line, session.sessionId);
    if (!ev) return;
    if (ev.type === "done") {
      const run = session.currentRun;
      if (!run) {
        // Idle settled: consume a pending stale (abort/timeout) if any.
        // A new run() gated on settling is woken here and only then sends
        // its prompt, so this event can never belong to a future run.
        if (session.settling) this.clearSettling(session);
        return;
      }
      if (session.settling) {
        // Gate-timeout fallback path: a new generation started while the
        // stale was still pending. This done is the stale one: consume it
        // without touching the new run, which keeps waiting for its own
        // settled. Without this, the stale would complete the new run
        // early with a false sawDone.
        this.clearSettling(session);
        return;
      }
      run.sawDone = true;
      try {
        run.onEvent(ev);
      } catch {
        // consumer disconnected mid-run: keep the run alive, drop this event.
      }
      this.finishRun(session, { aborted: false, timedOut: false });
      return;
    }
    const run = session.currentRun;
    if (!run) return; // idle: ignore late/broadcast events
    if (ev.type === "error") run.sawError = true;
    // Self-healing: a retry starting forgives the transient provider error
    // that triggered it. An exhausted retry re-marks sawError via its own
    // error event, so healed runs settle as done while failed runs stay error.
    if (ev.type === "status" && typeof ev.message === "string" && ev.message.startsWith("retrying")) {
      run.sawError = false;
    }
    try {
      run.onEvent(ev);
    } catch {
      // consumer disconnected mid-run: keep the run alive, drop this event.
    }
  }

  private finishRun(session: SessionState, opts: { aborted: boolean; timedOut: boolean }): void {
    const run = session.currentRun;
    if (!run) return;
    session.currentRun = null;
    session.streaming = false;
    clearTimeout(run.timer);
    if (opts.aborted) run.aborted = true;
    if (opts.timedOut) run.timedOut = true;
    this.scheduleIdle(session);
    run.resolve({ sawError: run.sawError, sawDone: run.sawDone, aborted: run.aborted, timedOut: run.timedOut });
  }

  private scheduleIdle(session: SessionState): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // Double-kill safety rests on the session-identity check below, not on
    // pid capture: after a respawn the map holds a different object, so a
    // stale timer for the old generation returns early and never signals
    // the new child. killSession additionally guards via killed/exited.
    session.idleTimer = setTimeout(() => {
      const current = this.sessions.get(session.sessionId);
      if (!current || current !== session) return;
      if (current.streaming || current.currentRun) return;
      this.killSession(session.sessionId);
    }, this.opts.idleTtlMs);
    (session.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.killed || session.exited) return;
    if (session.streaming || session.currentRun) return; // never reap a live run
    if (session.child.exitCode !== null) {
      this.sessions.delete(sessionId);
      return;
    }
    // Guard against double-kill: mark first, signal once.
    session.killed = true;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    try {
      session.child.kill("SIGKILL");
    } catch {
      // already gone
    }
    // The 'close' handler removes the session from the map.
  }
}
