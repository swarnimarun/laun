import { parseAllowlist } from "@laun/protocol";
import { resolve } from "node:path";
import { telegramControllerUrl } from "./v2client.js";

export interface BridgeConfig {
  /** May be empty: an empty token means "disabled", handled in index.ts. */
  botToken: string;
  allowlist: string[];
  gatewayUrl: string;
  gatewayToken: string;
  defaultModel: string;
  pollMs: number;
  controlV2?: boolean;
  bridgeToken?: string;
  dataDir?: string;
  inboxKey?: string;
  allowInsecureNetwork?: boolean;
}

/** Documented placeholder from deploy/.env.example: never a real login. */
export const TELEGRAM_PLACEHOLDER_TOKEN =
  "123456:ABC-your-bot-token-from-BotFather";

/** Single line logged when the bridge starts disabled. Keep stable. */
export const BRIDGE_DISABLED_MESSAGE =
  "telegram bridge disabled: set TELEGRAM_BOT_TOKEN to enable";

/** Unset, blank, or the documented placeholder all mean "not configured". */
export function isTelegramTokenDisabled(
  token: string | undefined | null,
): boolean {
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
  const v2 = env.LAUN_CONTROL_V2 ?? "false";
  if (v2 !== "true" && v2 !== "false")
    throw new Error("LAUN_CONTROL_V2 must be true or false");
  const insecure = env.BRIDGE_ALLOW_INSECURE_NETWORK ?? "false";
  if (v2 === "true" && insecure !== "true" && insecure !== "false")
    throw new Error("BRIDGE_ALLOW_INSECURE_NETWORK must be true or false");
  const gatewayUrl = (env.GATEWAY_URL ?? "http://localhost:8080").replace(
    /\/$/,
    "",
  );
  if (v2 === "true") telegramControllerUrl(gatewayUrl, insecure === "true");
  const inboxKey = env.BRIDGE_INBOX_KEY?.trim() || undefined;
  const bridgeToken = env.LAUN_TELEGRAM_BRIDGE_TOKEN?.trim() || undefined;
  if (inboxKey !== undefined && inboxKey.length < 32)
    throw new Error("BRIDGE_INBOX_KEY must have at least 32 characters");
  return {
    // Optional on purpose: a missing token is a clean disabled exit (see
    // index.ts), not a throw — otherwise the stack crash-loops on a fresh box.
    botToken: (env["TELEGRAM_BOT_TOKEN"] ?? "").trim(),
    allowlist: parseAllowlist(env["TELEGRAM_ALLOWLIST_IDS"]),
    gatewayUrl,
    gatewayToken:
      env.GATEWAY_TOKEN?.trim() ||
      (v2 === "true" && bridgeToken
        ? bridgeToken
        : required(env, "GATEWAY_TOKEN")),
    defaultModel: env["MODEL"] ?? "opencode-go/muse-spark-1.3-contributor",
    pollMs,
    controlV2: v2 === "true",
    bridgeToken,
    dataDir: resolve(env.BRIDGE_DATA_DIR?.trim() || "./data/telegram"),
    inboxKey,
    allowInsecureNetwork: v2 === "true" && insecure === "true",
  };
}
