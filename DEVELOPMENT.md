# Development

How to build, test, and run laun locally. Every command below has been run
on this checkout; counts and timings are measured, not aspirational.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| [Bun](https://bun.sh) | >= 1.2 (1.4.2 tested) | everything — Bun runs the TypeScript directly |
| [jj](https://jj-vcs.github.io/jj/) | 0.41 tested | version control (this repo is jj-first) |
| Docker | 28+ | `docker compose`, the Pi sandbox image, OpenShell |
| pi | 1.0.2 tested | **real agent runs only** — tests never call it |

```bash
bun install
bun run build        # tsc -b, also what CI runs
```

## Tests

```bash
bun run test         # 303 tests, 16 files, ~65s
```

**Always use `bun run test`, never bare `bun test`.** Bare `bun test` also picks
up the compiled copies under `dist/` and runs the suite **twice (606 tests,
32 files)**. The script scopes the glob to `*/src`.

Per package:

| Package | Tests | Files | Notes |
| --- | --- | --- | --- |
| `packages/protocol` | 8 | 1 | types, key format, bearer checks |
| `packages/policy` | 60 | 4 | OpenShell YAML schema limits, provider secrets, auto-approve scoping |
| `apps/executor` | 104 | 3 | spawns stub binaries; incl. thinking coalescing + usage emission, wedged-slot release, sandbox runner |
| `apps/gateway` | 26 | 5 | auth, abort, sessions, SSE; abort always pokes the executor |
| `apps/telegram-bridge` | 18 | 1 | formatting + allowlist, disabled exit, `/log`, busy-409 reply |
| `apps/laun` | 87 | 2 | flags, exit codes, ssh argv, recovery ergonomics, `watch`, `doctor`, named targets, thinking render |

### Tests need no network, no model, no pi

Every external boundary is stubbed: agent runs use shell stubs, HTTP uses
`Bun.serve` on port 0, ssh uses an injected command runner. So a fresh clone can
be fully verified offline.

### Running a subset

```bash
bun test packages/policy/src           # one package
bun test apps/executor/src/index.test.ts
bun test apps/laun/src -t "staging"     # by name
bun test apps/executor/src -t "" --timeout 60000   # longer budget
```

### Rules when adding a test

1. **It must fail when the feature is deleted.** Reviewers run this check; three
   tests were rejected across two lanes for being tautological (comparing a
   handler against a copy of itself, or asserting on a stub that never records
   the call you care about).
2. **No wall-clock sleeps where you can poll a condition.** Two tests were
   flaky in CI for exactly this reason; they now poll with a deadline.
3. **Set an explicit timeout** on anything that spawns a process — Bun's default
   per-test timeout is 5s and shell spawns under load can exceed it.

## Running the services locally

### 1. Make an env file

```bash
bun run laun -- setup --no-start
```

This writes `.env` with a fresh `GATEWAY_TOKEN` and `LAUN_KEY` (it never
overwrites existing values), and **does not** start Docker. Pass
`--env-file <path>` to write somewhere else (note the file must be named `.env`
if you want the next step to pick it up).

**Bun loads `.env` from the working directory automatically** — verified:
`bun -e 'console.log(process.env.GATEWAY_TOKEN)'` prints the file's value with
no export. So once the file exists, the commands below need no environment
prefixing at all.

### 2. Start the processes

Each service is a separate process; they talk over HTTP with the shared token.

```bash
# terminal 1 — executor, spawns the agent (port 8081)
bun run dev:executor

# terminal 2 — gateway, the API the CLI/UI/bridge use (port 8080)
bun run dev:gateway

# terminal 3 — optional, needs a real bot token from @BotFather
bun run dev:bridge
```

To override a value for a single run (or to avoid the file entirely), prefix it
explicitly — the command-line value wins over the file:

```bash
GATEWAY_TOKEN=other-token bun run dev:gateway
```

`dev:*` runs `bun run build` first, then `bun --hot` (restarts on edit).

| Service | Required env | Defaults worth knowing |
| --- | --- | --- |
| executor | `GATEWAY_TOKEN` | `EXECUTOR_PORT=8081`, `SESSION_DIR=./data/sessions`, `PI_BIN=pi`, `MODEL`, `EXECUTOR_MODE=json\|rpc`, `RUN_RECOVERY_ATTEMPTS=2`, `RUN_RECOVERY_BACKOFF_MS=2000`, `RUN_TIMEOUT_MS=600000` |
| gateway | `GATEWAY_TOKEN` | `GATEWAY_PORT=8080`, `EXECUTOR_URL=http://localhost:8081`, `DATA_DIR=./data`, `LAUN_KEY` (optional — enables agent-key auth) |
| bridge | `GATEWAY_TOKEN`, `TELEGRAM_BOT_TOKEN` | `GATEWAY_URL=http://localhost:8080`, `TELEGRAM_ALLOWLIST_IDS` (empty = ignores everyone) |

Everything else has a safe default. The gateway refuses to start without
`GATEWAY_TOKEN`, and refuses to start if `LAUN_KEY` is set but malformed.

### 3. Drive it

```bash
bun run laun -- setup --no-start          # once; gives you the agent key
bun run laun -- agent auth --host 127.0.0.1 --key <laun_...>   # saves ~/.laun/auth.json (0600)
bun run laun -- agent new "reply with PONG"
bun run laun -- agent log <id> --follow
bun run laun -- stop <id>                 # 0 running, 1 not running/unknown
bun run laun -- continue <id>             # resume a run that died
bun run laun -- list
bun run laun -- keys ls                   # needs GATEWAY_TOKEN in the env
```

The browser UI is served by the gateway at `http://127.0.0.1:8080/` — paste the
agent key.

Raw HTTP, if you prefer curl:

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" -X POST localhost:8080/sessions \
  -d '{"goal":"reply with PONG"}'
curl -H "Authorization: Bearer $GATEWAY_TOKEN" 'localhost:8080/sessions/<id>/log?since=0'
```

## Real agent runs

Tests are stubbed; a real run needs pi and provider credentials:

```bash
pi --list-models "opencode-go/muse-spark"   # does pi resolve the model?
```

pi reads `~/.pi/agent/auth.json`. If that exists, `EXECUTOR_MODE=rpc` runs one
long-lived `pi --mode rpc` child per session; `json` (the default) spawns pi
once per message and is the conservative fallback.

Smoke test, no Docker needed:

```bash
GATEWAY_TOKEN=test-token bun run dev:executor &
GATEWAY_TOKEN=test-token bun run dev:gateway &
bun run laun -- agent new "Reply with exactly: PONG"   # after auth
```

## Verifying a change end to end

The gateway logs every event to `data/events-<id>.jsonl` and the session index
to `data/index.json`, so a restart replays history and marks interrupted runs
`error` rather than leaving them `running`.

```bash
bun run build && bun run test    # the gate every change must pass
jj status                        # clean tree
jj log --no-graph -n 5           # what just landed
```

## Remote / VPS

See `deploy/remote-setup.md` for provisioning a host
(`laun setup ssh -i <key> user@host`), the SSH-tunnel access pattern, and
the gotchas from the first real bring-up. `examples/agent-keys.md` covers key
model and rotation; `examples/models.md` covers pi/model setup.

### OpenShell (sandboxing)

```bash
docker build -t pi-agent:local -f deploy/openshell/Dockerfile.pi .   # Pi image
MODEL_HOST=<host> bash deploy/openshell/install-and-verify.sh --dry-run
MODEL_HOST=<host> bash deploy/openshell/install-and-verify.sh          # prints OS_PROBE=...
```

The script is idempotent, attaches the filesystem policy at sandbox creation
(it is static; only network policy hot-reloads), probes one allowed write
against **two independently-probed** denied paths, and prints a machine-readable
`OS_SANDBOX/OS_PROVIDER/OS_POLICY/OS_GATEWAY/OS_PROBE` summary as its last
lines. It needs bun on PATH — it falls back to `~/.bun/bin` itself.

## Working in lanes (agents / parallel work)

Follows `gameboy/docs/parallel-work.md`: a lane is a **jj workspace**, never a
git worktree (a git worktree has no `.jj`, so `jj status` fails inside it).

```sh
jj workspace add ../laun-lane-<task>   # sibling of the repo, from a clean tree
```

- Write the spec to `.pi-subagents/specs/<lane>.md` **before** spawning a worker.
- One writer per seam; the integrator owns `packages/protocol`, `apps/gateway`,
  root config and all docs.
- Each lane: worker → adversarial validator (read-only, no shell) → back to the
  worker on `CHANGES REQUESTED` (3 rounds max) → integrator runs the gates and
  lands it, one lane at a time.
- Handoffs go in `.pi-subagents/handoffs/<lane>.md` in the **parent** repo
  (gitignored, shared on disk, never committed).

See `PLAN.md` for the milestone table and the DoD for each wave.

## Cleaning up

```bash
bun run clean     # removes dist/ and tsconfig.tsbuildinfo everywhere
jj workspace list # finished lanes must be forgotten, then their dir deleted
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `bun: command not found` over ssh / in a script | bun installs to `~/.bun/bin`, which is **not** on PATH for non-interactive shells. Prefix `PATH=$HOME/.bun/bin:$PATH`, or run a command that falls back itself (the OpenShell script does). |
| `bare bun test` takes twice as long / counts double | `dist/` holds compiled test copies. Use `bun run test`. |
| A dev command says `unauthorized` although `.env` exists | The file must be named exactly `.env` in the directory you run from (Bun only auto-loads that name), and a value prefixed on the command line overrides it. |
| A streaming request dies after ~10s with `curl: (18)` | Bun's `idleTimeout` defaults to 10s. Both servers set `idleTimeout: 0` (`apps/*/src/serve.ts`) — do not remove it. There is a behavioural test that fails if you do. |
| SSE disconnects immediately | Same cause; the gateway heartbeats every 15s, slower than the 10s default. |
| `laun list` exits 2 | Usage error (it needs arguments, or the command does not exist — `laun help` lists them). Exit codes: 0 ok, 1 gateway/runtime error, 2 usage. |
| Gateway says `unauthorized` | Wrong token. Services want `GATEWAY_TOKEN`; humans want an agent key. They are different credentials. |
| `session not running` from `stop` | 409 — it finished or never started. Not an error in the tooling. |
| `jj status` shows "Working copy changes" with committed work | Normal in jj: the working-copy commit *is* the commit. It is only uncommitted in the git sense. |
| A test fails in CI but passes alone | Timing. Poll for the condition with a deadline instead of sleeping; give spawn-heavy tests an explicit timeout. |
