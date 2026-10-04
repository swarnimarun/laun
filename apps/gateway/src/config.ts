import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
export const DEFAULT_MAX_SESSION_TOKENS = 0;

export interface GatewayConfig {
  port: number;
  gatewayToken: string;
  executorUrl: string;
  dataDir: string;
  /** Agent key minted by `laun setup`; imported into the key store at boot. */
  bootstrapKey?: string;
  /** Directory holding the browser UI (apps/gateway/public). */
  publicDir: string;
  /**
   * Max simultaneously running sessions (0 = unlimited). New runs past the
   * ceiling are rejected with 429 instead of piling onto the executor.
   * Optional — defaults to DEFAULT_MAX_CONCURRENT_RUNS.
   */
  maxConcurrentRuns?: number;
  /**
   * Max counted tokens per session (0 = unlimited). Counted from `usage`
   * events (totalTokens, else input+output); breaching aborts the run.
   * Optional — defaults to DEFAULT_MAX_SESSION_TOKENS.
   */
  maxSessionTokens?: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? "").trim();
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env["GATEWAY_PORT"] ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GATEWAY_PORT must be 1-65535");
  const bootstrapKey = (env["LAUN_KEY"] ?? "").trim();
  const maxConcurrentRuns = Number(env["MAX_CONCURRENT_RUNS"] ?? DEFAULT_MAX_CONCURRENT_RUNS);
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 0) {
    throw new Error("MAX_CONCURRENT_RUNS must be an integer >= 0 (0 = unlimited)");
  }
  const maxSessionTokens = Number(env["MAX_SESSION_TOKENS"] ?? DEFAULT_MAX_SESSION_TOKENS);
  if (!Number.isInteger(maxSessionTokens) || maxSessionTokens < 0) {
    throw new Error("MAX_SESSION_TOKENS must be an integer >= 0 (0 = unlimited)");
  }
  return {
    port,
    gatewayToken: required(env, "GATEWAY_TOKEN"),
    executorUrl: (env["EXECUTOR_URL"] ?? "http://localhost:8081").replace(/\/$/, ""),
    dataDir: env["DATA_DIR"] ?? "./data",
    bootstrapKey: bootstrapKey || undefined,
    publicDir: env["PUBLIC_DIR"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public"),
    maxConcurrentRuns,
    maxSessionTokens,
  };
}
