#!/usr/bin/env bun
import { UsageError, flagBool, flagString, parseArgs, requiredArg } from "./args.js";
import { renderEvent, follow, formatApprovals, sessionLine } from "./agent.js";
import { GatewayClient, GatewayError } from "./client.js";
import { authFilePath, resolveTarget, saveTarget, targetUrl, type Target } from "./config.js";
import { connectionBlock, localSetup, parseSshTarget, remoteSetup } from "./setup.js";

const HELP = `cloudbear — self-hosted remote agent control

  Setup
    cloudbear setup [--host <ip>] [--no-start] [--model <m>] [--env-file <path>]
        Prepare .env locally (gateway token + agent key) and start the stack.

    cloudbear setup ssh -i <identity> [--user <u>] [--port <n>] [--remote-dir <dir>]
        [--repo-url <url>] [--no-start] <host>
        Bootstrap a VPS over SSH and print its agent key.

  Connect
    cloudbear agent auth --host <host> --key <key> [--port <n>] [--scheme http|https]
        Verify the key and save it to ~/.cloudbear/auth.json (0600).

  Drive agents
    cloudbear agent new "<goal>" [--model <m>] [--json]
    cloudbear agent ls [--json]
    cloudbear agent status <id> [--json]
    cloudbear agent log <id> [--follow] [--since <n>] [--json]
    cloudbear agent say <id> <text>
    cloudbear agent approve <id> <requestId> [--note <t>]
    cloudbear agent deny <id> <requestId> [--note <t>]

  Keys (needs GATEWAY_TOKEN, the service secret)
    cloudbear keys ls
    cloudbear keys create [--label <l>]
    cloudbear keys revoke <id>

  Environment overrides: CLOUDBEAR_HOST, CLOUDBEAR_PORT, CLOUDBEAR_KEY
`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

function clientFor(target: Target, tokenOverride?: string): GatewayClient {
  return new GatewayClient(targetUrl(target), tokenOverride ?? target.key);
}

function requireTarget(env: NodeJS.ProcessEnv, io: Io): Target {
  const target = resolveTarget(env);
  if (!target) throw new UsageError(`not connected to a cloudbear yet — run: cloudbear agent auth --host <ip> --key <key>`);
  return target;
}

