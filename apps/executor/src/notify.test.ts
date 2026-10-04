import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@laun/protocol";
import { loadConfig } from "./config.js";
import {
  buildGrantHistoryArgs,
  buildNotifySteerMessage,
  DEFAULT_NOTIFY_GRANT_POLL_MS,
  DEFAULT_NOTIFY_GRANT_WINDOW_MS,
  fetchGrantHistorySync,
  isDenialOutput,
  parseRuleHistory,
} from "./notify.js";
import { RpcManager } from "./rpc.js";
import { sandboxNameForSession, type SandboxRunner, type SandboxSpawnOptions } from "./sandbox.js";
import { spawn } from "node:child_process";

/**
 * Lane-exec-notify: denial -> grant watch -> steer to retry.
 *
 * No live openshell contact: grant history comes from an injected fetcher
 * or a stub `rule history` binary printing a file the test controls. Every
 * wait polls with a deadline; every spawn carries an explicit timeout; all
 * windows/intervals here are short test values, not the ~90s/~10s defaults.
 */

/** Poll `cond` every 25ms until true or `timeoutMs` elapses (throws). */
async function pollFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Minimal sandbox fake: proves routing without a real gateway. */
class FakeRunner implements SandboxRunner {
  creates: string[] = [];
  async create(opts: { name: string }): Promise<void> {
    this.creates.push(opts.name);
  }
  spawnInteractive(sandboxName: string, argv: string[], opts: SandboxSpawnOptions): ChildProcess {
    const [cmd, ...args] = argv;
    return spawn(cmd!, args, { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin ?? "pipe", "pipe", "pipe"] });
  }
  async remove(_sandboxName: string): Promise<void> {}
  async stop(_sandboxName: string): Promise<void> {}
  async start(_sandboxName: string): Promise<void> {}
  async exists(sandboxName: string): Promise<boolean> {
    return this.creates.includes(sandboxName);
  }
}

/**
 * Stub pi rpc child. On prompt it emits one tool_result (denial-shaped when
 * RPC_NOTIFY_MODE=denial, unrelated when =unrelated, ok when =ok) then
 * settles after RPC_NOTIFY_SETTLE_MS. Every steer lands in $RPC_LOG.
 */
function writeNotifyPiStub(dir: string): string {
  const p = join(dir, "notify-pi");
  writeFileSync(
    p,
    "#!/usr/bin/env bun\n" +
      'import { appendFileSync } from "node:fs";\n' +
      'const log = process.env.RPC_LOG ?? "/dev/null";\n' +
      'const mode = process.env.RPC_NOTIFY_MODE ?? "denial";\n' +
      'const settleMs = Number(process.env.RPC_NOTIFY_SETTLE_MS ?? "800");\n' +
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
      '    if (m.type === "get_state") { process.stdout.write(JSON.stringify({ type: "state", isStreaming: false }) + "\\n"); continue; }\n' +
      '    if (m.type === "steer") { note("STEER:" + m.message); continue; }\n' +
      '    if (m.type === "abort") { note("ABORT"); process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); continue; }\n' +
      '    if (m.type === "prompt") {\n' +
      '      note("PROMPT");\n' +
      '      const out = mode === "denial" ? "curl: (7) Failed to connect: EACCES 198.18.0.2:443" : mode === "unrelated" ? "boom: something failed" : "ok";\n' +
      '      const isError = mode !== "ok";\n' +
      "      process.stdout.write(JSON.stringify({ type: \"tool_execution_end\", toolCallId: \"c1\", toolName: \"bash\", result: { content: [{ type: \"text\", text: out }] }, isError }) + \"\\n\");\n" +
      "      setTimeout(() => { process.stdout.write('{\"type\":\"agent_settled\"}\\n'); }, settleMs);\n" +
      "      continue;\n" +
      "    }\n" +
      "  }\n" +
      "});\n",
  );
  chmodSync(p, 0o755);
  return p;
}

