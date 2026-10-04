import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgentKey } from "@laun/protocol";

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
 * instead of writing to the operator's real ~/.laun.
 */
export function homeFor(env: NodeJS.ProcessEnv = process.env): string {
  return env["HOME"] ?? homedir();
}

export function authFilePath(home: string = homedir()): string {
  return join(home, ".laun", "auth.json");
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
 * sandboxes stay deterministic. A named target wins over both: `--target`
 * is explicit, so it selects a saved host even when the env is set.
 */
export function resolveTarget(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homeFor(env),
  name?: string,
): Target | null {
  if (name) return loadNamedTarget(name, home);
  const key = (env["LAUN_KEY"] ?? "").trim();
  const host = (env["LAUN_HOST"] ?? "").trim();
  if (key && host) {
    return {
      host,
      port: Number(env["LAUN_PORT"] ?? 8080),
      scheme: env["LAUN_SCHEME"] === "https" ? "https" : "http",
      key,
      keyId: parseAgentKey(key)?.id,
    };
  }
  return loadTarget(home);
}

/**
 * Named targets: extra saved hosts under `~/.laun/targets/<name>.json`,
 * each file holding the same Target shape as the default auth file (0600 in
 * a 0700 dir, atomic tmp+rename write). The default file is untouched, so
 * behaviour without `--target` is exactly what it always was.
 */
const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidTargetName(name: string): boolean {
  return TARGET_NAME_RE.test(name);
}

export function targetsDir(home: string = homedir()): string {
  return join(home, ".laun", "targets");
}

export function targetFilePath(home: string, name: string): string {
  // Names become file paths, so reject anything that is not a safe slug —
  // in particular `..` and `/`, which would escape the targets dir.
  if (!isValidTargetName(name)) throw new Error(`invalid target name "${name}" (use letters, numbers, - and _)`);
  return join(targetsDir(home), `${name}.json`);
}

/** Writes the named target file 0600. Returns the path. */
export function saveNamedTarget(name: string, target: Target, home: string = homedir()): string {
  const file = targetFilePath(home, name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(target, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

export function loadNamedTarget(name: string, home: string = homedir()): Target | null {
  let raw: Partial<Target>;
  try {
    raw = JSON.parse(readFileSync(targetFilePath(home, name), "utf8"));
  } catch {
    return null;
  }
  if (!raw.host || !raw.key) return null;
  return {
    host: raw.host,
    port: Number(raw.port ?? 8080),
    scheme: raw.scheme === "https" ? "https" : "http",
    key: raw.key,
    keyId: raw.keyId,
  };
}

/** All valid saved targets, sorted by name. Corrupt files are skipped. */
export function listNamedTargets(home: string = homedir()): Array<{ name: string; target: Target }> {
  let files: string[];
  try {
    files = readdirSync(targetsDir(home)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Array<{ name: string; target: Target }> = [];
  for (const file of files) {
    const name = file.slice(0, -".json".length);
    if (!isValidTargetName(name)) continue;
    const target = loadNamedTarget(name, home);
    if (target) out.push({ name, target });
  }
  return out;
}