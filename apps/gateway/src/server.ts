import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  ApprovalDecision,
  CreateSessionRequest,
  SendMessageRequest,
  SessionRecord,
} from "@laun/protocol";
import { bearerToken, checkBearer, normalizeCreateSession } from "@laun/protocol";
import type { GatewayConfig } from "./config.js";
import {
  DEFAULT_AUTO_RESUME,
  DEFAULT_AUTO_RESUME_MAX_AGE_MS,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_SESSION_TOKENS,
  DEFAULT_STALL_MS,
  RESUME_PROMPT,
} from "./config.js";
import { streamExecutorRun, abortExecutorRun, executorKnowsAbort, steerExecutorRun, executorKnowsSteer, approveExecutorDecision } from "./executorClient.js";
import { AgentKeyStore } from "./keys.js";
import { SessionStore } from "./store.js";

const MAX_EVENTS_PER_SESSION = 2000;

interface SessionBus {
  events: AgentEvent[];
  subs: Set<(e: AgentEvent) => void>;
  pendingApprovals: Map<string, AgentEvent & { type: "approval_request" }>;
}

const safeFile = (id: string) => `events-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`;

/** Who is calling: an internal service, or a human/CLI/web client using an agent key. */
export type GatewayIdentity =
  | { kind: "service" }
  | { kind: "agent"; keyId: string; label: string };

