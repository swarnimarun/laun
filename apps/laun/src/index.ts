#!/usr/bin/env bun
import { parseAgentKey } from "@laun/protocol";
import { UsageError, flagBool, flagString, parseArgs, requiredArg } from "./args.js";
import {
  createTranscript,
  follow,
  formatApprovals,
  parseDurationMs,
  runDoctor,
  sessionLine,
  watchSession,
  type DoctorGateway,
  type DoctorProbe,
} from "./agent.js";
import { GatewayClient, GatewayError } from "./client.js";
import {
  authFilePath,
  homeFor,
  isValidTargetName,
  listNamedTargets,
  loadNamedTarget,
  loadTarget,
  resolveTarget,
  saveNamedTarget,
  saveTarget,
  targetUrl,
  type Target,
} from "./config.js";
import { connectionBlock, localSetup, parseSshTarget, remoteSetup } from "./setup.js";

export const CLI_VERSION = "0.1.0";

const HELP = `laun — self-hosted remote agent control

  Setup
    laun setup [--host <ip>] [--no-start] [--model <m>] [--env-file <path>]
        Prepare .env locally (gateway token + agent key) and start the stack.

    laun setup ssh -i <identity> [--user <u>] [--port <n>] [--remote-dir <dir>]
        [--repo-url <url>] [--no-start] <host>
        Bootstrap a VPS over SSH and print its agent key.

  Connect
    laun agent auth --host <host> --key <key> [--port <n>] [--scheme http|https]
        Verify the key and save it to ~/.laun/auth.json (0600).

  Drive agents (all accept --target <name> for a saved host)
    laun agent new "<goal>" [--model <m>] [--json]
    laun agent ls [--json]
    laun agent status <id> [--json]
    laun agent log <id> [--follow] [--since <n>] [--json]
    laun agent say <id> <text> [--json]
    laun agent stop <id> [--json]
    laun agent continue <id> [--json]   (alias: retry)
    laun agent approve <id> <requestId> [--note <t>] [--json]
    laun agent deny <id> <requestId> [--note <t>] [--json]
    laun agent watch <id> [--poll-ms <ms>] [--timeout <dur>]
        Wait until the run settles; exit 0 done, 1 error, 2 timeout.
        Durations: bare numbers are ms; suffixes ms|s|m|h (e.g. 30s, 5m).

  Health + named hosts
    laun doctor [--target <name>]
        Check gateway reachability, saved target, key, and common failures.
    laun target ls
    laun target add <name> --host <h> --key <k> [--port <n>] [--scheme http|https]
        Saved hosts; selected per-command with --target <name>. Without the
        flag the default target (env or auth file) is used, as before.

  Shortcuts (same as the agent command in brackets)
    laun list|ls                    (= agent ls)
    laun status <id>                (= agent status <id>)
    laun log <id> [--follow] [--since <n>] [--json]
    laun run "<goal>"               (= agent new; alias of new)
    laun stop <id> [--json]         (= agent stop <id>)
    laun approve|deny <id> <requestId>
    (agent also accepts the aliases: list (= ls), run (= new), retry (= continue))

  Keys (needs GATEWAY_TOKEN, the service secret)
    laun keys ls
    laun keys create [--label <l>]
    laun keys revoke <id>

  Environment overrides: LAUN_HOST, LAUN_PORT, LAUN_KEY
`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Raw write for streaming text (no trailing newline). */
  write: (text: string) => void;
}

const defaultIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  write: (t) => process.stdout.write(t),
};

function clientFor(target: Target, tokenOverride?: string): GatewayClient {
  return new GatewayClient(targetUrl(target), tokenOverride ?? target.key);
}

function requireTarget(env: NodeJS.ProcessEnv, io: Io, name?: string): Target {
  if (name) {
    const home = homeFor(env);
    const named = loadNamedTarget(name, home);
    if (!named) {
      const known = listNamedTargets(home).map((t) => t.name);
      throw new UsageError(
        known.length > 0 ? `unknown target "${name}" — saved targets: ${known.join(", ")}` : `unknown target "${name}" — no saved targets yet (add one with: laun target add <name> --host <ip> --key <key>)`,
      );
    }
    return named;
  }
  const target = resolveTarget(env);
  if (!target) throw new UsageError(`not connected to a laun yet — run: laun agent auth --host <ip> --key <key>`);
  return target;
}