async function setupCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "ssh") {
    const { flags } = parseArgs(rest, {
      boolean: ["no-start", "json"],
      value: ["i", "identity", "user", "port", "remote-dir", "repo-url", "env-file"],
    });
    const rawHost = requiredArg(parseArgs(rest, { boolean: ["no-start"], value: ["i", "identity", "user", "port", "remote-dir", "repo-url", "env-file"] }).positionals, 0, "host", "cloudbear setup ssh -i <identity> [user@]host");
    const identity = flagString(flags, "i") ?? flagString(flags, "identity");
    if (!identity) throw new UsageError("setup ssh needs a private key: -i <identity>");
    const portRaw = flagString(flags, "port");
    const target = parseSshTarget(rawHost, flagString(flags, "user"));
    const result = await remoteSetup({
      identity,
      host: target.host,
      user: target.user,
      port: portRaw ? Number(portRaw) : undefined,
      remoteDir: flagString(flags, "remote-dir") ?? "/opt/cloudbear",
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

async function agentCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === "auth") {
    const { flags } = parseArgs(rest, { boolean: ["json"], value: ["host", "key", "port", "scheme"] });
    const host = flagString(flags, "host");
    const key = flagString(flags, "key");
    if (!host || !key) throw new UsageError("usage: cloudbear agent auth --host <host> --key <key> [--port <n>] [--scheme http|https]");
    const target: Target = {
      host,
      port: Number(flagString(flags, "port") ?? 8080),
      scheme: flagString(flags, "scheme") === "https" ? "https" : "http",
      key,
    };
    const client = clientFor(target);
    const health = await client.health();
    const { sessions } = await client.listSessions();
    const saved = saveTarget(target);
    if (flagBool(flags, "json")) io.out(JSON.stringify({ ...target, saved, sessions: sessions.length }));
    else {
      io.out(`connected to ${targetUrl(target)} (${health.service})`);
      io.out(`sessions: ${sessions.length}`);
      io.out(`saved: ${saved}`);
    }
    return 0;
  }

  const target = requireTarget(env, io);
  const client = clientFor(target);

  if (sub === "new") {
    const parsed = parseArgs(rest, { boolean: ["json"], value: ["model"] });
    const goal = requiredArg(parsed.positionals, 0, "goal", 'cloudbear agent new "<goal>"');
    const rec = await client.createSession(goal, flagString(parsed.flags, "model"));
    if (flagBool(parsed.flags, "json")) io.out(JSON.stringify(rec));
    else io.out(`🚀 ${rec.id} [${rec.status}] ${rec.model}`);
    return 0;
  }

  if (sub === "ls") {
    const { flags } = parseArgs(rest, { boolean: ["json"] });
    const { sessions } = await client.listSessions();
    if (flagBool(flags, "json")) io.out(JSON.stringify(sessions));
    else if (sessions.length === 0) io.out("no sessions yet — start one with: cloudbear agent new \"<goal>\"");
    else for (const s of sessions) io.out(sessionLine(s));
    return 0;
  }

  if (sub === "status") {
    const parsed = parseArgs(rest, { boolean: ["json"] });
    const id = requiredArg(parsed.positionals, 0, "session id", "cloudbear agent status <id>");
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
    const id = requiredArg(parsed.positionals, 0, "session id", "cloudbear agent log <id> [--follow]");
    const since = Number(flagString(parsed.flags, "since") ?? 0);
    const asJson = flagBool(parsed.flags, "json");
    const emit = (e: Parameters<typeof renderEvent>[0]) => {
      if (asJson) io.out(JSON.stringify(e));
      else for (const line of renderEvent(e)) io.out(line);
    };
    if (flagBool(parsed.flags, "follow")) {
      await follow(client, id, { since, onEvent: emit });
    } else {
      const log = await client.log(id, since);
      for (const e of log.events) emit(e);
    }
    return 0;
  }

  if (sub === "say") {
    const parsed = parseArgs(rest);
    const id = requiredArg(parsed.positionals, 0, "session id", 'cloudbear agent say <id> "<text>"');
    const text = requiredArg(parsed.positionals, 1, "text", 'cloudbear agent say <id> "<text>"');
    try {
      await client.sendMessage(id, text);
      io.out(`↗️ sent to ${id}`);
    } catch (e) {
      if (e instanceof GatewayError && e.status === 409) {
        io.out(`⏳ session ${id} is busy — try again shortly`);
        return 0;
      }
      throw e;
    }
    return 0;
  }

  if (sub === "approve" || sub === "deny") {
    const parsed = parseArgs(rest, { value: ["note"] });
    const id = requiredArg(parsed.positionals, 0, "session id", `cloudbear agent ${sub} <id> <requestId>`);
    const requestId = requiredArg(parsed.positionals, 1, "request id", `cloudbear agent ${sub} <id> <requestId>`);
    await client.decideApproval(id, requestId, sub, flagString(parsed.flags, "note"));
    io.out(`${sub === "approve" ? "✅ approved" : "⛔ denied"} ${requestId} (session ${id})`);
    return 0;
  }

  throw new UsageError(`unknown agent command "${sub ?? ""}"\n\n${HELP}`);
}

async function keysCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const token = (env["GATEWAY_TOKEN"] ?? "").trim();
  if (!token) throw new UsageError("keys commands need the service secret: export GATEWAY_TOKEN=<token from .env>");
  const target = requireTarget(env, io);
  const client = clientFor(target, token);
  const [sub, ...rest] = argv;

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
    const id = requiredArg(parsed.positionals, 0, "key id", "cloudbear keys revoke <id>");
    const { ok } = await client.revokeKey(id);
    io.out(ok ? `revoked ${id}` : `key ${id} not found`);
    return ok ? 0 : 1;
  }
  throw new UsageError(`unknown keys command "${sub}"\n\n${HELP}`);
}

/** Entry point. Returns the process exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out("cloudbear 0.1.0");
    return 0;
  }
  try {
    if (command === "setup") return await setupCommand(rest, env, io);
    if (command === "agent") return await agentCommand(rest, env, io);
    if (command === "keys") return await keysCommand(rest, env, io);
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