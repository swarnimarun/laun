# Cloudbear plan

Where the project is, what was verified, and what to build next.

## What cloudbear is

A self-hosted remote agent service: one VPS, running 24/7, that you drive from
Telegram, a terminal, or a browser.

```
Telegram / CLI / browser
        │
        ▼
    gateway  (sessions, event log, approvals, agent keys)
        │  bearer token, internal
        ▼
    executor (spawns the agent inside a policy sandbox)
        │
        ▼
    pi | goose | dots        inside OpenShell: policy, network, credentials
```

Today: Telegram bridge + gateway + executor for `pi`, plus a CLI and browser UI
that connect with an agent key. The executor runs `pi -p --mode json` once per
turn and keeps pi session files under `/data`.

## Principles already held

- `packages/protocol` is the only contract. Gateway and bridge never import
  harness types.
- The executor interface stays runtime-agnostic: `pi` now, `goose`/`dots`
  behind the same seam. No pi types leak into gateway or bridge.
- OpenShell is env-gated (`OPENSHELL_ENABLED`), never assumed to exist.
- Secrets never reach session files. Agent keys are stored hashed; the service
  token is never logged or printed.
- Durability is file-based: pi session files + gateway `index.json` +
  per-session JSONL event logs, all under `/data`.

## Verified findings

Facts checked against primary sources; these should shape the next milestones.

**Pi RPC mode is the right long-term executor primitive.** `pi --mode rpc` is a
long-lived process: JSONL commands on stdin, responses and events on stdout.
It supports `prompt` (with `streamingBehavior: "steer" | "followUp"`), `steer`,
`follow_up`, `abort`, `get_state`, `get_messages`, `get_entries`, `fork`,
`clone`, `set_model`, `compact`. Two properties matter for durability:

- `agent_settled` is the only completion signal. `agent_end` can be followed by
  retries, overflow recovery, compaction, or queued work.
- `get_entries` takes an entry id as a cursor: `{since: <id>}` returns only
  newer entries, even across client restarts. That is a better cursor than the
  gateway's own array index.

