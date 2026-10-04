import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { SandboxClient, type ConnectOptions, type ExecInteractiveSessionControl } from "@nvidia/openshell-sdk";

/**
 * Per-session OpenShell sandbox runner.
 *
 * When `OPENSHELL_ENABLED=true` the executor creates one sandbox per session
 * and spawns `pi` inside it via `openshell sandbox exec`, instead of as a
 * bare host child. Disabled (the default) changes nothing: call sites spawn
 * directly exactly as before.
 *
 * The only load-bearing assumption is that the CLI holds interactive stdio:
 * `spawn(bin, ["sandbox","exec","-n",name,"--",...argv], {stdio:pipe x 3})`
 * must stay up across multiple writes over time with streaming reads. That
 * shape is pinned by the stdio proof in sandbox.test.ts and must fail loudly
 * if the CLI ever stops supporting it.
 *
 * Two transports implement {@link SandboxRunner} with the same lifecycle
 * (create/stop/start/delete + context upload): {@link CliSandboxRunner}
 * shells out to the openshell binary (kept for one-shot json and for
 * deployments without SDK auth), while {@link SdkSandboxRunner} keeps the
 * CLI lifecycle (so `--policy` file handling never changes shape) but backs
 * `spawnInteractive` with the SDK's `execInteractive` session — the CLI
 * `sandbox exec` does not stream incrementally, so rpc needs the SDK.
 * Selection lives in server.ts: SDK for rpc when configured, CLI otherwise.
 */

/**
 * In-sandbox agent workdir. Matches the pi-agent image WORKDIR
 * (deploy/openshell/Dockerfile.pi) and the bring-up probe default, so the
 * policy's `${WORKDIR}` allowlist covers it. One sandbox serves one session,
 * so this single path is already session-private.
 */
export const SANDBOX_WORKDIR = "/workspace";

/** In-sandbox pi session dir: under the workdir so stop/start preserves it. */
export function sandboxSessionDirForSession(sessionId: string): string {
  return `${SANDBOX_WORKDIR}/.laun-sessions/${sessionId}`;
}

/** Default max idle age before a stopped sandbox is deleted (7 days). */
export const DEFAULT_SANDBOX_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Default interval between age-reaper sweeps (1 hour). */
export const DEFAULT_SANDBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Default bound for the post-create sandbox readiness wait (2 minutes). */
export const DEFAULT_SANDBOX_READY_TIMEOUT_SECS = 120;

/** Deterministic sandbox name for a session (sessionId is already [A-Za-z0-9_-]). */
export function sandboxNameForSession(sessionId: string): string {
  return `laun-${sessionId}`;
}

export interface SandboxCreateOptions {
  /** Sandbox name, e.g. from {@link sandboxNameForSession}. */
  name: string;
  /**
   * Host dir whose entries are uploaded into the sandbox on create (the
   * repo/goal context a fresh agent would otherwise miss: host /data is
   * invisible inside the sandbox). Skipped when unset or empty — a fresh
   * session simply has no context to seed. Upload failure is loud.
   */
  uploadFrom?: string;
  /** In-sandbox upload destination. Defaults to {@link SANDBOX_WORKDIR}. */
  uploadTo?: string;
}

export interface SandboxSpawnOptions {
  /** Host cwd for the openshell CLI process itself (SDK transport ignores it). */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * "pipe" keeps stdin open for interactive JSONL (rpc mode). "ignore" gives
   * the child EOF immediately (one-shot json mode, where an open pipe would
   * make pi wait for EOF forever). Defaults to "pipe".
   */
  stdin?: "pipe" | "ignore";
  /**
   * In-sandbox cwd for the exec: CLI `--workdir` / SDK `workdir` option.
   * Unset runs in the sandbox default (the image WORKDIR).
   */
  sandboxWorkdir?: string;
}

/**
 * Drop-in replacement for the `spawn` call sites in rpc.ts / pi.ts: the
 * returned handle is a real ChildProcess (stdin/stdout/stderr pipes, pid,
 * kill, close/error events). A fake implementation lives in sandbox.test.ts.
 */
