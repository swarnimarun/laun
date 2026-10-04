import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
export const DEFAULT_MAX_SESSION_TOKENS = 0;
export const DEFAULT_AUTO_RESUME = true;
export const DEFAULT_AUTO_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STALL_MS = 45 * 60 * 1000;
/** Prompt a resumed run continues with — mirrors the operator runbook. */
export const RESUME_PROMPT =
  "Continue where you left off. Do not redo completed work; write files incrementally so partial progress survives another interruption.";

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
  /**
   * Resume interrupted runs after a restart (default on). A restarted
   * gateway no longer abandons in-flight work: pi resumes from its session
   * files, so the continuation just needs sending. Aged-out interruptions
   * (older than the max age) still go to error for a human to triage.
   * Optional — defaults to DEFAULT_AUTO_RESUME.
   */
  autoResume?: boolean;
  /**
   * Max age of an interruption that still auto-resumes (0 = no limit).
   * Optional — defaults to DEFAULT_AUTO_RESUME_MAX_AGE_MS.
   */
  autoResumeMaxAgeMs?: number;
  /**
   * Silence ceiling per running session (0 = no sweeper). A live run that
   * emits nothing for this long is aborted as stalled — but only once the
   * abort verifiably lands; an unreachable executor leaves the record
   * alone for the next sweep. Optional — defaults to DEFAULT_STALL_MS.
   */
  stallMs?: number;
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
  const autoResumeRaw = (env["AUTO_RESUME"] ?? "").trim().toLowerCase();
  if (autoResumeRaw !== "" && autoResumeRaw !== "true" && autoResumeRaw !== "false") {
    throw new Error('AUTO_RESUME must be "true" or "false"');
  }
  const autoResume = autoResumeRaw === "" ? DEFAULT_AUTO_RESUME : autoResumeRaw === "true";
  const autoResumeMaxAgeMs = Number(env["AUTO_RESUME_MAX_AGE_MS"] ?? DEFAULT_AUTO_RESUME_MAX_AGE_MS);
  if (!Number.isFinite(autoResumeMaxAgeMs) || autoResumeMaxAgeMs < 0) {
    throw new Error("AUTO_RESUME_MAX_AGE_MS must be >= 0 (0 = no limit)");
  }
  const stallMs = Number(env["RUN_STALL_MS"] ?? DEFAULT_STALL_MS);
  if (!Number.isFinite(stallMs) || stallMs < 0) {
    throw new Error("RUN_STALL_MS must be >= 0 (0 = no sweeper)");
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
    autoResume,
    autoResumeMaxAgeMs,
    stallMs,
  };
}
