import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Parse and smoke-load config without Docker. This does not claim Docker
// merge/daemon, certificate trust or real OpenShell enforcement validation.
const base = parse(readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8"));
const overlay = parse(readFileSync(new URL("../../../deploy/docker-compose.openshell.yml", import.meta.url), "utf8"));
const executorModule = new URL("../../../apps/executor/src/config.ts", import.meta.url).href;
const gatewayModule = new URL("../../../apps/gateway/src/config.ts", import.meta.url).href;

function expand(value: unknown, env: Record<string, string>): string {
  let text = String(value);
  for (let count = 0; count < 10 && text.includes("${"); count++) {
    text = text.replace(/\$\{([A-Z_]+)(?:(:-|:\?)([^{}]*))?\}/g, (_, name: string, operator?: string, fallback = "") => {
      if (env[name]) return env[name];
      if (operator === ":?") throw new Error(`missing required ${name}`);
      return fallback;
    });
  }
  if (text.includes("${")) throw new Error("unresolved variable");
  return text;
}

function environment(spec: Record<string, unknown>, env: Record<string, string>) {
  return Object.fromEntries(Object.entries(spec).map(([name, value]) => [name, expand(value, env)]));
}

describe("deployment profile config smoke", () => {
  const env = { GATEWAY_TOKEN: "fixture-token", HOME: "/tmp/operator" };

  test("base executor loads with OpenShell off and no identity mounts", async () => {
    const { loadConfig } = await import(executorModule);
    const config = loadConfig(environment(base.services.executor.environment, env));
    expect(config.openshellEnabled).toBe(false);
    expect(config.sdkGateway).toBe("");
    expect(base.services.executor.extra_hosts).toBeUndefined();
    expect(base.services.executor.volumes.some((v: string) => v.includes("openshell"))).toBe(false);
    for (const service of Object.values(base.services) as Array<{ ports?: string[] }>) {
      for (const port of service.ports ?? []) expect(expand(port, env)).toMatch(/^127\.0\.0\.1:/);
    }
  });

  test("overlay forces isolation, validates required paths, and loads SDK config", async () => {
    const { loadConfig } = await import(executorModule);
    const production = { ...env, OPENSHELL_CONFIG_DIR: "/srv/operator/openshell", OPENSHELL_PROVIDER: "model-route" };
    const merged = { ...base.services.executor.environment, ...overlay.services.executor.environment };
    const config = loadConfig(environment(merged, production));
    expect(config.openshellEnabled).toBe(true);
    expect(config.sdkGateway).toBe("https://host.openshell.internal:17670");
    expect(config.sdkClientKeyFile).toBe("/openshell-mtls/tls.key");
    for (const mount of overlay.services.executor.volumes) {
      expect(expand(mount.source, production)).toBe("/srv/operator/openshell/gateways/openshell/mtls");
      expect(mount.read_only).toBe(true);
      expect(mount.bind.create_host_path).toBe(false);
      expect(() => expand(mount.source, env)).toThrow("OPENSHELL_CONFIG_DIR");
    }
    expect(() => loadConfig(environment(base.services.executor.environment, { ...env, OPENSHELL_ENABLED: "true" }))).toThrow("neither OPENSHELL_PREFIX nor OPENSHELL_SANDBOX_IMAGE");
  });

  test("documented gateway limits reach actual config parsing", async () => {
    const { loadConfig } = await import(gatewayModule);
    const config = loadConfig(environment(base.services.gateway.environment, {
      ...env, MAX_CONCURRENT_RUNS: "2", MAX_SESSION_TOKENS: "12345", AUTO_RESUME: "false", AUTO_RESUME_MAX_AGE_MS: "60000", RUN_STALL_MS: "90000",
    }));
    expect(config).toMatchObject({ maxConcurrentRuns: 2, maxSessionTokens: 12345, autoResume: false, autoResumeMaxAgeMs: 60000, stallMs: 90000 });
  });
});
