# Cloudbear

Self-hosted remote agent runner. Pi-first executor, OpenShell policy sandbox, Telegram bridge. One VPS, on 24/7.

```
Telegram / CLI / browser -> gateway -> executor (pi inside OpenShell sandbox) -> your repo/container
```

## Quick start (one command)

```bash
# from a checkout (works before the CLI is on your PATH)
bun install && bun run cli -- setup ssh -i ~/.ssh/id_ed25519 root@203.0.113.9
# ...or locally in this checkout
bun run cli -- setup

# once installed (`bun link apps/cli`), the short form works anywhere
cloudbear setup ssh -i ~/.ssh/id_ed25519 root@203.0.113.9
```

Either way it prints a connection block with a URL and a one-time **agent key**:

```
  URL   http://203.0.113.9:8080
  Key   cb_5ca79d23_1awj…
  UI    http://203.0.113.9:8080/   (paste the key)

cloudbear agent auth --host 203.0.113.9 --key cb_5ca79d23_1awj…
cloudbear agent new "fix the failing tests"
cloudbear agent log <id> --follow
```

See `deploy/remote-setup.md` for flags, prerequisites, and troubleshooting, and
`examples/agent-keys.md` for how the key is stored and rotated.

### Browser UI

Open `http://<host>:8080/` and paste the agent key: session list, live
transcript, new session, follow-up messages, and approve/deny buttons.

### Remote control (CLI)

```bash
cloudbear agent auth --host <host> --key <cb_...>   # verify + save (0600)
cloudbear agent new "<goal>" [--model <m>]
cloudbear agent ls | status <id> | log <id> [--follow] | say <id> "<text>"
cloudbear agent approve <id> <requestId> | deny <id> <requestId>
cloudbear keys ls | create [--label <l>] | revoke <id>   # needs GATEWAY_TOKEN
```

## Quick start (manual, VPS)

```bash
git clone <this-repo> cloudbear && cd cloudbear
cp deploy/.env.example .env   # fill in TELEGRAM_BOT_TOKEN, GATEWAY_TOKEN, allowlist
chmod +x deploy/install.sh && ./deploy/install.sh
```

`install.sh` installs Bun/Docker/pi/OpenShell (best-effort), then runs
`docker compose -f deploy/docker-compose.yml --env-file .env up -d --build`.
Containers restart automatically (`unless-stopped`) — that plus the Docker
daemon starting at boot is the whole 24/7 story. Sessions live in the
`cloudbear-data` volume (`/data/sessions` + gateway `index.json`).

Useful:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env logs -f
curl localhost:8080/health && curl localhost:8081/health
WORKDIR=/data/sessions/<id>/work MODEL_HOST=YOUR_MODEL_HOST bun packages/policy/src/render.ts restrictive
```

Model setup (Muse via opencode-go): see `examples/models.md`.
OpenShell policy mapping: see `examples/openshell-policy-notes.md`.
Roadmap and verified harness findings: see `PLAN.md`; the forward-looking
backlog of **unimplemented features**, each with its evidence and definition of
done, is in [`docs/roadmap.md`](docs/roadmap.md).

## Local dev (Bun-only)

Full walkthrough — tests, running the three services, the CLI, real agent runs,
lanes, and every gotcha found so far: **[DEVELOPMENT.md](DEVELOPMENT.md)**.

```bash
bun install
bun run build
bun run test        # 211 tests / 14 files. Never bare `bun test` (it doubles)
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
* `apps/executor` — spawns `pi -p --mode json` per session, streams JSONL events. Wraps with OpenShell when `OPENSHELL_ENABLED=true`.
* `apps/gateway` — tiny HTTP API + SSE + agent-key management. Serves the browser UI from `apps/gateway/public`.
* `apps/telegram-bridge` — grammY long-polling bot, allowlisted user IDs only.
* `apps/cli` — the `cloudbear` command: local/remote setup, agent auth, and agent/key control.
* `deploy/` — compose, env example, install script, remote bootstrap, remote setup guide.
* `examples/` — model setup, OpenShell policy notes, agent keys.

## API (gateway :8080)

Auth: `Authorization: Bearer <token>`, where the token is either `GATEWAY_TOKEN`
(internal services) or an agent key `cb_<id>_<secret>` (CLI and browser).

* `POST /sessions` `{ goal, repo?, model? }` -> the full session record (201)
* `GET /sessions` -> `{ sessions: [...] }`
* `GET /sessions/:id` -> `{ session, pendingApprovals }`
* `POST /sessions/:id/messages` `{ text }` -> `{ accepted: true }` (409 when busy)
* `GET /sessions/:id/log?since=N` -> `{ events, next }` (polling)
* `GET /sessions/:id/events` (SSE) — executor output, tool calls, approval requests
* `POST /sessions/:id/approvals` `{ requestId, decision: "approve"|"deny" }`
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
* Pi never sees provider keys directly when OpenShell is on — keys live on gateway/host, injected only for approved endpoints.
* Policy escalations surface as approval events; default deny on timeout.
* The gateway speaks plain HTTP: put it behind TLS or a private network before
  exposing it to the internet.
* Durability: pi session files + gateway `index.json` + per-session `events-<id>.jsonl`
  all live under `/data` (persisted volume). A gateway restart replays logs and
  marks interrupted runs `error` so nothing stays `running` forever.
