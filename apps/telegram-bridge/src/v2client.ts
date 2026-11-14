import type {
  TelegramDelivery,
  TelegramInboundUpdate,
  TelegramIngestResult,
  TelegramDeliveryAuthorization,
} from "@laun/protocol";

export class V2GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export function telegramControllerUrl(
  value: string,
  allowInsecureNetwork = false,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "invalid bridge controller URL; use credential-free HTTPS or local HTTP",
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(
      "invalid bridge controller URL; credentials, query and fragments are not allowed",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) &&
    allowInsecureNetwork !== true
  )
    throw new Error(
      "remote bridge controllers require HTTPS; BRIDGE_ALLOW_INSECURE_NETWORK=true is an explicit trusted-network exception",
    );
  return url.href.replace(/\/$/, "");
}
export class V2GatewayClient {
  constructor(
    private base: string,
    private token: string,
    readonly botId: string,
    private fetcher: typeof fetch = fetch,
    options: { allowInsecureNetwork?: boolean } = {},
  ) {
    this.base = telegramControllerUrl(base, options.allowInsecureNetwork);
  }
  private async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref();
    try {
      const response = await this.fetcher(
        `${this.base}/api/v2/connectors/telegram/${path}`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
        },
      );
      const reader = response.body?.getReader();
      let raw = "";
      let size = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      if (reader)
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > 262_144)
              throw new Error("bridge response exceeds 256 KiB");
            raw += decoder.decode(item.value, { stream: true });
          }
          raw += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      const value = JSON.parse(raw || "{}");
      if (!response.ok)
        throw new V2GatewayError(
          String(value.error ?? `controller HTTP ${response.status}`)
            .split(this.token)
            .join("[REDACTED]"),
          response.status,
        );
      return value as T;
    } finally {
      clearTimeout(timer);
    }
  }
  ingest(update: TelegramInboundUpdate): Promise<TelegramIngestResult> {
    return this.request("ingest", update);
  }
  poll(): Promise<{ deliveries: TelegramDelivery[] }> {
    return this.request("poll", { botId: this.botId, limit: 4 });
  }
  verify(delivery: TelegramDelivery): Promise<TelegramDeliveryAuthorization> {
    return this.request("verify", {
      botId: this.botId,
      id: delivery.id,
      leaseId: delivery.leaseId,
    });
  }
  ack(
    delivery: TelegramDelivery,
    result: {
      status: "delivered" | "retry" | "uncertain" | "failed";
      messageId?: string;
      retryAfterMs?: number;
    },
  ): Promise<{ acknowledged: boolean }> {
    return this.request("ack", {
      botId: this.botId,
      id: delivery.id,
      leaseId: delivery.leaseId,
      ...result,
    });
  }
}
