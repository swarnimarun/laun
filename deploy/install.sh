#!/usr/bin/env bash
# Laun VPS bootstrap (Debian/Ubuntu). Idempotent: safe to re-run.
#
# Usage:
#   ./deploy/install.sh                  # build the image from this checkout
#   LAUN_TAG=0.1.0 ./deploy/install.sh   # pull the released image from GHCR
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
  curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh || echo "OpenShell install failed — isolated setup still requires a provisioned gateway identity"
fi

# LAUN_TAG set = deploy released images (no local build); unset = build from this checkout.
if [ -z "${LAUN_TAG:-}" ]; then
  echo "==> Bun install"
  bun install
fi

if [ ! -f .env ]; then
  echo "==> Creating .env from deploy/.env.example (EDIT IT NOW)"
  cp deploy/.env.example .env
  # This is the VPS installer. Local `laun setup` keeps its own default off.
  sed -i 's/^OPENSHELL_ENABLED=.*/OPENSHELL_ENABLED=true/' .env
  echo "    Fill in GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST_IDS."
  echo "    Model auth comes from this host's pi login (~/.pi/agent/auth.json) — see examples/models.md."
fi

source "$REPO_DIR/deploy/compose-profile.sh"
laun_compose_profile "$REPO_DIR/.env" "$REPO_DIR/deploy/docker-compose.yml" true
COMPOSE=(docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env)
"${COMPOSE[@]}" config --quiet

if [ -n "${LAUN_TAG:-}" ]; then
  echo "==> Pulling released images (LAUN_TAG=$LAUN_TAG)"
  "${COMPOSE[@]}" pull
  "${COMPOSE[@]}" up -d
else
  echo "==> Typecheck + tests"
  bun run build
  bun run test

  echo "==> Building the image from this checkout"
  "${COMPOSE[@]}" up -d --build
fi
"${COMPOSE[@]}" logs --tail=50

UPS='up -d --build'
if [ -n "${LAUN_TAG:-}" ]; then UPS='up -d'; fi
echo ""
echo "Done. Next:"
echo "  1. Edit .env (tokens, allowlist, MODEL)"
echo "  2. ${COMPOSE[*]} $UPS"
echo "  3. curl localhost:8080/health && curl localhost:8081/health"
echo "  4. Message your Telegram bot: /new fix failing tests"
