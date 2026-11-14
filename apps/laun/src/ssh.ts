import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { DeploymentFile } from "./assets.js";
import {
  prepareAssetParent,
  prepareRemoteDirectory,
  publishRemoteConfig,
  validateInstallDirectory,
} from "./remote-path.js";
import { shQuote } from "./shell-quote.js";
import {
  controllerSourceInstaller,
  validateControllerSource,
  CONTROLLER_QUALIFICATION_SCRIPT,
} from "./controller-source.js";
import type { YardSourceArchive } from "./yard-source.js";
export { shQuote } from "./shell-quote.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Text piped to the command's stdin. */
  stdin?: string;
  /** "inherit" streams straight to the terminal (docker builds); "pipe" captures. */
  stdio?: "inherit" | "pipe";
  /**
   * While capturing (needed for parsing), also forward chunks to this process's
   * terminal as they arrive. Without it a remote bootstrap — apt, bun install,
   * tsc, docker compose build — produces several minutes of *nothing* on screen
   * and looks hung. Output is still returned in full, so key parsing works.
   */
  echo?: boolean;
  env?: Record<string, string>;
  /** Bound a disposable qualification process; normal builds remain unbounded. */
  timeoutMs?: number;
}

/** Read a stream to completion, optionally echoing each chunk as it arrives. */
async function drain(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk?: (text: string) => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = dec.decode(value, { stream: true });
    out += text;
    if (onChunk) onChunk(text);
  }
  return out;
}

export type CommandRunner = (
  argv: string[],
  opts?: RunOptions,
) => Promise<CommandResult>;