/** Stub `openshell` binary: `rule history <name>` cats $LAUN_HISTORY_FILE. */
function writeHistoryStub(dir: string): string {
  const p = join(dir, "openshell-history-stub.sh");
  writeFileSync(
    p,
    "#!/bin/sh\n" +
      'if [ "$1" = "rule" ] && [ "$2" = "history" ]; then\n' +
      '  cat "${LAUN_HISTORY_FILE:-/dev/null}" 2>/dev/null\n' +
      "  exit 0\n" +
      "fi\n" +
      'echo "unexpected: $*" >&2\n' +
      "exit 99\n",
  );
  chmodSync(p, 0o755);
  return p;
}

describe("isDenialOutput", () => {
  test("matches the live shape and its tight outward list", () => {
    for (const out of [
      "curl: (7) Failed to connect: EACCES 198.18.0.2:443",
      "connect EACCES 10.0.0.1:443",
      "docker: permission denied",
      "Permission Denied while dialing",
      "Policy denied for egress to example.com",
      "policy DENIED",
      "403 Forbidden",
      "forbidden",
      "proxy refused the connection",
      "proxy connect refused",
      "connection refused by proxy",
      "proxy denied CONNECT",
      "proxy forbidden",
      "proxy CONNECT 403",
      "403 from proxy",
      "ERR_PROXY_CONNECTION_FAILED",
      "proxy tunnel failed",
      "tunnel through proxy failed",
    ]) {
      expect(isDenialOutput(out)).toBe(true);
    }
  });

  test("ignores unrelated failures (no false watches)", () => {
    for (const out of [undefined, "", "boom", "boom: something failed", "run timed out after 5000ms", "ENOENT: no such file", "connection refused", "connection reset by peer", "EAGAIN try again", "all good"]) {
      expect(isDenialOutput(out)).toBe(false);
    }
  });
});

describe("parseRuleHistory", () => {
  test("parses the live-observed approved line shape", () => {
    expect(parseRuleHistory("a1b2 2026-10-04T12:00:00Z approved Rule 'allow_example_com_443' approved")).toEqual([
      "allow_example_com_443",
    ]);
  });

  test("parses the chunk variant and multiple grants", () => {
    const out = [
      "x 2026-10-04 approved [chunk 1/2] Rule 'net_out' approved",
      "y 2026-10-04 approved Rule \"quoted_name\" approved",
    ].join("\n");
    expect(parseRuleHistory(out)).toEqual(["net_out", "quoted_name"]);
  });

  test("ignores pending/rejected rows, headers, and garbage", () => {
    const out = [
      "ID TIME STATUS RULE",
      "a 2026-10-04 pending Rule 'want_net' pending",
      "b 2026-10-04 rejected Rule 'bad_net' rejected",
      "hello world",
      "",
      "approved but no rule name here",
      "c 2026-10-04T12:01:00Z approved Rule 'got_net' approved",
    ].join("\n");
    expect(parseRuleHistory(out)).toEqual(["got_net"]);
  });
});

describe("notify argv + steer text", () => {
  test("history argv is exact (no invented flags)", () => {
    expect(buildGrantHistoryArgs("laun-s1")).toEqual(["rule", "history", "laun-s1"]);
  });

  test("steer text names the rule and orders a retry", () => {
    const msg = buildNotifySteerMessage("allow_example_com_443");
    expect(msg).toContain("allow_example_com_443");
    expect(msg).toMatch(/retry/i);
  });
});

describe("fetchGrantHistorySync (stub binary, explicit timeouts)", () => {
  test("parses stub output; missing/failing binaries yield []", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-fetch-"));
    const hist = join(dir, "history.txt");
    writeFileSync(hist, "a 2026-10-04 approved Rule 'allow_x' approved\ngarbage\n");
    process.env["LAUN_HISTORY_FILE"] = hist;
    try {
      const stub = writeHistoryStub(dir);
      expect(fetchGrantHistorySync(stub, "laun-s1", 5000)).toEqual(["allow_x"]);
      expect(fetchGrantHistorySync(join(dir, "definitely-not-a-binary"), "laun-s1", 2000)).toEqual([]);
      const failing = join(dir, "fail.sh");
      writeFileSync(failing, "#!/bin/sh\nexit 3\n");
      chmodSync(failing, 0o755);
      expect(fetchGrantHistorySync(failing, "laun-s1", 2000)).toEqual([]);
      // Direct spawnSync proof of the explicit timeout (no hangs).
      const r = spawnSync(stub, ["rule", "history", "laun-s1"], { encoding: "utf8", timeout: 5000 });
      expect(r.status).toBe(0);
    } finally {
      delete process.env["LAUN_HISTORY_FILE"];
    }
  });
});

