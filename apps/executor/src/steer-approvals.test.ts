import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@laun/protocol";
import { parseExtensionUiRequest, RpcManager } from "./rpc.js";
import { createHandler } from "./server.js";

/**
 * Lane-exec3: steer + real gating approvals.
 *
 * The stub below speaks pi's rpc framing (strict JSONL on stdin/stdout) and
 * the extension_ui subprotocol (docs rpc-commands.md / rpc-extension-ui.md):
 * - mode "confirm": prompt -> extension_ui_request(confirm), waits for
 *   extension_ui_response, then agent_settled.
 * - mode "select": same with a select (options ["prod","staging"]).
 * - mode "inform": prompt -> notify + input requests, then settles at once
 *   (input must get an immediate cancelled answer; notify gets none).
 * - mode "slow": prompt -> text + settled after ~1.5s (steer target).
 * Every stdin line that matters is appended to $RPC_LOG for assertions.
 */
function writeApprovalStub(dir: string): string {
  const p = join(dir, "approval-stub");
  writeFileSync(
    p,
    "#!/usr/bin/env bun\n" +
      'import { appendFileSync } from "node:fs";\n' +
      'const log = process.env.RPC_LOG ?? "/dev/null";\n' +
      'const mode = process.env.RPC_APPROVAL_MODE ?? "confirm";\n' +
      'const note = (s) => appendFileSync(log, s + "\\n");\n' +
      'let buf = "";\n' +
      'process.stdin.setEncoding("utf8");\n' +
      'process.stdin.on("data", (c) => {\n' +
      "  buf += c;\n" +
      "  let i;\n" +
      '  while ((i = buf.indexOf("\\n")) >= 0) {\n' +
      "    const line = buf.slice(0, i);\n" +
      "    buf = buf.slice(i + 1);\n" +
      "    if (!line.trim()) continue;\n" +
      "    let m = null;\n" +
      "    try { m = JSON.parse(line); } catch { continue; }\n" +
      '    if (m.type === "set_auto_retry") continue;\n' +
      '    if (m.type === "get_state") {\n' +
      '      const r = typeof m.id === "string" ? { id: m.id, type: "state", isStreaming: false } : { type: "state", isStreaming: false };\n' +
      '      process.stdout.write(JSON.stringify(r) + "\\n");\n' +
      "      continue;\n" +
      "    }\n" +
      '    if (m.type === "steer") { note("STEER:" + m.message); continue; }\n' +
      '    if (m.type === "extension_ui_response") {\n' +
      '      note("RESP:" + JSON.stringify(m));\n' +
      "      process.stdout.write('{\"type\":\"agent_settled\"}\\n');\n" +
      "      continue;\n" +
      "    }\n" +
      "    if (m.type === \"abort\") { note(\"ABORT\"); process.stdout.write('{\\\"type\\\":\\\"agent_settled\\\"}\\n'); continue; }\n" +
      '    if (m.type === "prompt") {\n' +
      '      note("PROMPT");\n' +
      '      if (mode === "confirm") {\n' +
      "        process.stdout.write(JSON.stringify({ type: \"extension_ui_request\", id: \"appr-1\", method: \"confirm\", title: \"Allow deploy?\", message: \"run deploy.sh\" }) + \"\\n\");\n" +
      '      } else if (mode === "select") {\n' +
      "        process.stdout.write(JSON.stringify({ type: \"extension_ui_request\", id: \"appr-2\", method: \"select\", title: \"Pick target\", options: [\"prod\", \"staging\"] }) + \"\\n\");\n" +
      '      } else if (mode === "inform") {\n' +
      "        process.stdout.write(JSON.stringify({ type: \"extension_ui_request\", id: \"n-1\", method: \"notify\", message: \"hello there\" }) + \"\\n\");\n" +
      "        process.stdout.write(JSON.stringify({ type: \"extension_ui_request\", id: \"i-1\", method: \"input\", title: \"Name?\" }) + \"\\n\");\n" +
      "        process.stdout.write('{\"type\":\"agent_settled\"}\\n');\n" +
      '      } else if (mode === "slow") {\n' +
      "        setTimeout(() => {\n" +
      "          process.stdout.write(JSON.stringify({ type: \"message_update\", assistantMessageEvent: { type: \"text_delta\", delta: \"working\" } }) + \"\\n\");\n" +
      "          process.stdout.write('{\"type\":\"agent_settled\"}\\n');\n" +
      "        }, 1500);\n" +
      "      }\n" +
      "      continue;\n" +
      "    }\n" +
      "  }\n" +
      "});\n",
  );
  chmodSync(p, 0o755);
  return p;
}

