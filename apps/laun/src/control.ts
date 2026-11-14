import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  AdviceResult,
  BrokerConnection,
  ControlApproval,
  ControlRun,
  ControlState,
  GatewayMe,
  OnboardingStatus,
  OnboardingResult,
  CreateOnboarding,
  SelectPrimaryDirector,
  ThreadPurgePreview,
  ThreadPurgeJob,
  ThreadPurgeInput,
  HostCleanupPlan,
  HostCleanupReview,
  HostCleanupApproval,
  WorkerDrainResult,
  WorkerKeyRotation,
  WorkerKeyRotationResult,
  MowerRecord,
  StoredProfile,
  TaskRecord,
  ThreadCheckpoint,
  ThreadEvent,
  ThreadRecord,
  ThreadProfileRebase,
  ThreadWorkerMove,
  ThreadLifecycleResult,
  WorkerRecord,
} from "@laun/protocol";
import {
  flagBool,
  flagString,
  parseArgs,
  requiredArg,
  UsageError,
  type FlagSpec,
} from "./args.js";
import { GatewayClient } from "./client.js";
import { parseDurationMs } from "./agent.js";

export const CONTROL_COMMANDS = new Set([
  "mower",
  "thread",
  "yard",
  "profile",
  "task",
  "connector",
  "advice",
  "approval",
  "whoami",
  "onboard",
  "purge",
  "host-copy",
]);
export function controlHelpRequested(argv: string[]): boolean {
  const boundary = argv.indexOf("--");
  return argv
    .slice(0, boundary < 0 ? argv.length : boundary)
    .some((arg) => arg === "--help" || arg === "-h");
}
export const CONTROL_HELP = `  Durable v2 control (all accept --target <name> and --json)
    laun onboard status|new --file <json>|select <mowerId> <threadId> [--from-revision <n>]
        New setup accepts explicit model, yard and minimal permission choices. No inference is invoked.
    laun whoami [--json]   (stable owner identity for credential rotation)
    laun mower ls|new <name>|set <id> [--model <provider/model>] [--role mower|director]
        [--profile <id> --version <n>] [--yard <id>] [--clear-yard] [--name <name>] [--instructions <text>]
    laun thread ls [--mower <id>]
    laun thread new <mowerId> <title> [--parent <threadId>]
    laun thread say <id> <text> [--request-id <stable-id>]
    laun thread log|watch <id> [--after <cursor>] [--poll-ms <n>] [--timeout <dur>]
        watch waits for queued/running work; exits 0 done, 1 failed/cancelled,
        2 timeout/usage, 3 interrupted (requires reconciliation). --run pins one run.
    laun thread stop|archive <id>
    laun thread resume|abandon <runId> --confirmed-stopped
    laun thread profile <threadId> <profileId> --version <n>
        --from-profile <id> --from-version <n> --confirmed-stopped
    laun thread move <threadId> <yardId> --from-yard <id|none> --confirmed-stopped
        [--checkpoint-sha256 <reviewed-hash>] [--confirmed-omissions]
    laun thread checkpoint <id> --out <file>   (private 0600, never overwrites)
    laun thread purge-preview <id> --json
    laun thread purge <id> --digest <reviewed-sha256> --confirmed-stopped --controller-copy-only
        [--legacy-telegram-route-cleanup] [--request-id <stable-id>]
    laun purge ls|status <id>|continue <id> [--max-rows <1-256>]|host-copies <id>
        Remove controller copy only. Host caches, quoted results, exports and backups remain separate.
    laun host-copy review <planId> [--json]
    laun host-copy approve <planId> --digest <reviewed-plan-sha256> --confirmed-stopped --delete-host-copies
    laun host-copy revoke <planId> --digest <current-reviewed-plan-sha256>
        Separate destructive host approval. Keep the idle yard online; verify this thread's work stopped.
        Revocation stops further authorized steps; it cannot undo deletion already begun.
    laun yard ls|enroll <name> [--capacity <n>] [--labels a,b]|revoke <id>
    laun yard drain|resume <id>
    laun yard rotate <id> --from-version <credential-version> --confirmed-stopped
        Replacement key is shown once; replace the private worker configuration manually.
    laun yard setup ssh <host> -i <identity> --controller-url <https-origin>
        --config <json> [--service-user <nonroot>] [--inference controller|local]
        [--source-dir <checkout> | --repo-url <https> --revision <40hex>]
        [--remote-dir <absolute>] [--no-start] [--timeout 2m]
    laun profile ls|new --file <json>|revise <id> --file <json> --base <version>
    laun profile revoke <id> [--version <n>]
    laun task ls [--parent <threadId>]
    laun task delegate <parentThreadId> <goal> [--mower <id>] [--name <title>]
    laun task handoff <taskId> <mowerId> [--request-id <stable-id>]
    laun connector ls|add --file <json>|discover <id>|disable <id>
    laun approval ls|allow <id>|deny <id>|discuss <id> <feedback>
    laun advice get <runId> | ask <approvalId> <feedback>
        Structured input uses a JSON object file; --file=- reads stdin.
        Profiles: {name,mode,rules}. Connector: {name,url,protocolVersion,...}.
        Advice is inert; revisions and current-action decisions are separate.
`;

