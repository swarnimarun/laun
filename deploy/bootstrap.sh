#!/usr/bin/env bash
# Cloudbear remote bootstrap. Invoked over SSH by `cloudbear setup ssh`:
#
#   ssh -i <key> -o BatchMode=yes <user>@<host> \
#     CB_NO_START=false bash -s -- <remote-dir> [repo-url]
#
# The caller MUST have written <remote-dir>/.env (mode 600, containing at least
# GATEWAY_TOKEN and CLOUDBEAR_KEY) before this runs. Idempotent: safe to re-run.
#
# Output: progress lines prefixed "==>", then a summary whose LAST line is the
# agent key so the CLI can read it back:
#   CLOUDBEAR_DIR=...
#   CLOUDBEAR_PORT=...
#   CLOUDBEAR_KEY=...
# GATEWAY_TOKEN is never printed.
set -euo pipefail

REMOTE_DIR="${1:-}"
REPO_URL="${2:-}"

log() { printf '==> %s\n' "$*"; }
warn() { printf '==> WARNING: %s\n' "$*" >&2; }
die() {
  printf '==> ERROR: %s\n' "$*" >&2
  exit 1
}

[ -n "$REMOTE_DIR" ] || die "usage: bash bootstrap.sh <remote-dir> [repo-url]"
[ -d "$REMOTE_DIR" ] || die "remote dir does not exist: $REMOTE_DIR (create it and write .env first)"
REMOTE_DIR="$(cd "$REMOTE_DIR" && pwd)"
ENV_FILE="$REMOTE_DIR/.env"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE — write it before bootstrapping (cloudbear setup ssh does this)"

# The checkout may overwrite .env, so keep the authoritative copy aside.
ENV_BACKUP="$(mktemp)"
CLONE_TMP=""
cleanup() {
  rm -f "$ENV_BACKUP"
  [ -n "$CLONE_TMP" ] && rm -rf "$CLONE_TMP"
  return 0
}
trap cleanup EXIT
cp "$ENV_FILE" "$ENV_BACKUP"
chmod 600 "$ENV_FILE"

# --- privileges -----------------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "this script needs root or passwordless sudo"
  SUDO="sudo"
fi

APT_UPDATED=0
apt_update_once() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    $SUDO apt-get update -y >/dev/null 2>&1 || warn "apt-get update failed"
    APT_UPDATED=1
  fi
}

# --- prerequisites --------------------------------------------------------------
# unzip is not optional: bun's own installer hard-fails without it.
PREREQS="curl ca-certificates git unzip"
missing_prereqs=""
for p in $PREREQS; do
  case "$p" in
    ca-certificates) dpkg -s ca-certificates >/dev/null 2>&1 || missing_prereqs="$missing_prereqs $p" ;;
    *) command -v "$p" >/dev/null 2>&1 || missing_prereqs="$missing_prereqs $p" ;;
  esac
done
if [ -n "$missing_prereqs" ]; then
  log "installing prerequisites:$missing_prereqs"
  apt_update_once
  $SUDO apt-get install -y --no-install-recommends $missing_prereqs >/dev/null \
    || die "could not install:$missing_prereqs"
fi

# --- docker ---------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing docker"
  curl -fsSL https://get.docker.com -o /tmp/cloudbear-get-docker.sh || die "could not download the docker installer"
  $SUDO sh /tmp/cloudbear-get-docker.sh >/dev/null || die "docker install failed"
  rm -f /tmp/cloudbear-get-docker.sh
fi
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "could not enable docker through systemctl"
elif command -v service >/dev/null 2>&1; then
  $SUDO service docker start >/dev/null 2>&1 || warn "could not start docker through service"
fi
# Add the invoking user to the docker group.
# SUDO_USER is only set when this script runs *under* sudo. When a normal login
# user runs it directly — the common case — it is empty, and skipping this left
# the user without docker socket access. On a real VPS that made OpenShell's
# gateway fail with "no compute driver configured and auto-detection found",
# because it could not reach the docker socket to detect the driver at all.
if [ "$(id -u)" -ne 0 ]; then
  INVOKING_USER="${SUDO_USER:-$(id -un)}"
  if $SUDO usermod -aG docker "$INVOKING_USER" >/dev/null 2>&1; then
    log "added $INVOKING_USER to the docker group"
  else
    warn "could not add $INVOKING_USER to the docker group — docker commands may need sudo"
  fi
  # Group membership is fixed at session start, so anything already running
  # (systemd user services in particular) keeps the old, access-less set.
  if ! id -nG | tr ' ' '\n' | grep -qx docker; then
    warn "this session predates the group change: re-login, and restart user services, for docker access to take effect"
  fi
fi

# --- bun ------------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  log "installing bun"
  curl -fsSL https://bun.sh/install | bash >/tmp/bun-install.log 2>&1 \
    || { tail -5 /tmp/bun-install.log >&2; die "the bun installer failed (bun needs unzip; see the log above)"; }
