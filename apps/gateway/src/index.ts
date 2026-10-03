import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";

const cfg = loadConfig();
const gw = createGateway(cfg, new SessionStore(cfg.dataDir));

Bun.serve({
  port: cfg.port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return Response.json({ ok: true, service: "gateway", executor: cfg.executorUrl });
    }
    if (!gw.auth(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    try {
      // POST /sessions
      if (path === "/sessions" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") return err("invalid JSON body", 400);
        const rec = gw.createSession(body as never);
        return Response.json(rec, { status: 201 });
      }
      // GET /sessions
      if (path === "/sessions" && req.method === "GET") {
        return Response.json({ sessions: gw.sessions.list() });
      }
      const m = path.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})(\/messages|\/events|\/log|\/approvals)?$/);
      if (m) {
        const id = m[1];
        const suffix = m[2] ?? "";
        const rec = gw.sessions.get(id);
        if (!rec) return err("session not found", 404);

        if (suffix === "" && req.method === "GET") {
          return Response.json({ session: rec, pendingApprovals: gw.pendingApprovals(id) });
        }
        if (suffix === "/messages" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (!body || typeof body !== "object") return err("invalid JSON body", 400);
          gw.sendMessage(id, body as never);
          return Response.json({ accepted: true, sessionId: id });
        }
        if (suffix === "/log" && req.method === "GET") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ sessionId: id, ...gw.log(id, since) });
        }
        if (suffix === "/events" && req.method === "GET") {
          const bus = gw.busFor(id);
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const send = (e: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              for (const e of bus.events) send(e);
              const sub = (e: unknown) => send(e);
              bus.subs.add(sub);
              const hb = setInterval(() => controller.enqueue(enc.encode(`: hb\n\n`)), 15_000);
              req.signal.addEventListener("abort", () => {
                clearInterval(hb);
                bus.subs.delete(sub);
                controller.close();
              });
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
          });
        }
        if (suffix === "/approvals" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (!body || typeof body !== "object") return err("invalid JSON body", 400);
          gw.decideApproval(id, body as never);
          return Response.json({ ok: true });
        }
      }
      return err("not found", 404);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      return err((e as Error).message, status);
    }
  },
});

function err(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

console.log(`[gateway] listening :${cfg.port} -> executor ${cfg.executorUrl}`);
