import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@cloudbear/protocol";
import { loadConfig } from "./config.js";
import { buildPiArgs, runPiStreaming } from "./pi.js";
import { buildRpcArgs, RpcManager } from "./rpc.js";
import {
  buildSandboxCreateArgs,
  buildSandboxExecArgs,
  CliSandboxRunner,
  sandboxNameForSession,
  type SandboxRunner,
  type SandboxSpawnOptions,
} from "./sandbox.js";
import { createHandler } from "./server.js";

/**
 * Lane-sandbox tests. Every test here must fail if the sandbox feature is
 * deleted: argv shaping is asserted exactly, runner routing is asserted via
 * a recording fake, and the interactive-stdio proof pins the load-bearing
 * assumption (a long-lived piped `sandbox exec` child stays up across
 * multiple writes over time with streaming reads).
 *
 * No wall-clock sleeps: every wait polls with an explicit deadline, and
 * every spawn (sync or async) carries an explicit timeout.
 */

/** Poll `cond` every 25ms until true or `timeoutMs` elapses (throws on timeout). */
async function pollFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Stub of the openshell CLI surface this lane uses. `sandbox exec` parses
 * exactly our shaping (`-n <name> -- <argv...>`, nothing else) and execs the
 * target so stdio pipes flow through, holding them open like the real CLI.
 * `sandbox create` logs and exits ${CB_SANDBOX_CREATE_EXIT:-0}; `delete` logs.
 */
function writeOpenshellStub(dir: string): string {
  const p = join(dir, "openshell-stub.sh");
  writeFileSync(
    p,
    "#!/bin/sh\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "create" ]; then\n' +
      '  echo "$*" >> "${CB_SANDBOX_CREATE_LOG:-/dev/null}"\n' +
      '  exit "${CB_SANDBOX_CREATE_EXIT:-0}"\n' +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then\n' +
      '  echo "$*" >> "${CB_SANDBOX_DELETE_LOG:-/dev/null}"\n' +
      "  exit 0\n" +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then\n' +
      '  echo "$*" >> "${CB_SANDBOX_EXEC_LOG:-/dev/null}"\n' +
      "  shift 2\n" +
      '  if [ "$1" = "-n" ] || [ "$1" = "--name" ]; then shift 2; fi\n' +
      '  if [ "$1" = "--" ]; then shift; fi\n' +
      '  case "$1" in -*) echo "stub-openshell: unexpected flag $1" >&2; exit 99;; esac\n' +
      '  exec "$@"\n' +
      "fi\n" +
      'echo "stub-openshell: unexpected argv: $*" >&2\n' +
      "exit 99\n",
  );
  chmodSync(p, 0o755);
  return p;
}

/** Recording fake: proves spawn routing without needing a real gateway. */
class FakeRunner implements SandboxRunner {
  creates: string[] = [];
  spawns: Array<{ name: string; argv: string[]; stdin: string }> = [];
  removes: string[] = [];
  failCreate: Error | null = null;

  async create(opts: { name: string }): Promise<void> {
    this.creates.push(opts.name);
    if (this.failCreate) throw this.failCreate;
  }

  spawnInteractive(sandboxName: string, argv: string[], opts: SandboxSpawnOptions): ChildProcess {
    const stdin = opts.stdin ?? "pipe";
    this.spawns.push({ name: sandboxName, argv, stdin });
    const [cmd, ...args] = argv;
    return spawn(cmd!, args, { cwd: opts.cwd, env: opts.env, stdio: [stdin, "pipe", "pipe"] });
  }

  async remove(sandboxName: string): Promise<void> {
    this.removes.push(sandboxName);
  }
}

/** Deadline-bounded line reader for a piped child (no sleeps). */
function attachLineReader(child: ChildProcess) {
  let text = "";
  const pending: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    let idx: number;
    while ((idx = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, idx);
      text = text.slice(idx + 1);
      const w = waiting.shift();
      if (w) w(line);
      else pending.push(line);
    }
  });
  return {
    nextLine(timeoutMs: number): Promise<string> {
      const got = pending.shift();
      if (got !== undefined) return Promise.resolve(got);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiting.indexOf(resolve);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error("timed out waiting for child output"));
        }, timeoutMs);
        waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
  };
}

