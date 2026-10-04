# AGENTS.md — laun conventions

* Bun-only repo (`bun >= 1.2`). Run everything with `bun install`, `bun run`, `bun test`, `bun x`. No npm/node direct use.
* TypeScript strict, ESM. Bun runs `src/*.ts` directly (`bun --hot apps/...`); `tsc -b` is only for typecheck/build. No new runtime deps without reason.
* Keep infra simple: single VPS, docker compose, long-polling Telegram. No K8s/webhooks in v1.
* `packages/protocol` is the contract — gateway, executor, bridge must import types from there, no duplicated shapes.
* Executor interface must stay runtime-agnostic (`pi` now, `goose`/`dots` later). No pi-specific types leaking into gateway/bridge.
* OpenShell integration is an env-gated wrapper (`OPENSHELL_ENABLED`), never hardcoded. Default off locally, on in deploy.
* Sessions are durable via pi `--session-dir` files + gateway `index.json`. Never store secrets in session files.
* Commit with `jj` frequently, small scoped commits. `jj commit -m "<scope>: <what>"`. Bun commands only (`bun`, `bun x`, `bun test`).
