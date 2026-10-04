import { existsSync } from "node:fs";
import type { AgentEvent, ExecutorRunRequest } from "@cloudbear/protocol";
import { checkBearer } from "@cloudbear/protocol";
import type { ExecutorConfig, ExecutorMode } from "./config.js";
import { clampTimeout, ensureWorkdir, resolveSessionDir, resolveWorkdir, assertValidPrompt, assertValidSessionId } from "./paths.js";
import { runPiStreaming } from "./pi.js";
import { RpcManager } from "./rpc.js";

interface JsonActive {
  controller: AbortController;
  send: (e: AgentEvent) => void;
}

export function createHandler(cfg: ExecutorConfig) {
  const busy = new Set<string>();
  const mode: ExecutorMode = (cfg as Partial<ExecutorConfig>).executorMode ?? "json";
  const rpcIdleTtlMs = (cfg as Partial<ExecutorConfig>).rpcIdleTtlMs ?? 300_000;
  const rpc = new RpcManager({ piBin: cfg.piBin, openshellPrefix: cfg.openshellPrefix, idleTtlMs: rpcIdleTtlMs });
  const jsonActive = new Map<string, JsonActive>();

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
    let workdir: string;
    try {
      workdir = resolveWorkdir(cfg.sessionDir, body.sessionId);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    ensureWorkdir(workdir);

    busy.add(body.sessionId);
    const timeoutMs = clampTimeout(body.timeoutMs, cfg.defaultTimeoutMs);
    const model = body.model?.trim() || cfg.defaultModel;
    if (mode === "rpc") {
      return runRpcStream(body.sessionId, body.prompt, workdir, model, timeoutMs);
    }
    return runJsonStream(body.sessionId, body.prompt, workdir, model, timeoutMs);
  }

  function runJsonStream(sessionId: string, prompt: string, workdir: string, model: string, timeoutMs: number): Response {
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
        jsonActive.set(sessionId, { controller: aborter, send });
        send({ type: "status", sessionId, status: "running", message: `model ${model}` });
        try {
          const result = await runPiStreaming({
            sessionId,
            piSessionDir: resolveSessionDir(cfg.sessionDir, sessionId),
            workdir,
            model,
            prompt,
            piBin: cfg.piBin,
            openshellPrefix: cfg.openshellPrefix,
            timeoutMs,
            onEvent: send,
            signal: aborter.signal,
          });
          // pi --mode json can exit 0 with a failed assistant response, so the
          // event stream (not the exit code) decides success.
          if (result.sawError || result.exitCode !== 0) {
            send({
              type: "status",
              sessionId,
              status: "error",
              message: result.exitCode === null ? "run failed (no exit code)" : `run exited ${result.exitCode}`,
            });
          } else {
            send({ type: "status", sessionId, status: "done" });
          }
        } catch (e) {
          send({ type: "error", sessionId, message: (e as Error).message });
        } finally {
          jsonActive.delete(sessionId);
          busy.delete(sessionId);
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

  function runRpcStream(sessionId: string, prompt: string, workdir: string, model: string, timeoutMs: number): Response {
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
        send({ type: "status", sessionId, status: "running", message: `model ${model}` });
        try {
          const result = await rpc.run({
            sessionId,
            piSessionDir: resolveSessionDir(cfg.sessionDir, sessionId),
            workdir,
            model,
            prompt,
            timeoutMs,
            onEvent: send,
          });
          // Success is decided by the event stream, never the exit code: the
          // long-lived child stays alive across runs, so there is no exit code
          // to check. agent_settled (sawDone) is the only completion signal.
          if (result.aborted || result.timedOut || result.sawError || !result.sawDone) {
            if (result.aborted) {
              // The "aborted by user" status was already emitted by abort();
              // close with a terminal error so clients never see a bare done.
              send({ type: "status", sessionId, status: "error", message: "run aborted" });
            } else if (result.timedOut) {
              send({ type: "status", sessionId, status: "error", message: "run timed out" });
            } else if (result.sawError) {
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
          busy.delete(sessionId);
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
    if (mode === "rpc") {
      const ok = rpc.abort(sessionId);
      if (!ok) {
        // Desync guard: busy said running but the rpc child had no live run
        // (already settled or never started). Release the slot anyway.
        busy.delete(sessionId);
        return json({ error: "session not running" }, 409);
      }
      // rpc.abort() resolves the run; the stream's finally releases busy, but
      // release it here too so a 200 always means the slot is free, even if the
      // stream close is still in flight. The finally delete is idempotent.
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
    }
    busy.delete(sessionId);
    jsonActive.delete(sessionId);
    return json({ ok: true });
  }

  function close(): void {
    try {
      rpc.close();
    } catch {
      // ignore during test teardown
    }
  }

  return { busy, rpc, handleRun, handleAbort, close };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