/**
 * Pull `--target <name>` / `--target=<name>` out of a subcommand's argv
 * before its own strict flag parser runs (which would reject the shared
 * flag). Stops at `--` so a literal `--target` in message text survives.
 */
function splitTargetFlag(argv: string[]): { argv: string[]; target?: string } {
  const rest: string[] = [];
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--target") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new UsageError("--target requires a value");
      target = value;
      i++;
      continue;
    }
    if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (!value) throw new UsageError("--target requires a value");
      target = value;
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, target };
}

/** Race a promise against a timeout so a hung gateway cannot hang the CLI. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function setupCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "ssh") {
    const { flags } = parseArgs(rest, {
      boolean: ["no-start", "json"],
      value: ["i", "identity", "user", "port", "remote-dir", "repo-url", "env-file"],
    });
    const rawHost = requiredArg(parseArgs(rest, { boolean: ["no-start"], value: ["i", "identity", "user", "port", "remote-dir", "repo-url", "env-file"] }).positionals, 0, "host", "laun setup ssh -i <identity> [user@]host");
    const identity = flagString(flags, "i") ?? flagString(flags, "identity");
    if (!identity) throw new UsageError("setup ssh needs a private key: -i <identity>");
    const portRaw = flagString(flags, "port");
    const target = parseSshTarget(rawHost, flagString(flags, "user"));
    const result = await remoteSetup({
      identity,
      host: target.host,
      user: target.user,
      port: portRaw ? Number(portRaw) : undefined,
      remoteDir: flagString(flags, "remote-dir") ?? "/opt/laun",
      repoUrl: flagString(flags, "repo-url"),
      noStart: flagBool(flags, "no-start"),
      envFile: flagString(flags, "env-file") ?? ".env",
    });
    if (flagBool(flags, "json")) io.out(JSON.stringify({ url: result.url, key: result.key, host: target.host, remoteDir: result.remoteDir }));
    else io.out(connectionBlock(result.url, result.key, target.host));
    return 0;
  }

  const { flags } = parseArgs(argv, {
    boolean: ["no-start", "json"],
    value: ["host", "model", "env-file", "compose-file"],
  });
  const host = flagString(flags, "host") ?? "localhost";
  const result = await localSetup({
    envFile: flagString(flags, "env-file") ?? ".env",
    composeFile: flagString(flags, "compose-file") ?? "deploy/docker-compose.yml",
    host,
    noStart: flagBool(flags, "no-start"),
  });
  if (flagBool(flags, "json")) io.out(JSON.stringify({ url: result.url, key: result.key, envFile: result.envPath }));
  else io.out(connectionBlock(result.url, result.key, host));
  return 0;
}

/** Fixed prompt sent by `agent continue` to resume a run that died. */
export const CONTINUE_PROMPT = "Please continue from where you left off.";

/** Subcommand aliases accepted under `agent` (mirrored at the top level). */
const AGENT_SUB_ALIASES: Record<string, string> = {
  list: "ls",
  run: "new",
  retry: "continue",
};