describe("notify config", () => {
  test("defaults to ~90s window and ~10s interval", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "s" } as NodeJS.ProcessEnv);
    expect(cfg.notifyGrantWindowMs).toBe(DEFAULT_NOTIFY_GRANT_WINDOW_MS);
    expect(cfg.notifyGrantPollMs).toBe(DEFAULT_NOTIFY_GRANT_POLL_MS);
    expect(DEFAULT_NOTIFY_GRANT_WINDOW_MS).toBe(90_000);
    expect(DEFAULT_NOTIFY_GRANT_POLL_MS).toBe(10_000);
  });

  test("parses custom values", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "s", NOTIFY_GRANT_WINDOW_MS: "5000", NOTIFY_GRANT_POLL_MS: "500" } as NodeJS.ProcessEnv);
    expect(cfg.notifyGrantWindowMs).toBe(5000);
    expect(cfg.notifyGrantPollMs).toBe(500);
  });

  test("rejects out-of-range and non-integer values", () => {
    for (const v of ["0", "5", "-1", "999999999", "nope", "1.5"]) {
      expect(() => loadConfig({ GATEWAY_TOKEN: "s", NOTIFY_GRANT_WINDOW_MS: v } as NodeJS.ProcessEnv)).toThrow("NOTIFY_GRANT_WINDOW_MS");
    }
    for (const v of ["0", "-1", "999999999", "nope", "2.5"]) {
      expect(() => loadConfig({ GATEWAY_TOKEN: "s", NOTIFY_GRANT_POLL_MS: v } as NodeJS.ProcessEnv)).toThrow("NOTIFY_GRANT_POLL_MS");
    }
  });
});

describe("watch trigger: denial starts it, unrelated failures do not", () => {
  test("denial arms the watch mid-run; unrelated never fetches", async () => {
    for (const mode of ["denial", "unrelated"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `laun-notify-trig-${mode}-`));
      const log = join(dir, "cmds.log");
      writeFileSync(log, "");
      process.env["RPC_LOG"] = log;
      process.env["RPC_NOTIFY_MODE"] = mode;
      process.env["RPC_NOTIFY_SETTLE_MS"] = "600";
      let fetchCalls = 0;
      const mgr = new RpcManager({
        piBin: writeNotifyPiStub(dir),
        openshellPrefix: [],
        idleTtlMs: 300_000,
        sandboxRunner: new FakeRunner(),
        notifyWindowMs: 5000,
        notifyPollMs: 25,
        notifyFetch: () => {
          fetchCalls++;
          return [];
        },
      });
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
        if (mode === "denial") {
          await pollFor(() => mgr.hasNotifyWatch("s1"), "grant watch arming");
        } else {
          // Same window the denial case arms in: no watch, hence no fetch.
          await pollFor(() => readFileSync(log, "utf8").includes("PROMPT"), "prompt delivery");
          await new Promise((r) => setTimeout(r, 300));
          expect(mgr.hasNotifyWatch("s1")).toBe(false);
        }
        const r = await p;
        expect(r.sawDone).toBe(true);
        expect(mgr.hasNotifyWatch("s1")).toBe(false);
        if (mode === "denial") {
          expect(fetchCalls).toBeGreaterThan(0);
          expect(events.some((e) => e.type === "tool_result" && !e.ok)).toBe(true);
        } else {
          expect(fetchCalls).toBe(0);
        }
      } finally {
        delete process.env["RPC_LOG"];
        delete process.env["RPC_NOTIFY_MODE"];
        delete process.env["RPC_NOTIFY_SETTLE_MS"];
        mgr.close();
      }
    }
  }, 20_000);

  test("no sandbox means no watch (direct spawn skips silently)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-nosbx-"));
    process.env["RPC_NOTIFY_MODE"] = "denial";
    process.env["RPC_NOTIFY_SETTLE_MS"] = "400";
    let fetchCalls = 0;
    const mgr = new RpcManager({
      piBin: writeNotifyPiStub(dir),
      openshellPrefix: [],
      idleTtlMs: 300_000,
      notifyWindowMs: 2000,
      notifyPollMs: 25,
      notifyFetch: () => {
        fetchCalls++;
        return [];
      },
    });
    try {
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: () => {},
      });
      expect(r.sawDone).toBe(true);
      expect(fetchCalls).toBe(0);
      expect(mgr.hasNotifyWatch("s1")).toBe(false);
    } finally {
      delete process.env["RPC_NOTIFY_MODE"];
      delete process.env["RPC_NOTIFY_SETTLE_MS"];
      mgr.close();
    }
  }, 20_000);
});

