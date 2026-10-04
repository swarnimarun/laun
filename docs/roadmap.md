# Roadmap — what is not built yet

What laun is missing, in the order it should be built, with the evidence
that a feature is actually missing and a definition of done for each. Read this
alongside `DEVELOPMENT.md` (how to run it, and the lane/worker/validator workflow).

**Status legend:** *missing* = not in the code at all · *stub* = present but not
doing the real job · *unverified* = built but never proven in the real world ·
*done* = landed, gated, and proven live where stated.

---

## DONE (all landed 2026-10-04 unless noted, gates green at every landing)

- RPC executor: one long-lived `pi --mode rpc` child per session, abort,
  completion on `agent_settled` only.
- CLI: stop/continue/aliases, `agent watch` (exit 0/1/2, live-proven), `doctor`
  (live-proven), named targets, thinking render.
- Executor recovery: own retry with shared wall-clock deadline; `retrying (`
  visible; timeouts intentionally not retryable.
- Run-slot wedge class fixed (observed live, restart required): timeout/abort/
  error always free every slot (wedged children SIGKILLed, generation guard
  against `finally` clobbering, sync throws become 500); gateway `stop`
  always pokes the executor. Markers verified inside the running containers.
- Thinking + usage emission (coalesced, flood-tested) with CLI and bridge
  render; thinking events observed live end-to-end.
- Telegram bridge: disabled-by-default exit 0 (stack all-healthy), `/log`,
  actionable busy reply, cap notice.
- OpenShell policy layer: real YAML schema + validator, provider profiles,
  bring-up script with provider create, scoped `--approval-mode auto`,
  `OS_GRANTED` audit, key-absent-in-sandbox probe design.
