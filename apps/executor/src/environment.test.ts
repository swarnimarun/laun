import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnvironment, repositoryEnvironment } from "./environment.js";
import { checkoutRepo, createHandler } from "./server.js";

const CONTROL = {
  GATEWAY_TOKEN: "test-controller-token",
  LAUN_KEY: "test-human-key",
  TELEGRAM_BOT_TOKEN: "test-chat-token",
  OPENSHELL_SDK_TOKEN: "test-sdk-token",
  OPENSHELL_SDK_CLIENT_KEY_FILE: "/test/admin-key",
  OPENSHELL_GATEWAY_ENDPOINT: "https://test-admin-endpoint",
  GOOSE_SECRET: "test-goose-secret",
  EXECUTOR_PRIVATE_KEY: "test-worker-key",
};
const PROVIDER = { OPENROUTER_API_KEY: "test-provider-key", PI_CODING_AGENT_DIR: "/test/pi" };

function withEnvironment<T>(values: NodeJS.ProcessEnv, fn: () => T): T {
  const previous: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

describe("child environment containment", () => {
  test("strips controller namespaces and startup hooks without mutating source", () => {
    const source = { ...CONTROL, ...PROVIDER, PATH: "/tools", NODE_OPTIONS: "--require=bad", BASH_ENV: "/bad", LD_PRELOAD: "/bad" };
    const filtered = agentEnvironment(source);
    for (const key of Object.keys(CONTROL)) expect(filtered[key]).toBeUndefined();
    for (const key of ["NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD"]) expect(filtered[key]).toBeUndefined();
    expect(filtered.OPENROUTER_API_KEY).toBe(PROVIDER.OPENROUTER_API_KEY);
    expect(filtered.PI_CODING_AGENT_DIR).toBe(PROVIDER.PI_CODING_AGENT_DIR);
    expect(filtered.PATH).toBe("/tools");
    expect(source.GATEWAY_TOKEN).toBe(CONTROL.GATEWAY_TOKEN);
    expect(agentEnvironment({ gateway_token: "case-variant" }).gateway_token).toBeUndefined();
  });

  test("repository fetch gets no model keys, Git overrides or interactive helpers", () => {
    const env = repositoryEnvironment({
      ...CONTROL, ...PROVIDER, PATH: "/tools", HOME: "/operator", SSH_AUTH_SOCK: "/ssh.sock",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "bad",
      GIT_ASKPASS: "/bad", GIT_SSH_COMMAND: "bad", AWS_SECRET_ACCESS_KEY: "test-cloud-key",
    });
    expect(env.PATH).toBe("/tools");
    expect(env.SSH_AUTH_SOCK).toBe("/ssh.sock");
    for (const key of [...Object.keys(CONTROL), ...Object.keys(PROVIDER), "AWS_SECRET_ACCESS_KEY", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_ASKPASS", "GIT_SSH_COMMAND"]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  for (const mode of ["json", "rpc"] as const) {
    test(`${mode} Pi spawn excludes control credentials and preserves provider login env`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `laun-env-${mode}-`));
      const stub = join(dir, "pi-stub");
      writeFileSync(stub, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const controls = ${JSON.stringify(Object.keys(CONTROL))};
const report = { controls: controls.filter(k => process.env[k] !== undefined), provider: process.env.OPENROUTER_API_KEY === "test-provider-key", pi: process.env.PI_CODING_AGENT_DIR === "/test/pi", hook: process.env.NODE_OPTIONS !== undefined };
writeFileSync("observed.json", JSON.stringify(report));
if (${JSON.stringify(mode)} === "json") {
  console.log(JSON.stringify({type:"agent_settled"}));
} else {
  let buf = "";
  process.stdin.on("data", chunk => {
    buf += chunk.toString();
    let newline;
    while ((newline = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, newline); buf = buf.slice(newline + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "prompt") console.log(JSON.stringify({type:"agent_settled"}));
    }
  });
}
`);
      chmodSync(stub, 0o755);
      try {
        await withEnvironment({ ...CONTROL, ...PROVIDER, NODE_OPTIONS: "--require=/nonexistent/control-preload" }, async () => {
          const handler = createHandler({
            port: 0, gatewayToken: "t", sessionDir: dir, piBin: stub, defaultModel: "test",
            openshellEnabled: false, openshellPrefix: [], defaultTimeoutMs: 30_000,
            executorMode: mode, recoveryAttempts: 0,
          });
          try {
            const response = await handler.handleRun(new Request("http://test/run", {
              method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
              body: JSON.stringify({ sessionId: "env-test", prompt: "hello" }),
            }));
            expect(response.status).toBe(200);
            await response.text();
            expect(JSON.parse(readFileSync(join(dir, "env-test", "work", "observed.json"), "utf8"))).toEqual({
              controls: [], provider: true, pi: true, hook: false,
            });
          } finally {
            handler.close();
          }
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("host Git spawn uses the repository environment at the acquisition boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "laun-env-git-"));
    const bin = join(dir, "bin");
    const work = join(dir, "work");
    mkdirSync(bin);
    mkdirSync(work);
    const stub = join(bin, "git");
    writeFileSync(stub, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const prohibited = ${JSON.stringify([...Object.keys(CONTROL), ...Object.keys(PROVIDER), "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_SSH_COMMAND"])};
const report = { prohibited: prohibited.filter(k => process.env[k] !== undefined), global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM, prompt: process.env.GIT_TERMINAL_PROMPT };
writeFileSync(process.argv.at(-1) + "/observed.json", JSON.stringify(report));
`);
    chmodSync(stub, 0o755);
    try {
      withEnvironment({
        ...CONTROL, ...PROVIDER, PATH: `${bin}:${process.env.PATH ?? ""}`,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "bad", GIT_SSH_COMMAND: "bad",
      }, () => checkoutRepo(work, "https://source.example/test.git"));
      expect(JSON.parse(readFileSync(join(work, "observed.json"), "utf8"))).toEqual({
        prohibited: [], global: "/dev/null", system: "/dev/null", prompt: "0",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
