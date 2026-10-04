import { DEFAULT_RECOVERY_ATTEMPTS, DEFAULT_RECOVERY_BACKOFF_MS, MAX_RECOVERY_ATTEMPTS, MAX_RECOVERY_BACKOFF_MS } from "./recovery.js";
import { DEFAULT_SANDBOX_MAX_IDLE_MS } from "./sandbox.js";

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
  /** openshell CLI binary. Defaults to "openshell". */
  openshellBin?: string;
  /**
   * Sandbox image for `sandbox create --from` (e.g. "pi-agent:local").
   * Required when sandbox mode is enabled (fail closed); empty disables nothing.
   */
  sandboxImage?: string;
  /** Policy YAML path for `sandbox create --policy`. Empty omits the flag. */
  sandboxPolicyFile?: string;
  /** Providers, each passed as a repeatable `sandbox create --provider` flag. */
  sandboxProviders?: string[];
  /** Approval mode for `sandbox create --approval-mode`. Empty omits the flag. */
  sandboxApprovalMode?: string;
  /**
   * OpenShell gateway URL for SDK transport (streaming rpc). Empty disables
   * the SDK: rpc falls back to the CLI runner. Requires OPENSHELL_ENABLED.
   */
  sdkGateway?: string;
  /** OIDC bearer for SDK auth. Empty omits it. Never log. */
  sdkToken?: string;
  /** PEM file paths for SDK mTLS to the gateway (must pair up). */
  sdkClientCertFile?: string;
  sdkClientKeyFile?: string;
  /** PEM file path for a custom SDK CA. Empty uses system roots. */
  sdkCaFile?: string;
  /** Skip TLS verification for the SDK. Dev/debug only. */
  sdkInsecure?: boolean;
  /**
   * Idle age after which a stopped sandbox is deleted by the age reaper.
   * Defaults to 7d. There is no gateway session-delete API: time-based
   * delete is the only delete (besides create-failure cleanup).
   */
  sandboxMaxIdleMs?: number;
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
  // Per-session sandbox wiring (lane-sandbox): enabled requires an image,
  // never silently unsandboxed. OPENSHELL_PREFIX stays required for compat.
  const sandboxImage = (env["OPENSHELL_SANDBOX_IMAGE"] ?? "").trim();
  if (openshellEnabled && !sandboxImage) {
    throw new Error("OPENSHELL_ENABLED=true but OPENSHELL_SANDBOX_IMAGE is empty — set it to the sandbox image (fail closed).");
  }
  const sandboxPolicyFile = (env["OPENSHELL_POLICY"] ?? "").trim();
  const sandboxProviders = (env["OPENSHELL_PROVIDER"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sandboxApprovalMode = (env["OPENSHELL_APPROVAL_MODE"] ?? "").trim();
  if (sandboxApprovalMode !== "" && sandboxApprovalMode !== "manual" && sandboxApprovalMode !== "auto") {
    throw new Error('OPENSHELL_APPROVAL_MODE must be "manual" or "auto"');
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
  // SDK transport selection: rpc uses the SDK only when a gateway endpoint
  // is configured (fail closed on bad URLs and on SDK-without-sandbox-mode).
  const sdkGateway = (env["OPENSHELL_SDK_GATEWAY"] ?? "").trim();
  if (sdkGateway) {
    let protocol: string;
    try {
      protocol = new URL(sdkGateway).protocol;
    } catch {
      throw new Error("OPENSHELL_SDK_GATEWAY must be a valid URL");
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error("OPENSHELL_SDK_GATEWAY must be an http(s) URL");
    }
    if (!openshellEnabled) {
      throw new Error("OPENSHELL_SDK_GATEWAY is set but OPENSHELL_ENABLED is not true (fail closed).");
    }
  }
  const sdkToken = (env["OPENSHELL_SDK_TOKEN"] ?? "").trim();
  const sdkClientCertFile = (env["OPENSHELL_SDK_CLIENT_CERT_FILE"] ?? "").trim();
  const sdkClientKeyFile = (env["OPENSHELL_SDK_CLIENT_KEY_FILE"] ?? "").trim();
  if (!!sdkClientCertFile !== !!sdkClientKeyFile) {
    throw new Error("OPENSHELL_SDK_CLIENT_CERT_FILE and OPENSHELL_SDK_CLIENT_KEY_FILE must be set together");
  }
  const sdkCaFile = (env["OPENSHELL_SDK_CA_FILE"] ?? "").trim();
  const sdkInsecure = (env["OPENSHELL_SDK_INSECURE"] ?? "false").toLowerCase() === "true";
  const sandboxMaxIdleMsRaw = (env["OPENSHELL_SANDBOX_MAX_IDLE_MS"] ?? "").trim();
  const sandboxMaxIdleMs = sandboxMaxIdleMsRaw === "" ? DEFAULT_SANDBOX_MAX_IDLE_MS : Number(sandboxMaxIdleMsRaw);
  if (!Number.isFinite(sandboxMaxIdleMs) || sandboxMaxIdleMs < 1000) {
    throw new Error("OPENSHELL_SANDBOX_MAX_IDLE_MS must be >= 1000");
  }
  return {
    port,
    gatewayToken,
    sessionDir: env["SESSION_DIR"] ?? "./data/sessions",
    piBin: env["PI_BIN"] ?? "pi",
    defaultModel: env["MODEL"] ?? "opencode-go/muse-spark-1.3-contributor",
    openshellEnabled,
    openshellPrefix,
    openshellBin: env["OPENSHELL_BIN"] ?? "openshell",
    sandboxImage,
    sandboxPolicyFile,
    sandboxProviders,
    sandboxApprovalMode,
    defaultTimeoutMs,
    executorMode: modeRaw as ExecutorMode,
    rpcIdleTtlMs,
    recoveryAttempts,
    recoveryBackoffMs: Math.floor(recoveryBackoffMs),
    sdkGateway,
    sdkToken,
    sdkClientCertFile,
    sdkClientKeyFile,
    sdkCaFile,
    sdkInsecure,
    sandboxMaxIdleMs,
  };
}
