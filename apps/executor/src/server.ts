import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ExecutorRunRequest } from "@laun/protocol";
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

export function createHandler(cfg: ExecutorConfig) {
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
    sandboxRunner: rpcRunner,
    reaper,
  });
  const jsonActive = new Map<string, JsonActive>();
  const rpcActive = new Map<string, RpcActive>();
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
    if (busy.has(body.sessionId)) return json({ error: "session already running" }, 409);
    let hostWorkdir: string;
    try {
      hostWorkdir = resolveWorkdir(cfg.sessionDir, body.sessionId);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    ensureWorkdir(hostWorkdir);

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

  return { busy, rpc, handleRun, handleAbort, close };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
