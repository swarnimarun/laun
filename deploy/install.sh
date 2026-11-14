#!/usr/bin/env bash
# Laun VPS bootstrap (Debian/Ubuntu). Local Nix/WSL development uses shell.nix.
# Usage: ./deploy/install.sh, or LAUN_TAG=0.1.0 ./deploy/install.sh for images.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
need() { command -v "$1" >/dev/null 2>&1; }
echo "==> Checking prerequisites"
if ! need curl; then sudo apt-get update && sudo apt-get install -y curl ca-certificates git unzip; fi
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
  echo "==> Installing pinned Pi 1.5.2 with Bun"
  bun add --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.2
  install -d -m 755 "$HOME/.local/bin"
  pi_package="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
  rm -f "$HOME/.local/bin/pi"
  printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$pi_package" > "$HOME/.local/bin/pi"
  chmod 755 "$HOME/.local/bin/pi"
  export PATH="$HOME/.local/bin:$PATH"
  pi --version
fi
if ! need openshell; then
  echo "==> Installing pinned OpenShell v0.1.8"
  openshell_installer="$(mktemp)"
  trap 'rm -f "$openshell_installer"' EXIT
  curl -fLsS https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.8/install.sh -o "$openshell_installer"
  OPENSHELL_VERSION=v0.1.8 sh "$openshell_installer"
  rm -f "$openshell_installer"
  trap - EXIT
fi
if [ -z "${LAUN_TAG:-}" ]; then bun install --frozen-lockfile; fi
if [ ! -f .env ]; then
  echo "==> Creating private .env with fresh controller and bridge credentials"
  bun deploy/prepare-env.ts
  echo "    Fill in credentials, allowlist, host OpenShell identity and PI_CONTROLLER_AUTH_DIR."
fi
source "$REPO_DIR/deploy/compose-profile.sh"
laun_compose_profile "$REPO_DIR/.env" "$REPO_DIR/deploy/docker-compose.yml" true
COMPOSE=(docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env)
"${COMPOSE[@]}" config --quiet
if [ -n "${LAUN_TAG:-}" ]; then
  "${COMPOSE[@]}" pull
  "${COMPOSE[@]}" up -d
else
  bun run build
  bun run test
  "${COMPOSE[@]}" up -d --build
fi
"${COMPOSE[@]}" logs --tail=50
echo "Open the gateway through an SSH tunnel. Verify authenticated runtime readiness and a real sandbox denial before unattended work."
