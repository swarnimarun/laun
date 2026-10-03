# Cloudbear

Self-hosted remote agent runner. Pi-first executor, OpenShell policy sandbox, Telegram bridge. One VPS, on 24/7.

```
Telegram -> bridge -> gateway -> executor (pi inside OpenShell sandbox) -> your repo/container
```

## Quick start (VPS)

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

## Local dev (Bun-only)

```bash
bun install
bun run build
bun test
```

Run each service locally (needs `pi` on PATH + `.env`):

```bash
bun run dev:executor   # :8081 (builds first, then --hot)
bun run dev:gateway    # :8080
bun run dev:bridge     # long-polling Telegram
```

## Layout

* `packages/protocol` — shared types + validation for gateway/executor/bridge. Executor interface supports pi now, goose/dots later.
* `packages/policy` — OpenShell policy templates (restrictive default).
* `apps/executor` — spawns `pi -p --mode json` per session, streams JSONL events. Wraps with OpenShell when `OPENSHELL_ENABLED=true`.
* `apps/gateway` — tiny HTTP API + SSE. Auth: `Authorization: Bearer $GATEWAY_TOKEN`. Keeps session index.
* `apps/telegram-bridge` — grammY long-polling bot, allowlisted user IDs only.
* `deploy/` — compose, env example, install script, systemd unit.
* `examples/` — model setup (Muse via opencode-go), OpenShell policy notes.

## API (gateway :8080)

* `POST /sessions` `{ goal, repo?, model? }` -> `{ sessionId }`
* `POST /sessions/:id/messages` `{ text }` -> `{ accepted: true }`
* `GET /sessions/:id/events` (SSE) — executor output, tool calls, approval requests
* `POST /sessions/:id/approvals` `{ requestId, decision: "approve"|"deny" }`
* `GET /health`

Executor on `:8081`: `POST /run` (gateway only, same bearer token).

## Security model

* Telegram allowlist (`TELEGRAM_ALLOWLIST_IDS`). Unknown users get no response.
* Gateway bearer token shared by bridge + executor. Rotate in `.env`.
* Pi never sees provider keys directly when OpenShell is on — keys live on gateway/host, injected only for approved endpoints.
* Policy escalations surface as approval events; default deny on timeout.
* Durability: pi session files + gateway `index.json` + per-session `events-<id>.jsonl`
  all live under `/data` (persisted volume). A gateway restart replays logs and
  marks interrupted runs `error` so nothing stays `running` forever.
