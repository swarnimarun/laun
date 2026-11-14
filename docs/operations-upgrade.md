# Upgrades, rollback and format compatibility

The supported recovery path is an offline backup, a restore into a new data
directory and explicit reactivation. A binary/image rollback alone is not a
data rollback. Keep the previous installation stopped and retain its original
disks until the replacement has been qualified.

This document describes the current source implementation and release gates.
It does not claim that a published v2 release, arbitrary version downgrade or
production VPS certificate configuration has already been qualified.

## Supported compatibility boundary

| Component | Current contract | Behavior on a mismatch |
| --- | --- | --- |
| Human/control API | `/api/v2`, shared protocol DTOs | Authentication and owner checks remain mandatory; unsupported operations fail. |
| Worker capability document | `protocolVersion: 1`, `inferenceModes` including `controller`, `durabilityAdapters` including `pi-durable@1.5.2` version `1` | Yard SSH setup checks the source capability file and bounded `--capabilities` output before service startup. |
| Control SQLite metadata | Schema marker `1` | A future marker is rejected before schema/journal initialization. The marker alone does not promise downgrade compatibility for every additive feature. |
| Control backup | Manifest version `1`, scope `laun-v2-control`, schema `1` | Checksums, known schema/idempotency constraints and owner/reference bindings are checked before a new destination is published. |
| Thread archive | Manifest version `1`, runtime `pi-durable@1.5.2` | Unsupported runtime versions, invalid paths, checksums and limits are rejected. |
| Durable harness/model packages | Exact Pi Durable/AI family `1.5.2` | A package/storage change requires a separate compatibility exercise; old files are not renamed into a new format. |
| Central inference | Adapter `pi-ai@1.5.2`, envelope version `1` | The adapter rejects unknown versions and worker endpoint/auth/options. No local inference fallback occurs. |
| Server-owned Pi ledger | Adapter `pi-durable@1.5.2`, envelope version `1`, one snapshot followed by commits | Rebuild verifies hashes, fixed head and SDK sequences before scheduling. Unacknowledged commits remain interrupted. |
| OpenShell client/gateway | `0.1.8` exercised locally | Requalify the actual gateway, CLI, image and kernel together. Unknown CLI/API compatibility is not inferred from a health check. |
| Image JavaScript runtime | Bun `1.4.4`, multiarch base pinned by digest | Both image Dockerfiles use the same pinned base; CLI and source workflows remain Bun-only. |
| Host isolation | Non-root sandbox, hard Landlock requirement, supported seccomp supervision | Positive and negative runtime probes must pass. Current live evidence covers WSL2 Linux `6.6.87.2` with rootless Podman `5.8.9`. |

The v1 Pi coding-agent JSON/RPC transcript and Pi Durable JSONL storage are
different formats, despite both containing JSON. A v1 file is not a Durable
checkpoint. Language-neutral protocol/archive versions are separate from a
future Rust implementation choice.

## Record one deployment artifact set

Before changing a VPS, retain a private record of:

- The released controller/bridge image, sandbox image and CLI binary version,
  checksums/digests, source JJ/Git revision and `bun.lock` checksum.
- The compatibility versions above, worker capability output and every
  selected runtime/inference mode.
- Paths and references for controller model credentials, MCP secrets,
  OpenShell identities and the matching Telegram inbox key. Their values are
  outside control backups and must stay outside agent sessions.
- The last verified control backup, its manifest/digests, any workspace
  omissions and the old installation's stopped-state record.

`LAUN_SERVICE_IMAGE` accepts a complete service image reference, including
`repository@sha256:...`, for gateway/executor/bridge. If absent, the existing
`LAUN_IMAGE` repository plus `LAUN_TAG` remains the fallback.
`OPENSHELL_SANDBOX_IMAGE` also accepts a complete reference. Use matching,
tested artifacts; `latest` is a moving selector rather than a rollback record.
An immutable image reference is for pulling/running reviewed artifacts; build
a source image under its own local tag before recording its resulting digest.

The CLI build emits a machine-readable artifact manifest with binary/template
hashes, source-bundle identity and toolchain/worker/durability versions. Retain
it with the checksummed binary. A unified release manifest also binding the
published service/sandbox image digests, signed provenance and cross-version
migration certification remain release work; the static worker capability
file alone is not a substitute for them.

## Cold upgrade procedure

1. Stop new admission, then stop the controller, Telegram bridge, workers and
   their restarting supervisors. Verify that tracked sandbox processes have
   stopped. A revoked lease is not evidence that an unreachable host stopped.
   Reconcile interrupted tools, model charges and uncertain external sends.
2. Create the offline control backup described in
   [backup and recovery](operations-backup.md). Preserve the old deployment
   untouched. Separately protect external credential recovery and the bridge
   queue with its matching encryption key.
3. Select the candidate artifact set. Verify source/archive checksums, image
   references, capability output and compatibility versions. A worker with no
   controller-inference or server-ledger capability must not silently become a
   local-credential or checkpoint-only executor.
4. Restore the backup into a **new** directory with the candidate reader.
   Unsupported schemas/formats stop here. Restore fences unfinished runs,
   revokes restored credentials, stops threads and leaves uncertain deliveries
   inert; it does not autoplay old work.
