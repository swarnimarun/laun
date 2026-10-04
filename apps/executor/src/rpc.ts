import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@laun/protocol";
import {
  buildNotifySteerMessage,
  DEFAULT_NOTIFY_GRANT_POLL_MS,
  DEFAULT_NOTIFY_GRANT_WINDOW_MS,
  fetchGrantHistorySync,
  isDenialOutput,
} from "./notify.js";
import { handlePiLine, ThinkingCoalescer, parsePiJsonLine } from "./pi.js";
import { SANDBOX_WORKDIR, sandboxNameForSession, type SandboxReaper, type SandboxRunner } from "./sandbox.js";

export function buildRpcArgs(o: { sessionId: string; piSessionDir: string; model: string }): string[] {
  return ["--mode", "rpc", "--session-id", o.sessionId, "--session-dir", o.piSessionDir, "--model", o.model];
}

export interface RpcRunOptions {
  sessionId: string;
  /**
   * Session dir for pi's own session files. In sandbox mode this points
   * INSIDE the sandbox (host /data is invisible there); otherwise host-side.
   */
  piSessionDir: string;
  /** Host cwd for the spawn (the CLI process cwd; SDK transport ignores it). */
  workdir: string;
  /** In-sandbox cwd for the exec. Unset runs in the sandbox default. */
  sandboxWorkdir?: string;
  /**
   * Host dir uploaded into the sandbox on create (repo/goal context).
   * Skipped when unset or empty.
   */
  uploadFrom?: string;
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
  /** Per-run reasoning accumulator (shared helper in pi.ts). */
  thinking: ThinkingCoalescer;
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
  /** Sandbox holding the rpc child, or null for a direct host spawn. */
  sandboxName: string | null;
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
  /**
   * Parked extension_ui approvals (confirm/select only), keyed by pi's
   * request id. pi blocks until extension_ui_response arrives, so the run
   * is implicitly parked; the per-entry timer fail-closes (deny) and
   * abort/run-timeout/disconnect release every entry as denied.
   */
  pendingApprovals: Map<string, PendingApproval>;
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

/** Default bound for one parked approval before it is denied (5m). */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** Only these extension_ui methods park a run waiting for a decision. */
const PARKING_METHODS = new Set(["confirm", "select"]);

/** Dialog methods that would block pi forever without a response. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** One parked approval: pi's dialog blocks until we answer. */
interface PendingApproval {
  /** pi extension_ui method (confirm|select). */
  method: string;
  /** select options in server order (first = the approve choice). */
  options: string[];
  /** Run-stream emitter for timeout/deny notices. */
  onEvent: (e: AgentEvent) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** Parsed `extension_ui_request` (see pi docs rpc-extension-ui.md). */
export interface ExtensionUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options: string[];
}

/**
 * Best-effort parse of one `extension_ui_request` object. Returns null for
 * anything else (including malformed requests). Never throws. Option
 * extraction is tolerant: bare strings plus {value}/{optionId,id}/{name,
 * label} shapes across pi versions.
 */
export function parseExtensionUiRequest(obj: unknown): ExtensionUiRequest | null {
  try {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (rec["type"] !== "extension_ui_request") return null;
    const id = rec["id"];
    const method = rec["method"];
    if (typeof id !== "string" || !id || typeof method !== "string" || !method) return null;
    const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const options: string[] = [];
    const raw = rec["options"];
    if (Array.isArray(raw)) {
      for (const o of raw) {
        if (typeof o === "string") {
          if (o) options.push(o);
          continue;
        }
        if (o !== null && typeof o === "object" && !Array.isArray(o)) {
          const r = o as Record<string, unknown>;
          const v = optStr(r["value"]) ?? optStr(r["optionId"]) ?? optStr(r["id"]) ?? optStr(r["name"]) ?? optStr(r["label"]);
          if (v) options.push(v);
        }
      }
    }
    const out: ExtensionUiRequest = { id, method, options };
    const title = optStr(rec["title"]);
    if (title) out.title = title;
    const message = optStr(rec["message"]);
    if (message) out.message = message;
    return out;
  } catch {
    return null;
  }
}

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
  /**
   * Bound for one parked approval (extension_ui confirm/select) before it
   * is denied automatically. Fail-closed: a run never hangs forever.
   * Defaults to 300_000 (5m).
   */
  approvalTimeoutMs?: number;
  /**
   * Watch window after a denial-shaped tool failure (notify-on-grant).
   * Defaults to 90_000 (90s). Tests inject short values.
   */
  notifyWindowMs?: number;
  /**
   * Poll interval for `openshell rule history` inside the watch window.
   * Defaults to 10_000 (10s). Tests inject short values.
   */
  notifyPollMs?: number;
  /** openshell CLI binary for grant-history polls. Defaults to "openshell". */
  openshellBin?: string;
  /**
   * Injected history fetcher (tests stub the CLI here: no live contact).
   * Production defaults to `fetchGrantHistorySync` on `openshellBin`.
   */
  notifyFetch?: (sandboxName: string) => string[] | Promise<string[]>;
  /**
   * When set, pi spawns inside a per-session sandbox (created on first run,
   * STOPPED (workspace preserved) when the child dies or is reaped, STARTED
   * on the next run, DELETED only by the age reaper). Unset spawns directly.
   */
  sandboxRunner?: SandboxRunner;
  /**
   * Age reaper deleting long-idle sandboxes. Tracked on every run; sweep
   * via `reaper.sweep()` (background interval when constructed with one).
   */
  reaper?: SandboxReaper;
}

