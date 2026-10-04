import type { AgentEvent, SessionRecord } from "@cloudbear/protocol";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface PendingApproval {
  type: "approval_request";
  sessionId: string;
  requestId: string;
  reason: string;
  detail?: string;
}

/** Minimal typed client for the cloudbear gateway. */
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
      throw new GatewayError(`cannot reach ${this.base}: ${(e as Error).message}`, 0);
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

  sendMessage(id: string, text: string): Promise<{ accepted: boolean; sessionId: string }> {
    return this.request(`/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
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