import { join, resolve } from "node:path";
import type { TelegramDelivery, TelegramInboundUpdate } from "@laun/protocol";
import type { BridgeConfig } from "./config.js";
import { TelegramInbox } from "./v2inbox.js";
import { V2GatewayClient, V2GatewayError } from "./v2client.js";

export interface TelegramSender {
  sendMessage(
    chatId: string,
    text: string,
    options: {
      message_thread_id?: number;
      reply_markup?: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      link_preview_options: { is_disabled: true };
    },
  ): Promise<{ message_id: number }>;
}
export class V2Delivery {
  private inbox: TelegramInbox;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: Promise<void> | undefined;
  private chatLastSent = new Map<string, number>();
  private client: V2GatewayClient;
  constructor(
    private cfg: BridgeConfig,
    private sender: TelegramSender,
    private options: {
      client?: V2GatewayClient;
      minChatIntervalMs?: number;
      log?: (text: string) => void;
    } = {},
  ) {
    const token = cfg.bridgeToken ?? cfg.gatewayToken;
    const botId = cfg.botToken.split(":")[0]!;
    if (!/^\d{1,20}$/.test(botId))
      throw new Error("invalid numeric Telegram bot identity");
    this.client =
      options.client ??
      new V2GatewayClient(cfg.gatewayUrl, token, botId, undefined, {
        allowInsecureNetwork: cfg.allowInsecureNetwork === true,
      });
    this.inbox = new TelegramInbox(
      join(resolve(cfg.dataDir ?? "./data/telegram"), "inbox.sqlite"),
      cfg.inboxKey ?? `${cfg.botToken}\0${token}`,
    );
  }
  private log(error: unknown) {
    let value = error instanceof Error ? error.message : String(error);
    for (const secret of [
      this.cfg.botToken,
      this.cfg.gatewayToken,
      this.cfg.bridgeToken,
      this.cfg.inboxKey,
    ])
      if (secret) value = value.split(secret).join("[REDACTED]");
    this.options.log?.(value);
  }
  accept(update: TelegramInboundUpdate): void {
    if (this.closed) throw new Error("Telegram bridge admission is closed");
    this.inbox.enqueue(update);
    void this.pump().catch((error) => this.log(error));
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pump().catch((error) => this.log(error));
    }, this.cfg.pollMs);
    this.timer.unref();
    void this.pump().catch((error) => this.log(error));
  }
  async pump(): Promise<void> {
    if (this.closed) return;
    if (this.current) return this.current;
    this.current = this.work().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }
  private async work(): Promise<void> {
    for (const update of this.inbox.pending()) {
      try {
        await this.client.ingest(update);
        this.inbox.accepted(update);
      } catch (error) {
        if (
          error instanceof V2GatewayError &&
          [400, 403, 404, 409].includes(error.status)
        ) {
          this.inbox.rejected(update);
          this.log(
            `Telegram update ${update.updateId} rejected by server (${error.status}); retained encrypted for operator inspection`,
          );
          continue;
        }
        throw error;
      }
    }
    if (this.closed) return;
    const result = await this.client.poll();
    if (!Array.isArray(result.deliveries) || result.deliveries.length > 8)
      throw new Error("invalid controller outbox batch");
    for (const delivery of result.deliveries) {
      if (this.closed) return;
      await this.deliver(delivery);
    }
  }
  private async deliver(delivery: TelegramDelivery): Promise<void> {
    if (this.closed) return;
    if (
      !/^-?\d{1,20}$/.test(delivery.chatId) ||
      typeof delivery.text !== "string" ||
      delivery.text.length > 3500 ||
      !delivery.id ||
      !delivery.leaseId
    )
      throw new Error("invalid Telegram delivery envelope");
    const topic =
      delivery.topicId === undefined ? undefined : Number(delivery.topicId);
    if (topic !== undefined && (!Number.isSafeInteger(topic) || topic < 1))
      throw new Error("invalid Telegram delivery topic");
    if (
      delivery.buttons &&
      (delivery.buttons.length > 2 ||
        delivery.buttons.some(
          (button) =>
            !/^laun:[ad]:[A-Za-z0-9_-]{22}$/.test(button.callbackData),
        ))
    )
      throw new Error("invalid Telegram permission keyboard");
    const pause =
      (this.chatLastSent.get(delivery.chatId) ?? 0) +
      (this.options.minChatIntervalMs ?? 1100) -
      Date.now();
    if (pause > 0) await Bun.sleep(pause);
    if (this.closed) return;
    // Recheck after throttling, immediately before the external send. A
    // claimed envelope is no longer authority after unlink/revocation.
    try {
      const check = await this.client.verify(delivery);
      if (check.authorized !== true)
        throw new Error("Telegram send was not authorized");
    } catch (error) {
      this.log(error);
      return;
    }
    if (this.closed) return;
    this.chatLastSent.set(delivery.chatId, Date.now());
    try {
      const sent = await this.sender.sendMessage(
        delivery.chatId,
        delivery.text,
        {
          ...(topic !== undefined ? { message_thread_id: topic } : {}),
          ...(delivery.buttons
            ? {
                reply_markup: {
                  inline_keyboard: [
                    delivery.buttons.map((button) => ({
                      text: button.text,
                      callback_data: button.callbackData,
                    })),
                  ],
                },
              }
            : {}),
          link_preview_options: { is_disabled: true },
        },
      );
      // Retrying the receipt is safe; sending the Telegram message again is not.
      let ackError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.client.ack(delivery, {
            status: "delivered",
            messageId: String(sent.message_id),
          });
          return;
        } catch (error) {
          ackError = error;
          if (error instanceof V2GatewayError && error.status < 500) break;
          if (attempt < 2) await Bun.sleep(100);
        }
      }
      throw ackError;
    } catch (error) {
      const apiError = error as {
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (apiError.error_code === 429) {
        const delay = Number(apiError.parameters?.retry_after ?? 1);
        await this.client.ack(delivery, {
          status: "retry",
          retryAfterMs: Number.isFinite(delay)
            ? Math.min(3_600_000, Math.max(1000, Math.ceil(delay * 1000)))
            : 1000,
        });
      } else if (apiError.error_code === 400 || apiError.error_code === 403) {
        await this.client.ack(delivery, { status: "failed" });
      } else {
        // Includes an ambiguous send or lost delivery acknowledgement. The
        // server keeps this visible; it never automatically resends it.
        await this.client
          .ack(delivery, { status: "uncertain" })
          .catch(() => {});
        this.log(error);
      }
    }
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.current;
    } catch (error) {
      // A pending controller failure must not escape shutdown as an
      // unredacted asynchronous rejection from the top-level poller.
      this.log(error);
    } finally {
      this.inbox.close();
    }
  }
}
