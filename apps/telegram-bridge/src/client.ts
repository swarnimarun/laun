import type { AgentEvent, SessionRecord } from "@laun/protocol";

export class GatewayClient {
  constructor(
    private base: string,
    private token: string,
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`gateway ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async createSession(goal: string, model: string): Promise<SessionRecord> {
    const res = await this.req("/sessions", { method: "POST", body: JSON.stringify({ goal, model, runtime: "pi" }) });
    return (await res.json()) as SessionRecord;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.req(`/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  }

  async decideApproval(sessionId: string, requestId: string, decision: "approve" | "deny"): Promise<void> {
    await this.req(`/sessions/${sessionId}/approvals`, {
      method: "POST",
      body: JSON.stringify({ requestId, decision }),
    });
  }

  async getSession(sessionId: string): Promise<{ session: SessionRecord; pendingApprovals: unknown[] }> {
    const res = await this.req(`/sessions/${sessionId}`);
    return (await res.json()) as { session: SessionRecord; pendingApprovals: unknown[] };
  }

  async getLog(sessionId: string, since: number): Promise<{ events: AgentEvent[]; next: number }> {
    const res = await this.req(`/sessions/${sessionId}/log?since=${since}`);
    return (await res.json()) as { events: AgentEvent[]; next: number };
  }
}
