import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

const cfg = loadConfig();
if (cfg.allowlist.length === 0) {
  console.warn("[bridge] WARNING: TELEGRAM_ALLOWLIST_IDS is empty — bot will ignore everyone (fail closed).");
}

const bot = createBot(cfg);
bot.start({
  onStart: (me) => console.log(`[bridge] polling as @${me.username} -> ${cfg.gatewayUrl}`),
});
