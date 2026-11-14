# Product, connectors, and operations design

Historical baseline audit and accepted product/operations design, based on v1
(`cff77fd8`) on 2026-11-14. Findings below describe that starting point. See
[implementation](implementation.md) and [current acceptance status](../core-status.md)
for completed workflows and later qualification. This independent design
review alone does not certify a live deployment.

## 1. Product vocabulary and boundaries

Keep the project spelling **laun**, pronounced “lawn.” Use familiar nouns in
the interface, with garden names as a light layer:

| Concept | Recommended UI name | Meaning |
| --- | --- | --- |
| Installation/control plane | laun installation | One administrative boundary with users, hosts, policy, and threads |
| Named agent identity | Mower | Persistent name, instructions, assigned permission profile, and budget |
| Supervising identity | Director | A mower with explicit delegation capabilities; same enforcement as others |
| Conversation | Thread | Durable server record, independent of UI or the process currently running it |
| Machine | Yard / Host | Local computer or VPS; owns worker capacity and sandbox support |
| Execution run | Run | A logical unit of work with its own cancellation and limits, spanning retry attempts |
| Execution attempt | Attempt | One runtime allocation within a run, with its own host and lease generation |
| Delegated work | Task | Explicit assignment, inputs, dependencies, result, and owner |
| Saved output | Clipping (optional) | Artifact with producer, thread/run, hash, and access rules |

Other naming options are “Groundskeeper” for the director, “Crew” for a group
of mowers, and “Patch” for a project. Prefer **Director**, **Mowers**,
**Threads**, and **Hosts** in navigation until the meaning is obvious. Names
are editable display fields, never authorization identifiers. Duplicate names
across installations are fine; names within one installation use a normalized uniqueness rule
and retain immutable IDs after renaming. Keep Unicode display names distinct
from safe filesystem slugs.

The requested chat experience is interpreted as a persistent inbox with a
director, visible delegated agents, parallel conversations, streaming output,
and approvals. No dependency on, or claimed feature parity with, an external
“Grokbot” product is required to implement these behaviors.

## 2. Current behavior and missing cases

The current product has useful foundations: sessions, a browser transcript,
CLI named targets, abort/continue, steer/queue API support, usage events,
Telegram long polling, a deploy workflow, and file-backed recovery. It has
one configured executor per gateway, rather than a fleet or mower registry.

