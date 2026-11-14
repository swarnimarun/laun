import { Bot } from "grammy";
import { isAllowlisted } from "@laun/protocol";
import type { BridgeConfig } from "./config.js";
import { V2Delivery } from "./v2delivery.js";

const deliveries = new WeakMap<Bot, V2Delivery>();
export const v2DeliveryFor = (bot: Bot): V2Delivery | undefined => deliveries.get(bot);

export function createV2Bot(cfg: BridgeConfig): Bot {
  const bot = new Bot(cfg.botToken);
  const delivery = new V2Delivery(cfg, bot.api, { log: (line) => console.error(`[bridge] ${line}`) });
  deliveries.set(bot, delivery);
  bot.use(async (ctx, next) => { if (ctx.from?.id !== undefined && isAllowlisted(ctx.from.id, cfg.allowlist)) await next(); });
  bot.on("message:text", (ctx) => {
    delivery.accept({ botId: String(ctx.me.id), updateId: ctx.update.update_id, userId: String(ctx.from.id), chatId: String(ctx.chat.id),
      ...(ctx.message.message_thread_id ? { topicId: String(ctx.message.message_thread_id) } : {}), text: ctx.message.text });
  });
  bot.on("callback_query:data", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    if (!msg || !ctx.from) return ctx.answerCallbackQuery({ text: "This message is unavailable; inspect the request in the web app." });
    const topic = "message_thread_id" in msg ? msg.message_thread_id : undefined;
    delivery.accept({ botId: String(ctx.me.id), updateId: ctx.update.update_id, userId: String(ctx.from.id), chatId: String(msg.chat.id),
      ...(topic ? { topicId: String(topic) } : {}), callbackData: ctx.callbackQuery.data });
    await ctx.answerCallbackQuery({ text: "Decision queued for server verification." }).catch(() => {});
  });
  bot.catch(async (error) => {
    let value = error.error instanceof Error ? error.error.message : "Telegram update handler failed";
    for (const secret of [cfg.botToken, cfg.gatewayToken, cfg.bridgeToken]) if (secret) value = value.split(secret).join("[REDACTED]");
    console.error(`[bridge] ${value}`);
    // An admission/storage failure must stop polling rather than silently
    // advancing Telegram's offset past an update we could not persist.
    try { await bot.stop(); } catch { /* polling may already be stopped */ } finally { await delivery.stop(); }
  });
  return bot;
}
