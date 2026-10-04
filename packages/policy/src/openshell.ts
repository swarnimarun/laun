// OpenShell policy layer: validator + abstract -> OpenShell translator.
//
// The legacy dialect (index.ts: PolicyTemplate JSON with filesystem/network/
// processes/credentials) is NOT accepted by OpenShell. The real policy is YAML:
//   version: 1
//   filesystem_policy: { include_workdir, read_only[], read_write[] }
//   landlock: { compatibility }
//   process: { run_as_user, run_as_group }
//   network_policies: { <rule>: { endpoints[], binaries[] } }
//   network_middlewares: { <name>: { middleware, endpoints, order, ... } }
//
// Reference (verified 2026-10-04):
//   https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema
//   https://docs.nvidia.com/openshell/latest/how-it-works/providers/profiles
//
// This module fails closed: anything it cannot prove valid is reported as a
// problem (validatePolicy) or throws (renderOpenShellPolicy). OpenShell itself
// re-validates server-side; this catches authoring errors before they ship.
//
// What this does NOT check (left to `openshell policy advisor` / `prover` on
// the VPS): cross-endpoint consistency (same tls/allowed_ips for overlapping
// hosts), whether binary paths exist in the pinned image, or whether the
// kernel supports Landlock. See the integration contract in the handoff.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
function templatesDir(): string {
  return join(here, "..", "templates");
}

export function listOpenShellTemplates(): string[] {
  return readdirSync(templatesDir())
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
}

/** Raw template text (still contains ${VAR} placeholders). Render validates. */
export function loadOpenShellTemplate(name: string): string {
  return readFileSync(join(templatesDir(), `${name}.yaml`), "utf8");
}

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Substitute ${VAR} placeholders and return real OpenShell YAML.
 * Throws (fail closed) on missing vars or on a rendered policy that does not
 * validate -- an invalid policy must never be written out silently.
 */
export function renderOpenShellPolicy(name: string, vars: Record<string, string>): string {
  const raw = loadOpenShellTemplate(name);
  const missing = new Set<string>();
  const rendered = raw.replace(VAR_RE, (m, key: string) => {
    if (!(key in vars)) {
      missing.add(key);
      return m;
    }
    return vars[key];
  });
  if (missing.size > 0) {
    throw new Error(`missing template vars: ${[...missing].sort().join(", ")}`);
  }
  const problems = validatePolicy(rendered);
  if (problems.length > 0) {
    throw new Error(`rendered openshell policy "${name}" invalid: ${problems.join("; ")}`);
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// validatePolicy
// ---------------------------------------------------------------------------

const MAX_POLICY_BYTES = 4 * 1024 * 1024;
const MAX_PATHS = 256;
const MAX_PATH_BYTES = 4096;

const TOP_LEVEL_KEYS = new Set([
  "version",
  "filesystem_policy",
  "landlock",
  "process",
  "network_policies",
  "network_middlewares",
]);
const FS_KEYS = new Set(["include_workdir", "read_only", "read_write"]);
const LANDLOCK_KEYS = new Set(["compatibility"]);
const PROCESS_KEYS = new Set(["run_as_user", "run_as_group"]);
const RULE_KEYS = new Set(["name", "endpoints", "binaries"]);
const BINARY_KEYS = new Set(["path"]);
// Endpoint keys seen in the schema reference + profile field map. Anything
// else is rejected as unknown (OpenShell rejects unknown fields server-side).
const ENDPOINT_KEYS = new Set([
  "host",
  "port",
  "ports",
  "path",
  "allowed_ips",
  "protocol",
  "tls",
  "enforcement",
  "access",
  "rules",
  "deny_rules",
  "allow_encoded_slash",
  "credential_binding",
  "request_body_credential_rewrite",
  "websocket_credential_rewrite",
  "allow_uninspected_credentials",
  "credential_signing",
  "signing_service",
  "signing_region",
  "persisted_queries",
  "graphql_persisted_queries",
  "graphql_max_body_bytes",
  "mcp",
  "json_rpc",
  "json-rpc",
]);
const MIDDLEWARE_KEYS = new Set(["middleware", "endpoints", "order", "config", "on_error", "name"]);
const MW_ENDPOINT_KEYS = new Set(["include", "exclude"]);
const MCP_KEYS = new Set([
  "versions",
  "max_body_bytes",
  "strict_tool_names",
  "allow_all_known_mcp_methods",
]);
const JSON_RPC_KEYS = new Set(["max_body_bytes"]);

const PROTOCOLS = new Set(["rest", "websocket", "graphql", "mcp", "json-rpc", "tcp"]);
const ENFORCEMENTS = new Set(["enforce", "audit"]);
const ACCESSES = new Set(["read-only", "read-write", "full"]);
const MCP_VERSIONS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
const SIGNINGS = new Set(["sigv4", "sigv4:body", "sigv4:no_body"]);
// Ports OpenShell never routes to on exact-host/IP/allowed_ips endpoints.
const BLOCKED_PORTS = new Set([2379, 2380, 6443, 10250, 10255]);
// Hosts that must never appear as an allowed destination.
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "169.254.169.254"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split(".").every((o) => Number(o) <= 255);
}

function ipv4ToInt(s: string): number {
  const o = s.split(".").map(Number);
  return ((o[0]! * 256 + o[1]!) * 256 + o[2]!) * 256 + o[3]!;
}

function parseIPv4CIDR(s: string): [number, number] | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
  if (!m || !isIPv4(m[1]!)) return null;
  const bits = Number(m[2]!);
  if (bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff - (2 ** (32 - bits) - 1)) >>> 0;
  return [ipv4ToInt(m[1]!) >>> 0, mask];
}