| Priority | Finding and code evidence | Consequence / required outcome |
| --- | --- | --- |
| P0 | `deploy/docker-compose.yml` publishes `${EXECUTOR_PORT}:8081` and `${GATEWAY_PORT}:8080` without a bind address | All host interfaces can expose these ports. Bind the human API to loopback by default; remove executor publication or bind it explicitly to loopback. `deploy/tls.md` and `deploy/Caddyfile` currently claim the executor is loopback-only without making it so. |
| P0 | Gateway compose environment omits `MAX_CONCURRENT_RUNS`, `MAX_SESSION_TOKENS`, `AUTO_RESUME`, `AUTO_RESUME_MAX_AGE_MS`, and `RUN_STALL_MS`, despite defining them in `deploy/.env.example` | Editing these documented settings does not reach the container. Pass them explicitly and test resolved deployment configuration. |
| P0 | `apps/gateway/src/index.ts` `/health` always returns `ok: true` with an executor URL; `apps/laun/src/agent.ts` doctor uses this liveness response | “Healthy” does not establish authenticated access, executor readiness, model availability, durable writes, or OpenShell readiness. Separate public liveness from authenticated readiness and capability checks. |
| P0 | `apps/laun/src/ssh.ts` writes the local env file verbatim to the remote before bootstrap; `deploy/bootstrap.sh` restores that version | Re-running setup can overwrite remote operational choices and secrets with stale local configuration. Use per-installation config ownership, an explicit diff, backups, and merge rules. Never silently migrate credentials across hosts. |
| P0 | `deploy/bootstrap.sh` warns and continues after dependency/typecheck failures and after gateway health timeout | Setup can report completion on a broken or stale system. Required checks must fail with an actionable stage and nonzero exit; optional integration absence should be an explicit capability state. |
| P0 | Compose mounts OpenShell identities from `/home/ubuntu/.config/...` and hardcodes gateway transport topology | Root installs, different usernames, additional hosts, and local installs need different paths. Parameterize validated paths/endpoints and generate per-host config; require only the mounts for enabled capabilities. |
| P1 | `apps/telegram-bridge/src/bot.ts` has module-level in-memory `Map<chatId, sessionId>` | Bridge restart loses routing; forum topics and multiple users in a group share the latest session. Move routing to authenticated, durable `(connector, account, chat, topic, sender-or-shared-scope)` bindings. |
| P1 | Plain text follows only running/pending/waiting sessions, otherwise starts a new one (`bot.ts`) | A natural follow-up after completion discards conversation continuity. Bound threads remain addressable after completion; `/new` explicitly creates another. |
| P1 | Bridge `GatewayClient.sendMessage` and browser composer never send a busy mode | The gateway supports `steer`/`queue`, but these interfaces still say to retry later. Add explicit Send / Queue / Steer semantics with a returned durable message receipt. |
| P1 | `pollSession` watches only new sessions and keeps cursor only on its stack; it advances `since` before delivery, and swallows send errors | Restart loses all watchers; Telegram delivery failure can drop output forever. Persist subscriptions and an outbox, retry deliveries independently from event ingestion. |
| P1 | `MAX_POLLS` is derived using 2000ms rather than `cfg.pollMs` | The claimed 30-minute ceiling varies from about 7.5 minutes to 7.5 hours across valid settings. Use a wall-clock deadline and present “watch ended” separately from “run ended.” |
| P1 | `format.ts` truncates one oversize event at `TG_MAX`; the bridge renders every text delta as a line | Long results lose content; token streams can flood chats and break paragraphs. Coalesce output, chunk without data loss, attach/link long artifacts, and throttle sends. |
| P1 | Approval callback embeds the whole session/request ID in `format.ts` | Opaque server handles are needed to fit transport bounds, expire safely, and bind the action to the requester and exact pending operation. A stale button must display already resolved/expired, never imply a new grant. |
| P1 | Browser stores the bearer key in localStorage (`public/app.js`) | Add a credential/session strategy, restrictive content policy, and escaping guarantees before exposing a richer plugin/UI surface. Local storage currently makes any same-origin script a credential reader. |
| P1 | `apps/gateway/src/server.ts` pending queue has one in-memory slot, with newer messages replacing older | Users need visible replacement semantics now; future durable queues require message IDs, ordering, cancellation, idempotency, and restart recovery. |
| P1 | `deleteSession` removes records/logs after best-effort abort; sandbox deletion is deferred to an idle reaper | “Delete” may leave a live external operation, sandbox, runtime state, or artifacts. Expose archive, stop, and purge as distinct operations with cleanup state and retry. |
| P1 | `apps/laun/src/config.ts` named targets save gateway endpoints and credentials | This is client selection among independent servers, not one director dispatching to hosts. Keep target selection, add server-side host registration and assignment. |
| P1 | CLI release compiles just `apps/laun/src/index.ts`, but setup reads deployment files through `repoRoot()` in `setup.ts` | A standalone binary needs embedded/versioned templates or an authenticated release bundle. Validate setup from an empty directory using the packaged artifact, without assuming a source checkout exists. |
| P1 | Service Dockerfiles fetch unpinned Pi/OpenShell installers; `.env.example` defaults to `latest` | The same laun release can rebuild with different runtime behavior. Pin tested runtime and image versions/digests and report them via capabilities. |
| P1 | `remote-setup.md` backup recipe covers `laun-data`, while runtime sandboxes can own independent workspaces | Catalog and restore all authoritative stores, including sandbox volumes/runtime exports and artifact objects, with a consistent manifest. The documented data-volume backup alone does not establish sandbox recovery. |
| P2 | List/log endpoints materialize complete histories; browser initially loads log from cursor zero | Large installations need pagination, transcript virtualization, bounded chunks, event retention, and replay cursors with explicit expired-cursor responses. |
| P2 | `.github/workflows/ci.yml` runs typecheck/unit tests; release smoke only starts services and probes health | No automated evidence yet for browser interactions, full sandboxed inference, bridge restart delivery, packaged setup, or host loss recovery. Add the acceptance layers below. |

