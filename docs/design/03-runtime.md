# Runtime, durable threads, and execution hosts

Status: proposed architecture; implementation gates below are required before claiming delivery. Reviewed against the repository and primary upstream sources on 2026-11-14. This is a bounded design audit, not proof that every possible failure has been found. The existing session files and `index.json` remain authoritative until an explicit, tested migration lands.

## 1. Decisions

1. Keep Bun and strict TypeScript for laun services. Use language-neutral, versioned contracts in `packages/protocol`; a later Rust server can implement those contracts without rewriting connector behavior.
2. Distinguish the control server, an execution host, a named mower, a thread, a run, and an attempt. Today's single `sessionId` represents too many of these concepts.
3. Preserve the functioning Pi RPC adapter and sandbox seam. Add an experimental, pinned Pi Durable adapter in isolation rather than rewriting Pi before establishing its limitations.
4. Make thread history, submissions, delegation, permissions, and task state server-owned. A disconnected client does not stop work. An executor process and its SSE connection are replaceable delivery mechanisms.
5. One active execution owner per thread. Persistent lease generations fence stale events and broker calls. Lease expiry alone cannot make an arbitrary external side effect safe to repeat.
6. Start with one control server and a local execution host in Compose. Multiple registered hosts use the same API later; Kubernetes, public executor endpoints, and webhook migration are unnecessary.

## 2. Verified Pi interfaces

