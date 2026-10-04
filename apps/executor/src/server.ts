import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AgentEvent, ExecutorRunRequest } from "@laun/protocol";
import { runGoose, type GooseRunOptions, type GooseRunResult } from "@laun/acp";
import { checkBearer } from "@laun/protocol";
import type { ExecutorConfig, ExecutorMode } from "./config.js";
import { clampTimeout, ensureWorkdir, resolveSessionDir, resolveWorkdir, assertValidPrompt, assertValidSessionId } from "./paths.js";
import { runPiStreaming } from "./pi.js";
import {
  CliSandboxRunner,
  connectSandboxSurface,
  DEFAULT_SANDBOX_MAX_IDLE_MS,
  SANDBOX_WORKDIR,
  SandboxReaper,
  sandboxSessionDirForSession,
  SdkSandboxRunner,
  type SandboxRunner,
} from "./sandbox.js";
import {
  DEFAULT_RECOVERY_ATTEMPTS,
  DEFAULT_RECOVERY_BACKOFF_MS,
  recoveryExhaustedMessage,
  retryingMessage,
  runWithRecovery,
} from "./recovery.js";
import { RpcManager } from "./rpc.js";

interface JsonActive {
  controller: AbortController;
  send: (e: AgentEvent) => void;
  gen: object;
}

interface RpcActive {
  controller: AbortController;
  send: (e: AgentEvent) => void;
  gen: object;
}

/**
 * Goose ACP run seam: `typeof runGoose` (packages/acp, read-only — import
 * shapes only, never edit). Tests inject a stub; production uses the real
 * adapter. GooseConfig lives on the options (`opts.config`).
 */
export type GooseRunner = typeof runGoose;
export type { GooseRunOptions, GooseRunResult };

export interface HandlerDeps {
  /** Injected goose runner (tests). Production wires `runGoose` here. */
  gooseRunner?: GooseRunner;
}

/** Runtime requested for one run. `pi` is the default; validated per run. */
export type RequestedRuntime = "pi" | "goose" | "dots";

/**
 * Validate the `repo` field of a run request. Returns the trimmed clone
 * source, or undefined when absent. Throws a 400-status error for bad
 * shapes (non-strings, control bytes, option-injection `-` prefixes).
 * URL-vs-path classification happens in checkoutRepo.
 */
export function normalizeRepo(repo: unknown): string | undefined {
  if (repo === undefined || repo === null) return undefined;
  const bad = (msg: string): Error => Object.assign(new Error(msg), { status: 400 });
  if (typeof repo !== "string") throw bad("invalid repo (must be a cloneable URL or local path)");
  const src = repo.trim();
  if (!src) throw bad("invalid repo (must be a cloneable URL or local path)");
  if (src.length > 2000) throw bad("invalid repo (max 2000 chars)");
  if (src.startsWith("-")) throw bad("invalid repo (must be a cloneable URL or local path)");
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(src)) throw bad("invalid repo (must be a cloneable URL or local path)");
  return src;
}

const REPO_URL_RE = /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)/i;
const REPO_SCP_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:.+/;

/** Explicit bound for the repo clone spawn (no hanging on dead remotes). */
export const REPO_CLONE_TIMEOUT_MS = 120_000;

/**
 * Check out `src` into `workdir` BEFORE the agent starts. URLs (and
 * scp-like `user@host:path`) are shallow-cloned (`git clone --depth 1`,
 * no shell, `--` separator, explicit timeout); anything else must be an
 * existing local directory (clone source) — `..` escapes and missing
 * paths are refused. Everything lands under `workdir` (never joined into
 * it). A populated workdir is already checked out (idempotent skip, so
 * re-runs never fail). Throws 400-status for bad shapes, 500-status for
 * clone failures — both fail the run loudly before any agent spawns.
 */