These are observed examples, not an exhaustive proof that no other edge cases
exist. The old `docs/roadmap.md` mixes “done,” stale “missing,” and live claims;
release readiness must be tied to current checks and artifacts rather than its
summary table.

## 3. User flows and director behavior

### First run

1. Run setup locally or against a chosen VPS. Preflight host permissions,
   available disk/RAM, Bun/Docker, ports, CPU architecture, time sync, network,
   and the selected OpenShell/Pi compatibility set.
2. Choose one topology: all local, all on this VPS, or control plane here with
   workers on registered hosts. The initial path is single VPS + compose.
3. Name the installation, its first yard/host and first mower. Create a director thread with a minimal
   profile; show which capabilities are available and which require setup.
4. Configure model access through the chosen secret provider. Run an actual
   bounded model and sandbox probe; never report ready based on HTTP alone.
5. Return the configured private URL/tunnel instruction, authenticated
   bootstrap/session flow, runtime versions, and a working test thread. Store
   a durable installation ID so repeat setup addresses the same installation.

Setup must not silently fall back to unsandboxed execution if remote isolation
was requested. Local OpenShell-off development is an explicit capability, not
a reason to advertise confinement. Automode setup should ask concrete policy
questions (allowed repos, hosts, external writes, secret use, spending), save
a versioned draft, and explain any missing information. Policy authority is
specified in [02-permissions.md](02-permissions.md).

### Normal work

The director accepts a goal, creates visible tasks, chooses eligible mowers,
and delegates through a server API with bounded budgets and permission
subsets. Each child gets a thread URL immediately. The user can open, message,
pause, stop, or take over any child for which they have access. The director
receives typed task result events, not unrestricted access to every child
transcript or secret. A failure is a result requiring a decision; it must not
automatically spawn recursive replacement agents forever.

Define `spawn`, `assign`, `send`, and `handoff` separately. A handoff changes
task ownership and sends a context package; it does not transfer a live Pi
process or silently grant the recipient the sender's policy. Assignment is
durable before acknowledging the request. Concurrent user/director messages
have explicit ordering and authorship. User stop/pause takes priority over
subsequent director retries and delegation.

Required boundaries: maximum child count/depth, no delegation cycles,
per-task and total budget, capability-compatible placement, cancellation
propagation, and owner-approved permission expansion. A director remains an
ordinary policy-constrained mower. It cannot enroll a host, edit policy, or
mint credentials merely because its role is director.

## 4. Interface shape

Extend the existing browser application; keep a plain functional UI before
adding a framework or a second dashboard. Suggested navigation:

- Inbox: director and active threads, with unread results and approvals.
- Mowers: name, purpose, assigned profile revision, model/runtime, current
  host, queue, concurrency and budget; lifecycle includes paused/retired.
- Threads: durable history, composer, delegation tree, artifacts, run state,
  actor identity, queue receipts, and links to parent/child threads.
- Hosts: online/offline/draining, last heartbeat, capacity, runtime and
  OpenShell versions, supported policy features, storage availability.
- Permissions: pending actions, drafts, active revisions, expiration and
  audit history. “Decision saved” and “operation resumed” are different states.

Keep the current CLI commands as aliases during migration. Add mower/thread/
host commands once the protocol exists; do not rename a session API before a
compatibility adapter and migration are ready. Every mutation returns an
operation/resource ID and supports idempotency. Stale clients must get a
version/capability error before triggering incompatible behavior.