async function agentCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const split = splitTargetFlag(argv);
  const [rawSub, ...rest] = split.argv;
  const sub = rawSub === undefined ? undefined : (AGENT_SUB_ALIASES[rawSub] ?? rawSub);

  if (sub === "auth" && split.target !== undefined) {
    throw new UsageError("agent auth saves the default target — name it afterwards with: laun target add <name> --host <host> --key <key>");
  }

  if (sub === "auth") {
    const { flags } = parseArgs(rest, { boolean: ["json"], value: ["host", "key", "port", "scheme"] });
    const host = flagString(flags, "host");
    const key = flagString(flags, "key");
    if (!host || !key) throw new UsageError("usage: laun agent auth --host <host> --key <key> [--port <n>] [--scheme http|https]");
    const target: Target = {
      host,
      port: Number(flagString(flags, "port") ?? 8080),
      scheme: flagString(flags, "scheme") === "https" ? "https" : "http",
      key,
      // Which key this file holds — otherwise the saved artifact never carries
      // the id its own type declares, and `keys ls` cannot be correlated to it.
      keyId: parseAgentKey(key)?.id,
    };
    const client = clientFor(target);
    const health = await client.health();
    const { sessions } = await client.listSessions();
    // Home comes from the env this invocation was given, not a bare homedir(),
    // so a test cannot write into the operator's real ~/.laun.
    const saved = saveTarget(target, homeFor(env));
    if (flagBool(flags, "json")) io.out(JSON.stringify({ ...target, saved, sessions: sessions.length }));
    else {
      io.out(`connected to ${targetUrl(target)} (${health.service})`);
      io.out(`sessions: ${sessions.length}`);
      io.out(`saved: ${saved}`);
    }
    return 0;
  }

  const target = requireTarget(env, io, split.target);
  const client = clientFor(target);

  if (sub === "new") {
    const parsed = parseArgs(rest, { boolean: ["json"], value: ["model"] });
    const goal = requiredArg(parsed.positionals, 0, "goal", 'laun agent new "<goal>"');
    const rec = await client.createSession(goal, flagString(parsed.flags, "model"));
    if (flagBool(parsed.flags, "json")) io.out(JSON.stringify(rec));
    else io.out(`🚀 ${rec.id} [${rec.status}] ${rec.model}`);
    return 0;
  }

  if (sub === "ls") {
    const { flags } = parseArgs(rest, { boolean: ["json"] });
    const { sessions } = await client.listSessions();
    if (flagBool(flags, "json")) io.out(JSON.stringify(sessions));
    else if (sessions.length === 0) io.out("no sessions yet — start one with: laun agent new \"<goal>\"");
    else for (const s of sessions) io.out(sessionLine(s));
    return 0;
  }

  if (sub === "status") {
    const parsed = parseArgs(rest, { boolean: ["json"] });
    const id = requiredArg(parsed.positionals, 0, "session id", "laun agent status <id>");
    const { session, pendingApprovals } = await client.getSession(id);
    if (flagBool(parsed.flags, "json")) io.out(JSON.stringify({ session, pendingApprovals }));
    else {
      io.out(sessionLine(session));
      for (const line of formatApprovals(pendingApprovals)) io.out(line);
    }
    return 0;
  }

  if (sub === "log") {
    const parsed = parseArgs(rest, { boolean: ["follow", "json"], value: ["since"] });
    const id = requiredArg(parsed.positionals, 0, "session id", "laun agent log <id> [--follow]");
    const since = flagString(parsed.flags, "since");
    const asJson = flagBool(parsed.flags, "json");
    const emit = createTranscript(io, asJson);
    if (flagBool(parsed.flags, "follow")) {
      // Follow from now unless the caller pinned an explicit cursor. Say so:
      // joining a quiet, tool-heavy job and seeing nothing reads as a hang.
      if (since === undefined && !asJson) {
        const head = await client.log(id, 0).catch(() => null);
        if (head) {
          io.out(`· following new events (${head.next} already recorded — run without --follow for history)`);
        }
      }
      await follow(client, id, {
        since: since === undefined ? 0 : Number(since),
        fromLatest: since === undefined,
        onEvent: emit,
      });
    } else {
      const log = await client.log(id, Number(since ?? 0));
      for (const e of log.events) emit(e);
    }
    return 0;
  }

  if (sub === "say") {
    const parsed = parseArgs(rest, { boolean: ["json"] });
    const id = requiredArg(parsed.positionals, 0, "session id", 'laun agent say <id> "<text>"');
    const text = requiredArg(parsed.positionals, 1, "text", 'laun agent say <id> "<text>"');
    const asJson = flagBool(parsed.flags, "json");
    try {
      const res = await client.sendMessage(id, text);
      if (asJson) io.out(JSON.stringify(res));
      else io.out(`↗️ sent to ${id}`);
    } catch (e) {
      if (e instanceof GatewayError && e.status === 409) {
        if (asJson) io.out(JSON.stringify({ sessionId: id, busy: true }));
        else io.out(`⏳ session ${id} is busy — try again shortly`);
        return 0;
      }
      throw e;
    }
    return 0;
  }

  if (sub === "stop") {
    const parsed = parseArgs(rest, { boolean: ["json"] });
    const id = requiredArg(parsed.positionals, 0, "session id", "laun agent stop <id>");
    try {
      const result = await client.abortSession(id);
      if (flagBool(parsed.flags, "json")) io.out(JSON.stringify({ sessionId: id, ...result }));
      else io.out(`🛑 stopped ${id}`);
    } catch (e) {
      if (e instanceof GatewayError && e.status === 404) {
        io.err(`no such session: ${id}`);
        return 1;
      }
      if (e instanceof GatewayError && e.status === 409) {
        io.err(`session ${id} is not running`);
        return 1;
      }
      throw e;
    }
    return 0;
  }

  if (sub === "continue") {
    const parsed = parseArgs(rest, { boolean: ["json"] });
    const id = requiredArg(parsed.positionals, 0, "session id", "laun agent continue <id>");
    const asJson = flagBool(parsed.flags, "json");
    const busyMessage = `⏳ session ${id} is already running — send input with: laun agent say ${id} "<text>"`;
    // A busy session must keep its single run; a second run would collide
    // with it, so refuse before sending anything.
    const { session } = await client.getSession(id);
    if (session.status === "running") {
      io.err(busyMessage);
      return 1;
    }
    try {
      await client.sendMessage(id, CONTINUE_PROMPT);
    } catch (e) {
      if (e instanceof GatewayError && e.status === 409) {
        io.err(busyMessage);
        return 1;
      }
      throw e;
    }
    // Watch the resumed run, skipping history (which usually already ends in
    // the terminal event of the run that died).
    const emit = createTranscript(io, asJson);
    await follow(client, id, { fromLatest: true, onEvent: emit });
    return 0;
  }

  if (sub === "watch") {
    const parsed = parseArgs(rest, { value: ["poll-ms", "timeout"] });
    const id = requiredArg(parsed.positionals, 0, "session id", "laun agent watch <id> [--poll-ms <ms>] [--timeout <dur>]");
    const pollRaw = flagString(parsed.flags, "poll-ms");
    const timeoutRaw = flagString(parsed.flags, "timeout");
    const pollMs = pollRaw === undefined ? 2000 : parseDurationMs(pollRaw);
    const maxMs = timeoutRaw === undefined ? 30 * 60 * 1000 : parseDurationMs(timeoutRaw);
    return await watchSession(client, id, io, { pollMs, maxMs });
  }

  if (sub === "approve" || sub === "deny") {
    const parsed = parseArgs(rest, { boolean: ["json"], value: ["note"] });
    const id = requiredArg(parsed.positionals, 0, "session id", `laun agent ${sub} <id> <requestId>`);
    const requestId = requiredArg(parsed.positionals, 1, "request id", `laun agent ${sub} <id> <requestId>`);
    const res = await client.decideApproval(id, requestId, sub, flagString(parsed.flags, "note"));
    if (flagBool(parsed.flags, "json")) io.out(JSON.stringify({ sessionId: id, requestId, decision: sub, ...res }));
    else io.out(`${sub === "approve" ? "✅ approved" : "⛔ denied"} ${requestId} (session ${id})`);
    return 0;
  }

  throw new UsageError(`unknown agent command "${sub ?? ""}"\n\n${HELP}`);
}

