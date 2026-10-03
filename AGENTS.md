# AGENTS.md — cloudbear conventions

* Node >= 22, TypeScript strict, ESM (`NodeNext`). No new runtime deps without reason.
* Keep infra simple: single VPS, docker compose, long-polling Telegram. No K8s/webhooks in v1.
* `packages/protocol` is the contract — gateway, executor, bridge must import types from there, no duplicated shapes.
* Executor interface must stay runtime-agnostic (`pi` now, `goose`/`dots` later). No pi-specific types leaking into gateway/bridge.
* OpenShell integration is an env-gated wrapper (`OPENSHELL_ENABLED`), never hardcoded. Default off locally, on in deploy.
* Sessions are durable via pi `--session-dir` files + gateway `index.json`. Never store secrets in session files.
* Commit with `jj` frequently, small scoped commits. `jj commit -m "<scope>: <what>"`.
