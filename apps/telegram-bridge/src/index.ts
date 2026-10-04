import { BRIDGE_DISABLED_MESSAGE, isTelegramTokenDisabled, loadConfig } from "./config.js";
import { createBot } from "./bot.js";

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
bot.start({
  onStart: (me) => console.log(`[bridge] polling as @${me.username} -> ${cfg.gatewayUrl}`),
});
