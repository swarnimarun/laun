// OpenShell provider profile: load + validate + secret scan.
//
// A provider profile declares the model endpoint and the credential OpenShell
// injects only for approved endpoints, so the agent inside the sandbox never
// sees the real key. Field map verified 2026-10-04 against:
//   https://docs.nvidia.com/openshell/latest/how-it-works/providers/profiles
//   https://docs.nvidia.com/openshell/latest/tutorials/run-pi-with-openrouter
//
// The profile lives at deploy/openshell/provider-model.yaml (outside this
// package). Tests resolve it from the repo root; CLOUDBEAR_PROVIDER_PROFILE
// overrides the path.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { validateBinaryObject, validateEndpointObject } from "./openshell.js";

const here = dirname(fileURLToPath(import.meta.url));

export function defaultProviderProfilePath(): string {
  if (process.env["CLOUDBEAR_PROVIDER_PROFILE"]) return resolve(process.env["CLOUDBEAR_PROVIDER_PROFILE"]!);
  // packages/policy/src -> repo root -> deploy/openshell/provider-model.yaml
  return join(here, "..", "..", "..", "deploy", "openshell", "provider-model.yaml");
}

export function loadProviderProfileText(path?: string): string {
  return readFileSync(path ?? defaultProviderProfilePath(), "utf8");
}

