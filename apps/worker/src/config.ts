import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import type { PiRuntimeOptions } from "@laun/runtime";

export interface WorkerConfig {
  controllerUrl: string;
  workerKey: string;
  dataDir: string;
  capacity: number;
  pollMs: number;
  heartbeatMs: number;
  runtime: PiRuntimeOptions;
}

export function controllerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("LAUN_CONTROLLER_URL must be a URL"); }
  if (url.username || url.password || url.hash || url.search || (url.pathname !== "/" && url.pathname !== "")) throw new Error("controller URL must have no credentials, path, query or fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("remote controller requires HTTPS; use a loopback SSH tunnel for local HTTP");
  return url.origin;
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const result = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be ${min}-${max}`);
  return result;
}
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const endpoint = controllerUrl(env.LAUN_CONTROLLER_URL ?? "http://127.0.0.1:8080");
  const key = env.LAUN_WORKER_KEY ?? "";
  if (!/^yard_[0-9a-f-]{36}_[A-Za-z0-9_-]{20,128}$/.test(key)) throw new Error("LAUN_WORKER_KEY must be the enrolled yard credential");
  const trustedLocal = flag(env, "LAUN_TRUSTED_LOCAL");
  const openshellEnabled = flag(env, "OPENSHELL_ENABLED");
  if (!trustedLocal && !openshellEnabled) throw new Error("choose OpenShell isolation or explicitly set LAUN_TRUSTED_LOCAL=true for development");
  const image = env.OPENSHELL_SANDBOX_IMAGE ?? "";
  if (openshellEnabled && !image) throw new Error("OPENSHELL_SANDBOX_IMAGE is required when isolation is enabled");
  return {
    controllerUrl: endpoint, workerKey: key, dataDir: resolve(env.LAUN_WORKER_DIR ?? "./data/worker"),
    capacity: number(env, "LAUN_WORKER_CAPACITY", 1, 1, 16), pollMs: number(env, "LAUN_WORKER_POLL_MS", 1000, 100, 30_000),
    heartbeatMs: number(env, "LAUN_WORKER_HEARTBEAT_MS", 1000, 100, 5000),
    runtime: { trustedLocal, openshellEnabled, enableFaux: flag(env, "LAUN_DEMO"), authFile: env.PI_AUTH_FILE ?? join(homedir(), ".pi", "agent", "auth.json"),
      openshell: openshellEnabled ? { image, bin: env.OPENSHELL_BIN, policyFile: env.OPENSHELL_V2_POLICY } : undefined,
      maxTurns: number(env, "LAUN_MAX_TURNS", 32, 1, 256), timeoutMs: number(env, "RUN_TIMEOUT_MS", 600_000, 1000, 86_400_000) },
  };
}
