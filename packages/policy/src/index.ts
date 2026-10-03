import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PolicyTemplate {
  name: string;
  description?: string;
  filesystem: { read: string[]; write: string[]; deny?: string[] };
  network: { allowHosts: string[]; denyHosts?: string[] };
  processes: { allow: string[]; deny?: string[] };
  credentials?: { passthrough?: string[]; comment?: string };
  [k: string]: unknown;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Templates live at the package root: packages/policy/templates (works for bun src/ and built dist/). */
function templatesDir(): string {
  return join(here, "..", "templates");
}

export function listTemplates(): string[] {
  return readdirSync(templatesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadTemplate(name: string): PolicyTemplate {
  const raw = readFileSync(join(templatesDir(), `${name}.json`), "utf8");
  const tpl = JSON.parse(raw) as PolicyTemplate;
  const problems = validateTemplate(tpl);
  if (problems.length > 0) {
    throw new Error(`policy template "${name}" invalid: ${problems.join("; ")}`);
  }
  return tpl;
}

/** Render ${VAR} placeholders. Throws on missing vars (fail closed). */
export function renderTemplate(tpl: PolicyTemplate, vars: Record<string, string>): PolicyTemplate {
  const missing = new Set<string>();
  const rendered = JSON.parse(
    JSON.stringify(tpl).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key: string) => {
      if (!(key in vars)) {
        missing.add(key);
        return `\${${key}}`;
      }
      return vars[key];
    }),
  ) as PolicyTemplate;
  if (missing.size > 0) {
    throw new Error(`missing template vars: ${[...missing].join(", ")}`);
  }
  return rendered;
}

export function validateTemplate(tpl: PolicyTemplate): string[] {
  const problems: string[] = [];
  if (!tpl.name) problems.push("name required");
  const fs = tpl.filesystem;
  if (!fs || !Array.isArray(fs.read) || fs.read.length === 0) problems.push("filesystem.read must be non-empty");
  if (!fs || !Array.isArray(fs.write) || fs.write.length === 0) problems.push("filesystem.write must be non-empty");
  const net = tpl.network;
  if (!net || !Array.isArray(net.allowHosts) || net.allowHosts.length === 0) {
    problems.push("network.allowHosts must be non-empty");
  }
  const procs = tpl.processes;
  if (!procs || !Array.isArray(procs.allow) || procs.allow.length === 0) {
    problems.push("processes.allow must be non-empty");
  }
  // Write must not exceed read: every write root should be covered by a read entry (prefix match, ** aware).
  if (fs && Array.isArray(fs.read) && Array.isArray(fs.write)) {
    for (const w of fs.write) {
      const base = w.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
      const covered = fs.read.some((r) => {
        const rb = r.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
        return base === rb || base.startsWith(rb.endsWith("/") ? rb : rb + "/") || rb === base;
      });
      if (!covered) problems.push(`write path "${w}" not covered by filesystem.read`);
    }
  }
  return problems;
}
