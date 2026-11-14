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
  inferenceMode:"controller"|"local";
  minFreeDiskBytes:number;
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
  const inferenceMode=env.LAUN_INFERENCE_MODE??"controller";
  if(inferenceMode!=="controller"&&inferenceMode!=="local")throw new Error("LAUN_INFERENCE_MODE must be controller or local");
  if(inferenceMode==="local"&&!env.PI_AUTH_FILE&&!flag(env,"LAUN_DEMO"))throw new Error("local inference requires explicit operator-provisioned PI_AUTH_FILE");
  const cpuLimit=Number(env.OPENSHELL_CPU_LIMIT??2),memoryMiB=number(env,"OPENSHELL_MEMORY_MIB",1024,64,65536);
  if(!Number.isFinite(cpuLimit)||cpuLimit<0.1||cpuLimit>64||Math.abs(Math.round(cpuLimit*1000)-cpuLimit*1000)>4*Number.EPSILON*Math.max(1,Math.abs(cpuLimit*1000)))throw new Error("OPENSHELL_CPU_LIMIT must be 0.1-64 CPUs with millicpu precision");
  return {
    controllerUrl: endpoint, workerKey: key, inferenceMode,minFreeDiskBytes:number(env,"LAUN_MIN_FREE_DISK_MIB",512,0,1_048_576)*1024*1024, dataDir: resolve(env.LAUN_WORKER_DIR ?? "./data/worker"),
    capacity: number(env, "LAUN_WORKER_CAPACITY", 1, 1, 16), pollMs: number(env, "LAUN_WORKER_POLL_MS", 1000, 100, 30_000),
    heartbeatMs: number(env, "LAUN_WORKER_HEARTBEAT_MS", 1000, 100, 5000),
    runtime: { trustedLocal, openshellEnabled,cleanupRoot:resolve(env.LAUN_WORKER_DIR??"./data/worker"), enableFaux: flag(env, "LAUN_DEMO"), authFile: env.PI_AUTH_FILE ?? join(homedir(), ".pi", "agent", "auth.json"),
      openshell: openshellEnabled ? { image, bin: env.OPENSHELL_BIN, policyFile: env.OPENSHELL_V2_POLICY,cpuLimit,memoryMiB } : undefined,
      maxTurns: number(env, "LAUN_MAX_TURNS", 32, 1, 256), timeoutMs: number(env, "RUN_TIMEOUT_MS", 600_000, 1000, 86_400_000) },
  };
}