/** Poll `cond` every 25ms until true or `timeoutMs` elapses (throws). */
async function pollFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function rpcHandler(dir: string, piBin: string, extra: Record<string, unknown> = {}) {
  return createHandler({
    port: 0,
    gatewayToken: "t",
    sessionDir: dir,
    piBin,
    defaultModel: "m",
    openshellEnabled: false,
    openshellPrefix: [],
    defaultTimeoutMs: 30_000,
    executorMode: "rpc",
    rpcIdleTtlMs: 300_000,
    ...extra,
  } as Parameters<typeof createHandler>[0]);
}

async function readNdjson(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AgentEvent);
}

function authed(path: string, body: unknown, token = "t"): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseExtensionUiRequest", () => {
  test("parses confirm/select/notify shapes", () => {
    const c = parseExtensionUiRequest({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Sure?", message: "do it" });
    expect(c).toEqual({ id: "u1", method: "confirm", options: [], title: "Sure?", message: "do it" });
    const s = parseExtensionUiRequest({ type: "extension_ui_request", id: "u2", method: "select", title: "Pick", options: ["a", "b"] });
    expect(s?.options).toEqual(["a", "b"]);
    const n = parseExtensionUiRequest({ type: "extension_ui_request", id: "u3", method: "notify", message: "hi" });
    expect(n?.method).toBe("notify");
  });

  test("rejects non-requests and malformed shapes", () => {
    expect(parseExtensionUiRequest(null)).toBeNull();
    expect(parseExtensionUiRequest({ type: "response", id: "x" })).toBeNull();
    expect(parseExtensionUiRequest({ type: "extension_ui_request", method: "confirm" })).toBeNull();
    expect(parseExtensionUiRequest({ type: "extension_ui_request", id: "x" })).toBeNull();
    expect(parseExtensionUiRequest('{"type":"extension_ui_request"}')).toBeNull();
  });
});

describe("RpcManager.steer", () => {
  test("live run consumes steer; run still completes normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-steer-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "slow";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const p = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      await pollFor(() => readFileSync(log, "utf8").includes("PROMPT"), "prompt delivery");
      expect(mgr.steer("s1", "go left")).toBe(true);
      const r = await p;
      // No completion side effects: the steered run still settles done.
      expect(r.sawDone).toBe(true);
      expect(r.sawError).toBe(false);
      expect(readFileSync(log, "utf8")).toContain("STEER:go left");
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("steer is false with no live run and for unknown sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-steer-idle-"));
    process.env["RPC_APPROVAL_MODE"] = "slow";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      expect(mgr.steer("nope", "x")).toBe(false);
      await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: () => {},
      });
      expect(mgr.steer("s1", "late")).toBe(false); // idle after settle
    } finally {
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);
});