fi
export PATH="$HOME/.bun/bin:$PATH"

# --- source tree ----------------------------------------------------------------
if [ -f "$REMOTE_DIR/package.json" ]; then
  log "reusing existing checkout at $REMOTE_DIR"
  if [ -n "$REPO_URL" ] && [ -d "$REMOTE_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    git -C "$REMOTE_DIR" pull --ff-only >/dev/null 2>&1 || warn "git pull failed — continuing with the local checkout"
  fi
else
  [ -n "$REPO_URL" ] \
    || die "no checkout at $REMOTE_DIR and no repo url given: rsync the repo there, or re-run with --repo-url <git-url>"
  log "cloning $REPO_URL"
  CLONE_TMP="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$CLONE_TMP/repo" >/dev/null 2>&1 || die "git clone $REPO_URL failed"
  shopt -s dotglob
  mv "$CLONE_TMP/repo"/* "$REMOTE_DIR"/ || die "could not move the checkout into $REMOTE_DIR"
  shopt -u dotglob
fi

# The pre-written env file wins over anything the checkout brought along.
cp "$ENV_BACKUP" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- build ----------------------------------------------------------------------
if [ -x "$REMOTE_DIR/node_modules/.bin/tsc" ] || command -v bun >/dev/null 2>&1; then
  log "installing dependencies"
  (cd "$REMOTE_DIR" && bun install --frozen-lockfile) || warn "bun install of dependencies failed — continuing"
  log "typechecking"
  (cd "$REMOTE_DIR" && bun run build) || warn "bun run build failed — continuing"
fi

# --- start ----------------------------------------------------------------------
GATEWAY_PORT="$(sed -n 's/^GATEWAY_PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -1)"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"

if [ "${CB_NO_START:-false}" = "true" ]; then
  log "CB_NO_START=true — leaving the stack stopped"
else
  # `sudo docker compose` sets HOME=/root, which would make compose bind-mount
  # /root/.pi (empty) instead of the operator's pi credentials. Resolve the real
  # home and hand compose an explicit PI_CONFIG_DIR. It must end in /.pi — a
  # bare home directory would mount the whole home (ssh keys included).
  REAL_USER="${SUDO_USER:-$(id -un)}"
  PI_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
  [ -n "$PI_HOME" ] || PI_HOME="$(eval echo "~$REAL_USER")"
  PI_CONFIG_DIR="${PI_CONFIG_DIR:-$PI_HOME/.pi}"
  case "$PI_CONFIG_DIR" in
    *.pi) ;;
    *) PI_CONFIG_DIR="$PI_CONFIG_DIR/.pi" ;;
  esac
  if [ ! -f "$PI_CONFIG_DIR/agent/auth.json" ]; then
    warn "no pi credentials at $PI_CONFIG_DIR/agent/auth.json — every session will fail until pi is logged in on this host (run pi once and /login)"
  fi

  # Persist the resolved path so ANY later invocation — including a manual
  # `docker compose up` that never goes through this script — resolves the same
  # mount. Without this, compose falls back to ${HOME} which is /root under sudo.
  if grep -q '^PI_CONFIG_DIR=' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^PI_CONFIG_DIR=.*|PI_CONFIG_DIR=$PI_CONFIG_DIR|" "$ENV_FILE"
  else
    printf '\nPI_CONFIG_DIR=%s\n' "$PI_CONFIG_DIR" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  log "starting the stack (docker compose up -d --build)"
  (cd "$REMOTE_DIR" && $SUDO env PI_CONFIG_DIR="$PI_CONFIG_DIR" docker compose -f deploy/docker-compose.yml --env-file .env up -d --build) \
    || die "docker compose up failed — inspect: cd $REMOTE_DIR && docker compose logs"
  healthy=0
  for _ in $(seq 1 20); do
    if curl -fsS "http://localhost:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 3
  done
  if [ "$healthy" = "1" ]; then
    log "gateway is healthy on port ${GATEWAY_PORT}"
  else
    warn "gateway health check did not pass yet — check: cd $REMOTE_DIR && docker compose logs"
  fi
fi

# --- summary (last line is the agent key) ---------------------------------------
CLOUDBEAR_KEY="$(sed -n 's/^CLOUDBEAR_KEY=\(.*\)$/\1/p' "$ENV_FILE" | tail -1 | tr -d '[:space:]')"
[ -n "$CLOUDBEAR_KEY" ] || die "no CLOUDBEAR_KEY in $ENV_FILE — run cloudbear setup to generate one"

log "done"
printf 'CLOUDBEAR_DIR=%s\n' "$REMOTE_DIR"
printf 'CLOUDBEAR_PORT=%s\n' "$GATEWAY_PORT"
printf 'CLOUDBEAR_KEY=%s\n' "$CLOUDBEAR_KEY"