# Roadmap — what is not built yet

What cloudbear is missing, in the order it should be built, with the evidence
that a feature is actually missing and a definition of done for each. Read this
alongside `PLAN.md` (architecture and the lane workflow) and `DEVELOPMENT.md`
(how to run it).

**Status legend:** *missing* = not in the code at all · *stub* = present but not
doing the real job · *unverified* = built but never proven in the real world.

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

### 2. Model credentials are not provisioned *(missing)*

The OpenShell provider path is skipped (`OS_PROVIDER=none`) because the only
credential on the box is pi's `auth.json`, which OpenShell cannot inject. So
even once OpenShell is wired, credential isolation is unproven.

**Done when:** a key-based provider profile is created on the box, the agent
inside the sandbox reaches the model, and the raw key is absent from the
sandbox (assert it in the probe).

### 3. Approvals are acknowledge-only *(stub)*

`POST /sessions/:id/approvals` records a human decision and broadcasts it.
Nothing gates the agent — pi's `extension_ui` subprotocol is never connected.

**Done when:** an approval request blocks the agent until a decision arrives,
`extension_ui_request(confirm|select)` round-trips to `extension_ui_response`
through gateway → Telegram/CLI/web, and a **timeout denies by default**.

### 4. `pi` inside a sandbox is unverified *(unverified)*

OpenShell's tutorial only covers interactive `pi`; JSON/RPC across
`sandbox.execInteractive` is assumed, never tested.

**Done when:** a real `pi --mode rpc` child runs inside a sandbox with its
stdin/stdout attached, and one full session completes that way on the VPS.

---

## P1 — needed for long, unattended work

### 5. Model thinking is invisible *(missing)*

`parsePiJsonLine` maps only `text_delta` and `error`; every `thinking_*` event
is discarded. For a tool-heavy job the reasoning is the only sign of life, so
the transcript looks frozen.

**Done when:** thinking is visible in the CLI, browser UI and raw log, and the
gateway's 2000-event ring cannot be flooded by it — thinking deltas must be
**coalesced** (batched, not one event per token), covered by a test proving a
long reasoning block does not evict the surrounding `done`/`error` events.

### 6. No completion notification *(missing)*

You must poll or hold `--follow`. There is no way to say "tell me when this
finishes".

**Done when:** `cloudbear agent watch <id>` (or an equivalent) exits when the
run settles and returns its status code from the run's outcome — usable by a
cloud agent that wants to block on a job.

### 7. Follow-ups are rejected while a run is active *(stub)*

`POST /messages` returns 409 during a run, so work cannot be queued. RPC mode
already supports `steer` and `follow_up`; the gateway and CLI never use them.

**Done when:** `cloudbear agent say <id> "..."` on a busy session queues a
`steer` (or `follow_up`) instead of failing, with `--queue`/`--steer` choosing
behaviour, and a test asserts ordering.

### 8. A reboot abandons in-flight work *(stub)*

Boot recovery marks interrupted runs `error` — correct, but destructive: the
work is thrown away rather than resumed.

**Done when:** after a gateway or host restart, an interrupted session resumes
from pi's session file (or is offered `continue` automatically) instead of
being terminally `error`.

### 9. Recovery cannot save a timeout *(stub, by design)*

`RUN_RECOVERY_ATTEMPTS` shares one wall-clock deadline, so a run killed by
`RUN_TIMEOUT_MS` cannot be retried. That is correct for bounding retries, but it
means the most common long-job failure is unrecoverable automatically.

**Done when:** either timeouts get their own policy (bounded per-attempt retry
with a total ceiling), or the choice is documented as deliberate and `watch`
knows how to resume one.

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
| 17 | **Single host only** | one saved target in `~/.cloudbear/auth.json` | named targets, `cloudbear --target <name>` |
| 18 | **No stack self-check** | you must know the ssh/docker commands by hand | `cloudbear doctor` reports health, config, version drift and the common failure modes |
| 19 | **Telegram bridge crash-loops** | placeholder `TELEGRAM_BOT_TOKEN` on the box | ships disabled-by-default when unset, so the stack is all-healthy |
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
- **Stale `cloudbear-launch` skill** in `~/.pi` targets a different (Portainer)
  system that does not exist in this repo.

---

## Deliberately out of scope

Single VPS + docker compose + long polling is the intended shape. **Not** doing:
Kubernetes, webhooks, a mobile app, multi-tenant auth, or forking goose for
branding (talk ACP to `goose serve` instead). See `PLAN.md` for the reasoning.

---

## Quick reference

| Feature | Status | Priority |
|---|---|---|
| OpenShell sandboxing enabled | stub | P0 |
| Credential isolation via providers | missing | P0 |
| Real (gating) approvals | stub | P0 |
| `pi` in-sandbox JSON/RPC | unverified | P0 |
| Thinking visible (coalesced) | missing | P1 |
| Completion notification (`watch`) | missing | P1 |
| Queue/steer while busy | stub | P1 |
| Resume after reboot | stub | P1 |
| Retry policy for timeouts | stub | P1 |
| Token usage / cost | missing | P2 |
| Durable `get_entries` cursor | missing | P2 |
| `repo` checkout on create | missing | P2 |
| ACP adapter (goose/dots) | missing | P2 |
| Budgets + concurrency cap | missing | P2 |
| Key scopes, multi-target | missing | P2 |
| `cloudbear doctor` | missing | P2 |
| Bridge disabled without a token | stub | P2 |
| TLS recipe | partial | P2 |
