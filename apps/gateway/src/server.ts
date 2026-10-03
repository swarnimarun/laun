import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  ApprovalDecision,
  CreateSessionRequest,
  SendMessageRequest,
  SessionRecord,
} from "@cloudbear/protocol";
import { checkBearer, normalizeCreateSession } from "@cloudbear/protocol";
import type { GatewayConfig } from "./config.js";
import { streamExecutorRun } from "./executorClient.js";
import { SessionStore } from "./store.js";

const MAX_EVENTS_PER_SESSION = 2000;

interface SessionBus {
  events: AgentEvent[];
  subs: Set<(e: AgentEvent) => void>;
  pendingApprovals: Map<string, AgentEvent & { type: "approval_request" }>;
}

const safeFile = (id: string) => `events-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`;

export function createGateway(cfg: GatewayConfig, store?: SessionStore) {
  const sessions = store ?? new SessionStore(cfg.dataDir);
  const buses = new Map<string, SessionBus>();
  const running = new Set<string>();

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

    auth(req: Request): boolean {
      return checkBearer(req.headers.get("authorization"), cfg.gatewayToken);
    },

    createSession(input: CreateSessionRequest): SessionRecord {
      const norm = normalizeCreateSession(input);
      const rec = sessions.create({ goal: norm.goal, repo: norm.repo, model: norm.model, runtime: norm.runtime });
      busFor(rec.id);
      void runAgent(rec.id, norm.goal, norm.model);
      return rec;
    },

    sendMessage(sessionId: string, input: SendMessageRequest): void {
      const rec = sessions.get(sessionId);
      if (!rec) throw Object.assign(new Error("session not found"), { status: 404 });
      const text = (input.text ?? "").trim();
      if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
      if (text.length > 8000) throw Object.assign(new Error("text too long (max 8000 chars)"), { status: 400 });
      if (running.has(sessionId)) throw Object.assign(new Error("session already running"), { status: 409 });
      void runAgent(sessionId, text, rec.model);
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

    log(sessionId: string, since: number): { events: AgentEvent[]; next: number } {
      const b = busFor(sessionId);
      const from = Number.isInteger(since) && since >= 0 ? since : 0;
      return { events: b.events.slice(from), next: b.events.length };
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
