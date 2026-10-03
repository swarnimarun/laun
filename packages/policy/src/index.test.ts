import { describe, expect, test } from "bun:test";
import { listTemplates, loadTemplate, renderTemplate, validateTemplate } from "./index.js";

describe("policy", () => {
  test("ships restrictive + standard-dev templates", () => {
    expect(listTemplates()).toEqual(["restrictive", "standard-dev"]);
  });

  test("templates load and validate", () => {
    for (const name of listTemplates()) {
      const tpl = loadTemplate(name);
      expect(validateTemplate(tpl)).toEqual([]);
    }
  });

  test("render fills vars, fails closed on missing", () => {
    const tpl = loadTemplate("restrictive");
    const rendered = renderTemplate(tpl, { WORKDIR: "/data/work/abc", MODEL_HOST: "openrouter.ai" });
    expect(JSON.stringify(rendered)).not.toContain("${");
    expect(() => renderTemplate(tpl, { WORKDIR: "/x" })).toThrow("MODEL_HOST");
  });

  test("validator catches write wider than read", () => {
    const tpl = loadTemplate("restrictive");
    const bad = { ...tpl, filesystem: { read: ["/a"], write: ["/b"] } };
    expect(validateTemplate(bad).length).toBeGreaterThan(0);
  });
});