interface ControlIo {
  out(line: string): void;
  err(line: string): void;
}
const ACTIVE = new Set(["queued", "running", "waiting_permission"]);
const idPath = (id: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new UsageError("invalid resource identifier");
  return encodeURIComponent(id);
};
function integer(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new UsageError(`${name} must be a nonnegative integer`);
  return Number(value);
}
function positive(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  const n = integer(value, name, fallback);
  if (n < 1) throw new UsageError(`${name} must be positive`);
  return n;
}
export async function readInput(
  path: string | undefined,
): Promise<Record<string, unknown>> {
  if (!path)
    throw new UsageError(
      "structured input requires --file <path> (or --file=- for stdin)",
    );
  let raw: string;
  if (path === "-") {
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 262_144) {
          await reader.cancel();
          throw new UsageError("JSON input exceeds 256 KiB");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } else {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile())
        throw new UsageError(
          "--file requires a regular JSON file; use --file=- for stdin",
        );
      const bytes = Buffer.alloc(262_145);
      let size = 0;
      while (size < bytes.length) {
        const next = await file.read(bytes, size, bytes.length - size, size);
        if (!next.bytesRead) break;
        size += next.bytesRead;
      }
      if (size > 262_144) throw new UsageError("JSON input exceeds 256 KiB");
      raw = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
    } finally {
      await file.close();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("input must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new UsageError("input must be a JSON object");
  return parsed as Record<string, unknown>;
}
function eventLine(event: ThreadEvent): string | undefined {
  const p = event.payload;
  const e = p.event;
  if (event.kind === "message")
    return `[${event.sequence}] ${p.role ?? "user"}: ${p.text ?? ""}`;
  if (e?.type === "text") return `[${event.sequence}] assistant: ${e.delta}`;
  if (e?.type === "error") return `[${event.sequence}] error: ${e.message}`;
  if (e?.type === "tool_call") return `[${event.sequence}] tool: ${e.name}`;
  if (e?.type === "tool_result")
    return `[${event.sequence}] ${e.ok ? "tool completed" : "tool failed"}: ${e.name}`;
  if (typeof p.text === "string")
    return `[${event.sequence}] ${event.kind}: ${p.text}`;
  return undefined;
}

/** Commands dispatch through the same saved/authenticated client as the legacy CLI. */
export async function controlCommand(
  command: string,
  argv: string[],
  client: GatewayClient,
  io: ControlIo,
): Promise<number> {
  if (controlHelpRequested(argv)) {
    io.out(CONTROL_HELP);
    return 0;
  }
  if (command === "whoami") {
    const parsed = parseArgs(argv, { boolean: ["json"] });
    if (parsed.positionals.length)
      throw new UsageError("usage: laun whoami [--json]");
    const identity = await client.control<GatewayMe>("/me");
    io.out(
      flagBool(parsed.flags, "json")
        ? JSON.stringify(identity)
        : `${identity.principalId}  ${identity.admin ? "installation administrator" : "workspace owner"}`,
    );
    return 0;
  }
  const [sub = "ls", ...rest] = argv;
  const spec: FlagSpec = { boolean: ["json"], value: [] };
  const allowed: Record<string, Record<string, FlagSpec>> = {
    onboard: {
      status: {},
      new: { value: ["file", "request-id"] },
      select: { value: ["from-revision", "request-id"] },
    },
    mower: {
      ls: {},
      new: {
        value: ["model", "role", "profile", "version", "yard", "instructions"],
      },
      set: {
        boolean: ["clear-yard", "archive"],
        value: ["name", "model", "profile", "version", "yard", "instructions"],
      },
    },
    thread: {
      ls: { value: ["mower"] },
      new: { value: ["parent"] },
      say: { value: ["request-id"] },
      log: { value: ["after"] },
      watch: { value: ["after", "poll-ms", "timeout", "run"] },
      stop: {},
      archive: {},
      resume: { boolean: ["confirmed-stopped"] },
      abandon: { boolean: ["confirmed-stopped"] },
      checkpoint: { value: ["out"] },
      "purge-preview": {},
      purge: {
        value: ["digest", "request-id"],
        boolean: [
          "confirmed-stopped",
          "controller-copy-only",
          "legacy-telegram-route-cleanup",
        ],
      },
      profile: {
        boolean: ["confirmed-stopped"],
        value: ["version", "from-profile", "from-version"],
      },
      move: {
        boolean: ["confirmed-stopped", "confirmed-omissions"],
        value: ["from-yard", "checkpoint-sha256"],
      },
    },
    yard: {
      ls: {},
      enroll: { value: ["capacity", "labels"] },
      revoke: {},
      drain: {},
      resume: {},
      rotate: { value: ["from-version"], boolean: ["confirmed-stopped"] },
    },
    profile: {
      ls: {},
      new: { value: ["file"] },
      revise: { value: ["file", "base"] },
      revoke: { value: ["version"] },
    },
    task: {
      ls: { value: ["parent"] },
      delegate: { value: ["mower", "name", "request-id"] },
      handoff: { value: ["request-id"] },
    },
    connector: { ls: {}, add: { value: ["file"] }, discover: {}, disable: {} },
    approval: {
      ls: {},
      allow: {},
      deny: { boolean: ["stop"], value: ["feedback"] },
      discuss: { value: ["request-id"] },
    },
    advice: { get: {}, ask: { value: ["request-id"] } },
    purge: {
      ls: {},
      status: {},
      continue: { value: ["max-rows"] },
      "host-copies": {},
    },
    "host-copy": {
      review: {},
      approve: { value: ["digest"], boolean: ["confirmed-stopped", "delete-host-copies"] },
      revoke: { value: ["digest"] },
    },
  };
  const selected = allowed[command]?.[sub];
  if (!selected)
    throw new UsageError(
      `unknown ${command} command "${sub}"\n\n${CONTROL_HELP}`,
    );
  const { flags, positionals } = parseArgs(rest, {
    boolean: [...spec.boolean!, ...(selected.boolean ?? [])],
    value: selected.value,
  });
  const counts: Record<string, Record<string, number>> = {
    onboard: { status: 0, new: 0, select: 2 },
    mower: { ls: 0, new: 1, set: 1 },
    thread: {
      ls: 0,
      new: 2,
      say: 2,
      log: 1,
      watch: 1,
      stop: 1,
      archive: 1,
      resume: 1,
      abandon: 1,
      checkpoint: 1,
      "purge-preview": 1,
      purge: 1,
      profile: 2,
      move: 2,
    },
    yard: { ls: 0, enroll: 1, revoke: 1, drain: 1, resume: 1, rotate: 1 },
    profile: { ls: 0, new: 0, revise: 1, revoke: 1 },
    task: { ls: 0, delegate: 2, handoff: 2 },
    connector: { ls: 0, add: 0, discover: 1, disable: 1 },
    approval: { ls: 0, allow: 1, deny: 1, discuss: 2 },
    advice: { get: 1, ask: 2 },
    purge: { ls: 0, status: 1, continue: 1, "host-copies": 1 },
    "host-copy": { review: 1, approve: 1, revoke: 1 },
  };
  if (positionals.length > (counts[command]?.[sub] ?? 0))
    throw new UsageError(
      `too many arguments for ${command} ${sub}; quote multiword text`,
    );
  const json = flagBool(flags, "json");
  const arg = (index: number, what: string) =>
    requiredArg(positionals, index, what, `laun ${command} ${sub} <${what}>`);
  const get = <T>(path: string, timeoutMs?: number) =>
    client.control<T>(path, { timeoutMs });
  const post = <T>(path: string, body: unknown = {}) =>
    client.control<T>(path, { method: "POST", body });
  const print = (data: unknown, human?: string) => {
    io.out(json || human === undefined ? JSON.stringify(data) : human);
  };
  const list = <T>(values: T[], line: (item: T) => string) => {
    if (json) io.out(JSON.stringify(values));
    else if (!values.length) io.out("No records.");
    else for (const item of values) io.out(line(item));
  };
  const workspace = () => get<ControlState>("/state");
  const requestId = () =>
    flagString(flags, "request-id") ?? crypto.randomUUID();

  if (command === "onboard") {
    if (sub === "status") {
      const status = await get<OnboardingStatus>("/onboarding");
      print(status);
      return 0;
    }
    let body: CreateOnboarding | SelectPrimaryDirector;
    if (sub === "new") {
      const input = await readInput(flagString(flags, "file"));
      const allowed = new Set([
        "requestId",
        "name",
        "title",
        "model",
        "workerId",
        "mode",
        "workspaceWrite",
        "processExecute",
        "delegation",
      ]);
      if (Object.keys(input).some((name) => !allowed.has(name)))
        throw new UsageError(
          "New onboarding accepts only explicit name, title, model, workerId, mode and the three structured permission choices.",
        );
      for (const name of [
        "name",
        "title",
        "model",
        "workerId",
        "mode",
        "workspaceWrite",
        "processExecute",
        "delegation",
      ])
        if (typeof input[name] !== "string" || !input[name])
          throw new UsageError(`onboarding JSON requires ${name}`);
      body = {
        ...input,
        requestId:
          flagString(flags, "request-id") ??
          (typeof input.requestId === "string"
            ? input.requestId
            : crypto.randomUUID()),
      } as unknown as CreateOnboarding;
    } else
      body = {
        requestId: requestId(),
        mowerId: arg(0, "mowerId"),
        threadId: arg(1, "threadId"),
        ...(flagString(flags, "from-revision")
          ? {
              expectedRevision: positive(
                flagString(flags, "from-revision"),
                "from-revision",
              ),
            }
          : {}),
      };
    const result = await post<OnboardingResult>("/onboarding", body);
    print(
      result,
      `${result.created ? "Created" : "Selected"} primary Groundskeeper ${result.setup.primaryMowerId}; thread=${result.setup.primaryThreadId}; revision=${result.setup.revision}. No run was started.`,
    );
    return 0;
  }

  if (command === "mower") {
    if (sub === "ls") {
      list(
        (await workspace()).mowers,
        (m) =>
          `${m.id}  ${m.name}  ${m.role}  ${m.model}  ${m.profileId}:v${m.profileVersion}${m.archivedAt ? "  archived" : ""}`,
      );
      return 0;
    }
    const body: Record<string, unknown> = {};
    for (const name of ["name", "model", "instructions"])
      if (flagString(flags, name) !== undefined)
        body[name] = flagString(flags, name);
    if (sub === "new") {
      body.name = arg(0, "name");
      if (flagString(flags, "role")) body.role = flagString(flags, "role");
    }
    const profile = flagString(flags, "profile"),
      version = flagString(flags, "version");
    if ((profile === undefined) !== (version === undefined))
      throw new UsageError("--profile and --version must be supplied together");
    if (profile) {
      body.profileId = profile;
      body.profileVersion = positive(version, "version");
    }
    if (flagBool(flags, "clear-yard") && flagString(flags, "yard"))
      throw new UsageError("choose --yard or --clear-yard");
    if (flagString(flags, "yard")) body.workerId = flagString(flags, "yard");
    if (flagBool(flags, "clear-yard")) body.workerId = null;
    if (flagBool(flags, "archive")) body.archived = true;
    if (sub === "set" && !Object.keys(body).length)
      throw new UsageError("mower set requires a change flag");
    const result =
      sub === "new"
        ? await post<MowerRecord>("/mowers", body)
        : await client.control<MowerRecord>(
            `/mowers/${idPath(arg(0, "mowerId"))}`,
            { method: "PATCH", body },
          );
    print(result, `${result.id}  ${result.name}  ${result.model}`);
    return 0;
  }
  if (command === "thread") {
    if (sub === "ls") {
      let values = (await workspace()).threads;
      const mower = flagString(flags, "mower");
      if (mower) values = values.filter((t) => t.mowerId === mower);
      list(
        values,
        (t) =>
          `${t.id}  ${t.title}  mower=${t.mowerId}${t.parentThreadId ? `  parent=${t.parentThreadId}` : ""}`,
      );
      return 0;
    }
    if (sub === "new") {
      const result = await post<ThreadRecord>("/threads", {
        mowerId: arg(0, "mowerId"),
        title: arg(1, "title"),
        parentThreadId: flagString(flags, "parent"),
      });
      print(result, `${result.id}  ${result.title}`);
      return 0;
    }
    const id = arg(
      0,
      sub === "resume" || sub === "abandon" ? "runId" : "threadId",
    );
    const path = idPath(id);
    if (sub === "purge-preview") {
      const { preview } = await get<{ preview: ThreadPurgePreview }>(
        `/threads/${path}/purge-preview`,
      );
      print(preview);
      return 0;
    }
    if (sub === "purge") {
      if (
        !flagBool(flags, "confirmed-stopped") ||
        !flagBool(flags, "controller-copy-only")
      )
        throw new UsageError(
          "Remove controller copy requires --confirmed-stopped and --controller-copy-only after reviewing the current preview. Host copies, quoted results and backups are separate.",
        );
      const digest = flagString(flags, "digest");
      if (!digest || !/^[a-f0-9]{64}$/.test(digest))
        throw new UsageError(
          "--digest must be the exact current purge-preview SHA-256 you reviewed",
        );
      const body: ThreadPurgeInput = {
        requestId: requestId(),
        expectedDigest: digest,
        confirmedStopped: true,
        confirmedControllerCopyOnly: true,
        ...(flagBool(flags, "legacy-telegram-route-cleanup")
          ? { confirmedLegacyTelegramRouteCleanup: true }
          : {}),
      };
      const { job } = await post<{ job: ThreadPurgeJob }>(
        `/threads/${path}/purge`,
        body,
      );
      print(
        job,
        `Remove controller copy: ${job.status}; purge=${job.id}; pending host copies=${job.pendingHostCopies}. Continue bounded removal with laun purge continue ${job.id}.`,
      );
      return 0;
    }
    if (sub === "profile" || sub === "move") {
      if (!flagBool(flags, "confirmed-stopped"))
        throw new UsageError(
          "Reconcile and stop execution before changing a thread; pass --confirmed-stopped only after inspecting the old placement/profile and external effects.",
        );
      let body: ThreadProfileRebase | ThreadWorkerMove;
      if (sub === "profile") {
        const previous = flagString(flags, "from-profile");
        if (!previous)
          throw new UsageError(
            "--from-profile and --from-version must identify the pinned revision you reviewed",
          );
        body = {
          profileId: arg(1, "profileId"),
          profileVersion: positive(flagString(flags, "version"), "version"),
          expectedProfileId: previous,
          expectedProfileVersion: positive(
            flagString(flags, "from-version"),
            "from-version",
          ),
          confirmedStopped: true,
        };
      } else {
        const previous = flagString(flags, "from-yard");
        if (!previous)
          throw new UsageError(
            "--from-yard must identify the reviewed current yard, or none for an unassigned thread",
          );
        const digest = flagString(flags, "checkpoint-sha256");
        if (digest && !/^[0-9a-f]{64}$/i.test(digest))
          throw new UsageError(
            "checkpoint-sha256 must be the reviewed SHA-256 digest",
          );
        body = {
          workerId: arg(1, "yardId"),
          expectedWorkerId: previous === "none" ? null : previous,
          confirmedStopped: true,
          checkpointSha256: digest?.toLowerCase(),
          confirmedOmissions: flagBool(flags, "confirmed-omissions")
            ? true
            : undefined,
        };
      }
      const result = await post<ThreadLifecycleResult>(
        `/threads/${path}/${sub}`,
        body,
      );
      print(
        result,
        `Thread ${result.thread.id} ${sub === "profile" ? "profile rebased" : "placement moved"}. It remains stopped; no prompt was replayed. Direct user input is required to continue.`,
      );
      return 0;
    }
    if (sub === "say") {
      const result = await post<ControlRun>(`/threads/${path}/messages`, {
        text: arg(1, "text"),
        requestId: requestId(),
      });
      print(
        result,
        `${result.id}  ${result.status}  request=${result.requestId}`,
      );
      return 0;
    }
    if (sub === "stop") {
      const result = await post(`/threads/${path}/cancel`);
      print(
        result,
        "Cancellation requested. Interrupted attempts still require reconciliation.",
      );
      return 0;
    }
    if (sub === "archive") {
      const result = await post<ThreadRecord>(`/threads/${path}/archive`);
      print(
        result,
        "Thread archived; history remains on the controller. Active family work was asked to stop; interrupted effects still require reconciliation.",
      );
      return 0;
    }
    if (sub === "resume" || sub === "abandon") {
      if (!flagBool(flags, "confirmed-stopped"))
        throw new UsageError(
          "First verify the previous worker stopped and reconcile external effects; then pass --confirmed-stopped. Unknown effects must not be blindly replayed.",
        );
      const result = await post<ControlRun>(`/runs/${path}/${sub}`, {
        confirmedStopped: true,
      });
      print(
        result,
        `${result.id}  ${result.status}${sub === "resume" ? " (accepted for execution)" : " (abandoned without replay)"}`,
      );
      return 0;
    }
    if (sub === "checkpoint") {
      const output = flagString(flags, "out");
      if (!output)
        throw new UsageError(
          "checkpoint export requires --out <private-file>; it never writes artifacts to stdout",
        );
      const raw = await client.control<string>(`/threads/${path}/checkpoint`, {
        response: "text",
      });
      const archive = JSON.parse(raw) as ThreadCheckpoint;
      if (
        archive.version !== 1 ||
        archive.threadId !== id ||
        !Array.isArray(archive.files)
      )
        throw new Error("server returned an invalid checkpoint");
      const destination = resolve(output);
      const handle = await open(destination, "wx", 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      print(
        {
          path: destination,
          threadId: id,
          createdAt: archive.createdAt,
          files: archive.files.length,
          sha256: createHash("sha256").update(raw).digest("hex"),
          omittedPaths: archive.omittedPaths ?? [],
        },
        `Saved last completed checkpoint privately to ${destination}${archive.omittedPaths?.length ? ` (${archive.omittedPaths.length} omitted paths)` : ""}.`,
      );
      return 0;
    }
    let cursor = integer(flagString(flags, "after"), "after", 0);
    const pollMs = positive(flagString(flags, "poll-ms"), "poll-ms", 1000);
    if (pollMs < 10 || pollMs > 60_000)
      throw new UsageError("poll-ms must be between 10 and 60000");
    const timeoutMs =
      flagString(flags, "timeout") === undefined
        ? 300_000
        : parseDurationMs(flagString(flags, "timeout")!);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new UsageError("timeout must be positive");
    const deadline = Date.now() + Math.ceil(timeoutMs);
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("watch deadline");
      return Math.min(ms, 20_000);
    };
    const drain = async () => {
      for (;;) {
        const batch = await get<{ events: ThreadEvent[]; nextCursor: number }>(
          `/threads/${path}/events?after=${cursor}`,
          remaining(),
        );
        if (
          !Array.isArray(batch.events) ||
          !Number.isSafeInteger(batch.nextCursor) ||
          batch.nextCursor < cursor ||
          batch.events.some(
            (event) =>
              event.threadId !== id ||
              !Number.isSafeInteger(event.sequence) ||
              event.sequence > batch.nextCursor,
          )
        )
          throw new Error("server returned an invalid durable event cursor");
        const previous = cursor;
        for (const event of batch.events) {
          if (event.sequence <= cursor) continue;
          if (json) io.out(JSON.stringify({ type: "event", event }));
          else {
            const line = eventLine(event);
            if (line) io.out(line);
          }
          cursor = Math.max(cursor, event.sequence);
        }
        cursor = batch.nextCursor;
        if (!batch.events.length) return;
        if (cursor <= previous)
          throw new Error("server returned a non-advancing event cursor");
      }
    };
    const runId = flagString(flags, "run");
    const loadRuns = async () => {
      const runs = runId
        ? [
            (
              await get<{ run: ControlRun }>(
                `/runs/${idPath(runId)}`,
                remaining(),
              )
            ).run,
          ]
        : (
            await get<{ runs: ControlRun[] }>(
              `/threads/${path}/runs`,
              remaining(),
            )
          ).runs;
      if (!Array.isArray(runs) || runs.some((run) => run.threadId !== id))
        throw new Error("server returned runs outside the requested thread");
      return runs;
    };
    try {
      for (;;) {
        await drain();
        if (sub === "log") {
          if (json)
            io.out(JSON.stringify({ type: "cursor", nextCursor: cursor }));
          return 0;
        }
        let runs = await loadRuns();
        if (!runs.length) {
          io.err(
            runId
              ? "Run not found in this thread."
              : "This thread has no accepted runs.",
          );
          return 1;
        }
        const interrupted = runs.find((run) => run.status === "interrupted");
        if (interrupted) {
          print(
            { type: "status", threadId: id, run: interrupted, cursor },
            `Interrupted run ${interrupted.id}; reconcile the previous worker before explicit resume or abandon.`,
          );
          return 3;
        }
        if (!runs.some((run) => ACTIVE.has(run.status))) {
          await drain();
          runs = await loadRuns();
          if (
            runs.some(
              (run) => ACTIVE.has(run.status) || run.status === "interrupted",
            )
          )
            continue;
          if (!runs.length)
            throw new Error("server lost the watched run history");
          const latest = runs.sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )[0]!;
          print(
            { type: "status", threadId: id, run: latest, cursor },
            `${latest.id}  ${latest.status}${latest.summary ? `  ${latest.summary}` : ""}`,
          );
          return latest.status === "done" ? 0 : 1;
        }
        const wait = Math.min(pollMs, deadline - Date.now());
        if (wait > 0) await Bun.sleep(wait);
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        io.err("Timed out; work may still be running.");
        return 2;
      }
      throw error;
    }
  }
  if (command === "host-copy") {
    const path = `/host-copies/${idPath(arg(0, "planId"))}`;
    if (sub === "review") {
      const { review } = await get<{ review: HostCleanupReview }>(path);
      const plan = review.plan;
      print(review, [
        `Host copy: ${plan.id}  ${plan.status}  worker=${plan.workerId}  thread=${plan.threadId}`,
        `Review digest: ${review.digest}`,
        `Approval: ${plan.approvedAt ? `granted until ${plan.approvalExpiresAt}` : "none"}; verified completion=${plan.status === "done" && plan.verified === true && !plan.outstanding?.length}; removed paths=${plan.removedPaths ?? 0}; removed sandboxes=${plan.removedSandboxes ?? 0}`,
        `Placements: ${plan.placementIds.join(", ") || "legacy/base placement"}; older placements untracked=${plan.unknownPlacements}`,
        ...review.warnings,
        ...(plan.outstanding ?? []).map(message => `Outstanding: ${message}`),
        "Keep the idle yard service online. Independently verify this thread's work is stopped; a controller status does not prove physical shutdown. Unknown copies, exports, backups and bridge data remain separate.",
      ].join("\n"));
      return 0;
    }
    const digest = flagString(flags, "digest");
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new UsageError("--digest must be the exact current host-copy review SHA-256 you inspected; changed plans require a fresh review");
    if (sub === "approve" && (!flagBool(flags, "confirmed-stopped") || !flagBool(flags, "delete-host-copies"))) throw new UsageError("Host-copy deletion requires --confirmed-stopped and --delete-host-copies. Verify this thread's work is stopped on the intended host and review its exact plan first; keep the idle yard service online.");
    const body: HostCleanupApproval | { expectedDigest: string } = sub === "approve"
      ? { expectedDigest: digest, confirmedStopped: true, confirmedDeleteHostCopies: true }
      : { expectedDigest: digest };
    const { plan } = await post<{ plan: HostCleanupPlan }>(`${path}/${sub}`, body);
    print(plan, sub === "approve"
      ? `Host-copy deletion approved until ${plan.approvalExpiresAt}; plan=${plan.id}; status=${plan.status}. Approval is not completion. Review this plan again for verified results and outstanding copies.`
      : `Host-copy approval withdrawn; plan=${plan.id}; status=${plan.status}. Already-started deletion may have completed; inspect the host before approving again.`);
    return 0;
  }
  if (command === "purge") {
    if (sub === "ls") {
      const { purges } = await get<{ purges: ThreadPurgeJob[] }>("/purges");
      list(
        purges,
        (job) =>
          `${job.id}  thread=${job.threadId}  ${job.status}  pending host copies=${job.pendingHostCopies}`,
      );
      return 0;
    }
    const path = `/purges/${idPath(arg(0, "purgeId"))}`;
    if (sub === "host-copies") {
      const { plans } = await get<{ plans: HostCleanupPlan[] }>(
        `${path}/host-copies`,
      );
      print(plans);
      return 0;
    }
    let job: ThreadPurgeJob;
    if (sub === "continue") {
      const rows = positive(flagString(flags, "max-rows"), "max-rows", 64);
      if (rows > 256) throw new UsageError("max-rows must be 1-256");
      job = (
        await post<{ job: ThreadPurgeJob }>(`${path}/continue`, {
          maxRows: rows,
        })
      ).job;
    } else job = (await get<{ job: ThreadPurgeJob }>(path)).job;
    print(
      job,
      `Controller copy: ${job.status}; pending host copies=${job.pendingHostCopies}; SQLite page reclamation=${job.reclamation}. Logical removal does not erase quoted results or backups.`,
    );
    return 0;
  }
  if (command === "yard") {
    if (sub === "ls") {
      list(
        (await workspace()).workers,
        (w) =>
          `${w.id}  ${w.name}  ${w.status}${w.drainingAt ? "  draining" : ""}  capacity=${w.capacity}  credential=v${w.credentialVersion ?? 1}${w.local ? "  controller-local" : ""}`,
      );
      return 0;
    }
    if (sub === "drain" || sub === "resume") {
      const { worker } = await post<WorkerDrainResult>(
        `/workers/${idPath(arg(0, "yardId"))}/${sub}`,
      );
      print(
        worker,
        `${worker.id}  ${worker.name}  ${worker.drainingAt ? "draining; active work and queued affinity preserved" : "dispatch resumed after authenticated readiness checks"}`,
      );
      return 0;
    }
    if (sub === "rotate") {
      if (!flagBool(flags, "confirmed-stopped"))
        throw new UsageError(
          "Stop the old worker and reconcile its effects before passing --confirmed-stopped. Rotation does not prove the host stopped.",
        );
      const body: WorkerKeyRotation = {
        expectedCredentialVersion: positive(
          flagString(flags, "from-version"),
          "from-version",
        ),
        confirmedStopped: true,
      };
      const result = await post<WorkerKeyRotationResult>(
        `/workers/${idPath(arg(0, "yardId"))}/rotate`,
        body,
      );
      if (json) io.out(JSON.stringify(result));
      else {
        io.out(
          `${result.worker.id}  credential=v${result.worker.credentialVersion}  offline and draining; ${result.interruptedRunIds.length} attempts require reconciliation.\nReplace the private worker environment manually, reconnect, then resume dispatch. The SSH installer refuses differing existing configuration.\nReplacement worker key (shown once; save privately):`,
        );
        io.out(result.key);
      }
      return 0;
    }
    if (sub === "revoke") {
      const result = await post<WorkerRecord>(
        `/workers/${idPath(arg(0, "yardId"))}/revoke`,
      );
      print(result, `${result.id}  ${result.status}`);
      return 0;
    }
    const result = await post<{ worker: WorkerRecord; key: string }>(
      "/workers",
      {
        name: arg(0, "name"),
        capacity: positive(flagString(flags, "capacity"), "capacity", 1),
        labels: (flagString(flags, "labels") ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      },
    );
    if (json) io.out(JSON.stringify(result));
    else {
      io.out(
        `${result.worker.id}  ${result.worker.name}\nWorker key (shown once; save privately):`,
      );
      io.out(result.key);
    }
    return 0;
  }
  if (command === "profile") {
    if (sub === "ls") {
      list(
        (await workspace()).profiles,
        (p) =>
          `${p.id}  v${p.version}  ${p.name}  ${p.mode}${p.revokedAt ? "  revoked" : ""}`,
      );
      return 0;
    }
    if (sub === "revoke") {
      const version = flagString(flags, "version");
      const result = await post<StoredProfile>(
        `/profiles/${idPath(arg(0, "profileId"))}/revoke`,
        version ? { version: positive(version, "version") } : {},
      );
      print(result, `${result.id}  v${result.version}  revoked`);
      return 0;
    }
    const input = await readInput(flagString(flags, "file"));
    if (sub === "revise")
      input.expectedBaseVersion = positive(flagString(flags, "base"), "base");
    const result = await post<StoredProfile>(
      sub === "new"
        ? "/profiles"
        : `/profiles/${idPath(arg(0, "profileId"))}/revisions`,
      input,
    );
    print(
      result,
      `${result.id}  v${result.version}  ${result.name} (assign explicitly; existing threads retain their revision)`,
    );
    return 0;
  }
  if (command === "task") {
    if (sub === "ls") {
      let tasks = (await workspace()).tasks;
      const parent = flagString(flags, "parent");
      if (parent) tasks = tasks.filter((t) => t.parentThreadId === parent);
      list(
        tasks,
        (t) =>
          `${t.id}  ${t.status}  ${t.title}  mower=${t.mowerId}  thread=${t.threadId}`,
      );
      return 0;
    }
    const result =
      sub === "delegate"
        ? await post<{
            task: TaskRecord;
            thread: ThreadRecord;
            run: ControlRun;
          }>("/tasks", {
            parentThreadId: arg(0, "parentThreadId"),
            goal: arg(1, "goal"),
            mowerId: flagString(flags, "mower"),
            name: flagString(flags, "name"),
            requestId: requestId(),
          })
        : await post<{ task: TaskRecord }>(
            `/tasks/${idPath(arg(0, "taskId"))}/handoff`,
            { mowerId: arg(1, "mowerId"), requestId: requestId() },
          );
    print(result, JSON.stringify(result));
    return 0;
  }
  if (command === "connector") {
    if (sub === "ls") {
      list(
        (await workspace()).connections,
        (c) =>
          `${c.id}  ${c.name}  ${c.enabled === false ? "disabled" : "enabled"}  ${c.url}  tools=${c.tools?.length ?? 0}`,
      );
      return 0;
    }
    const result =
      sub === "add"
        ? await post<BrokerConnection>(
            "/connections",
            await readInput(flagString(flags, "file")),
          )
        : sub === "discover"
          ? await post<BrokerConnection>(
              `/connections/${idPath(arg(0, "connectionId"))}/discover`,
            )
          : await client.control<BrokerConnection>(
              `/connections/${idPath(arg(0, "connectionId"))}`,
              { method: "PATCH", body: { enabled: false } },
            );
    print(result);
    return 0;
  }
  if (command === "advice" && sub === "get") {
    const result = await get<AdviceResult>(
      `/advice/${idPath(arg(0, "runId"))}`,
    );
    print(result);
    return 0;
  }
  if (command === "approval" && sub === "ls") {
    list(
      (await workspace()).approvals,
      (a) =>
        `${a.id}  ${a.status}  ${a.action.operation}  ${a.action.resource}  thread=${a.action.threadId}\n${a.detail ?? "Action preview unavailable"}`,
    );
    return 0;
  }
  if (command === "approval" && (sub === "allow" || sub === "deny")) {
    const id = arg(0, "approvalId");
    if (sub === "allow") {
      const approval = (await workspace()).approvals.find((a) => a.id === id);
      if (!approval?.detail)
        throw new UsageError(
          "Allow once requires an inspectable action preview; use approval ls to review the exact request first",
        );
    }
    const result = await post<ControlApproval>(`/approvals/${idPath(id)}`, {
      decision: sub === "allow" ? "approve" : "deny",
      ...(sub === "deny"
        ? {
            feedback: flagString(flags, "feedback"),
            continuation: flagBool(flags, "stop")
              ? "stop"
              : flagString(flags, "feedback")
                ? "replan"
                : undefined,
          }
        : {}),
    });
    print(result);
    return 0;
  }
  const result = await post<{ thread: ThreadRecord; run: ControlRun }>(
    `/approvals/${idPath(arg(0, "approvalId"))}/advice`,
    { feedback: arg(1, "feedback"), requestId: requestId() },
  );
  print(
    result,
    `Advice queued: thread=${result.thread.id} run=${result.run.id}. No permission was granted.`,
  );
  return 0;
}