function childAlive(child: ChildProcess): boolean {
  if (child.exitCode !== null) return false;
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

function basicRpcStub(dir: string): string {
  const p = join(dir, "rpc.sh");
  writeFileSync(
    p,
    "#!/bin/sh\n" +
      'while IFS= read -r line; do\n' +
      '  case "$line" in\n' +
      "    *set_auto_retry*) ;;\n" +
      '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
      '    *prompt*)\n' +
      '      echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello rpc"}}\';\n' +
      '      echo \'{"type":"agent_end","willRetry":false}\';\n' +
      '      echo \'{"type":"agent_settled"}\';\n' +
      "      ;;\n" +
      '    *abort*) echo \'{"type":"agent_settled"}\' ;;\n' +
      "  esac\n" +
      "done\n",
  );
  chmodSync(p, 0o755);
  return p;
}

function oneShotJsonStub(dir: string): string {
  const p = join(dir, "pi.sh");
  writeFileSync(
    p,
    "#!/bin/sh\n" +
      "echo '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"hi\"}}'\n" +
      "echo '{\"type\":\"agent_settled\"}'\n",
  );
  chmodSync(p, 0o755);
  return p;
}

describe("sandbox argv shaping", () => {
  test("create passes image/policy/provider/approval-mode from config", () => {
    expect(
      buildSandboxCreateArgs({
        name: "cb-s1",
        image: "pi-agent:local",
        policyFile: "/pol.yaml",
        providers: ["prov-a", "prov-b"],
        approvalMode: "auto",
      }),
    ).toEqual([
      "sandbox",
      "create",
      "--name",
      "cb-s1",
      "--from",
      "pi-agent:local",
      "--provider",
      "prov-a",
      "--provider",
      "prov-b",
      "--policy",
      "/pol.yaml",
      "--approval-mode",
      "auto",
    ]);
  });

  test("create omits empty optionals (no invented flags)", () => {
    expect(buildSandboxCreateArgs({ name: "cb-s1", image: "img" })).toEqual([
      "sandbox",
      "create",
      "--name",
      "cb-s1",
      "--from",
      "img",
    ]);
  });

  test("exec shapes an interactive child: sandbox exec -n <name> -- <argv>", () => {
    expect(buildSandboxExecArgs("cb-s1", ["pi", "--mode", "rpc"])).toEqual([
      "sandbox",
      "exec",
      "-n",
      "cb-s1",
      "--",
      "pi",
      "--mode",
      "rpc",
    ]);
  });

  test("sandbox names are deterministic per session", () => {
    expect(sandboxNameForSession("abc-123")).toBe("cb-abc-123");
  });
});

describe("sandbox config", () => {
  test("enabled requires an image (fail closed)", () => {
    expect(() =>
      loadConfig({ GATEWAY_TOKEN: "x", OPENSHELL_ENABLED: "true", OPENSHELL_PREFIX: "openshell exec" } as NodeJS.ProcessEnv),
    ).toThrow("OPENSHELL_SANDBOX_IMAGE");
  });

  test("parses image, policy, providers, approval mode", () => {
    const cfg = loadConfig({
      GATEWAY_TOKEN: "x",
      OPENSHELL_ENABLED: "true",
      OPENSHELL_PREFIX: "openshell exec",
      OPENSHELL_SANDBOX_IMAGE: "pi-agent:local",
      OPENSHELL_POLICY: "/pol.yaml",
      OPENSHELL_PROVIDER: "prov-a, prov-b",
      OPENSHELL_APPROVAL_MODE: "auto",
    } as NodeJS.ProcessEnv);
    expect(cfg.sandboxImage).toBe("pi-agent:local");
    expect(cfg.sandboxPolicyFile).toBe("/pol.yaml");
    expect(cfg.sandboxProviders).toEqual(["prov-a", "prov-b"]);
    expect(cfg.sandboxApprovalMode).toBe("auto");
  });

  test("rejects an unknown approval mode", () => {
    expect(() =>
      loadConfig({ GATEWAY_TOKEN: "x", OPENSHELL_APPROVAL_MODE: "yolo" } as NodeJS.ProcessEnv),
    ).toThrow("OPENSHELL_APPROVAL_MODE");
  });

  test("disabled leaves sandbox fields empty", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "x" } as NodeJS.ProcessEnv);
    expect(cfg.sandboxImage).toBe("");
    expect(cfg.sandboxProviders).toEqual([]);
    expect(cfg.sandboxApprovalMode).toBe("");
  });
});

