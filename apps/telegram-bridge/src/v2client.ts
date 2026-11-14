import type { TelegramDelivery, TelegramInboundUpdate, TelegramIngestResult } from "@laun/protocol";

export class V2GatewayError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export class V2GatewayClient {
  constructor(private base: string, private token: string, readonly botId: string, private fetcher: typeof fetch = fetch) {
    const url = new URL(base);
    if (url.username || url.password || url.hash || url.search || !["http:", "https:"].includes(url.protocol)) throw new Error("invalid bridge gateway URL");
    this.base = url.href.replace(/\/$/, "");
  }
  private async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000); timer.unref();
    try {
      const response = await this.fetcher(`${this.base}/api/v2/connectors/telegram/${path}`, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` }, body: JSON.stringify(body) });
      const reader = response.body?.getReader(); let raw = ""; let size = 0; const decoder = new TextDecoder("utf-8", { fatal: true });
      if (reader) try {
        for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 262_144) throw new Error("bridge response exceeds 256 KiB"); raw += decoder.decode(item.value, { stream: true }); }
        raw += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(raw || "{}");
      if (!response.ok) throw new V2GatewayError(String(value.error ?? `controller HTTP ${response.status}`).split(this.token).join("[REDACTED]"), response.status);
      return value as T;
    } finally { clearTimeout(timer); }
  }
  ingest(update: TelegramInboundUpdate): Promise<TelegramIngestResult> { return this.request("ingest", update); }
  poll(): Promise<{ deliveries: TelegramDelivery[] }> { return this.request("poll", { botId: this.botId, limit: 4 }); }
  ack(delivery: TelegramDelivery, result: { status: "delivered" | "retry" | "uncertain" | "failed"; messageId?: string; retryAfterMs?: number }): Promise<{ acknowledged: boolean }> {
    return this.request("ack", { botId: this.botId, id: delivery.id, leaseId: delivery.leaseId, ...result });
  }
}
