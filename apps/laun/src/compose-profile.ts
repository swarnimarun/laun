import { existsSync, readFileSync, statSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";

/** Static dotenv subset shared by CLI and shell setup. Never executes .env. */
export function readEnvValue(content: string, name: string): string | null {
  let raw: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (match?.[1] === name) raw = match[2];
  }
  if (raw === undefined) return null;
  let value: string;
  const trimmed = raw.trim();
  if (trimmed.startsWith("'")) {
    const match = trimmed.match(/^'([^']*)'\s*(?:#.*)?$/);
    if (!match) throw new Error(`invalid quoted value for ${name}`);
    value = match[1]!;
  } else if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (!match) throw new Error(`invalid quoted value for ${name}`);
    value = match[1]!.replace(
      /\\([\\"nrt])/g,
      (_, c: string) =>
        ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' })[c]!,
    );
  } else {
    value = trimmed.replace(/\s+#.*$/, "").trim();
  }
  // Compose interpolation can make preflight check a different resource from
  // the mounted one. Require explicit static isolation settings instead.
  if (
    (name.startsWith("OPENSHELL_") || name === "LAUN_DATA_DIR") &&
    /[\r\n]|\$/.test(value)
  ) {
    throw new Error(
      `${name} must be a static single-line value without interpolation`,
    );
  }
  return value || null;
}

/** Explicit cold-restore binding. Never creates directories or follows links. */
export function validateDataDirectory(value: string): void {
  const parts = value.split("/").filter(Boolean);
  if (
    !isAbsolute(value) ||
    normalize(value) !== value ||
    value.endsWith("/") ||
    /[\x00-\x1f\x7f$]/.test(value) ||
    parts.length < 2 ||
    ["etc", "proc", "sys", "dev", "run", "bin", "sbin", "usr"].includes(
      parts[0]!,
    ) ||
    (["home", "var"].includes(parts[0]!) && parts.length < 3)
  )
    throw new Error(
      "LAUN_DATA_DIR must be a static canonical absolute dedicated data directory; protected bases are refused",
    );
  let current = parse(value).root;
  for (const part of parts) {
    current = join(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      throw new Error(
        "LAUN_DATA_DIR must already exist; setup will not create a possibly incorrect restore destination",
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(
        "LAUN_DATA_DIR and every ancestor must be real directories without symlinks",
      );
    const mode = entry.mode & 0o7777;
    if ((mode & 0o022) !== 0 && !((mode & 0o1000) !== 0 && current !== value))
      throw new Error("LAUN_DATA_DIR has an ancestor writable by other users");
    if (current === value && (mode & 0o077) !== 0)
      throw new Error(
        "LAUN_DATA_DIR must be private (0700); review permissions explicitly",
      );
  }
}

export function setupComposeFiles(
  content: string,
  compose: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultEnabled = false,
): string[] {
  const setting = (name: string, fallback = "") =>
    env[name] ?? readEnvValue(content, name) ?? fallback;
  const dataDir = setting("LAUN_DATA_DIR");
  if (dataDir) validateDataDirectory(dataDir);
  const legacy = setting("LAUN_LEGACY_API", "false");
  if (legacy !== "true" && legacy !== "false")
    throw new Error("LAUN_LEGACY_API must be true or false");
  const base = [
    ...(legacy === "true" ? ["--profile", "legacy"] : []),
    "-f",
    compose,
  ];
  const enabled = setting("OPENSHELL_ENABLED", String(defaultEnabled));
  if (enabled === "false") return base;
  if (enabled !== "true")
    throw new Error("OPENSHELL_ENABLED must be true or false");
  const configDir = setting("OPENSHELL_CONFIG_DIR");
  if (!isAbsolute(configDir))
    throw new Error(
      "isolated VPS install requires an absolute OPENSHELL_CONFIG_DIR on the target host; provision OpenShell and its provider first (deploy/remote-setup.md). Set OPENSHELL_ENABLED=false explicitly only for trusted development",
    );
  const gateway = setting("OPENSHELL_GATEWAY_NAME", "openshell");
  const configId = setting(
    "OPENSHELL_GATEWAY_CONFIG_ID",
    "https___host.openshell.internal_17670",
  );
  if (
    !/^[A-Za-z0-9_-]+$/.test(gateway) ||
    !/^[A-Za-z0-9_.-]+$/.test(configId) ||
    configId === "." ||
    configId === ".."
  ) {
    throw new Error("invalid OpenShell gateway name/config identity");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(
      setting("OPENSHELL_SDK_GATEWAY", "https://host.openshell.internal:17670"),
    );
  } catch {
    throw new Error(
      "OPENSHELL_SDK_GATEWAY must be a valid HTTPS URL without credentials",
    );
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error(
      "isolated install requires an HTTPS OPENSHELL_SDK_GATEWAY without credentials",
    );
  if (
    setting("LAUN_LEGACY_API", "false") === "true" &&
    !setting("OPENSHELL_PROVIDER")
  )
    throw new Error(
      "legacy isolated install requires a provisioned OPENSHELL_PROVIDER; see deploy/remote-setup.md",
    );
  for (const name of ["ca.crt", "tls.crt", "tls.key"]) {
    const file = join(configDir, "gateways", gateway, "mtls", name);
    try {
      if (!statSync(file).isFile() || readFileSync(file).byteLength === 0)
        throw new Error("empty or not a file");
    } catch {
      throw new Error(
        `isolated install requires readable OpenShell mTLS file: ${name}; provision the target host identity before retrying`,
      );
    }
  }
  const overlay = join(dirname(compose), "docker-compose.openshell.yml");
  if (!existsSync(overlay))
    throw new Error("OpenShell compose overlay is missing");
  return [...base, "-f", overlay];
}

if (import.meta.main) {
  try {
    const [envFile, compose, defaultMode = "false"] = process.argv.slice(2);
    if (!envFile || !compose || !["true", "false"].includes(defaultMode))
      throw new Error(
        "usage: compose-profile.ts <env-file> <compose-file> [default-isolation]",
      );
    for (const arg of setupComposeFiles(
      readFileSync(envFile, "utf8"),
      compose,
      process.env,
      defaultMode === "true",
    ))
      console.log(arg);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
