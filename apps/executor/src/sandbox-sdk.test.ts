import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@laun/protocol";
import type { ExecInteractiveSessionControl, ExecStreamChunk, ExecStreamEvent } from "@nvidia/openshell-sdk";
import { loadConfig } from "./config.js";
import { RpcManager } from "./rpc.js";
import {
  buildSandboxExecArgs,
  buildSandboxGetArgs,
  buildSandboxStartArgs,
  buildSandboxStopArgs,
  buildSandboxUploadArgs,
  CliSandboxRunner,
  connectSandboxSurface,
  DEFAULT_SANDBOX_MAX_IDLE_MS,
  SANDBOX_WORKDIR,
  SandboxReaper,
  sandboxSessionDirForSession,
  SdkSandboxRunner,
  type SdkSandboxSurface,
} from "./sandbox.js";

/**
 * Lane-sandbox-v2 tests: SDK transport + sandbox-per-session lifecycle.
 *
 * Every SDK member used here is verified against the installed
 * `@nvidia/openshell-sdk` 0.1.2 `dist/*.d.ts` (see sandbox.ts doc comments
 * for the exact locations). Fakes implement the narrow `SdkSandboxSurface`
 * and `ExecInteractiveSessionControl` shapes directly, so a renamed SDK
 * method fails at runtime here AND at `tsc` build time — never silently.
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
 * Stub of the openshell CLI surface (lifecycle verbs only — transport here
 * goes through the fake SDK surface). `get` exits 0 iff the name is listed
 * in ${LAUN_SANDBOX_EXISTING}; everything else logs and exits 0 (create
 * honors ${LAUN_SANDBOX_CREATE_EXIT:-0}).
 */
function writeOpenshellStub(dir: string): string {
  const p = join(dir, "openshell-stub.sh");
  writeFileSync(
    p,
    "#!/bin/sh\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "create" ]; then\n' +
      '  echo "$*" >> "${LAUN_SANDBOX_CREATE_LOG:-/dev/null}"\n' +
      '  exit "${LAUN_SANDBOX_CREATE_EXIT:-0}"\n' +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then\n' +
      '  echo "$*" >> "${LAUN_SANDBOX_DELETE_LOG:-/dev/null}"\n' +
      "  exit 0\n" +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "stop" ]; then\n' +
      '  echo "$*" >> "${LAUN_SANDBOX_STOP_LOG:-/dev/null}"\n' +
      "  exit 0\n" +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "start" ]; then\n' +
      '  echo "$*" >> "${LAUN_SANDBOX_START_LOG:-/dev/null}"\n' +
      "  exit 0\n" +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then\n' +
      '  echo "$* $3" >> "${LAUN_SANDBOX_GET_LOG:-/dev/null}"\n' +
      '  case " ${LAUN_SANDBOX_EXISTING:-} " in\n' +
      '    *" $3 "*) exit 0;;\n' +
      "  esac\n" +
      "  exit 1\n" +
      "fi\n" +
      'if [ "$1" = "sandbox" ] && [ "$2" = "upload" ]; then\n' +
      '  echo "$*" >> "${LAUN_SANDBOX_UPLOAD_LOG:-/dev/null}"\n' +
      "  exit 0\n" +
      "fi\n" +
      'echo "stub-openshell: unexpected argv: $*" >&2\n' +
      "exit 99\n",
  );
  chmodSync(p, 0o755);
  return p;
}

/** Scriptable fake of ExecInteractiveSessionControl (verified member names only). */
class ScriptSession implements ExecInteractiveSessionControl {
  readonly written: string[] = [];
  closeInputCalls = 0;
  cancelCalls = 0;
  resizeCalls = 0;
  exitCode: number | undefined = undefined;
  onWrite: (line: string) => void = () => {};
  private readonly queue: ExecStreamEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  private readonly donePromise: Promise<number>;
  private resolveDone!: (code: number) => void;
  private rejectDone!: (err: unknown) => void;
  readonly output: AsyncIterable<ExecStreamEvent>;

  constructor() {
    this.donePromise = new Promise<number>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A lone handler keeps an unobserved rejection from surfacing as an
    // unhandledRejection in tests that only assert the child events.
    this.donePromise.catch(() => {});
    this.output = { [Symbol.asyncIterator]: () => this.drain() };
  }

