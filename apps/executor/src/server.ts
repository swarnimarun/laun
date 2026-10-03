import type { AgentEvent, ExecutorRunRequest } from "@cloudbear/protocol";
import { checkBearer } from "@cloudbear/protocol";
import type { ExecutorConfig } from "./config.js";
import { clampTimeout, ensureWorkdir, resolveSessionDir, resolveWorkdir, assertValidPrompt, assertValidSessionId } from "./paths.js";
import { runPiStreaming } from "./pi.js";

const busy = new Set<string>();

export function createHandler(cfg: ExecutorConfig) {
  return {
    busy,
    async handleRun(req: Request): Promise<Response> {
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
      const stream = new ReadableStream({
        async start(controller) {
          const send = (e: AgentEvent) => controller.enqueue(JSON.stringify(e) + "\n");
          send({ type: "status", sessionId: body.sessionId, status: "running", message: `model ${model}` });
          try {
            await runPiStreaming({
              sessionId: body.sessionId,
              piSessionDir: resolveSessionDir(cfg.sessionDir, body.sessionId),
              workdir,
              model,
              prompt: body.prompt,
              piBin: cfg.piBin,
              openshellPrefix: cfg.openshellPrefix,
              timeoutMs,
              onEvent: send,
            });
            send({ type: "status", sessionId: body.sessionId, status: "done" });
          } catch (e) {
            send({ type: "error", sessionId: body.sessionId, message: (e as Error).message });
          } finally {
            busy.delete(body.sessionId);
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
      });
    },
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
