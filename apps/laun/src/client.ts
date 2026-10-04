import type { AgentEvent, SessionRecord } from "@laun/protocol";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Turn a refused connection into advice. When the target is not loopback this
 * is almost always a firewalled port — cloud providers block 8080 by default
 * and the gateway listens there — so say that instead of leaving the operator
 * to rediscover it. Loopback means the local services are simply not running.
 */
export function connectionHint(base: string, cause: string): string {
  const msg = `cannot reach ${base}: ${cause}`;
  let host: string | null = null;
  try {
    host = new URL(base).hostname;
  } catch {
    host = null;
  }
  if (!host) return msg;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (loopback) {
    return `${msg}\n  Are the services running? (bun run dev:executor / dev:gateway)`;
  }
  return [
    msg,
    `  The gateway's port is likely firewalled — providers block 8080 by default.`,
    `  Open a tunnel and point the CLI at it:`,
    `    ssh -N -L 18080:localhost:8080 user@${host}`,
    `    laun agent auth --host 127.0.0.1 --port 18080 --key <laun_...>`,
  ].join("\n");
}

export interface PendingApproval {
  type: "approval_request";
  sessionId: string;
  requestId: string;
  reason: string;
  detail?: string;
}

/** Minimal typed client for the laun gateway. */
export class GatewayClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  get origin(): string {
    return this.base;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (e) {
      throw new GatewayError(connectionHint(this.base, (e as Error).message), 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch {
        // keep the raw body
      }
      if (res.status === 401) throw new GatewayError("unauthorized — the agent key is wrong or revoked", 401);
      if (res.status === 409) throw new GatewayError(detail || "session is busy", 409);
      throw new GatewayError(`${res.status}: ${detail || res.statusText}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  health(): Promise<{ ok: boolean; service: string; executor: string }> {
    return this.request("/health");
  }

  listSessions(): Promise<{ sessions: SessionRecord[] }> {
    return this.request("/sessions");
  }

  createSession(goal: string, model?: string): Promise<SessionRecord> {
    return this.request("/sessions", {
      method: "POST",
      body: JSON.stringify(model ? { goal, model } : { goal }),
    });
  }

  getSession(id: string): Promise<{ session: SessionRecord; pendingApprovals: PendingApproval[] }> {
    return this.request(`/sessions/${id}`);
  }

  log(id: string, since: number): Promise<{ sessionId: string; events: AgentEvent[]; next: number }> {
    return this.request(`/sessions/${id}/log?since=${since}`);
  }

  sendMessage(id: string, text: string, mode?: "steer" | "queue"): Promise<{ accepted: boolean; sessionId: string; outcome?: string }> {
    return this.request(`/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify(mode ? { text, mode } : { text }),
    });
  }

  decideApproval(id: string, requestId: string, decision: "approve" | "deny", note?: string): Promise<{ ok: boolean }> {
    return this.request(`/sessions/${id}/approvals`, {
      method: "POST",
      body: JSON.stringify(note ? { requestId, decision, note } : { requestId, decision }),
    });
  }

  /**
   * Ask the gateway to stop a running session. 200 {ok:true} on success,
   * 404 for an unknown session, 409 when the session is not running.
   * (Integrator-owned route: POST /sessions/:id/abort.)
   */
  abortSession(id: string): Promise<{ ok: boolean }> {
    return this.request(`/sessions/${id}/abort`, { method: "POST" });
  }

  createKey(label?: string): Promise<{ key: string; record: { id: string; label: string; createdAt: string } }> {
    return this.request("/keys", { method: "POST", body: JSON.stringify(label ? { label } : {}) });
  }

  listKeys(): Promise<{ keys: Array<{ id: string; label: string; createdAt: string }> }> {
    return this.request("/keys");
  }

  revokeKey(id: string): Promise<{ ok: boolean }> {
    return this.request(`/keys/${id}`, { method: "DELETE" });
  }
}