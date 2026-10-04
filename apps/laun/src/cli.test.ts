import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentKey } from "@laun/protocol";
import { UsageError, flagBool, flagString, parseArgs, requiredArg } from "./args.js";
import {
  isValidTargetName,
  listNamedTargets,
  loadNamedTarget,
  loadTarget,
  resolveTarget,
  saveNamedTarget,
  saveTarget,
  targetUrl,
} from "./config.js";
import { main, type Io } from "./index.js";
import { ensureEnv, parseSshTarget, readEnvValue, upsertEnv } from "./setup.js";
import { bunRunner, lastMatch, runRemoteSetup, shQuote, sshArgv, type CommandRunner } from "./ssh.js";

describe("args", () => {
  test("parses values, booleans, equals form, and --", () => {
    const { positionals, flags } = parseArgs(["--host", "1.2.3.4", "--json", "--port=9000", "goal text", "--", "--literal"], {
      boolean: ["json"],
      value: ["host", "port"],
    });
    expect(flagString(flags, "host")).toBe("1.2.3.4");
    expect(flagString(flags, "port")).toBe("9000");
    expect(flagBool(flags, "json")).toBe(true);
    expect(positionals).toEqual(["goal text", "--literal"]);
  });

  test("short flags work for -i", () => {
    const { flags } = parseArgs(["-i", "~/.ssh/id_ed25519", "host"], { value: ["i"] });
    expect(flagString(flags, "i")).toBe("~/.ssh/id_ed25519");
  });

  test("unknown flags and missing values are hard errors", () => {
    expect(() => parseArgs(["--nope"], { boolean: ["json"] })).toThrow(UsageError);
    expect(() => parseArgs(["--host"], { value: ["host"] })).toThrow("requires a value");
    expect(() => parseArgs(["--json=1"], { boolean: ["json"] })).toThrow("does not take a value");
    expect(() => requiredArg([], 0, "goal", "usage")).toThrow(UsageError);
  });
});

describe("config", () => {
  test("saves 0600 in a 0700 dir and round-trips", () => {
    const home = mkdtempSync(join(tmpdir(), "laun-home-"));
    const path = saveTarget({ host: "203.0.113.9", port: 8080, scheme: "http", key: "laun_aabbccdd_secretsecretsecretsecret", keyId: "aabbccdd" }, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".laun")).mode & 0o777).toBe(0o700);
    expect(loadTarget(home)?.host).toBe("203.0.113.9");
  });

  test("env overrides the saved target, and half a target is ignored", () => {
    const home = mkdtempSync(join(tmpdir(), "laun-home-"));
    saveTarget({ host: "saved", port: 8080, scheme: "http", key: "laun_aabbccdd_secretsecretsecretsecret" }, home);
    expect(resolveTarget({} as NodeJS.ProcessEnv, home)?.host).toBe("saved");
    expect(resolveTarget({ LAUN_KEY: "k" } as NodeJS.ProcessEnv, home)?.host).toBe("saved");
    expect(resolveTarget({ LAUN_HOST: "envhost", LAUN_KEY: "laun_aabbccdd_secretsecretsecretsecret" } as NodeJS.ProcessEnv, home)?.host).toBe("envhost");
  });

  test("missing file yields null instead of throwing", () => {
    expect(loadTarget(mkdtempSync(join(tmpdir(), "laun-home-"))) ).toBeNull();
  });

  test("targetUrl keeps IPv6 usable", () => {
    expect(targetUrl({ host: "1.2.3.4", port: 8080, scheme: "http" })).toBe("http://1.2.3.4:8080");
    expect(targetUrl({ host: "::1", port: 8080, scheme: "http" })).toBe("http://[::1]:8080");
  });
});

