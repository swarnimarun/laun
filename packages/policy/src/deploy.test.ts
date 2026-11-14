import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Parse and smoke-load config without Docker. This does not claim Docker
// merge/daemon, certificate trust or real OpenShell enforcement validation.
const base = parse(readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8"), { merge: true });
const overlay = parse(readFileSync(new URL("../../../deploy/docker-compose.openshell.yml", import.meta.url), "utf8"), { merge: true });
const executorModule = new URL("../../../apps/executor/src/config.ts", import.meta.url).href;
const gatewayModule = new URL("../../../apps/gateway/src/config.ts", import.meta.url).href;

function expand(value: unknown, env: Record<string, string>): string {
  let text = String(value);
  for (let count = 0; count < 10 && text.includes("${"); count++) {
    text = text.replace(/\$\{([A-Z_][A-Z0-9_]*)(?:(:-|:\?)([^{}]*))?\}/g, (_, name: string, operator?: string, fallback = "") => {
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

  test("service image accepts a complete immutable digest while preserving repository/tag fallback", () => {
    const reference = `ghcr.io/example/laun@sha256:${"a".repeat(64)}`;
    for (const name of ["gateway", "executor", "telegram-bridge"]) {
      expect(expand(base.services[name].image, { ...env, LAUN_SERVICE_IMAGE: reference, LAUN_TAG: "ignored" })).toBe(reference);
      expect(expand(base.services[name].image, { ...env, LAUN_IMAGE: "ghcr.io/example/laun", LAUN_TAG: "0.1.0" })).toBe("ghcr.io/example/laun:0.1.0");
    }
  });

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

  test("v2 controller receives explicit execution settings and container-network binding", () => {
    const local = environment(base.services.gateway.environment, env);
    expect(local.GATEWAY_BIND).toBe("0.0.0.0");
    expect(local.OPENSHELL_ENABLED).toBe("false");
    expect(local.LAUN_TRUSTED_LOCAL).toBe("false");
    expect(local.LAUN_DEMO).toBe("false");
    expect(local.PI_AUTH_FILE).toBe("/controller-auth/auth.json");
    expect(local.LAUN_LOCAL_CAPACITY).toBe("2");
    expect(local.MAX_FAMILY_TOKENS).toBe("100000");
    const production = environment({ ...base.services.gateway.environment, ...overlay.services.gateway.environment }, env);
    expect(production.OPENSHELL_ENABLED).toBe("true");
    expect(production.LAUN_TRUSTED_LOCAL).toBe("false");
    expect(production.LAUN_DEMO).toBe("false");
    expect(production.OPENSHELL_GATEWAY_INSECURE).toBe("false");
    expect(production.OPENSHELL_GATEWAY_ENDPOINT).toBe("https://host.openshell.internal:17670");
  });

  test("production credentials mount only into trusted gateway controller, with required explicit host path", () => {
    const auth = overlay.services.gateway.volumes.find((mount: { target: string }) => mount.target === "/controller-auth");
    expect(auth).toBeDefined();
    expect(auth.read_only).toBe(false); // controller performs atomic OAuth refresh
    expect(auth.bind.create_host_path).toBe(false);
    expect(() => expand(auth.source, env)).toThrow("PI_CONTROLLER_AUTH_DIR");
    expect(expand(auth.source, { ...env, PI_CONTROLLER_AUTH_DIR: "/srv/laun/controller-auth" })).toBe("/srv/laun/controller-auth");
    expect(overlay.services.executor.volumes.some((mount: { target: string }) => mount.target === "/controller-auth")).toBe(false);
    const dataMount=base.services.gateway.volumes.find((mount:unknown)=>typeof mount==="string"&&mount.endsWith(":/data"));
    expect(expand(dataMount,env)).toBe("laun-data:/data");
    expect(expand(dataMount,{...env,LAUN_DATA_DIR:"/srv/laun/recovered-data"})).toBe("/srv/laun/recovered-data:/data");
    const baseAuth = base.services.gateway.volumes.find((mount: { target?: string }) => mount.target === "/controller-auth");
    expect(baseAuth.bind.create_host_path).toBe(false);
    expect(expand(baseAuth.source, env)).toBe("/tmp/operator/.pi/agent");
  });

  test("Telegram v2 routing gets a separate persistent encrypted delivery volume", () => {
    const bridge = base.services["telegram-bridge"];
    expect(bridge.volumes).toEqual(["laun-bridge-data:/bridge-data"]);
    expect(bridge.environment.BRIDGE_DATA_DIR).toBe("/bridge-data");
    expect(expand(bridge.environment.LAUN_CONTROL_V2, env)).toBe("true");
    expect(bridge.environment.BRIDGE_INBOX_KEY).toContain("BRIDGE_INBOX_KEY");
    expect(expand(bridge.environment.GATEWAY_TOKEN, { ...env, LAUN_TELEGRAM_BRIDGE_TOKEN: "connector-only" })).toBe("connector-only");
    expect(expand(bridge.environment.GATEWAY_TOKEN, env)).toBe(env.GATEWAY_TOKEN);
    expect(base.services.gateway.volumes).not.toContain("laun-bridge-data:/bridge-data");
    expect(base.services.executor.volumes).not.toContain("laun-bridge-data:/bridge-data");
    expect(base.services.gateway.environment.BRIDGE_INBOX_KEY).toBeUndefined();
    expect(base.volumes["laun-bridge-data"]).toBeDefined();
  });
});
