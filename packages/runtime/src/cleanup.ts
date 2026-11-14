import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RuntimeThreadCleanupInput, RuntimeThreadCleanupResult } from "@laun/protocol";
import { executeProcess, type CommandResult } from "./execution.js";
import { lockThread } from "./lock.js";
import { managedSandboxName } from "./sandbox-identity.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const uid = () => process.getuid?.() ?? -1;
const MAX_PATHS = 50_000, MAX_CANDIDATES = 128, MAX_GUESTS = 1000;
type Transport = { bin?: string; env?: NodeJS.ProcessEnv };

/** Immutable supervisor configuration. No request can select a filesystem root. */
export interface ThreadCleanerOptions {
  cleanupRoot: string;
  openshell?: Transport;
  /** A custom execution boundary needs its own cleanup implementation. */
  unsupportedExecution?: boolean;
}

/** No file contents or credentials are included in reports. */
export function createThreadCleaner(options: ThreadCleanerOptions) {
  const root = resolve(options.cleanupRoot);
  const canonicalInput = isAbsolute(options.cleanupRoot) && root === options.cleanupRoot;
  const transport = options.openshell ? { bin: options.openshell.bin || "openshell", env: { ...(options.openshell.env ?? process.env), OPENSHELL_COLOR: "never", NO_COLOR: "1" } } : undefined;
  const unsupported = options.unsupportedExecution === true;
  let bound: Stats | undefined;

  function verifyRoot(): Stats {
    if (!canonicalInput || root === "/") throw new Error("cleanup root must be an absolute dedicated canonical directory");
    let path = root;
    for (;;) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cleanup root has an unverified ancestor");
      if (info.uid !== 0 && info.uid !== uid()) throw new Error("cleanup root has an untrusted ancestor owner");
      // Shared sticky /tmp is an allowed ancestor, never an allowed root.
      if ((info.mode & 0o022) && !(path !== root && info.uid === 0 && (info.mode & 0o1000))) throw new Error("cleanup root has a writable ancestor");
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    const info = lstatSync(root);
    if (info.uid !== uid() || (info.mode & 0o077) || realpathSync(root) !== root) throw new Error("cleanup root must be private and owned by the supervisor");
    if (bound && !same(info, bound)) throw new Error("configured cleanup root identity changed");
    bound ??= info;
    return info;
  }

  function privateDirectory(path: string, create = false): Stats {
    if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid() || (info.mode & 0o077)) throw new Error("managed directory is not private and supervisor-owned");
    return info;
  }

  /** Shared by new runs and cleanup; old per-session guards are checked too. */
  function acquire(threadId: string): () => void {
    if (!ID.test(threadId)) throw new Error("invalid cleanup thread ID");
    verifyRoot();
    const guards = join(root, ".runtime-guards"); privateDirectory(guards, true);
    const guard = join(guards, threadId); privateDirectory(guard, true);
    return lockThread(guard);
  }

  function prepareRun(input: { threadId: string; sessionDir: string; workspaceRoot: string }): void {
    const thread = join(root, "threads", input.threadId);
    if (input.sessionDir !== join(thread, "session") || input.workspaceRoot !== join(thread, "work")) throw new Error("runtime directories must match the configured managed cleanup namespace");
    verifyRoot(); privateDirectory(join(root, "threads"), true); privateDirectory(thread, true);
    privateDirectory(join(thread, "session"), true); privateDirectory(join(thread, "work"), true);
  }

  function inspectTree(path: string, device: number, signal?: AbortSignal): Stats {
    let count = 0;
    function visit(current: string, depth: number): Stats {
      signal?.throwIfAborted();
      if (++count > MAX_PATHS || depth > 128) throw new Error("managed copy exceeds bounded verification limits");
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.uid !== uid() || stat.dev !== device) throw new Error("managed copy contains an unverified link, owner, mount or special file");
      if (stat.isDirectory()) {
        for (const name of readdirSync(current)) visit(join(current, name), depth + 1);
      }
      return stat;
    }
    const info = visit(path, 0);
    if (!info.isDirectory() || (info.mode & 0o077)) throw new Error("managed thread copy is not a private directory");
    return info;
  }

  async function cleanup(input: RuntimeThreadCleanupInput): Promise<RuntimeThreadCleanupResult> {
    const result: RuntimeThreadCleanupResult = { verified: false, removedPaths: 0, removedSandboxes: 0, outstanding: [] };
    const report = (message: string) => { if (result.outstanding.length < 100) result.outstanding.push(message); else result.outstanding[99] = "Additional unverified copies were omitted from this bounded report"; };
    let release: (() => void) | undefined;
    const releases: Array<() => void> = [];
    try {
      if (!ID.test(input.threadId) || input.confirmedStopped !== true || !Array.isArray(input.placementIds) || input.placementIds.length > 128 || input.placementIds.some(p => !UUID.test(p)) || new Set(input.placementIds).size !== input.placementIds.length) throw new Error("invalid cleanup thread, placement or stop confirmation");
      input.signal?.throwIfAborted();
      const info = verifyRoot();
      release = acquire(input.threadId);
      const threads = join(root, "threads");
      let names: string[] = [];
      try { privateDirectory(threads); names = readdirSync(threads); }
      catch (e) { if (!missing(e)) throw e; }
      const candidates: Array<{ path: string; stat: Stats }> = [];
      for (const name of names) {
        if (name !== input.threadId && !name.startsWith(`${input.threadId}.`)) continue;
        const suffix = name.slice(input.threadId.length);
        if (suffix && !((suffix.startsWith(".restore-") && UUID.test(suffix.slice(9))) || (suffix.startsWith(".recovery-") && UUID.test(suffix.slice(10))))) {
          report("An unknown thread-copy namespace was preserved"); continue;
        }
        if (candidates.length >= MAX_CANDIDATES) throw new Error("too many managed thread copies");
        const path = join(threads, name);
        try {
          const stat = inspectTree(path, info.dev, input.signal);
          // Old runtimes only acquired this guard. Never remove a live writer.
          const session = join(path, "session");
          // Even an old incomplete copy needs a held session lock: an older
          // runtime may not know about the new supervisor-wide guard.
          privateDirectory(session, true); releases.push(lockThread(session));
          candidates.push({ path, stat });
        } catch { report("An unverified or active managed thread copy was preserved"); }
      }
      if (unsupported) report("The configured custom execution boundary has no verified cleanup capability");
      // Verify/stop guests BEFORE removing host evidence. Unknown guests block
      // local removal, so their state and ownership records remain reviewable.
      if (transport && result.outstanding.length === 0) {
        const guests = await cleanupSandboxes(input, transport);
        result.removedSandboxes = guests.removed;
        for (const message of guests.outstanding) report(message);
      }
      if (result.outstanding.length === 0) {
        for (const candidate of candidates) {
          input.signal?.throwIfAborted(); verifyRoot(); privateDirectory(threads);
          if (!same(candidate.stat, inspectTree(candidate.path, info.dev, input.signal))) throw new Error("managed copy identity changed before removal");
          input.signal?.throwIfAborted();
          // All agents are stopped and both guards are held. rm does not
          // traverse symlinks; the complete bounded tree was verified above.
          rmSync(candidate.path, { recursive: true }); result.removedPaths++;
          const fd = openSync(threads, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
      input.signal?.throwIfAborted(); verifyRoot();
      result.verified = result.outstanding.length === 0;
    } catch (e) {
      report(input.signal?.aborted ? "Cleanup was cancelled; any unacknowledged removal requires reconciliation" : (e as NodeJS.ErrnoException)?.code ? "Managed runtime filesystem could not be verified" : e instanceof Error ? e.message : "Cleanup verification failed");
    } finally { for (const unlock of releases.reverse()) unlock(); release?.(); }
    return result;
  }
  return { acquire, prepareRun, cleanup };
}

/** OpenShell0.1.8 public list/get schema. Never starts or executes a guest. */
async function cleanupSandboxes(input: RuntimeThreadCleanupInput, transport: Required<Transport>): Promise<{ removed: number; outstanding: string[] }> {
  const outstanding: string[] = []; let removed = 0;
  const workspace = transport.env.OPENSHELL_WORKSPACE || "default";
  const deadline = Date.now() + 120_000;
  const call = async (args: string[], until = deadline): Promise<CommandResult> => {
    input.signal?.throwIfAborted();
    const remaining = Math.min(deadline, until) - Date.now();
    if (remaining <= 0) throw new Error("Sandbox cleanup verification deadline reached; reconciliation is required");
    const result = await executeProcess([transport.bin, "sandbox", ...args], { env: transport.env, signal: input.signal, timeoutMs: Math.min(15_000, remaining), maxBytes: 1024 * 1024 });
    input.signal?.throwIfAborted(); return result;
  };
  const absent = (value: CommandResult) => {
    if (value.truncated || value.exitCode === 0 || /unauthenticated|permission denied|unauthorized|transport|connection/i.test(value.stderr)) return false;
    // Only the outermost supported status establishes absence. A nested
    // driver's message containing "NotFound" is not an authoritative result.
    const raw = value.stderr.trim();
    // miette0.1.8 renders a leading cross and wraps continuation lines. We
    // inspect only its first outer diagnostic, never search nested messages.
    return /^(?:Error:\s*(?:×\s*)?)?code:\s*'Some requested entity was not found'(?=,|\s*$)/s.test(raw)
      || /^(?:Error:\s*(?:×\s*)?)?status:\s*NotFound\s*,\s*message:\s*"/s.test(raw)
      || /^(?:Error:\s*(?:×\s*)?)?Status\s*\{\s*code:\s*NotFound\s*,\s*message:\s*"/s.test(raw);
  };
  const parse = (value: CommandResult): Record<string, unknown> => {
    if (value.exitCode !== 0 || value.truncated) throw new Error("OpenShell lookup was unavailable or ambiguous; guests preserved");
    const parsed: unknown = JSON.parse(value.stdout); if (!object(parsed)) throw new Error("Unsupported OpenShell cleanup response"); return parsed;
  };
  const validate = (value: Record<string, unknown>, expectedName: string): void => {
    if (value.workspace !== workspace) throw new Error("A managed sandbox belongs to another or unknown OpenShell workspace; preserved for separate review");
    if (!object(value.labels) || value.labels["laun.thread-id"] !== input.threadId) throw new Error("Sandbox thread identity is missing or changed; guest preserved");
    if (Object.values(value.labels).some(value => typeof value !== "string")) throw new Error("Unsupported sandbox label identity; guest preserved");
    const placement = value.labels["laun.placement-id"];
    if (placement !== undefined && (typeof placement !== "string" || !UUID.test(placement))) throw new Error("Unknown sandbox placement identity; guest preserved");
    if (value.name !== expectedName || managedSandboxName(input.threadId, placement as string | undefined) !== expectedName) throw new Error("Sandbox name or placement identity changed; guest preserved");
    for (const field of ["laun.policy-sha256", "laun.resources-sha256"]) {
      const digest = value.labels[field];
      if (typeof digest !== "string" || !/^[0-9a-z]{50}$/.test(digest) || BigInt(`0x${base36Hex(digest)}`) >= (1n << 256n)) throw new Error("Unknown sandbox identity version; guest preserved");
    }
  };
  try {
    const names = new Set([undefined, ...input.placementIds].map(placement => managedSandboxName(input.threadId, placement)));
    const enumerate = async (filtered: boolean, until = deadline): Promise<Record<string, unknown>[]> => {
      const selected: Record<string, unknown>[] = [], seenTokens = new Set<string>(); let token = "", total = 0;
      for (;;) {
        const page = parse(await call(["list", "--all-workspaces", ...(filtered ? ["--selector", `laun.thread-id=${input.threadId}`] : []), "--page-size", "100", ...(token ? ["--page-token", token] : []), "-o", "json"], until));
        if (!Array.isArray(page.sandboxes) || (page.next_page_token !== undefined && typeof page.next_page_token !== "string")) throw new Error("Unsupported OpenShell sandbox enumeration; guests preserved");
        for (const raw of page.sandboxes) {
          if (++total > MAX_GUESTS) throw new Error("Sandbox enumeration exceeds bounded cleanup limit");
          if (!object(raw) || typeof raw.name !== "string") throw new Error("Unsupported OpenShell sandbox identity; guests preserved");
          if (filtered || names.has(raw.name) || (object(raw.labels) && raw.labels["laun.thread-id"] === input.threadId)) selected.push(raw);
        }
        token = (page.next_page_token as string | undefined) ?? "";
        if (!token) break;
        if (token.length > 4096 || seenTokens.has(token) || seenTokens.size >= 100) throw new Error("Sandbox pagination could not be verified");
        seenTokens.add(token);
      }
      return selected;
    };
    for (const raw of await enumerate(true)) { validate(raw, raw.name as string); names.add(raw.name as string); }
    // CLI get also fetches effective policy. Its NotFound can come from that
    // second RPC, so corroborate name/label ownership with the public list
    // RPC, including removed labels and historical workspace collisions.
    const listed = new Set<string>();
    for (const raw of await enumerate(false)) { validate(raw, raw.name as string); names.add(raw.name as string); listed.add(raw.name as string); }
    const records: Array<{ name: string; identity: string }> = [];
    const identity = (v: Record<string, unknown>) => JSON.stringify({ name: v.name, workspace: v.workspace,
      labels: Object.fromEntries(Object.entries(v.labels as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))) });
    for (const name of names) {
      const response = await call(["get", name, "-o", "json"]); if (absent(response)) { if (listed.has(name)) throw new Error("A listed sandbox lookup is inconsistent; preserved for reconciliation"); continue; }
      const value = parse(response); validate(value, name); records.push({ name, identity: identity(value) });
    }
    let deletedCount = 0;
    for (const { name, identity: expected } of records) {
      input.signal?.throwIfAborted();
      const before = await call(["get", name, "-o", "json"]); if (absent(before)) continue;
      const current = parse(before); validate(current, name); if (identity(current) !== expected) throw new Error("Sandbox identity changed during cleanup; guest preserved");
      const stopped = await call(["stop", name]); if (stopped.exitCode !== 0 || stopped.truncated) throw new Error("Sandbox stop was not verified; deletion was not attempted");
      const after = await call(["get", name, "-o", "json"]); if (absent(after)) continue;
      const settled = parse(after); validate(settled, name); if (identity(settled) !== expected) throw new Error("Sandbox identity changed after stop; guest preserved");
      if (settled.phase !== "Stopped") throw new Error("Sandbox has not reached verified stopped state; deletion was not attempted");
      input.signal?.throwIfAborted();
      const deleted = await call(["delete", name]); if (deleted.exitCode !== 0 || deleted.truncated) throw new Error("Sandbox deletion outcome is ambiguous; reconciliation is required");
      // OpenShell can acknowledge deletion while its driver/metadata record
      // is still Deleting. Repeat READS only; never repeat destructive delete.
      const verifyUntil = Math.min(deadline, Date.now() + 5_000);
      const pending = (value: Record<string, unknown>) => {
        validate(value, name);
        if (identity(value) !== expected || !["Stopped", "Deleting"].includes(String(value.phase))) throw new Error("Sandbox identity or stopped boundary changed during deletion; preserved for reconciliation");
      };
      for (;;) {
        const response = await call(["get", name, "-o", "json"], verifyUntil);
        if (absent(response)) {
          const remaining = (await enumerate(false, verifyUntil)).filter(value => value.name === name);
          if (!remaining.length) break;
          for (const value of remaining) pending(value);
        } else pending(parse(response));
        input.signal?.throwIfAborted();
        if (Date.now() >= verifyUntil) throw new Error("Sandbox deletion is not yet authoritative; reconciliation is required");
        await new Promise(resolve => setTimeout(resolve, Math.min(100, verifyUntil - Date.now())));
        input.signal?.throwIfAborted();
      }
      deletedCount++;
    }
    // A concurrently created epoch cannot silently escape this operation.
    if ((await enumerate(false)).length) throw new Error("Managed sandbox copies remain after cleanup");
    removed = deletedCount;
  } catch (e) { outstanding.push(input.signal?.aborted ? "Sandbox cleanup cancelled; uncertain effects require reconciliation" : (e as NodeJS.ErrnoException)?.code || e instanceof SyntaxError ? "Sandbox cleanup transport or response could not be verified" : e instanceof Error ? e.message : "Sandbox cleanup could not be verified"); }
  return { removed, outstanding };
}

function base36Hex(raw: string): string {
  let value = 0n; for (const character of raw) value = value * 36n + BigInt(parseInt(character, 36)); return value.toString(16);
}