describe("grant mid-window steers the live run with a note", () => {
  test("new approved rule -> steer with rule name + status note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-fire-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_NOTIFY_MODE"] = "denial";
    process.env["RPC_NOTIFY_SETTLE_MS"] = "900";
    let calls = 0;
    const mgr = new RpcManager({
      piBin: writeNotifyPiStub(dir),
      openshellPrefix: [],
      idleTtlMs: 300_000,
      sandboxRunner: new FakeRunner(),
      notifyWindowMs: 5000,
      notifyPollMs: 25,
      notifyFetch: () => {
        calls++;
        return calls <= 3 ? [] : ["allow_example_com_443"];
      },
    });
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
      expect(r.sawDone).toBe(true);
      // Steer landed mid-run with the rule name (exactly once: fire stops).
      await pollFor(() => readFileSync(log, "utf8").includes("STEER:"), "grant steer delivery", 8000);
      const steers = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("STEER:"));
      expect(steers).toHaveLength(1);
      expect(steers[0]).toContain("allow_example_com_443");
      // The status note went to the run stream with the same text.
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("allow_example_com_443"))).toBe(true);
      expect(mgr.hasNotifyWatch("s1")).toBe(false);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_NOTIFY_MODE"];
      delete process.env["RPC_NOTIFY_SETTLE_MS"];
      mgr.close();
    }
  }, 20_000);

  test("pre-existing grants never fire (only NEW rules steer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-nofire-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_NOTIFY_MODE"] = "denial";
    process.env["RPC_NOTIFY_SETTLE_MS"] = "500";
    const mgr = new RpcManager({
      piBin: writeNotifyPiStub(dir),
      openshellPrefix: [],
      idleTtlMs: 300_000,
      sandboxRunner: new FakeRunner(),
      notifyWindowMs: 2000,
      notifyPollMs: 25,
      notifyFetch: () => ["already_there"],
    });
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
      expect(r.sawDone).toBe(true);
      expect(readFileSync(log, "utf8")).not.toContain("STEER:");
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("granted"))).toBe(false);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_NOTIFY_MODE"];
      delete process.env["RPC_NOTIFY_SETTLE_MS"];
      mgr.close();
    }
  }, 20_000);

  test("production CLI path: stub rule-history binary grants mid-window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-cli-"));
    const log = join(dir, "cmds.log");
    const hist = join(dir, "history.txt");
    writeFileSync(log, "");
    writeFileSync(hist, "");
    process.env["RPC_LOG"] = log;
    process.env["LAUN_HISTORY_FILE"] = hist;
    process.env["RPC_NOTIFY_MODE"] = "denial";
    process.env["RPC_NOTIFY_SETTLE_MS"] = "1200";
    const mgr = new RpcManager({
      piBin: writeNotifyPiStub(dir),
      openshellPrefix: [],
      idleTtlMs: 300_000,
      sandboxRunner: new FakeRunner(),
      notifyWindowMs: 5000,
      notifyPollMs: 25,
      openshellBin: writeHistoryStub(dir),
    });
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
      await pollFor(() => mgr.hasNotifyWatch("s1"), "grant watch arming");
      // A human/advisor grant lands mid-window as a new history line.
      writeFileSync(hist, "f1 2026-10-04T12:00:01Z approved Rule 'allow_example_com_443' approved\n");
      const r = await p;
      expect(r.sawDone).toBe(true);
      await pollFor(() => readFileSync(log, "utf8").includes("STEER:"), "CLI-path steer delivery", 8000);
      expect(readFileSync(log, "utf8")).toContain("allow_example_com_443");
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("allow_example_com_443"))).toBe(true);
      expect(sandboxNameForSession("s1")).toBe("laun-s1");
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["LAUN_HISTORY_FILE"];
      delete process.env["RPC_NOTIFY_MODE"];
      delete process.env["RPC_NOTIFY_SETTLE_MS"];
      mgr.close();
    }
  }, 20_000);
});