5. Reprovision fresh controller/bridge credentials and explicit human-owner
   mappings. Enroll replacement yards and establish their OpenShell identities
   without copying controller provider keys to workers. Keep the old workers
   and bridge stopped. Review recovered policy revisions and connector URLs.
6. Run the candidate's source/type checks and packaged-artifact smoke in an
   isolated candidate environment. Confirm HTTP/UI authentication, central
   inference, one approved effect, one denied effect and model replanning.
   Exercise guest cancellation, fresh-placement checkpoint restore and the
   actual VPS certificate/engine boundary before unattended work.
7. Point the service configuration at the candidate data directory/artifacts.
   Explicitly select threads/tasks to resume or abandon. Admission after this
   point belongs to the new deployment; record that cutover in the operator
   recovery log.

This conservative procedure deliberately renews recovered authority. A rolling
upgrade that preserves live leases, approvals and bridge deliveries needs its
own tested migration/admission protocol. Do not run two controller versions
against one SQLite directory or two bridges against one delivery queue.

## Rollback cases

Before the candidate accepts new work, return to the previous artifact set and
a fresh restore of its matching pre-upgrade backup. Apply that reader's
compatibility checks, renew credentials, requalify the boundary and explicitly
reactivate selected work. Retaining the original stopped installation also
preserves forensic evidence without opening it under an incompatible writer.

After the candidate has accepted work, first stop it and preserve a new backup
with the candidate reader. Keep receipts for effects performed since cutover.
Restoring the older backup cannot undo a sent message, changed remote system
or charged model request. Reconcile those effects before any task replay.
Use a verified backward converter only when one exists for those exact
formats; otherwise retain the newer reader and import history into a fresh
supported deployment as inert records. Never edit version markers to persuade
an older binary to accept newer state.

The keys index, policy state, task queue, server Pi ledger and checkpoint
archive must come from the same offline backup. Mixing an old queue with
newer credentials or newer history can resurrect authority or duplicate
effects. Restored human keys are
revoked; `.env`/provider credentials must be rotated separately. Preserve the
stable owner mapping when issuing replacement human credentials.

## Legacy Pi history migration contract

Legacy import is an explicit offline history operation, separate from resuming
work. The current source importer archives exact version-3 files and creates
passive provenance/tree records plus owner-visible display history. It assigns
a fresh empty isolated profile, leaves the new thread stopped and admits no
run. It requires an explicit stable owner and offline confirmation. Retain
the original files with their original reader; never point the Durable
adapter at them or let a startup scan submit their last prompt.

Importing old history as model context is currently unavailable. A future
opt-in path must add explicit branch selection and preview binding; the
passive import does not turn old instructions or tool calls into context.

The installed Pi coding-agent `1.5.2` declares session format version `3` and
tree entries with `id`/`parentId`. Its pure projection helpers can explain
branches and compaction. Its parsers skip malformed lines, and its migration
helper mutates entries; they are not a strict migration validator. A writable
SessionManager may repair/migrate state, so it must not open the original.

A supported importer must:

1. Read only a bounded regular file while the original writer is stopped;
   reject symlinks, concurrent changes, malformed UTF-8/JSON, duplicate IDs,
   cycles, unsupported versions and unresolved required parent references.
   Preserve the exact original bytes, digest and source-format provenance in
   private archival storage. Never mutate the source.
2. Create a new owner-scoped destination under a fresh manual/isolated profile.
   Preserve all original branches as display data; selecting model context
   requires an explicit leaf/branch choice and a preview of omissions.
3. Treat old system messages, extension/custom state, tool calls, provider
   configuration and tool results as untrusted historical data. Do not load
   plugins/extensions, execute hooks, recreate task graphs, import permissions
   or assert that old external effects are known complete.
4. Write passive Durable entries through the adapter. Upstream supports
   `harness.root(context, {init})`/`conversation.commit()` with `tx.appendEntry()`;
   kind/data-only entries create history without model messages or submissions.
   If a human opts into model context, quote reviewed history as inert text
   under current Laun instructions. Do not copy old executable tool-call or
   system-message structures into a resumable task.
5. Verify that import makes zero provider/tool/connector calls, admits no run,
   preserves raw hashes and remains inert after process restart. A later fresh
   user message may start new work through ordinary current authorization.

Unsupported fields should be listed in an import report and retained in the
raw archive, rather than silently dropped or interpreted as authority. Lossy
context projection and missing artifact files must be visible to the operator.

## Qualification gates

Current evidence includes pinned full image builds, an authenticated container
HTTP/UI smoke, actual OpenShell denial/cancellation and 6 MiB fresh-guest
restore, authenticated central inference with real approve/deny/replan, and
whole-control restore with old-key rejection and preserved stable owners.
The real-provider relay used a test reviewer fixture for its exact approvals;
it did not claim a human manually clicked during the smoke.
See [runtime evidence](../packages/runtime/README.md),
[core status](core-status.md) and the committed recovery tests for exact limits.

A release still needs the exact candidate artifact set exercised against its
production engine/certificates, backward/forward compatibility fixtures for
each declared format transition, interrupted-upgrade recovery and an operator
rollback rehearsal. A successful backup or a source test suite alone cannot
certify a different release's storage reader.