describe("interactive stdio proof (real runner + stub CLI shaping)", () => {
  test("three writes over time get three reads back; the child stays alive between them", async () => {
    // Load-bearing assumption: the CLI holds interactive stdio. This runs the
    // REAL CliSandboxRunner (exact exec argv, pipe x 3) against a stub binary
    // that execs the target with the pipes held open, like the real CLI.
    // A live-gateway proof was attempted on this Mac and is documented in the
    // handoff; the VPS proof (integrator) covers the real server side.
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-stdio-"));
    const execLog = join(dir, "exec.log");
    writeFileSync(execLog, "");
    process.env["CB_SANDBOX_EXEC_LOG"] = execLog;
    const stub = writeOpenshellStub(dir);
    const runner = new CliSandboxRunner({ bin: stub, image: "stub-image" });
    const child = runner.spawnInteractive("cb-probe", ["cat"], { cwd: dir, env: process.env });
    try {
      const reader = attachLineReader(child);
      expect(child.pid).toBeDefined();
      for (const word of ["one", "two", "three"]) {
        // Alive between writes: the previous roundtrip ended and no exit arrived.
        expect(childAlive(child)).toBe(true);
        child.stdin!.write(word + "\n");
        // Explicit deadline per read, no sleeps: each roundtrip itself spans time.
        await expect(reader.nextLine(5000)).resolves.toBe(word);
      }
      expect(childAlive(child)).toBe(true);
      // The shaping the proof used is the exact CLI contract.
      expect(readFileSync(execLog, "utf8")).toContain("sandbox exec -n cb-probe -- cat");
    } finally {
      delete process.env["CB_SANDBOX_EXEC_LOG"];
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await pollFor(() => child.exitCode !== null, "stdio child exit").catch(() => {});
    }
  }, 15000);

  test("real runner create passes flags; create failure throws loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-create-"));
    const createLog = join(dir, "create.log");
    writeFileSync(createLog, "");
    process.env["CB_SANDBOX_CREATE_LOG"] = createLog;
    const stub = writeOpenshellStub(dir);
    const runner = new CliSandboxRunner({
      bin: stub,
      image: "pi-agent:local",
      policyFile: "/pol.yaml",
      providers: ["prov-a", "prov-b"],
      approvalMode: "auto",
    });
    try {
      await runner.create({ name: "cb-s1" });
      const logged = readFileSync(createLog, "utf8");
      for (const flag of ["--name cb-s1", "--from pi-agent:local", "--provider prov-a", "--provider prov-b", "--policy /pol.yaml", "--approval-mode auto"]) {
        expect(logged).toContain(flag);
      }
      process.env["CB_SANDBOX_CREATE_EXIT"] = "1";
      await expect(runner.create({ name: "cb-boom" })).rejects.toThrow("failed to create sandbox cb-boom");
    } finally {
      delete process.env["CB_SANDBOX_CREATE_LOG"];
      delete process.env["CB_SANDBOX_CREATE_EXIT"];
    }
  });

  test("remove never throws, even when the binary is missing", async () => {
    const runner = new CliSandboxRunner({ bin: "cloudbear-definitely-not-a-binary", image: "img", removeTimeoutMs: 2000 });
    await runner.remove("cb-ghost"); // must resolve, not reject
  });
});

