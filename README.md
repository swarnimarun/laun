# Laun

Self-hosted remote agent runner. Pi-first executor, OpenShell policy sandbox, Telegram bridge. One VPS, on 24/7.

```
Telegram / CLI / browser -> gateway -> executor (pi via rpc) -> your repo/container
```

Sandboxing (OpenShell) is built but disabled: the executor can already
create per-session sandboxes and run one-shot commands inside them, but
long-lived rpc needs the SDK transport and session files need a workdir
mapping first — see `docs/roadmap.md` P0. `OPENSHELL_ENABLED` stays `false`
until then.

## Quick start (one command)

Prerequisites: Bun >= 1.2, an SSH key on a Ubuntu VPS with Docker, and (for
the agent to do anything) `pi` with a configured model. Providers firewall
port 8080, so every remote command below goes through a tunnel — open it once
and leave it running:

```bash
ssh -f -N -L 18080:localhost:8080 -i ~/.ssh/id_ed25519 ubuntu@<vps>
```

```bash
# from a checkout (works before the CLI is on your PATH)
bun install && bun run laun -- setup ssh -i ~/.ssh/id_ed25519 ubuntu@<vps>
# ...or locally in this checkout
bun run laun -- setup

# once installed (`bun link apps/laun`), the short form works anywhere
laun setup ssh -i ~/.ssh/id_ed25519 ubuntu@<vps>
```

Either way it prints a connection block with a URL and a one-time **agent key**
(shown once, stored hashed — save it now):

```
  URL   http://127.0.0.1:18080
  Key   laun_01234567_XXXX…
  UI    http://127.0.0.1:18080/   (paste the key)

laun agent auth --host 127.0.0.1 --port 18080 --key laun_01234567_XXXX…
laun agent new "fix the failing tests"
laun agent watch <id>   # blocks until done; exit code is the outcome
```

See `deploy/remote-setup.md` for flags, prerequisites, and troubleshooting, and
`examples/agent-keys.md` for how the key is stored and rotated.

### Browser UI

Open `http://127.0.0.1:18080/` (over the tunnel — port 8080 is firewalled)
and paste the agent key: session list, live transcript, new session,
follow-up messages, and approve/deny buttons.

### Remote control (CLI)

```bash
laun agent auth --host <host> --key <laun_...>   # verify + save (0600)
laun agent new "<goal>" [--model <m>]
laun agent ls | status <id> | log <id> [--follow] | say <id> "<text>"
laun agent watch <id> [--timeout 30m]   # block until settled: 0 done, 1 error, 2 timeout
laun agent stop <id> | continue <id>    # kill a runaway; resume a dead one
laun agent approve <id> <requestId> | deny <id> <requestId>
laun doctor                             # self-check: target, key, gateway
laun target ls | add <name> --host ...  # named hosts, --target <name> anywhere
laun keys ls | create [--label <l>] | revoke <id>   # needs GATEWAY_TOKEN
```

Telegram (when `TELEGRAM_BOT_TOKEN` is set; otherwise the bridge exits 0,
disabled): `/new`, `/status <id>`, `/log <id> [n]`, `/approve`, `/deny` —
plain text follows up on your latest session.

## Quick start (manual, VPS)

```bash
git clone git@github.com:swarnimarun/laun.git laun && cd laun && git checkout v1
cp deploy/.env.example .env   # fill in TELEGRAM_BOT_TOKEN, GATEWAY_TOKEN, allowlist
chmod +x deploy/install.sh && ./deploy/install.sh
```

`install.sh` installs Bun/Docker/pi/OpenShell (best-effort), then runs
`docker compose -f deploy/docker-compose.yml --env-file .env up -d --build`.
Containers restart automatically (`unless-stopped`) — that plus the Docker
daemon starting at boot is the whole 24/7 story. Sessions live in the
`laun-data` volume (`/data/sessions` + gateway `index.json`).

### Deploy a release

Tagged releases publish multi-arch images to GHCR and CLI binaries on the
GitHub Release (design + runbook: [`docs/releases.md`](docs/releases.md)). Pin
the version and let compose pull instead of build:

```bash
cp deploy/.env.example .env          # fill in tokens
echo "LAUN_TAG=0.1.0" >> .env        # stays pinned for later compose runs
LAUN_TAG=0.1.0 ./deploy/install.sh   # or: docker compose ... pull && up -d
```

GHCR packages are private for personal accounts by default: either flip both
packages to public in their package settings, or log the box in once
(`docker login ghcr.io -u <user> -p <PAT with read:packages>`). The OpenShell
sandbox image ships on the same tags; fetch it when enabling sandboxing with
`docker compose --profile sandbox pull`.