/** True when an IPv4 address or CIDR range touches a blocked range. */
function touchesBlockedIPv4(s: string): boolean {
  const blocked: Array<[number, number]> = [
    [ipv4ToInt("127.0.0.0"), 0xff000000], // loopback 127/8
    [ipv4ToInt("169.254.0.0"), 0xffff0000], // link-local + cloud metadata
    [ipv4ToInt("0.0.0.0"), 0xff000000], // "this network" / unspecified 0/8
  ];
  const check = (ip: number, mask: number) => {
    for (const [bip, bmask] of blocked) {
      // Two ranges overlap iff their network portions agree under the wider
      // (shorter-prefix, numerically smaller) mask.
      const wide = mask < bmask ? mask : bmask;
      if (((ip & wide) >>> 0) === ((bip & wide) >>> 0)) return true;
    }
    return false;
  };
  if (isIPv4(s)) return check(ipv4ToInt(s) >>> 0, 0xffffffff);
  const cidr = parseIPv4CIDR(s);
  if (cidr) return check(cidr[0], cidr[1]);
  return false;
}

function isBlockedIPLiteral(host: string): boolean {
  const h = host.toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isIPv4(h) || parseIPv4CIDR(h)) return touchesBlockedIPv4(h);
  // IPv6 loopback / unspecified / link-local.
  if (h === "::1" || h === "::" || h === "::ffff:127.0.0.1") return true;
  if (h.startsWith("fe80:") || h.startsWith("[fe80:")) return true;
  return false;
}

function checkFsPath(p: unknown, where: string, problems: string[]): void {
  if (typeof p !== "string" || p.length === 0) {
    problems.push(`${where}: path must be a non-empty string`);
    return;
  }
  if (!p.startsWith("/")) problems.push(`${where}: path must be absolute: ${p}`);
  if (p.split("/").includes("..")) problems.push(`${where}: path must not contain "..": ${p}`);
  if (Buffer.byteLength(p, "utf8") > MAX_PATH_BYTES) {
    problems.push(`${where}: path exceeds ${MAX_PATH_BYTES} bytes: ${p}`);
  }
}

function checkPort(p: unknown, where: string, problems: string[]): void {
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
    problems.push(`${where}: port must be an integer 1-65535`);
  }
}

function checkHost(host: unknown, where: string, problems: string[]): string | null {
  if (typeof host !== "string" || host.length === 0) {
    problems.push(`${where}: host must be a non-empty string`);
    return null;
  }
  if (host.includes("://") || host.includes("/")) {
    problems.push(`${where}: host must be a hostname/IP/wildcard, not a URL or path: ${host}`);
    return null;
  }
  if (isBlockedIPLiteral(host)) {
    problems.push(`${where}: host is never authorized by network policy (loopback/link-local/metadata): ${host}`);
    return host;
  }
  if (/[?[\]]/.test(host)) {
    problems.push(`${where}: endpoint hosts accept only * and ** wildcards: ${host}`);
    return host;
  }
  if (host.includes("*")) {
    const labels = host.split(".");
    if (labels.length < 3) {
      problems.push(`${where}: wildcard host needs at least three DNS labels: ${host}`);
    }
  }
  return host;
}