describe("env generation", () => {
  test("seeds every key the example defines but the file lacks", () => {
    // Regression: `setup ssh` writes this file to the host verbatim, so a key
    // missing locally silently reverted the remote — EXECUTOR_MODE=rpc was
    // wiped back to json by a later setup run.
    const dir = mkdtempSync(join(tmpdir(), "laun-envseed-"));
    const envPath = join(dir, ".env");
    const examplePath = join(dir, "example.env");
    writeFileSync(examplePath, "GATEWAY_TOKEN=change-me\nLAUN_KEY=\nEXECUTOR_MODE=rpc\nRUN_TIMEOUT_MS=1800000\n");
    writeFileSync(envPath, "GATEWAY_TOKEN=mine-keep-me\nLAUN_KEY=\n");

    const first = ensureEnv(envPath, examplePath);
    expect(readEnvValue(first.content, "GATEWAY_TOKEN")).toBe("mine-keep-me"); // untouched
    expect(readEnvValue(first.content, "EXECUTOR_MODE")).toBe("rpc"); // seeded
    expect(readEnvValue(first.content, "RUN_TIMEOUT_MS")).toBe("1800000"); // seeded
    expect(readEnvValue(first.content, "LAUN_KEY")).toMatch(/^laun_/); // generated

    const again = ensureEnv(envPath, examplePath);
    expect(readEnvValue(again.content, "EXECUTOR_MODE")).toBe("rpc"); // idempotent
    expect(again.token).toBe(first.token);
    expect(again.key).toBe(first.key);
  });

  test("fills placeholders and never clobbers a live secret", () => {
    const example = "GATEWAY_TOKEN=change-me-to-a-long-random-string\nOTHER=1\n";
    const first = ensureEnv(join(mkdtempSync(join(tmpdir(), "laun-env-")), ".env"), "");
    expect(first.token.length).toBeGreaterThan(20);
    expect(parseAgentKey(first.key)?.id).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), "laun-env-"));
    const examplePath = join(dir, "example.env");
    const envPath = join(dir, ".env");
    writeFileSync(examplePath, example);
    const created = ensureEnv(envPath, examplePath);
    expect(created.created).toBe(true);
    expect(readEnvValue(created.content, "GATEWAY_TOKEN")).toBe(created.token);
    expect(readEnvValue(created.content, "OTHER")).toBe("1");
    expect(parseAgentKey(readEnvValue(created.content, "LAUN_KEY")!)).not.toBeNull();

    // re-running keeps the same gateway token and key
    const again = ensureEnv(envPath, examplePath);
    expect(again.token).toBe(created.token);
    expect(again.key).toBe(created.key);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    // an existing hand-written token is preserved verbatim
    const custom = upsertEnv("GATEWAY_TOKEN=my-own-token\nLAUN_KEY=\n", { GATEWAY_TOKEN: "generated", LAUN_KEY: "laun_aabbccdd_x" });
    expect(readEnvValue(custom, "GATEWAY_TOKEN")).toBe("my-own-token");
    expect(readEnvValue(custom, "LAUN_KEY")).toBe("laun_aabbccdd_x");
  });
});

