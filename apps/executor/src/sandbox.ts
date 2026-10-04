import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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
 */

/** Deterministic sandbox name for a session (sessionId is already [A-Za-z0-9_-]). */
export function sandboxNameForSession(sessionId: string): string {
  return `cb-${sessionId}`;
}

export interface SandboxCreateOptions {
  /** Sandbox name, e.g. from {@link sandboxNameForSession}. */
  name: string;
}

export interface SandboxSpawnOptions {
  /** Host cwd for the openshell CLI process itself (not passed as --workdir). */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * "pipe" keeps stdin open for interactive JSONL (rpc mode). "ignore" gives
   * the child EOF immediately (one-shot json mode, where an open pipe would
   * make pi wait for EOF forever). Defaults to "pipe".
   */
  stdin?: "pipe" | "ignore";
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
   * sandbox is swallowed).
   */
  remove(sandboxName: string): Promise<void>;
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
export function buildSandboxExecArgs(sandboxName: string, argv: string[]): string[] {
  return ["sandbox", "exec", "-n", sandboxName, "--", ...argv];
}

/** CLI implementation: shells out to the openshell binary (no SDK dep). */
export class CliSandboxRunner implements SandboxRunner {
  private readonly bin: string;
  private readonly createTimeoutMs: number;
  private readonly removeTimeoutMs: number;

  constructor(private readonly opts: CliSandboxRunnerOptions) {
    this.bin = opts.bin ?? "openshell";
    this.createTimeoutMs = opts.createTimeoutMs ?? 120_000;
    this.removeTimeoutMs = opts.removeTimeoutMs ?? 30_000;
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
  }

  spawnInteractive(sandboxName: string, argv: string[], opts: SandboxSpawnOptions): ChildProcess {
    const args = buildSandboxExecArgs(sandboxName, argv);
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
}