/** Default runner: Bun.spawn, so no shell is involved and quoting is explicit. */
export const bunRunner: CommandRunner = async (argv, opts = {}) => {
  const stdio = opts.stdio ?? "pipe";
  const echo = opts.echo === true && stdio === "pipe";
  const proc = Bun.spawn(argv, {
    stdin:
      opts.stdin !== undefined
        ? new Blob([opts.stdin])
        : stdio === "inherit"
          ? "inherit"
          : "ignore",
    stdout: stdio === "inherit" ? "inherit" : "pipe",
    stderr: stdio === "inherit" ? "inherit" : "pipe",
    env: opts.env ? { ...Bun.env, ...opts.env } : Bun.env,
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
  });
  const [stdout, stderr] = await Promise.all([
    stdio === "inherit"
      ? Promise.resolve("")
      : drain(proc.stdout, echo ? (t) => process.stdout.write(t) : undefined),
    stdio === "inherit"
      ? Promise.resolve("")
      : drain(proc.stderr, echo ? (t) => process.stderr.write(t) : undefined),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
};

/** POSIX single-quote a value so it survives a remote shell untouched. */

export interface SshTargetSpec {
  identity: string;
  host: string;
  user?: string;
  port?: number;
}

/** Base ssh argv shared by every remote call. BatchMode keeps it non-interactive. */
export function sshArgv(spec: SshTargetSpec, remoteCommand: string): string[] {
  const argv = [
    "ssh",
    "-i",
    spec.identity,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
  ];
  if (spec.port !== undefined) argv.push("-p", String(spec.port));
  argv.push(`${spec.user ?? "root"}@${spec.host}`, remoteCommand);
  return argv;
}

export interface RemoteSetupOptions extends SshTargetSpec {
  remoteDir: string;
  envContent: string;
  bootstrapScript: string;
  repoUrl?: string;
  revision?: string;
  noStart?: boolean;
  runner?: CommandRunner;
  assets?: DeploymentFile[];
  releaseOnly?: boolean;
  sourceArchive?: YardSourceArchive;
}

export interface RemoteSetupResult {
  key: string;
  port: number;
  dir: string;
}

/**
 * Push the env file, run deploy/bootstrap.sh on the host, and read the key back
 * out of its stdout. The key never appears in argv or in an environment
 * variable — only in the piped payloads.
 */
export async function runRemoteSetup(
  opts: RemoteSetupOptions,
): Promise<RemoteSetupResult> {
  const run = opts.runner ?? bunRunner;
  const dir = shQuote(validateInstallDirectory(opts.remoteDir));
  if (opts.sourceArchive) {
    validateControllerSource(opts.sourceArchive);
    if (opts.repoUrl || opts.releaseOnly)
      throw new Error(
        "controller source archive cannot be combined with a repository or release-only install",
      );
  } else if (!opts.repoUrl && !opts.releaseOnly)
    throw new Error(
      "controller setup needs current source, an explicit pinned repository, or released deployment templates; no remote checkout is silently reused",
    );
  if (opts.repoUrl && !/^[a-f0-9]{40}$/.test(opts.revision ?? ""))
    throw new Error(
      "controller repository install requires an exact 40-hex revision",
    );

  // Every remote step echoes: a silent multi-minute bootstrap reads as "stuck".
  const show = { echo: true } as const;

  // Creating a path like /opt/laun needs root on a stock Ubuntu box, but
  // /home/<user>/laun does not — try plainly first, then passwordless sudo,
  // and always hand the dir back to the calling user so the env write works.
  const mkdirCmd = `bash -c ${shQuote(prepareRemoteDirectory(opts.remoteDir, "controller"))}`;
  const mkdir = await run(sshArgv(opts, mkdirCmd), show);
  if (mkdir.code !== 0) {
    const why = mkdir.stderr.trim();
    throw new Error(
      `ssh mkdir failed (${mkdir.code}): ${
        why ||
        "use a fresh dedicated application directory, owned by this installer, with root/passwordless sudo when needed"
      }`,
    );
  }

  const writeEnv = await run(
    sshArgv(
      opts,
      `bash -c ${shQuote(publishRemoteConfig(opts.remoteDir, ".env"))}`,
    ),
    {
      stdin: opts.envContent,
      echo: false,
    },
  );
  if (writeEnv.code !== 0)
    throw new Error(
      `ssh env write failed (${writeEnv.code}): ${writeEnv.stderr.trim()}`,
    );

  const installer = opts.sourceArchive
    ? controllerSourceInstaller(opts.remoteDir)
    : undefined;
  const transferAssets = [
    ...(opts.assets ?? []),
    ...(installer
      ? [
          {
            path: "deploy/controller-source-installer.ts",
            content: installer,
            sha256: createHash("sha256").update(installer).digest("hex"),
          },
        ]
      : []),
  ];
  for (const asset of transferAssets) {
    if (
      !/^(?:deploy\/.+|apps\/laun\/src\/compose-profile\.ts)$/.test(
        asset.path,
      ) ||
      asset.path
        .split("/")
        .some((part) => !part || part === ".." || part === ".") ||
      asset.path.includes("\\") ||
      asset.path.endsWith("/.env") ||
      createHash("sha256").update(asset.content).digest("hex") !== asset.sha256
    )
      throw new Error("invalid public deployment asset");
    const destination = shQuote(`${opts.remoteDir}/${asset.path}`);
    const command = `bash -c ${shQuote(`${prepareAssetParent(opts.remoteDir, posix.dirname(asset.path))}\ndestination=${destination}; if [ -e "$destination" ] || [ -L "$destination" ]; then [ ! -L "$destination" ] && [ -f "$destination" ] && [ "$(stat -c %u -- "$destination")" = "$(id -u)" ] && asset_mode=$(stat -c %a -- "$destination") && (( (8#$asset_mode & 0022) == 0 )) && printf '%s  %s\\n' ${shQuote(asset.sha256)} "$destination" | sha256sum --check --status || { echo 'existing deployment template differs or is unsafe; use the explicit upgrade workflow' >&2; exit 1; }; exit 0; fi; asset_tmp=$(mktemp "$destination.tmp.XXXXXX"); trap 'rm -f "$asset_tmp"' EXIT; cat > "$asset_tmp"; printf '%s  %s\\n' ${shQuote(asset.sha256)} "$asset_tmp" | sha256sum --check --status; ln "$asset_tmp" "$destination"`)}`;
    const pushed = await run(sshArgv(opts, command), {
      stdin: asset.content,
      echo: false,
    });
    if (pushed.code !== 0)
      throw new Error(
        `verified deployment template transfer failed: ${asset.path}`,
      );
  }
  if (opts.sourceArchive) {
    const transferred = await run(
      sshArgv(
        opts,
        `bash -c ${shQuote(publishRemoteConfig(opts.remoteDir, ".controller-source.json"))}`,
      ),
      { stdin: JSON.stringify(opts.sourceArchive), echo: false },
    );
    if (transferred.code !== 0)
      throw new Error(
        `controller source transfer failed (${transferred.code}); source and credentials were not overwritten`,
      );
  }

  const bootstrapCmd = `${opts.noStart ? "LAUN_NO_START=true " : ""}${opts.releaseOnly ? "LAUN_RELEASE_ONLY=true " : ""}${opts.sourceArchive ? "LAUN_SOURCE_ARCHIVE=true " : ""}bash -s -- ${dir}${opts.repoUrl ? ` ${shQuote(opts.repoUrl)}${opts.revision ? ` ${shQuote(opts.revision)}` : ""}` : ""}`;
  if (opts.repoUrl) {
    const payload = CONTROLLER_QUALIFICATION_SCRIPT + "\n",
      destination = shQuote(`${opts.remoteDir}/.laun-controller-contract.js`),
      digest = createHash("sha256").update(payload).digest("hex");
    const command = `${publishRemoteConfig(opts.remoteDir, ".laun-controller-contract.js")}\nprintf '%s  %s\\n' ${shQuote(digest)} ${destination} | sha256sum --check --status`;
    const transferred = await run(
      sshArgv(opts, `bash -c ${shQuote(command)}`),
      { stdin: payload, echo: false },
    );
    if (transferred.code !== 0)
      throw new Error(
        "trusted controller qualification payload transfer failed",
      );
  }
  const boot = await run(sshArgv(opts, bootstrapCmd), {
    stdin: opts.bootstrapScript,
    echo: true,
  });
  const key = lastMatch(
    boot.stdout,
    /^LAUN_KEY=(laun_[0-9a-f]{8,32}_[A-Za-z0-9_-]{20,128})\s*$/m,
  );
  if (boot.code !== 0 || !key) {
    const tail = boot.stderr.trim() || boot.stdout.trim();
    throw new Error(
      `remote setup failed (${boot.code})${key ? "" : ": no LAUN_KEY in bootstrap output"}\n${tail.slice(-2000)}`,
    );
  }
  return {
    key,
    port: Number(lastMatch(boot.stdout, /^LAUN_PORT=(\d+)\s*$/m) ?? 8080),
    dir: lastMatch(boot.stdout, /^LAUN_DIR=(.+)\s*$/m) ?? opts.remoteDir,
  };
}

/** Last capture of a regex; the bootstrap prints its summary at the end. */
export function lastMatch(text: string, re: RegExp): string | null {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  let last: string | null = null;
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    last = m[1] ?? m[0] ?? null;
  }
  return last;
}
