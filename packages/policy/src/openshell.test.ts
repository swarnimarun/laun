// Tests for the real OpenShell policy layer (src/openshell.ts).
// One test per rule: each rejection test must fail if its rule is removed.
import { describe, expect, test } from "bun:test";
import {
  listOpenShellTemplates,
  renderOpenShellPolicy,
  validatePolicy,
} from "./openshell.js";

const VARS = { WORKDIR: "/workspace", MODEL_HOST: "model.example.com" };

/** Smallest policy exercising every validated section. */
function minimalValid(): string {
  return [
    "version: 1",
    "filesystem_policy:",
    "  read_only: [/usr]",
    "  read_write: [/workspace]",
    "network_policies:",
    "  model:",
    "    endpoints:",
    "      - host: example.com",
    "        port: 443",
    "        protocol: rest",
    "        access: read-only",
    "    binaries:",
    "      - path: /usr/bin/node",
    "",
  ].join("\n");
}

describe("openshell templates", () => {
  test("ships restrictive + standard-dev openshell templates", () => {
    expect(listOpenShellTemplates()).toEqual(["restrictive", "standard-dev"]);
  });

  test("restrictive renders to valid OpenShell YAML", () => {
    const out = renderOpenShellPolicy("restrictive", VARS);
    expect(out).toContain("version: 1");
    expect(validatePolicy(out)).toEqual([]);
  });

  test("standard-dev renders to valid OpenShell YAML", () => {
    const out = renderOpenShellPolicy("standard-dev", VARS);
    expect(validatePolicy(out)).toEqual([]);
  });

  test("rendered policy is self-contained (no placeholders, concrete paths)", () => {
    for (const name of listOpenShellTemplates()) {
      const out = renderOpenShellPolicy(name, VARS);
      expect(out).not.toContain("${");
      expect(out).toContain("/workspace");
      expect(out).toContain("model.example.com");
    }
  });

  test("restrictive allows only the model host", () => {
    const out = renderOpenShellPolicy("restrictive", VARS);
    expect(out).toContain("model.example.com");
    expect(out).not.toContain("github.com");
    expect(out).not.toContain("pypi.org");
  });
});

describe("openshell render fails closed", () => {
  test("missing vars throw", () => {
    expect(() => renderOpenShellPolicy("restrictive", { WORKDIR: "/w" })).toThrow("MODEL_HOST");
  });

  test("workdir with .. throws", () => {
    expect(() => renderOpenShellPolicy("restrictive", { ...VARS, WORKDIR: "/w/../etc" })).toThrow("..");
  });

  test("model host as URL throws", () => {
    expect(() => renderOpenShellPolicy("restrictive", { ...VARS, MODEL_HOST: "https://model.example.com/v1" })).toThrow("host");
  });

  test("unknown template throws", () => {
    expect(() => renderOpenShellPolicy("nope", VARS)).toThrow();
  });
});