export interface SandboxRunner {
  /**
   * Create the sandbox. Throws on failure: a run must fail loudly, never
   * silently continue unsandboxed.
   */
  create(opts: SandboxCreateOptions): Promise<void>;
  /** Spawn a long-lived child inside the sandbox `sandboxName`. */
  spawnInteractive(sandboxName: string, argv: string[], opts: SandboxSpawnOptions): ChildProcess;
  /**
   * Delete the sandbox. Best-effort and never throws: it runs on reap/teardown
   * paths where a throw would wedge run slots. Idempotent (deleting a missing
   * sandbox is swallowed). Only the age reaper deletes; idle reap stops.
   */
  remove(sandboxName: string): Promise<void>;
  /**
   * Stop the sandbox, preserving its workspace (session files survive).
   * Best-effort and never throws: idle reap and teardown call this.
   */
  stop(sandboxName: string): Promise<void>;
  /**
   * Start a stopped sandbox. Best-effort and never throws: a sandbox that is
   * still down fails loudly at readiness/spawn instead, never unsandboxed.
   */
  start(sandboxName: string): Promise<void>;
  /**
   * True when the sandbox exists. Never throws: any error means false, and
   * the create path then fails loudly if the gateway is really down.
   */
  exists(sandboxName: string): Promise<boolean>;
}

export interface CliSandboxRunnerOptions {
  /** openshell binary. Defaults to "openshell". */
  bin?: string;
  /** Sandbox image, passed as `sandbox create --from`. Required (fail closed). */
  image: string;
  /** Policy YAML path, passed as `--policy` when non-empty. */
  policyFile?: string;
  /** Providers, each passed as a repeatable `--provider` flag. */
  providers?: string[];
  /** Approval mode, passed as `--approval-mode` when non-empty. */
  approvalMode?: string;
  /** Explicit timeout for the create spawn. Defaults to 120_000. */
  createTimeoutMs?: number;
  /** Explicit timeout for the delete spawn. Defaults to 30_000. */
  removeTimeoutMs?: number;
  /** Explicit timeout for the stop spawn. Defaults to 60_000. */
  stopTimeoutMs?: number;
  /** Explicit timeout for the start spawn. Defaults to 120_000. */
  startTimeoutMs?: number;
  /** Explicit timeout for the get (exists probe) spawn. Defaults to 30_000. */
  getTimeoutMs?: number;
  /** Explicit timeout for the upload spawn. Defaults to 120_000. */
  uploadTimeoutMs?: number;
}

/** Exact `sandbox create` argv shaping (no shell, no invented flags). */
export function buildSandboxCreateArgs(o: {
  name: string;
  image: string;
  policyFile?: string;
  providers?: string[];
  approvalMode?: string;
}): string[] {
  const args = ["sandbox", "create", "--name", o.name, "--from", o.image];
  for (const p of o.providers ?? []) args.push("--provider", p);
  if (o.policyFile) args.push("--policy", o.policyFile);
  if (o.approvalMode) args.push("--approval-mode", o.approvalMode);
  return args;
}

/** Exact `sandbox exec` argv shaping for an interactive child. */
export function buildSandboxExecArgs(sandboxName: string, argv: string[], opts?: { workdir?: string }): string[] {
  const args = ["sandbox", "exec", "-n", sandboxName];
  if (opts?.workdir) args.push("--workdir", opts.workdir);
  args.push("--", ...argv);
  return args;
}

/** Exact `sandbox stop` argv shaping (workspace-preserving stop). */
export function buildSandboxStopArgs(sandboxName: string): string[] {
  return ["sandbox", "stop", sandboxName];
}

/** Exact `sandbox start` argv shaping (resume a stopped sandbox). */
export function buildSandboxStartArgs(sandboxName: string): string[] {
  return ["sandbox", "start", sandboxName];
}

/** Exact `sandbox get` argv shaping (exists probe: exit 0 iff present). */
export function buildSandboxGetArgs(sandboxName: string): string[] {
  return ["sandbox", "get", sandboxName];
}

/** Exact `sandbox upload` argv shaping (seed repo/goal context on create). */
export function buildSandboxUploadArgs(sandboxName: string, localPath: string, dest: string): string[] {
  return ["sandbox", "upload", sandboxName, localPath, dest];
}

