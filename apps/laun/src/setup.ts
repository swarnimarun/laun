import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAgentKey } from "@laun/protocol";
import { UsageError } from "./args.js";
import { bunRunner, runRemoteSetup, type CommandRunner } from "./ssh.js";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomAgentKey(): string {
  return formatAgentKey(randomBytes(4).toString("hex"), randomBytes(32).toString("base64url"));
}

/** Values placeholders in deploy/.env.example must be treated as unset. */
function isPlaceholder(value: string): boolean {
  return value === "" || /^change-me/i.test(value) || /^<.*>$/.test(value);
}

/**
 * Set each key only when it is missing or still a placeholder. An existing
 * secret is never overwritten: re-running setup must not invalidate the key
 * that is already saved in a client's auth file.
 */
export function upsertEnv(content: string, updates: Record<string, string>): string {
  const out: string[] = [];
  const handled = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const name = m[1]!;
    const current = m[2]!.trim();
    if (name in updates) {
      handled.add(name);
      if (isPlaceholder(current)) {
        out.push(`${name}=${updates[name]}`);
        continue;
      }
    }
    out.push(line);
  }
  const missing = Object.entries(updates).filter(([k]) => !handled.has(k));
  if (missing.length > 0) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push("");
    for (const [k, v] of missing) out.push(`${k}=${v}`);
  }
  return out.join("\n");
}

export interface EnvResult {
  path: string;
  created: boolean;
  content: string;
  token: string;
  key: string;
}

/**
 * Ensure an .env exists with a gateway token and an agent key, generating
 * either one only when needed. Returns the values so the caller can print the
 * connection block.
 */
export function ensureEnv(envPath: string, examplePath: string): EnvResult {
  const created = !existsSync(envPath);
  const example = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
  const base = created
    ? example || "GATEWAY_TOKEN=\nLAUN_KEY=\n"
    : readFileSync(envPath, "utf8");

  // Carry every key the example defines but this file lacks. `setup ssh` writes
  // this file verbatim to the host, so a key missing here silently reverts the
  // remote to its default — which is how EXECUTOR_MODE=rpc got wiped back to
  // json by a later run.
  const updates: Record<string, string> = {};
  for (const line of example.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) updates[m[1]!] = m[2]!;
  }
  updates["GATEWAY_TOKEN"] = randomToken();
  updates["LAUN_KEY"] = randomAgentKey();

  const content = upsertEnv(base, updates);
  if (content !== base) writeFileSync(envPath, content, { mode: 0o600 });
  const token = readEnvValue(content, "GATEWAY_TOKEN");
  const key = readEnvValue(content, "LAUN_KEY");
  if (!token || !key) throw new Error(`could not prepare ${envPath}: GATEWAY_TOKEN or LAUN_KEY missing`);
  return { path: envPath, created, content, token, key };
}

export function readEnvValue(content: string, name: string): string | null {
  const m = content.match(new RegExp(`^${name}=(.*)$`, "m"));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Repo root, resolved from this file: apps/cli/src -> ../../.. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function connectionBlock(url: string, key: string, host: string): string {
  return [
    "",
    "  laun is ready.",
    "",
    `  URL   ${url}`,
    `  Key   ${key}`,
    `  UI    ${url}/   (paste the key)`,
    "",
    "  Save it for the CLI:",
    `    laun agent auth --host ${host} --key ${key}`,
    "",
    "  The key is a password: it is shown once here and stored only as a hash",
    "  on the gateway. Keep it out of shell history and git.",
    "",
  ].join("\n");
}

export interface LocalSetupOptions {
  envFile: string;
  composeFile: string;
  host: string;
  noStart: boolean;
  runner?: CommandRunner;
}

export async function localSetup(opts: LocalSetupOptions): Promise<{ url: string; key: string; envPath: string }> {
  const run = opts.runner ?? bunRunner;
  const root = repoRoot();
  const envPath = resolve(opts.envFile);
  const env = ensureEnv(envPath, join(root, "deploy", ".env.example"));
  if (!opts.noStart) {
    const compose = resolve(opts.composeFile);
    const res = await run(["docker", "compose", "-f", compose, "--env-file", envPath, "up", "-d", "--build"], {
      stdio: "inherit",
    });
    if (res.code !== 0) throw new Error(`docker compose failed with code ${res.code}`);
  }
  // The printed URL must match what the operator actually configured.
  const port = readEnvValue(env.content, "GATEWAY_PORT") ?? "8080";
  return { url: `http://${opts.host}:${port}`, key: env.key, envPath };
}

export interface SshUserAndHost {
  user: string;
  host: string;
}

/**
 * Split `ubuntu@1.2.3.4` into parts. The explicit `--user` flag wins over the
 * user embedded in the host, and the fallback default applies only when
 * neither carries one — otherwise `setup ssh ubuntu@host` would turn into
 * `root@ubuntu@host` and fail to authenticate.
 */
export function parseSshTarget(rawHost: string, userFlag?: string, defaultUser = "root"): SshUserAndHost {
  const trimmed = rawHost.trim();
  if (!trimmed) throw new UsageError(`missing host\n\nusage: laun setup ssh -i <identity> [user@]host`);
  let host = trimmed;
  let user = userFlag?.trim() || undefined;
  const at = trimmed.lastIndexOf("@");
  if (at >= 0) {
    const embedded = trimmed.slice(0, at);
    const rest = trimmed.slice(at + 1);
    if (!rest) throw new UsageError(`missing host after "@" in "${trimmed}"`);
    if (!user && embedded) user = embedded;
    host = rest;
  }
  return { user: user || defaultUser, host };
}

export interface RemoteSetupOptions {
  identity: string;
  host: string;
  user: string;
  port?: number;
  remoteDir: string;
  repoUrl?: string;
  noStart: boolean;
  envFile: string;
  runner?: CommandRunner;
}

export async function remoteSetup(opts: RemoteSetupOptions) {
  const root = repoRoot();
  const envPath = resolve(opts.envFile);
  const env = ensureEnv(envPath, join(root, "deploy", ".env.example"));
  const bootstrapPath = join(root, "deploy", "bootstrap.sh");
  if (!existsSync(bootstrapPath)) {
    throw new Error(`missing ${bootstrapPath} — this checkout is incomplete, cannot bootstrap the remote host`);
  }
  const result = await runRemoteSetup({
    identity: opts.identity,
    host: opts.host,
    user: opts.user,
    port: opts.port,
    remoteDir: opts.remoteDir,
    repoUrl: opts.repoUrl,
    noStart: opts.noStart,
    envContent: env.content,
    bootstrapScript: readFileSync(bootstrapPath, "utf8"),
    runner: opts.runner ?? bunRunner,
  });
  return { url: `http://${opts.host}:${result.port}`, key: result.key, envPath, remoteDir: result.dir };
}