describe("ssh layer", () => {
  const spec = { identity: "/k/id_ed25519", host: "203.0.113.9", user: "root" };

  test("sshArgv is non-interactive and quotes the remote command", () => {
    const argv = sshArgv(spec, "echo hi");
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    expect(argv).toContain("root@203.0.113.9");
    expect(argv[argv.length - 1]).toBe("echo hi");
    expect(sshArgv({ ...spec, port: 2222 }, "x")).toContain("2222");
  });

  test("shQuote survives single quotes and spaces", () => {
    expect(shQuote("/opt/my dir")).toBe("'/opt/my dir'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  test("runRemoteSetup writes env, runs bootstrap, and never puts the key in argv", async () => {
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const runner: CommandRunner = async (argv, opts) => {
      calls.push({ argv, stdin: opts?.stdin });
      return { code: 0, stdout: "==> done\nLAUN_DIR=/opt/laun\nLAUN_PORT=8081\nLAUN_KEY=laun_aabbccdd_secretsecretsecretsecret\n", stderr: "" };
    };
    const key = "laun_aabbccdd_secretsecretsecretsecret";
    const result = await runRemoteSetup({
      ...spec,
      remoteDir: "/opt/laun",
      repoUrl: "git@github.com:me/laun.git",
      envContent: `GATEWAY_TOKEN=super-secret-token\nLAUN_KEY=${key}\n`,
      bootstrapScript: "#!/usr/bin/env bash\nset -euo pipefail\n",
      runner,
    });

    expect(result).toEqual({ key, port: 8081, dir: "/opt/laun" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toContain("mkdir -p '/opt/laun'");
    // non-root users need the sudo fallback for paths such as /opt/...
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toContain("sudo -n mkdir -p '/opt/laun'");
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toContain("$(id -u):$(id -g)");
    expect(calls[1]!.argv[calls[1]!.argv.length - 1]).toContain("cat > '/opt/laun'/.env");
    expect(calls[2]!.argv[calls[2]!.argv.length - 1]).toBe("bash -s -- '/opt/laun' 'git@github.com:me/laun.git'");
    // the env travels on stdin, and no secret ever appears in argv
    expect(calls[1]!.stdin).toContain(key);
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(key);
      expect(call.argv.join(" ")).not.toContain("super-secret-token");
    }
  });

  test("runRemoteSetup fails loudly when the bootstrap prints no key", async () => {
    let call = 0;
    const runner: CommandRunner = async () => {
      call++;
      // mkdir and env write succeed; the bootstrap itself fails without a key
      return call < 3 ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "==> ERROR: boom", stderr: "nope" };
    };
    await expect(
      runRemoteSetup({ ...spec, remoteDir: "/d", envContent: "x", bootstrapScript: "y", runner }),
    ).rejects.toThrow(/remote setup failed.*LAUN_KEY/s);
  });

  test("runRemoteSetup surfaces an ssh failure before bootstrapping", async () => {
    const runner: CommandRunner = async () => ({ code: 255, stdout: "", stderr: "Permission denied" });
    await expect(
      runRemoteSetup({ ...spec, remoteDir: "/d", envContent: "x", bootstrapScript: "y", runner }),
    ).rejects.toThrow(/ssh mkdir failed.*Permission denied/s);
  });

  test("echo streams to the terminal AND still returns the full output", async () => {
    // Regression: setup ssh used to pipe the remote bootstrap silently, so a
    // 3-10 minute apt/build sequence looked like a hang. Echoing must not cost
    // us the captured text the key is parsed from.
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let seen = "";
    let r: Awaited<ReturnType<typeof bunRunner>> | null = null;
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      seen += s;
      return true;
    };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      seen += s;
      return true;
    };
    try {
      r = await bunRunner(["sh", "-c", "echo streamed-out; echo streamed-err >&2"], { echo: true });
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origOut;
      (process.stderr as unknown as { write: unknown }).write = origErr;
    }
    expect(r?.code).toBe(0);
    expect(r?.stdout.trim()).toBe("streamed-out"); // captured for parsing
    expect(seen).toContain("streamed-out"); // shown to the operator
    expect(seen).toContain("streamed-err");
  });

  test("without echo nothing is written to our own streams", async () => {
    const origOut = process.stdout.write.bind(process.stdout);
    let seen = "";
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      seen += s;
      return true;
    };
    let r: Awaited<ReturnType<typeof bunRunner>> | null = null;
    try {
      r = await bunRunner(["sh", "-c", "echo quiet"]);
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origOut;
    }
    expect(r?.stdout.trim()).toBe("quiet");
    expect(seen).toBe("");
  });

  test("lastMatch returns the final occurrence", () => {
    expect(lastMatch("LAUN_KEY=a\nLAUN_KEY=b\n", /^LAUN_KEY=(.*)$/m)).toBe("b");
    expect(lastMatch("nothing", /^LAUN_KEY=(.*)$/m)).toBeNull();
  });
});