/** CLI implementation: shells out to the openshell binary (no SDK calls). */
export class CliSandboxRunner implements SandboxRunner {
  private readonly bin: string;
  private readonly createTimeoutMs: number;
  private readonly removeTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly getTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(private readonly opts: CliSandboxRunnerOptions) {
    this.bin = opts.bin ?? "openshell";
    this.createTimeoutMs = opts.createTimeoutMs ?? 120_000;
    this.removeTimeoutMs = opts.removeTimeoutMs ?? 30_000;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 60_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 120_000;
    this.getTimeoutMs = opts.getTimeoutMs ?? 30_000;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? 120_000;
  }

  async create(opts: SandboxCreateOptions): Promise<void> {
    const image = (this.opts.image ?? "").trim();
    if (!image) {
      throw new Error(`failed to create sandbox ${opts.name}: sandbox image is required (fail closed)`);
    }
    const args = buildSandboxCreateArgs({
      name: opts.name,
      image,
      policyFile: this.opts.policyFile || undefined,
      providers: this.opts.providers ?? [],
      approvalMode: this.opts.approvalMode || undefined,
    });
    const r = spawnSync(this.bin, args, { encoding: "utf8", timeout: this.createTimeoutMs });
    if (r.error) {
      throw new Error(`failed to create sandbox ${opts.name}: ${(r.error as Error).message}`);
    }
    if (r.status !== 0) {
      const detail = (r.stderr || "").trim().split("\n").slice(-5).join("\n");
      throw new Error(`failed to create sandbox ${opts.name} (exit ${r.status})${detail ? `: ${detail}` : ""}`);
    }
    await this.uploadContext(opts.name, opts.uploadFrom, opts.uploadTo ?? SANDBOX_WORKDIR);
  }

  /**
   * Seed repo/goal context into a fresh sandbox. Skipped when the host dir
   * is unset, missing, or empty (fresh sessions have nothing to seed).
   * Loud on failure: running without the expected context must not be silent.
   */
  private async uploadContext(sandboxName: string, uploadFrom: string | undefined, uploadTo: string): Promise<void> {
    if (!uploadFrom) return;
    let entries: string[];
    try {
      entries = readdirSync(uploadFrom);
    } catch {
      return; // missing dir: nothing to seed
    }
    if (entries.length === 0) return;
    const args = buildSandboxUploadArgs(sandboxName, uploadFrom, uploadTo);
    const r = spawnSync(this.bin, args, { encoding: "utf8", timeout: this.uploadTimeoutMs });
    if (r.error) {
      throw new Error(`failed to upload context to sandbox ${sandboxName}: ${(r.error as Error).message}`);
    }
    if (r.status !== 0) {
      const detail = (r.stderr || "").trim().split("\n").slice(-5).join("\n");
      throw new Error(`failed to upload context to sandbox ${sandboxName} (exit ${r.status})${detail ? `: ${detail}` : ""}`);
    }
  }

  spawnInteractive(sandboxName: string, argv: string[], opts: SandboxSpawnOptions): ChildProcess {
    const args = buildSandboxExecArgs(sandboxName, argv, { workdir: opts.sandboxWorkdir });
    return spawn(this.bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    });
  }

  async remove(sandboxName: string): Promise<void> {
    try {
      spawnSync(this.bin, ["sandbox", "delete", sandboxName], {
        encoding: "utf8",
        timeout: this.removeTimeoutMs,
      });
    } catch {
      // Best-effort by contract: reap/teardown paths must never throw.
    }
  }

  async stop(sandboxName: string): Promise<void> {
    try {
      spawnSync(this.bin, buildSandboxStopArgs(sandboxName), {
        encoding: "utf8",
        timeout: this.stopTimeoutMs,
      });
    } catch {
      // Best-effort by contract: idle reap/teardown must never throw.
    }
  }

  async start(sandboxName: string): Promise<void> {
    try {
      spawnSync(this.bin, buildSandboxStartArgs(sandboxName), {
        encoding: "utf8",
        timeout: this.startTimeoutMs,
      });
    } catch {
      // Best-effort by contract: readiness/spawn fail loudly instead.
    }
  }

  async exists(sandboxName: string): Promise<boolean> {
    try {
      const r = spawnSync(this.bin, buildSandboxGetArgs(sandboxName), {
        encoding: "utf8",
        timeout: this.getTimeoutMs,
      });
      return !r.error && r.status === 0;
    } catch {
      return false;
    }
  }
}

