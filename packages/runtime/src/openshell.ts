import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { executeProcess, MAX_FILE_BYTES, type CommandResult, type RuntimeExecution } from "./execution.js";
import { captureWorkspace, materializeWorkspace, MAX_WORKSPACE_TRANSPORT_BYTES, replaceWorkspace } from "./workspace.js";
import { prepareIsolatedPolicy } from "./isolated-policy.js";
import { managedSandboxName } from "./sandbox-identity.js";
import { resolveResourceLimits, resourceProbe, validateResourceCapabilities, validateRetainedResources, verifyResourceProbe, type OpenShellResourceLimits, type OpenShellResourceOptions } from "./resources.js";

export interface OpenShellExecutionOptions extends OpenShellResourceOptions {
  threadId: string;
  placementId?: string;
  stateDir: string;
  /** Backend-owned host artifact mirror, archived by the controller. */
  workspaceRoot?: string;
  image: string;
  bin?: string;
  /** Optional narrower supported host ceiling. All generic command egress is denied. */
  policyFile?: string;
  env?: NodeJS.ProcessEnv;
}

const ROOT = "/workspace";
const PATH = "/usr/local/bin:/usr/bin:/bin";
const PATH_CHECK = 'p=$(realpath -m -- "$1") || exit 1; case "$p" in /workspace|/workspace/*) ;; *) echo "path escapes thread workspace" >&2; exit 1;; esac; ';
// OpenShell label values are at most63 characters; base36 retains every bit
// of SHA-256 while using at most50 label-safe alphanumeric characters.
const labelDigest = (hex: string) => BigInt(`0x${hex}`).toString(36).padStart(50, "0");

