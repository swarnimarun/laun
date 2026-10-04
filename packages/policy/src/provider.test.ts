// Tests for the model provider profile (deploy/openshell/provider-model.yaml).
import { describe, expect, test } from "bun:test";
import {
  isRealHost,
  loadProviderProfileText,
  parseProviderProfile,
  scanForSecrets,
  validateProviderProfile,
} from "./provider.js";

function renderedProfile(host = "model.example.com"): unknown {
  const text = loadProviderProfileText().replaceAll("${MODEL_HOST}", host);
  const { value, problems } = parseProviderProfile(text);
  expect(problems).toEqual([]);
  return value;
}

describe("provider profile", () => {
  test("profile parses with no YAML errors", () => {
    const { problems } = parseProviderProfile(loadProviderProfileText());
    expect(problems).toEqual([]);
  });

  test("profile is valid after substituting the model host", () => {
    const text = loadProviderProfileText().replaceAll("${MODEL_HOST}", "model.example.com");
    const { value, problems } = parseProviderProfile(text);
    expect(problems).toEqual([]);
    // Raw text is passed so the no-secrets guarantee lives in validation too.
    expect(validateProviderProfile(value, text)).toEqual([]);
  });

  test("declares required fields and credential flow", () => {
    const p = renderedProfile() as Record<string, unknown>;
    expect(p["id"]).toBe("laun-model");
    expect(p["category"]).toBe("inference");
    expect(p["inference_capable"]).toBe(true);
    const creds = p["credentials"] as Array<Record<string, unknown>>;
    expect(creds.length).toBeGreaterThan(0);
    expect(creds[0]!["env_vars"]).toContain("MODEL_API_KEY");
    expect(creds[0]!["auth_style"]).toBe("bearer");
    expect(creds[0]!["header_name"]).toBe("authorization");
    const d = p["discovery"] as Record<string, unknown>;
    expect(d["credentials"]).toContain(creds[0]!["name"]);
    expect((p["binaries"] as unknown[]).length).toBeGreaterThan(0);
  });

  test("endpoint host is a real host", () => {
    const p = renderedProfile() as Record<string, unknown>;
    const eps = p["endpoints"] as Array<Record<string, unknown>>;
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) {
      expect(isRealHost(ep["host"])).toBe(true);
      expect(ep["port"]).toBe(443);
    }
  });

  test("contains no secret literals", () => {
    expect(scanForSecrets(loadProviderProfileText())).toEqual([]);
  });

  test("secret scanner is not vacuous", () => {
    expect(scanForSecrets('token: "sk-test-abc1234567890xyz"')).not.toEqual([]);
    expect(scanForSecrets("key: sk-or-v1-abc123def456ghi789jkl")).not.toEqual([]);
    expect(scanForSecrets("-----BEGIN PRIVATE KEY-----\nx\n")).not.toEqual([]);
    expect(scanForSecrets("name: api_key\nenv_vars: [MODEL_API_KEY]")).toEqual([]);
  });

  test("validation rejects a profile carrying a secret literal", () => {
    const p = renderedProfile() as Record<string, unknown>;
    expect(validateProviderProfile(p, "api_key: sk-or-v1-abc123def456ghi789jkl")).toContainEqual(
      expect.stringContaining("secret-looking"),
    );
  });

  test("rejects bad profile ids", () => {
    const p = { ...(renderedProfile() as Record<string, unknown>), id: "Bad_ID" };
    expect(validateProviderProfile(p)).toContainEqual(expect.stringContaining("id"));
  });

  test("rejects discovery naming an undeclared credential", () => {
    const p = { ...(renderedProfile() as Record<string, unknown>), discovery: { credentials: ["nope"] } };
    expect(validateProviderProfile(p)).toContainEqual(expect.stringContaining("no declared credential"));
  });

  test("rejects reserved v-digit env prefixes", () => {
    const p = renderedProfile() as Record<string, unknown>;
    const creds = structuredClone(p["credentials"]);
    (creds as Array<Record<string, unknown>>)[0]!["env_vars"] = ["v10_GITHUB_TOKEN"];
    expect(validateProviderProfile({ ...p, credentials: creds })).toContainEqual(
      expect.stringContaining("reserved"),
    );
  });

  test("rejects placeholder hosts", () => {
    expect(isRealHost("${MODEL_HOST}")).toBe(false);
    expect(isRealHost("https://model.example.com/v1")).toBe(false);
    expect(isRealHost("")).toBe(false);
    expect(isRealHost("model.example.com")).toBe(true);
  });
});
