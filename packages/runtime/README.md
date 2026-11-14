# Laun Pi Durable adapter

This package implements the runtime-neutral `AgentRuntime` contract from
`@laun/protocol`, using the exact-pinned upstream Pi Durable 1.5.2 API. The
control service supplies one server-owned `sessionDir` and `workspaceRoot` per
thread; a run's stable `runId` becomes the upstream submission request ID.
Gateway/connector code does not import Pi types.

`listModels()` returns cached runtime-neutral metadata with full
`provider/model-id` IDs and provider configuration status, never credential
values. The current built-in catalog works with a separately configured
Vercel AI Gateway credential; custom provider catalogs remain an injectable
adapter seam. A real local smoke on 2026-11-14 using
`vercel-ai-gateway/openai/gpt-4.1-nano` returned `LAUN_REAL_RUNTIME_OK`
through the complete Durable adapter (619 reported tokens). Its tools were
all denied and its run was bounded to two turns/60 seconds.

Only Laun's reviewed tool registry is installed. Repository extensions,
project MCP configuration, package hooks and arbitrary executable plugins are
not loaded into the controller. Native model access runs in the trusted
controller, using provider environment variables or a separately configured
credential file. Credential refresh is serialized and atomically persisted;
that file must remain outside thread state/workspaces. Do not open the same
credential file concurrently with another credential-writing application.

The mediated file and command tools call the server's authorization callback
before effects. Workspace-relative file operations reject traversal and
escaping symlinks, bound file/output sizes and carry cancellation signals.
Broker tools delegate authorization and stable idempotency to the central
service; their request IDs include the run and upstream call ID. Writes,
commands and mutating broker calls use upstream's unsafe replay policy. A
crash produces an interrupted tool result rather than automatically repeating
an uncertain external action. Read-only tools may be replayed.

Execution modes are explicit:

- `trustedLocal: true` enables local developer tools. File tools are scoped;
  an approved shell command retains the host user's OS authority. Its minimal
  environment excludes model/control credentials. This is not OS isolation.
- `openshellEnabled: true` requires an OpenShell execution backend and image.
  Each thread gets a persistent sandbox, manual policy escalation, an empty
  command environment and a hard-enforced workspace filesystem boundary.
  Default generated policy denies all network egress. Before model dispatch,
  a positive workspace-write probe and negative world-writable `/var/tmp`
  probe must pass, and root execution is rejected. Any failure remains an
  error; host execution is never a fallback. Closing stops and preserves the
  sandbox. Explicit artifact export/retention owns deletion.
- Neither mode selected refuses execution. `faux/faux-1` exists only with an
  explicit demo option or injected test models; real model failures never
  become demonstration answers.

Pi state uses the upstream fsync JSONL backend. A guarded single writer opens
it for each run, with a private per-thread request fingerprint index preventing
changed payload reuse. Control SQLite state, thread ACLs, run ownership and
permission grants are handled by the control service rather than the Pi
transcript. `close()` cancels active work; process/command cancellation and
permission waits share an abort signal.

Remote workers use `RuntimeCallbacks.durability` to make the controller's
fenced SQLite ledger authoritative for Pi state during a run. The adapter
collects the JSONL backend's accepted batch receipts, appends the opaque
versioned commit envelope to the controller, and releases receipts only after
the exact sequence is acknowledged. Every storage query is serialized behind
that barrier. Model and tool tasks cannot start from unacknowledged state;
streamed progress is explicitly flushed through an ordinary transaction
before it is exposed, including Pi's otherwise deferred live updates. A lost,
rejected or ambiguous acknowledgment poisons the writer and returns
`interrupted`; the adapter never retries an uncertain append automatically.

Before opening the harness, a worker rebuilds a fresh staged Pi directory from
fixed-head ledger pages, verifies sequence/request hashes and upstream batch
sequences, then installs that state. Strict filename/SHA manifests reuse an
identical acknowledged local cache. SDK writes use stable JSON key ordering so
native and server-replayed files match; binary values and serialization hooks
are rejected. A divergent or poisoned cache is preserved under the thread's
`runtime-recovery` directory outside portable session/work archives.
An empty ledger is seeded once from only the existing Pi JSONL files; provider
configuration and arbitrary files are rejected. This supports the previous
server-checkpoint format without running its tasks during conversion. The
transport bounds ordinary commits to 2 MiB, the initial snapshot to 32 MiB raw
(48 MiB encoded), and a thread ledger to 128 MiB. Divergent-cache directories
currently require operator retention management; bounded ledger compaction is
a future compatibility workflow, never silent history deletion.

