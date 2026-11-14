import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CommandResult { exitCode: number; stdout: string; stderr: string; truncated: boolean }
export interface RuntimeExecution {
  readonly mode: "trusted-local" | "isolated";
  /** A failed boundary stop leaves external effects requiring reconciliation. */
  readonly uncertain?: boolean;
  prepare?(): Promise<void>;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
  listFiles(path: string, signal?: AbortSignal): Promise<string[]>;
  execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>;
  /** Flush a quiesced guest workspace into its controller-owned host mirror. */
  checkpoint?(): Promise<void>;
  close?(): Promise<void>;
}
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 1024 * 1024;

/** Model tools never inherit model/provider/control credentials. */
export function commandEnvironment(root: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: root, TMPDIR: "/tmp" };
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "TZ", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

/** Used by both host commands and the supervisor's OpenShell transport. */
export async function executeProcess(
  argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs: number; signal?: AbortSignal; maxBytes?: number },
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const max = options.maxBytes ?? MAX_COMMAND_BYTES;
  return new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }); }
    catch (error) { reject(error); return; }
    let stdout = "", stderr = "", bytes = 0, truncated = false, timedOut = false;
    let inputError: Error | undefined;
    const out = new TextDecoder(); const err = new TextDecoder();
    const kill = () => {
      if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); return; } catch {} }
      try { child.kill("SIGKILL"); } catch {}
    };
    const aborted = () => kill();
    options.signal?.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
    const accept = (data: Buffer, decoder: TextDecoder, isError: boolean) => {
      const remaining = Math.max(0, max - bytes);
      const value = decoder.decode(data.subarray(0, remaining), { stream: true });
      bytes += Math.min(data.byteLength, remaining);
      if (isError) stderr += value; else stdout += value;
      if (data.byteLength > remaining) { truncated = true; kill(); }
    };
    child.stdout?.on("data", (b: Buffer) => accept(b, out, false));
    child.stderr?.on("data", (b: Buffer) => accept(b, err, true));
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); };
    child.once("error", (error) => { cleanup(); kill(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      // Commands cannot leave detached background work beyond their tracked
      // invocation. Descendants retaining pipes are killed by the timeout.
      kill();
      stdout += out.decode(); stderr += err.decode();
      if (options.signal?.aborted) { reject(new Error("command cancelled")); return; }
      if (timedOut) { reject(new Error("command timed out")); return; }
      if (inputError) { reject(new Error(`command stdin transfer failed: ${inputError.message}${stderr ? `; ${stderr.slice(-1000)}` : ""}`)); return; }
      resolveResult({ exitCode: code ?? 1, stdout, stderr, truncated });
    });
    child.stdin?.on("error", (error) => {
      // File writes and workspace restore depend on receiving the complete
      // input. A successful exit with lost stdin must never appear successful.
      if (options.input?.length) { inputError = error; kill(); }
    });
    child.stdin?.end(options.input);
  });
}

function beneath(root: string, path: string): boolean { return path === root || path.startsWith(root + sep); }

/** Path confinement for mediated file tools. Host shells remain explicitly trusted. */
export class LocalExecution implements RuntimeExecution {
  readonly mode = "trusted-local" as const;
  private root!: string;
  private readonly ready: Promise<void>;
  constructor(workspaceRoot: string) {
    this.ready = (async () => { await mkdir(workspaceRoot, { recursive: true, mode: 0o700 }); this.root = await realpath(workspaceRoot); })();
    void this.ready.catch(() => {});
  }
  async prepare(): Promise<void> { await this.ready; }
  private async path(input: string, writing = false): Promise<string> {
    await this.ready;
    if (typeof input !== "string" || input.includes("\0") || input.length > 4096) throw new Error("invalid workspace path");
    const path = isAbsolute(input) ? resolve(input) : resolve(this.root, input || ".");
    if (!beneath(this.root, path)) throw new Error("path escapes thread workspace");
    let existing = path;
    for (;;) {
      try {
        const canonical = await realpath(existing);
        if (!beneath(this.root, canonical)) throw new Error("symlink escapes thread workspace");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !writing) throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    return path;
  }
  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted(); const file = await this.path(path);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("read requires a regular file of at most 1 MiB");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) throw new Error("file exceeded 1 MiB during read");
      return buffer.subarray(0, length).toString("utf8");
    } finally { await handle.close(); }
  }
  async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("write exceeds 1 MiB");
    const file = await this.path(path, true);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("write requires a regular file");
      signal?.throwIfAborted();
      await handle.writeFile(content, { signal });
    } finally { await handle.close(); }
  }
  async listFiles(path: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    const directory = await this.path(path);
    const names = await readdir(directory, { withFileTypes: true });
    return names.slice(0, 1000).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`);
  }
  async execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    await this.ready;
    return executeProcess(["sh", "-c", command], { cwd: this.root, env: commandEnvironment(this.root), timeoutMs, signal });
  }
}