export function checkoutRepo(workdir: string, src: string): void {
  const fail = (status: number, msg: string): Error => Object.assign(new Error(msg), { status });
  const isUrl = REPO_URL_RE.test(src) || REPO_SCP_RE.test(src) || src.startsWith("git@");
  if (!isUrl) {
    // Local path: refuse escapes outright, then require an existing dir.
    if (src.includes("..")) throw fail(400, "invalid repo (path escapes workdir)");
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(src);
    } catch {
      throw fail(400, "invalid repo (must be a cloneable URL or local path)");
    }
    if (!st.isDirectory()) throw fail(400, "invalid repo (must be a cloneable URL or local path)");
  }
  let entries: string[];
  try {
    entries = readdirSync(workdir);
  } catch {
    entries = [];
  }
  if (entries.length > 0) return; // already checked out
  const r = spawnSync("git", ["clone", "--depth", "1", "--", src, workdir], {
    encoding: "utf8",
    timeout: REPO_CLONE_TIMEOUT_MS,
  });
  if (r.error) {
    throw fail(500, `failed to checkout repo: ${(r.error as Error).message}`);
  }
  if (r.status !== 0) {
    const detail = (r.stderr || "").trim().split("\n").slice(-5).join("\n");
    throw fail(500, `failed to checkout repo (exit ${r.status})${detail ? `: ${detail}` : ""}`);
  }
}