async function keysCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const split = splitTargetFlag(argv);
  const token = (env["GATEWAY_TOKEN"] ?? "").trim();
  if (!token) throw new UsageError("keys commands need the service secret: export GATEWAY_TOKEN=<token from .env>");
  const target = requireTarget(env, io, split.target);
  const client = clientFor(target, token);
  const [sub, ...rest] = split.argv;

  if (sub === "ls" || sub === undefined) {
    const { keys } = await client.listKeys();
    for (const k of keys) io.out(`${k.id}  ${k.createdAt}  ${k.label}`);
    return 0;
  }
  if (sub === "create") {
    const { flags } = parseArgs(rest, { value: ["label"] });
    const { key, record } = await client.createKey(flagString(flags, "label"));
    io.out(`agent key ${record.id} (${record.label}) — shown once:`);
    io.out(key);
    return 0;
  }
  if (sub === "revoke") {
    const parsed = parseArgs(rest);
    const id = requiredArg(parsed.positionals, 0, "key id", "laun keys revoke <id>");
    const { ok } = await client.revokeKey(id);
    io.out(ok ? `revoked ${id}` : `key ${id} not found`);
    return ok ? 0 : 1;
  }
  throw new UsageError(`unknown keys command "${sub}"\n\n${HELP}`);
}

