import type {
  ControlBackupManifest,
  ControlRestoreResult,
} from "@laun/protocol";
import {
  flagBool,
  flagString,
  parseArgs,
  requiredArg,
  UsageError,
} from "./args.js";

/** Offline/local only: no gateway key, remote side effects or automatic service stop. */
export async function backupCommand(
  argv: string[],
  io: { out(line: string): void },
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "create" && sub !== "restore")
    throw new UsageError(
      "usage: laun backup create --data-dir <dir> --out <new-dir> --confirmed-offline | restore <backup-dir> --to <new-dir> --confirmed-offline",
    );
  const parsed = parseArgs(rest, {
    boolean: ["json", "confirmed-offline"],
    value: sub === "create" ? ["data-dir", "out"] : ["to"],
  });
  if (!flagBool(parsed.flags, "confirmed-offline"))
    throw new UsageError(
      "Stop the controller, bridge and every worker before passing --confirmed-offline. This command never stops them for you.",
    );
  if (parsed.positionals.length > (sub === "restore" ? 1 : 0))
    throw new UsageError("unexpected backup arguments");
  const api = await import("@laun/control");
  if (sub === "create") {
    const dataDir = flagString(parsed.flags, "data-dir"),
      destination = flagString(parsed.flags, "out");
    if (!dataDir || !destination)
      throw new UsageError(
        "backup create requires --data-dir <stopped-controller-dir> --out <new-backup-dir>",
      );
    const result: ControlBackupManifest = await api.createControlBackup({
      dataDir,
      destination,
      confirmOffline: true,
    });
    io.out(
      flagBool(parsed.flags, "json")
        ? JSON.stringify(result)
        : `Control backup created at ${destination}; ${result.files.length} verified files. Provider credential files, installation environment files, live guest volumes and uncheckpointed worker state are outside this archive.`,
    );
  } else {
    const backupDir = requiredArg(
        parsed.positionals,
        0,
        "backup directory",
        "laun backup restore <backup-dir> --to <new-dir> --confirmed-offline",
      ),
      targetDir = flagString(parsed.flags, "to");
    if (!targetDir)
      throw new UsageError("backup restore requires --to <new-controller-dir>");
    const result: ControlRestoreResult = await api.restoreControlBackup({
      backupDir,
      targetDir,
      confirmOffline: true,
    });
    io.out(
      flagBool(parsed.flags, "json")
        ? JSON.stringify(result)
        : `Control restored inertly to ${result.targetDir}. Mint replacement credentials for preserved principals, re-enroll yards, reconcile interrupted work and uncertain deliveries before resuming.`,
    );
  }
  return 0;
}
