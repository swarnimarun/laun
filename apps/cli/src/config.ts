import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgentKey } from "@cloudbear/protocol";

/** A resolved gateway target: where to connect and which key to present. */
export interface Target {
  host: string;
  port: number;
  scheme: "http" | "https";
  key: string;
  keyId?: string;
}

/**
 * Which home directory this run should use. Reading it from the env passed in
 * (not a bare homedir()) is what lets tests point the CLI at a temp directory
 * instead of writing to the operator's real ~/.cloudbear.
 */
export function homeFor(env: NodeJS.ProcessEnv = process.env): string {
  return env["HOME"] ?? homedir();
}

export function authFilePath(home: string = homedir()): string {
  return join(home, ".cloudbear", "auth.json");
}

export function loadTarget(home: string = homedir()): Target | null {
  try {
    const raw = JSON.parse(readFileSync(authFilePath(home), "utf8")) as Partial<Target>;
    if (!raw.host || !raw.key) return null;
    return {
      host: raw.host,
      port: Number(raw.port ?? 8080),
      scheme: raw.scheme === "https" ? "https" : "http",
      key: raw.key,
      keyId: raw.keyId,
    };
  } catch {
    return null;
  }
}

/** Writes the auth file 0600 inside a 0700 directory. Returns the path. */
export function saveTarget(target: Target, home: string = homedir()): string {
  const file = authFilePath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(target, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

export function targetUrl(t: Pick<Target, "host" | "port" | "scheme">): string {
  const host = t.host.includes(":") && !t.host.startsWith("[") ? `[${t.host}]` : t.host;
  return `${t.scheme}://${host}:${t.port}`;
}

/**
 * Env overrides win over the saved file, so CI and one-off runs never need to
 * write credentials to disk. The auth file honours $HOME so tests and
 * sandboxes stay deterministic.
 */
export function resolveTarget(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homeFor(env),
): Target | null {
  const key = (env["CLOUDBEAR_KEY"] ?? "").trim();
  const host = (env["CLOUDBEAR_HOST"] ?? "").trim();
  if (key && host) {
    return {
      host,
      port: Number(env["CLOUDBEAR_PORT"] ?? 8080),
      scheme: env["CLOUDBEAR_SCHEME"] === "https" ? "https" : "http",
      key,
      keyId: parseAgentKey(key)?.id,
    };
  }
  return loadTarget(home);
}