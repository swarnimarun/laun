import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { executeProcess, MAX_FILE_BYTES, type CommandResult, type RuntimeExecution } from "./execution.js";

export interface OpenShellExecutionOptions {
  threadId: string;
  stateDir: string;
  image: string;
  bin?: string;
  /** Optional operator-reviewed host ceiling. Default policy denies all egress. */
  policyFile?: string;
  env?: NodeJS.ProcessEnv;
}

const ROOT = "/workspace";
const PATH = "/usr/local/bin:/usr/bin:/bin";
const PATH_CHECK = 'p=$(realpath -m -- "$1") || exit 1; case "$p" in /workspace|/workspace/*) ;; *) echo "path escapes thread workspace" >&2; exit 1;; esac; ';

/** Whole tool commands execute inside OpenShell; no error path runs on the host. */
export class OpenShellExecution implements RuntimeExecution {
  readonly mode = "isolated" as const;
  private readonly name: string;
  private readonly bin: string;
  private readonly ready: Promise<void>;
  constructor(private readonly options: OpenShellExecutionOptions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.threadId)) throw new Error("invalid thread ID for sandbox");
    if (!options.image.trim()) throw new Error("OpenShell sandbox image is required");
    this.name = `laun-v2-${options.threadId}`;
    this.bin = options.bin || "openshell";
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  async prepare(): Promise<void> {
    await this.ready;
    const nonce = randomUUID();
    // An image starting is not evidence of enforcement. The negative target
    // is a normally world-writable directory outside the allowed roots.
    const probe = `set -eu
test "$(id -u)" -ne 0 || { echo "sandbox must run unprivileged" >&2; exit 1; }
test -d /var/tmp && test "$(stat -c %a -- /var/tmp)" = 1777 || { echo "unsupported sandbox denial probe target" >&2; exit 1; }
printf ready > /workspace/.laun-boundary-${nonce}
test "$(cat /workspace/.laun-boundary-${nonce})" = ready
rm -- /workspace/.laun-boundary-${nonce}
if ( : > /var/tmp/.laun-denied-${nonce} ) 2>/tmp/.laun-probe-${nonce}; then
  rm -f -- /var/tmp/.laun-denied-${nonce}
  echo "OpenShell filesystem denial probe unexpectedly allowed the write" >&2; exit 1
fi
grep -qi 'permission denied' /tmp/.laun-probe-${nonce} || { cat /tmp/.laun-probe-${nonce} >&2; exit 1; }
rm -- /tmp/.laun-probe-${nonce}
printf LAUN_BOUNDARY_OK`;
    const result = await this.exec(["bash", "-c", probe], undefined, undefined, 30_000);
    if (result.exitCode !== 0 || result.stdout.trim() !== "LAUN_BOUNDARY_OK") throw new Error(`OpenShell enforcement probe failed: ${result.stderr.slice(-1000)}`);
  }
  private async transport(args: string[], input?: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<CommandResult> {
    // This is a trusted supervisor process. Its OpenShell transport identity is
    // not an agent environment and is never interpolated into sandbox argv.
    return executeProcess([this.bin, ...args], { env: this.options.env ?? process.env, input, signal, timeoutMs });
  }
  private async initialize(): Promise<void> {
    const exists = await this.transport(["sandbox", "get", this.name]);
    if (exists.exitCode === 0) {
      // CLI start may report already-running. Actual exec below is authoritative.
      await this.transport(["sandbox", "start", this.name]);
      return;
    }
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const policy = this.options.policyFile || join(this.options.stateDir, "sandbox-policy.yaml");
    if (!this.options.policyFile) await writeFile(policy, `version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr, /lib, /bin, /etc]
  read_write: [/workspace, /tmp]
landlock:
  compatibility: hard_requirement
process: {}
network_policies: {}
network_middlewares: {}
`, { mode: 0o600 });
    const created = await this.transport(["sandbox", "create", "--name", this.name, "--from", this.options.image, "--policy", policy, "--approval-mode", "manual"]);
    if (created.exitCode !== 0) throw new Error(`OpenShell create failed (${created.exitCode}): ${created.stderr.slice(-1000)}`);
  }
  private path(value: string): string {
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new Error("invalid workspace path");
    // Absolute host paths are never meaningful in the sandbox namespace.
    const path = posix.resolve(ROOT, value || ".");
    if (path !== ROOT && !path.startsWith(ROOT + "/")) throw new Error("path escapes thread workspace");
    return path;
  }
  private async exec(argv: string[], input?: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<CommandResult> {
    await this.ready;
    signal?.throwIfAborted();
    return this.transport(["sandbox", "exec", "-n", this.name, "--workdir", ROOT, "--", "env", "-i", `HOME=${ROOT}`, `PATH=${PATH}`, ...argv], input, signal, timeoutMs);
  }
  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.exec(["bash", "-c", `${PATH_CHECK}test -f "$p" || exit 1; test "$(stat -c %s -- "$p")" -le ${MAX_FILE_BYTES} || { echo "file exceeds 1 MiB" >&2; exit 1; }; head -c ${MAX_FILE_BYTES + 1} -- "$p"`, "laun-read", this.path(path)], undefined, signal);
    if (result.exitCode !== 0) throw new Error(`sandbox read failed: ${result.stderr.slice(-1000)}`);
    if (result.truncated || Buffer.byteLength(result.stdout) > MAX_FILE_BYTES) throw new Error("file exceeds 1 MiB");
    return result.stdout;
  }
  async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("write exceeds 1 MiB");
    const result = await this.exec(["bash", "-c", `${PATH_CHECK}mkdir -p -- "$(dirname -- "$p")" && cat > "$p"`, "laun-write", this.path(path)], content, signal);
    if (result.exitCode !== 0) throw new Error(`sandbox write failed: ${result.stderr.slice(-1000)}`);
  }
  async listFiles(path: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.exec(["bash", "-c", `${PATH_CHECK}find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\n' | head -n 1000`, "laun-list", this.path(path)], undefined, signal);
    if (result.exitCode !== 0) throw new Error(`sandbox listing failed: ${result.stderr.slice(-1000)}`);
    return result.stdout.split("\n").filter(Boolean);
  }
  async execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    return this.exec(["bash", "-c", command], undefined, signal, timeoutMs);
  }
  async close(): Promise<void> {
    // Stop preserves thread files. Deletion requires a separate explicit,
    // verified archive/retention operation; close never deletes durable work.
    await this.ready;
    const result = await this.transport(["sandbox", "stop", this.name], undefined, undefined, 60_000);
    if (result.exitCode !== 0) throw new Error(`OpenShell stop failed (${result.exitCode})`);
  }
}