Source: pi docs `rpc.md`, `rpc-commands.md`, `json.md`
(https://github.com/earendil-works/pi).

**Real approvals are possible.** In RPC mode, pi's extension UI becomes a
request/response subprotocol: `extension_ui_request` records (`select`,
`confirm`, `input`, `editor`, `notify`) go to the client, which replies with
`extension_ui_response`. A Telegram/CLI/web approval can therefore gate the
agent's next action, replacing today's acknowledge-only approvals. Source: pi
docs `rpc-extension-ui.md`.

**The current JSON mode has hard limits.** In `--mode json` all prompts are
supplied at process start: no steering, no abort, no follow-up. pi also exits 0
even when the assistant response failed, so the event stream — not the exit
code — must decide success. (Both are handled in the current executor, but the
one-process-per-turn model is the real ceiling.)

**OpenShell is a gateway + sandbox control plane, not a CLI wrapper.** It is
Apache-2.0 Rust with a gateway (control plane), local and remote sandboxes, and
Python/TypeScript/Go/Rust SDKs. The TypeScript SDK (`@nvidia/openshell-sdk`)
exposes `OpenShellClient.connect()`, `client.sandbox.create/waitReady/exec/delete`,
streaming and interactive exec, SSH sessions, provider attachment, and a raw
gRPC client. Prefer the SDK over shelling out. Sources:
https://github.com/NVIDIA/OpenShell and https://docs.nvidia.com/openshell/latest/.

**OpenShell policies are a specific YAML schema, not the JSON in
`packages/policy`.** `version: 1` with `filesystem_policy`, `landlock`,
`process`, `network_policies`, `network_middlewares`. Absolute paths only, at
most 256 paths, `read_write` cannot contain `/`, unknown or duplicate keys are
rejected, and `openshell policy advisor` / `prover` report what a change would
newly allow. Sandboxes are long-lived, support restart policies,
`sandbox exec`, `sandbox upload/download`, and can run on a remote gateway.
Source: https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema.

**OpenShell keeps real credentials out of the sandbox.** Provider profiles
(YAML) declare endpoints and credentials; `openshell provider create
--from-existing` stores the key; the agent only ever sees a placeholder. That
is a stronger version of our "keys never reach the sandbox" rule than mounting
the host's `~/.pi`. Worked example for pi:
https://docs.nvidia.com/openshell/latest/tutorials/run-pi-with-openrouter
(`openshell sandbox create --name pi --from pi-agent:local --provider openrouter -- pi`).

**goose can be a second runtime through ACP, not a vendored fork.** goose is
Apache-2.0 Rust with `goose serve` — an ACP HTTP/WebSocket server documented for
custom clients — plus a custom-distribution/white-labelling guide. Sources:
https://github.com/block/goose and its `CUSTOM_DISTROS.md`. Recommendation:
implement the executor as a harness adapter and talk to `goose serve` over ACP;
vendor only if branding is genuinely required.

**"pi durable" and "dots" do not resolve to projects.** GitHub search found
nothing under those names, and pi's own docs have no "durable"/"dots" concept.
Closest real prior art:

- `monotykamary/heddlework` (MIT) — "harness-neutral workspace for agent
  sessions, task graphs, diffs, and durable work — Pi first".
- `kelvinschen/acpus` (MIT) — "orchestrate Claude, Codex, Pi & other ACP agents
  in dynamic, durable workflows — survive crashes, pause/resume, retry".

For durable-execution mechanics in general: Temporal, Restate, DBOS. Treat
"dots" as an unresolved name and ask the operator.

## Durability model

Keep files as the source of truth; make the *cursor* and the *process* better.

- Source of truth: gateway `index.json` + per-session `events-<id>.jsonl` +
  pi session files under `/data`.
- Completion cursor: move from an in-memory array index to pi's `get_entries`
  entry id, which survives restarts and compaction.
- Run lifecycle: one long-lived RPC child per active session instead of one
  process per message, so `abort` and `steer` exist and a restart can reattach
  or replay from the session file.
- Never leave a session `running` after a restart. (Implemented.)

## Milestones

**M1 — correctness and first-run experience (in flight).**
Real pi wire-event mapping; failure vs success decided by events; agent keys;
CLI (`setup`, `setup ssh`, `agent`, `keys`); browser UI; remote bootstrap.
Why now: without it the service is not actually usable or trustworthy.

**M2 — long-running and recoverable runs** *(split into lanes; M2.1–M2.2 in flight)*

The observed failure modes on a real VPS were: a provider socket drop killed a
near-complete run (no retry exists in one-shot JSON mode — `set_auto_retry` is
RPC-only), and there was no way to stop a runaway session.

| # | Task | Seam | Owner |
| --- | --- | --- | --- |
| M2.1 | RPC executor: one long-lived `pi --mode rpc` child per session, `set_auto_retry`, completion on `agent_settled`, idle TTL, `POST /abort`; `json` mode kept as a flag-guarded fallback | `apps/executor/**` | Lane A (worker + validator) |
| M2.2 | CLI: `cloudbear list` aliases, `agent stop`, `agent continue`, `--json` everywhere | `apps/cli/**` | Lane B (worker + validator) |
| M2.3 | Gateway: `POST /sessions/:id/abort` routed to the executor; `steer` so a message can land mid-run | `apps/gateway/**` | integrator |
| M2.4 | Run lease + heartbeat so a dead executor cannot leave a session `running` forever (today boot recovery only marks it `error`) | `apps/gateway/**` | integrator |
| M2.5 | Surface pi's `usage` (tokens/cost) as events — the field is already on `message_update` and we currently drop it | `packages/protocol` + executor | later wave |
| M2.6 | Durability cursor: adopt pi's `get_entries {since}` entry id instead of the gateway's array index | `apps/gateway/**` | later wave |

Why now: it is the difference between "runs a turn" and "controls an agent".

## Wave 2 — make it safe to leave running unattended

Objective: close the two gaps that stop a long task from surviving on its own
(provider runs dying mid-flight, and nothing actually being sandboxed), then
add the `dots` runtime once research says what that means.

| Track | Seam | Lane | State |
| --- | --- | --- | --- |
| **W2.1** Executor recovery (M2.7) — our own retry, because pi's `set_auto_retry` does not cover the socket-drop class that kills real runs | `apps/executor/**` | Lane R | worker in flight |
| **W2.2** OpenShell policy layer — real YAML schema our templates can actually be applied as, provider profile for credential injection, VPS bring-up script that *probes* a denial instead of claiming one | `packages/policy/**`, `deploy/openshell/**` | Lane P | worker in flight |
| **W2.3** `dots` runtime — adapter behind the same executor interface | TBD (`packages/` scaffold first) | blocked on research | research in flight |
| **W2.4** Executor → sandbox wiring, then enable it for real | `apps/executor/**`, `deploy/**` | **integrator** | after W2.1/W2.2 land |

**Ordering and why:** W2.1 and W2.2 are disjoint seams, so they run in
parallel; W2.4 must wait for both because it consumes Lane P's bring-up script
*and* touches the executor Lane R is editing. One lane lands at a time with the
gates re-run by the integrator, exactly as in M2.

**Definition of done for the wave (all measured on the VPS, none assumed):**

1. A long run that hits the socket-drop failure recovers on its own and reaches
   `done` without operator intervention, with `retrying (` visible in the log.
2. `deploy/openshell/install-and-verify.sh` prints `OS_PROBE=pass`, meaning a
   policy denial was observed — not merely that the sandbox started.
3. The executor runs the agent **inside** a sandbox with `OPENSHELL_ENABLED=true`,
   and the model credential reaches the provider without existing in the
   sandbox.
4. `stop` still works, and an abort during recovery never resurrects a run.
5. Lanes land only after a validator verdict and an independent gate run.

**Explicitly out of this wave:** M2.4 lease/heartbeat, M2.5 `usage`, M2.6
`get_entries`, TLS, and the Telegram token — all still required before this is
production-grade, none of them blocking the wave's goal.

## Handing work to a cloud agent: lanes, workers, validators

The loop that produced M2.1/M2.2 is designed to run unattended on a remote
box. It follows `gameboy/docs/parallel-work.md`.

**A lane is a jj workspace, never a git worktree.** `worktree: true` creates a
checkout with no `.jj`, so `jj log`/`jj status` fail inside it — that is a copy,
not a lane. Create it yourself and pass the child an explicit `cwd`:

```sh
jj workspace add ../cloudbear-lane-<name>   # sibling, outside the repo tree
```

**One writer per seam.** The worker owns exactly one directory subtree. The
integrator owns the serialization points: `packages/protocol`,
`apps/gateway`, root `package.json`/`tsconfig.json`, and all docs. A worker
that needs a cross-seam change records an *integration request* in its handoff
instead of making it — otherwise two lanes land on the same lines.

**Each lane runs a worker/validator pair:**

1. **Worker** (`muse-spark-1.3-contributor`, `:xhigh`) executes a spec written
to a file before it is spawned, so the brief cannot drift.
2. **Validator** (`reviewer`, same model/thinking) runs *after* it, read-only in
   the same lane cwd. Its job is adversarial: run the gates itself, look for
   tests that assert nothing, seam violations, silent behaviour changes, and
   any place the implementation dodges the spec. Verdict is `approve` or
   `changes requested` with file:line reasons.
3. On `changes requested`, the **worker is resumed with the verdict** — same
   run, not a fresh one, so it keeps its own context. Cap at 3 rounds; a lane
   that still fails review escalates to the integrator rather than looping.
4. **Integration is one lane at a time, in order**, re-running the gates after
   each landing, so a broken gate points at one change.

**Handoff is what makes it durable.** Every lane writes a note under
`.pi-subagents/handoffs/<lane>.md` in the *parent* repo (gitignored, shared on
disk) with change id, commit id, gate output and open decisions, so a cold
reader — or the next cloud agent — can pick it up without this conversation.

**Forbidden in a lane:** `jj abandon`, `jj op restore`, `jj gc`, `jj bookmark
set`, pushing, or removing any workspace but its own.

## Gaps that still block hands-off long runs

Observed against a live deployment, beyond M2:

| Gap | Consequence | Where |
| --- | --- | --- |
| No completion notification | you must poll `agent log --follow`; the only push channel is Telegram | new: `agent watch <id>` that exits when a run settles, so a cloud agent can wait on it |
| Follow-ups are rejected while running (409) | you cannot queue work onto a busy session; `steer`/`follow_up` in RPC mode is the fix | M2.3 |
| A reboot marks runs `error` rather than resuming | safe, but work in flight is abandoned | post-M2: replay from the pi session file |
| No budget limits | nothing caps runtime or tokens beyond `RUN_TIMEOUT_MS` (30 min hard) | post-M2 |
| `usage` (tokens/cost) is discarded | no visibility into what a long run costs | M2.5 |
| No global concurrency cap | sessions run in parallel with no ceiling on the box | post-M2 |

**M3 — real approvals.**
Bridge pi's `extension_ui_request(confirm|select)` into gateway
`approval_request` events, out to Telegram/CLI/web, and back as
`extension_ui_response`. Deny by default on timeout. Why now: today's approvals
are advisory; enforcement lives only in OpenShell policy.

**M4 — OpenShell integration.**
Use `@nvidia/openshell-sdk` from the executor: one sandbox per session from a
pinned pi image, credentials through providers, and policy templates
translated to the real YAML schema. Surface `policy advisor` findings as an
approval. Why now: this is the actual security boundary, and the JSON
templates we ship today do not apply to OpenShell as written.

**M5 — a second runtime and multiple targets.**
Prove the harness seam with goose over ACP (or a `dots` adapter). Add several
targets to the CLI with per-target keys, so one laptop can drive several VPSs.
Why now: it validates the interface before more features depend on it.

**M6 — hardening.**
TLS/reverse proxy in front of the gateway; key rotation as a documented flow;
per-key scopes and rate limits; structured logs and metrics; backup/restore of
`/data`. Why now: needed before the gateway is reachable from anywhere.

## Should this become a proper app?

Yes — but keep the gateway the product and the browser UI and CLI its clients.
Concretely:

- Do not fork goose for branding. Talk to `goose serve` over ACP.
- Do not adopt Kubernetes or webhooks. Single VPS, docker compose, long
  polling is a deliberate scope that keeps operations to one file.
- Do invest in the two things that are actually product-shaped: the gateway's
  session/event/approval contract, and the first-run experience
  (`setup` → key → connect). Everything else is replaceable.

## Open questions

- What does "dots" refer to? No project by that name was found.
- Should the browser UI stay served by the gateway (same origin, simplest), or
  become a separate SPA with its own deployment?
- Should agent keys be scoped per repo/target instead of being all-or-nothing?
- Which messaging channel is next — more Telegram features, or a second bridge
  (Slack/Discord/Matrix)?
- Does OpenShell belong on the same VPS as the gateway, or on a separate
  sandbox host reached through a remote gateway?
- How much of `/data` must survive a host loss? That decides whether the JSONL
  logs stay the source of truth or get mirrored.
