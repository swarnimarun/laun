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
LAUN_BUN_BIN="$(bash "$REPO_DIR/deploy/install-bun.sh")"
export PATH="$(dirname "$LAUN_BUN_BIN"):$PATH"
export LAUN_TOOLS_DIR="${LAUN_TOOLS_DIR:-$HOME/.local/share/laun/tools}"
if ! need pi || ! pi --version 2>/dev/null | grep -Eq '(^|[[:space:]])1\.5\.2([[:space:]]|$)'; then
  echo "==> Installing pinned Pi 1.5.2 with Bun"
  pi_root="$LAUN_TOOLS_DIR/pi/1.5.2"
  [ ! -e "$pi_root" ] || { echo "Inspect the existing Pi tool cache before retrying: $pi_root" >&2; exit 1; }
  install -d -m 755 "$pi_root/bin"
  printf '%s\n' '{"private":true,"dependencies":{"@earendil-works/pi-coding-agent":"1.5.2"}}' > "$pi_root/package.json"
  (cd "$pi_root" && "$LAUN_BUN_BIN" install --ignore-scripts)
  pi_package="$pi_root/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
  # Values stay data even when an installation path contains shell punctuation.
  "$LAUN_BUN_BIN" -e 'const quote=v=>"\x27"+v.replaceAll("\x27","\x27\\\x27\x27")+"\x27";await Bun.write(process.argv[1],"#!/bin/sh\nexec "+quote(process.argv[2])+" "+quote(process.argv[3])+" \"$@\"\n");' "$pi_root/bin/pi" "$LAUN_BUN_BIN" "$pi_package"
  chmod 755 "$pi_root/bin/pi"
  export PATH="$pi_root/bin:$PATH"
  pi --version
fi
if ! need openshell || ! openshell --version 2>/dev/null | grep -Eq '(^|[[:space:]])0\.1\.8([[:space:]]|$)'; then
  echo "==> Installing pinned OpenShell v0.1.8"
  openshell_dir="$LAUN_TOOLS_DIR/openshell/0.1.8/bin"
  [ ! -e "$openshell_dir/openshell" ] || { echo "Inspect the existing OpenShell tool cache before retrying: $openshell_dir" >&2; exit 1; }
  bash "$REPO_DIR/deploy/openshell/install-cli.sh" "$openshell_dir"
  export PATH="$openshell_dir:$PATH"
fi
if [ ! -f .env ]; then
  echo "==> Creating private .env with fresh controller and bridge credentials"
  bun deploy/prepare-env.ts
  echo "    Fill in credentials, allowlist, host OpenShell identity and PI_CONTROLLER_AUTH_DIR."
fi
SERVICE_IMAGE="$(bun -e 'import {readEnvValue} from "./apps/laun/src/compose-profile.ts";console.log(process.env.LAUN_SERVICE_IMAGE??readEnvValue(await Bun.file(".env").text(),"LAUN_SERVICE_IMAGE")??"");')"
PULL_ONLY=false
if [ -n "${LAUN_TAG:-}" ] || [ -n "$SERVICE_IMAGE" ]; then PULL_ONLY=true; fi
if [ "$PULL_ONLY" = false ]; then bun install --frozen-lockfile --ignore-scripts; fi
source "$REPO_DIR/deploy/compose-profile.sh"
laun_compose_profile "$REPO_DIR/.env" "$REPO_DIR/deploy/docker-compose.yml" true
COMPOSE=(docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env)
"${COMPOSE[@]}" config --quiet
if [ "$PULL_ONLY" = true ]; then
  "${COMPOSE[@]}" pull
  CONTRACT_SCRIPT="$(cat "$REPO_DIR/deploy/controller-contract.js")"
  QUALIFY_IMAGE="$(bun -e 'import {readEnvValue} from "./apps/laun/src/compose-profile.ts";const text=await Bun.file(".env").text();console.log(process.env.LAUN_SERVICE_IMAGE||readEnvValue(text,"LAUN_SERVICE_IMAGE")||`${process.env.LAUN_IMAGE||readEnvValue(text,"LAUN_IMAGE")||"ghcr.io/swarnimarun/laun"}:${process.env.LAUN_TAG||readEnvValue(text,"LAUN_TAG")||"latest"}`);')"
  echo "==> Qualifying the pulled controller without production data, credentials or network"
  timeout 60 docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 512m --cpus 1 --tmpfs /tmp:rw,nosuid,nodev,size=96m --env HOME=/tmp --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-transpile --entrypoint bun "$QUALIFY_IMAGE" -e "$CONTRACT_SCRIPT" /app \
    || { echo "Pulled image lacks the required v2 owner/durable/inference contract; existing data was not mounted and stack was not started" >&2; exit 1; }
  "${COMPOSE[@]}" up -d --no-build
else
  bun run build
  bun run test
  "${COMPOSE[@]}" up -d --build
fi
"${COMPOSE[@]}" logs --tail=50
echo "Open the gateway through an SSH tunnel. Verify authenticated runtime readiness and a real sandbox denial before unattended work."