describe("parseSshTarget", () => {
  test("never produces root@ubuntu@host", () => {
    // the bug: a user embedded in the host got prefixed with the default user
    expect(parseSshTarget("ubuntu@1.2.3.4")).toEqual({ user: "ubuntu", host: "1.2.3.4" });
    expect(parseSshTarget("ubuntu@1.2.3.4", "root")).toEqual({ user: "root", host: "1.2.3.4" });
    expect(parseSshTarget("root@1.2.3.4")).toEqual({ user: "root", host: "1.2.3.4" });
  });

  test("a bare host falls back to the default user", () => {
    expect(parseSshTarget("1.2.3.4")).toEqual({ user: "root", host: "1.2.3.4" });
    expect(parseSshTarget("1.2.3.4", "ubuntu")).toEqual({ user: "ubuntu", host: "1.2.3.4" });
    expect(parseSshTarget("1.2.3.4", undefined, "deploy")).toEqual({ user: "deploy", host: "1.2.3.4" });
  });

  test("the flag beats an embedded user, and IPv6 survives", () => {
    expect(parseSshTarget("alice@srv.example", "bob")).toEqual({ user: "bob", host: "srv.example" });
    expect(parseSshTarget("[2001:db8::1]", "ubuntu")).toEqual({ user: "ubuntu", host: "[2001:db8::1]" });
  });

  test("an empty host is a usage error", () => {
    expect(() => parseSshTarget("ubuntu@")).toThrow(UsageError);
  });
});

describe("bootstrap contract", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");

  test("deploy/bootstrap.sh exists, is bash-valid, and prints the key last", () => {
    const body = readFileSync(join(repoRoot, "deploy", "bootstrap.sh"), "utf8");
    expect(body).toContain("set -euo pipefail");
    expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
    // the key must be the last summary line the CLI parses
    const lines = body.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toContain("LAUN_KEY=");
    // and the service token must never be echoed
    expect(body).not.toMatch(/printf.*GATEWAY_TOKEN/);
  });

  test("compose must not read HOME for the pi mount (sudo resolves it to /root)", () => {
    const compose = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
    // regression: `${HOME}/.pi` bound /root/.pi when compose ran under sudo,
    // silently mounting an empty read-only dir and breaking pi entirely.
    expect(compose).not.toMatch(/- \$\{HOME\}\/\.pi/);
    expect(compose).toContain("${PI_CONFIG_DIR:-${HOME}/.pi}:/root/.pi");
    // pi must be able to create ~/.pi/agent, so the mount cannot be read-only
    expect(compose).not.toContain("/root/.pi:ro");

    const bootstrap = readFileSync(join(repoRoot, "deploy", "bootstrap.sh"), "utf8");
    // bootstrap resolves the invoking user's home and passes it through sudo
    expect(bootstrap).toContain("getent passwd");
    expect(bootstrap).toContain('env PI_CONFIG_DIR="$PI_CONFIG_DIR"');
    // it must resolve to <home>/.pi — never the bare home directory, which
    // would mount ssh keys and everything else into the container
    expect(bootstrap).toMatch(/\$PI_HOME\/\.pi/);
    expect(bootstrap).toContain("*.pi");
    // and warns when there is no pi login, instead of failing opaquely later
    expect(bootstrap).toContain("agent/auth.json");
    // the resolved path must be persisted so a later manual `docker compose up`
    // (which never runs this script) cannot fall back to HOME=/root
    expect(bootstrap).toContain("^PI_CONFIG_DIR=");
    expect(bootstrap).toContain("PI_CONFIG_DIR=%s");
  });
});
describe("named targets", () => {
  const KEY = "laun_aabbccdd_" + "s".repeat(30);

  test("save/load round-trips with the same 0600/0700 conventions as the default file", () => {
    const home = mkdtempSync(join(tmpdir(), "laun-targets-"));
    const path = saveNamedTarget("vps1", { host: "203.0.113.9", port: 8080, scheme: "http", key: KEY, keyId: "aabbccdd" }, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadNamedTarget("vps1", home)).toEqual({ host: "203.0.113.9", port: 8080, scheme: "http", key: KEY, keyId: "aabbccdd" });
    expect(loadNamedTarget("missing", home)).toBeNull();
  });

  test("names are safe slugs — traversal and slashes rejected", () => {
    expect(isValidTargetName("vps1")).toBe(true);
    expect(isValidTargetName("my-host_2")).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "a b", ".hidden", "x".repeat(65)]) {
      expect(isValidTargetName(bad)).toBe(false);
    }
    const home = mkdtempSync(join(tmpdir(), "laun-targets-"));
    expect(() => saveNamedTarget("../evil", { host: "h", port: 1, scheme: "http", key: KEY }, home)).toThrow();
  });

  test("list is sorted by name and skips corrupt files", () => {
    const home = mkdtempSync(join(tmpdir(), "laun-targets-"));
    saveNamedTarget("b-host", { host: "b", port: 8080, scheme: "http", key: KEY }, home);
    saveNamedTarget("a-host", { host: "a", port: 8080, scheme: "http", key: KEY }, home);
    writeFileSync(join(home, ".laun", "targets", "broken.json"), "not json{");
    expect(listNamedTargets(home).map((t) => t.name)).toEqual(["a-host", "b-host"]);
    expect(listNamedTargets(mkdtempSync(join(tmpdir(), "laun-targets-")))).toEqual([]);
  });

  test("a named selection resolves; an absent flag keeps the current default", () => {
    const home = mkdtempSync(join(tmpdir(), "laun-targets-"));
    saveNamedTarget("vps1", { host: "named-host", port: 8080, scheme: "http", key: KEY }, home);
    const env = { HOME: home, LAUN_HOST: "env-host", LAUN_KEY: KEY } as NodeJS.ProcessEnv;
    // Explicit --target wins over the env override.
    expect(resolveTarget(env, home, "vps1")?.host).toBe("named-host");
    // Without it, resolution is exactly what it always was (env here).
    expect(resolveTarget(env, home)?.host).toBe("env-host");
    expect(resolveTarget({} as NodeJS.ProcessEnv, home)?.host).toBeUndefined();
    expect(resolveTarget({} as NodeJS.ProcessEnv, home)).toBeNull();
  });
});

