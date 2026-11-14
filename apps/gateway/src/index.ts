import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";
import { SessionStore } from "./store.js";
import { STREAMING_SERVE_OPTIONS } from "./serve.js";
import { createControl } from "./control.js";
import { isKeyPrincipalId, KeyStoreUnavailableError } from "./keys.js";

const cfg = loadConfig();
const control = createControl(cfg);
const gw = createGateway(cfg, new SessionStore(cfg.dataDir),undefined,{legacyEnabled:control.legacyEnabled});

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the browser UI from apps/gateway/public. Public by design: the assets
 * carry no secrets, and every API call behind them requires a bearer token.
 * Returns null when the path escapes publicDir or the file does not exist.
 */
function serveStatic(pathname: string): Response | null {
  const rel =
    pathname === "/" || pathname === "/app" || pathname === "/app/"
      ? "v2/index.html"
      : pathname.startsWith("/app/")
        ? `v2/${pathname.slice("/app/".length)}`
      : pathname === "/ui" || pathname === "/ui/"
      ? "index.html"
      : pathname.startsWith("/ui/")
        ? pathname.slice("/ui/".length)
        : null;
  if (!rel || rel.includes("\0")) return null;
  const base = resolve(cfg.publicDir);
  const file = resolve(join(base, rel));
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return new Response(readFileSync(file), {
      headers: {
        "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return null;
  }
}

const server=Bun.serve({
  port: cfg.port,
  hostname: process.env.GATEWAY_BIND ?? "127.0.0.1",
  maxRequestBodySize: 64 * 1024 * 1024,
  ...STREAMING_SERVE_OPTIONS,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return Response.json({ ok: true, service: "gateway", control: control.service.readiness() });
    }
    if (req.method === "GET" && (path === "/" || path === "/app" || path.startsWith("/app/") || path.startsWith("/ui/") || path === "/favicon.ico")) {
      const asset = serveStatic(path);
      if (asset) return asset;
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      return err("not found", 404);
    }

    let id: ReturnType<typeof gw.authenticate>;
    try { id = gw.authenticate(req); }
    catch (error) { if (error instanceof KeyStoreUnavailableError) return err(error.message, 503); throw error; }
    if (path.startsWith("/api/v2/")) {
      const principalId=id ? id.kind==="service"?"service":gw.keys.principalIdForKey(id.keyId) : null;
      return control.handle(req, id&&principalId ? { id:principalId,admin:id.kind==="service" } : null);
    }
    if (!id) return Response.json({ error: "unauthorized" }, { status: 401 });
    const serviceOnly = id.kind === "service";

    try {
      // Agent key management: service token only — a leaked agent key must not
      // be able to mint or revoke keys.
      if (path === "/keys" && req.method === "POST") {
        if (!serviceOnly) return err("service token required", 403);
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return err("invalid JSON body", 400);
        if (Object.keys(body).some((field) => field !== "label" && field !== "principalId")) return err("invalid key fields", 400);
        const { label, principalId } = body as { label?: unknown; principalId?: unknown };
        if (label !== undefined && (typeof label !== "string" || label.length > 64)) return err("invalid label", 400);
        if (principalId !== undefined && !isKeyPrincipalId(principalId)) return err("invalid principalId", 400);
        const { key, record } = gw.keys.add(typeof label === "string" ? label : "default", principalId);
        // The only place a key is ever returned. Never logged.
        return Response.json({ key, record }, { status: 201 });
      }
      if (path === "/keys" && req.method === "GET") {
        if (!serviceOnly) return err("service token required", 403);
        return Response.json({ keys: gw.keys.list() });
      }
      const km = path.match(/^\/keys\/([0-9a-f]{8,32})$/);
      if (km && req.method === "DELETE") {
        if (!serviceOnly) return err("service token required", 403);
        return Response.json({ ok: gw.keys.revoke(km![1]) });
      }

      // Legacy shared-key sessions are an explicit single-operator mode.
      if((path==="/sessions"||path.startsWith("/sessions/"))&&!control.legacyEnabled)return err("legacy sessions API disabled; use /api/v2 or explicitly enable LAUN_LEGACY_API for a single-operator installation",410);
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
      const m = path.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})(\/messages|\/events|\/log|\/approvals|\/abort)?$/);
      if (m) {
        const sessionId = m[1];
        const suffix = m[2] ?? "";
        const rec = gw.sessions.get(sessionId);
        if (!rec) return err("session not found", 404);

        if (suffix === "" && req.method === "DELETE") {
          await gw.deleteSession(sessionId, id.kind === "agent" ? id.label : "service");
          return Response.json({ ok: true });
        }
        if (suffix === "" && req.method === "GET") {
          return Response.json({ session: rec, pendingApprovals: gw.pendingApprovals(sessionId) });
        }
        if (suffix === "/messages" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (!body || typeof body !== "object") return err("invalid JSON body", 400);
          // sendMessage validates synchronously (404/400/409 surface as
          // throws); steer/queue outcomes ride along additively so old
          // clients ignoring the field see no change.
          const out = await gw.sendMessage(sessionId, body as never);
          return Response.json({ accepted: true, sessionId, outcome: out.outcome });
        }
        if (suffix === "/log" && req.method === "GET") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json({ sessionId, ...gw.log(sessionId, since) });
        }
        if (suffix === "/events" && req.method === "GET") {
          const bus = gw.busFor(sessionId);
          // Resume from a cursor so reconnects skip replay: ?since=N drops
          // the first N bus events (same indexing as GET /log). Defaults to
          // the full bus for first-time followers.
          const sinceRaw = Number(url.searchParams.get("since") ?? 0);
          const since = Number.isInteger(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const send = (e: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              for (const e of gw.log(sessionId, since).events) send(e);
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
          gw.decideApproval(sessionId, body as never, id.kind === "agent" ? id.label : "service");
          return Response.json({ ok: true });
        }
        if (suffix === "/abort" && req.method === "POST") {
          // Errors here carry {status} and fall through to the handler below.
          // "not_running" maps to 409 so `stop` on an idle session keeps its
          // old message and exit code; the executor was still asked (that is
          // the point: a wedged slot there is reachable even when the local
          // record says idle).
          const r = await gw.abort(sessionId, id.kind === "agent" ? id.label : "service");
          if (r === "not_running") return err("session not running", 409);
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

let stopping=false;
function shutdown(){
  if(stopping)return;stopping=true;server.stop(true);
  const deadline=setTimeout(()=>{console.error("[gateway] shutdown outcome remains interrupted; verify execution hosts before resuming");process.exit(1);},20_000);
  void (async()=>{
    try{
      await control.close();
      if(control.legacyEnabled)await Promise.allSettled(gw.sessions.list().filter(s=>["running","waiting_approval"].includes(s.status)).map(s=>gw.abort(s.id,"gateway shutdown")));
      clearTimeout(deadline);process.exit(0);
    }catch{clearTimeout(deadline);console.error("[gateway] shutdown requires operator reconciliation");process.exit(1);}
  })();
}
process.once("SIGTERM",shutdown);process.once("SIGINT",shutdown);
console.log(`[gateway] Laun control listening :${cfg.port}`);
