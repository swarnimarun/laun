import { controllerUrl } from "./config.js";

export class WorkerHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export class WorkerTransportError extends Error {}

export class WorkerClient {
  private endpoint: string;
  constructor(endpoint: string, private key: string, private fetcher: typeof fetch = fetch) { this.endpoint = controllerUrl(endpoint); }
  async request<T>(method: string, body: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    timer.unref();
    const signals = [controller.signal, ...(options.signal ? [options.signal] : [])];
    const signal = AbortSignal.any(signals);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.endpoint}/api/v2/worker/${method}`, { method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` }, body: JSON.stringify(body) });
      } catch {
        if (options.signal?.aborted) throw new WorkerHttpError("worker request cancelled", 499);
        throw new WorkerTransportError("controller transport failed or timed out; execution stopped pending reconciliation");
      }
      if (!response.body) throw new WorkerTransportError("controller returned no response body");
      const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = ""; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > 2_097_152) throw new WorkerTransportError("controller response exceeds 2 MiB");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new WorkerTransportError("controller returned invalid JSON"); }
      if (!response.ok) {
        const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `controller HTTP ${response.status}`;
        throw new WorkerHttpError(message.split(this.key).join("[REDACTED]"), response.status);
      }
      return value as T;
    } catch (error) {
      if (error instanceof WorkerHttpError || error instanceof WorkerTransportError) throw error;
      if (options.signal?.aborted) throw new WorkerHttpError("worker request cancelled", 499);
      throw new WorkerTransportError("controller response interrupted; outcome requires reconciliation");
    } finally { clearTimeout(timer); }
  }
}
