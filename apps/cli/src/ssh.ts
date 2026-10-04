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
  env?: Record<string, string>;
}

export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<CommandResult>;

/** Default runner: Bun.spawn, so no shell is involved and quoting is explicit. */
export const bunRunner: CommandRunner = async (argv, opts = {}) => {
  const stdio = opts.stdio ?? "pipe";
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : stdio === "inherit" ? "inherit" : "ignore",
    stdout: stdio === "inherit" ? "inherit" : "pipe",
    stderr: stdio === "inherit" ? "inherit" : "pipe",
    env: opts.env ? { ...Bun.env, ...opts.env } : Bun.env,
  });
  const [stdout, stderr] = await Promise.all([
    stdio === "inherit" ? Promise.resolve("") : new Response(proc.stdout).text(),
    stdio === "inherit" ? Promise.resolve("") : new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
};

/** POSIX single-quote a value so it survives a remote shell untouched. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  noStart?: boolean;
  runner?: CommandRunner;
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
export async function runRemoteSetup(opts: RemoteSetupOptions): Promise<RemoteSetupResult> {
  const run = opts.runner ?? bunRunner;
  const dir = shQuote(opts.remoteDir);

  // Creating a path like /opt/cloudbear needs root on a stock Ubuntu box, but
  // /home/<user>/cloudbear does not — try plainly first, then passwordless sudo,
  // and always hand the dir back to the calling user so the env write works.
  const mkdirCmd =
    `{ mkdir -p ${dir} && chmod 700 ${dir}; } 2>/dev/null || ` +
    `{ sudo -n mkdir -p ${dir} && sudo -n chown "$(id -u):$(id -g)" ${dir} && sudo -n chmod 700 ${dir}; }`;
  const mkdir = await run(sshArgv(opts, mkdirCmd));
  if (mkdir.code !== 0) {
    const why = mkdir.stderr.trim();
    throw new Error(
      `ssh mkdir failed (${mkdir.code}): ${why ||
        "cannot create the remote directory — it needs write access or passwordless sudo; use a writable --remote-dir such as ~/cloudbear"}`,
    );
  }

  const writeEnv = await run(sshArgv(opts, `cat > ${dir}/.env && chmod 600 ${dir}/.env`), {
    stdin: opts.envContent,
  });
  if (writeEnv.code !== 0) throw new Error(`ssh env write failed (${writeEnv.code}): ${writeEnv.stderr.trim()}`);

  const bootstrapCmd = `${opts.noStart ? "CB_NO_START=true " : ""}bash -s -- ${dir}${opts.repoUrl ? ` ${shQuote(opts.repoUrl)}` : ""}`;
  const boot = await run(sshArgv(opts, bootstrapCmd), { stdin: opts.bootstrapScript });
  const key = lastMatch(boot.stdout, /^CLOUDBEAR_KEY=(cb_[0-9a-f]{8,32}_[A-Za-z0-9_-]{20,128})\s*$/m);
  if (boot.code !== 0 || !key) {
    const tail = boot.stderr.trim() || boot.stdout.trim();
    throw new Error(`remote setup failed (${boot.code})${key ? "" : ": no CLOUDBEAR_KEY in bootstrap output"}\n${tail.slice(-2000)}`);
  }
  return {
    key,
    port: Number(lastMatch(boot.stdout, /^CLOUDBEAR_PORT=(\d+)\s*$/m) ?? 8080),
    dir: lastMatch(boot.stdout, /^CLOUDBEAR_DIR=(.+)\s*$/m) ?? opts.remoteDir,
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