For messages during a run, users choose Queue or Steer. Queue preserves every
accepted message unless cancellation is explicit. Steer is available only
when the runtime advertises it; otherwise offer Queue. A response must say
whether input was stored, delivered to a worker, or processed. Streaming
reconnect uses server event IDs; a client must not equate ending one run with
ending the thread subscription. Keep visible user messages as durable events
so another client can reconstruct the entire conversation.

Accessibility checks include keyboard-only navigation, focus after a child
opens, screen-reader status announcements, clear approval context, and mobile
layouts. Never depend on color or a garden pun to explain a blocked action.

## 5. Connector contract and Telegram

The control plane owns threads, message routing, authorization, approvals,
and subscriptions. A connector owns transport normalization and delivery. Put
shared contracts in `packages/protocol`; clients should not re-declare pending
approval/request shapes. A normalized message includes installation/account,
transport message ID, sender principal, conversation/topic/reply identity,
timestamp, content references, and an idempotency key. Transport identity is
bound to a laun principal through an explicit connection flow.

For Telegram, ship long polling first and one polling owner per bot token.
Persist received update IDs with message acceptance. Bind private chats and
forum topics explicitly; support “one topic = one thread” and ordinary chat
reply-to routing. `/new`, `/mowers`, `/use`, `/thread`, `/status`, `/stop`,
`/queue`, `/steer`, and direct child links should reach the same server APIs.
Use existing commands as compatibility aliases. When a chat has no binding,
ask for or clearly announce the new thread rather than guessing silently.

Delivery needs a persistent outbox with bounded retries, per-chat ordering,
rate-limit backoff, and a dead-letter state visible in the UI. Record the
transport message ID after successful send; Telegram can still duplicate a
message if it accepted the send before the connector crashed. Document this
at-least-once limitation and make approval actions idempotent. Loss of the
Telegram transport must not stop a server run or erase its result.

Before enabling group use, define membership and topic ACLs: being an
allowlisted sender does not authorize posting sensitive output to every
group that sender visits. Check destination permission at delivery time.
Handle bot removal, topic closure/deletion, migration of group IDs, edited and
deleted messages, duplicate updates, reconnects, stale callbacks, and expired
attachments. Attachment download is untrusted content; apply size, type,
retention and sandbox ingestion rules. Credentials and secret-bearing
artifacts are never forwarded by default.

Future connectors (CLI stream, browser, Slack/Discord/email) use this same
message/identity/outbox contract. Implement the durable Telegram/browser/CLI
path before adding another external service or OAuth provider.

## 6. Local and multi-VPS operations

Support three equivalent deployment arrangements:

| Arrangement | Durable authority | Worker placement | Constraint |
| --- | --- | --- | --- |
| Local development | Local gateway files | Same machine | OpenShell optional, visibly advertised |
| One VPS | Gateway + durable volume on VPS | Same VPS | Compose, private ports, OpenShell required for confined production |
| Local or remote control plane + remote workers | One designated gateway/control plane | Enrolled VPSs | Authenticated worker channels, leases, fenced ownership, checkpoint transfer |

Start with one authoritative control plane, not federation or a consensus
cluster. For remote workers prefer outbound authenticated connections/polling
so arbitrary VPSs do not need public executor ports. Enrollment uses a
single-use expiring token and produces a distinct revocable worker identity.
Keep enrollment credentials out of mower environments and transcripts.
Workers advertise capabilities; placement requires both user policy and
host policy. A host marked draining gets no new work but can finish/stop
existing work. Deleting a host requires explicit handling of its data and
unreachable runs.

Do not imply that server durability alone makes a thread movable. Pi session
files and the sandbox workspace currently have their own physical location.
Until a verified checkpoint/export exists, runs remain pinned to their owning
host. Host loss shows `unavailable`/`recovery_required`; never replays an
unconfirmed external write automatically on a second host. Migration requires
quiescence, runtime checkpoint + workspace/artifact transfer, hash/version
validation, secret re-binding, and a new fenced run assignment.