  get done(): Promise<number> {
    return this.donePromise;
  }

  private async *drain(): AsyncGenerator<ExecStreamEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  private wake(): void {
    const w = this.waiters.splice(0);
    for (const f of w) f();
  }

  push(event: ExecStreamEvent): void {
    this.queue.push(event);
    this.wake();
  }

  pushLine(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    const chunk: ExecStreamChunk = { stream, data: Buffer.from(line + "\n") };
    this.push(chunk);
  }

  write(data: Buffer): void {
    if (this.ended) throw new Error("exec input is closed");
    for (const line of data.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      this.written.push(line);
      this.onWrite(line);
    }
  }

  resize(): void {
    this.resizeCalls++;
  }

  close(): void {
    this.closeInput();
  }

  closeInput(): void {
    this.closeInputCalls++;
  }

  cancel(): void {
    this.cancelCalls++;
  }

  /** End the session like a natural process exit (exit event + done). */
  exit(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.push({ type: "exit", exitCode: code });
    this.resolveDone(code);
    this.wake();
  }

  /** Fail the transport (done rejects, output ends without an exit event). */
  failTransport(err: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.rejectDone(err);
    this.wake();
  }
}

/** Wire a ScriptSession to speak pi --mode rpc JSONL. */
function speakRpc(session: ScriptSession, delta = "hello sdk"): void {
  session.onWrite = (line) => {
    let m: { type?: string; id?: string } | null = null;
    try {
      m = JSON.parse(line) as { type?: string; id?: string };
    } catch {
      return;
    }
    if (m.type === "set_auto_retry") return;
    if (m.type === "get_state") {
      const state = typeof m.id === "string"
        ? { id: m.id, type: "state", isStreaming: false }
        : { type: "state", isStreaming: false };
      session.pushLine(JSON.stringify(state));
      return;
    }
    if (m.type === "prompt") {
      session.pushLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }));
      session.pushLine(JSON.stringify({ type: "agent_end", willRetry: false }));
      session.pushLine(JSON.stringify({ type: "agent_settled" }));
      return;
    }
    if (m.type === "abort") {
      session.pushLine(JSON.stringify({ type: "agent_settled" }));
    }
  };
}

/** Fake of the narrow SdkSandboxSurface (verified member names only). */
class FakeSurface implements SdkSandboxSurface {
  waitReadyCalls: Array<{ name: string; timeoutSecs: number }> = [];
  execCalls: Array<{ name: string; command: string[]; options?: { workdir?: string; tty?: boolean; timeoutSecs?: number } }> = [];
  failWaitReady: Error | null = null;
  sessionFactory: (name: string, command: string[]) => ScriptSession = () => new ScriptSession();

  async get(): Promise<{ phase: string }> {
    return { phase: "ready" };
  }

  async waitReady(name: string, timeoutSecs: number): Promise<unknown> {
    this.waitReadyCalls.push({ name, timeoutSecs });
    if (this.failWaitReady) throw this.failWaitReady;
    return { name };
  }

  async execInteractive(
    name: string,
    command: string[],
    options?: { workdir?: string; tty?: boolean; timeoutSecs?: number },
  ): Promise<ExecInteractiveSessionControl> {
    this.execCalls.push({ name, command, options });
    return this.sessionFactory(name, command);
  }
}

/** Collect child stdout lines with an explicit deadline (no sleeps). */
function attachCollector(child: ChildProcess): { lines: string[]; text(): string } {
  const lines: string[] = [];
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  return { lines, text: () => lines.join("\n") };
}

function waitClosed(child: ChildProcess, timeoutMs = 5000): Promise<{ code: unknown; err: unknown }> {
  return new Promise((resolve, reject) => {
    let err: unknown = null;
    const timer = setTimeout(() => reject(new Error("timed out waiting for child close")), timeoutMs);
    child.on("error", (e) => {
      err = e;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, err });
    });
  });
}