Tests kill a real Pi worker while an unsafe write is parked, remove its entire
local directory before any final checkpoint, and reconstruct from the server
ledger without repeating that write. Separate tests hold acknowledgments at
tool-claim and streamed-progress boundaries and replay acknowledged writes
into an independent storage implementation to check exposed progress.

A later request cannot revive abandoned SDK work under its own callbacks.
Before enabling scheduling, the adapter inspects unfinished submissions. It
preserves recovery of the same request ID; for a new request it first durably
marks every old task aborted and withdraws old queued input while scheduling
is paused. Only then may reviewed cancellation handlers settle that work and
the new request begin. Mixed unfinished request identities or failed cleanup
remain interrupted. A separate crash test verifies this for an old tool that
was persisted pending but never admitted its execution claim.

Run `bun test packages/runtime/src` and `bun x tsc -b packages/runtime` from the
repository root. Tests exercise the real upstream harness with its explicit
scripted provider, including a SIGKILL while an unsafe write waits for
permission, reopen deduplication, denial without effects, cancellation, broker
request IDs, file boundaries, minimal command environments and the OpenShell
transport's fail-closed behavior. Fake OpenShell transport tests do not claim
that a local kernel or live OpenShell gateway has been qualified; the real
boundary probe must pass on the actual execution host.

The isolated backend mirrors guest artifacts into `workspaceRoot` before the
runtime returns, after the harness closes. A newly-created guest imports that
server-restored mirror; an existing guest remains authoritative. Transfer uses
fixed trusted Bun scripts launched from `/usr` with `HOME=/nonexistent`, never
repository startup code or host tar extraction. Manifests verify canonical
paths, regular files and SHA-256 checksums, reject symlinks/special files, and
bound data to 32 MiB/2048 files. Dependencies, VCS and generated cache directories
are omitted with markers the server archive records. A failed or interrupted
initial import preserves the guest for inspection instead of silently retrying
over partially restored files.

Live qualification on 2026-11-14 used OpenShell 0.1.8, rootless Podman 5.8.9,
WSL2 Linux 6.6.87.2 and Bun 1.4.4. The tested Bun base is the multiarch OCI index
`sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`,
also pinned in the Dockerfiles. The temporary test gateway bound loopback
only and used a separate development launch-signing bundle; production mTLS
configuration was not weakened.

- The actual non-root sandbox passed a permitted workspace write and denied
  a write to normally world-writable `/var/tmp`.
- Server workspace import and guest artifact export were checked against
  actual file contents (`REAL_GUEST_IMPORT_EXPORT_OK`).
- Real Pi Durable 1.5.2 with its explicit upstream scripted provider invoked
  actual isolated read/write/process tools and reopened without model replay
  (`REAL_ISOLATED_HARNESS_OK`, 4 model calls).
- The complete `deploy/openshell/Dockerfile.pi` image built and reported Pi
  coding-agent 1.5.2. The live qualifier checked a 6 MiB binary artifact in both
  directions, server archive capture, old test-guest deletion and restoration
  into a fresh guest at a different host directory without model replay.
- Cancellation stopped a remote command before its delayed write, including
  on the complete Pi image. Normal shell completion also stops the sandbox to
  remove untracked background descendants before the next invocation.
- A real configured Vercel model ran through the same enforced backend with
  every tool denied: `vercel-ai-gateway/openai/gpt-4.1-nano` replied
  `LAUN_REAL_ISOLATED_MODEL_OK` (624 reported tokens, $0.0000654 reported cost).

The real-provider smoke first used a minimal Bun image; the committed live
qualifier also passed against the complete Pi image. These bounded checks do
not qualify a remote VPS, production certificate routing or every kernel/engine.
Live cancellation testing exposed that killing the OpenShell CLI alone leaves
its remote command running; the backend now explicitly stops the whole
sandbox for tracked shell completion/abort, then restarts it only for another
tracked invocation or trusted checkpoint export. A stop that cannot be
verified produces `interrupted` and requires reconciliation.

Repeat the explicit qualification against an operator-provisioned gateway:

```sh
OPENSHELL_ENABLED=true OPENSHELL_SANDBOX_IMAGE=<built-pi-image> \
  bun packages/runtime/test/openshell-live.ts
```

The script uses the upstream scripted provider and creates only labelled test
sandboxes. It deletes only its own verified sandbox after archiving it, forces
a fresh guest restore, and cleans up that guest. Local test archives remain at
the paths printed for inspection. It makes no paid model requests. The restore
transport uses bounded base64 chunks because OpenShell 0.1.8 limits a single
piped exec input to 4 MiB; it does not extract a host-provided tar archive.

