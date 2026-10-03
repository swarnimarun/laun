export interface GatewayConfig {
  port: number;
  gatewayToken: string;
  executorUrl: string;
  dataDir: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? "").trim();
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env["GATEWAY_PORT"] ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GATEWAY_PORT must be 1-65535");
  return {
    port,
    gatewayToken: required(env, "GATEWAY_TOKEN"),
    executorUrl: (env["EXECUTOR_URL"] ?? "http://localhost:8081").replace(/\/$/, ""),
    dataDir: env["DATA_DIR"] ?? "./data",
  };
}