- Executor sandbox wiring (CLI path): per-session sandbox create/exec/delete
  routing, fail-closed config. Proven live through one-shot exec + real
  policy denial + pi running inside — but NOT enabled (see NOW #1–2).
- Packaging: `bun` + `types` export conditions so clean checkouts resolve
  without `dist` (fixed a total deploy crash-loop).
- Rename cloudbear → laun; secrets hunt clean across tree + full history
  (one doc example scrubbed); fresh `/opt/laun` stack live; `v1` pushed.

---

## NOW: the RPC-long-lived track (ordered — each unlocks the next)

### 1. SDK transport for rpc (lane: `apps/executor`)

CLI `sandbox exec` streams nothing incrementally (proven live, three
witnesses) — it serves one-shot json only. Long-lived rpc needs the SDK's
`execInteractive` (documented streaming transport). `@nvidia/openshell-sdk`
lives on GitHub Packages (not npm): install with a `gh auth token`-minted
credential that is never printed, pin the version against gateway 0.1.2.
Contract: keep the `SandboxRunner.spawnInteractive` SHAPE (stdin/stdout/
stderr pipes); back it with an `execInteractive` session
(write/closeInput/output/done). **Done when:** the 3-writes-over-time test
passes against the REAL gateway (VPS throwaway sandbox), unit tests run on
fakes, no new failures elsewhere.

### 2. Sandbox-per-session lifecycle + workdir mapping (same lane, second)

Host `/data` is invisible inside sandboxes (proven live), so pi session files
and workdirs must live sandbox-side: create `laun-<sessionId>` on first run,
**STOP (not delete)** on idle reap so the workspace persists (= session
continuity), START on the next run. Upload repo/goal context on create.
There is no gateway session-delete API, so deletion is time-based:
`OPENSHELL_SANDBOX_MAX_IDLE_MS` (default 7d) reaper deletes stopped
sandboxes past their age. **Done when:** two runs share pi session files
across a stop/start cycle on the VPS; aged-out sandboxes disappear; host
workdir assumptions are gone from the executor.

### 3. Provider key, then enable (human step, then integrator)

Without a provider, pi inside a sandbox has no model auth — enabling first
would break every run. Order: user provisions `MODEL_API_KEY` on the box →
provider create → one full session proves model access with the key absent
inside → `OPENSHELL_ENABLED=true` + redeploy → default-on. Auto-approve flag
rides along (already in the bring-up script).

### 4. Steer / queue while busy (executor lane + integrator gateway)

RPC already supports steering; the gateway 409s instead. Contract (both
sides build to this): `RpcManager.steer(sessionId, text): boolean` (false
when no live run); single pending queue slot per session (newer replaces
older, replacement noted in the log); gateway `POST /messages` honors
`mode` (`steer` → rpc steer, `queue` → pending slot, 409 only when both the
run and the slot are occupied); CLI gains `--steer`/`--queue` on `say`.
**Done when:** say-while-busy steers visibly mid-run in the log, queue
ordering is test-covered, busy error text points at the new flags.

### 5. Resume after reboot + run lease/heartbeat (integrator, gateway-owned)

With #2 done, resume = start the stopped sandbox + new rpc child on the same
pi `--session-id` (session files persisted in the sandbox workspace). Lease:
gateway heartbeat per active run; a dead executor/gateway cannot leave a
session `running` forever. Definitions of done stay as written in P1 #9 and
the M2.4 row — this item is the scheduling, not a rewrite.

---

## P0 — makes an unattended run safe

These are the gaps that would let something go wrong without anyone noticing.

### 1. OpenShell is off; nothing is sandboxed *(stub)*

`OPENSHELL_ENABLED` is `false` on the live deployment, and the executor only
supports `OPENSHELL_PREFIX` — a string prepended to `pi`. There is no per-session
policy, no sandbox, and no credential isolation.

Evidence: `grep OPENSHELL_ENABLED deploy/.env.example` → `false`;
`grep -r 'execInteractive|openshell-sdk' apps/ packages/` → nothing.

**Done when:** `deploy/openshell/install-and-verify.sh` prints `OS_PROBE=pass`
on the VPS (a *denial observed*, not a sandbox that started), the executor runs
the agent inside a sandbox, and `OPENSHELL_ENABLED=true` is the shipped default.
The bring-up script and real YAML policy layer already exist (Lane P, landed);
the missing piece is executor ↔ sandbox wiring via
`@nvidia/openshell-sdk`'s `sandbox.execInteractive` for `pi --mode rpc`.

> Lane-sandbox landed 2026-10-04 (code; NOT enabled on the box): executor
> creates a per-session sandbox and routes spawns through `sandbox exec`.
> VPS-proven live: create with policy, real `/etc` denial, pi 1.0.2 runs
> inside, one-shot piped exec works. Two blockers before enabling: (1) CLI
> `exec` does not stream incrementally (three independent witnesses) —
> long-lived rpc needs the SDK's `execInteractive`, not the CLI; (2) host
> `/data` is invisible inside the sandbox, so pi session files/workdirs need
> a sync-or-mount design before sessions can survive there. Next lanes:
> SDK transport, then workdir mapping, then enable + redeploy.

### 2. Model access does not go through OpenShell *(missing — plan below)*

The OpenShell provider path is skipped entirely (`OS_PROVIDER=none`), because
the only credential the box has is pi's `auth.json`, which OpenShell cannot
inject. So even after OpenShell is wired up, the agent would be talking to its
model *outside* the sandbox's credential and network policy — which is the
whole point of the exercise.

**Evidence:** `deploy/openshell/install-and-verify.sh` skips provider creation
when `MODEL_API_KEY` is unset; `grep provider create` in `deploy/openshell/` is
reached only with a key supplied by hand.

**Plan — connect a *different* model through OpenShell's provider path.** Local
pi already holds credentials for several providers (`openrouter`,
`vercel-ai-gateway`, `zenmux`, `opencode-go`, `openai-codex` — names only,
values never read into a plan). OpenShell's documented example uses OpenRouter,
and one is available, so:

1. Create the provider on the box from an environment variable, never a literal:
   `MODEL_API_KEY=<key> openshell provider create --name <n> --type <provider> --from-existing`
2. Attach it **at sandbox creation** (`--provider`; static fields cannot be
   changed afterwards).
3. Point the agent at that provider's model id, so the sandbox's allowlisted
   endpoint is the one pi actually calls.
4. Keep the key out of the sandbox: the gateway holds it, the sandbox receives
   a placeholder, and only approved endpoints see the real value.

**Done when:** a session runs inside the sandbox against that model, the
summary reports `OS_PROVIDER=<name>` instead of `none`, the raw key is **absent
from inside the sandbox** (assert it in the probe), and a real model call
succeeds from within the sandbox.

### 3. Policy escalations still need a human *(missing — see 3a)*

**Evidence:** `deploy/openshell/install-and-verify.sh` never sets an approval
mode, and OpenShell's documented flow is manual:
`openshell rule get <sandbox> --status pending` → `openshell rule approve
<sandbox> --chunk-id <id>`.

That is fine while a human watches. It directly contradicts "run unattended":
as soon as the agent needs new egress, the run stalls waiting for someone to
approve a rule.

#### 3a. Automatic approval for policy proposals *(missing)*

OpenShell supports an automatic mode at sandbox creation:
`sandbox create --approval-mode auto` (with `agent_policy_proposals_enabled`
for the advisor to propose at all).

**Plan:** set it in the bring-up script, then decide *which* rule classes are
allowed to auto-approve. This is a real safety trade, not a switch to flip:

- **Auto-approve network egress proposals** so a model/tool call is not blocked.
- **Never auto-approve filesystem or process changes** — those widen the
  sandbox's blast radius and must stay human.
- **Record what was granted**, so auto-approval does not become an unaudited
  privilege creep.

**Done when:** a run that needs new egress completes with no human in the loop,
`openshell rule get <sandbox> --status pending` is **empty afterwards**, the
approved set is queryable (what was granted, when), and a filesystem/process
proposal is still *held* for review rather than silently granted. Prove it with
a probe that needs egress, not by asserting the flag was set.

> Landed 2026-10-04 (code-complete, live proof pending redeploy):
> `--approval-mode auto` is set at sandbox creation with runtime sniffing
> (degrades to `unsupported` + warn), network-egress auto-approve is scoped
> script-side, grants are audited via `OS_GRANTED`, the raw key is
> byte-compared absent inside the sandbox, and fs/process probes stay held.
> **Verified live 2026-10-04:** `--approval-mode` exists in
> `openshell sandbox create --help` (manual default, agent-authored proposals)
> and `openshell rule get [NAME]` exists — the script's sniffing targets are
> real. Full provider provisioning still needs a real `MODEL_API_KEY` on the
> box, which is a human step, not a lane step.

### 4. Approvals are acknowledge-only *(stub)*

`POST /sessions/:id/approvals` records a human decision and broadcasts it.
Nothing gates the agent — pi's `extension_ui` subprotocol is never connected.

**Done when:** an approval request blocks the agent until a decision arrives,
`extension_ui_request(confirm|select)` round-trips to `extension_ui_response`
through gateway → Telegram/CLI/web, and a **timeout denies by default**.

### 5. `pi` inside a sandbox is unverified *(unverified)*

OpenShell's tutorial only covers interactive `pi`; JSON/RPC across
`sandbox.execInteractive` is assumed, never tested.

**Done when:** a real `pi --mode rpc` child runs inside a sandbox with its
stdin/stdout attached, and one full session completes that way on the VPS.

---

## P1 — needed for long, unattended work

### 6. Model thinking is invisible *(missing)*

`parsePiJsonLine` maps only `text_delta` and `error`; every `thinking_*` event
is discarded. For a tool-heavy job the reasoning is the only sign of life, so
the transcript looks frozen.

**Done when:** thinking is visible in the CLI, browser UI and raw log, and the
gateway's 2000-event ring cannot be flooded by it — thinking deltas must be
**coalesced** (batched, not one event per token), covered by a test proving a
long reasoning block does not evict the surrounding `done`/`error` events.

> Landed 2026-10-04 (code-complete, live proof pending redeploy): the executor
> emits coalesced thinking (300-char chunks, flushed at turn end/abort/timeout;
> 10k chars → ~33 events, covered by flood + round-trip tests), and the CLI
> (`💭` prefix, coalesced transcript, `--json` passthrough) and the bridge
> render it. Still open: gateway forwarding of the new event kinds through the
> ring + browser UI render — integrator Phase-2 work.

### 7. No completion notification *(missing)*

You must poll or hold `--follow`. There is no way to say "tell me when this
finishes".

**Done when:** `laun agent watch <id>` (or an equivalent) exits when the
run settles and returns its status code from the run's outcome — usable by a
cloud agent that wants to block on a job.

> Landed + live-proven 2026-10-04: `agent watch <id> [--poll-ms] [--timeout]`
> exits 0/1/2 (done/error/timeout-or-usage), proven against the VPS over the
> tunnel (`watch 7031451e` → `✅ done`, exit 0). Needs no new gateway routes.

### 8. Follow-ups are rejected while a run is active *(stub — NOW #4 owns this)*

`POST /messages` returns 409 during a run, so work cannot be queued. RPC mode
already supports `steer` and `follow_up`; the gateway and CLI never use them.
The build order and contract live in NOW #4 above; this section keeps only
the original evidence. Done-when from NOW #4 applies.

### 9. A reboot abandons in-flight work *(stub — NOW #5 owns this)*

Boot recovery marks interrupted runs `error` — correct, but destructive: the
work is thrown away rather than resumed.

**Done when:** after a gateway or host restart, an interrupted session resumes
from pi's session file (or is offered `continue` automatically) instead of
being terminally `error`.

### 10. Recovery cannot save a timeout *(stub, by design)*

`RUN_RECOVERY_ATTEMPTS` shares one wall-clock deadline, so a run killed by
`RUN_TIMEOUT_MS` cannot be retried. That is correct for bounding retries, but it
means the most common long-job failure is unrecoverable automatically.

**Done when:** either timeouts get their own policy (bounded per-attempt retry
with a total ceiling), or the choice is documented as deliberate and `watch`
knows how to resume one.

> Wedge class fixed 2026-10-04 (observed live on 41bb1ac8, fixed before it
> could recur): a timed-out run left the executor answering 409 forever while
> the gateway record said idle — and `stop` refused without asking. Two halves:
> executor frees every slot on timeout/abort/error (wedged children SIGKILLed
> after a bounded 5s grace; per-run generation guard stops an old `finally`
> from clobbering a new run's slot; sync throws become 500 with the slot
> freed), and gateway `stop` always pokes the executor instead of trusting
> its local record. No `docker restart` should ever be needed for this again.
>
> Live on the box since the 2026-10-04 redeploy (code markers verified inside
> the running containers). Self-healing after a real timeout is still
> unproven live — the next 30-minute timeout is the test.

---

## P2 — product completeness

| # | Gap | Evidence it's missing | Done when |
|---|---|---|---|
| 10 | **Token/cost visibility** | `usage` exists on pi's `message_update`, never read | usage is an event, shown per session, and `agent status` reports totals |
| 11 | **Durable cursor** | gateway indexes events by array position | uses pi's `get_entries {since}` id so a cursor survives compaction and restart |
| 12 | **`repo` field is dead** | protocol declares it; nothing clones | `POST /sessions {repo}` checks the repo out into the workdir, or the field is removed |
| 13 | **ACP adapter (goose/dots)** | only `RuntimeKind` enum exists; no adapter | a second runtime runs behind the same executor interface; `goose serve` ACP (`/acp`, `X-Secret-Key`) is the documented path |
| 14 | **No budget limits** | only the 30-min `RUN_TIMEOUT_MS` cap | per-session max time and max tokens, enforced, reported |
| 15 | **No global concurrency cap** | sessions run in parallel unbounded | a configurable ceiling, with a queue or a clear rejection |
| 16 | **Keys are all-or-nothing** | one key grants every session | scopes (per repo/target), revocation that is immediate and testable |
| 17 | **Single host only** | one saved target in `~/.laun/auth.json` | named targets, `laun --target <name>` |
| 18 | **No stack self-check** | you must know the ssh/docker commands by hand | `laun doctor` reports health, config, version drift and the common failure modes |
| 19 | **Telegram bridge crash-loops** | placeholder `TELEGRAM_BOT_TOKEN` on the box | ships disabled-by-default when unset, so the stack is all-healthy — **landed 2026-10-04** (exit 0 + `/log` + actionable busy reply proven locally; `Restarting (1)` on the box clears on next redeploy) |
| 20 | **No TLS path** | plain HTTP behind a tunnel; docs say "put a proxy in front" | a documented Caddy/nginx recipe with an example config in `deploy/` |

---

## P3 — later, or opportunistic

- **Browser UI proven in a real browser.** Server path verified with curl;
  rendering, SSE and Approve have never been clicked by a human.
- **Bootstrap clone path untested** — the repo has no git remote, so `--repo-url`
  has never run for real.
- **Published images** — every deploy rebuilds from source on the box.
- **CI e2e** — CI runs unit tests only; nothing exercises a real executor.
- **Backups** — no recipe for backing up/restoring the `/data` volume.
- **Audit trail** — decisions record who approved; there is no queryable history
  of approvals and policy changes.
- **Timing-sensitive tests** — two were de-flaked this session; the class
  remains, so new spawn-heavy tests need explicit timeouts.
- **Stale `laun-launch` skill** in `~/.pi` targets a different (Portainer)
  system that does not exist in this repo.

---

## Deliberately out of scope

Single VPS + docker compose + long polling is the intended shape. **Not** doing:
Kubernetes, webhooks, a mobile app, multi-tenant auth, or forking goose for
branding (talk ACP to `goose serve` instead).

---

## Quick reference

| Feature | Status | Priority |
|---|---|---|
| OpenShell sandboxing enabled | stub | P0 |
| Model via OpenShell provider (key never in sandbox) | missing | P0 |
| Policy proposals auto-approved (network only) | missing | P0 |
| Real (gating) approvals | stub | P0 |
| `pi` in-sandbox JSON/RPC | unverified | P0 |
| Thinking visible (coalesced) | pipeline live since redeploy, awaiting a tool-heavy run | P1 |
| Completion notification (`watch`) | landed + live-proven | P1 |
| Queue/steer while busy | stub | P1 |
| Resume after reboot | stub | P1 |
| Retry policy for timeouts | stub | P1 |
| Token usage / cost | missing | P2 |
| Durable `get_entries` cursor | missing | P2 |
| `repo` checkout on create | missing | P2 |
| ACP adapter (goose/dots) | missing | P2 |
| Budgets + concurrency cap | missing | P2 |
| Key scopes, multi-target | missing | P2 |
| `laun doctor` | landed + live-proven | P2 |
| Bridge disabled without a token | live: stack all-healthy, Exited (0) | P2 |
| TLS recipe | partial | P2 |
