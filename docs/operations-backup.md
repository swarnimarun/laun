# Control-plane backup and recovery

Laun's v2 backup contains a consistent SQLite snapshot and the human key index. It preserves mowers, threads, events, permission profile revisions, task queues, server checkpoint archives, connector configuration and delivery records. Connector credentials remain references such as `MCP_EXAMPLE_TOKEN`; their values are not exported from the controller environment.

This is a control-plane backup, not a whole VPS image. It does not copy `.env`, provider authentication, TLS/private keys, OpenShell configuration or images, live sandbox files, worker journals, or Telegram's separate encrypted admission queue. A server checkpoint contains the latest captured Pi session and workspace for that thread, with any omitted generated files recorded in the checkpoint. Uncheckpointed changes on a live or lost worker are outside this archive. Transcripts and checkpoint files are private user data and can contain values a user or agent wrote into them; protect the entire backup accordingly.

## Create a backup

Stop the gateway/controller, Telegram bridge, remote workers and any supervisors that would restart them. Confirm that runtimes and sandbox processes have stopped. `confirmOffline` is an operator acknowledgement, not a process detector. SQLite is copied with a parameterized `VACUUM INTO` snapshot; the stopped services also keep the separate key index consistent with that snapshot.

Run from the repository with Bun, choosing an existing source directory and a **new** backup path:

```sh
bun --eval 'import { createControlBackup } from "./packages/control/src/backup.ts";
const manifest = await createControlBackup({
  dataDir: "/srv/laun/data",
  destination: "/srv/laun-backups/control-2026-11-14",
  confirmOffline: true
});
console.log(JSON.stringify(manifest, null, 2));'
```

The destination must not already exist, including an empty directory. Its parent must exist and resolve without symlinks. The backup creates a private `0700` directory containing `control.sqlite`, `keys.json`, and `manifest.json`, each `0600`. The manifest specifies format/schema versions, byte counts, and SHA-256 digests calculated in bounded chunks. The key index contains password-equivalent hashes and stable owner mappings, so it must remain private even though plaintext keys are absent. If the installation has never created a human key index, the archive includes an empty index.

Copy the finished directory to protected storage and verify the copy with a trial restore. Keep a separate protected record of deployment configuration and external credential recovery procedures. Never put those credentials inside a Laun thread to make them part of a backup.

## Restore into a new location

Keep the old installation stopped and retain its disks unchanged. Do not point two controllers or bridge processes at the same work. Choose a **new** destination with an existing real parent directory:

```sh
bun --eval 'import { restoreControlBackup } from "./packages/control/src/backup.ts";
const result = await restoreControlBackup({
  backupDir: "/srv/laun-backups/control-2026-11-14",
  targetDir: "/srv/laun/restored-data",
  confirmOffline: true
});
console.log(JSON.stringify(result, null, 2));'
```

Restore verifies every listed checksum, SQLite integrity, the supported schema, idempotency constraints and essential owner/reference bindings before publishing the new directory. Unexpected files, unsupported schemas, malformed keys and symlink inputs fail closed. Failure preserves the backup and any pre-existing destination. A successful target also contains `restore.json` with the source manifest, owner inventory and recovery counts.

Restored execution is intentionally paused:

- Every queued, running, waiting or previously interrupted run becomes interrupted, with its lease fenced and cancellation requested. Even work queued at backup time might have executed later on the original system.
- In-flight model inference admissions become interrupted. Completed admission IDs remain receipts, not requests to replay; the controller does not retry an uncertain provider call from a restored backup.
- All threads are stopped. Active approvals expire, worker credentials are removed, workers are revoked, and unfinished tasks are cancelled.
- Pending or sending external deliveries become uncertain; internal task deliveries are cancelled. A prior send may already have reached its destination. Inspect receipts before requesting any explicit retry.
- Telegram links, routes, subscriptions, link codes and approval buttons are removed. Users must link again. This prevents a backup from resurrecting an identity link revoked after it was captured.
- All restored human keys are revoked while their stable owner mappings remain. Old bootstrap credentials cannot reactivate those revoked IDs.

Generate a fresh `GATEWAY_TOKEN` and `LAUN_TELEGRAM_BRIDGE_TOKEN`; rotate the Telegram bot token and provider/API credentials through their original protected channels. Revoking restored human keys does **not** revoke credentials held in `.env`, provider accounts, or external services. Reprovision model authentication, MCP secret values, the OpenShell boundary and network/TLS configuration separately. Keep the matching `BRIDGE_INBOX_KEY` available if recovering its encrypted queue; changing a token from which an older queue key was derived can otherwise make that queue unreadable.

Bring up the controller with the restored data path. Use the new installation administrator credential to mint a fresh human key bound to the relevant `principalId` listed in the restore result; a fresh credential without that field creates a separate account. Review restored profile revisions and connector destinations before enabling work, because their policy state reflects the backup date.

Enroll new worker credentials and explicitly choose placement. Before resuming an interrupted attempt, verify that the original runtime cannot still act and reconcile any external outcome. Use the normal confirmed-stop recovery flow; restoration does not automatically replay a prompt or move a live thread between hosts. Checkpoints can restore captured session/workspace state, not undo external effects or recover uncheckpointed writes.

## Telegram admission queue and worker state

The bridge queue is a separate encrypted SQLite store in `BRIDGE_DATA_DIR` / the compose `laun-bridge-data` volume. Back it up offline using a consistent SQLite snapshot and preserve the **matching stable `BRIDGE_INBOX_KEY` in separate protected secret storage**. The controller backup does not include that queue or key. After a rollback, inspect outstanding bridge admissions and their old controller receipts before restarting polling; do not blindly replay queued updates from a newer bridge against an older controller. If the matching key is lost, the pending queue cannot be decrypted.

Worker journals and active sandbox state are also separate. Preserve them offline when investigating an interrupted attempt; do not restore or start an old worker journal against a new installation credential without reconciling the prior generation and external effects.

## Key-store storage failures

Human key updates sync the temporary file, rename it, then sync the parent directory. A failure before rename leaves the prior credentials active. A failure after rename makes the durable outcome uncertain: the live key store disables human verification and all key operations return unavailable until the controller is restarted and its persisted state inspected. The installation service credential remains available for recovery. Check the stored revocation and owner mappings before resuming normal access.