describe("window expiry and settled runs never steer", () => {
  test("no grants in the window -> no steer, no crash, watcher gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-expiry-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_NOTIFY_MODE"] = "denial";
    process.env["RPC_NOTIFY_SETTLE_MS"] = "900";
    const mgr = new RpcManager({
      piBin: writeNotifyPiStub(dir),
      openshellPrefix: [],
      idleTtlMs: 300_000,
      sandboxRunner: new FakeRunner(),
      notifyWindowMs: 250,
      notifyPollMs: 25,
      notifyFetch: () => [],
    });
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
      await pollFor(() => mgr.hasNotifyWatch("s1"), "grant watch arming");
      // The window (250ms) expires while the run (900ms) is still live.
      await pollFor(() => !mgr.hasNotifyWatch("s1"), "watch expiry");
      const r = await p;
      expect(r.sawDone).toBe(true);
      expect(r.sawError).toBe(false);
      expect(readFileSync(log, "utf8")).not.toContain("STEER:");
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("granted"))).toBe(false);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_NOTIFY_MODE"];
      delete process.env["RPC_NOTIFY_SETTLE_MS"];
      mgr.close();
    }
  }, 20_000);

  test("late grant after settle -> no steer, no note spam", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-notify-late-"));
    const log = join(dir, "cmds.log");
    writeFileSync(log, "");
    process.env["RPC_LOG"] = log;
    process.env["RPC_NOTIFY_MODE"] = "denial";
    process.env["RPC_NOTIFY_SETTLE_MS"] = "300";
    let settled = false;
    const mgr = new RpcManager({
      piBin: writeNotifyPiStub(dir),
      openshellPrefix: [],
      idleTtlMs: 300_000,
      sandboxRunner: new FakeRunner(),
      notifyWindowMs: 2000,
      notifyPollMs: 25,
      notifyFetch: () => (settled ? ["late_rule"] : []),
    });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 15_000,
        onEvent: (e) => {
          if (e.type === "done") settled = true;
          events.push(e);
        },
      });
      expect(r.sawDone).toBe(true);
      // The grant only exists after the settle stopped the watch: bounded
      // wait past several poll intervals, then assert silence.
      await new Promise((res) => setTimeout(res, 400));
      expect(mgr.hasNotifyWatch("s1")).toBe(false);
      expect(readFileSync(log, "utf8")).not.toContain("STEER:");
      expect(events.some((e) => e.type === "status" && (e.message ?? "").includes("late_rule"))).toBe(false);
    } finally {
      delete process.env["RPC_LOG"];
      delete process.env["RPC_NOTIFY_MODE"];
      delete process.env["RPC_NOTIFY_SETTLE_MS"];
      mgr.close();
    }
  }, 20_000);

  test("poll with no live run stops the watch without a note (fail-safe)", async () => {
    // White-box pin for the `steer() === false` branch: a watch entry with
    // no session behind it must stop silently instead of throwing or noting.
    const mgr = new RpcManager({ piBin: "true", openshellPrefix: [], idleTtlMs: 300_000, sandboxRunner: new FakeRunner(), notifyFetch: () => ["ghost_rule"] });
    try {
      const timer = setInterval(() => {}, 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
      (mgr as unknown as { notifyWatches: Map<string, unknown> }).notifyWatches.set("ghost", {
        sandboxName: "laun-ghost",
        seen: new Set<string>(),
        deadline: Date.now() + 5000,
        timer,
      });
      await (mgr as unknown as { pollNotifyWatch: (id: string) => Promise<void> }).pollNotifyWatch("ghost");
      expect((mgr as unknown as { notifyWatches: Map<string, unknown> }).notifyWatches.has("ghost")).toBe(false);
    } finally {
      mgr.close();
    }
  }, 10_000);
});
