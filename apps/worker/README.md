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

The target system needs Bun, the configured Pi model credentials, and a
provisioned OpenShell gateway/identity for isolated mode. Keep provider
credentials outside LAUN_WORKER_DIR. The worker connects outbound; it opens no
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

Current remote conversations are pinned to the yard that owns their Pi files.
Controller transcripts/metadata are durable, but moving execution to another
host requires verified checkpoint transfer; copying a yard credential does not
migrate conversation state. Back up both controller and yard data. Whole-host
loss and artifact export require the checkpoint/archive workflow in the main
design before failover can be claimed.

`--once` polls once and exits after any accepted run settles. `--help` prints
setup requirements without reading credentials. Tests use a real local control
server and verify central allow/deny, durable event deduplication and restart
reconciliation.