const CATEGORIES = new Set(["other", "inference", "agent", "source_control", "messaging", "data", "knowledge"]);
const AUTH_STYLES = new Set(["basic", "bearer", "header", "query", "path"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HOST_RE = /^(?=.{1,253}$)(\*|[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9*]([A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?)*$/;

/** True when a host value is a real host: DNS name, IP literal, or wildcard. */
export function isRealHost(host: unknown): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  if (host.includes("://") || host.includes("/") || host.includes(" ")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((o) => Number(o) <= 255);
  }
  if (host === "localhost") return true;
  return HOST_RE.test(host) && host.includes(".");
}

/**
 * Validate a parsed provider profile. Returns problems (empty = valid).
 * Checks the documented profile shape: id, display_name, category,
 * inference_capable, credentials[] (env_vars/auth_style/header_name),
 * discovery, endpoints[] (host/port/protocol/access/enforcement), binaries[].
 */
export function validateProviderProfile(profile: unknown, rawText?: string): string[] {
  const problems: string[] = [];
  if (!isObj(profile)) return ["provider profile root must be a mapping"];
  // The no-secrets guarantee must not rest on a file-text test alone: when
  // the raw text is available, scan it as part of validation (fail closed).
  if (typeof rawText === "string") {
    for (const hit of scanForSecrets(rawText)) {
      problems.push(`profile contains a secret-looking literal (${hit})`);
    }
  }

  if (typeof profile["id"] !== "string" || !/^[a-z0-9-]+$/.test(profile["id"] as string)) {
    problems.push('profile "id" required: lowercase kebab-case [a-z0-9-]');
  }
  if (typeof profile["display_name"] !== "string" || (profile["display_name"] as string).length === 0) {
    problems.push('profile "display_name" required');
  }
  if ("category" in profile && !CATEGORIES.has(profile["category"] as string)) {
    problems.push(`profile "category" must be one of ${[...CATEGORIES].join(", ")}`);
  }
  if ("inference_capable" in profile && typeof profile["inference_capable"] !== "boolean") {
    problems.push('profile "inference_capable" must be a boolean');
  }

  const declared = new Set<string>();
  if (!Array.isArray(profile["credentials"]) || (profile["credentials"] as unknown[]).length === 0) {
    problems.push('profile "credentials" must be a non-empty list');
  } else {
    (profile["credentials"] as unknown[]).forEach((c, i) => {
      const where = `credentials[${i}]`;
      if (!isObj(c)) {
        problems.push(`${where}: must be an object`);
        return;
      }
      if (typeof c["name"] !== "string" || (c["name"] as string).length === 0) {
        problems.push(`${where}.name: required`);
      } else {
        declared.add(c["name"] as string);
      }
      if ("env_vars" in c) {
        const ev = c["env_vars"];
        if (!Array.isArray(ev) || ev.length === 0 || !ev.every((s) => typeof s === "string")) {
          problems.push(`${where}.env_vars: must be a non-empty list of strings`);
        } else {
          for (const v of ev as string[]) {
            if (/^v\d+_/i.test(v)) {
              problems.push(`${where}.env_vars: "${v}" uses the reserved v<digits>_ prefix`);
            }
          }
        }
      }
      if ("auth_style" in c && !AUTH_STYLES.has(c["auth_style"] as string)) {
        problems.push(`${where}.auth_style: must be basic|bearer|header|query|path`);
      }
      if ("required" in c && typeof c["required"] !== "boolean") {
        problems.push(`${where}.required: must be a boolean`);
      }
    });
  }

  if ("discovery" in profile) {
    const d = profile["discovery"];
    if (!isObj(d)) {
      problems.push("discovery: must be an object");
    } else if ("credentials" in d) {
      const dc = d["credentials"];
      if (!Array.isArray(dc) || !dc.every((s) => typeof s === "string")) {
        problems.push("discovery.credentials: must be a list of strings");
      } else {
        for (const name of dc as string[]) {
          if (!declared.has(name)) problems.push(`discovery.credentials: "${name}" names no declared credential`);
        }
      }
    }
  }

  if ("endpoints" in profile) {
    const eps = profile["endpoints"];
    if (!Array.isArray(eps) || eps.length === 0) {
      problems.push('profile "endpoints" must be a non-empty list when present');
    } else {
      (eps as unknown[]).forEach((ep, i) => {
        if (!isObj(ep)) {
          problems.push(`endpoints[${i}]: must be an object`);
          return;
        }
        if (!isRealHost(ep["host"])) {
          problems.push(`endpoints[${i}].host: must be a real hostname, IP, or wildcard (not a placeholder or URL)`);
        }
        validateEndpointObject(ep, `endpoints[${i}]`, problems);
      });
    }
  }

  if ("binaries" in profile) {
    const bins = profile["binaries"];
    if (!Array.isArray(bins) || bins.length === 0) {
      problems.push('profile "binaries" must be a non-empty list when present');
    } else {
      (bins as unknown[]).forEach((b, i) => validateBinaryObject(b, `binaries[${i}]`, problems));
    }
  }

  return problems;
}

// High-confidence secret-literal patterns. Names of credential *variables*
// (e.g. `name: api_key`, `OPENROUTER_API_KEY`) must NOT match -- only values
// shaped like real issued secrets.
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-(live|test)-[A-Za-z0-9]{8,}/, label: "OpenAI-style sk- key" },
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/, label: "Anthropic key" },
  // OpenRouter keys (sk-or-v1-...) and any long sk- secret: the sk-(live|test)
  // rule above misses these, and a bare `sk-` prefix with a long random tail
  // is secret-shaped regardless of vendor infix.
  { re: /sk-or-v1-[A-Za-z0-9_-]{8,}/, label: "OpenRouter key" },
  { re: /\bsk-[A-Za-z0-9_-]{24,}/, label: "long sk- secret" },
  { re: /xox[bpas]-[A-Za-z0-9-]{8,}/, label: "Slack token" },
  { re: /gh[op]_[A-Za-z0-9]{20,}/, label: "GitHub token" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key id" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key block" },
  { re: /openrouter[a-z]*['"]?\s*[:=]\s*['"]?sk-[A-Za-z0-9_-]{8,}/i, label: "OpenRouter key assignment" },
  { re: /api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i, label: "api_key assigned a secret-looking value" },
];

/** Return descriptions of secret-looking literals found in text (empty = clean). */
export function scanForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

/** Parse YAML (surfacing duplicate-key errors) for profile tests. */
export function parseProviderProfile(text: string): { value: unknown; problems: string[] } {
  const doc = parseDocument(text);
  const problems = doc.errors.map((e) => `YAML error: ${e.message.split("\n")[0]}`);
  if (problems.length > 0) return { value: undefined, problems };
  return { value: doc.toJSON() as unknown, problems };
}