/** Whole tool commands execute inside OpenShell; no error path runs on the host. */
export class OpenShellExecution implements RuntimeExecution {
  readonly mode = "isolated" as const;
  uncertain = false;
  private readonly name: string;
  private readonly bin: string;
  private readonly ready: Promise<void>;
  private stopped = false;
  private boundaryStarted = false;
  private readonly limits: OpenShellResourceLimits;
  private verified = false;
  private preparing?: Promise<void>;
  constructor(private readonly options: OpenShellExecutionOptions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.threadId)) throw new Error("invalid thread ID for sandbox");
    if (options.placementId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(options.placementId)) throw new Error("invalid thread placement ID for sandbox");
    if (!options.image.trim()) throw new Error("OpenShell sandbox image is required");
    this.limits = resolveResourceLimits(options);
    // OpenShell0.1.8 accepts at most19 DNS-label characters. Protocol thread
    // IDs may be64 characters, so use a stable64-bit digest within that limit.
    this.name = managedSandboxName(options.threadId, options.placementId);
    this.bin = options.bin || "openshell";
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  async prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    const pending = this.verifyBoundary(); this.preparing = pending;
    try { await pending; } finally { if (this.preparing === pending) this.preparing = undefined; }
  }
  private async verifyBoundary(): Promise<void> {
    this.verified = false;
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
${resourceProbe(this.limits)}
printf LAUN_BOUNDARY_OK`;
    const result = await this.rawExec(["bash", "-c", probe], undefined, undefined, 30_000);
    if (result.exitCode !== 0 || result.truncated) { await this.stopBoundary(); throw new Error(`OpenShell enforcement probe failed: ${result.stderr.slice(-1000)}`); }
    try { verifyResourceProbe(result.stdout.trim(), this.limits); } catch (error) { await this.stopBoundary(); throw error; }
    this.verified = true;
  }
  private async transport(args: string[], input?: string, signal?: AbortSignal, timeoutMs = 120_000, maxBytes?: number): Promise<CommandResult> {
    // This is a trusted supervisor process. Its OpenShell transport identity is
    // not an agent environment and is never interpolated into sandbox argv.
    return executeProcess([this.bin, ...args], { env: this.options.env ?? process.env, input, signal, timeoutMs, maxBytes });
  }
  private async initialize(): Promise<void> {
    // Validate before looking up retained guests; an old or mutable custom
    // policy must not bypass the supported per-thread ceiling on reopen.
    const policy = await prepareIsolatedPolicy(this.options.stateDir, this.options.policyFile);
    const policyLabel = labelDigest(policy.sha256), resourcesLabel = labelDigest(this.limits.sha256);
    const info = await this.transport(["gateway", "info", "-o", "json"]);
    if (info.exitCode !== 0 || info.truncated) throw new Error(`OpenShell resource capability lookup failed: ${info.stderr.slice(-1000)}`);
    validateResourceCapabilities(info.stdout);
    const pending = join(this.options.stateDir, "sandbox-import-pending");
    const missing = (r: CommandResult) => /not found|does not exist|NotFound/i.test(r.stderr);
    let absent = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await this.transport(["sandbox", "get", this.name, "-o", "json"]);
      if (exists.exitCode !== 0) {
        if (!missing(exists)) throw new Error(`OpenShell lookup failed: ${exists.stderr.slice(-1000)}`);
        absent = true; break;
      }
      const existing = JSON.parse(exists.stdout) as { labels?: Record<string, string>; [key: string]: unknown };
      if (existing.labels?.["laun.thread-id"] !== this.options.threadId) throw new Error("OpenShell sandbox thread identity mismatch; preserved guest was not opened");
      if ((existing.labels?.["laun.placement-id"] ?? "") !== (this.options.placementId ?? "")) throw new Error("OpenShell sandbox placement identity mismatch");
      if (existing.labels?.["laun.policy-sha256"] !== policyLabel) throw new Error("OpenShell sandbox policy identity is missing or changed; preserve and reconcile the old guest before a reviewed placement move");
      if (existing.labels?.["laun.resources-sha256"] !== resourcesLabel) throw new Error("OpenShell sandbox resource identity is missing or changed; preserve and reconcile the old guest before a reviewed placement move");
      validateRetainedResources(existing, this.limits);
      try { await access(pending); throw new Error("previous sandbox workspace import was interrupted; inspect the preserved sandbox before recovery"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const started = await this.transport(["sandbox", "start", this.name]);
      if (started.exitCode === 0) { this.boundaryStarted = true; return; }
      // Get can briefly return a deleted guest's record while the driver's
      // deletion event reconciles. Only an authoritative not-found permits a
      // bounded lookup retry; auth/transport failures never create a fallback.
      if (!missing(started)) throw new Error(`OpenShell start failed: ${started.stderr.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!absent) throw new Error("OpenShell guest deletion has not reconciled; retry after inspecting its state");
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    // Record intent before creation so a crash between create and import can
    // never make an empty guest look like an authoritative recovered guest.
    if (this.options.workspaceRoot) await writeFile(pending, "new sandbox workspace import in progress\n", { mode: 0o600 });
    const created = await this.transport(["sandbox", "create", "--name", this.name, "--from", this.options.image, "--cpu", this.limits.cpuArgument, "--memory", this.limits.memoryArgument, "--policy", policy.path, "--label", `laun.thread-id=${this.options.threadId}`, "--label", `laun.policy-sha256=${policyLabel}`, "--label", `laun.resources-sha256=${resourcesLabel}`, ...(this.options.placementId ? ["--label", `laun.placement-id=${this.options.placementId}`] : []), "--approval-mode", "manual", "--detach", "--no-tty", "--no-auto-providers", "--", "sleep", "infinity"]);
    if (created.exitCode !== 0) throw new Error(`OpenShell create failed (${created.exitCode}): ${created.stderr.slice(-1000)}`);
    this.boundaryStarted = true;
    if (this.options.workspaceRoot) {
      // Existing guests are always authoritative. Only a newly-created guest
      // may receive the restored host mirror; stale snapshots never overwrite
      // an existing sandbox after a controller restart.
      await mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 });
      const manifest = await captureWorkspace(this.options.workspaceRoot);
      const raw = JSON.stringify(manifest);
      if (Buffer.byteLength(raw) > MAX_WORKSPACE_TRANSPORT_BYTES) throw new Error("workspace import manifest exceeds transport limit");
      if (Buffer.byteLength(raw) <= 3 * 1024 * 1024) {
        const imported = await this.rawExec(["env", "HOME=/nonexistent", "bun", "--cwd", "/usr", "--no-addons", "-e", `let raw=await Bun.stdin.text();await (${materializeWorkspace.toString()})(JSON.parse(raw),'/workspace');`], raw);
        if (imported.exitCode !== 0 || imported.truncated) throw new Error(`OpenShell workspace import failed: ${imported.stderr.slice(-1000)}`);
      } else {
        // OpenShell0.1.8 caps one piped stdin at4MiB. Transfer bounded ASCII
        // chunks to a private guest file; no host or guest tar is extracted.
        const path = `/tmp/.laun-import-${randomUUID()}.json`, literal = JSON.stringify(path);
        const send = async (code: string, input?: string) => {
          const result = await this.rawExec(["env", "HOME=/nonexistent", "bun", "--cwd", "/usr", "--no-addons", "-e", code], input);
          if (result.exitCode !== 0 || result.truncated) throw new Error(`OpenShell chunked workspace import failed: ${result.stderr.slice(-1000)}`);
        };
        await send(`const fs=await import('node:fs/promises');const fd=await fs.open(${literal},'wx',0o600);await fd.close();`);
        try {
          const encoded = Buffer.from(raw).toString("base64");
          for (let index = 0; index < encoded.length; index += 2 * 1024 * 1024) {
            await send(`const fs=await import('node:fs/promises');const {constants}=await import('node:fs');const fd=await fs.open(${literal},constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);try{await fd.writeFile(Buffer.from(await Bun.stdin.text(),'base64'));}finally{await fd.close();}`, encoded.slice(index, index + 2 * 1024 * 1024));
          }
          await send(`const fs=await import('node:fs/promises');const raw=await fs.readFile(${literal},'utf8');await (${materializeWorkspace.toString()})(JSON.parse(raw),'/workspace');`);
        } finally { await send(`await (await import('node:fs/promises')).rm(${literal},{force:true});`).catch(() => {}); }
      }
      await rm(pending);
    }
  }
  private path(value: string): string {
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new Error("invalid workspace path");
    // Absolute host paths are never meaningful in the sandbox namespace.
    const path = posix.resolve(ROOT, value || ".");
    if (path !== ROOT && !path.startsWith(ROOT + "/")) throw new Error("path escapes thread workspace");
    return path;
  }
  private async rawExec(argv: string[], input?: string, signal?: AbortSignal, timeoutMs = 120_000, maxBytes?: number): Promise<CommandResult> {
    signal?.throwIfAborted();
    if (this.uncertain) throw new Error("sandbox execution is uncertain after a failed stop; reconciliation is required");
    if (this.stopped) {
      const started = await this.transport(["sandbox", "start", this.name]);
      if (started.exitCode !== 0) throw new Error(`OpenShell restart failed: ${started.stderr.slice(-1000)}`);
      this.stopped = false;
    }
    try {
      const result = await this.transport(["sandbox", "exec", "-n", this.name, "--workdir", ROOT, "--no-login-shell", "--no-tty", "--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "--", "env", "-i", `HOME=${ROOT}`, `PATH=${PATH}`, "BUN_INSTALL_CACHE_DIR=/tmp/.laun-bun-install", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/.laun-bun-transpile", ...argv], input, signal, timeoutMs, maxBytes);
      if (result.exitCode !== 0 || result.truncated) await this.stopBoundary();
      return result;
    } catch (error) {
      // Killing the CLI does not cancel its remote gRPC exec. Stop the whole
      // sandbox and verify completion before releasing this tracked action.
      await this.stopBoundary(); throw error;
    }
  }
  private async exec(argv: string[], input?: string, signal?: AbortSignal, timeoutMs = 120_000, maxBytes?: number): Promise<CommandResult> {
    await this.ready; if (!this.verified) await this.prepare(); return this.rawExec(argv, input, signal, timeoutMs, maxBytes);
  }
  async checkpoint(): Promise<void> {
    if (!this.options.workspaceRoot) return;
    const captured = await this.exec(["env", "HOME=/nonexistent", "bun", "--cwd", "/usr", "--no-addons", "-e", `console.log(JSON.stringify(await (${captureWorkspace.toString()})('/workspace')));`], undefined, undefined, 120_000, MAX_WORKSPACE_TRANSPORT_BYTES);
    if (captured.exitCode !== 0 || captured.truncated) throw new Error(`OpenShell workspace export failed: ${captured.stderr.slice(-1000)}`);
    await replaceWorkspace(JSON.parse(captured.stdout), this.options.workspaceRoot);
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
    try { return await this.exec(["bash", "-c", command], undefined, signal, timeoutMs); }
    finally {
      // Even a successful shell can leave daemonized descendants. Persistent
      // work must use tracked jobs, never unowned shell background processes.
      await this.stopBoundary();
    }
  }
  private async stopBoundary(): Promise<void> {
    if (!this.boundaryStarted || this.stopped) return;
    try {
      const result = await this.transport(["sandbox", "stop", this.name], undefined, undefined, 60_000);
      if (result.exitCode !== 0 || result.truncated) throw new Error(`OpenShell stop failed (${result.exitCode}): ${result.stderr.slice(-1000)}`);
      this.stopped = true;
      this.verified = false;
    } catch (error) { this.uncertain = true; throw error; }
  }
  async close(): Promise<void> {
    // Stop preserves thread files. Deletion requires a separate explicit,
    // verified archive/retention operation; close never deletes durable work.
    await this.ready.catch(() => {});
    await this.stopBoundary();
  }
}
