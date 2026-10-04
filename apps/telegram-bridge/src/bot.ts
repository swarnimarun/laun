import { Bot, InlineKeyboard } from "grammy";
import { isAllowlisted } from "@laun/protocol";
import type { BridgeConfig } from "./config.js";
import { GatewayClient } from "./client.js";
import { decodeApproval, encodeApproval, renderChunks, sessionLine } from "./format.js";

const HELP = [
  "🧸 laun — your VPS agent",
  "",
  "/new <goal> — start a session (e.g. /new fix failing tests in web/)",
  "/status <id> — session status + pending approvals",
  "/log <id> [n] — last n session events (default 10)",
  "/approve <id> <requestId> — approve (or tap buttons)",
  "/deny <id> <requestId> — deny",
  "",
  "Plain text starts a session, or follows up on your latest active one.",
].join("\n");

/** chatId -> latest sessionId for follow-ups. */
const active = new Map<number, string>();

export function createBot(cfg: BridgeConfig, client?: GatewayClient): Bot {
  const gw = client ?? new GatewayClient(cfg.gatewayUrl, cfg.gatewayToken);
  const bot = new Bot(cfg.botToken);

  // Fail-closed allowlist: unknown users get silence.
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined || !isAllowlisted(uid, cfg.allowlist)) return;
    await next();
  });

  bot.command("start", (ctx) => ctx.reply(HELP));
  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.command("new", async (ctx) => {
    const goal = ctx.match.trim();
    if (!goal) return ctx.reply("usage: /new <goal>");
    await startSession(ctx as never, gw, cfg, ctx.chat.id, goal);
  });

  bot.command("status", async (ctx) => {
    const id = ctx.match.trim();
    if (!id) return ctx.reply("usage: /status <sessionId>");
    try {
      const { session, pendingApprovals } = await gw.getSession(id);
      await ctx.reply(sessionLine(session) + `\npending approvals: ${pendingApprovals.length}`);
    } catch (e) {
      await ctx.reply(`lookup failed: ${(e as Error).message}`);
    }
  });

  for (const decision of ["approve", "deny"] as const) {
    bot.command(decision, async (ctx) => {
      const [id, requestId] = ctx.match.trim().split(/\s+/, 2);
      if (!id || !requestId) return ctx.reply(`usage: /${decision} <sessionId> <requestId>`);
      await decide(ctx as never, gw, id, requestId, decision);
    });
  }

  // NOTE: command handlers must stay above the message:text handler below —
  // grammy runs middleware in order and the text handler does not call next().
  bot.command("log", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const id = parts[0] ?? "";
    if (!id) return ctx.reply("usage: /log <sessionId> [n]");
    let n = 10;
    if (parts[1] !== undefined) {
      n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 1) return ctx.reply("usage: /log <sessionId> [n]");
    }
    // Bound the reply: enough history to be useful, never a flood.
    const count = Math.min(n, 50);
    const capped = n > count;
    try {
      const log = await gw.getLog(id, 0);
      const chunks = renderChunks(log.events.slice(-count));
      if (chunks.length === 0) return ctx.reply(`no recent events for session ${id}`);
      if (capped) await ctx.reply(`(showing last ${count} of ${n} requested)`);
      for (const c of chunks) await ctx.reply(c);
    } catch (e) {
      await ctx.reply(`lookup failed: ${(e as Error).message}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;
    const last = active.get(ctx.chat.id);
    if (last) {
      try {
        const { session } = await gw.getSession(last);
        if (session.status === "running" || session.status === "waiting_approval" || session.status === "pending") {
          try {
            await gw.sendMessage(last, text);
            await ctx.reply(`↗️ sent to session ${last}`);
          } catch (e) {
            const st = (e as { status?: number }).status;
            if (st === 409) {
              // Gateway has no steer/queue yet, so the message was NOT queued.
              // Say what is running and where to follow it; queueing is coming.
              await ctx.reply(
                `⏳ session ${last} is busy (${session.status}) — still working, so that message was not sent.\n` +
                  `Catch up with /status ${last} or /log ${last}, then resend once it settles.\n` +
                  `Queued follow-ups are coming; for now, please try again shortly.`,
              );
            } else {
              await ctx.reply(`send failed: ${(e as Error).message}`);
            }
          }
          return;
        }
      } catch {
        // fall through to new session
      }
    }
    await startSession(ctx as never, gw, cfg, ctx.chat.id, text);
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = decodeApproval(ctx.callbackQuery.data);
    if (!parsed) return ctx.answerCallbackQuery({ text: "unknown button" });
    await decide(ctx as never, gw, parsed.sessionId, parsed.requestId, parsed.decision);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.answerCallbackQuery({ text: parsed.decision }).catch(() => {});
  });

  return bot;
}

async function decide(
  ctx: { reply: (t: string) => Promise<unknown> },
  gw: GatewayClient,
  sessionId: string,
  requestId: string,
  decision: "approve" | "deny",
): Promise<void> {
  try {
    await gw.decideApproval(sessionId, requestId, decision);
    await ctx.reply(`${decision === "approve" ? "✅ approved" : "⛔ denied"} ${requestId} (session ${sessionId})`);
  } catch (e) {
    await ctx.reply(`decision failed: ${(e as Error).message}`);
  }
}

async function startSession(
  ctx: { reply: (t: string, extra?: never) => Promise<{ message_id: number } | unknown> },
  gw: GatewayClient,
  cfg: BridgeConfig,
  chatId: number,
  goal: string,
): Promise<void> {
  let session;
  try {
    session = await gw.createSession(goal, cfg.defaultModel);
  } catch (e) {
    await ctx.reply(`could not start session: ${(e as Error).message}`);
    return;
  }
  active.set(chatId, session.id);
  await ctx.reply(`🚀 started session ${session.id}\n${goal.slice(0, 500)}`);
  void pollSession(ctx as never, gw, cfg, session.id);
}

const MAX_POLLS = Math.ceil((30 * 60 * 1000) / 2000); // ~30 min ceiling regardless of pollMs

async function pollSession(
  ctx: { reply: (t: string, extra?: { reply_markup?: unknown }) => Promise<unknown> },
  gw: GatewayClient,
  cfg: BridgeConfig,
  sessionId: string,
): Promise<void> {
  let since = 0;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    let log;
    try {
      log = await gw.getLog(sessionId, since);
    } catch {
      continue; // gateway hiccup; keep polling
    }
    since = log.next;
    const fresh = log.events.filter((e) => e.type !== "status");
    const chunks = renderChunks(fresh);
    const approvals = log.events.filter((e) => e.type === "approval_request");
    for (const c of chunks) {
      await ctx.reply(c).catch(() => {});
    }
    for (const a of approvals) {
      if (a.type !== "approval_request") continue;
      const kb = new InlineKeyboard()
        .text("✅ Approve", encodeApproval(sessionId, a.requestId, "approve"))
        .text("⛔ Deny", encodeApproval(sessionId, a.requestId, "deny"));
      await ctx.reply(`🛑 ${a.reason}`, { reply_markup: kb }).catch(() => {});
    }
    const terminal = log.events.find((e) => e.type === "done" || e.type === "error");
    if (terminal) return;
    // Also stop if session record says done/error and no new events for a while.
    try {
      const { session } = await gw.getSession(sessionId);
      if ((session.status === "done" || session.status === "error") && fresh.length === 0) {
        // one last drain
        const drain = await gw.getLog(sessionId, since).catch(() => null);
        if (drain) {
          for (const c of renderChunks(drain.events.filter((e) => e.type !== "status"))) {
            await ctx.reply(c).catch(() => {});
          }
        }
        return;
      }
    } catch {
      // ignore, keep polling
    }
  }
  await ctx.reply(`⏱️ stopped watching ${sessionId} after 30m — /status ${sessionId} to check`).catch(() => {});
}
