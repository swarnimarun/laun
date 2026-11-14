/**
 * Keep controller credentials out of host agent children. This is containment
 * for trusted-local mode, not a sandbox: the same user can still read host
 * files. Pi/provider variables remain available for existing model logins.
 * New controller configuration belongs under one of these reserved prefixes.
 */
const CONTROL_PREFIXES = ["LAUN_", "GATEWAY_", "EXECUTOR_", "TELEGRAM_", "OPENSHELL_", "GOOSE_"];
const STARTUP_HOOKS = new Set(["NODE_OPTIONS", "BUN_OPTIONS", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"]);

export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (value === undefined || STARTUP_HOOKS.has(name) || CONTROL_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Git acquisition has no use for model keys. Keep only transport/platform
 * configuration and disable inherited Git configuration/askpass commands.
 * Host Git/filesystem/network acquisition still requires a future sandbox gate.
 */
export function repositoryEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TERM",
    "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
  ]);
  for (const [key, value] of Object.entries(agentEnvironment(source))) {
    if (allowed.has(key) || /^LC_[A-Z_]+$/.test(key)) env[key] = value;
  }
  // Global/system config can run credential helpers, hooks, SSH commands or
  // filters outside the sandbox. Private sources must use an explicit SSH
  // agent for now; credential-helper enrollment belongs to the future broker.
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}
