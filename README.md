# Cloudbear

Self-hosted remote agent runner. Pi-first executor, OpenShell policy sandbox, Telegram bridge. One VPS, on 24/7.

```
Telegram -> bridge -> gateway -> executor (pi inside OpenShell sandbox) -> your repo/container
```

## Quick start (VPS)

```bash
git clone <this-repo> cloudbear && cd cloudbear
cp deploy/.env.example .env   # fill in TELEGRAM_BOT_TOKEN, GATEWAY_TOKEN, model keys
./deploy/install.sh           # installs node 22, pi, openshell, docker; runs compose
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

Single VPS only for v1. No K8s. Sessions live in `./data/sessions` (mount this to a volume).

## Local dev

```bash
npm install
npm run build
npm run test
```

Run each service locally (needs `pi` on PATH + `.env`):

```bash
npm run dev:executor   # :8081
npm run dev:gateway    # :8080
npm run dev:bridge     # long-polling Telegram
```

## Layout

* `packages/protocol` — shared types + validation for gateway/executor/bridge. Executor interface supports pi now, goose/dots later.
* `packages/policy` — OpenShell policy templates (restrictive default).
* `apps/executor` — spawns `pi -p --mode json` per session, streams JSONL events. Wraps with OpenShell when `OPENSHELL_ENABLED=true`.
* `apps/gateway` — tiny HTTP API + SSE. Auth: `Authorization: Bearer $GATEWAY_TOKEN`. Keeps session index.
* `apps/telegram-bridge` — grammY long-polling bot, allowlisted user IDs only.
* `deploy/` — compose, env example, install script, systemd unit.
* `examples/` — Grok provider config, pi extension wiring.

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
