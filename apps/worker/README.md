# Outbound yard worker

Enroll a named yard in the Laun app. Its returned credential is unique to that
yard and stored hashed on the controller. Start a worker on the target system:

```sh
LAUN_CONTROLLER_URL=https://your-control-server.example \
LAUN_WORKER_KEY=yard_... \
OPENSHELL_ENABLED=true \
OPENSHELL_SANDBOX_IMAGE=your-pinned-agent-image \
bun apps/worker/src/index.ts
```

The target system needs pinned Bun and a provisioned OpenShell gateway/identity
for isolated mode. Default `LAUN_INFERENCE_MODE=controller` uses the fenced
controller inference relay; provider credentials stay on the controller.
Explicit `LAUN_INFERENCE_MODE=local` requires an operator-provisioned
`PI_AUTH_FILE` outside `LAUN_WORKER_DIR` and all agent environments. The worker
connects outbound; it opens no
HTTP listener. Use an SSH tunnel and a loopback controller URL when public TLS
is unavailable. Remote plaintext URLs and redirects are rejected.

For explicit trusted local development:

```sh
LAUN_CONTROLLER_URL=http://127.0.0.1:8080 \
LAUN_WORKER_KEY=yard_... LAUN_TRUSTED_LOCAL=true \
bun apps/worker/src/index.ts
```

`LAUN_WORKER_DIR` defaults to `./data/worker`; its per-thread Pi session files,
workspaces and per-generation event journals must persist across restart.
`LAUN_WORKER_CAPACITY` (1–16) is a local ceiling; the controller also enforces
enrolled yard capacity. Each data directory has an exclusive process lock.
Use a distinct enrolled credential and directory per yard, never reuse one
credential concurrently on different machines.

Every privileged tool request is centrally authorized against the active run
lease. Heartbeats detect cancellation, revocation and controller failure. A
transport failure cancels execution and records an interrupted outcome; it
never silently continues with cached permissions. Events are synchronized to a
private durable outbox before transmission and retried under the same
run/generation/sequence identity, so losing an acknowledgement does not create
a duplicate transcript event.

A process restart with an in-progress journal does not replay its prompt. The
controller marks it interrupted and requires the operator to verify old work
has stopped before resuming under a new generation. A final local outcome
whose acknowledgement is lost remains in the journal; stale leases cannot
change reassigned controller state. Deadlines cannot prove that a previously
admitted external mutation was rolled back. Inspect and reconcile such effects.
After a positive finish acknowledgement, the worker validates the exact server
run/thread/yard/generation and terminal status, fsyncs a local acknowledgement
marker, then may remove that redundant delivery journal. A server cancellation
is valid even when the local outcome was done. Controller conversation events,
central Pi commits, checkpoints and workspaces are retained. Lost or malformed
finish acknowledgements, running/fenced/interrupted work, pending events and
reason-bearing uncertain records are never compacted automatically.

Startup maintenance streams at most128 directory entries and8MiB per tick,
retaining its cursor before accepting new runs. This can recover a supported
older inventory beyond the4096-file/32MiB recovery cap without loading it all
into memory. The supported older writer persisted `phase: reported` only after
a positive controller response; migration additionally requires a terminal
outcome, empty event outbox and absent reason. This is an audited older-writer
contract, never an inference from server absence. Unknown schemas, unsafe
permissions/owners, symlinks, hardlinks, FIFOs and corrupt files are preserved
for inspection. Removal rechecks inode/content timestamps, cancellation and the
private directory boundary, then fsyncs the directory. Outstanding unknown work
can still reach the recovery limit and requires explicit reconciliation.
Graceful worker shutdown also records active attempts as interrupted before
aborting execution. Later queued input remains blocked until explicit
reconciliation; an operator-requested cancellation through the API retains its
separate cancelled outcome.

Current remote conversations remain pinned until an explicit reviewed yard move.
Every Pi commit awaits the controller's durable SQLite acknowledgement before
new model/tool scheduling and progress exposure. Complete checkpoints preserve
workspace artifacts; reviewed moves validate exact checkpoint hashes and create
a fresh placement epoch. Copying a worker key does not migrate state. Keep the
controller backup and artifact/checkpoint scope in mind when recovering a host;
uncheckpointed workspace effects still require reconciliation.

Yards can drain without cancelling existing work. Worker-key rotation preserves
the stable yard ID while invalidating the old key and fencing active execution
and host-cleanup leases. The replacement remains offline/drained until an
authenticated reconnect advertises current capabilities and an operator resumes
dispatch. Replace the private service configuration deliberately; SSH setup
refuses differing existing configuration rather than rotating it implicitly.

Host cleanup requires a separate owner-reviewed controller plan after logical
controller-copy removal finishes. A worker with `runtime.cleanupThread` polls
these plans only while idle. It checks the authenticated lease before effects,
renews it through cleanup/reporting, and aborts on withdrawal, expiry, key loss,
transport failure or shutdown. Unknown outcomes are not executed again
automatically; they require fresh review. The controller receives exact
generation-bound verification results, never user-supplied deletion paths.

After verified runtime cleanup, the worker prunes matching thread copies from
its event journals. It verifies a real private owned directory and bounded
regular files, uses typed thread identity, and preserves unrelated journals.
Unknown, unreadable, corrupt, symlinked, shared, oversized or active-writer files
remain outstanding and prevent a verified-complete result. Malformed startup
journals block new execution while still allowing separately approved cleanup.
Known host cleanup does not erase quoted parent content, backups, exports,
external messages or unknown copies.

`--once` polls once and exits after any accepted run settles. `--help` prints
setup requirements without reading credentials. Tests use a real local control
server and verify central allow/deny, durable event deduplication and restart
reconciliation, plus explicit cleanup authority, withdrawal/key/network loss,
shutdown, lost-result acknowledgement and conservative journal pruning. These
worker transport checks use disposable adapters/files; live production VPS
cleanup qualification remains separate.
