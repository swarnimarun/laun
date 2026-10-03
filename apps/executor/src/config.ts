export interface ExecutorConfig {
  port: number;
  /** Shared secret the gateway must present. Never log. */
  gatewayToken: string;
  /** Base dir for all sessions. Every workdir stays under here. */
  sessionDir: string;
  piBin: string;
  defaultModel: string;
  openshellEnabled: boolean;
  /** argv prefix prepended before the pi command, e.g. ["openshell","exec","--sandbox","agent"]. */
  openshellPrefix: string[];
  defaultTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] ?? "").trim();
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const gatewayToken = required(env, "GATEWAY_TOKEN");
  const openshellEnabled = (env["OPENSHELL_ENABLED"] ?? "false").toLowerCase() === "true";
  const prefixRaw = (env["OPENSHELL_PREFIX"] ?? "").trim();
  const openshellPrefix = prefixRaw ? prefixRaw.split(/\s+/) : [];
  if (openshellEnabled && openshellPrefix.length === 0) {
    throw new Error(
      "OPENSHELL_ENABLED=true but OPENSHELL_PREFIX is empty — set it to your openshell exec prefix (fail closed).",
    );
  }
  const port = Number(env["EXECUTOR_PORT"] ?? 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EXECUTOR_PORT must be 1-65535");
  const defaultTimeoutMs = Number(env["RUN_TIMEOUT_MS"] ?? 600_000);
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 30_000) {
    throw new Error("RUN_TIMEOUT_MS must be >= 30000");
  }
  return {
    port,
    gatewayToken,
    sessionDir: env["SESSION_DIR"] ?? "./data/sessions",
    piBin: env["PI_BIN"] ?? "pi",
    defaultModel: env["MODEL"] ?? "x-ai/grok-4.6",
    openshellEnabled,
    openshellPrefix,
    defaultTimeoutMs,
  };
}
