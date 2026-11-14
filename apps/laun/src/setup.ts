import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAgentKey } from "@laun/protocol";
import { UsageError } from "./args.js";
import { bunRunner, runRemoteSetup, type CommandRunner } from "./ssh.js";
import { readEnvValue, setupComposeFiles } from "./compose-profile.js";
import { deploymentAssets, deploymentFiles } from "./assets.js";
export { readEnvValue, setupComposeFiles } from "./compose-profile.js";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomAgentKey(): string {
  return formatAgentKey(
    randomBytes(4).toString("hex"),
    randomBytes(32).toString("base64url"),
  );
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
export function upsertEnv(
  content: string,
  updates: Record<string, string>,
): string {
  const out: string[] = [];
  const handled = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const name = m[1]!;
    const current = readEnvValue(line, name) ?? "";
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
export function ensureEnv(
  envPath: string,
  examplePath: string,
  defaults: {
    openshellEnabled?: boolean;
    releaseTag?: string;
    projectName?: string;
  } = {},
): EnvResult {
  const created = !existsSync(envPath);
  let example = existsSync(examplePath)
    ? readFileSync(examplePath, "utf8")
    : "";
  if (defaults.openshellEnabled !== undefined) {
    example = example.replace(
      /^OPENSHELL_ENABLED=.*$/m,
      `OPENSHELL_ENABLED=${defaults.openshellEnabled}`,
    );
  }
  if (created && defaults.releaseTag !== undefined) {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(defaults.releaseTag))
      throw new Error("portable setup requires a concrete release version");
    example = example.replace(
      /^LAUN_TAG=.*$/m,
      `LAUN_TAG=${defaults.releaseTag}`,
    );
  }
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
  if (defaults.projectName)
    updates["COMPOSE_PROJECT_NAME"] = defaults.projectName;
  // New installations get a scoped connector token and stable encrypted-inbox
  // key. Existing derived-key inboxes must be drained before explicit rotation.
  if (created) {
    updates["LAUN_TELEGRAM_BRIDGE_TOKEN"] = randomToken();
    updates["BRIDGE_INBOX_KEY"] = randomToken();
  }
  if (defaults.openshellEnabled !== undefined)
    updates["OPENSHELL_ENABLED"] = String(defaults.openshellEnabled);

  const content = upsertEnv(base, updates);
  if (created) mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  if (content !== base) writeFileSync(envPath, content, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  const token = readEnvValue(content, "GATEWAY_TOKEN");
  const key = readEnvValue(content, "LAUN_KEY");
  if (!token || !key)
    throw new Error(
      `could not prepare ${envPath}: GATEWAY_TOKEN or LAUN_KEY missing`,
    );
  return { path: envPath, created, content, token, key };
}

/** Repo root, resolved from this file: apps/cli/src -> ../../.. */
export function repoRoot(): string {
  if (import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN"))
    return resolve(dirname(fileURLToPath(import.meta.url)), ".no-checkout");
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function connectionBlock(
  url: string,
  key: string,
  host: string,
): string {
  return [
    "",
    "  laun connection settings.",
    "",
    `  URL   ${url}`,
    `  Key   ${key}`,
    `  UI    ${url}/app   (paste the key)`,
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
  releaseVersion?: string;
  checkoutRoot?: string;
}

export async function localSetup(
  opts: LocalSetupOptions,
): Promise<{ url: string; key: string; envPath: string }> {
  const run = opts.runner ?? bunRunner;
  const envPath = resolve(opts.envFile);
  const assets = deploymentAssets(opts.checkoutRoot ?? repoRoot(), envPath),
    root = assets.root;
  const env = ensureEnv(
    envPath,
    join(root, "deploy", ".env.example"),
    assets.bundled
      ? {
          releaseTag: opts.releaseVersion ?? "0.1.0",
          projectName: `laun-${createHash("sha256").update(envPath).digest("hex").slice(0, 12)}`,
        }
      : {},
  );
  if (!opts.noStart) {
    const compose =
      assets.bundled && opts.composeFile === "deploy/docker-compose.yml"
        ? join(root, "deploy/docker-compose.yml")
        : resolve(opts.composeFile);
    const files = setupComposeFiles(env.content, compose);
    const serviceImage =
      process.env.LAUN_SERVICE_IMAGE ??
      readEnvValue(env.content, "LAUN_SERVICE_IMAGE") ??
      "";
    const pullOnly = assets.bundled || Boolean(serviceImage);
    const dockerEnv = {
      ...(serviceImage ? { LAUN_SERVICE_IMAGE: serviceImage } : {}),
      ...(assets.bundled
        ? {
            LAUN_TAG: readEnvValue(env.content, "LAUN_TAG")!,
            COMPOSE_PROJECT_NAME: readEnvValue(
              env.content,
              "COMPOSE_PROJECT_NAME",
            )!,
          }
        : {}),
    };
    if (assets.bundled) {
      const tag = readEnvValue(env.content, "LAUN_TAG");
      if (!tag || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(tag))
        throw new Error(
          "portable setup requires an explicit pinned LAUN_TAG in the installation environment; floating tags never select a release",
        );
    }
    if (pullOnly) {
      const pulled = await run(
        ["docker", "compose", ...files, "--env-file", envPath, "pull"],
        { stdio: "inherit", env: dockerEnv },
      );
      if (pulled.code !== 0)
        throw new Error(`docker compose pull failed with code ${pulled.code}`);
    }
    const res = await run(
      [
        "docker",
        "compose",
        ...files,
        "--env-file",
        envPath,
        "up",
        "-d",
        pullOnly ? "--no-build" : "--build",
      ],
      {
        stdio: "inherit",
        env: dockerEnv,
      },
    );
    if (res.code !== 0)
      throw new Error(`docker compose failed with code ${res.code}`);
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
export function parseSshTarget(
  rawHost: string,
  userFlag?: string,
  defaultUser = "root",
): SshUserAndHost {
  const trimmed = rawHost.trim();
  if (!trimmed)
    throw new UsageError(
      `missing host\n\nusage: laun setup ssh -i <identity> [user@]host`,
    );
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
  revision?: string;
  noStart: boolean;
  envFile: string;
  runner?: CommandRunner;
  releaseVersion?: string;
  checkoutRoot?: string;
}

export async function remoteSetup(opts: RemoteSetupOptions) {
  const envPath = resolve(opts.envFile);
  const assets = deploymentAssets(opts.checkoutRoot ?? repoRoot(), envPath),
    root = assets.root;
  const env = ensureEnv(envPath, join(root, "deploy", ".env.example"), {
    openshellEnabled: true,
    ...(assets.bundled
      ? { releaseTag: opts.releaseVersion ?? "0.1.0", projectName: "laun" }
      : {}),
  });
  const bootstrapPath = join(root, "deploy", "bootstrap.sh");
  if (!existsSync(bootstrapPath)) {
    throw new Error(
      `missing ${bootstrapPath} — this checkout is incomplete, cannot bootstrap the remote host`,
    );
  }
  const result = await runRemoteSetup({
    identity: opts.identity,
    host: opts.host,
    user: opts.user,
    port: opts.port,
    remoteDir: opts.remoteDir,
    repoUrl: opts.repoUrl,
    revision: opts.revision,
    noStart: opts.noStart,
    envContent: env.content,
    bootstrapScript: readFileSync(bootstrapPath, "utf8"),
    assets: assets.bundled && !opts.repoUrl ? deploymentFiles() : undefined,
    releaseOnly: assets.bundled && !opts.repoUrl,
    runner: opts.runner ?? bunRunner,
  });
  return {
    url: `http://${opts.host}:${result.port}`,
    key: result.key,
    envPath,
    remoteDir: result.dir,
  };
}