/** One notify-on-grant watch: baseline + bounded poll for new grants. */
interface NotifyWatch {
  sandboxName: string;
  seen: Set<string>;
  deadline: number;
  timer: ReturnType<typeof setInterval>;
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
  /**
   * Notify-on-grant watches keyed by session. Started on a denial-shaped
   * tool failure, stopped on fire/expiry/settle/teardown. One per session.
   */
  private notifyWatches = new Map<string, NotifyWatch>();
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
    if (this.opts.sandboxRunner) {
      // Activity for the age reaper: every run keeps the sandbox alive.
      try {
        this.opts.reaper?.track(sandboxNameForSession(o.sessionId));
      } catch {
        // Tracking must never break a run.
      }
    }
    let session = await this.ensureSession(o.sessionId, o.piSessionDir, o.workdir, o.model, o.sandboxWorkdir, o.uploadFrom);
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
        session = await this.ensureSession(o.sessionId, o.piSessionDir, o.workdir, o.model, o.sandboxWorkdir, o.uploadFrom);
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
          const rest = cur.thinking.flush();
          if (rest) cur.onEvent(rest);
        } catch {
          // consumer gone
        }
        try {
          cur.onEvent({ type: "error", sessionId: o.sessionId, message: `run timed out after ${o.timeoutMs}ms` });
        } catch {
          // consumer gone
        }
        // A parked run must not hang past the run timeout: deny first.
        this.denyAllPending(o.sessionId, "run timed out");
        this.writeJson(session, { type: "abort" });
        // pi still owes a trailing settled for the timed-out run; mark it
        // so the next run gates until it is consumed (see settling).
        // A wedged child that ignores abort never settles: arm a bounded
        // SIGKILL grace (same SETTLE_WAIT_MS shape, no new timer family) so
        // its slot frees even when no second run ever gates.
        session.settling = true;
        this.armSettleKill(session);
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
        thinking: new ThinkingCoalescer(o.sessionId),
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
   * Steer the live run with new direction via pi's `steer` command
   * (delivered after the current assistant turn, before the next LLM call).
   * Fire-and-forget: the run continues, no completion side effects.
   * Returns false when there is no live run (caller maps to 404/409).
   */
  steer(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;
    if (!session.currentRun || !session.streaming) return false;
    return this.writeJson(session, { type: "steer", message: text });
  }

  /**
   * Deliver a human decision to a parked approval. Writes the matching
   * `extension_ui_response` (confirm: confirmed/cancelled; select: first
   * option value/cancelled — cancelled reads as deny to the extension)
   * and unparks the run. Returns false for unknown sessions/requests.
   * An approve on a select with no recorded options fail-closes to deny.
   */
  decideApproval(sessionId: string, requestId: string, decision: "approve" | "deny"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;
    return this.settleApproval(session, requestId, decision, `approval ${requestId} ${decision}`);
  }

  /** Parked approval request ids for a session (tests/diagnostics). */
  pendingApprovalIds(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId)?.pendingApprovals.keys() ?? [])];
  }

  /** True while a notify-on-grant watch is armed (tests/diagnostics). */
  hasNotifyWatch(sessionId: string): boolean {
    return this.notifyWatches.has(sessionId);
  }

  private notifyWindowMs(): number {
    return this.opts.notifyWindowMs ?? DEFAULT_NOTIFY_GRANT_WINDOW_MS;
  }

  private notifyPollMs(): number {
    return this.opts.notifyPollMs ?? DEFAULT_NOTIFY_GRANT_POLL_MS;
  }

  private async fetchNotifyHistory(sandboxName: string): Promise<string[]> {
    try {
      if (this.opts.notifyFetch) return (await this.opts.notifyFetch(sandboxName)) ?? [];
      return fetchGrantHistorySync(this.opts.openshellBin ?? "openshell", sandboxName);
    } catch {
      return [];
    }
  }

  /**
   * Start a bounded grant watch after a denial-shaped tool failure.
   * No sandbox (direct spawn) means no grants to see: skip silently.
   * Json one-shot runs never reach here (rpc-only watcher). Never throws.
   */
  private maybeStartNotifyWatch(session: SessionState, output?: string): void {
    try {
      if (!this.opts.sandboxRunner) return;
      const sandboxName = session.sandboxName;
      if (!sandboxName) return;
      if (this.notifyWatches.has(session.sessionId)) return;
      if (!session.currentRun || !session.streaming) return;
      if (!isDenialOutput(output)) return;
      const windowMs = this.notifyWindowMs();
      const pollMs = this.notifyPollMs();
      // Baseline synchronously when the fetcher is sync so the first poll
      // cannot fire on pre-existing grants; async fetchers establish it
      // on their first tick instead (see pollNotifyWatch).
      let baseline: string[] = [];
      let baselineReady = false;
      try {
        const maybe = this.opts.notifyFetch
          ? this.opts.notifyFetch(sandboxName)
          : fetchGrantHistorySync(this.opts.openshellBin ?? "openshell", sandboxName);
        if (Array.isArray(maybe)) {
          baseline = maybe;
          baselineReady = true;
        }
      } catch {
        baseline = [];
        baselineReady = false;
      }
      const watch: NotifyWatch = {
        sandboxName,
        seen: new Set(baselineReady ? baseline : []),
        deadline: Date.now() + windowMs,
        timer: undefined as unknown as ReturnType<typeof setInterval>,
      };
      // Async baseline: resolve before the first poll can fire.
      if (!baselineReady && this.opts.notifyFetch) {
        void this.fetchNotifyHistory(sandboxName)
          .then((names) => {
            const w = this.notifyWatches.get(session.sessionId);
            if (w) for (const n of names) w.seen.add(n);
          })
          .catch(() => {
            // keep the empty baseline; the next poll retries
          });
      }
      watch.timer = setInterval(() => {
        void this.pollNotifyWatch(session.sessionId).catch(() => {
          // poll must never throw into the timer
        });
      }, pollMs);
      (watch.timer as unknown as { unref?: () => void }).unref?.();
      this.notifyWatches.set(session.sessionId, watch);
    } catch {
      // watcher setup must never break a run
    }
  }

  /**
   * One poll tick: expire silently at the deadline, else steer the live
   * run on the first NEW approved rule. Steer declined (no live run) stops
   * the watch with no note. Fires once, then stops. Never throws.
   */
  private async pollNotifyWatch(sessionId: string): Promise<void> {
    const watch = this.notifyWatches.get(sessionId);
    if (!watch) return;
    try {
      if (Date.now() >= watch.deadline) {
        this.stopNotifyWatch(sessionId);
        return;
      }
      let names: string[] = [];
      try {
        names = await this.fetchNotifyHistory(watch.sandboxName);
      } catch {
        return; // failed poll keeps the watch until expiry
      }
      const fresh = names.filter((n) => n && !watch.seen.has(n));
      for (const n of names) watch.seen.add(n);
      if (fresh.length === 0) return;
      const rule = fresh[0]!;
      const message = buildNotifySteerMessage(rule);
      if (!this.steer(sessionId, message)) {
        this.stopNotifyWatch(sessionId);
        return;
      }
      try {
        this.sessions
          .get(sessionId)
          ?.currentRun?.onEvent({ type: "status", sessionId, status: "running", message });
      } catch {
        // consumer gone; pi still got the steer
      }
      this.stopNotifyWatch(sessionId);
    } catch {
      // poll must never break the run; expiry stops it eventually
    }
  }

  /** Stop and forget a grant watch (fire/expiry/settle/teardown). */
  private stopNotifyWatch(sessionId: string): void {
    try {
      const w = this.notifyWatches.get(sessionId);
      if (!w) return;
      try {
        clearInterval(w.timer);
      } catch {
        // ignore teardown races
      }
      this.notifyWatches.delete(sessionId);
    } catch {
      // teardown paths must never throw
    }
  }

  /**
   * Release every parked approval as denied (gateway disconnect path).
   * The run itself continues: pi receives the denials and proceeds.
   * Never throws; no-op when nothing is parked.
   */
  denyAllPending(sessionId: string, reason: string): void {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      for (const id of [...session.pendingApprovals.keys()]) {
        try {
          this.settleApproval(session, id, "deny", `approval ${id} denied (${reason})`);
        } catch {
          // one bad entry must not block the rest
        }
      }
    } catch {
      // disconnect/teardown paths must never throw
    }
  }

  /**
   * Abort the active run for a session: send `{"type":"abort"}` and wait for
   * idle is handled by pi; here we emit the user-visible event and resolve
   * the run so the HTTP stream closes and the busy slot releases. A healthy
   * child stays alive for reuse (idle TTL reaps it later); a wedged child
   * that never settles is SIGKILLed after the bounded settle grace.
   * Returns true when a run was actually aborted.
   */
  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;
    const run = session.currentRun;
    if (!run || !session.streaming) return false;
    // A parked run must never hang: release every approval as denied first
    // so pi's dialog unblocks, then abort the run itself.
    this.denyAllPending(sessionId, "run aborted");
    this.writeJson(session, { type: "abort" });
    run.aborted = true;
    run.sawError = true;
    try {
      const rest = run.thinking.flush();
      if (rest) run.onEvent(rest);
    } catch {
      // consumer gone; the run still needs to resolve
    }
    try {
      run.onEvent({ type: "status", sessionId, status: "error", message: "aborted by user" });
    } catch {
      // consumer gone; the run still needs to resolve
    }
    // pi still owes a trailing settled for the aborted run. Mark settling
    // before resolving so the next run() gates until it is consumed and a
    // stale settled can never complete the next generation early.
    session.settling = true;
    this.armSettleKill(session);
    this.finishRun(session, { aborted: true, timedOut: false });
    return true;
  }

  /**
   * Bounded grace for a wedged child: if the session is still settling with
   * no live run after SETTLE_WAIT_MS, SIGKILL it so the slot frees. Reuses
   * the existing settle-wait duration, not a second timer family. Never
   * touches a live run (streaming/currentRun) or a newer generation: the
   * session-identity check makes a stale timer return early after respawn.
   */
  private armSettleKill(session: SessionState): void {
    const id = session.sessionId;
    const child = session.child;
    const timer = setTimeout(() => {
      const cur = this.sessions.get(id);
      if (!cur || cur !== session) return;
      if (!cur.settling || cur.currentRun || cur.streaming) return;
      if (cur.exited || cur.killed) return;
      if (child.exitCode !== null) return;
      this.killSession(id);
    }, SETTLE_WAIT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Resolve when `settling` clears (stale settled consumed or child gone). */
  private waitForSettled(session: SessionState, timeoutMs: number): Promise<void> {
    if (!session.settling) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Wedged child that never settles: SIGKILL after the bounded grace
        // so the next run spawns fresh instead of reusing the wedged child.
        // Any impossibly-late settled afterwards is still ignored while idle.
        const idx = session.settleWaiters.indexOf(wake);
        if (idx >= 0) session.settleWaiters.splice(idx, 1);
        try {
          const cur = this.sessions.get(session.sessionId);
          if (
            cur &&
            cur === session &&
            session.settling &&
            !session.currentRun &&
            !session.streaming &&
            !session.exited &&
            !session.killed &&
            session.child.exitCode === null
          ) {
            this.killSession(session.sessionId);
          }
        } catch {
          // kill is best-effort; gating must proceed regardless
        }
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
    for (const id of [...this.notifyWatches.keys()]) this.stopNotifyWatch(id);
    for (const session of [...this.sessions.values()]) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      // Teardown stops the sandbox (workspace preserved for the next run);
      // only the age reaper deletes. The kill below triggers the 'close'
      // handler, which stops again idempotently.
      this.stopSandbox(session.sandboxName);
      for (const [, resolve] of session.pendingState) resolve(null);
      session.pendingState.clear();
      this.clearSettling(session);
      this.clearPendingApprovals(session);
      if (session.killed || session.exited) continue;
      session.killed = true;
      try {
        session.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  private async ensureSession(
    sessionId: string,
    piSessionDir: string,
    workdir: string,
    model: string,
    sandboxWorkdir?: string,
    uploadFrom?: string,
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.exited) {
      if (existing.child.exitCode !== null) {
        this.clearPendingApprovals(existing);
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
    return this.spawnSession(sessionId, piSessionDir, workdir, model, sandboxWorkdir, uploadFrom);
  }

  /** Best-effort sandbox stop (workspace preserved): never throws, safe on reap/teardown paths. */
  private stopSandbox(sandboxName: string | null): void {
    if (!sandboxName || !this.opts.sandboxRunner) return;
    try {
      void this.opts.sandboxRunner.stop(sandboxName).catch(() => {
        // stop() is best-effort by contract; this guards fakes too.
      });
    } catch {
      // synchronous throws from a runner must never wedge run slots.
    }
  }

  /** Best-effort sandbox delete: only for create-failure cleanup (half-made sandboxes). */
  private deleteSandbox(sandboxName: string | null): void {
    if (!sandboxName || !this.opts.sandboxRunner) return;
    try {
      void this.opts.sandboxRunner.remove(sandboxName).catch(() => {
        // remove() is best-effort by contract; this guards fakes too.
      });
    } catch {
      // synchronous throws from a runner must never wedge run slots.
    }
  }

  private async spawnSession(
    sessionId: string,
    piSessionDir: string,
    workdir: string,
    model: string,
    sandboxWorkdir?: string,
    uploadFrom?: string,
  ): Promise<SessionState> {
    const sandboxName = this.opts.sandboxRunner ? sandboxNameForSession(sessionId) : null;
    if (sandboxName) {
      // Sandbox-per-session lifecycle: an existing sandbox is STARTED
      // (workspace persisted across the idle stop); only a missing one is
      // created (with repo/goal context uploaded). Fail loudly, never
      // silently unsandboxed: create errors reject the run before any child
      // exists. Best-effort delete first so a half-made sandbox does not leak.
      try {
        if (await this.opts.sandboxRunner!.exists(sandboxName)) {
          await this.opts.sandboxRunner!.start(sandboxName);
        } else {
          await this.opts.sandboxRunner!.create({ name: sandboxName, uploadFrom });
        }
      } catch (e) {
        this.deleteSandbox(sandboxName);
        throw e;
      }
    }
    const piArgv = [this.opts.piBin, ...buildRpcArgs({ sessionId, piSessionDir, model })];
    let child: ChildProcess;
    if (sandboxName) {
      child = this.opts.sandboxRunner!.spawnInteractive(sandboxName, piArgv, {
        cwd: workdir,
        env: process.env,
        sandboxWorkdir: sandboxWorkdir ?? SANDBOX_WORKDIR,
      });
    } else {
      const argv = [...this.opts.openshellPrefix, ...piArgv];
      const [cmd, ...args] = argv;
      child = spawn(cmd!, args, { cwd: workdir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    }
    const session: SessionState = {
      sessionId,
      sandboxName,
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
      pendingApprovals: new Map(),
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
      this.clearPendingApprovals(session);
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
      // The child never started: stop its sandbox (workspace preserved);
      // a half-made sandbox from a failed create is deleted by the caller.
      this.stopSandbox(session.sandboxName);
    });
    child.on("close", (code) => {
      if (session.exited && !session.currentRun && !this.sessions.has(sessionId)) return;
      const wasRunning = !!session.currentRun;
      session.exited = true;
      // Awaiters gated on the stale settled must not hang when the child
      // is gone: the replacement child starts with no stale pending.
      this.clearSettling(session);
      this.clearPendingApprovals(session);
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
      // Sandbox lifetime == child lifetime, but STOP (not delete): the
      // workspace (session files) persists for the next run's start.
      // Covers crashes, idle reap kills, and settle-grace kills alike.
      // Deletion is the age reaper's job only.
      this.stopSandbox(session.sandboxName);
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

  private approvalTimeoutMs(): number {
    return this.opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /**
   * Route one `extension_ui_request`. confirm/select park the run: an
   * `approval_request` event goes to the stream and the run waits (pi
   * blocks) until decideApproval, timeout, abort, or disconnect. Every
   * other method informs only: a running status on the stream, and an
   * immediate cancelled response for dialogs (input/editor) so pi never
   * blocks on a decision nobody will make. Fire-and-forget methods
   * (notify/...) expect no response — none is sent.
   */
  private onExtensionUi(session: SessionState, req: ExtensionUiRequest): void {
    const run = session.currentRun;
    if (!run || !session.streaming || !PARKING_METHODS.has(req.method)) {
      const text = (req.title ?? req.message ?? `${req.method} requested`).slice(0, 500);
      if (run) {
        try {
          run.onEvent({ type: "status", sessionId: session.sessionId, status: "running", message: `ui ${req.method}: ${text}` });
        } catch {
          // consumer gone; the run still proceeds
        }
        // A dialog nobody parks would block pi forever: release it now.
        if (DIALOG_METHODS.has(req.method)) {
          this.writeJson(session, { type: "extension_ui_response", id: req.id, cancelled: true });
        }
      } else if (DIALOG_METHODS.has(req.method)) {
        // Idle dialog (no run to park): still answer so the child never hangs.
        this.writeJson(session, { type: "extension_ui_response", id: req.id, cancelled: true });
      }
      return;
    }
    const reason = (req.title ?? req.message ?? `${req.method} approval requested`).slice(0, 500);
    const detail =
      req.method === "select" && req.options.length > 0
        ? `options: ${req.options.join(", ")}`.slice(0, 500)
        : req.message && req.message !== reason
          ? req.message.slice(0, 500)
          : undefined;
    try {
      run.onEvent({
        type: "approval_request",
        sessionId: session.sessionId,
        requestId: req.id,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch {
      // consumer gone; the approval still parks (timeout/abort release it)
    }
    const pending: PendingApproval = {
      method: req.method,
      options: req.options,
      onEvent: run.onEvent,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
    };
    const timer = setTimeout(() => this.onApprovalTimeout(session.sessionId, req.id), this.approvalTimeoutMs());
    (timer as unknown as { unref?: () => void }).unref?.();
    pending.timer = timer;
    session.pendingApprovals.set(req.id, pending);
  }

  /** Resolve one parked approval and answer pi. Returns false when unknown. */
  private settleApproval(session: SessionState, requestId: string, decision: "approve" | "deny", note: string): boolean {
    const p = session.pendingApprovals.get(requestId);
    if (!p || p.settled) return false;
    p.settled = true;
    clearTimeout(p.timer);
    session.pendingApprovals.delete(requestId);
    // Verified shapes come from pi docs rpc-extension-ui.md: confirm takes
    // confirmed/cancelled, select takes value/cancelled. Deny is always
    // cancelled (the extension reads it as false/undefined). Approve on a
    // select answers the first offered option; with no recorded options
    // there is no verifiable approve shape, so it fail-closes to deny.
    const response =
      decision === "approve" && p.method === "confirm"
        ? { type: "extension_ui_response", id: requestId, confirmed: true }
        : decision === "approve" && p.method === "select" && p.options.length > 0
          ? { type: "extension_ui_response", id: requestId, value: p.options[0] }
          : { type: "extension_ui_response", id: requestId, cancelled: true };
    this.writeJson(session, response);
    try {
      p.onEvent({ type: "status", sessionId: session.sessionId, status: "running", message: note });
    } catch {
      // consumer gone; pi still got its answer
    }
    return true;
  }

  /** Bounded wait expired: deny by default (fail-closed). Never throws. */
  private onApprovalTimeout(sessionId: string, requestId: string): void {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.settleApproval(session, requestId, "deny", `approval ${requestId} denied (timeout)`);
    } catch {
      // timer paths must never throw
    }
  }

  /** Clear pending timers without answering (child is dead). Never throws. */
  private clearPendingApprovals(session: SessionState): void {
    try {
      for (const p of session.pendingApprovals.values()) {
        try {
          clearTimeout(p.timer);
        } catch {
          // ignore teardown races
        }
        p.settled = true;
      }
      session.pendingApprovals.clear();
    } catch {
      // teardown paths must never throw
    }
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
    // Extension UI subprotocol (pi docs rpc-extension-ui.md): intercept
    // before the generic parser, whose message-field fallback would
    // otherwise double-emit the dialog text as a chat event.
    const uiReq = parseExtensionUiRequest(obj);
    if (uiReq) {
      this.onExtensionUi(session, uiReq);
      return;
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
    const run = session.currentRun;
    if (!run) {
      // Idle: only a stale trailing settled matters (consumed by the
      // abort/timeout gate). All other late/broadcast events are ignored.
      // A new run() gated on settling is woken here and only then sends
      // its prompt, so this event can never belong to a future run.
      const idleEv = parsePiJsonLine(line, session.sessionId);
      if (idleEv?.type === "done" && session.settling) this.clearSettling(session);
      return;
    }
    // Thinking/usage/done handling is shared with the json path via the
    // coalescing helper in pi.ts; the remainder flushes before `done`.
    handlePiLine(line, session.sessionId, run.thinking, (e) => this.deliverToRun(session, run, e));
  }

  private deliverToRun(session: SessionState, run: ActiveRun, e: AgentEvent): void {
    if (e.type === "done") {
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
        run.onEvent(e);
      } catch {
        // consumer disconnected mid-run: keep the run alive, drop this event.
      }
      this.finishRun(session, { aborted: false, timedOut: false });
      return;
    }
    if (e.type === "error") run.sawError = true;
    // Self-healing: a retry starting forgives the transient provider error
    // that triggered it. An exhausted retry re-marks sawError via its own
    // error event, so healed runs settle as done while failed runs stay error.
    if (e.type === "status" && typeof e.message === "string" && e.message.startsWith("retrying")) {
      run.sawError = false;
    }
    // Notify-on-grant: a denial-shaped tool failure arms the bounded grant
    // watch (sandbox sessions only; skipped silently otherwise). Never
    // throws: watcher setup must not break the run.
    if (e.type === "tool_result" && !e.ok) {
      try {
        this.maybeStartNotifyWatch(session, e.output);
      } catch {
        // watcher setup must never break a run
      }
    }
    try {
      run.onEvent(e);
    } catch {
      // consumer disconnected mid-run: keep the run alive, drop this event.
    }
  }

  /** Release a run's buffered reasoning, if any. Never throws. */
  private flushThinking(run: ActiveRun): void {
    try {
      const rest = run.thinking.flush();
      if (rest) run.onEvent(rest);
    } catch {
      // consumer gone; the run still needs to resolve
    }
  }

  private finishRun(session: SessionState, opts: { aborted: boolean; timedOut: boolean }): void {
    const run = session.currentRun;
    if (!run) return;
    // The run settled: the grant watch has no live run to steer, so it
    // expires here (a later denial in the next generation re-arms it).
    this.stopNotifyWatch(session.sessionId);
    // Backstop: abort/timeout flushed explicitly before their status/error
    // events, so this is normally a no-op; it covers child-crash paths.
    this.flushThinking(run);
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
      // Already-exited child: stop (workspace preserved), never delete here.
      this.stopSandbox(session.sandboxName);
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
