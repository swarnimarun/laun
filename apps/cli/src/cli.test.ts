import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentKey } from "@cloudbear/protocol";
import { UsageError, flagBool, flagString, parseArgs, requiredArg } from "./args.js";
import { loadTarget, resolveTarget, saveTarget, targetUrl } from "./config.js";
import { ensureEnv, readEnvValue, upsertEnv } from "./setup.js";
import { lastMatch, runRemoteSetup, shQuote, sshArgv, type CommandRunner } from "./ssh.js";

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

  test("lastMatch returns the final occurrence", () => {
    expect(lastMatch("CLOUDBEAR_KEY=a\nCLOUDBEAR_KEY=b\n", /^CLOUDBEAR_KEY=(.*)$/m)).toBe("b");
    expect(lastMatch("nothing", /^CLOUDBEAR_KEY=(.*)$/m)).toBeNull();
  });
});

describe("bootstrap contract", () => {
  test("deploy/bootstrap.sh exists, is bash-valid, and prints the key last", () => {
    const script = join(import.meta.dir, "..", "..", "..", "deploy", "bootstrap.sh");
    const body = readFileSync(script, "utf8");
    expect(body).toContain("set -euo pipefail");
    expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
    // the key must be the last summary line the CLI parses
    const lines = body.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toContain("CLOUDBEAR_KEY=");
    // and the service token must never be echoed
    expect(body).not.toMatch(/printf.*GATEWAY_TOKEN/);
  });
});