async function doctorCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv, { value: ["target"] });
  if (positionals.length > 0) throw new UsageError("usage: laun doctor [--target <name>]");
  const name = flagString(flags, "target");
  const home = homeFor(env);
  let resolved: Target | null;
  if (name !== undefined) {
    resolved = loadNamedTarget(name, home);
    if (!resolved) {
      const known = listNamedTargets(home).map((t) => t.name);
      throw new UsageError(
        known.length > 0 ? `unknown target "${name}" — saved targets: ${known.join(", ")}` : `unknown target "${name}" — no saved targets yet`,
      );
    }
  } else {
    resolved = resolveTarget(env);
  }
  const fromEnv = name === undefined && Boolean((env["LAUN_HOST"] ?? "").trim() && (env["LAUN_KEY"] ?? "").trim());
  const savedPresent = loadTarget(home) !== null;
  const probe = async (): Promise<DoctorProbe> => {
    if (!resolved) return { version: CLI_VERSION, target: null, savedPresent, keyPresent: false, gateway: null };
    let gateway: DoctorGateway;
    try {
      const health = await withTimeout(new GatewayClient(targetUrl(resolved), resolved.key).health(), 8000);
      gateway = { ok: true, service: health.service };
    } catch (e) {
      // First line only, and never a secret: our gateway errors carry the
      // URL and the cause, never the key or token.
      gateway = { ok: false, error: (e as Error).message.split("\n")[0]!.slice(0, 300) };
    }
    return {
      version: CLI_VERSION,
      target: {
        url: targetUrl(resolved),
        source: name !== undefined ? `saved target "${name}"` : fromEnv ? "environment" : "saved file",
        keyId: resolved.keyId,
      },
      savedPresent,
      keyPresent: resolved.key.length > 0,
      gateway,
    };
  };
  return runDoctor(io, probe);
}

async function targetCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  const home = homeFor(env);

  if (sub === "ls" || sub === undefined) {
    const named = listNamedTargets(home);
    const def = loadTarget(home);
    if (named.length === 0 && !def) {
      io.out("no targets yet — save one with: laun target add <name> --host <ip> --key <key>");
      return 0;
    }
    // Keys never printed here: the id is enough to correlate with `keys ls`.
    if (def) io.out(`default  ${targetUrl(def)}${def.keyId ? `  ${def.keyId}` : ""}`);
    for (const { name, target } of named) io.out(`${name}  ${targetUrl(target)}${target.keyId ? `  ${target.keyId}` : ""}`);
    return 0;
  }

  if (sub === "add") {
    const parsed = parseArgs(rest, { value: ["host", "key", "port", "scheme"] });
    const name = requiredArg(parsed.positionals, 0, "target name", "laun target add <name> --host <host> --key <key> [--port <n>] [--scheme http|https]");
    if (!isValidTargetName(name)) throw new UsageError(`invalid target name "${name}" (use letters, numbers, - and _)`);
    const host = flagString(parsed.flags, "host");
    const key = flagString(parsed.flags, "key");
    if (!host || !key) throw new UsageError("usage: laun target add <name> --host <host> --key <key> [--port <n>] [--scheme http|https]");
    const portRaw = flagString(parsed.flags, "port");
    const port = portRaw === undefined ? 8080 : Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new UsageError(`invalid port "${portRaw}"`);
    const scheme = flagString(parsed.flags, "scheme");
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") throw new UsageError(`invalid scheme "${scheme}" (http or https)`);
    const target: Target = {
      host,
      port,
      scheme: scheme === "https" ? "https" : "http",
      key,
      keyId: parseAgentKey(key)?.id,
    };
    const saved = saveNamedTarget(name, target, home);
    io.out(`saved target "${name}" -> ${targetUrl(target)} (${saved})`);
    return 0;
  }

  throw new UsageError(`unknown target command "${sub}"\n\n${HELP}`);
}

/** Top-level shortcuts, each mapping onto the `agent` subcommand in brackets. */
const TOP_LEVEL_AGENT_ALIAS: Record<string, string> = {
  list: "ls",
  ls: "ls",
  status: "status",
  log: "log",
  run: "new",
  stop: "stop",
  approve: "approve",
  deny: "deny",
};

/** Entry point. Returns the process exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out(`laun ${CLI_VERSION}`);
    return 0;
  }
  try {
    if (command === "setup") return await setupCommand(rest, env, io);
    if (command === "agent") return await agentCommand(rest, env, io);
    if (command === "keys") return await keysCommand(rest, env, io);
    if (command === "doctor") return await doctorCommand(rest, env, io);
    if (command === "target") return await targetCommand(rest, env, io);
    const aliased = TOP_LEVEL_AGENT_ALIAS[command];
    if (aliased !== undefined) return await agentCommand([aliased, ...rest], env, io);
    throw new UsageError(`unknown command "${command}"\n\n${HELP}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    if (e instanceof GatewayError) {
      io.err(`gateway error: ${e.message}`);
      return 1;
    }
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}