describe("rpc through the runner (fake)", () => {
  test("enabled routes spawn through the runner with pi argv; created once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-rpc-"));
    const stub = basicRpcStub(dir);
    const fake = new FakeRunner();
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000, sandboxRunner: fake });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(true);
      expect(fake.creates).toEqual(["cb-s1"]);
      expect(fake.spawns).toHaveLength(1);
      expect(fake.spawns[0]!.name).toBe("cb-s1");
      expect(fake.spawns[0]!.argv).toEqual([stub, ...buildRpcArgs({ sessionId: "s1", piSessionDir: dir, model: "m" })]);
      // Second run reuses the sandbox child: created once, spawned once.
      const pid1 = mgr.pidOf("s1");
      const r2 = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "again",
        timeoutMs: 10_000,
        onEvent: () => {},
      });
      expect(r2.sawDone).toBe(true);
      expect(fake.creates).toEqual(["cb-s1"]);
      expect(fake.spawns).toHaveLength(1);
      expect(mgr.pidOf("s1")).toBe(pid1);
    } finally {
      mgr.close();
    }
  });

  test("disabled spawns directly with no runner involved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-direct-"));
    const mgr = new RpcManager({ piBin: basicRpcStub(dir), openshellPrefix: [], idleTtlMs: 300_000 });
    try {
      const events: AgentEvent[] = [];
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: (e) => events.push(e),
      });
      expect(r.sawDone).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(true);
    } finally {
      mgr.close();
    }
  });

  test("sandbox is removed on idle reap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-reap-"));
    const fake = new FakeRunner();
    const mgr = new RpcManager({ piBin: basicRpcStub(dir), openshellPrefix: [], idleTtlMs: 150, sandboxRunner: fake });
    try {
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 10_000,
        onEvent: () => {},
      });
      expect(r.sawDone).toBe(true);
      await pollFor(() => fake.removes.includes("cb-s1"), "sandbox removal on idle reap");
      expect(mgr.has("s1")).toBe(false);
    } finally {
      mgr.close();
    }
  });

  test("sandbox is removed on timeout kill of a wedged child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-wedge-"));
    const stub = join(dir, "wedge.sh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        'while IFS= read -r line; do\n' +
        '  case "$line" in\n' +
        "    *set_auto_retry*) ;;\n" +
        '    *get_state*) echo \'{"type":"state","isStreaming":false}\' ;;\n' +
        // prompt and abort are both ignored: the run times out, then the
        // bounded settle grace SIGKILLs the wedged child.
        "  esac\n" +
        "done\n",
    );
    chmodSync(stub, 0o755);
    const fake = new FakeRunner();
    const mgr = new RpcManager({ piBin: stub, openshellPrefix: [], idleTtlMs: 300_000, sandboxRunner: fake });
    try {
      const r = await mgr.run({
        sessionId: "s1",
        piSessionDir: dir,
        workdir: dir,
        model: "m",
        prompt: "hi",
        timeoutMs: 400,
        onEvent: () => {},
      });
      expect(r.timedOut).toBe(true);
      expect(fake.creates).toEqual(["cb-s1"]);
      await pollFor(() => fake.removes.includes("cb-s1"), "sandbox removal on timeout kill", 20_000);
      expect(mgr.has("s1")).toBe(false);
    } finally {
      mgr.close();
    }
  }, 30_000);

  test("create failure rejects loudly and never spawns unsandboxed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-createfail-"));
    const fake = new FakeRunner();
    fake.failCreate = new Error("gateway refused");
    const mgr = new RpcManager({ piBin: basicRpcStub(dir), openshellPrefix: [], idleTtlMs: 300_000, sandboxRunner: fake });
    try {
      await expect(
        mgr.run({ sessionId: "s1", piSessionDir: dir, workdir: dir, model: "m", prompt: "hi", timeoutMs: 5000, onEvent: () => {} }),
      ).rejects.toThrow("gateway refused");
      // No fallback spawn: the run died instead of running outside the sandbox.
      expect(fake.spawns).toHaveLength(0);
      expect(mgr.has("s1")).toBe(false);
    } finally {
      mgr.close();
    }
  });
});