function checkRestLikeRules(
  list: unknown,
  where: string,
  protocol: string,
  wrapped: boolean,
  problems: string[],
): void {
  if (!Array.isArray(list)) {
    problems.push(`${where}: must be a list`);
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const at = `${where}[${i}]`;
    if (wrapped) {
      if (!isObj(entry) || !isObj(entry["allow"])) {
        problems.push(`${at}: each entry must wrap matcher fields in "allow"`);
        continue;
      }
      const extra = Object.keys(entry).filter((k) => k !== "allow");
      if (extra.length > 0) problems.push(`${at}: unexpected keys beside "allow": ${extra.join(", ")}`);
      checkMatcher(entry["allow"] as Record<string, unknown>, `${at}.allow`, protocol, problems);
    } else {
      if (!isObj(entry)) {
        problems.push(`${at}: each entry must be an object`);
        continue;
      }
      if ("allow" in entry) problems.push(`${at}: deny_rules entries list matcher fields directly, without "allow"`);
      checkMatcher(entry, at, protocol, problems);
    }
  }
}

function checkMatcher(m: Record<string, unknown>, where: string, protocol: string, problems: string[]): void {
  const str = (k: string) => m[k];
  if (protocol === "rest" || protocol === "websocket") {
    if (typeof str("method") !== "string" || typeof str("path") !== "string") {
      problems.push(`${where}: ${protocol} rules require "method" and "path" strings`);
    } else if (protocol === "websocket" && !["GET", "WEBSOCKET_TEXT", "*"].includes(m["method"] as string)) {
      problems.push(`${where}: websocket method must be GET, WEBSOCKET_TEXT or *: ${m["method"]}`);
    }
    if ("query" in m && !isObj(m["query"])) problems.push(`${where}: "query" must be a map`);
  } else if (protocol === "graphql") {
    if (!["query", "mutation", "subscription"].includes(m["operation_type"] as string)) {
      problems.push(`${where}: graphql rules require operation_type query|mutation|subscription`);
    }
    if ("fields" in m && (!Array.isArray(m["fields"]) || !(m["fields"] as unknown[]).every((f) => typeof f === "string"))) {
      problems.push(`${where}: graphql "fields" must be a list of strings`);
    }
  } else if (protocol === "mcp") {
    const method = m["method"];
    if (typeof method !== "string") {
      problems.push(`${where}: mcp rules require "method" (unless mcp.allow_all_known_mcp_methods is true)`);
    } else {
      if (method === "*") problems.push(`${where}: mcp method "*" is not allowed`);
      else if (/[*?[\]]/.test(method) && !method.startsWith("tools/")) {
        problems.push(`${where}: mcp globs are allowed only in the tools/ family: ${method}`);
      }
    }
    if (("tool" in m || "params.name" in m) && method !== "tools/call") {
      problems.push(`${where}: rules with tool/params.name must set method: tools/call`);
    }
  } else if (protocol === "json-rpc") {
    const method = m["method"];
    if (typeof method !== "string") {
      problems.push(`${where}: json-rpc rules require "method"`);
    } else if (method !== "*" && /[*?[\]]/.test(method)) {
      problems.push(`${where}: json-rpc method must be exact or "*": ${method}`);
    }
  }
}