export function createGateway(cfg: GatewayConfig, store?: SessionStore, keyStore?: AgentKeyStore) {
  const sessions = store ?? new SessionStore(cfg.dataDir);
  const keys = keyStore ?? new AgentKeyStore(cfg.dataDir);
  const buses = new Map<string, SessionBus>();
  const running = new Set<string>();
  /**
   * Single pending follow-up per session (set by sendMessage mode "queue",
   * consumed by runAgent's finally as one fresh run). Newer replaces older.
   * Cleared by a successful abort — abort cancels all intent.
   */
  const pendingQueue = new Map<string, string>();
  const maxConcurrentRuns = cfg.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const maxSessionTokens = cfg.maxSessionTokens ?? DEFAULT_MAX_SESSION_TOKENS;
  const autoResume = cfg.autoResume ?? DEFAULT_AUTO_RESUME;
  const autoResumeMaxAgeMs = cfg.autoResumeMaxAgeMs ?? DEFAULT_AUTO_RESUME_MAX_AGE_MS;
  const stallMs = cfg.stallMs ?? DEFAULT_STALL_MS;
  /** Last observed event per session (stall sweeper clock). */
  const lastEventAt = new Map<string, number>();
  /** Sessions with a budget-abort already in flight (reentrancy guard). */
  const budgetAborting = new Set<string>();

  // A key minted before the gateway started (setup writes it into .env).
  if (cfg.bootstrapKey) {
    try {
      const rec = keys.importKey(cfg.bootstrapKey);
      console.log(`[gateway] agent key ${rec.id} ready (${rec.label})`);
    } catch (e) {
      throw new Error(`LAUN_KEY invalid: ${(e as Error).message}`);
    }
  }

  const eventsFile = (id: string): string => join(cfg.dataDir, safeFile(id));

  /** Rebuild in-memory bus from the persisted JSONL log (survives restarts). */
  function replay(id: string): Pick<SessionBus, "events" | "pendingApprovals"> {
    const events: AgentEvent[] = [];
    try {
      if (!existsSync(eventsFile(id))) return { events, pendingApprovals: new Map() };
      const lines = readFileSync(eventsFile(id), "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(-MAX_EVENTS_PER_SESSION)) {
        try {
          const e = JSON.parse(line) as AgentEvent;
          if (e && typeof e === "object" && typeof e.type === "string") events.push(e);
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      return { events, pendingApprovals: new Map() };
    }
    const decided = new Set<string>();
    for (const e of events) {
      if (e.type === "status" && e.message) {
        const m = e.message.match(/^approval (\S+) (approve|deny)/);
        if (m) decided.add(m[1]);
      }
    }
    const pendingApprovals = new Map<string, AgentEvent & { type: "approval_request" }>();
    for (const e of events) {
      if (e.type === "approval_request" && !decided.has(e.requestId)) pendingApprovals.set(e.requestId, e);
    }
    return { events, pendingApprovals };
  }

  const busFor = (id: string): SessionBus => {
    let b = buses.get(id);
    if (!b) {
      const restored = replay(id);
      b = { events: restored.events, subs: new Set(), pendingApprovals: restored.pendingApprovals };
      buses.set(id, b);
    }
    return b;
  };

  function publish(sessionId: string, e: AgentEvent): void {
    const b = busFor(sessionId);
    b.events.push(e);
    lastEventAt.set(sessionId, Date.now());
    if (b.events.length > MAX_EVENTS_PER_SESSION) b.events.splice(0, b.events.length - MAX_EVENTS_PER_SESSION);
    try {
      appendFileSync(eventsFile(sessionId), JSON.stringify(e) + "\n");
    } catch (err) {
      console.error(`[gateway] failed to persist event for ${sessionId}: ${(err as Error).message}`);
    }
    if (e.type === "approval_request") {
      b.pendingApprovals.set(e.requestId, e);
      sessions.setStatus(sessionId, "waiting_approval");
    }
    // An error event is authoritative: never leave a failed run looking alive.
    if (e.type === "error") sessions.setStatus(sessionId, "error");
    if (e.type === "done") sessions.setStatus(sessionId, "done");
    enforceTokenBudget(sessionId);
    for (const sub of b.subs) {
      try {
        sub(e);
      } catch {
        // subscriber gone; cleaned up on SSE close
      }
    }
  }

  /** Counted tokens for a session from its `usage` events (bus = source of truth). */
  function sessionTokens(sessionId: string): number {
    let total = 0;
    for (const e of busFor(sessionId).events) {
      if (e.type !== "usage") continue;
      const u = e as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
      if (typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens > 0) {
        total += u.totalTokens;
      } else {
        for (const k of ["inputTokens", "outputTokens"] as const) {
          const v = u[k];
          if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
        }
      }
    }
    return Math.floor(total);
  }

  /**
   * Abort live runs that blew past MAX_SESSION_TOKENS. Checked on every
   * published event (usage arrives mid-run); reentrancy-guarded so the
   * abort's own events cannot retrigger it. No-op when disabled, idle, or
   * already aborting.
   */
  function enforceTokenBudget(sessionId: string): void {
    if (maxSessionTokens <= 0) return;
    if (!running.has(sessionId)) return;
    if (budgetAborting.has(sessionId)) return;
    if (sessionTokens(sessionId) <= maxSessionTokens) return;
    budgetAborting.add(sessionId);
    publish(sessionId, {
      type: "status",
      sessionId,
      status: "running",
      message: `token budget exceeded (${sessionTokens(sessionId)} > ${maxSessionTokens}) — aborting`,
    });
    void api
      .abort(sessionId, "token budget")
      .catch(() => {
        // Executor unreachable: the run is already doomed budget-wise; leave
        // the record for the operator instead of throwing inside publish.
      })
      .finally(() => budgetAborting.delete(sessionId));
  }

  function setStatus(sessionId: string, status: SessionRecord["status"]): void {
    const rec = sessions.setStatus(sessionId, status);
    if (rec) publish(sessionId, { type: "status", sessionId, status });
  }

  async function runAgent(
    sessionId: string,
    prompt: string,
    model: string,
    opts: { repo?: string; runtime?: SessionRecord["runtime"] } = {},
  ): Promise<void> {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    sessions.setStatus(sessionId, "running");
    publish(sessionId, { type: "status", sessionId, status: "running" });
    try {
      for await (const e of streamExecutorRun(cfg.executorUrl, cfg.gatewayToken, {
        sessionId,
        prompt,
        model,
        repo: opts.repo,
        runtime: opts.runtime,
      })) {
        publish(sessionId, e);
        if (e.type === "status" && (e.status === "done" || e.status === "error")) {
          sessions.setStatus(sessionId, e.status);
        }
      }
      const rec = sessions.get(sessionId);
      if (rec && rec.status === "running") setStatus(sessionId, "done");
    } catch (e) {
      publish(sessionId, { type: "error", sessionId, message: (e as Error).message });
      setStatus(sessionId, "error");
    } finally {
      running.delete(sessionId);
      // Drain one queued follow-up, if any, as a fresh run. Chained via
      // void (never awaited) so queue depth cannot grow the call stack;
      // each drain consumes exactly one slot.
      const next = pendingQueue.get(sessionId);
      if (next !== undefined) {
        pendingQueue.delete(sessionId);
        const rec = sessions.get(sessionId);
        if (rec) void runAgent(sessionId, next, rec.model, { repo: rec.repo, runtime: rec.runtime });
      }
    }
  }

  // Boot recovery: resume recently-interrupted runs instead of abandoning
  // them. pi resumes from its session files, so the continuation just needs
  // sending. Aged-out interruptions still go to error for human triage.
  for (const rec of sessions.list()) {
    if (rec.status === "running" || rec.status === "waiting_approval") {
      const ageMs = Date.now() - Date.parse(rec.updatedAt);
      if (autoResume && (autoResumeMaxAgeMs <= 0 || ageMs <= autoResumeMaxAgeMs)) {
        publish(rec.id, {
          type: "status",
          sessionId: rec.id,
          status: "running",
          message: "gateway restarted during run — resuming where it left off",
        });
        void runAgent(rec.id, RESUME_PROMPT, rec.model, { repo: rec.repo, runtime: rec.runtime });
      } else {
        sessions.setStatus(rec.id, "error");
        publish(rec.id, {
          type: "error",
          sessionId: rec.id,
          message: autoResume
            ? "gateway restarted during run — interruption too old to resume, send a new message to retry"
            : "gateway restarted during run — send a new message to retry",
        });
      }
    }
  }

  // Stall sweeper: a live run silent past the ceiling is aborted — but only
  // once the abort verifiably lands. An unreachable executor leaves the
  // record alone for the next sweep instead of stranding a live run's record.
  // Unref'd so tests and idle processes exit cleanly.
  if (stallMs > 0) {
    const sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const id of [...running]) {
        const last = lastEventAt.get(id) ?? now;
        if (now - last < stallMs) continue;
        void api
          .abort(id, "stall sweeper")
          .then((r) => {
            if (r === "ok") {
              publish(id, {
                type: "status",
                sessionId: id,
                status: "error",
                message: `run stalled (no events for ${Math.round(stallMs / 1000)}s) — aborted`,
              });
            }
          })
          .catch(() => {
            // Executor unreachable/refusing: leave the record for the next
            // sweep rather than marking a possibly-live run dead.
          });
      }
    }, Math.min(60_000, Math.max(1_000, stallMs)));
    (sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Reject new runs past MAX_CONCURRENT_RUNS (0 = unlimited). Checked
   * synchronously at both run entry points so the rejection surfaces
   * instead of silently queuing behind the executor.
   */
  function checkConcurrency(): void {
    if (maxConcurrentRuns > 0 && running.size >= maxConcurrentRuns) {
      throw Object.assign(new Error(`too many concurrent runs (${maxConcurrentRuns} max)`), { status: 429 });
    }
  }

  const api = {
    sessions,
    running,
    busFor,
    publish,
    keys,

    /** Service token (internal) or a valid agent key (humans, CLI, web UI). */
    authenticate(req: Request): GatewayIdentity | null {
      const token = bearerToken(req.headers.get("authorization"));
      if (!token) return null;
      if (checkBearer(`Bearer ${token}`, cfg.gatewayToken)) return { kind: "service" };
      const rec = keys.verify(token);
      return rec ? { kind: "agent", keyId: rec.id, label: rec.label } : null;
    },

    auth(req: Request): boolean {
      return this.authenticate(req) !== null;
    },

    createSession(input: CreateSessionRequest): SessionRecord {
      checkConcurrency();
      const norm = normalizeCreateSession(input);
      const rec = sessions.create({ goal: norm.goal, repo: norm.repo, model: norm.model, runtime: norm.runtime });
      busFor(rec.id);
      void runAgent(rec.id, norm.goal, norm.model, { repo: norm.repo, runtime: norm.runtime });
      return rec;
    },

    sendMessage(sessionId: string, input: SendMessageRequest): Promise<{ outcome: "started" | "steered" | "queued" }> {
      const rec = sessions.get(sessionId);
      if (!rec) throw Object.assign(new Error("session not found"), { status: 404 });
      const text = (input.text ?? "").trim();
      if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
      if (text.length > 8000) throw Object.assign(new Error("text too long (max 8000 chars)"), { status: 400 });
      const mode = (input as { mode?: unknown }).mode;
      if (mode !== undefined && mode !== "steer" && mode !== "queue") {
        throw Object.assign(new Error('mode must be "steer" or "queue"'), { status: 400 });
      }
      if (!running.has(sessionId)) {
        checkConcurrency();
        void runAgent(sessionId, text, rec.model, { repo: rec.repo, runtime: rec.runtime });
        return Promise.resolve({ outcome: "started" as const });
      }
      if (mode === "steer") return this.steerRunning(sessionId, text);
      if (mode === "queue") {
        const replaced = pendingQueue.has(sessionId);
        pendingQueue.set(sessionId, text);
        publish(sessionId, {
          type: "status",
          sessionId,
          status: "running",
          message: replaced ? "queued follow-up (replaces older)" : "queued follow-up",
        });
        return Promise.resolve({ outcome: "queued" as const });
      }
      throw Object.assign(new Error("session already running"), { status: 409 });
    },

    /**
     * Steer the live run via the executor. A 409/unknown-session answer
     * means desync (we thought busy, nothing live there): clear local state
     * and start the text as a fresh run rather than stranding the user the
     * way the old wedge did. A missing steer route is a 502 — explicit
     * steering must never silently degrade.
     */
    async steerRunning(sessionId: string, text: string): Promise<{ outcome: "started" | "steered" | "queued" }> {
      const result = await steerExecutorRun(cfg.executorUrl, cfg.gatewayToken, sessionId, text);
      if (result.status === 200) {
        publish(sessionId, {
          type: "status",
          sessionId,
          status: "running",
          message: `steered: ${text.slice(0, 200)}`,
        });
        return { outcome: "steered" as const };
      }
      if (executorKnowsSteer(result)) {
        running.delete(sessionId);
        const rec = sessions.get(sessionId);
        if (!rec) throw Object.assign(new Error("session not found"), { status: 404 });
        publish(sessionId, {
          type: "status",
          sessionId,
          status: "running",
          message: "executor had no live run; started fresh",
        });
        void runAgent(sessionId, text, rec.model);
        return { outcome: "started" as const };
      }
      throw Object.assign(
        new Error(
          result.status === 0
            ? "executor unreachable"
            : result.status === 404
              ? "this executor build has no steer endpoint — rebuild and redeploy it"
              : `executor refused steer (${result.status})`,
        ),
        { status: 502 },
      );
    },

    /** v1 semantics: records the human decision + broadcasts it. Hard enforcement lives in OpenShell policy. */
    decideApproval(sessionId: string, d: ApprovalDecision, decidedBy?: string): void {
      const b = busFor(sessionId);
      if (!b.pendingApprovals.has(d.requestId)) {
        throw Object.assign(new Error("approval request not found"), { status: 404 });
      }
      if (d.decision !== "approve" && d.decision !== "deny") {
        throw Object.assign(new Error("decision must be approve|deny"), { status: 400 });
      }
      b.pendingApprovals.delete(d.requestId);
      publish(sessionId, {
        type: "status",
        sessionId,
        status: b.pendingApprovals.size > 0 ? "waiting_approval" : "running",
        message: `approval ${d.requestId} ${d.decision}${decidedBy ? ` by ${decidedBy}` : ""}${d.note ? `: ${d.note}` : ""}`,
      });
      const rec = sessions.get(sessionId);
      if (rec && b.pendingApprovals.size === 0 && rec.status === "waiting_approval") {
        sessions.setStatus(sessionId, "running");
      }
      // Forward to a parked executor run (extension_ui gating). Best-effort:
      // the local record above is what the UI shows, so a settled run or a
      // dead executor only earns a note event, never a failed click.
      void approveExecutorDecision(cfg.executorUrl, cfg.gatewayToken, sessionId, d.requestId, d.decision).then(
        (r) => {
          if (r.status !== 200) {
            publish(sessionId, {
              type: "status",
              sessionId,
              status: "running",
              message:
                r.status === 0
                  ? `approval ${d.requestId} recorded; executor unreachable — run holds until timeout`
                  : `approval ${d.requestId} recorded; executor said ${r.status} — run holds until timeout`,
            });
          }
        },
        () => {
          // approveExecutorDecision never rejects (catches internally); guard anyway.
        },
      );
    },

    /**
     * Delete a session entirely: stop a live run first (best-effort — a
     * dead executor never blocks deletion), then drop the record, bus,
     * timers, pending queue entry, and the persisted JSONL log. The sandbox
     * itself ages out via the executor reaper. 404 unknown id.
     */
    async deleteSession(id: string, abortedBy?: string): Promise<void> {
      const rec = sessions.get(id);
      if (!rec) throw Object.assign(new Error("session not found"), { status: 404 });
      if (running.has(id)) {
        try {
          await api.abort(id, abortedBy ?? "session deleted");
        } catch {
          running.delete(id);
          pendingQueue.delete(id);
        }
      }
      running.delete(id);
      pendingQueue.delete(id);
      lastEventAt.delete(id);
      buses.delete(id);
      try {
        unlinkSync(eventsFile(id));
      } catch {
        // Already gone or never created; the record is the source of truth.
      }
      sessions.delete(id);
    },

    pendingApprovals(sessionId: string) {
      return [...busFor(sessionId).pendingApprovals.values()];
    },

    /**
     * Stop an active run. 404 unknown session; "not_running" when neither
     * side has anything live (the HTTP layer maps it to 409 so `stop` on an
     * idle session keeps its old message and exit code). The executor is
     * ALWAYS asked first: it owns the truth about live runs, and a
gateway/executor desync (record settled here, slot wedged there) once
     * made `stop` unreachable, because the old code threw 409 off the local
     * `running` set without ever poking the executor.
     *
     * Preserved semantics: `stop` on a stale-but-gone run still succeeds
     * (the run is gone either way), and an unreachable executor while we
     * believed running is still a 502 that leaves state untouched.
     */
    async abort(sessionId: string, abortedBy?: string): Promise<"ok" | "not_running"> {
      const rec = sessions.get(sessionId);
      if (!rec) throw Object.assign(new Error("session not found"), { status: 404 });
      const believedRunning = running.has(sessionId);

      const result = await abortExecutorRun(cfg.executorUrl, cfg.gatewayToken, sessionId);
      if (result.status === 200) {
        publish(sessionId, {
          type: "status",
          sessionId,
          status: "error",
          message: `aborted${abortedBy ? ` by ${abortedBy}` : ""}`,
        });
        running.delete(sessionId);
        pendingQueue.delete(sessionId);
        return "ok";
      }
      if (executorKnowsAbort(result)) {
        // The executor confirms no live run (409 not-running, or 404 unknown
        // session on a build that has the route). Clear local state either way.
        running.delete(sessionId);
        pendingQueue.delete(sessionId);
        return believedRunning ? "ok" : "not_running";
      }
      if (!believedRunning) {
        // Executor unreachable, refusing, or without an abort route, while we
        // believed idle: answer from local state (the same 409 as before),
        // since there is nothing to kill that we know of.
        running.delete(sessionId);
        return "not_running";
      }
      // 0 = unreachable, 5xx = refused, 404 with a route-shaped body = this
      // executor build has no abort endpoint at all. None of them stopped the
      // run, so none of them may be reported as success.
      throw Object.assign(
        new Error(
          result.status === 0
            ? "executor unreachable"
            : result.status === 404
              ? "this executor build has no abort endpoint — rebuild and redeploy it"
              : `executor refused abort (${result.status})`,
        ),
        { status: 502 },
      );
    },

    log(sessionId: string, since: number): { events: AgentEvent[]; next: number } {
      const b = busFor(sessionId);
      const from = Number.isInteger(since) && since >= 0 ? since : 0;
      return { events: b.events.slice(from), next: b.events.length };
    },
  };
  return api;
}

export type Gateway = ReturnType<typeof createGateway>;
