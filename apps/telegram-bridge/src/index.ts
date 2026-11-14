import { BRIDGE_DISABLED_MESSAGE, isTelegramTokenDisabled, loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { v2DeliveryFor } from "./v2bot.js";

// Disabled-by-default: no token (or the documented placeholder) is a clean
// exit 0 before any login attempt, so the stack stays all-healthy.
if (isTelegramTokenDisabled(process.env["TELEGRAM_BOT_TOKEN"])) {
  console.log(BRIDGE_DISABLED_MESSAGE);
  process.exit(0);
}

const cfg = loadConfig();
if (cfg.allowlist.length === 0) {
  console.warn("[bridge] WARNING: TELEGRAM_ALLOWLIST_IDS is empty — bot will ignore everyone (fail closed).");
}

const bot = createBot(cfg);
void bot.start({
  onStart: (me) => { console.log(`[bridge] polling as @${me.username} -> ${cfg.gatewayUrl}`); v2DeliveryFor(bot)?.start(); },
}).catch(async (error) => {
  let detail = (error as Error).message;
  for (const secret of [cfg.botToken, cfg.gatewayToken, cfg.bridgeToken, cfg.inboxKey]) if (secret) detail = detail.split(secret).join("[REDACTED]");
  console.error(`[bridge] polling stopped: ${detail}`); process.exitCode = 1; await v2DeliveryFor(bot)?.stop();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void (async () => { try { await bot.stop(); } finally { await v2DeliveryFor(bot)?.stop(); } })().catch(() => console.error("[bridge] shutdown did not finish cleanly"));
});