describe("lifecycle argv shaping", () => {
  test("stop/start/get/upload shape exactly", () => {
    expect(buildSandboxStopArgs("laun-s1")).toEqual(["sandbox", "stop", "laun-s1"]);
    expect(buildSandboxStartArgs("laun-s1")).toEqual(["sandbox", "start", "laun-s1"]);
    expect(buildSandboxGetArgs("laun-s1")).toEqual(["sandbox", "get", "laun-s1"]);
    expect(buildSandboxUploadArgs("laun-s1", "/tmp/ctx", "/workspace")).toEqual([
      "sandbox",
      "upload",
      "laun-s1",
      "/tmp/ctx",
      "/workspace",
    ]);
  });

  test("exec passes the in-sandbox workdir before the -- separator", () => {
    expect(buildSandboxExecArgs("laun-s1", ["pi", "--mode", "rpc"], { workdir: "/workspace" })).toEqual([
      "sandbox",
      "exec",
      "-n",
      "laun-s1",
      "--workdir",
      "/workspace",
      "--",
      "pi",
      "--mode",
      "rpc",
    ]);
    // Unset workdir keeps the exact legacy shape (no invented flags).
    expect(buildSandboxExecArgs("laun-s1", ["pi"])).toEqual(["sandbox", "exec", "-n", "laun-s1", "--", "pi"]);
  });

  test("in-sandbox paths live under /workspace", () => {
    expect(SANDBOX_WORKDIR).toBe("/workspace");
    expect(sandboxSessionDirForSession("abc")).toBe("/workspace/.laun-sessions/abc");
    expect(DEFAULT_SANDBOX_MAX_IDLE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("config: SDK selection + max idle", () => {
  const base = {
    GATEWAY_TOKEN: "x",
    OPENSHELL_ENABLED: "true",
    OPENSHELL_PREFIX: "openshell exec",
    OPENSHELL_SANDBOX_IMAGE: "pi-agent:local",
  } as NodeJS.ProcessEnv;

  test("SDK off by default; max idle defaults to 7d", () => {
    const cfg = loadConfig({ GATEWAY_TOKEN: "x" } as NodeJS.ProcessEnv);
    expect(cfg.sdkGateway ?? "").toBe("");
    expect(cfg.sandboxMaxIdleMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("parses SDK gateway + auth + max idle", () => {
    const cfg = loadConfig({
      ...base,
      OPENSHELL_SDK_GATEWAY: "https://127.0.0.1:17670",
      OPENSHELL_SDK_TOKEN: "tok",
      OPENSHELL_SANDBOX_MAX_IDLE_MS: "86400000",
    } as NodeJS.ProcessEnv);
    expect(cfg.sdkGateway).toBe("https://127.0.0.1:17670");
    expect(cfg.sdkToken).toBe("tok");
    expect(cfg.sandboxMaxIdleMs).toBe(86_400_000);
  });

  test("rejects bad SDK gateway URLs", () => {
    expect(() => loadConfig({ ...base, OPENSHELL_SDK_GATEWAY: "not a url" } as NodeJS.ProcessEnv)).toThrow(
      "OPENSHELL_SDK_GATEWAY",
    );
    expect(() => loadConfig({ ...base, OPENSHELL_SDK_GATEWAY: "ftp://x/y" } as NodeJS.ProcessEnv)).toThrow(
      "OPENSHELL_SDK_GATEWAY",
    );
  });

  test("SDK without sandbox mode fails closed", () => {
    expect(() => loadConfig({ GATEWAY_TOKEN: "x", OPENSHELL_SDK_GATEWAY: "https://127.0.0.1:17670" } as NodeJS.ProcessEnv)).toThrow(
      "OPENSHELL_ENABLED",
    );
  });

  test("half-paired client cert files fail closed", () => {
    expect(() => loadConfig({ ...base, OPENSHELL_SDK_CLIENT_CERT_FILE: "/c.pem" } as NodeJS.ProcessEnv)).toThrow(
      "CLIENT_CERT_FILE",
    );
    expect(() => loadConfig({ ...base, OPENSHELL_SDK_CLIENT_KEY_FILE: "/k.pem" } as NodeJS.ProcessEnv)).toThrow(
      "CLIENT_CERT_FILE",
    );
  });

  test("rejects tiny max idle values", () => {
    expect(() => loadConfig({ ...base, OPENSHELL_SANDBOX_MAX_IDLE_MS: "0" } as NodeJS.ProcessEnv)).toThrow(
      "OPENSHELL_SANDBOX_MAX_IDLE_MS",
    );
    expect(() => loadConfig({ ...base, OPENSHELL_SANDBOX_MAX_IDLE_MS: "-5" } as NodeJS.ProcessEnv)).toThrow(
      "OPENSHELL_SANDBOX_MAX_IDLE_MS",
    );
  });
});

describe("SDK connect validation (no network)", () => {
  test("empty/bad gateway and unreadable PEMs throw before any RPC", async () => {
    await expect(connectSandboxSurface({ gateway: "" })).rejects.toThrow("gateway URL is required");
    await expect(connectSandboxSurface({ gateway: "not a url" })).rejects.toThrow("valid URL");
    await expect(connectSandboxSurface({ gateway: "nope://x" })).rejects.toThrow("http(s)");
    await expect(connectSandboxSurface({ gateway: "ftp://x/y" })).rejects.toThrow("http(s)");
    await expect(connectSandboxSurface({ gateway: "https://127.0.0.1:17670", clientCertFile: "/c" })).rejects.toThrow(
      "together",
    );
    await expect(
      connectSandboxSurface({
        gateway: "https://127.0.0.1:17670",
        clientCertFile: "/definitely/missing-cert.pem",
        clientKeyFile: "/definitely/missing-key.pem",
      }),
    ).rejects.toThrow("cannot read client cert");
  });

  test("connect is lazy: resolving exposes the verified surface with no RPC", async () => {
    // The SDK documents connect() as lazy (no RPC until first use), so this
    // resolves offline against a dead port. It pins the export shape at
    // runtime: a renamed SDK method fails here, not just at tsc time.
    const surface = await connectSandboxSurface({ gateway: "http://127.0.0.1:1" });
    expect(typeof surface.get).toBe("function");
    expect(typeof surface.waitReady).toBe("function");
    expect(typeof surface.execInteractive).toBe("function");
  });
});

describe("SDK interactive transport (fake surface, no binary)", () => {
  test("stdin writes reach the session; session output streams back; exit closes", async () => {
    const surface = new FakeSurface();
    let session!: ScriptSession;
    surface.sessionFactory = () => {
      session = new ScriptSession();
      session.onWrite = (line) => session.pushLine(`got:${line}`);
      return session;
    };
    const runner = new SdkSandboxRunner({ image: "img", surface });
    const child = runner.spawnInteractive("laun-s1", ["pi", "--mode", "rpc"], { cwd: "/tmp", env: process.env });
    const coll = attachCollector(child);
    const closedP = waitClosed(child);
    child.stdin!.write('{"type":"prompt","message":"hi"}\n');
    await pollFor(() => coll.lines.length >= 1, "echoed session output");
    expect(coll.lines[0]).toContain("got:");
    expect(session.written).toHaveLength(1);
    // Transport options are the verified SDK spelling: pipes, never a PTY.
    expect(surface.execCalls).toHaveLength(1);
    expect(surface.execCalls[0]).toMatchObject({
      name: "laun-s1",
      command: ["pi", "--mode", "rpc"],
      options: { workdir: "/workspace", tty: false, timeoutSecs: 0 },
    });
    session.exit(0);
    const { code, err } = await closedP;
    expect(err).toBeNull();
    expect(code).toBe(0);
    expect(child.exitCode).toBe(0);
  });

  test("writes before attach are buffered and flushed in order", async () => {
    const surface = new FakeSurface();
    let release!: (s: ScriptSession) => void;
    const gate = new Promise<ScriptSession>((r) => {
      release = r;
    });
    surface.execInteractive = async () => gate;
    const runner = new SdkSandboxRunner({ image: "img", surface });
    const child = runner.spawnInteractive("laun-s1", ["pi"], { cwd: "/tmp", env: process.env });
    const coll = attachCollector(child);
    const closedP = waitClosed(child);
    // Two writes land before the session exists: they must not be lost.
    child.stdin!.write('{"seq":1}\n');
    child.stdin!.write('{"seq":2}\n');
    const session = new ScriptSession();
    session.onWrite = (line) => session.pushLine(`got:${line}`);
    release(session);
    await pollFor(() => session.written.length >= 2, "buffered writes flushed");
    expect(session.written).toEqual(['{"seq":1}', '{"seq":2}']);
    session.exit(0);
    const { code } = await closedP;
    expect(code).toBe(0);
    expect(coll.lines.join("\n")).toContain("seq");
  });

  test("attach failure emits error + close (never a silent hang)", async () => {
    const runner = new SdkSandboxRunner({ image: "img", connect: () => Promise.reject(new Error("gateway down")) });
    const child = runner.spawnInteractive("laun-s1", ["pi"], { cwd: "/tmp", env: process.env });
    const { code, err } = await waitClosed(child);
    expect((err as Error).message).toContain("gateway down");
    expect(code).toBeNull();
  });

  test("ignore-mode ends stdin immediately and closes remote input on attach", async () => {
    const surface = new FakeSurface();
    const session = new ScriptSession();
    surface.sessionFactory = () => session;
    const runner = new SdkSandboxRunner({ image: "img", surface });
    const child = runner.spawnInteractive("laun-s1", ["pi", "-p"], { cwd: "/tmp", env: process.env, stdin: "ignore" });
    const closedP = waitClosed(child);
    await pollFor(() => session.closeInputCalls >= 1, "remote input closed");
    expect(child.stdin!.destroyed || child.stdin!.writableEnded).toBe(true);
    session.exit(0);
    const { code } = await closedP;
    expect(code).toBe(0);
  });

  test("kill cancels the session and closes with a null code and no error", async () => {
    const surface = new FakeSurface();
    const session = new ScriptSession();
    surface.sessionFactory = () => session;
    const runner = new SdkSandboxRunner({ image: "img", surface });
    const child = runner.spawnInteractive("laun-s1", ["pi"], { cwd: "/tmp", env: process.env });
    let sawError = false;
    child.on("error", () => {
      sawError = true;
    });
    const closedP = waitClosed(child);
    child.kill("SIGKILL");
    const { code } = await closedP;
    expect(code).toBeNull();
    // The kill wins synchronously; the still-in-flight attach observes the
    // closed child on the next microtask and cancels the session (no leak).
    await pollFor(() => session.cancelCalls >= 1, "late-attach cancel");
    expect(session.cancelCalls).toBe(1);
    expect(sawError).toBe(false);
  });

  test("transport failure emits error with the observed exit retained", async () => {
    const surface = new FakeSurface();
    const session = new ScriptSession();
    surface.sessionFactory = () => session;
    const runner = new SdkSandboxRunner({ image: "img", surface });
    const child = runner.spawnInteractive("laun-s1", ["pi"], { cwd: "/tmp", env: process.env });
    const closedP = waitClosed(child);
    session.failTransport(new Error("gateway stream reset"));
    const { code, err } = await closedP;
    expect((err as Error).message).toContain("gateway stream reset");
    expect(code).toBeNull();
  });
});

describe("SDK create waits ready and cleans up loudly", () => {
  test("create runs CLI create then SDK waitReady; waitReady failure deletes + throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-sdk-create-"));
    const createLog = join(dir, "create.log");
    const deleteLog = join(dir, "delete.log");
    writeFileSync(createLog, "");
    writeFileSync(deleteLog, "");
    process.env["LAUN_SANDBOX_CREATE_LOG"] = createLog;
    process.env["LAUN_SANDBOX_DELETE_LOG"] = deleteLog;
    const stub = writeOpenshellStub(dir);
    try {
      const surface = new FakeSurface();
      const ok = new SdkSandboxRunner({ bin: stub, image: "pi-agent:local", surface });
      await ok.create({ name: "laun-s1" });
      expect(readFileSync(createLog, "utf8")).toContain("--name laun-s1");
      expect(surface.waitReadyCalls).toEqual([{ name: "laun-s1", timeoutSecs: 120 }]);

      const failing = new FakeSurface();
      failing.failWaitReady = new Error("still provisioning");
      const runner = new SdkSandboxRunner({ bin: stub, image: "pi-agent:local", surface: failing });
      await expect(runner.create({ name: "laun-s2" })).rejects.toThrow("not ready");
      // Half-made sandbox does not leak: deleted, and the run still fails loudly.
      expect(readFileSync(deleteLog, "utf8")).toContain("laun-s2");
    } finally {
      delete process.env["LAUN_SANDBOX_CREATE_LOG"];
      delete process.env["LAUN_SANDBOX_DELETE_LOG"];
    }
  });

  test("no surface and no factory fails closed", async () => {
    const runner = new SdkSandboxRunner({ image: "img" });
    const child = runner.spawnInteractive("laun-s1", ["pi"], { cwd: "/tmp", env: process.env });
    const { err } = await waitClosed(child);
    expect((err as Error).message).toContain("fail closed");
  });
});

describe("context upload on create (stub CLI)", () => {
  test("non-empty host dir is uploaded into /workspace; empty dir skips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-sdk-upload-"));
    const uploadLog = join(dir, "upload.log");
    writeFileSync(uploadLog, "");
    process.env["LAUN_SANDBOX_UPLOAD_LOG"] = uploadLog;
    const stub = writeOpenshellStub(dir);
    const ctx = join(dir, "ctx");
    const { mkdirSync } = await import("node:fs");
    try {
      mkdirSync(join(ctx, "sub"), { recursive: true });
      writeFileSync(join(ctx, "goal.md"), "# goal\n");
      const runner = new CliSandboxRunner({ bin: stub, image: "img" });
      await runner.create({ name: "laun-s1", uploadFrom: ctx });
      const logged = readFileSync(uploadLog, "utf8");
      expect(logged).toContain(`sandbox upload laun-s1 ${ctx} /workspace`);

      writeFileSync(uploadLog, "");
      const empty = join(dir, "empty");
      mkdirSync(empty, { recursive: true });
      await runner.create({ name: "laun-s2", uploadFrom: empty });
      expect(readFileSync(uploadLog, "utf8")).not.toContain("laun-s2");

      writeFileSync(uploadLog, "");
      await runner.create({ name: "laun-s3" });
      expect(readFileSync(uploadLog, "utf8")).toBe("");
    } finally {
      delete process.env["LAUN_SANDBOX_UPLOAD_LOG"];
    }
  });
});

describe("lifecycle: create -> run -> stop -> start -> run -> delete (fakes)", () => {
  test("stop preserves the session; start resumes it; only the reaper deletes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-sdk-life-"));
    for (const f of ["create.log", "start.log", "stop.log", "delete.log"]) writeFileSync(join(dir, f), "");
    process.env["LAUN_SANDBOX_CREATE_LOG"] = join(dir, "create.log");
    process.env["LAUN_SANDBOX_START_LOG"] = join(dir, "start.log");
    process.env["LAUN_SANDBOX_STOP_LOG"] = join(dir, "stop.log");
    process.env["LAUN_SANDBOX_DELETE_LOG"] = join(dir, "delete.log");
    const stub = writeOpenshellStub(dir);
    const surface = new FakeSurface();
    const sessions: ScriptSession[] = [];
    surface.sessionFactory = () => {
      const s = new ScriptSession();
      speakRpc(s);
      sessions.push(s);
      return s;
    };
    const runner = new SdkSandboxRunner({ bin: stub, image: "pi-agent:local", surface });
    const reaper = new SandboxReaper({
      runner,
      maxIdleMs: 60_000,
      sweepIntervalMs: 0,
      metaFile: join(dir, "meta.json"),
    });
    const mgr = new RpcManager({
      piBin: "pi",
      openshellPrefix: [],
      idleTtlMs: 150,
      sandboxRunner: runner,
      reaper,
    });
    try {
      const runOpts = (prompt: string) => ({
        sessionId: "s1",
        // Session files live INSIDE the sandbox: the same dir across
        // stop/start is what makes session continuity real.
        piSessionDir: sandboxSessionDirForSession("s1"),
        workdir: dir,
        sandboxWorkdir: SANDBOX_WORKDIR,
        model: "m",
        prompt,
        timeoutMs: 10_000,
        onEvent: (e: AgentEvent) => {
          void e;
        },
      });
      const createLines = () => readFileSync(join(dir, "create.log"), "utf8").trim().split("\n").filter(Boolean);
      // create -> run (stub `get` finds nothing: LAUN_SANDBOX_EXISTING unset)
      const r1 = await mgr.run(runOpts("first"));
      expect(r1.sawDone).toBe(true);
      expect(createLines()).toHaveLength(1);
      expect(surface.execCalls[0]?.options?.workdir).toBe("/workspace");
      // idle reap -> STOP (workspace preserved), never delete
      await pollFor(() => mgr.has("s1") === false, "idle reap");
      await pollFor(() => readFileSync(join(dir, "stop.log"), "utf8").includes("laun-s1"), "sandbox stop");
      expect(readFileSync(join(dir, "delete.log"), "utf8")).toBe("");
      // The stopped sandbox now exists: the next run STARTS it (no recreate)
      // and resumes the same in-sandbox session dir.
      process.env["LAUN_SANDBOX_EXISTING"] = "laun-s1";
      const r2 = await mgr.run(runOpts("second"));
      expect(r2.sawDone).toBe(true);
      expect(createLines()).toHaveLength(1);
      expect(readFileSync(join(dir, "start.log"), "utf8")).toContain("laun-s1");
      expect(surface.execCalls).toHaveLength(2);
      expect(surface.execCalls[1]?.options?.workdir).toBe("/workspace");
      expect(sessions).toHaveLength(2);
      // Only the age reaper deletes: a fresh sweep deletes nothing …
      expect(await reaper.sweep(Date.now())).toEqual([]);
      expect(readFileSync(join(dir, "delete.log"), "utf8")).toBe("");
      // … an aged sweep deletes exactly the idle sandbox.
      expect(await reaper.sweep(Date.now() + 61_000)).toEqual(["laun-s1"]);
      expect(readFileSync(join(dir, "delete.log"), "utf8")).toContain("laun-s1");
      expect(reaper.tracked).toEqual([]);
    } finally {
      delete process.env["LAUN_SANDBOX_CREATE_LOG"];
      delete process.env["LAUN_SANDBOX_START_LOG"];
      delete process.env["LAUN_SANDBOX_STOP_LOG"];
      delete process.env["LAUN_SANDBOX_DELETE_LOG"];
      delete process.env["LAUN_SANDBOX_EXISTING"];
      mgr.close();
      reaper.close();
    }
  });
});

