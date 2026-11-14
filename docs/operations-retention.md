# Removing a controller copy

Laun retains history until an owner explicitly removes it. Archiving stops admission but preserves the conversation. **Remove controller copy** is a separate destructive operation for an archived, stopped, settled leaf thread. It never schedules a model call, replays an old tool, or grants permissions.

The preview lists row counts, approximate serialized bytes, retained token/cost accounting, known yards/placement epochs and retained-copy warnings. The confirmation binds its SHA-256 digest. A changed event, approval, task, receipt, checkpoint, durable commit, inference admission or related connector delivery requires a new preview. Only a credential belonging to the owner can confirm; the installation administrator can inspect but must use an owner credential to perform removal.

Removal is refused while the thread has descendants; queued, running, permission-waiting or interrupted generations; an active worker lease; unresolved delegation; an active Gatekeeper discussion of the source; an admitted inference call; or a related pending, leased, sending or uncertain connector delivery. Reconcile outcomes first. A `confirmedStopped` flag does not make an unknown external outcome safe. The managed Gatekeeper conversation is retained and can be stopped to pause advice.

New Telegram outputs identify their source thread(s), or explicitly identify a static connector response. Settled typed output from surviving threads is preserved. Older untyped history cannot reliably be attributed after a route was switched or unlinked, so the preview lists **all owner-scoped untyped Telegram history**, with route/chat/topic and delivery counts where recorded. A separate explicit confirmation removes that listed untyped history, including unrelated settled delivery history; cancel if that broader removal is unwanted. New typed parent output remains. Any unresolved potentially affected delivery blocks removal. A route selected to a surviving thread keeps its base route, other subscriptions and permission handles; only the removed thread’s subscription and approval handles are revoked. A route currently selected to the removed thread is unselected with its subscription/button list, as described in the preview. These changes share the removal-fence transaction. Inbound update receipts remain to prevent an old Telegram update from creating work again.

## Durable state and retries

The first transaction writes a removal job, minimal resource/receipt/source-hash tombstones, family usage debit and pending host cleanup plans. It revokes controller producers before acknowledging the fence. Owners and installation administrators subsequently receive HTTP 410 for removed resources; another owner receives 404. Retries keep their original idempotency fingerprint and return 410 instead of recreating work or returning a success result pointing at a deleted run. The purge operation’s own request ID remains idempotent.

Following calls delete bounded batches. A restart or failed batch leaves the fence and acknowledged progress intact. Continue the same job explicitly; neither controller startup nor backup restore starts deletion. Thread events, run prompts/results, approvals, checkpoint archives, server durable ledger, raw legacy import, related structured advice, receipts and typed outbox references are removed from the controller’s live tables. Shared mowers and immutable profiles remain. Minimal IDs, hashes, row counts, lineage/usage debit and cleanup status remain; tombstones contain no title, prompt or result.

Purged child token usage still counts toward the surviving family budget, including after backup restore. A settled parent conversation or Gatekeeper discussion may retain quoted content from the child. Opaque Pi history in other threads is not rewritten.

Complete all controller batches before taking a backup: the backup reader rejects partial maintenance states. A completed backup includes tombstones, budget debit and host cleanup plans. Restore preserves removal fences and makes unfinished host cleanup plans blocked for fresh human review. Restoring an older backup can restore older logical history, but the normal restore rules keep old work stopped, permissions expired and credentials revoked.

## API module

The control package exports these runtime-neutral operations:

```ts
const preview = previewThreadPurge(store, principal, threadId);
let job = beginThreadPurge(store, principal, threadId, {
  requestId: crypto.randomUUID(),
  expectedDigest: preview.digest,
  confirmedStopped: true,
  confirmedControllerCopyOnly: true,
  // Set only after reviewing preview.legacyTelegramRoutes:
  // confirmedLegacyTelegramRouteCleanup: true,
});
// Each call performs one bounded transaction. A client may stop and resume.
job = continueThreadPurge(store, principal, job.id, { maxRows: 64 });
const current = inspectThreadPurge(store, principal, job.id);
const jobs = listThreadPurges(store, principal);
const remainingHosts = listHostCleanupPlans(store, principal, job.id);
```

