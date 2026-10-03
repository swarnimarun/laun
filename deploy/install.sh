#!/usr/bin/env bash
# Cloudbear VPS bootstrap (Debian/Ubuntu). Idempotent: safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

need() { command -v "$1" >/dev/null 2>&1; }

echo "==> Checking prerequisites"
if ! need curl; then sudo apt-get update && sudo apt-get install -y curl ca-certificates git; fi
if ! need docker; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi
if ! need bun; then
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
if ! need pi; then
  echo "==> Installing pi"
  curl -fsSL https://pi.dev/install.sh | sh
  export PATH="$HOME/.pi/bin:$HOME/.local/bin:$PATH"
fi
if ! need openshell; then
  echo "==> Installing OpenShell (best-effort)"
  curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh || echo "OpenShell install failed — continuing with OPENSHELL_ENABLED=false"
fi

echo "==> Bun install"
bun install

if [ ! -f .env ]; then
  echo "==> Creating .env from deploy/.env.example (EDIT IT NOW)"
  cp deploy/.env.example .env
  echo "    Fill in GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST_IDS."
  echo "    Model auth comes from this host's pi login (~/.pi/agent/auth.json) — see examples/models.md."
fi

echo "==> Typecheck + tests"
bun run build
bun test

echo "==> Starting stack"
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.yml --env-file .env logs --tail=50

echo ""
echo "Done. Next:"
echo "  1. Edit .env (tokens, allowlist, MODEL)"
echo "  2. docker compose -f deploy/docker-compose.yml --env-file .env up -d --build"
echo "  3. curl localhost:8080/health && curl localhost:8081/health"
echo "  4. Message your Telegram bot: /new fix failing tests"