describe("target + watch + doctor commands", () => {
  const KEY = "laun_aabbccdd_" + "q".repeat(30);
  const rec = {
    id: "s1",
    goal: "a goal",
    model: "m",
    runtime: "pi",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") return Response.json({ ok: true, service: "gateway", executor: "http://x" });
        if (url.pathname === "/sessions" && req.method === "GET") return Response.json({ sessions: [rec] });
        const sess = url.pathname.match(/^\/sessions\/([^/]+)$/);
        if (sess && req.method === "GET") {
          const id = sess[1]!;
          if (id === "s1") return Response.json({ session: rec, pendingApprovals: [] });
          if (id === "quiet") return Response.json({ session: { ...rec, id: "quiet" }, pendingApprovals: [] });
          return Response.json({ error: "unknown session" }, { status: 404 });
        }
        const logm = url.pathname.match(/^\/sessions\/([^/]+)\/log$/);
        if (logm) {
          const id = logm[1]!;
          if (id !== "s1" && id !== "quiet") return Response.json({ error: "unknown session" }, { status: 404 });
          const since = Number(url.searchParams.get("since") ?? 0);
          const events = id === "s1" ? [{ type: "done", sessionId: "s1", summary: "served" }] : [];
          return Response.json({ sessionId: id, events, next: since + events.length });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  function makeIo(): Io & { lines: string[]; errs: string[]; written: string[] } {
    const lines: string[] = [];
    const errs: string[] = [];
    const written: string[] = [];
    return { lines, errs, written, out: (l) => void lines.push(l), err: (l) => void errs.push(l), write: (t) => void written.push(t) };
  }

  function serverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const u = new URL(base);
    return { LAUN_HOST: u.hostname, LAUN_PORT: u.port, LAUN_KEY: KEY, ...extra } as NodeJS.ProcessEnv;
  }

  test("target add/ls round-trips; ls shows the id, never the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "laun-targetcmd-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const u = new URL(base);
    let io = makeIo();
    expect(await main(["target", "add", "n1", "--host", u.hostname, "--port", u.port, "--key", KEY], env, io)).toBe(0);
    expect(io.lines.join("\n")).toContain('saved target "n1"');
    io = makeIo();
    expect(await main(["target", "ls"], env, io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("n1");
    expect(text).toContain(u.hostname);
    expect(text).toContain("aabbccdd");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("q".repeat(10));
  });

  test("target add validates its inputs", async () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), "laun-targetcmd-")) } as NodeJS.ProcessEnv;
    for (const args of [
      ["target", "add", "n1", "--host", "h"],
      ["target", "add", "n1", "--key", KEY],
      ["target", "add", "../evil", "--host", "h", "--key", KEY],
      ["target", "add", "n1", "--host", "h", "--key", KEY, "--port", "banana"],
      ["target", "frobnicate"],
    ]) {
      expect(await main(args, env, makeIo())).toBe(2);
    }
  });

  test("--target selects the saved host; absent flag keeps the default (none here)", async () => {
    const home = mkdtempSync(join(tmpdir(), "laun-targetcmd-"));
    const u = new URL(base);
    expect(await main(["target", "add", "n1", "--host", u.hostname, "--port", u.port, "--key", KEY], { HOME: home } as NodeJS.ProcessEnv, makeIo())).toBe(0);
    let io = makeIo();
    expect(await main(["agent", "ls", "--target", "n1"], { HOME: home } as NodeJS.ProcessEnv, io)).toBe(0);
    expect(io.lines.join("\n")).toContain("s1");
    io = makeIo();
    expect(await main(["agent", "ls", "--target=n1"], { HOME: home } as NodeJS.ProcessEnv, io)).toBe(0);
    expect(io.lines.join("\n")).toContain("s1");
    // No flag, no default file, no env: the old \"not connected\" path, unchanged.
    io = makeIo();
    expect(await main(["agent", "ls"], { HOME: home } as NodeJS.ProcessEnv, io)).toBe(2);
    expect(io.errs.join("\n")).toContain("agent auth");
    // Unknown name is a usage error naming the problem.
    io = makeIo();
    expect(await main(["agent", "ls", "--target", "nope"], { HOME: home } as NodeJS.ProcessEnv, io)).toBe(2);
    expect(io.errs.join("\n")).toContain('unknown target "nope"');
  });

  test("agent watch exits 0 on done, 2 on timeout, 1 on unknown id, 2 on bad usage", async () => {
    const env = serverEnv();
    let io = makeIo();
    expect(await main(["agent", "watch", "s1"], env, io)).toBe(0);
    expect(io.lines).toEqual(["✅ done: served"]);
    io = makeIo();
    expect(await main(["agent", "watch", "quiet", "--timeout", "20ms", "--poll-ms", "1"], env, io)).toBe(2);
    expect(io.errs.join("\n")).toMatch(/timed out/);
    io = makeIo();
    expect(await main(["agent", "watch", "nope"], env, io)).toBe(1);
    io = makeIo();
    expect(await main(["agent", "watch"], env, io)).toBe(2);
    io = makeIo();
    expect(await main(["agent", "watch", "s1", "--timeout", "soon"], env, io)).toBe(2);
  });

  test("doctor: healthy gateway exits 0 without ever printing the key", async () => {
    const io = makeIo();
    expect(await main(["doctor"], serverEnv(), io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("reachable");
    expect(text).toContain("aabbccdd");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("q".repeat(10));
  });

  test("doctor: no target, dead gateway, and bad usage exit 1, 1, 2", async () => {
    let io = makeIo();
    expect(await main(["doctor"], { HOME: mkdtempSync(join(tmpdir(), "laun-doctor-")) } as NodeJS.ProcessEnv, io)).toBe(1);
    expect(io.lines.join("\n")).toContain("no target");
    io = makeIo();
    const env = { HOME: mkdtempSync(join(tmpdir(), "laun-doctor-")), LAUN_HOST: "127.0.0.1", LAUN_PORT: "9", LAUN_KEY: KEY } as NodeJS.ProcessEnv;
    expect(await main(["doctor"], env, io)).toBe(1);
    expect(io.lines.join("\n")).toContain("unreachable");
    io = makeIo();
    expect(await main(["doctor", "extra"], serverEnv(), io)).toBe(2);
  });
});