Remote yards use controller inference by default. `createPiInference()`
constructs the controller model service without enabling host tools or a local
executor. `RuntimeCallbacks.inference` binds the worker proxy to its current
authenticated run/generation; no worker provider credentials are read and no
local-provider fallback is available. An explicit operator-managed local
inference mode remains separate.

The gateway chooses the run's snapshotted model. The adapter accepts only
bounded transcript JSON and temperature/maxTokens/reasoning options, rejects
worker endpoint/header/auth overrides, caps output tokens and disables SDK
and harness retries. Provider continuation IDs and diagnostics are excluded
from worker-controlled request authority. Request IDs hash canonical adapter
envelopes; the controller durably admits each charge once. Compact deltas
avoid repeatedly transmitting full partial messages, and a terminal model
payload commits only after the transport confirms durable settlement and clean
EOF. Missing confirmation, provider errors and uncertain stops produce an
interrupted run requiring reconciliation. Authoritative usage is recorded on
the controller before its terminal frame; worker usage claims cannot suppress
or double-count it.

The adapter bounds request/frame JSON to 2 MiB, total adapter output to 16 MiB,
message/frame counts and JSON depth. Cancellation aborts provider and transport
iterators; deadlines remain effective even when a provider never resolves its
next event. The gateway also fences worker identity, generation, lease and
revocation before admission and during streaming.

A bounded real-provider HTTP relay smoke on 2026-11-14 used the existing
controller-only Vercel credential and a worker with no provider file. The
reviewer fixture approved one exact write, denied a second, and the actual
model replanned to `LAUN_REAL_RELAY_REPLAN_OK`. The approved file was verified
and the denied file was absent. Two `openai/gpt-4.1-nano` calls reported
1492 tokens and $0.0001699 centrally. The temporary authenticated controller,
worker data and test files were removed; credentials were never copied.

Mower instructions are snapshotted with a queued run and included in request
identity. They append to the fixed permission/cancellation baseline and any
operator instructions; they cannot replace that baseline or change authority.
The adapter bounds them to 16000 characters.

Current busy-input behavior is explicit FIFO follow-up or Stop. Steer is not
advertised as a runtime capability and the v2 API rejects it. Upstream Durable
does offer `whenBusy: "steer", whenIdle: "reject"`, but applies it at tool/final
boundaries and settles it with the existing upstream run's answer. It does not
preempt a model request or an approval-blocked tool. A future capability needs
durable controller command admission, run/generation binding, worker delivery
and acknowledgement, cancellation semantics and multiple-input settlement;
an SDK method alone does not provide that server-side contract.

Explicit host cleanup is separate from controller history removal. Configure
`cleanupRoot` once on the runtime factory; it must be a private supervisor-owned
directory containing `threads/<threadId>/{session,work}`. Configured runs are
confined to that layout. `cleanupThread` accepts only thread/placement IDs,
stop confirmation and an optional cancellation signal. An absent root, custom
execution backend, live writer, changed root identity, symlink, special file,
unknown copy namespace or exhausted verification bound blocks completion.
The runtime shares a supervisor guard with new runs, checks old session locks,
and removes only the exact thread plus UUID-named restore/recovery copies.
It checks cancellation between removals and fsyncs the containing directory.

OpenShell cleanup never creates, starts or executes a guest. It enumerates
bounded pages across visible workspaces, checks full thread/UUID placement and
policy/resource identity labels against the managed name, and deletes only
guests in the immutable configured workspace after a verified `Stopped` state.
Foreign workspaces and unknown identities remain outstanding. Both list and
direct lookup corroborate absence because CLI `get` also fetches policy and
can fail independently. Authentication/transport failures and asynchronous
deletion never count as successful absence. Enumeration is capped at 1,000
visible guests; tree verification at 50,000 entries per copy and 128 copies.
An accepted asynchronous guest deletion is followed by at most 5 seconds of
read-only verification, never another delete request. Present records retain
the exact identity and stopped/deleting phase; strict NotFound and a matching
all-workspaces list absence must agree. Guest operations share a 120 second
overall deadline and respect earlier cancellation/lease loss.
The result is verified only when every check completes with no outstanding
items. Controller approval/lease fencing must precede calling this method;
an expired or lost acknowledgement requires reconciliation rather than an
automatic retry. Unlabelled unknown guests, offline machines, bridge queues,
original imports and external copies are outside this runtime's erase claim.

Cleanup qualification currently uses dedicated temporary filesystem and fake
CLI fixtures, including cancellation, active writers, epoch pagination,
cross-workspace preservation, ambiguous statuses and unrelated-guest safety.
The actual OpenShell0.1.8 binary's flags and pinned public JSON/lifecycle source
were inspected; this does not claim a live VPS cleanup qualification.
