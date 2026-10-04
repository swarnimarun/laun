import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentKey } from "@cloudbear/protocol";
import { UsageError, flagBool, flagString, parseArgs, requiredArg } from "./args.js";
import { loadTarget, resolveTarget, saveTarget, targetUrl } from "./config.js";
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
    const home = mkdtempSync(join(tmpdir(), "cb-home-"));
    const path = saveTarget({ host: "203.0.113.9", port: 8080, scheme: "http", key: "cb_aabbccdd_secretsecretsecretsecret", keyId: "aabbccdd" }, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".cloudbear")).mode & 0o777).toBe(0o700);
    expect(loadTarget(home)?.host).toBe("203.0.113.9");
  });

  test("env overrides the saved target, and half a target is ignored", () => {
    const home = mkdtempSync(join(tmpdir(), "cb-home-"));
    saveTarget({ host: "saved", port: 8080, scheme: "http", key: "cb_aabbccdd_secretsecretsecretsecret" }, home);
    expect(resolveTarget({} as NodeJS.ProcessEnv, home)?.host).toBe("saved");
    expect(resolveTarget({ CLOUDBEAR_KEY: "k" } as NodeJS.ProcessEnv, home)?.host).toBe("saved");
    expect(resolveTarget({ CLOUDBEAR_HOST: "envhost", CLOUDBEAR_KEY: "cb_aabbccdd_secretsecretsecretsecret" } as NodeJS.ProcessEnv, home)?.host).toBe("envhost");
  });

  test("missing file yields null instead of throwing", () => {
    expect(loadTarget(mkdtempSync(join(tmpdir(), "cb-home-"))) ).toBeNull();
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
    const dir = mkdtempSync(join(tmpdir(), "cb-envseed-"));
    const envPath = join(dir, ".env");
    const examplePath = join(dir, "example.env");
    writeFileSync(examplePath, "GATEWAY_TOKEN=change-me\nCLOUDBEAR_KEY=\nEXECUTOR_MODE=rpc\nRUN_TIMEOUT_MS=1800000\n");
    writeFileSync(envPath, "GATEWAY_TOKEN=mine-keep-me\nCLOUDBEAR_KEY=\n");

    const first = ensureEnv(envPath, examplePath);
    expect(readEnvValue(first.content, "GATEWAY_TOKEN")).toBe("mine-keep-me"); // untouched
    expect(readEnvValue(first.content, "EXECUTOR_MODE")).toBe("rpc"); // seeded
    expect(readEnvValue(first.content, "RUN_TIMEOUT_MS")).toBe("1800000"); // seeded
    expect(readEnvValue(first.content, "CLOUDBEAR_KEY")).toMatch(/^cb_/); // generated

    const again = ensureEnv(envPath, examplePath);
    expect(readEnvValue(again.content, "EXECUTOR_MODE")).toBe("rpc"); // idempotent
    expect(again.token).toBe(first.token);
    expect(again.key).toBe(first.key);
  });

  test("fills placeholders and never clobbers a live secret", () => {
    const example = "GATEWAY_TOKEN=change-me-to-a-long-random-string\nOTHER=1\n";
    const first = ensureEnv(join(mkdtempSync(join(tmpdir(), "cb-env-")), ".env"), "");
    expect(first.token.length).toBeGreaterThan(20);
    expect(parseAgentKey(first.key)?.id).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), "cb-env-"));
    const examplePath = join(dir, "example.env");
    const envPath = join(dir, ".env");
    writeFileSync(examplePath, example);
    const created = ensureEnv(envPath, examplePath);
    expect(created.created).toBe(true);
    expect(readEnvValue(created.content, "GATEWAY_TOKEN")).toBe(created.token);
    expect(readEnvValue(created.content, "OTHER")).toBe("1");
    expect(parseAgentKey(readEnvValue(created.content, "CLOUDBEAR_KEY")!)).not.toBeNull();

    // re-running keeps the same gateway token and key
    const again = ensureEnv(envPath, examplePath);
    expect(again.token).toBe(created.token);
    expect(again.key).toBe(created.key);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    // an existing hand-written token is preserved verbatim
    const custom = upsertEnv("GATEWAY_TOKEN=my-own-token\nCLOUDBEAR_KEY=\n", { GATEWAY_TOKEN: "generated", CLOUDBEAR_KEY: "cb_aabbccdd_x" });
    expect(readEnvValue(custom, "GATEWAY_TOKEN")).toBe("my-own-token");
    expect(readEnvValue(custom, "CLOUDBEAR_KEY")).toBe("cb_aabbccdd_x");
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
      return { code: 0, stdout: "==> done\nCLOUDBEAR_DIR=/opt/cloudbear\nCLOUDBEAR_PORT=8081\nCLOUDBEAR_KEY=cb_aabbccdd_secretsecretsecretsecret\n", stderr: "" };
    };
    const key = "cb_aabbccdd_secretsecretsecretsecret";
    const result = await runRemoteSetup({
      ...spec,
      remoteDir: "/opt/cloudbear",
      repoUrl: "git@github.com:me/cloudbear.git",
      envContent: `GATEWAY_TOKEN=super-secret-token\nCLOUDBEAR_KEY=${key}\n`,
      bootstrapScript: "#!/usr/bin/env bash\nset -euo pipefail\n",
      runner,
    });

    expect(result).toEqual({ key, port: 8081, dir: "/opt/cloudbear" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toContain("mkdir -p '/opt/cloudbear'");
    // non-root users need the sudo fallback for paths such as /opt/...
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toContain("sudo -n mkdir -p '/opt/cloudbear'");
    expect(calls[0]!.argv[calls[0]!.argv.length - 1]).toContain("$(id -u):$(id -g)");
    expect(calls[1]!.argv[calls[1]!.argv.length - 1]).toContain("cat > '/opt/cloudbear'/.env");
    expect(calls[2]!.argv[calls[2]!.argv.length - 1]).toBe("bash -s -- '/opt/cloudbear' 'git@github.com:me/cloudbear.git'");
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
    ).rejects.toThrow(/remote setup failed.*CLOUDBEAR_KEY/s);
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
    expect(lastMatch("CLOUDBEAR_KEY=a\nCLOUDBEAR_KEY=b\n", /^CLOUDBEAR_KEY=(.*)$/m)).toBe("b");
    expect(lastMatch("nothing", /^CLOUDBEAR_KEY=(.*)$/m)).toBeNull();
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
    expect(lines[lines.length - 1]).toContain("CLOUDBEAR_KEY=");
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