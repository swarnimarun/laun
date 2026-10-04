import { parseAllowlist } from "@laun/protocol";

export interface BridgeConfig {
  /** May be empty: an empty token means "disabled", handled in index.ts. */
  botToken: string;
  allowlist: string[];
  gatewayUrl: string;
  gatewayToken: string;
  defaultModel: string;
  pollMs: number;
}

/** Documented placeholder from deploy/.env.example: never a real login. */
export const TELEGRAM_PLACEHOLDER_TOKEN = "123456:ABC-your-bot-token-from-BotFather";

/** Single line logged when the bridge starts disabled. Keep stable. */
export const BRIDGE_DISABLED_MESSAGE = "telegram bridge disabled: set TELEGRAM_BOT_TOKEN to enable";

/** Unset, blank, or the documented placeholder all mean "not configured". */
export function isTelegramTokenDisabled(token: string | undefined | null): boolean {
  const t = (token ?? "").trim();
  return t === "" || t === TELEGRAM_PLACEHOLDER_TOKEN;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? "").trim();
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const pollMs = Number(env["BRIDGE_POLL_MS"] ?? 2000);
  if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 30_000) {
    throw new Error("BRIDGE_POLL_MS must be 500-30000");
  }
  return {
    // Optional on purpose: a missing token is a clean disabled exit (see
    // index.ts), not a throw — otherwise the stack crash-loops on a fresh box.
    botToken: (env["TELEGRAM_BOT_TOKEN"] ?? "").trim(),
    allowlist: parseAllowlist(env["TELEGRAM_ALLOWLIST_IDS"]),
    gatewayUrl: (env["GATEWAY_URL"] ?? "http://localhost:8080").replace(/\/$/, ""),
    gatewayToken: required(env, "GATEWAY_TOKEN"),
    defaultModel: env["MODEL"] ?? "opencode-go/muse-spark-1.3-contributor",
    pollMs,
  };
}