The latest GitHub release retrieved during this audit was **v1.5.2**, published **2026-11-10**. Upstream is now `earendil-works/pi`; old `badlogic/pi-mono` URLs redirect. Pin a tested version and lock transitive dependencies, then upgrade through compatibility probes. “Latest” is an input to validation, not a floating production dependency. [Release](https://github.com/earendil-works/pi/releases/tag/v1.5.2), [package](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/package.json).

The supported coding-agent SDK embeds in Bun or Node. `createAgentSession`, `SessionManager`, and `AgentSessionRuntime` expose sessions, resource loading, tools, and model configuration. `SessionManager` owns finalized context; changing an in-memory message array does not replace stored history. Runtime replacement requires subscriptions to be rebound. Stdio RPC offers a process boundary and a typed exported `RpcClient`. `agent_settled` is the completion boundary; `agent_end` can precede retries or queued work. [Pinned SDK](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md), [RPC](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/rpc.md).

RPC command acceptance is separate from work completion. A prompt response can be `started`, `queued`, or `handled`; `handled` need not produce `agent_settled`. The command API includes `get_entries {since: entryId}`, `get_state`, steering, follow-up, fork, and clone. `set_model` takes `provider` and `modelId`. A Pi entry cursor identifies runtime history; it is not the cursor for laun approvals, worker state, or connector deliveries. [Commands](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/rpc-commands.md).

There is also a real **`@earendil-works/pi-durable` v1.5.2** package. It explicitly labels its API experimental. It provides `Harness.open`, durable `submit` with `requestId`, `resume`, conversations, atomic commits, durable tasks, owned subagents, per-conversation environments, and persisted watches. It is a separate harness from the coding-agent SDK and is not automatically enabled by updating the `pi` binary. [Pinned Durable README](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md), [package and exports](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/package.json).

The detailed engineering implications below are laun design recommendations inferred from those interfaces. Recheck upstream declarations before each adapter upgrade.

## 3. Current implementation and concrete gaps

The repository already has real assets: Pi JSON and long-lived RPC paths, restart continuation, an OpenShell transport seam, per-session workdirs, idle cleanup, bounded recovery, steering, a queue slot, token reporting, budgets, global admission control, named CLI targets, and a Goose ACP adapter. `docs/roadmap.md` mixes historical snapshots with completed work; its “missing” labels must not substitute for reading code.

| Area | Current evidence | Missing behavior or edge case |
|---|---|---|
| Identity | `packages/protocol/src/index.ts` has sessions and runtime kinds | No mower, host, principal ownership, durable run, attempt, parent, delegation, or capability identity |
| Index durability | `apps/gateway/src/store.ts` uses temp + rename | Any read/parse/permission failure becomes an empty fresh index; invalid records are cast without validation; no schema/version/migration or single-writer guard |
| Event durability | `apps/gateway/src/server.ts:publish` appends JSONL | Append failures only log while clients still see the event; state and log are not one transaction; power-loss semantics undefined |
| History | Same file: `replay` and `log` | Only last 2,000 events rebuilt; array-position cursor repeats/freezes after eviction or restart; full file is loaded to recover the tail |
| Budgets | Same file: `sessionTokens` | Totals derived from evictable event ring; old usage falls out, so a session's counted spend can decrease; persistent accounting must be independent |
| Inbox | Same file: `pendingQueue` | One in-memory slot silently replaces old intent with a status note; accepted queued work disappears on restart; no caller idempotency key |
| Run ownership | Gateway `running`, executor `busy` and generation map | Generation protection exists only inside a process; gateway restart can race a still-running executor; no durable lease/reconciliation protocol |
| Startup recovery | Gateway boot loop | Resume dispatch is a generic prompt, not reconciliation with executor/checkpoint; boot resumes bypass normal `checkConcurrency`; interrupted approvals can be mistaken for ordinary runnable work |
| Stream ending | Gateway `runAgent` | Stream EOF can mark `done` if status remains running, even without an authoritative terminal record |
| Dispatch routing | Gateway `steerRunning` fallback | Fresh fallback calls `runAgent(sessionId, text, rec.model)` without the saved `repo`/`runtime`, so non-Pi context can be lost |
| Runtime compatibility | Executor `rpc.ts:ensureSession` | Sends `{ type: 'set_model', model }`, which does not match v1.5.2's `provider`/`modelId`; generally correlates only state responses, not prompt/control acceptance |
| Prompt lifecycle | `rpc.ts:run` and `onLine` | Does not explicitly resolve successful `handled` acceptance; extensions can consume a prompt without a run, leaving it waiting for timeout |
| Framing | `rpc.ts:onStdout` and Pi streaming parser | LF framing is correct, but independent `Buffer.toString('utf8')` decoding can corrupt split multibyte characters; no maximum unterminated record buffer |
| Backpressure | `rpc.ts:writeJson` | Treats `stdin.write(...) === false` as failure, although false means accepted but wait for drain; a retry could duplicate an accepted command |
| Generic fallbacks | `pi.ts:parsePiJsonLine` | Malformed/unknown protocol lines can become user text, hiding version skew and leaking diagnostics rather than signaling protocol failure |
| Recovery | `executor/src/recovery.ts` | Good bounded deadline and abort handling, but a prompt telling the model not to repeat side effects is not durable idempotency |
| Repository setup | `executor/src/server.ts:checkoutRepo` | Synchronous clone blocks server; nonempty partial checkout is considered complete; local/file/SSH sources use host trust and credentials before sandbox execution |
| Sandboxed history | `executor/src/sandbox.ts`, `rpc.ts` | Session files live inside sandbox workspace; stop preserves them, age deletion removes them. Server-owned archive/checkpoints and verified restore/move are absent |
| Sandbox failure cleanup | `rpc.ts:spawnSession` | A failure while starting an existing sandbox enters the same remove path as a failed create; cleanup must distinguish prior durable data from newly allocated resources |
| Remote hosts | Gateway config has one executor URL | Named CLI targets select distinct installations, not one registered fleet; no heartbeat, enrollment, revocation, labels, placement, or artifact transfer |
| Adapter claim | Executor maps `dots` through Goose ACP | A runtime label is not proof of a Dots-native adapter; publish actual capabilities and reject unsupported operations explicitly |
| Deployment | `deploy/Dockerfile`, `deploy/docker-compose.yml` | Pi/OpenShell installs float; Compose has host/user-specific OpenShell mounts and fixed endpoint; default sandbox-disabled + configured SDK endpoint conflicts with config fail-closed check |

Severity and remediation order: protect accepted work and authorization first; stabilize one host before scheduling across hosts; add director delegation only after identities, authority attenuation, and budgets are enforceable.

## 4. Server-owned domain model

Use opaque server-issued IDs. Human names are mutable labels, never authorization identifiers.

| Entity | Meaning and durable fields |
|---|---|
| Principal | Human, connector, mower service, or host; issuer, scopes, revocation generation |
| Host | Named machine with authenticated identity, platform, labels, capabilities, capacity, health, last heartbeat |
| Mower | Reusable named agent identity: role, runtime/model selection, pinned instruction/plugin versions, policy binding, host placement preference |
| Thread | Durable conversation assigned to a mower; parent/director relationship, active branch, workspace, checkpoint locator, lifecycle, policy ceiling |
| Submission | Immutable input with idempotency key, authenticated sender, source mapping, delivery intent, acceptance time, withdrawal state |
| Run | Unit of work consuming submissions; status, explicit terminal result, durable limits, active attempt, owner lease and generation |
| Attempt | A single runtime execution allocation: host, sandbox, checkpoint, heartbeat, exit reason, resume/replay classification |
| Delegation | Parent/child thread IDs, task description, authority and budget ceiling, ownership mode, deliverables, handoff/result receipt |
| Artifact | Immutable content hash, owner thread, location, size, classification, retention; stored content does not imply permission to attach elsewhere |
| Event | Versioned laun envelope with event ID, thread sequence, timestamp, run/attempt IDs, causal request ID, and validated runtime-neutral payload |

A mower can have many threads. A thread has one writer. A director is an ordinary mower and thread with explicit delegation capabilities; it is not a system administrator. Users can address any authorized child thread directly. Direct input enters the same inbox as director input, with sender identity and clear steering precedence. A child's knowledge of its parent does not authorize reading every sibling's transcript.

Keep storage behind interfaces. For the first release, preserve current Pi session files plus `index.json`; strengthen validation, crash handling, and durable command/event metadata around them. Introduce SQLite control metadata only as a separately reviewed migration, using Bun's built-in SQLite and a documented reason: atomic inbox admission, run transitions, leases, audit/outbox, and budget totals. No distributed database is needed. Do not present a future database as the current durability mechanism.

## 5. Runtime adapter and Pi Durable evaluation

Runtime-neutral executor operations should include `capabilities`, `start`, `submit`, `cancel`, `inspect`, `checkpoint`, `restore`, and `dispose`, with a transport-independent event subscription. Capability negotiation describes steering, branches, images, checkpoint portability, approvals, MCP, and durable recovery. Unsupported capability use fails before accepting a request.

The laun control server must not import Pi-specific messages, task records, or SDK types. The Pi adapter owns wire framing, event translation, runtime IDs and checkpoint metadata. Store adapter name/version, Pi version, storage format, and policy/plugin manifest hash with each checkpoint. Runtime migration must preserve old raw history even when a new provider cannot consume every content block.

### Candidate A: retain Pi coding-agent RPC

Best near-term compatibility with the functioning executor and whole-agent sandbox. Fix acceptance correlation, command schemas, UTF-8 framing, backpressure, explicit terminal outcomes, and persisted inbox first. Use the maintained typed client where its process-launch surface fits; if OpenShell's stream transport cannot fit that client, keep a small tested transport implementation rather than pretending a host child process is equivalent to a sandbox stream.

Pi files remain execution context. The server archives finalized entries/checkpoints with integrity hashes, outside disposable sandbox lifecycle. Use `get_entries` stable IDs for incremental import and a separate laun event sequence for clients. Never mutate Pi files behind an active writer.

### Candidate B: Pi Durable behind an experimental adapter

This is a strong fit for durable tasks, subagents, idempotent admission, and server-owned conversations. The package already covers much of what a fresh Pi fork would need. Its API instability and storage/concurrency semantics require an explicit spike before adoption.

Evaluation requirements:

1. Pin all Pi Durable family packages to 1.5.2 and lock them with Bun. Load only allowlisted registry extensions.
2. Exercise the portable SQLite core through a Bun SQLite facade, or prove the upstream Node adapter works under the selected Bun version. Do not assume Node's `node:sqlite` is interchangeable with `bun:sqlite`. Run storage and environment conformance suites through a compatible test shim.
3. The upstream default SQLite mode is WAL with `synchronous=NORMAL`: process-crash durability differs from power-loss durability. Decide and test laun's acknowledgement guarantee; use stricter synchronization for accepted durable commands where required.
4. Upstream permits one writing process per storage and supplies no cross-process locking. Add process ownership/lock handling and recovery fencing. Opening a second writable JSONL instance is unsafe even if it “only reads,” because open can repair files. Remote hosts must not concurrently open the control store.
5. Choose the execution boundary deliberately. A central harness with `ExecutionEnv` routing tools to OpenShell gives centralized state but trusts registry code in the server. A whole harness inside each sandbox keeps extension code isolated but requires durable checkpoint transfer and remote scheduler ownership. Start with reviewed built-in extensions and a host-side tool broker; third-party executable extensions require their own sandbox rather than arbitrary server imports.
6. Kill the harness during admission, model call, tool intent, tool execution, result commit, child spawn, child result delivery, approval wait, and compaction. Verify recovery and transcript integrity.
7. Pi Durable commits tool intent, but only tools declared `replay: 'safe'` rerun after interruption. Unsafe tools return interruption results. External effects still require target idempotency keys or operator reconciliation. Never label shell or arbitrary MCP calls replay-safe by default.
8. Preserve foreground child ownership and explicit background boundaries. Cancellation must follow the recorded ownership graph; background work surviving parent cancellation must be visible to users.
9. Compare transcript/watch pagination, usage accounting, shutdown, file storage growth, model/provider compatibility, and plugin revocation against the existing adapter. Keep a versioned export that can be read without the experimental package.

### Fork decision

Do not fork Pi merely for mower terminology, director orchestration, or a web UI. A fork becomes justified only by a demonstrated missing enforcement hook or durability guarantee that cannot be built at the adapter/broker boundary. Record the blocker, minimal patch, upstream issue, maintenance owner, license notices, compatibility fixture suite, and update process. A Rust port is a future adapter/server implementation, not a prerequisite for this work.

## 6. Admission, execution, and restart state machine

Separate thread lifecycle (`open`, `archived`, `deleting`) from run lifecycle (`queued`, `leased`, `running`, `waiting_permission`, `reconciling`, `succeeded`, `failed`, `cancelled`, `interrupted`). A successful run requires an explicit terminal outcome. EOF, timeout, model errors, host disappearance, and “handled without model work” remain distinct outcomes.

1. Authenticate and authorize input; validate capability, sizes, target thread, and policy version.
2. Persist the submission, request fingerprint, queue order, and outbox/event in one durable admission operation. Repeated idempotency key + same input returns the original receipt; same key + different input is a conflict.
3. Scheduler claims capacity and a run lease with monotonically increasing generation. Persist the assignment before dispatch. All entry points use the same admission path, including startup recovery, queue drain, direct child messages, and director tools.
4. Host acknowledges attempt startup and selected sandbox/policy/checkpoint. Dispatch retries use attempt ID, so a lost reply cannot start a second copy.
5. Host emits events tagged with attempt ID and monotonic sequence. Server persists before fan-out. Duplicate receipts are ignored, gaps are requested, and stale generations cannot change status or consume privileged broker capabilities.
6. A connector or browser disconnection closes only its subscription. Work remains owned by the server lease. Backpressure affects delivery buffers, never whether a side effect is retried.
7. On restart, reconcile assigned attempts with hosts before resuming. Expired ownership produces `reconciling`, not immediate parallel execution. Host-local shell processes and external MCP effects need explicit stop/inspection before reassignment.
8. If a host is unreachable, prevent it from obtaining new broker grants; keep the run interrupted until the old process is fenced or an explicit recovery policy permits relocation. A partitioned host with previously granted network access may continue effects: disclose this limit and prefer short-lived broker capabilities.
9. Checkpoint transfer requires a quiescent writer, integrity verification, runtime/manifest compatibility, secrets filtering, and restore probe. Failed restore preserves the original checkpoint.
10. Cancellation stores intent, withdraws queued submissions by policy, revokes new broker calls, propagates to owned tasks, and waits for acknowledgements or bounded escalation. Late completion after cancellation cannot resurrect a cancelled run.

## 7. Director, delegation, and handoff

Expose typed tools such as `mowers.list`, `threads.spawn`, `threads.message`, `tasks.delegate`, `tasks.inspect`, `tasks.cancel`, and `tasks.handoff` through the central broker. They call the same authorized APIs as people. No tool passes unrestricted service credentials to a child.

Spawning records task intent and child identity atomically and returns a durable receipt before starting execution. Duplicate call IDs reuse the child and its submission. Child policy is the intersection of organization guardrails, template, parent delegation ceiling, host enforcement capabilities, and thread restrictions. Shared policy templates are immutable versions; sharing a name does not share credentials or widen authority automatically.

Set limits for depth, children per task, active family count, total model spend, time, storage, and tool fan-out. Child reservations draw from the parent's total budget rather than minting a new full budget. When a child completes, an outbox delivers one durable result receipt to its parent; retrying delivery does not re-run the child. Parent context should receive a bounded summary and authorized artifact references, not every child's unbounded stream.

Handoff transfers task responsibility through a recorded state transition; it does not mutate history ownership or transfer all source credentials. A task graph can contain dependency edges, while ownership must remain acyclic. Reject cycles and delegation to deleted, suspended, or incompatible mowers. Users must be able to inspect and cancel background descendants even after their original director run finishes.

Concurrent human/director instructions need a documented policy: ordered acceptance with explicit steer or follow-up intent, an auditable supersession record, and cancellation taking precedence over future work. A model cannot override a human cancellation by calling resume on itself.

## 8. Multiple execution hosts and deployment forms

Support three placements with one contract: local control + local host, remote control + co-located host, and control + remote hosts. A CLI named target addresses the control server; host placement is a server-owned choice.

Enrollment uses a short-lived one-use token bound to the intended owner; the host exchanges it for an independently revocable identity. Prefer an outbound authenticated host connection or long polling so worker ports stay private. Heartbeats report capacity and supported runtime/sandbox versions. A host cannot self-assert authority merely by advertising a capability.

Scheduler filters by required OS/architecture, runtime, policy enforcement, model route, locality, health, and available resources. A configured OpenShell requirement excludes hosts without a verified enforcement probe. Do not downgrade to local unsandboxed execution when a host or sandbox is unavailable. Persist queue reasons and support draining a host before upgrade.

Provisioning should be idempotent and preflight the distro/architecture, disk, memory, container runtime, ports, user paths, OpenShell gateway route, certificate identity, and model endpoint. Pin release artifacts/checksums. Keep OpenShell off for explicit local development and on in the supported deployed profile. Generated config must validate before services start; failed bootstrap retains recovery information without logging secrets.

Archives live on the control server or its backup store, not only on a worker disk. Lost host data produces a visible restore or unavailable state. Host migration is not “connect to any VPS”: supported platforms and reachable routes are explicit, and a host must pass probes before accepting work.

## 9. Acceptance matrix and implementation sequence

| Stage | Deliverable | Required acceptance evidence |
|---|---|---|
| R0: inventory | Versioned contracts, this gap audit, baseline tests | Current behavior identified from code; historical roadmap contradictions marked; no live VPS claims without evidence |
| R1: reliable local adapter | Pin Pi, command receipts, UTF-8/backpressure, terminal state | Real pinned Pi RPC transcript, handled command, rejected model change, split UTF-8, no-newline output ceiling, aborted/timeout/late-settled race tests |
| R2: durable control metadata | Validated index, durable inbox, event cursor, independent budgets | Crash after admission before dispatch; disk-full and corrupt-index fail safely; replay across >2,000 events; token totals never decrease; idempotent retry rejects payload conflict |
| R3: run ownership | Run/attempt identity, leases, fencing, recovery reconciliation | Kill gateway with worker alive; duplicate dispatch; old events after new lease; stale approvals; startup respects capacity; EOF without terminal outcome stays interrupted |
| R4: Durable spike | Optional adapter and compatibility/export report | Bun storage conformance; kill/reopen model and tools; safe vs unsafe replay; child spawn/result exactly-once admission; no unreviewed plugin execution in control process |
| R5: first director | Named mowers, child threads, broker tools, bounded delegation | Duplicate spawn, cycle/depth limits, budget reservation, direct child input, foreground/background cancellation, idempotent parent receipt |
| R6: remote fleet | Enroll/revoke, outbound connection, host selection, checkpoint transfer | Two hosts, one partition, stale host revoked, restore after loss, incompatible checkpoint refused, drain/upgrade/rollback |
| R7: release readiness | Install/backup/restore/soak | Clean VPS, local mode, restart during tools, >24h idle resume, disk pressure, certificate rotation, restore on replacement host; precise operational recovery guide |

Cross-cutting failure cases: process crash versus host power loss, partial disk writes, full disk, clock skew, duplicate/inverted events, huge outputs, lost final acknowledgement, concurrent same-thread requests, cancellation during policy wait, expired model credentials, inaccessible repository, missing runtime binary, plugin version change, model catalog drift, provider rate limits, sandbox quota exhaustion, and invalid UTF-8. Each release must describe what was fake-tested, what was exercised with real Pi/OpenShell, and what remains unverified.

## 10. Review record

Runtime review author: `runtime_review` sub-agent. Local code inspection and upstream 1.5.2 API research completed on 2026-11-14. Root/security cross-review must reconcile this proposal with the permissions and control-plane sections before implementation. No code in this document is a claim of deployed or tested Pi Durable support.