Useful:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env logs -f
curl localhost:8080/health && curl localhost:8081/health
WORKDIR=/data/sessions/<id>/work MODEL_HOST=YOUR_MODEL_HOST bun packages/policy/src/render.ts restrictive
```

Model setup (Muse via opencode-go): see `examples/models.md`.
OpenShell policy mapping: see `examples/openshell-policy-notes.md`.
Roadmap and verified harness findings: the forward-looking backlog of
**unimplemented features**, each with its evidence and definition of done,
is in [`docs/roadmap.md`](docs/roadmap.md).

## Local dev (Bun-only)

Full walkthrough — tests, running the three services, the CLI, real agent runs,
lanes, and every gotcha found so far: **[DEVELOPMENT.md](DEVELOPMENT.md)**.

```bash
bun install
bun run build
bun run test        # 303 tests / 16 files. Never bare `bun test` (it doubles)
```

Run each service locally (needs `pi` on PATH + `.env`):

```bash
bun run dev:executor   # :8081 (builds first, then --hot)
bun run dev:gateway    # :8080
bun run dev:bridge     # long-polling Telegram
```

## Layout

* `packages/protocol` — shared types + validation for gateway/executor/bridge/CLI. Executor interface supports pi now, goose/dots later.
* `packages/policy` — OpenShell policy templates (restrictive default).
* `apps/executor` — one long-lived `pi --mode rpc` child per session (json
  one-shot fallback), streamed JSONL events, abort, self-healing retry, and a
  wedged slot can never need a restart again. Sandbox execution is implemented
  behind `OPENSHELL_ENABLED` (off until the SDK transport + workdir mapping
  land — `docs/roadmap.md` has the proof log).
* `apps/gateway` — tiny HTTP API + SSE + agent-key management. Serves the browser UI from `apps/gateway/public`.
* `apps/telegram-bridge` — grammY long-polling bot, allowlisted user IDs only.
* `apps/laun` — the `laun` command: local/remote setup, agent auth, and agent/key control.
* `deploy/` — compose, env example, install script, remote bootstrap, remote setup guide.
* `examples/` — model setup, OpenShell policy notes, agent keys.

## API (gateway :8080)

Auth: `Authorization: Bearer <token>`, where the token is either `GATEWAY_TOKEN`
(internal services) or an agent key `laun_<id>_<secret>` (CLI and browser).

* `POST /sessions` `{ goal, repo?, model? }` -> the full session record (201)
* `GET /sessions` -> `{ sessions: [...] }`
* `GET /sessions/:id` -> `{ session, pendingApprovals }`
* `POST /sessions/:id/messages` `{ text }` -> `{ accepted: true }` (409 when busy)
* `GET /sessions/:id/log?since=N` -> `{ events, next }` (polling)
* `GET /sessions/:id/events` (SSE) — executor output, tool calls, approval requests
* `POST /sessions/:id/abort` — stop the run (200 ok; 409 not running).
  `stop` always asks the executor, so a wedged slot is reachable even when
  the record says idle.
* `POST /sessions/:id/approvals` `{ requestId, decision: "approve"|"deny" }`
  — recorded and broadcast (acknowledge-only today; real gating is roadmap P0)
* `POST /keys` `{ label? }` -> `{ key, record }` — service token only
* `GET /keys` -> `{ keys }` — service token only
* `DELETE /keys/:id` — service token only
* `GET /` and `GET /ui/*` — browser UI assets (public; the API behind them is not)
* `GET /health` — public

Executor on `:8081`: `POST /run` (gateway only, same service token).

## Security model

* Telegram allowlist (`TELEGRAM_ALLOWLIST_IDS`). Unknown users get no response.
* Two credentials: `GATEWAY_TOKEN` for services (bridge, executor, key
  management) and agent keys for people (CLI, browser). Agent keys can create
  sessions but cannot mint or revoke keys, so a leak is contained.
* Agent keys are stored as sha256 hashes in `data/keys.json` (0600); the
  plaintext is printed once by `setup` and never retrievable afterwards.
* Pi never sees provider keys directly — that is the design once a model key
  is provisioned through an OpenShell provider (not yet: no model key on the
  box, placeholder-only inside sandboxes).
* Policy escalations surface as approval events; timeout-deny-by-default is
  the rule the real gating will enforce (`extension_ui` round-trip, roadmap P0).
  Today nothing gates the agent — approvals record a human decision.
* The gateway speaks plain HTTP: put it behind TLS or a private network before
  exposing it to the internet.
* Durability: pi session files + gateway `index.json` + per-session `events-<id>.jsonl`
  all live under `/data` (persisted volume). A gateway restart replays logs and
  marks interrupted runs `error` so nothing stays `running` forever.
