import { DEFAULT_RECOVERY_ATTEMPTS, DEFAULT_RECOVERY_BACKOFF_MS, MAX_RECOVERY_ATTEMPTS, MAX_RECOVERY_BACKOFF_MS } from "./recovery.js";

export type ExecutorMode = "json" | "rpc";

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
  /** json = one-shot `pi -p --mode json` per run (fallback). rpc = one long-lived `pi --mode rpc` child per session. Defaults to json. */
  executorMode?: ExecutorMode;
  /** Idle TTL for rpc children before they are reaped. Restart reuses the same session dir. Defaults to 300_000. */
  rpcIdleTtlMs?: number;
  /**
   * Max recovery retries after the initial run (total runs <= 1 + this).
   * 0 disables recovery entirely. Defaults to 2.
   */
  recoveryAttempts?: number;
  /** Backoff between recovery attempts. Defaults to 2000. */
  recoveryBackoffMs?: number;
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
  const modeRaw = (env["EXECUTOR_MODE"] ?? "json").trim().toLowerCase();
  if (modeRaw !== "json" && modeRaw !== "rpc") {
    throw new Error('EXECUTOR_MODE must be "json" or "rpc"');
  }
  const rpcIdleTtlMs = Number(env["RPC_IDLE_TTL_MS"] ?? 300_000);
  if (!Number.isFinite(rpcIdleTtlMs) || rpcIdleTtlMs < 100) {
    throw new Error("RPC_IDLE_TTL_MS must be >= 100");
  }
  const recoveryAttemptsRaw = (env["RUN_RECOVERY_ATTEMPTS"] ?? "").trim();
  const recoveryAttempts = recoveryAttemptsRaw === "" ? DEFAULT_RECOVERY_ATTEMPTS : Number(recoveryAttemptsRaw);
  if (!Number.isInteger(recoveryAttempts) || recoveryAttempts < 0 || recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
    throw new Error(`RUN_RECOVERY_ATTEMPTS must be an integer 0-${MAX_RECOVERY_ATTEMPTS}`);
  }
  const recoveryBackoffRaw = (env["RUN_RECOVERY_BACKOFF_MS"] ?? "").trim();
  const recoveryBackoffMs = recoveryBackoffRaw === "" ? DEFAULT_RECOVERY_BACKOFF_MS : Number(recoveryBackoffRaw);
  if (!Number.isFinite(recoveryBackoffMs) || recoveryBackoffMs < 0 || recoveryBackoffMs > MAX_RECOVERY_BACKOFF_MS) {
    throw new Error(`RUN_RECOVERY_BACKOFF_MS must be 0-${MAX_RECOVERY_BACKOFF_MS}`);
  }
  return {
    port,
    gatewayToken,
    sessionDir: env["SESSION_DIR"] ?? "./data/sessions",
    piBin: env["PI_BIN"] ?? "pi",
    defaultModel: env["MODEL"] ?? "opencode-go/muse-spark-1.3-contributor",
    openshellEnabled,
    openshellPrefix,
    defaultTimeoutMs,
    executorMode: modeRaw as ExecutorMode,
    rpcIdleTtlMs,
    recoveryAttempts,
    recoveryBackoffMs: Math.floor(recoveryBackoffMs),
  };
}