describe("json through the runner (fake)", () => {
  const base = {
    sessionId: "s1",
    model: "m",
    prompt: "hi",
    openshellPrefix: [] as string[],
    timeoutMs: 10_000,
  };

  test("enabled runs one-shot inside the sandbox and removes it after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-json-"));
    const stub = oneShotJsonStub(dir);
    const fake = new FakeRunner();
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({ ...base, piBin: stub, piSessionDir: dir, workdir: dir, onEvent: (e) => events.push(e), sandboxRunner: fake });
    expect(r.sawDone).toBe(true);
    expect(r.sawError).toBe(false);
    expect(fake.creates).toEqual(["cb-s1"]);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.name).toBe("cb-s1");
    expect(fake.spawns[0]!.argv).toEqual([stub, ...buildPiArgs({ sessionId: "s1", piSessionDir: dir, model: "m", prompt: "hi" })]);
    expect(fake.spawns[0]!.stdin).toBe("ignore");
    await pollFor(() => fake.removes.includes("cb-s1"), "sandbox removal after one-shot");
  });

  test("create failure emits a loud error and never spawns unsandboxed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-jsonfail-"));
    const fake = new FakeRunner();
    fake.failCreate = new Error("gateway refused");
    const events: AgentEvent[] = [];
    const r = await runPiStreaming({
      ...base,
      piBin: oneShotJsonStub(dir),
      piSessionDir: dir,
      workdir: dir,
      onEvent: (e) => events.push(e),
      sandboxRunner: fake,
    });
    expect(r.sawError).toBe(true);
    expect(r.sawDone).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("failed to create sandbox"))).toBe(true);
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("server wiring: enabled runs the agent inside a sandbox", () => {
  test("POST /run creates, execs through, and deletes the sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-sbx-server-"));
    for (const f of ["create.log", "exec.log", "delete.log"]) writeFileSync(join(dir, f), "");
    process.env["CB_SANDBOX_CREATE_LOG"] = join(dir, "create.log");
    process.env["CB_SANDBOX_EXEC_LOG"] = join(dir, "exec.log");
    process.env["CB_SANDBOX_DELETE_LOG"] = join(dir, "delete.log");
    const openshellStub = writeOpenshellStub(dir);
    const piStub = oneShotJsonStub(dir);
    const cfg = loadConfig({
      GATEWAY_TOKEN: "t",
      SESSION_DIR: join(dir, "sessions"),
      PI_BIN: piStub,
      MODEL: "m",
      EXECUTOR_MODE: "json",
      OPENSHELL_ENABLED: "true",
      OPENSHELL_PREFIX: "openshell exec --sandbox agent",
      OPENSHELL_SANDBOX_IMAGE: "pi-agent:local",
      OPENSHELL_POLICY: "/pol.yaml",
      OPENSHELL_PROVIDER: "prov-a",
      OPENSHELL_APPROVAL_MODE: "auto",
      OPENSHELL_BIN: openshellStub,
    } as NodeJS.ProcessEnv);
    const handler = createHandler(cfg);
    try {
      const res = await handler.handleRun(
        new Request("http://x/run", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "ssbx", prompt: "hi" }),
        }),
      );
      expect(res.status).toBe(200);
      const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      expect(events.at(-1)).toMatchObject({ type: "status", status: "done" });
      // The agent ran inside the sandbox, with create flags from config.
      const created = readFileSync(join(dir, "create.log"), "utf8");
      for (const flag of ["--name cb-ssbx", "--from pi-agent:local", "--provider prov-a", "--policy /pol.yaml", "--approval-mode auto"]) {
        expect(created).toContain(flag);
      }
      const execed = readFileSync(join(dir, "exec.log"), "utf8");
      expect(execed).toContain("-n cb-ssbx");
      expect(execed).toContain(piStub);
      // One-shot child closed: its sandbox was deleted.
      await pollFor(() => readFileSync(join(dir, "delete.log"), "utf8").includes("cb-ssbx"), "sandbox deletion after run");
      expect(handler.busy.size).toBe(0);
    } finally {
      delete process.env["CB_SANDBOX_CREATE_LOG"];
      delete process.env["CB_SANDBOX_EXEC_LOG"];
      delete process.env["CB_SANDBOX_DELETE_LOG"];
      handler.close();
    }
  });
});
