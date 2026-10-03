import { parseAllowlist } from "@cloudbear/protocol";

export interface BridgeConfig {
  botToken: string;
  allowlist: string[];
  gatewayUrl: string;
  gatewayToken: string;
  defaultModel: string;
  pollMs: number;
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
    botToken: required(env, "TELEGRAM_BOT_TOKEN"),
    allowlist: parseAllowlist(env["TELEGRAM_ALLOWLIST_IDS"]),
    gatewayUrl: (env["GATEWAY_URL"] ?? "http://localhost:8080").replace(/\/$/, ""),
    gatewayToken: required(env, "GATEWAY_TOKEN"),
    defaultModel: env["MODEL"] ?? "opencode-go/muse-spark-1.3-contributor",
    pollMs,
  };
}