/** Shared endpoint-object check used by policies and provider profiles. */
export function validateEndpointObject(ep: unknown, where: string, problems: string[]): void {
  if (!isObj(ep)) {
    problems.push(`${where}: endpoint must be an object`);
    return;
  }
  const unk = unknownKeys(ep, ENDPOINT_KEYS);
  if (unk.length > 0) problems.push(`${where}: unknown endpoint fields: ${unk.join(", ")}`);

  const host = "host" in ep ? checkHost(ep["host"], `${where}.host`, problems) : null;
  const hasAllowedIps = "allowed_ips" in ep;
  if (!("host" in ep) && !hasAllowedIps) {
    problems.push(`${where}: endpoint needs "host" or "allowed_ips"`);
  }
  if (hasAllowedIps) {
    const ips = ep["allowed_ips"];
    if (!Array.isArray(ips) || ips.length === 0 || !ips.every((s) => typeof s === "string")) {
      problems.push(`${where}.allowed_ips: must be a non-empty list of strings`);
    } else {
      for (const s of ips as string[]) {
        if (touchesBlockedIPv4(s) || s === "::1" || s.startsWith("fe80:")) {
          problems.push(`${where}.allowed_ips: overlaps a blocked range (loopback/link-local/metadata): ${s}`);
        }
      }
    }
  }

  const hasPort = "port" in ep;
  const hasPorts = "ports" in ep;
  if (hasPort && hasPorts) {
    problems.push(`${where}: set "port" or "ports", not both`);
  } else if (!hasPort && !hasPorts) {
    problems.push(`${where}: endpoint needs "port" or "ports"`);
  }
  const ports: unknown[] = [];
  if (hasPort) {
    checkPort(ep["port"], `${where}.port`, problems);
    ports.push(ep["port"]);
  }
  if (hasPorts) {
    if (!Array.isArray(ep["ports"]) || (ep["ports"] as unknown[]).length === 0) {
      problems.push(`${where}.ports: must be a non-empty list of integers`);
    } else {
      for (const p of ep["ports"] as unknown[]) {
        checkPort(p, `${where}.ports`, problems);
        ports.push(p);
      }
    }
  }
  // OpenShell blocks control-plane ports on exact-host/IP/allowed_ips endpoints.
  const exactTarget = host !== null && !host.includes("*");
  if ((exactTarget || hasAllowedIps) && ports.some((p) => typeof p === "number" && BLOCKED_PORTS.has(p))) {
    problems.push(`${where}: ports 2379,2380,6443,10250,10255 are blocked by OpenShell on exact-host/IP/allowed_ips endpoints`);
  }

  const protocol = ep["protocol"];
  if ("protocol" in ep && !PROTOCOLS.has(protocol as string)) {
    problems.push(`${where}.protocol: must be one of ${[...PROTOCOLS].join(", ")}`);
  }
  if ("enforcement" in ep && !ENFORCEMENTS.has(ep["enforcement"] as string)) {
    problems.push(`${where}.enforcement: must be enforce|audit`);
  }
  if ("access" in ep && !ACCESSES.has(ep["access"] as string)) {
    problems.push(`${where}.access: must be read-only|read-write|full`);
  }

  const hasAccess = "access" in ep;
  const hasRules = "rules" in ep;
  if (hasAccess && hasRules) {
    problems.push(`${where}: "access" and "rules" cannot be combined`);
  }
  if (protocol === "tcp") {
    if (!("host" in ep) || (!hasPort && !hasPorts)) {
      problems.push(`${where}: protocol tcp requires a hostname and a port`);
    }
    for (const k of ["path", "enforcement", "access", "rules", "deny_rules", "request_body_credential_rewrite", "websocket_credential_rewrite", "credential_signing", "signing_service", "mcp", "json_rpc", "json-rpc", "persisted_queries", "graphql_persisted_queries", "graphql_max_body_bytes"]) {
      if (k in ep) problems.push(`${where}: protocol tcp accepts no request field "${k}"`);
    }
  } else if (protocol === "rest" || protocol === "websocket" || protocol === "graphql") {
    if (!hasAccess && !hasRules) {
      problems.push(`${where}: ${protocol} endpoints need "access" or "rules"`);
    }
  } else if (protocol === "mcp" || protocol === "json-rpc") {
    const mcp = ep["mcp"];
    const allowAll = isObj(mcp) && mcp["allow_all_known_mcp_methods"] === true;
    if (!hasRules && !(protocol === "mcp" && allowAll)) {
      problems.push(`${where}: ${protocol} endpoints need "rules"`);
    }
  } else if (!("protocol" in ep) && (hasAccess || hasRules)) {
    problems.push(`${where}: without "protocol", "access" and "rules" have no effect`);
  }

  if ("deny_rules" in ep) {
    if (!("protocol" in ep)) problems.push(`${where}: deny_rules require "protocol"`);
    else if (protocol !== "mcp" && !hasAccess && !hasRules) {
      problems.push(`${where}: deny_rules require "rules" or "access" on non-MCP endpoints`);
    }
  }
  if (hasRules && typeof protocol === "string" && protocol !== "tcp") {
    checkRestLikeRules(ep["rules"], `${where}.rules`, protocol, true, problems);
  }
  if ("deny_rules" in ep && typeof protocol === "string") {
    checkRestLikeRules(ep["deny_rules"], `${where}.deny_rules`, protocol, false, problems);
  }

  if ("allow_encoded_slash" in ep && typeof ep["allow_encoded_slash"] !== "boolean") {
    problems.push(`${where}.allow_encoded_slash: must be a boolean`);
  }
  for (const k of ["request_body_credential_rewrite", "websocket_credential_rewrite", "allow_uninspected_credentials"]) {
    if (k in ep && typeof ep[k] !== "boolean") problems.push(`${where}.${k}: must be a boolean`);
  }
  if ("credential_binding" in ep) {
    const cb = ep["credential_binding"];
    if (!isObj(cb) || typeof cb["provider"] !== "string") {
      problems.push(`${where}.credential_binding: must be an object with a "provider" string`);
    }
  }
  if ("credential_signing" in ep) {
    if (!SIGNINGS.has(ep["credential_signing"] as string)) {
      problems.push(`${where}.credential_signing: must be sigv4|sigv4:body|sigv4:no_body`);
    }
    if (typeof ep["signing_service"] !== "string") {
      problems.push(`${where}: credential_signing requires "signing_service"`);
    }
  }
  if ("mcp" in ep) {
    const mcp = ep["mcp"];
    if (!isObj(mcp)) {
      problems.push(`${where}.mcp: must be an object`);
    } else {
      const unkM = unknownKeys(mcp, MCP_KEYS);
      if (unkM.length > 0) problems.push(`${where}.mcp: unknown fields: ${unkM.join(", ")}`);
      if ("versions" in mcp) {
        const vs = mcp["versions"];
        if (!Array.isArray(vs) || !(vs as unknown[]).every((v) => typeof v === "string" && MCP_VERSIONS.has(v))) {
          problems.push(`${where}.mcp.versions: must list known MCP revisions`);
        }
      }
      for (const k of ["max_body_bytes"] as const) {
        if (k in mcp && typeof mcp[k] !== "number") problems.push(`${where}.mcp.${k}: must be a number`);
      }
      for (const k of ["strict_tool_names", "allow_all_known_mcp_methods"] as const) {
        if (k in mcp && typeof mcp[k] !== "boolean") problems.push(`${where}.mcp.${k}: must be a boolean`);
      }
    }
  }
  for (const k of ["json_rpc", "json-rpc"] as const) {
    if (k in ep) {
      const jr = ep[k];
      if (!isObj(jr)) problems.push(`${where}.${k}: must be an object`);
      else {
        const unkJ = unknownKeys(jr, JSON_RPC_KEYS);
        if (unkJ.length > 0) problems.push(`${where}.${k}: unknown fields: ${unkJ.join(", ")}`);
        if ("max_body_bytes" in jr && typeof jr["max_body_bytes"] !== "number") {
          problems.push(`${where}.${k}.max_body_bytes: must be a number`);
        }
      }
    }
  }
}

