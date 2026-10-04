import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
import { streamExecutorRun, abortExecutorRun, executorKnowsAbort, steerExecutorRun, executorKnowsSteer } from "./executorClient.js";
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
    for (const sub of b.subs) {
      try {
        sub(e);
      } catch {
        // subscriber gone; cleaned up on SSE close
      }
    }
  }

  function setStatus(sessionId: string, status: SessionRecord["status"]): void {
    const rec = sessions.setStatus(sessionId, status);
    if (rec) publish(sessionId, { type: "status", sessionId, status });
  }

  async function runAgent(sessionId: string, prompt: string, model: string): Promise<void> {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    sessions.setStatus(sessionId, "running");
    publish(sessionId, { type: "status", sessionId, status: "running" });
    try {
      for await (const e of streamExecutorRun(cfg.executorUrl, cfg.gatewayToken, { sessionId, prompt, model })) {
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
        if (rec) void runAgent(sessionId, next, rec.model);
      }
    }
  }

  // Boot recovery: runs interrupted by a restart must not stay "running" forever.
  for (const rec of sessions.list()) {
    if (rec.status === "running" || rec.status === "waiting_approval") {
      sessions.setStatus(rec.id, "error");
      publish(rec.id, {
        type: "error",
        sessionId: rec.id,
        message: "gateway restarted during run — send a new message to retry",
      });
    }
  }

  return {
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
      const norm = normalizeCreateSession(input);
      const rec = sessions.create({ goal: norm.goal, repo: norm.repo, model: norm.model, runtime: norm.runtime });
      busFor(rec.id);
      void runAgent(rec.id, norm.goal, norm.model);
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
        void runAgent(sessionId, text, rec.model);
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
}

export type Gateway = ReturnType<typeof createGateway>;