describe("validatePolicy", () => {
  test("accepts a minimal valid policy", () => {
    expect(validatePolicy(minimalValid())).toEqual([]);
  });

  test("rejects empty input", () => {
    expect(validatePolicy("")).not.toEqual([]);
  });

  test("rejects missing version", () => {
    expect(validatePolicy(minimalValid().replace("version: 1\n", ""))).toContainEqual(
      expect.stringContaining("version"),
    );
  });

  test("rejects version != 1", () => {
    expect(validatePolicy(minimalValid().replace("version: 1", "version: 2"))).toContainEqual(
      expect.stringContaining("version"),
    );
  });

  test("rejects unknown top-level key", () => {
    expect(validatePolicy(minimalValid().replace("version: 1", "version: 1\ncredentials: []"))).toContainEqual(
      expect.stringContaining("unknown top-level"),
    );
  });

  test("rejects duplicate keys", () => {
    expect(validatePolicy(minimalValid().replace("version: 1", "version: 1\nversion: 1"))).toContainEqual(
      expect.stringContaining("unique"),
    );
  });

  test("rejects relative path", () => {
    expect(validatePolicy(minimalValid().replace("read_only: [/usr]", "read_only: [var/lib]"))).toContainEqual(
      expect.stringContaining("absolute"),
    );
  });

  test("rejects path containing ..", () => {
    expect(validatePolicy(minimalValid().replace("/workspace", "/workspace/../etc"))).toContainEqual(
      expect.stringContaining(".."),
    );
  });

  test("rejects read_write: /", () => {
    expect(validatePolicy(minimalValid().replace("read_write: [/workspace]", "read_write: [/]"))).toContainEqual(
      expect.stringContaining('read_write'),
    );
  });

  test("rejects 257 paths", () => {
    const paths = Array.from({ length: 257 }, (_, i) => `      - /p${i}`);
    const doc = [
      "version: 1",
      "filesystem_policy:",
      "  read_only: [/usr]",
      "  read_write:",
      ...paths,
      "",
    ].join("\n");
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("256"));
  });

  test("accepts exactly 256 paths", () => {
    const paths = Array.from({ length: 255 }, (_, i) => `      - /p${i}`);
    const doc = [
      "version: 1",
      "filesystem_policy:",
      "  read_only: [/usr]",
      "  read_write:",
      ...paths,
      "",
    ].join("\n");
    expect(validatePolicy(doc)).toEqual([]);
  });

  test("rejects policy over 4 MiB", () => {
    const big = minimalValid() + "# " + "x".repeat(4 * 1024 * 1024 + 1) + "\n";
    expect(validatePolicy(big)).toContainEqual(expect.stringContaining("4 MiB"));
  });

  test("rejects unsubstituted vars", () => {
    expect(validatePolicy(minimalValid().replace("example.com", "${MODEL_HOST}"))).toContainEqual(
      expect.stringContaining("unsubstituted"),
    );
  });

  test("rejects metadata IP as endpoint", () => {
    expect(validatePolicy(minimalValid().replace("example.com", "169.254.169.254"))).toContainEqual(
      expect.stringContaining("never authorized"),
    );
  });

  test("rejects loopback as endpoint", () => {
    expect(validatePolicy(minimalValid().replace("example.com", '"127.0.0.1"'))).toContainEqual(
      expect.stringContaining("never authorized"),
    );
  });

  test("rejects allowed_ips overlapping a blocked range", () => {
    const doc = minimalValid().replace(
      "      - host: example.com",
      "      - host: example.com\n        allowed_ips:\n          - 127.0.0.0/24",
    );
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("blocked range"));
  });

  test("accepts allowed_ips outside blocked ranges", () => {
    const doc = minimalValid().replace(
      "      - host: example.com",
      "      - host: example.com\n        allowed_ips:\n          - 10.0.0.0/8",
    );
    expect(validatePolicy(doc)).toEqual([]);
  });
  test("rejects path longer than 4096 bytes", () => {
    const long = "/" + "a".repeat(4096); // 4097 bytes
    expect(
      validatePolicy(minimalValid().replace("read_write: [/workspace]", `read_write: [${long}]`)),
    ).toContainEqual(expect.stringContaining("4096"));
  });

  test("accepts path of exactly 4096 bytes", () => {
    const exact = "/" + "a".repeat(4095); // 4096 bytes
    expect(
      validatePolicy(minimalValid().replace("read_write: [/workspace]", `read_write: [${exact}]`)),
    ).toEqual([]);
  });

  test("rejects _provider_ rule keys", () => {
    expect(validatePolicy(minimalValid().replace("  model:", "  _provider_model:"))).toContainEqual(
      expect.stringContaining("_provider_"),
    );
  });

  test("rejects access combined with rules", () => {
    const doc = minimalValid().replace(
      "        access: read-only",
      "        access: read-only\n        rules:\n          - allow:\n              method: GET\n              path: /**",
    );
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("cannot be combined"));
  });

  test("rejects rest endpoint with neither access nor rules", () => {
    expect(validatePolicy(minimalValid().replace("        access: read-only\n", ""))).toContainEqual(
      expect.stringContaining('need "access" or "rules"'),
    );
  });

  test("rejects unknown landlock compatibility", () => {
    const doc = minimalValid() + "landlock:\n  compatibility: whatever\n";
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("compatibility"));
  });

  test("rejects root process uid", () => {
    const doc = minimalValid() + "process:\n  run_as_user: 0\n";
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("run_as_user"));
  });

  test("rejects blocked control-plane port on exact host", () => {
    expect(validatePolicy(minimalValid().replace("port: 443", "port: 6443"))).toContainEqual(
      expect.stringContaining("blocked"),
    );
  });

  test("rejects wildcard host with fewer than three labels", () => {
    expect(validatePolicy(minimalValid().replace("example.com", '"*.example"'))).toContainEqual(
      expect.stringContaining("three DNS labels"),
    );
  });

  test("reports unquoted wildcards as YAML errors instead of crashing", () => {
    // A bare * starts a YAML alias; must surface as a problem, never throw.
    expect(() => validatePolicy(minimalValid().replace("example.com", "*.example"))).not.toThrow();
    expect(validatePolicy(minimalValid().replace("example.com", "*.example"))).not.toEqual([]);
  });

  test("rejects same path in read_only and read_write", () => {
    const doc = minimalValid().replace("read_only: [/usr]", "read_only: [/usr, /workspace]");
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("both read_only and read_write"));
  });

  test("rejects duplicate middleware order", () => {
    const doc =
      minimalValid() +
      [
        "network_middlewares:",
        "  a:",
        "    middleware: openshell/regex",
        "    order: 10",
        "    endpoints:",
        '      include: ["example.com"]',
        "  b:",
        "    middleware: openshell/regex",
        "    order: 10",
        "    endpoints:",
        '      include: ["example.org"]',
        "",
      ].join("\n");
    expect(validatePolicy(doc)).toContainEqual(expect.stringContaining("unique"));
  });

  test("accepts a valid middleware entry", () => {
    const doc =
      minimalValid() +
      [
        "network_middlewares:",
        "  redactor:",
        "    middleware: openshell/regex",
        "    order: 10",
        "    on_error: fail_closed",
        "    endpoints:",
        '      include: ["example.com"]',
        "",
      ].join("\n");
    expect(validatePolicy(doc)).toEqual([]);
  });
});
