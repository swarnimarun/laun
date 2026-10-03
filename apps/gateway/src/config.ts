import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface GatewayConfig {
  port: number;
  gatewayToken: string;
  executorUrl: string;
  dataDir: string;
  /** Agent key minted by `cloudbear setup`; imported into the key store at boot. */
  bootstrapKey?: string;
  /** Directory holding the browser UI (apps/gateway/public). */
  publicDir: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? "").trim();
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env["GATEWAY_PORT"] ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GATEWAY_PORT must be 1-65535");
  const bootstrapKey = (env["CLOUDBEAR_KEY"] ?? "").trim();
  return {
    port,
    gatewayToken: required(env, "GATEWAY_TOKEN"),
    executorUrl: (env["EXECUTOR_URL"] ?? "http://localhost:8081").replace(/\/$/, ""),
    dataDir: env["DATA_DIR"] ?? "./data",
    bootstrapKey: bootstrapKey || undefined,
    publicDir: env["PUBLIC_DIR"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public"),
  };
}