describe("POST /steer", () => {
  test("live rpc run: 200 and steered text lands in the stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-hsteer-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "slow";
    const handler = rpcHandler(dir, writeApprovalStub(dir));
    try {
      const res = await handler.handleRun(authed("/run", { sessionId: "s1", prompt: "hi" }));
      expect(res.status).toBe(200);
      const textP = res.text();
      await pollFor(() => readFileSync(log, "utf8").includes("PROMPT"), "prompt delivery");
      const steerRes = await handler.handleSteer(authed("/steer", { sessionId: "s1", text: "go left" }));
      expect(steerRes.status).toBe(200);
      expect(await steerRes.json()).toEqual({ ok: true });
      const events = (await textP).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("go left"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      handler.close();
    }
  }, 20_000);

  test("idle steer is 409, unknown session is 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-hsteer-codes-"));
    process.env["RPC_APPROVAL_MODE"] = "slow";
    const handler = rpcHandler(dir, writeApprovalStub(dir));
    try {
      const unknown = await handler.handleSteer(authed("/steer", { sessionId: "never-seen-xyz", text: "x" }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "unknown session" });
      const runRes = await handler.handleRun(authed("/run", { sessionId: "sidle", prompt: "hi" }));
      await readNdjson(runRes);
      const idle = await handler.handleSteer(authed("/steer", { sessionId: "sidle", text: "x" }));
      expect(idle.status).toBe(409);
    } finally {
      delete process.env["RPC_APPROVAL_MODE"];
      handler.close();
    }
  }, 20_000);

  test("json mode steer is 409 with a clear message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-hsteer-json-"));
    const stub = join(dir, "slow.sh");
    writeFileSync(stub, "#!/bin/sh\nsleep 2\necho '{\"type\":\"agent_settled\"}'\n");
    chmodSync(stub, 0o755);
    const handler = createHandler({
      port: 0,
      gatewayToken: "t",
      sessionDir: dir,
      piBin: stub,
      defaultModel: "m",
      openshellEnabled: false,
      openshellPrefix: [],
      defaultTimeoutMs: 30_000,
    });
    try {
      const res = await handler.handleRun(authed("/run", { sessionId: "s1", prompt: "hi" }));
      expect(res.status).toBe(200);
      const textP = res.text();
      await pollFor(() => handler.busy.has("s1"), "run start");
      const steerRes = await handler.handleSteer(authed("/steer", { sessionId: "s1", text: "x" }));
      expect(steerRes.status).toBe(409);
      const body = (await steerRes.json()) as { error: string };
      expect(body.error).toMatch(/json mode/i);
      await textP;
    } finally {
      handler.close();
    }
  }, 20_000);

  test("steer validates auth and body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-hsteer-auth-"));
    const handler = rpcHandler(dir, writeApprovalStub(dir));
    try {
      expect((await handler.handleSteer(authed("/steer", { sessionId: "s1", text: "x" }, "nope"))).status).toBe(401);
      expect((await handler.handleSteer(authed("/steer", { sessionId: "../evil", text: "x" }))).status).toBe(400);
      expect((await handler.handleSteer(authed("/steer", { sessionId: "s1", text: "  " }))).status).toBe(400);
    } finally {
      handler.close();
    }
  });
});

describe("approvals: parked runs", () => {
  test("confirm approve resumes the run (confirmed:true reaches pi)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-ok-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "confirm";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const p = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      await pollFor(() => mgr.pendingApprovalIds("s1").includes("appr-1"), "approval parking");
      expect(events).toContainEqual({ type: "approval_request", sessionId: "s1", requestId: "appr-1", reason: "Allow deploy?", detail: "run deploy.sh" });
      expect(mgr.decideApproval("s1", "appr-1", "approve")).toBe(true);
      const r = await p;
      expect(r.sawDone).toBe(true);
      expect(r.sawError).toBe(false);
      expect(readFileSync(log, "utf8")).toContain('"confirmed":true');
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("select deny resumes the run (cancelled reaches pi)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-deny-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "select";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const p = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      await pollFor(() => mgr.pendingApprovalIds("s1").includes("appr-2"), "approval parking");
      const appr = events.find((e) => e.type === "approval_request");
      expect(appr).toMatchObject({ type: "approval_request", requestId: "appr-2" });
      expect(mgr.decideApproval("s1", "appr-2", "deny")).toBe(true);
      const r = await p;
      expect(r.sawDone).toBe(true);
      expect(readFileSync(log, "utf8")).toContain('"cancelled":true');
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("select approve answers the first option", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-sel-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "select";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const p = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: () => {},
      });
      await pollFor(() => mgr.pendingApprovalIds("s1").includes("appr-2"), "approval parking");
      expect(mgr.decideApproval("s1", "appr-2", "approve")).toBe(true);
      await p;
      expect(readFileSync(log, "utf8")).toContain('"value":"prod"');
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("timeout denies by default (bounded wait, run resumes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-timeout-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "confirm";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000, approvalTimeoutMs: 300 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      // Nobody decided: the bounded wait denied and the run still settled.
      expect(r.sawDone).toBe(true);
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("denied (timeout)"))).toBe(true);
      expect(readFileSync(log, "utf8")).toContain('"cancelled":true');
      expect(mgr.pendingApprovalIds("s1")).toEqual([]);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("abort releases a parked run as denied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-abort-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "confirm";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const p = mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: () => {},
      });
      await pollFor(() => mgr.pendingApprovalIds("s1").includes("appr-1"), "approval parking");
      expect(mgr.abort("s1")).toBe(true);
      const r = await p;
      expect(r.aborted).toBe(true);
      // The abort resolves locally; poll for the in-flight stdin bytes to
      // land in the stub before asserting (no fixed sleep).
      await pollFor(() => readFileSync(log, "utf8").includes('"cancelled":true'), "denied approval delivery");
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain("ABORT");
      expect(logged).toContain("ABORT");
      expect(mgr.pendingApprovalIds("s1")).toEqual([]);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("notify/input inform only: never park, input released at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-inform-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "inform";
    const mgr = new RpcManager({ piBin: writeApprovalStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => events.push(e),
      });
      // No decision was ever needed: the run settled on its own.
      expect(r.sawDone).toBe(true);
      expect(events.some((e) => e.type === "approval_request")).toBe(false);
      expect(mgr.pendingApprovalIds("s1")).toEqual([]);
      // The run settles without waiting for the stub to consume stdin:
      // poll for the immediate input answer to land (no fixed sleep).
      await pollFor(() => readFileSync(log, "utf8").includes("i-1"), "input release delivery");
      const logged = readFileSync(log, "utf8");
      expect(logged).not.toContain("n-1"); // fire-and-forget notify: no answer
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      mgr.close();
    }
  }, 20_000);

  test("gateway disconnect releases a parked run as denied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-appr-disc-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "confirm";
    const handler = rpcHandler(dir, writeApprovalStub(dir));
    try {
      const res = await handler.handleRun(authed("/run", { sessionId: "s1", prompt: "hi" }));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawApproval = false;
      const deadline = Date.now() + 8000;
      while (!sawApproval) {
        if (Date.now() > deadline) throw new Error("timed out waiting for approval_request");
        const { done, value } = await reader.read();
        if (done) break;
        buf += typeof value === "string" ? value : decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AgentEvent;
          if (e.type === "approval_request") sawApproval = true;
        }
      }
      expect(sawApproval).toBe(true);
      await reader.cancel(); // gateway goes away mid-park
      await pollFor(() => handler.busy.size === 0, "run completion after disconnect", 15_000);
      expect(readFileSync(log, "utf8")).toContain('"cancelled":true');
      expect(handler.rpc.pendingApprovalIds("s1")).toEqual([]);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      handler.close();
    }
  }, 25_000);
});