/**
 * Narrow structural surface {@link SdkSandboxRunner} needs from the SDK.
 * Every member name/signature is verified against the installed
 * `@nvidia/openshell-sdk` 0.1.2 `dist/client.d.ts`: `get`,
 * `waitReady(name, timeoutSecs)`, and `execInteractive(name, command,
 * options)` with `workdir`/`tty`/`timeoutSecs`. The real `SandboxClient`
 * satisfies this structurally; fakes implement it directly, so a renamed
 * SDK method fails both `tsc` and these tests at runtime.
 */
export interface SdkSandboxSurface {
  get(name: string): Promise<{ phase: string }>;
  waitReady(name: string, timeoutSecs: number): Promise<unknown>;
  execInteractive(
    name: string,
    command: string[],
    options?: { workdir?: string; tty?: boolean; timeoutSecs?: number },
  ): Promise<ExecInteractiveSessionControl>;
}

/**
 * Compile-time proof that the curated client satisfies {@link SdkSandboxSurface}:
 * `SandboxClient` IS the sandbox surface (`client.sandbox` on the root
 * `OpenShellClient`); a renamed SDK method fails this assignment and the build.
 */
const _sdkSurfaceCompatible: SdkSandboxSurface | null = null as unknown as SandboxClient | null;
void _sdkSurfaceCompatible;

export interface SdkConnectOptions {
  /** Gateway URL (`http://...` or `https://...`). Required. */
  gateway: string;
  /** OIDC bearer for direct auth. Empty omits it. */
  token?: string;
  /** PEM file paths for mTLS to the gateway (cert and key pair up). */
  clientCertFile?: string;
  clientKeyFile?: string;
  /** PEM file path for a custom CA. Empty uses system roots. */
  caFile?: string;
  /** Skip TLS verification. Dev/debug only, never on by default. */
  insecure?: boolean;
}

function readPemFile(label: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new Error(`openshell SDK auth: cannot read ${label} file ${path}: ${(e as Error).message}`);
  }
}

/**
 * Lazily connect the SDK sandbox surface. Field names follow the installed
 * SDK's `transport.d.ts` `ConnectOptions` exactly (`gateway`, `oidcToken`,
 * `clientCert`/`clientKey`, `caCert`, `insecureSkipVerify`). Fail closed:
 * bad gateway URLs, half-paired cert files, and unreadable PEMs throw before
 * any sandbox is touched. The client itself stays lazy (no RPC until first
 * use); pass `health()`-style verification to the caller.
 */
