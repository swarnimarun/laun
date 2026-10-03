import { loadConfig } from "./config.js";
import { createHandler } from "./server.js";

const cfg = loadConfig();

const handler = createHandler(cfg);

Bun.serve({
  port: cfg.port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "executor",
        openshell: cfg.openshellEnabled,
        piBin: cfg.piBin,
        model: cfg.defaultModel,
      });
    }
    if (url.pathname === "/run") return handler.handleRun(req);
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
});

console.log(`[executor] listening :${cfg.port} (openshell=${cfg.openshellEnabled} pi=${cfg.piBin})`);
