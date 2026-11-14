import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ControlState, GatewayMe, WorkerRecord } from "@laun/protocol";
import {
  flagBool,
  flagString,
  parseArgs,
  requiredArg,
  UsageError,
} from "./args.js";
import { parseDurationMs } from "./agent.js";
import { GatewayClient } from "./client.js";
import { readInput } from "./control.js";
import { parseSshTarget, repoRoot } from "./setup.js";
import {
  planYardSetup,
  runRemoteYardSetup,
  type YardSetupOptions,
} from "./yard-setup.js";
import { createYardSourceArchive } from "./yard-source.js";
import type { CommandRunner } from "./ssh.js";

interface YardIo {
  out(line: string): void;
  err(line: string): void;
}
/** Explicit installation boundary. The default runner performs SSH; tests inject it. */
export async function yardSetupCommand(
  argv: string[],
  client: GatewayClient,
  io: YardIo,
  options: { runner?: CommandRunner; sourceRoot?: string } = {},
): Promise<number> {
  const [kind, ...rest] = argv;
  if (kind !== "ssh")
    throw new UsageError(
      "usage: laun yard setup ssh <host> -i <identity> --controller-url <https-origin> --config <json>",
    );
  const parsed = parseArgs(rest, {
    boolean: ["json", "no-start"],
    value: [
      "i",
      "identity",
      "user",
      "port",
      "remote-dir",
      "name",
      "controller-url",
      "config",
      "source-dir",
      "repo-url",
      "revision",
      "bun-path",
      "service-user",
      "inference",
      "capacity",
      "timeout",
    ],
  });
  if (parsed.positionals.length > 1)
    throw new UsageError("yard setup accepts one SSH host");
  const host = requiredArg(
    parsed.positionals,
    0,
    "host",
    "laun yard setup ssh <host> -i <identity> --controller-url <https-origin> --config <json>",
  );
  const flags = parsed.flags,
    identity = flagString(flags, "i") ?? flagString(flags, "identity");
  if (!identity)
    throw new UsageError("yard setup needs an SSH identity: -i <path>");
  const controller = flagString(flags, "controller-url");
  if (!controller)
    throw new UsageError(
      "--controller-url is required: supply an HTTPS origin reachable from the remote yard, not an implicit local CLI target",
    );
  const inference = flagString(flags, "inference") ?? "controller";
  if (inference !== "controller" && inference !== "local")
    throw new UsageError("inference must be controller or local");
  const config = await readInput(flagString(flags, "config"));
  if (Object.values(config).some((value) => typeof value !== "string"))
    throw new UsageError(
      "yard configuration values must be remote-path/configuration strings",
    );
  const capacity = Number(flagString(flags, "capacity") ?? 1);
  const ssh = parseSshTarget(host, flagString(flags, "user"));
  const port =
    flagString(flags, "port") === undefined
      ? undefined
      : Number(flagString(flags, "port"));
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new UsageError("invalid SSH port");
  const source =
    flagString(flags, "source-dir") ?? options.sourceRoot ?? repoRoot();
  let repository = flagString(flags, "repo-url"),
    revision = flagString(flags, "revision");
  if ((repository === undefined) !== (revision === undefined))
    throw new UsageError("--repo-url and --revision must be supplied together");
  if (repository && flagString(flags, "source-dir"))
    throw new UsageError(
      "choose --source-dir or an explicit --repo-url/--revision",
    );
  if (
    !repository &&
    !flagString(flags, "source-dir") &&
    !existsSync(join(source, "apps/worker/src/index.ts"))
  ) {
    const published = process.env.LAUN_SOURCE_REVISION;
    if (!published || !/^[0-9a-f]{40}$/.test(published))
      throw new UsageError(
        "This portable development binary has no published source revision. Supply --source-dir <checkout> to transfer current JJ work, or explicit --repo-url and --revision.",
      );
    repository =
      process.env.LAUN_SOURCE_REPOSITORY ??
      "https://github.com/swarnimarun/laun.git";
    revision = published;
  }
  const archive = repository
    ? undefined
    : await createYardSourceArchive(source);
  const base: Omit<YardSetupOptions, "workerId" | "workerKey"> = {
    identity,
    host: ssh.host,
    user: ssh.user,
    port,
    controllerUrl: controller,
    remoteDir: flagString(flags, "remote-dir") ?? "/opt/laun/yards/preflight",
    repoUrl: repository,
    revision,
    sourceArchive: archive,
    inference,
    config: config as Record<string, string>,
    bunPath: flagString(flags, "bun-path"),
    serviceUser: flagString(flags, "service-user"),
    capacity,
    noStart: flagBool(flags, "no-start"),
    runner: options.runner,
  };
  planYardSetup({
    ...base,
    workerId: "00000000-0000-0000-0000-000000000000",
    workerKey: "yard_00000000-0000-0000-0000-000000000000_" + "x".repeat(32),
  });
  await client.control<GatewayMe>("/me");
  const initial = await client.control<ControlState>("/state");
  if (initial.readiness.storage?.acceptingWork === false)
    throw new UsageError(
      "Controller storage admission is closed. Restore the free-space reserve before enrolling a new execution yard.",
    );
  if (inference === "controller" && initial.readiness.inferenceRelay !== true)
    throw new UsageError(
      "This controller does not advertise the fenced inference relay. Upgrade/enable it, or explicitly choose --inference local with operator-provisioned remote credentials; no local fallback is selected automatically.",
    );
  if (initial.readiness.durableJournal !== true)
    throw new UsageError(
      "This controller does not advertise the central durable journal. Upgrade it before installing a new yard; no checkpoint-only fallback is selected.",
    );
  const duration = parseDurationMs(flagString(flags, "timeout") ?? "2m");
  const created = await client.control<{ worker: WorkerRecord; key: string }>(
    "/workers",
    {
      method: "POST",
      body: {
        name: flagString(flags, "name") ?? ssh.host,
        capacity,
        labels: ["ssh-installed", inference],
      },
    },
  );
  const directory =
    flagString(flags, "remote-dir") ??
    join("/opt/laun/yards", created.worker.id);
  try {
    const installed = await runRemoteYardSetup({
      ...base,
      remoteDir: directory,
      workerId: created.worker.id,
      workerKey: created.key,
    });
    if (!base.noStart) {
      const deadline = Date.now() + duration;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(
            "Yard service was installed but no authenticated heartbeat arrived before the timeout",
          );
        const state = await client.control<ControlState>("/state", {
          timeoutMs: Math.min(20_000, Math.ceil(remaining)),
        });
        const worker = state.workers.find(
          (value) => value.id === created.worker.id,
        );
        if (
          worker?.status === "online" &&
          worker.inferenceMode === inference &&
          worker.durabilityAdapter?.adapter === "pi-durable@1.5.2" &&
          worker.durabilityAdapter.version === 1 &&
          worker.checkpointVersion === "pi-durable@1.5.2" &&
          worker.lastSeenAt &&
          Date.now() - Date.parse(worker.lastSeenAt) < 45_000
        )
          break;
        await Bun.sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
      }
    }
    const result = {
      workerId: created.worker.id,
      service: installed.service,
      directory: installed.directory,
      inference,
      sourceManifest: archive?.manifest,
      started: !base.noStart,
      heartbeat: !base.noStart,
      qualification:
        "Inference, OpenShell execution and external tools have not been probed by installation.",
    };
    io.out(
      flagBool(flags, "json")
        ? JSON.stringify(result)
        : `Yard ${created.worker.id} installed (${installed.service}); ${base.noStart ? "not started; readiness unqualified" : "authenticated heartbeat received"}. ${result.qualification}`,
    );
    return 0;
  } catch (error) {
    try {
      await client.control(`/workers/${created.worker.id}/revoke`, {
        method: "POST",
        body: {},
      });
    } catch {
      io.err(
        `Automatic revocation failed. Revoke yard ${created.worker.id} from the controller before retrying.`,
      );
    }
    throw new Error(
      `${(error as Error).message.replaceAll(created.key, "[redacted worker key]")} Newly enrolled yard ${created.worker.id} was revoked when possible; private remote files remain for inspection.`,
    );
  }
}