export async function connectSandboxSurface(o: SdkConnectOptions): Promise<SdkSandboxSurface> {
  const gateway = (o.gateway ?? "").trim();
  if (!gateway) throw new Error("openshell SDK transport: gateway URL is required (fail closed)");
  let protocol: string;
  try {
    protocol = new URL(gateway).protocol;
  } catch {
    throw new Error(`openshell SDK transport: gateway URL is not a valid URL: ${gateway}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`openshell SDK transport: gateway URL must be http(s): ${gateway}`);
  }
  const certFile = (o.clientCertFile ?? "").trim();
  const keyFile = (o.clientKeyFile ?? "").trim();
  if (!!certFile !== !!keyFile) {
    throw new Error("openshell SDK auth: client cert and key files must be set together (fail closed)");
  }
  const caFile = (o.caFile ?? "").trim();
  const connectOpts: ConnectOptions = { gateway };
  const token = (o.token ?? "").trim();
  if (token) connectOpts.oidcToken = token;
  if (certFile) {
    connectOpts.clientCert = readPemFile("client cert", certFile);
    connectOpts.clientKey = readPemFile("client key", keyFile);
  }
  if (caFile) connectOpts.caCert = readPemFile("CA", caFile);
  if (o.insecure) connectOpts.insecureSkipVerify = true;
  // SandboxClient IS the sandbox surface (root OpenShellClient exposes it as
  // `.sandbox`); returning it directly satisfies SdkSandboxSurface.
  return SandboxClient.connect(connectOpts);
}

export interface SdkSandboxRunnerOptions extends CliSandboxRunnerOptions {
  /** Injected surface (tests/fakes). Takes precedence over `connect`. */
  surface?: SdkSandboxSurface;
  /** Lazy factory for the live surface (production). Called once, cached. */
  connect?: () => Promise<SdkSandboxSurface>;
  /** Bound for the post-create readiness wait. Defaults to 120s. */
  readyTimeoutSecs?: number;
}

/**
 * SDK-backed runner: CLI lifecycle (create/stop/start/delete/upload/exists
 * via an inner {@link CliSandboxRunner}, so `--policy` file handling never
 * changes shape) with `spawnInteractive` backed by the SDK's
 * `execInteractive` session (streaming rpc — the CLI `sandbox exec` does not
 * stream incrementally). `execInteractive` is async but `spawnInteractive` is
 * sync, so the returned child is a facade that buffers pre-attach stdin and
 * attaches as soon as the session resolves; attach failure surfaces as
 * `error` + `close`, exactly like a failed spawn.
 */
export class SdkSandboxRunner implements SandboxRunner {
  private readonly inner: CliSandboxRunner;
  private readonly readyTimeoutSecs: number;
  private cachedSurface: Promise<SdkSandboxSurface> | null = null;

  constructor(private readonly opts: SdkSandboxRunnerOptions) {
    this.inner = new CliSandboxRunner(opts);
    this.readyTimeoutSecs = opts.readyTimeoutSecs ?? DEFAULT_SANDBOX_READY_TIMEOUT_SECS;
  }

  private surface(): Promise<SdkSandboxSurface> {
    if (!this.cachedSurface) {
      if (this.opts.surface) {
        this.cachedSurface = Promise.resolve(this.opts.surface);
      } else if (this.opts.connect) {
        const connect = this.opts.connect;
        this.cachedSurface = connect().catch((e) => {
          // Do not cache failures: the next call retries the connection.
          if (this.cachedSurface) this.cachedSurface = null;
          throw e;
        });
      } else {
        return Promise.reject(new Error("openshell SDK transport selected but no client or factory configured (fail closed)"));
      }
    }
    return this.cachedSurface;
  }

  async create(opts: SandboxCreateOptions): Promise<void> {
    await this.inner.create(opts);
    try {
      const surface = await this.surface();
      await surface.waitReady(opts.name, this.readyTimeoutSecs);
    } catch (e) {
      // Half-made sandbox must not leak; the run still fails loudly below.
      try {
        await this.inner.remove(opts.name);
      } catch {
        // remove is best-effort by contract.
      }
      throw new Error(`sandbox ${opts.name} not ready: ${(e as Error).message}`);
    }
  }

  spawnInteractive(sandboxName: string, argv: string[], opts: SandboxSpawnOptions): ChildProcess {
    const sessionP = this.surface().then((surface) =>
      surface.execInteractive(sandboxName, argv, {
        workdir: opts.sandboxWorkdir ?? SANDBOX_WORKDIR,
        // Pipes carry JSONL: a PTY would mangle the byte stream.
        tty: false,
        // No exec-level timeout: RpcManager owns run timeouts and
        // abort/kill; a gateway-side timeout would kill idle rpc children.
        timeoutSecs: 0,
      }),
    );
    return new SdkInteractiveChild(sessionP, opts.stdin ?? "pipe") as unknown as ChildProcess;
  }

  async remove(sandboxName: string): Promise<void> {
    return this.inner.remove(sandboxName);
  }

  async stop(sandboxName: string): Promise<void> {
    return this.inner.stop(sandboxName);
  }

  async start(sandboxName: string): Promise<void> {
    return this.inner.start(sandboxName);
  }

  async exists(sandboxName: string): Promise<boolean> {
    return this.inner.exists(sandboxName);
  }
}

/**
 * `ChildProcess`-shaped facade over an SDK `execInteractive` session.
 * Verified SDK members only: `output` (async iterable of stdout/stderr
 * chunks plus a terminal `{ type: 'exit', exitCode }` event),
 * `write(Buffer)`, `closeInput()`/`close()` (idempotent stdin close),
 * `cancel()` (idempotent abort), `done: Promise<number>`.
 *
 * Node semantics are mirrored: attach failure emits `error` then `close`
 * (like a failed spawn), natural exit emits `close` with the code,
 * `kill()` cancels the session and emits `close` with a null code.
 * Stdin written before attach is buffered and flushed in order.
 */
class SdkInteractiveChild extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  pid: undefined;
  exitCode: number | null = null;
  signalCode: null = null;
  killed = false;
  private session: ExecInteractiveSessionControl | null = null;
  private readonly pending: Buffer[] = [];
  private closed = false;
  private readonly ignoreInput: boolean;

  constructor(sessionP: Promise<ExecInteractiveSessionControl>, stdinMode: "pipe" | "ignore") {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.ignoreInput = stdinMode === "ignore";
    if (this.ignoreInput) this.stdin.end();
    this.stdin.on("data", (chunk: Buffer) => this.onStdin(chunk));
    sessionP.then(
      (session) => this.onAttach(session),
      (err) => this.fail(err),
    );
  }

  private onStdin(chunk: Buffer): void {
    if (this.closed || this.killed) return;
    if (this.ignoreInput) return;
    if (this.session) {
      try {
        this.session.write(chunk);
      } catch {
        // Input already closed (post-exit writes): benign, drop.
      }
      return;
    }
    this.pending.push(chunk);
  }

  private closeRemoteInput(): void {
    const session = this.session;
    if (!session) return;
    try {
      session.closeInput();
    } catch {
      // closeInput is idempotent; a throw means already closed.
    }
  }

  private onAttach(session: ExecInteractiveSessionControl): void {
    if (this.closed || this.killed) {
      try {
        session.cancel();
      } catch {
        // already gone
      }
      return;
    }
    this.session = session;
    if (this.ignoreInput) {
      this.closeRemoteInput();
    } else {
      for (const chunk of this.pending.splice(0)) {
        try {
          session.write(chunk);
        } catch {
          break; // input closed mid-flush: drop the rest
        }
      }
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      for await (const event of session.output) {
        if (this.closed || this.killed) return;
        if ("type" in event) {
          this.exitCode = event.exitCode;
        } else if (event.stream === "stdout") {
          this.stdout.write(event.data);
        } else {
          this.stderr.write(event.data);
        }
      }
      const code = await session.done;
      this.finish(code);
    } catch (e) {
      if (this.closed || this.killed) return;
      this.fail(e);
    }
  }

  private finish(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    if (code !== null && code !== undefined) this.exitCode = code;
    try {
      this.stdout.end();
    } catch {
      // already ended
    }
    try {
      this.stderr.end();
    } catch {
      // already ended
    }
    this.emit("close", this.exitCode);
  }

  private fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    // Retain any observed process exit like the SDK's own `done` contract.
    const observed = this.session?.exitCode ?? this.exitCode ?? null;
    this.exitCode = observed;
    try {
      this.stdin.destroy();
    } catch {
      // already gone
    }
    try {
      this.stdout.destroy();
    } catch {
      // already gone
    }
    try {
      this.stderr.destroy();
    } catch {
      // already gone
    }
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
    this.emit("close", this.exitCode);
  }

  /** Mirrors `ChildProcess.kill`: cancel the session, end the pipes. */
  kill(): boolean {
    if (this.closed) return true;
    this.closed = true;
    this.killed = true;
    try {
      this.session?.cancel();
    } catch {
      // already gone
    }
    try {
      this.stdin.destroy();
    } catch {
      // already gone
    }
    try {
      this.stdout.end();
    } catch {
      // already gone
    }
    try {
      this.stderr.end();
    } catch {
      // already gone
    }
    this.exitCode = null;
    this.emit("close", null);
    return true;
  }
}

/** Last-activity record for one sandbox (persisted, no secrets — timestamps only). */
interface SandboxMetaEntry {
  lastActive: number;
  createdAt: number;
}

export interface SandboxReaperOptions {
  runner: SandboxRunner;
  /** Idle age after which a stopped sandbox is deleted. Defaults to 7d. */
  maxIdleMs?: number;
  /**
   * Interval between background sweeps. Defaults to 1h. 0 disables the
   * timer (call `sweep()` explicitly — used by tests).
   */
  sweepIntervalMs?: number;
  /** Host JSON file persisting activity across restarts. Optional. */
  metaFile?: string;
  /** Clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Age reaper: deletes sandboxes idle longer than `maxIdleMs`. There is no
 * gateway session-delete API, so deletion is purely time-based (recorded as
 * an integration note in the lane handoff — never built here). Activity is
 * tracked in memory and persisted to `metaFile` (host-side, timestamps
 * only) so an executor restart neither leaks nor prematurely deletes.
 * Idle reap (stop, workspace preserved) is NOT this class — it lives with
 * the run managers; this class only deletes the long-idle.
 */
export class SandboxReaper {
  private readonly runner: SandboxRunner;
  private readonly maxIdleMs: number;
  private readonly metaFile: string | undefined;
  private readonly clock: () => number;
  private readonly activity = new Map<string, SandboxMetaEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SandboxReaperOptions) {
    this.runner = opts.runner;
    this.maxIdleMs = opts.maxIdleMs ?? DEFAULT_SANDBOX_MAX_IDLE_MS;
    this.metaFile = opts.metaFile;
    this.clock = opts.now ?? Date.now;
    this.load();
    const interval = opts.sweepIntervalMs ?? DEFAULT_SANDBOX_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.sweep().catch(() => {
          // Best-effort: the next sweep retries.
        });
      }, interval);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Record activity for a sandbox (call on every run/acquire). Never throws. */
  track(sandboxName: string): void {
    try {
      const t = this.clock();
      const prev = this.activity.get(sandboxName);
      this.activity.set(sandboxName, { lastActive: t, createdAt: prev?.createdAt ?? t });
      this.save();
    } catch {
      // Tracking must never break a run.
    }
  }

  /** Names currently tracked (tests/diagnostics). */
  get tracked(): string[] {
    return [...this.activity.keys()];
  }

  /**
   * Delete every tracked sandbox idle at least `maxIdleMs`. Returns the
   * deleted names. Best-effort per sandbox; a surviving sandbox is simply
   * re-tracked on its next acquire (self-healing, never a leak by design).
   */
  async sweep(now?: number): Promise<string[]> {
    const t = now ?? this.clock();
    const deleted: string[] = [];
    for (const [name, meta] of [...this.activity]) {
      if (t - meta.lastActive < this.maxIdleMs) continue;
      try {
        await this.runner.remove(name);
      } catch {
        // remove is best-effort by contract; this guards fakes too.
      }
      this.activity.delete(name);
      deleted.push(name);
    }
    if (deleted.length > 0) this.save();
    return deleted;
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private load(): void {
    if (!this.metaFile) return;
    try {
      const raw = readFileSync(this.metaFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const table = (parsed as { sandboxes?: unknown }).sandboxes;
      if (table === null || typeof table !== "object" || Array.isArray(table)) return;
      for (const [name, entry] of Object.entries(table as Record<string, unknown>)) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec["lastActive"] !== "number" || typeof rec["createdAt"] !== "number") continue;
        if (!Number.isFinite(rec["lastActive"] as number) || !Number.isFinite(rec["createdAt"] as number)) continue;
        this.activity.set(name, { lastActive: rec["lastActive"] as number, createdAt: rec["createdAt"] as number });
      }
    } catch {
      // Missing/corrupt meta starts fresh; the next acquire re-tracks.
    }
  }

  private save(): void {
    if (!this.metaFile) return;
    try {
      mkdirSync(dirname(this.metaFile), { recursive: true });
      const sandboxes: Record<string, SandboxMetaEntry> = {};
      for (const [name, meta] of this.activity) sandboxes[name] = meta;
      writeFileSync(this.metaFile, JSON.stringify({ version: 1, sandboxes }) + "\n", "utf8");
    } catch {
      // Persistence is best-effort; memory still tracks this generation.
    }
  }
}