Version the installer and generated configuration. Fetch pinned artifacts,
validate hashes, write config atomically, back up before migration, and retain
the last working release. Preflight both service and sandbox images for the
host architecture. Do not run broad source sync with `--delete` as a routine
production upgrade. An upgrade drains runs, snapshots data, applies a
versioned migration, checks readiness, and rolls back code only when the
data format remains compatible. Config migration must preserve explicit
operator choices and identify defaults that changed.

Back up the gateway index/event files, Pi session checkpoints, sandbox
workspace volumes, artifact storage, connection metadata, and encrypted
secret-provider state separately. Include a manifest of versions and active
runs. Quiesce writers or take a verified consistent snapshot. Exercise restore
on a fresh host; a tar command existing in documentation is not restore
evidence. Define retention, disk watermarks, failed-backup alerts, and user
deletion behavior. Expired sandboxes must not silently become fresh empty
workspaces while the UI still implies continuity.

## 7. Delivery phases and acceptance gates

| Phase | Deliverable | Required acceptance evidence |
| --- | --- | --- |
| P0: truthful install | Correct port exposure, env propagation, configurable host paths, fail-closed enabled integrations, pinned compatibility set, useful readiness | Resolve compose under a non-ubuntu username and custom paths/ports; prove executor inaccessible remotely; modify every documented limit and observe it in the container; absent/broken requested OpenShell fails before agent dispatch; required failure exits nonzero without printing secrets. |
| P1: durable identity | Mower/thread/run/task records and compatibility adapters | Restart control plane and recover names, profiles, parent/child links and messages; two same-named/display-renamed agents retain immutable IDs; legacy sessions remain readable. |
| P2: durable interaction | Message receipts, subscriptions, event IDs, connector bindings/outbox | Bridge restart during a run delivers result; replay the same update without duplicate task creation; two Telegram forum topics never mix output; queue/steer and stale approvals behave consistently across browser/CLI/Telegram. |
| P3: delegation | Director tools, visible children, handoff, bounded graph/budgets | Director spawns two children in parallel, user messages one directly, results return once, one child fails, cancellation propagates, denied rights cannot be delegated. |
| P4: remote placement | Enrollment, worker capabilities, capacity, leases and drain | Use two hosts; reject revoked/expired enrollment; stop a worker mid-run and fence its late events; never double-run an uncertain external effect; pin unavailable checkpoints rather than fabricating continuity. |
| P5: production recovery | Snapshot/export/restore, installer upgrades, operator status | Restore to a clean VPS; test disk-full and corrupted/torn record handling; report checkpoint unavailable after reaping; upgrade/rollback with schema compatibility checks; validate packaged CLI setup outside checkout. |

Use `bun run build` and `bun run test` as baseline gates. New checks should
exercise meaningful contracts and failure transitions, not duplicate object
field lists. Add deterministic fake transports/workers for fast CI and a
separate opt-in real Pi/OpenShell test requiring only disposable sandboxes and
a bounded model budget. Browser smoke must actually send a message, reconnect
a stream, navigate a delegated thread, and resolve an approval. Release smoke
must run the packaged CLI and an authenticated gateway-to-executor operation,
not only a public health endpoint.

## 8. Independent review outcome

The product direction is feasible incrementally on Bun/TypeScript and one
VPS. Keeping the current gateway, clients, and session files reduces migration
risk. A full rewrite before proving policy enforcement and durable message
identity would postpone the most important evidence.

The main sequencing correction is to distinguish a saved named CLI target
from a server-side worker fleet, and a long-lived mower identity from a
single runtime session. The second is to make delivery and approvals durable
before allowing a director to multiply work. The third is to describe
uncertain host/run effects honestly: automatic retries are safe only when
their operation semantics allow replay.

Open decisions for later review: exact public naming, per-user versus shared
group topic defaults, which host operating systems beyond Debian/Ubuntu to
support, and the first remote worker transport. None prevents P0 or the
identity/permission foundations from proceeding.