describe("POST /approvals", () => {
  test("delivers to a parked run (200); unknown request/session is 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-happr-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_APPROVAL_MODE"] = "confirm";
    const handler = rpcHandler(dir, writeApprovalStub(dir));
    try {
      const unknownSession = await handler.handleApprovals(
        authed("/approvals", { sessionId: "never-seen-xyz", requestId: "r", decision: "approve" }),
      );
      expect(unknownSession.status).toBe(404);
      expect(await unknownSession.json()).toEqual({ error: "unknown session" });
      const res = await handler.handleRun(authed("/run", { sessionId: "s1", prompt: "hi" }));
      expect(res.status).toBe(200);
      const textP = res.text();
      await pollFor(() => handler.rpc.pendingApprovalIds("s1").includes("appr-1"), "approval parking");
      const unknownReq = await handler.handleApprovals(authed("/approvals", { sessionId: "s1", requestId: "nope", decision: "deny" }));
      expect(unknownReq.status).toBe(404);
      const ok = await handler.handleApprovals(authed("/approvals", { sessionId: "s1", requestId: "appr-1", decision: "approve" }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      const events = (await textP).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.some((e) => e.type === "approval_request" && e.requestId === "appr-1")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_APPROVAL_MODE"];
      handler.close();
    }
  }, 20_000);

  test("validates auth and body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-happr-auth-"));
    const handler = rpcHandler(dir, writeApprovalStub(dir));
    try {
      expect((await handler.handleApprovals(authed("/approvals", { sessionId: "s", requestId: "r", decision: "approve" }, "nope"))).status).toBe(401);
      expect((await handler.handleApprovals(authed("/approvals", { sessionId: "s", requestId: "r", decision: "maybe" }))).status).toBe(400);
      expect((await handler.handleApprovals(authed("/approvals", { sessionId: "s", decision: "deny" }))).status).toBe(400);
      expect((await handler.handleApprovals(authed("/approvals", { sessionId: "../evil", requestId: "r", decision: "deny" }))).status).toBe(400);
    } finally {
      handler.close();
    }
  });
});
