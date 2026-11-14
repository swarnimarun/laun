/** Disposable real control service + Pi Durable adapter for browser checks. */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ControlService,
  ControlStore,
  handleControlRequest,
} from "@laun/control";
import { checkBearer } from "@laun/protocol";
import { createBrowserFixtureRuntime } from "../../../packages/runtime/test/browser-fixture.js";

export async function startBrowserFixture(repoRoot: string) {
  const directory = await mkdtemp(join(tmpdir(), "laun-ui-fixture-"));
  await mkdir(join(directory, "data"));
  const store = new ControlStore(join(directory, "data", "control.sqlite"));
  const runtime = createBrowserFixtureRuntime();
  const service = new ControlService({
    store,
    runtime,
    dataDir: directory,
    mode: "trusted-local",
    capacity: 2,
    defaultModel: "faux/faux-1",
    approvalTimeoutMs: 60_000,
  });
  const key = randomBytes(32).toString("base64url");
  const principal = { id: "browser-owner", admin: true };
  const publicRoot = resolve(repoRoot, "apps/gateway/public/v2");
  const mcp = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const input = (await request.json()) as { id?: string; method?: string };
      if (input.method !== "tools/list")
        return new Response(null, { status: 400 });
      return Response.json({
        jsonrpc: "2.0",
        id: input.id,
        result: {
          tools: [
            {
              name: "browser_echo",
              description: "Read-only browser fixture tool",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
    },
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/v2/"))
        return handleControlRequest(
          service,
          request,
          checkBearer(request.headers.get("authorization"), key)
            ? principal
            : null,
          { allowLoopback: true },
        );
      const file =
        path === "/app" || path === "/app/"
          ? "index.html"
          : path === "/app/app.js"
            ? "app.js"
            : path === "/app/style.css"
              ? "style.css"
              : null;
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(join(publicRoot, file)), {
        headers: {
          "cache-control": "no-store",
          "content-type": file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/javascript; charset=utf-8",
        },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    key,
    directory,
    mcpURL: `http://127.0.0.1:${mcp.port}/mcp`,
    seedLongHistory(){
      const mower=store.createMower(principal,{name:"Long history fixture",model:"faux/faux-1"});
      const thread=store.createThread(principal,{mowerId:mower.id,title:"Long durable history"});
      store.transaction(()=>{for(let i=0;i<2000;i++)store.event(thread.id,"message",{role:"user",text:`History fixture marker ${String(i).padStart(4,"0")}`});});
      return thread.id;
    },
    async close() {
      server.stop(true);
      mcp.stop(true);
      await service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