describe("age reaper deletes only the aged", () => {
  test("sweep respects per-sandbox activity; meta file survives restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-sdk-reap-"));
    const removed: string[] = [];
    const runner = {
      create: async () => {},
      spawnInteractive: () => {
        throw new Error("not used");
      },
      remove: async (name: string) => {
        removed.push(name);
      },
      stop: async () => {},
      start: async () => {},
      exists: async () => false,
    };
    const metaFile = join(dir, "meta.json");
    let now = 1_000_000;
    const reaper = new SandboxReaper({ runner, maxIdleMs: 10_000, sweepIntervalMs: 0, metaFile, now: () => now });
    try {
      reaper.track("laun-fresh");
      now += 9_000;
      reaper.track("laun-newer");
      now += 2_000; // fresh is 11s idle (aged), newer is 2s idle
      expect(await reaper.sweep()).toEqual(["laun-fresh"]);
      expect(removed).toEqual(["laun-fresh"]);
      expect(reaper.tracked).toEqual(["laun-newer"]);
      // Persistence: a new reaper on the same file knows laun-newer.
      const reaper2 = new SandboxReaper({ runner, maxIdleMs: 10_000, sweepIntervalMs: 0, metaFile, now: () => now });
      try {
        expect(reaper2.tracked).toEqual(["laun-newer"]);
        expect(await reaper2.sweep()).toEqual([]);
        expect(await reaper2.sweep(now + 10_001)).toEqual(["laun-newer"]);
      } finally {
        reaper2.close();
      }
      // Corrupt meta starts fresh instead of throwing.
      writeFileSync(metaFile, "not json{{{");
      const reaper3 = new SandboxReaper({ runner, maxIdleMs: 10_000, sweepIntervalMs: 0, metaFile, now: () => now });
      try {
        expect(reaper3.tracked).toEqual([]);
        expect(await reaper3.sweep()).toEqual([]);
      } finally {
        reaper3.close();
      }
    } finally {
      reaper.close();
    }
  });
});