export function createHandler(cfg: ExecutorConfig, deps: HandlerDeps = {}) {
  const busy = new Set<string>();
  // Per-run generation token: guards the early busy.delete in handleAbort
  // against clobbering a newer generation. handleRun sets it synchronously
  // with busy.add; each stream's finally only frees slots still owned by
  // its own generation, so an aborted run's delayed close can never delete
  // the next run's busy/active entries.
  const busyGen = new Map<string, object>();
  const mode: ExecutorMode = (cfg as Partial<ExecutorConfig>).executorMode ?? "json";
  const rpcIdleTtlMs = (cfg as Partial<ExecutorConfig>).rpcIdleTtlMs ?? 300_000;
  // Sandbox mode: one sandbox per session, pi spawned inside it. Disabled
  // passes undefined and every spawn stays a direct host child (unchanged).
  // The CLI runner stays for one-shot json (and for rpc when the SDK is not
  // configured); the SDK runner keeps the CLI lifecycle but streams rpc
  // through `execInteractive` when an SDK gateway endpoint is configured.
  const cliRunner: SandboxRunner | undefined = cfg.openshellEnabled
    ? new CliSandboxRunner({
        bin: cfg.openshellBin ?? "openshell",
        image: cfg.sandboxImage ?? "",
        policyFile: cfg.sandboxPolicyFile ?? "",
        providers: cfg.sandboxProviders ?? [],
        approvalMode: cfg.sandboxApprovalMode ?? "",
      })
    : undefined;
  const sdkRunner: SandboxRunner | undefined =
    cfg.openshellEnabled && (cfg.sdkGateway ?? "").trim()
      ? new SdkSandboxRunner({
          bin: cfg.openshellBin ?? "openshell",
          image: cfg.sandboxImage ?? "",
          policyFile: cfg.sandboxPolicyFile ?? "",
          providers: cfg.sandboxProviders ?? [],
          approvalMode: cfg.sandboxApprovalMode ?? "",
          connect: () =>
            connectSandboxSurface({
              gateway: (cfg.sdkGateway ?? "").trim(),
              token: cfg.sdkToken ?? "",
              clientCertFile: cfg.sdkClientCertFile ?? "",
              clientKeyFile: cfg.sdkClientKeyFile ?? "",
              caFile: cfg.sdkCaFile ?? "",
              insecure: cfg.sdkInsecure ?? false,
            }),
        })
      : undefined;
  // Selection: SDK for rpc when configured, CLI otherwise. One-shot json
  // always stays on the CLI path. Either way a failure rejects loudly —
  // never a silent fallback to unsandboxed.
  const rpcRunner = sdkRunner ?? cliRunner;
  // Age reaper: time-based delete of long-idle sandboxes (there is no
  // gateway session-delete API). Activity persists host-side in the session
  // dir so restarts neither leak nor prematurely delete.
  const reaper: SandboxReaper | undefined = cliRunner
    ? new SandboxReaper({
        runner: cliRunner,
        maxIdleMs: cfg.sandboxMaxIdleMs ?? DEFAULT_SANDBOX_MAX_IDLE_MS,
        metaFile: join(cfg.sessionDir, ".sandbox-meta.json"),
      })
    : undefined;
  const rpc = new RpcManager({
    piBin: cfg.piBin,
    openshellPrefix: cfg.openshellPrefix,
    idleTtlMs: rpcIdleTtlMs,
    approvalTimeoutMs: (cfg as Partial<ExecutorConfig>).approvalTimeoutMs ?? 300_000,
    sandboxRunner: rpcRunner,
    reaper,
  });
  const jsonActive = new Map<string, JsonActive>();
  const rpcActive = new Map<string, RpcActive>();
  /** Live goose/dots runs by session (abort + steer-409 routing). */
  const gooseActive = new Map<string, JsonActive>();
  /**
   * Goose permission requests seen on the stream, keyed by session then
   * request id. The ACP adapter fail-closes immediately (cancelled), so
   * these only exist so POST /approvals can acknowledge the human decision
   * (200) instead of 404ing on a request the gateway still shows pending.
   * True allow-gating needs an adapter approval hook (integration request).
   */
  const goosePending = new Map<string, Map<string, number>>();
  // Additive recovery config: absent fields (older callers/tests) fall back
  // to the defaults, and 0 retries keeps the exact pre-recovery behaviour.
  const recoveryAttempts = (cfg as Partial<ExecutorConfig>).recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
  const recoveryBackoffMs = (cfg as Partial<ExecutorConfig>).recoveryBackoffMs ?? DEFAULT_RECOVERY_BACKOFF_MS;

  function isKnownIdleSession(sessionId: string): boolean {
    if (rpc.has(sessionId)) return true;
    try {
      return existsSync(resolveSessionDir(cfg.sessionDir, sessionId));
    } catch {
      return false;
    }
  }

  async function handleRun(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!checkBearer(req.headers.get("authorization"), cfg.gatewayToken)) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: ExecutorRunRequest;
    try {
      body = (await req.json()) as ExecutorRunRequest;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    try {
      assertValidSessionId(body.sessionId);
      assertValidPrompt(body.prompt);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 200)) {
      return json({ error: "invalid model" }, 400);
    }
    const raw = body as ExecutorRunRequest & { repo?: unknown; runtime?: unknown };
    const requestedRuntime: unknown = raw.runtime ?? "pi";
    if (requestedRuntime !== "pi" && requestedRuntime !== "goose" && requestedRuntime !== "dots") {
      return json({ error: 'runtime must be "pi"|"goose"|"dots"' }, 400);
    }
    const runtime: RequestedRuntime = requestedRuntime;
    let repoSrc: string | undefined;
    try {
      repoSrc = normalizeRepo(raw.repo);
    } catch (e) {
      return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 400);
    }
    if (busy.has(body.sessionId)) return json({ error: "session already running" }, 409);
    let hostWorkdir: string;
    try {
      hostWorkdir = resolveWorkdir(cfg.sessionDir, body.sessionId);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    ensureWorkdir(hostWorkdir);
    // Repo checkout precedes the busy slot: a bad repo or failed clone
    // fails loudly (400/500) without ever wedging the session.
    if (repoSrc !== undefined) {
      try {
        checkoutRepo(hostWorkdir, repoSrc);
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
    }

    busy.add(body.sessionId);
    const gen: object = {};
    busyGen.set(body.sessionId, gen);
    // A synchronous throw between busy.add and the stream's try (e.g. a
    // ReadableStream construction failure) must never wedge the slot.
    try {
      const timeoutMs = clampTimeout(body.timeoutMs, cfg.defaultTimeoutMs);
      const model = body.model?.trim() || cfg.defaultModel;
      // Sandbox mode: pi's session files and cwd live INSIDE the sandbox
      // (host /data is invisible there). The host workdir remains only as
      // the CLI spawn cwd and the context-upload source.
      const sandboxMode = cliRunner !== undefined;
      const piSessionDir = sandboxMode
        ? sandboxSessionDirForSession(body.sessionId)
        : resolveSessionDir(cfg.sessionDir, body.sessionId);
      const uploadFrom = sandboxMode ? hostWorkdir : undefined;
      if (runtime === "goose" || runtime === "dots") {
        return runGooseStream(body.sessionId, body.prompt, hostWorkdir, model, timeoutMs, gen);
      }
      if (mode === "rpc") {
        return runRpcStream(body.sessionId, body.prompt, hostWorkdir, piSessionDir, uploadFrom, model, timeoutMs, gen);
      }
      return runJsonStream(body.sessionId, body.prompt, hostWorkdir, piSessionDir, uploadFrom, model, timeoutMs, gen);
    } catch (e) {
      if (busyGen.get(body.sessionId) === gen) busyGen.delete(body.sessionId);
      busy.delete(body.sessionId);
      return json({ error: (e as Error).message || "run failed to start" }, 500);
    }
  }

  function runJsonStream(
    sessionId: string,
    prompt: string,
    hostWorkdir: string,
    piSessionDir: string,
    uploadFrom: string | undefined,
    model: string,
    timeoutMs: number,
    gen: object,
  ): Response {
    // The consumer (gateway) may disconnect mid-run. Writing to a closed
    // controller throws, and an uncaught throw here used to take down the
    // whole executor process — taking every in-flight run with it.
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (e: AgentEvent) => {
          if (closed) return;
          try {
            controller.enqueue(JSON.stringify(e) + "\n");
          } catch {
            closed = true; // consumer gone: keep the run alive, stop writing
          }
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the consumer
          }
        };
        const aborter = new AbortController();
        // If a newer generation already owns the slot (abort raced start),
        // do not run: the abort cancelled this generation before it began.
        if (busyGen.get(sessionId) !== gen) {
          finish();
          return;
        }
        const myActive = { controller: aborter, send, gen };
        jsonActive.set(sessionId, myActive);
        send({ type: "status", sessionId, status: "running", message: `model ${model}` });
        try {
          // Recovery: re-spawn pi with the same --session-id (history
          // persists in pi's session dir) and a continuation prompt. The
          // shared deadline bounds every attempt plus backoff, and an
          // operator abort stops the loop immediately (never resurrected).
          // Attempts are sequential: runPiStreaming only resolves after its
          // child closes, so no attempt leaks a process into the next.
          const deadline = Date.now() + timeoutMs;
          const loop = await runWithRecovery({
            maxRetries: recoveryAttempts,
            backoffMs: recoveryBackoffMs,
            timeoutMs,
            deadline,
            signal: aborter.signal,
            initialPrompt: prompt,
            onRetrying: (retryIndex, maxRetries, firstError) =>
              send({ type: "status", sessionId, status: "running", message: retryingMessage(retryIndex, maxRetries, firstError) }),
            attempt: async (attemptPrompt, budget) => {
              let firstError: string | null = null;
              const result = await runPiStreaming({
                sessionId,
                piSessionDir,
                workdir: hostWorkdir,
                sandboxWorkdir: cliRunner ? SANDBOX_WORKDIR : undefined,
                uploadFrom,
                model,
                prompt: attemptPrompt,
                piBin: cfg.piBin,
                openshellPrefix: cfg.openshellPrefix,
                timeoutMs: budget,
                sandboxRunner: cliRunner,
                reaper,
                onEvent: (e) => {
                  if (e.type === "error" && firstError === null) firstError = e.message;
                  send(e);
                },
                signal: aborter.signal,
              });
              return {
                sawError: result.sawError,
                sawDone: result.sawDone,
                aborted: aborter.signal.aborted,
                firstError,
                exitCode: result.exitCode,
              };
            },
          });
          // pi --mode json can exit 0 with a failed assistant response, so the
          // event stream (not the exit code) decides success.
          if (loop.aborted) {
            send({ type: "status", sessionId, status: "error", message: "run aborted" });
          } else if (loop.totalRuns > 1 && (loop.sawError || !loop.sawDone)) {
            send({
              type: "status",
              sessionId,
              status: "error",
              message: recoveryExhaustedMessage(loop.totalRuns, loop.firstError ?? "unknown error"),
            });
          } else if (loop.sawError || loop.exitCode !== 0) {
            send({
              type: "status",
              sessionId,
              status: "error",
              message: loop.exitCode === null ? "run failed (no exit code)" : `run exited ${loop.exitCode}`,
            });
          } else {
            send({ type: "status", sessionId, status: "done" });
          }
        } catch (e) {
          send({ type: "error", sessionId, message: (e as Error).message });
        } finally {
          // Generation guard: an aborted run's delayed close must never
          // delete the next run's entries. Only free slots we still own.
          if (busyGen.get(sessionId) === gen) {
            busyGen.delete(sessionId);
            if (jsonActive.get(sessionId) === myActive) jsonActive.delete(sessionId);
            busy.delete(sessionId);
          } else if (jsonActive.get(sessionId) === myActive) {
            jsonActive.delete(sessionId);
          }
          finish();
        }
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
    });
  }

  function runRpcStream(
    sessionId: string,
    prompt: string,
    hostWorkdir: string,
    piSessionDir: string,
    uploadFrom: string | undefined,
    model: string,
    timeoutMs: number,
    gen: object,
  ): Response {
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (e: AgentEvent) => {
          if (closed) return;
          try {
            controller.enqueue(JSON.stringify(e) + "\n");
          } catch {
            closed = true; // consumer gone: keep the run alive, stop writing
          }
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the consumer
          }
        };
        const aborter = new AbortController();
        if (busyGen.get(sessionId) !== gen) {
          finish();
          return;
        }
        const myActive = { controller: aborter, send, gen };
        rpcActive.set(sessionId, myActive);
        send({ type: "status", sessionId, status: "running", message: `model ${model}` });
        try {
          // Recovery: re-issue a continuation prompt through the same
          // long-lived rpc child (respawned transparently if it died).
          // Same shared-deadline and abort rules as json mode.
          const deadline = Date.now() + timeoutMs;
          const loop = await runWithRecovery({
            maxRetries: recoveryAttempts,
            backoffMs: recoveryBackoffMs,
            timeoutMs,
            deadline,
            signal: aborter.signal,
            initialPrompt: prompt,
            onRetrying: (retryIndex, maxRetries, firstError) =>
              send({ type: "status", sessionId, status: "running", message: retryingMessage(retryIndex, maxRetries, firstError) }),
            attempt: async (attemptPrompt, budget) => {
              let firstError: string | null = null;
              const r = await rpc.run({
                sessionId,
                piSessionDir,
                workdir: hostWorkdir,
                sandboxWorkdir: rpcRunner ? SANDBOX_WORKDIR : undefined,
                uploadFrom,
                model,
                prompt: attemptPrompt,
                timeoutMs: budget,
                onEvent: (e) => {
                  if (e.type === "error" && firstError === null) firstError = e.message;
                  send(e);
                },
              });
              return {
                sawError: r.sawError,
                sawDone: r.sawDone,
                aborted: r.aborted || aborter.signal.aborted,
                firstError,
                timedOut: r.timedOut,
              };
            },
          });
          // Success is decided by the event stream, never the exit code: the
          // long-lived child stays alive across runs, so there is no exit code
          // to check. agent_settled (sawDone) is the only completion signal.
          if (loop.aborted || loop.timedOut || loop.sawError || !loop.sawDone) {
            if (loop.aborted) {
              // The "aborted by user" status was already emitted by abort();
              // close with a terminal error so clients never see a bare done.
              send({ type: "status", sessionId, status: "error", message: "run aborted" });
            } else if (loop.totalRuns > 1) {
              send({
                type: "status",
                sessionId,
                status: "error",
                message: recoveryExhaustedMessage(loop.totalRuns, loop.firstError ?? "unknown error"),
              });
            } else if (loop.timedOut) {
              send({ type: "status", sessionId, status: "error", message: "run timed out" });
            } else if (loop.sawError) {
              send({ type: "status", sessionId, status: "error", message: "run failed" });
            } else {
              send({ type: "status", sessionId, status: "error", message: "run failed (no completion)" });
            }
          } else {
            send({ type: "status", sessionId, status: "done" });
          }
        } catch (e) {
          send({ type: "error", sessionId, message: (e as Error).message });
        } finally {
          if (busyGen.get(sessionId) === gen) {
            busyGen.delete(sessionId);
            if (rpcActive.get(sessionId) === myActive) rpcActive.delete(sessionId);
            busy.delete(sessionId);
          } else if (rpcActive.get(sessionId) === myActive) {
            rpcActive.delete(sessionId);
          }
          finish();
        }
      },
      cancel() {
        closed = true;
        // Gateway disconnect must never hang a parked run: deny every
        // pending approval so pi proceeds. The run itself continues.
        try {
          rpc.denyAllPending(sessionId, "gateway disconnect");
        } catch {
          // teardown paths must never throw
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
    });
  }

  function runGooseStream(
    sessionId: string,
    prompt: string,
    hostWorkdir: string,
    model: string,
    timeoutMs: number,
    gen: object,
  ): Response {
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (e: AgentEvent) => {
          if (closed) return;
          try {
            controller.enqueue(JSON.stringify(e) + "\n");
          } catch {
            closed = true; // consumer gone: keep the run alive, stop writing
          }
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the consumer
          }
        };
        const aborter = new AbortController();
        if (busyGen.get(sessionId) !== gen) {
          finish();
          return;
        }
        const myActive = { controller: aborter, send, gen };
        gooseActive.set(sessionId, myActive);
        send({ type: "status", sessionId, status: "running", message: `model ${model}` });
        try {
          const runner = deps.gooseRunner ?? runGoose;
          const baseUrl = (cfg as Partial<ExecutorConfig>).gooseUrl ?? "";
          const secret = (cfg as Partial<ExecutorConfig>).gooseSecret ?? "";
          if (!baseUrl || !secret) {
            throw new Error("goose runtime not configured (set GOOSE_URL and GOOSE_SECRET)");
          }
          const onEvent = (e: AgentEvent) => {
            // Track permission requests so POST /approvals acknowledges
            // them; the adapter already fail-closed, so this only records.
            if (e.type === "approval_request") {
              let per = goosePending.get(sessionId);
              if (!per) {
                per = new Map();
                goosePending.set(sessionId, per);
              }
              per.set(e.requestId, Date.now());
            }
            send(e);
          };
          const r = await runner({
            config: { baseUrl, secret, workdir: hostWorkdir },
            sessionId,
            prompt,
            model,
            timeoutMs,
            onEvent,
            signal: aborter.signal,
          });
          if (r.aborted || aborter.signal.aborted) {
            send({ type: "status", sessionId, status: "error", message: "run aborted" });
          } else if (r.timedOut) {
            send({ type: "status", sessionId, status: "error", message: "run timed out" });
          } else if (r.sawError || !r.sawDone) {
            send({ type: "status", sessionId, status: "error", message: "run failed" });
          } else {
            send({ type: "status", sessionId, status: "done" });
          }
        } catch (e) {
          send({ type: "error", sessionId, message: (e as Error).message });
        } finally {
          // Stale-permission guard: the adapter fail-closed at request
          // time, so entries here only exist to ack mid-run decisions.
          // Drop the whole session entry when the run ends — a late POST
          // /approvals for a finished run must 404, never 200-ack dead.
          goosePending.delete(sessionId);
          if (busyGen.get(sessionId) === gen) {
            busyGen.delete(sessionId);
            if (gooseActive.get(sessionId) === myActive) gooseActive.delete(sessionId);
            busy.delete(sessionId);
          } else if (gooseActive.get(sessionId) === myActive) {
            gooseActive.delete(sessionId);
          }
          finish();
        }
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
    });
  }

  async function handleAbort(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!checkBearer(req.headers.get("authorization"), cfg.gatewayToken)) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
    try {
      if (typeof sessionId !== "string") throw new Error("invalid sessionId (1-64 chars, A-Z a-z 0-9 _ -)");
      assertValidSessionId(sessionId);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    if (!busy.has(sessionId)) {
      if (isKnownIdleSession(sessionId)) return json({ error: "session not running" }, 409);
      return json({ error: "unknown session" }, 404);
    }
    // Goose/dots runs live outside the pi modes: abort via their signal.
    const goose = gooseActive.get(sessionId);
    if (goose) {
      try {
        goose.send({ type: "status", sessionId, status: "error", message: "aborted by user" });
      } catch {
        // consumer gone; still terminate the run below
      }
      try {
        goose.controller.abort();
      } catch {
        // already exited
      }
      busy.delete(sessionId);
      if (gooseActive.get(sessionId) === goose) gooseActive.delete(sessionId);
      return json({ ok: true });
    }
    // Active run: terminate the agent child for that session, emit the abort
    // event on its stream, and release the busy slot. Never leave busy set.
    // Generation tokens stay until each stream's finally: an early busy.delete
    // makes a 200 mean the slot is free, while the finally's gen check stops
    // a delayed close from deleting the next generation's entries.
    if (mode === "rpc") {
      const active = rpcActive.get(sessionId);
      if (!active) {
        const ok = rpc.abort(sessionId);
        if (!ok) {
          // Desync guard: busy said running but the rpc child had no live run
          // (already settled or never started). Release the slot anyway and
          // cancel any pending start holding this generation.
          busy.delete(sessionId);
          busyGen.delete(sessionId);
          return json({ error: "session not running" }, 409);
        }
        // rpc.abort() resolves the run; the stream's finally releases the
        // generation, but release busy here too so a 200 always means the
        // slot is free, even if the stream close is still in flight.
        busy.delete(sessionId);
        return json({ ok: true });
      }
      // Signal the recovery loop first: it must never start another attempt
      // after an operator abort, including while parked in backoff.
      try {
        active.controller.abort();
      } catch {
        // already aborted
      }
      const ok = rpc.abort(sessionId);
      if (!ok) {
        // No live run to resolve (between recovery attempts): announce the
        // abort here — rpc.abort() only announces when it resolves a run.
        // The loop observes the signal, skips further attempts, and the
        // stream still closes with a terminal "run aborted".
        try {
          active.send({ type: "status", sessionId, status: "error", message: "aborted by user" });
        } catch {
          // consumer gone; the loop still needs to stop
        }
      }
      busy.delete(sessionId);
      return json({ ok: true });
    }
    const active = jsonActive.get(sessionId);
    if (active) {
      try {
        active.send({ type: "status", sessionId, status: "error", message: "aborted by user" });
      } catch {
        // consumer gone; still terminate the child below
      }
      try {
        active.controller.abort();
      } catch {
        // already exited
      }
      busy.delete(sessionId);
      // Only remove our own generation's entry: a concurrent new run
      // overwrites the map with a different object that must survive.
      if (jsonActive.get(sessionId) === active) jsonActive.delete(sessionId);
      return json({ ok: true });
    }
    busy.delete(sessionId);
    busyGen.delete(sessionId);
    return json({ ok: true });
  }

  /**
   * POST /steer {sessionId, text}: redirect the live run via pi's rpc
   * `steer` (delivered after the current turn, before the next LLM call).
   * 200 when a live run consumed it, 409 when the session is known but has
   * no live (or no steerable) run, 404 {"error":"unknown session"} for
   * unknown ids. Steer never starts a run. The steered text is announced
   * on the run's event stream; the run continues with no other effects.
   */
  async function handleSteer(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!checkBearer(req.headers.get("authorization"), cfg.gatewayToken)) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
    const text = (body as { text?: unknown } | null)?.text;
    try {
      if (typeof sessionId !== "string") throw new Error("invalid sessionId (1-64 chars, A-Z a-z 0-9 _ -)");
      assertValidSessionId(sessionId);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    if (typeof text !== "string" || !text.trim()) return json({ error: "text is required" }, 400);
    if (text.length > 8000) return json({ error: "text too long (max 8000 chars)" }, 400);
    if (!busy.has(sessionId)) {
      if (isKnownIdleSession(sessionId)) return json({ error: "session not running" }, 409);
      return json({ error: "unknown session" }, 404);
    }
    // Only rpc-pi runs are steerable: json one-shots and goose runs have
    // no steer mechanism — 409 with a clear message, never silent.
    if (jsonActive.has(sessionId)) {
      return json({ error: "steer not supported in json mode (no live steerable run)" }, 409);
    }
    if (gooseActive.has(sessionId)) {
      return json({ error: "steer not supported for goose runtime" }, 409);
    }
    const ok = rpc.steer(sessionId, text);
    if (!ok) {
      // Desync: busy said running but the rpc child has no live run
      // (e.g. between recovery attempts). Same shape as abort's guard.
      if (isKnownIdleSession(sessionId)) return json({ error: "session not running" }, 409);
      return json({ error: "unknown session" }, 404);
    }
    try {
      rpcActive.get(sessionId)?.send({
        type: "status",
        sessionId,
        status: "running",
        message: `steered: ${text.slice(0, 200)}`,
      });
    } catch {
      // consumer gone; pi still got the steer
    }
    return json({ ok: true });
  }

  /**
   * POST /approvals {sessionId, requestId, decision}: deliver a pending
   * approval decision to the waiting run. 200 when delivered, 404 for
   * unknown sessions/requests. Pi-parked approvals answer via
   * `extension_ui_response`; goose permissions were already fail-closed by
   * the adapter, so their decision is only acknowledged (integration
   * request for true allow-gating — see handoff).
   */
  async function handleApprovals(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!checkBearer(req.headers.get("authorization"), cfg.gatewayToken)) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const rec = (body as { sessionId?: unknown; requestId?: unknown; decision?: unknown } | null) ?? {};
    try {
      if (typeof rec.sessionId !== "string") throw new Error("invalid sessionId (1-64 chars, A-Z a-z 0-9 _ -)");
      assertValidSessionId(rec.sessionId);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    const sessionId: string = rec.sessionId;
    if (typeof rec.requestId !== "string" || !rec.requestId) {
      return json({ error: "requestId is required" }, 400);
    }
    if (rec.decision !== "approve" && rec.decision !== "deny") {
      return json({ error: 'decision must be "approve"|"deny"' }, 400);
    }
    if (rpc.decideApproval(sessionId, rec.requestId, rec.decision)) {
      return json({ ok: true });
    }
    const per = goosePending.get(sessionId);
    if (per?.has(rec.requestId)) {
      per.delete(rec.requestId);
      return json({ ok: true });
    }
    if (busy.has(sessionId) || isKnownIdleSession(sessionId)) {
      return json({ error: "unknown approval request" }, 404);
    }
    return json({ error: "unknown session" }, 404);
  }

  function close(): void {
    try {
      rpc.close();
    } catch {
      // ignore during test teardown
    }
    try {
      reaper?.close();
    } catch {
      // ignore during test teardown
    }
  }

  return { busy, rpc, handleRun, handleAbort, handleSteer, handleApprovals, close };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