The supported online preview is bounded to 100,000 selected rows. A larger plan is refused without deleting anything; a larger offline removal implementation is not provided yet. Batches accept 1–256 rows and stop around 56 MiB of serialized rows, with one supported maximum-size checkpoint allowed as a single row. Each batch requires 192 MiB free space for SQLite/WAL overhead; this is admission headroom, not a disk quota. Free space elsewhere or expand the volume if the reserve is already exhausted. SQLite failures roll back the current batch; they do not undo earlier acknowledged batches.

## Remaining host and external copies

`done` means the controller’s live logical copy is removed. It does not mean every physical copy is erased. Host cleanup plans remain pending until a separate explicit cleanup verifies the relevant worker, thread labels, placement epochs and stopped sandbox boundary. Offline or unknown yards remain outstanding. No host deletion runs solely because a controller job is complete.

Each host plan needs a second owner review: `previewHostCleanupPlan` returns its exact digest and scope warnings; `approveHostCleanupPlan` requires that digest, `confirmedStopped: true` and `confirmedDeleteHostCopies: true`. An installation administrator must use an owner credential to approve deletion. Approval expires after ten minutes. Merely listing a pending plan, completing controller removal or reconnecting a worker never approves host deletion.

The trusted dispatcher claims an approved plan for its assigned worker only. The returned command contains the plan ID, thread ID, placement UUIDs, generation and lease expiration; it contains no filesystem paths. Leases last thirty seconds by default and require heartbeats. A draining yard accepts no new cleanup claim, while an existing lease may finish. Remote yards need a recent authenticated heartbeat. Expired or withdrawn approval, an expired lease, worker revocation/credential rotation, or restore blocks the attempt and clears its authority. Fresh review is required after an unknown outcome; startup does not reissue deletion automatically.

Only the trusted runtime/worker verifier may finish a lease. A completed plan requires `verified: true` and no outstanding items. Failed root/guest verification, unsupported execution boundaries, unverified labels, unreadable copies or partial/unknown outcomes remain blocked with a report. Exact repeated terminal results are idempotent; a changed result or stale generation is refused. Worker transports must abort further cleanup steps when their controller lease cannot be renewed. An already started recursive filesystem deletion cannot be undone, which is why unknown outcomes require host inspection rather than automatic retries.

The runtime’s cleanup root is immutable installation configuration, not a request parameter. It verifies private supervisor-owned trees and stopped full-identity OpenShell guests; unknown or unsafe copies are preserved. The worker also owns its separate event/outcome journal and must verify that copy before acknowledging host cleanup. A worker credential identifies one configured yard: copying it, changing roots/workspaces or moving storage can leave additional physical copies that require separate operator review. Service logs and filesystem snapshots remain separate copies.

The source legacy JSONL/index/events, bridge’s separately encrypted inbox, already delivered Telegram messages, exports, old backups, parent quotations, unmanaged directories, and unknown host copies remain outside controller removal. Shared mower names/instructions and permission profiles are separate retained objects. Filesystem journals, SSD wear leveling and snapshots also prevent a physical erasure guarantee.

## Database space

Logical removal and disk reclamation have separate outcomes. New control databases enable incremental auto-vacuum before creating tables. Existing databases retain their prior setting; startup never runs a live migration with `VACUUM`. After a completed job, Laun attempts a nonblocking passive checkpoint and at most 128 incremental-vacuum pages. Busy or failed maintenance leaves logical removal committed with reclamation pending. Free pages may be reused even when the database file does not shrink.

SQLite documents that a positive incremental-vacuum page count bounds the operation; omitted/zero counts can clear the entire freelist. A passive WAL checkpoint avoids waiting for readers/writers; truncating checkpoints can remain busy. `journal_size_limit` controls retained/reset journal size, not a hard live WAL ceiling. See [SQLite incremental vacuum](https://www.sqlite.org/pragma.html#pragma_incremental_vacuum) and [WAL checkpoint](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).

For an older non-incremental database, stop the controller, workers and bridge, verify a private backup, check that sufficient temporary disk space exists, and use SQLite’s offline `VACUUM INTO` workflow to a new file under administrator control. Validate integrity and the supported schema before replacing the original. No bundled automatic physical-compaction command is provided; do not unlink an active WAL file or claim a failed checkpoint reversed logical removal.