export function validateBinaryObject(b: unknown, where: string, problems: string[]): void {
  // Accept the policy object form {path} and the profile scalar form "/...".
  if (typeof b === "string") {
    if (b.length === 0 || !b.startsWith("/")) {
      problems.push(`${where}: binary path must be an absolute path string`);
    }
    return;
  }
  if (!isObj(b)) {
    problems.push(`${where}: binary must be a path string or {path} object`);
    return;
  }
  const unk = unknownKeys(b, BINARY_KEYS);
  if (unk.length > 0) problems.push(`${where}: unknown binary fields: ${unk.join(", ")}`);
  if (typeof b["path"] !== "string" || !(b["path"] as string).startsWith("/")) {
    problems.push(`${where}.path: must be an absolute path string`);
  }
}

/**
 * Validate OpenShell policy YAML. Returns the list of problems (empty = valid).
 * Mirrors the validateTemplate shape (string[]) so callers keep working.
 */
export function validatePolicy(yamlText: string): string[] {
  const problems: string[] = [];
  if (typeof yamlText !== "string" || yamlText.trim().length === 0) {
    return ["policy is empty"];
  }
  if (Buffer.byteLength(yamlText, "utf8") > MAX_POLICY_BYTES) {
    problems.push(`policy exceeds ${MAX_POLICY_BYTES} bytes (4 MiB)`);
  }
  const leftover = yamlText.match(VAR_RE);
  if (leftover) {
    problems.push(`unsubstituted template vars: ${[...new Set(leftover)].join(", ")} (render first)`);
  }

  const doc = parseDocument(yamlText);
  for (const err of doc.errors) {
    problems.push(`YAML error: ${err.message.split("\n")[0]}`);
  }
  if (doc.errors.length > 0) return problems;
  let policy: unknown;
  try {
    policy = doc.toJSON() as unknown;
  } catch (err) {
    // Unresolvable aliases/anchors throw from toJSON with no doc.errors.
    problems.push(`YAML error: ${(err as Error).message.split("\n")[0]}`);
    return problems;
  }
  if (!isObj(policy)) {
    problems.push("policy root must be a mapping");
    return problems;
  }

  const unkTop = unknownKeys(policy, TOP_LEVEL_KEYS);
  if (unkTop.length > 0) problems.push(`unknown top-level fields: ${unkTop.join(", ")}`);

  if (!("version" in policy)) {
    problems.push('"version" is required');
  } else if (policy["version"] !== 1) {
    problems.push('"version" must be the integer 1');
  }

  if ("filesystem_policy" in policy) {
    const fp = policy["filesystem_policy"];
    const where = "filesystem_policy";
    if (!isObj(fp)) {
      problems.push(`${where}: must be an object`);
    } else {
      const unk = unknownKeys(fp, FS_KEYS);
      if (unk.length > 0) problems.push(`${where}: unknown fields: ${unk.join(", ")}`);
      if ("include_workdir" in fp && typeof fp["include_workdir"] !== "boolean") {
        problems.push(`${where}.include_workdir: must be a boolean`);
      }
      const paths: string[] = [];
      for (const k of ["read_only", "read_write"] as const) {
        if (k in fp) {
          const list = fp[k];
          if (!Array.isArray(list)) {
            problems.push(`${where}.${k}: must be a list of strings`);
          } else {
            for (const p of list as unknown[]) {
              checkFsPath(p, `${where}.${k}`, problems);
              if (typeof p === "string") paths.push(p);
            }
            if (k === "read_write" && (list as unknown[]).includes("/")) {
              problems.push(`${where}.read_write: must never contain "/"`);
            }
          }
        }
      }
      if (paths.length > MAX_PATHS) {
        problems.push(`${where}: at most ${MAX_PATHS} paths per policy, found ${paths.length}`);
      }
      // read_write implies read; listing the same path read-only is ambiguous.
      if (Array.isArray(fp["read_only"]) && Array.isArray(fp["read_write"])) {
        const ro = new Set((fp["read_only"] as unknown[]).filter((p) => typeof p === "string"));
        const both = (fp["read_write"] as unknown[]).filter((p) => typeof p === "string" && ro.has(p as string));
        if (both.length > 0) problems.push(`${where}: listed as both read_only and read_write: ${both.join(", ")}`);
      }
    }
  }

  if ("landlock" in policy) {
    const ll = policy["landlock"];
    if (!isObj(ll)) {
      problems.push("landlock: must be an object");
    } else {
      const unk = unknownKeys(ll, LANDLOCK_KEYS);
      if (unk.length > 0) problems.push(`landlock: unknown fields: ${unk.join(", ")}`);
      if ("compatibility" in ll && ll["compatibility"] !== "best_effort" && ll["compatibility"] !== "hard_requirement") {
        problems.push('landlock.compatibility: must be best_effort|hard_requirement');
      }
    }
  }

  if ("process" in policy) {
    const pr = policy["process"];
    if (!isObj(pr)) {
      problems.push("process: must be an object");
    } else {
      const unk = unknownKeys(pr, PROCESS_KEYS);
      if (unk.length > 0) problems.push(`process: unknown fields: ${unk.join(", ")}`);
      for (const k of ["run_as_user", "run_as_group"] as const) {
        if (k in pr) {
          const v = pr[k];
          if (v === "sandbox") continue;
          const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
          if (!Number.isInteger(n) || n < 1 || n > 4294967294) {
            problems.push(`process.${k}: must be "sandbox" or a numeric UID/GID 1-4294967294 (root rejected)`);
          }
        }
      }
    }
  }

  if ("network_policies" in policy) {
    const np = policy["network_policies"];
    if (!isObj(np)) {
      problems.push("network_policies: must be a map of named rules");
    } else {
      for (const [ruleName, rule] of Object.entries(np)) {
        const where = `network_policies.${ruleName}`;
        if (ruleName.startsWith("_provider_")) {
          problems.push(`${where}: rule keys starting with "_provider_" are reserved for providers`);
        }
        if (!isObj(rule)) {
          problems.push(`${where}: rule must be an object`);
          continue;
        }
        const unk = unknownKeys(rule, RULE_KEYS);
        if (unk.length > 0) problems.push(`${where}: unknown fields: ${unk.join(", ")}`);
        if ("endpoints" in rule) {
          if (!Array.isArray(rule["endpoints"])) {
            problems.push(`${where}.endpoints: must be a list`);
          } else {
            (rule["endpoints"] as unknown[]).forEach((ep, i) =>
              validateEndpointObject(ep, `${where}.endpoints[${i}]`, problems),
            );
          }
        }
        if ("binaries" in rule) {
          if (!Array.isArray(rule["binaries"])) {
            problems.push(`${where}.binaries: must be a list`);
          } else {
            (rule["binaries"] as unknown[]).forEach((b, i) =>
              validateBinaryObject(b, `${where}.binaries[${i}]`, problems),
            );
          }
        }
      }
    }
  }

  if ("network_middlewares" in policy) {
    const nm = policy["network_middlewares"];
    if (!isObj(nm)) {
      problems.push("network_middlewares: must be a map");
    } else {
      const names = Object.keys(nm);
      if (names.length > 10) problems.push(`network_middlewares: at most 10 configurations, found ${names.length}`);
      const orders = new Set<number>();
      for (const [mwName, mw] of Object.entries(nm)) {
        const where = `network_middlewares.${mwName}`;
        if (!isObj(mw)) {
          problems.push(`${where}: must be an object`);
          continue;
        }
        const unk = unknownKeys(mw, MIDDLEWARE_KEYS);
        if (unk.length > 0) problems.push(`${where}: unknown fields: ${unk.join(", ")}`);
        if (typeof mw["middleware"] !== "string" || (mw["middleware"] as string).length === 0) {
          problems.push(`${where}.middleware: required non-empty string`);
        }
        if (!isObj(mw["endpoints"])) {
          problems.push(`${where}.endpoints: required object with "include"`);
        } else {
          const mwe = mw["endpoints"] as Record<string, unknown>;
          const unkE = unknownKeys(mwe, MW_ENDPOINT_KEYS);
          if (unkE.length > 0) problems.push(`${where}.endpoints: unknown fields: ${unkE.join(", ")}`);
          for (const k of ["include", "exclude"] as const) {
            if (k in mwe) {
              const list = mwe[k];
              if (!Array.isArray(list) || (list as unknown[]).length === 0 || !(list as unknown[]).every((s) => typeof s === "string")) {
                problems.push(`${where}.endpoints.${k}: must be a non-empty list of strings`);
              } else if ((list as unknown[]).length > 32) {
                problems.push(`${where}.endpoints.${k}: at most 32 patterns`);
              }
            }
          }
          if (!("include" in mwe)) problems.push(`${where}.endpoints.include: required`);
        }
        if ("order" in mw) {
          if (typeof mw["order"] !== "number" || !Number.isInteger(mw["order"])) {
            problems.push(`${where}.order: must be an integer`);
          } else if (orders.has(mw["order"] as number)) {
            problems.push(`${where}.order: values must be unique`);
          } else {
            orders.add(mw["order"] as number);
          }
        }
        if ("on_error" in mw && mw["on_error"] !== "fail_closed" && mw["on_error"] !== "fail_open") {
          problems.push(`${where}.on_error: must be fail_closed|fail_open`);
        }
        if ("config" in mw && !isObj(mw["config"])) {
          problems.push(`${where}.config: must be an object`);
        }
      }
    }
  }

  return problems;
}
