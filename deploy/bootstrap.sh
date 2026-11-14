#!/usr/bin/env bash
# Laun remote bootstrap. Invoked over SSH by `laun setup ssh`:
#
#   ssh -i <key> -o BatchMode=yes <user>@<host> \
#     LAUN_NO_START=false bash -s -- <remote-dir> [repo-url]
#
# The caller MUST have written <remote-dir>/.env (mode 600, containing at least
# GATEWAY_TOKEN and LAUN_KEY) before this runs. Idempotent: safe to re-run.
#
# Output: progress lines prefixed "==>", then a summary whose LAST line is the
# agent key so the CLI can read it back:
#   LAUN_DIR=...
#   LAUN_PORT=...
#   LAUN_KEY=...
# GATEWAY_TOKEN is never printed.
set -euo pipefail

REMOTE_DIR="${1:-}"
REPO_URL="${2:-}"
SOURCE_REVISION="${3:-}"
RELEASE_ONLY="${LAUN_RELEASE_ONLY:-false}"
[[ "$RELEASE_ONLY" = true || "$RELEASE_ONLY" = false ]] || { echo 'LAUN_RELEASE_ONLY must be true or false' >&2; exit 1; }

log() { printf '==> %s\n' "$*"; }
warn() { printf '==> WARNING: %s\n' "$*" >&2; }
die() {
  printf '==> ERROR: %s\n' "$*" >&2
  exit 1
}

[ -n "$REMOTE_DIR" ] || die "usage: bash bootstrap.sh <remote-dir> [repo-url]"
case "$REMOTE_DIR" in /opt/?*|/srv/?*|/home/?*/?*|/root/?*|/var/lib/laun|/var/lib/laun/?*|/tmp/?*) ;; *) die "remote-dir must be a dedicated absolute application directory, never an OS or home base";; esac
[[ "$REMOTE_DIR" != *$'\n'* && "$REMOTE_DIR" != *$'\r'* && "$REMOTE_DIR" != */ && "$REMOTE_DIR" != *//* ]] || die "remote-dir must be canonical and single-line"
current=""
IFS=/ read -r -a components <<< "$REMOTE_DIR"
for component in "${components[@]}"; do
  [ -n "$component" ] || continue
  [[ "$component" != . && "$component" != .. ]] || die "dot path components are refused"
  case "$component" in .ssh|.aws|.gnupg|.kube|.azure|.pi|.codex) die "credential directories cannot contain an installation";; esac
  current="$current/$component"
  [ ! -L "$current" ] && [ -d "$current" ] || die "installation path must contain real directories only"
  owner="$(stat -c %u -- "$current")"; mode="$(stat -c %a -- "$current")"
  [[ "$owner" = 0 || "$owner" = "$(id -u)" || "$owner" = "${SUDO_UID:-$(id -u)}" ]] || die "installation path belongs to another user"
  if (( (8#$mode & 0022) != 0 )); then (( (8#$mode & 01000) != 0 )) && [ "$current" != "$REMOTE_DIR" ] || die "installation path is writable by other users"; fi
done
case "${REMOTE_DIR##*/}" in .config|.local) die "shared configuration bases cannot be installation leaves";; esac
[ "$(stat -c %u -- "$REMOTE_DIR")" = "$(id -u)" ] || die "existing installation must be owned by this installer; setup will not chown it"
(( (8#$mode & 0077) == 0 )) || die "controller installation directory must be private"
MARKER="$REMOTE_DIR/.laun-install.json"
[ ! -L "$MARKER" ] && [ -f "$MARKER" ] && [ "$(stat -c %u -- "$MARKER")" = "$(id -u)" ] || die "missing verified controller marker; initialize a fresh directory with laun setup ssh or use the reviewed adoption workflow"
marker_mode="$(stat -c %a -- "$MARKER")"; (( (8#$marker_mode & 0077) == 0 )) || die "controller marker must be private"
printf '%s\n' '{"version":1,"kind":"controller"}' | cmp -s - "$MARKER" || die "installation marker does not identify a controller deployment"
ENV_FILE="$REMOTE_DIR/.env"
[ ! -L "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && [ "$(stat -c %u -- "$ENV_FILE")" = "$(id -u)" ] || die "configuration must be an installer-owned regular file; symlinks are refused"
env_mode="$(stat -c %a -- "$ENV_FILE")"; (( (8#$env_mode & 0077) == 0 )) || die "configuration must be private before setup"

# The checkout may overwrite .env, so keep the authoritative copy aside.
ENV_BACKUP="$(mktemp)"
CLONE_TMP=""
DOCKER_INSTALLER=""
cleanup() {
  rm -f "$ENV_BACKUP"
  [ -n "$CLONE_TMP" ] && rm -rf "$CLONE_TMP"
  [ -n "$DOCKER_INSTALLER" ] && rm -f "$DOCKER_INSTALLER"
  return 0
}
trap cleanup EXIT
cp "$ENV_FILE" "$ENV_BACKUP"

# --- privileges -----------------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "this script needs root or passwordless sudo"
  sudo -n true || die "this script needs passwordless sudo"
  SUDO="sudo -n"
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
  DOCKER_INSTALLER="$(mktemp)"
  chmod 600 "$DOCKER_INSTALLER"
  curl -fsSL https://get.docker.com -o "$DOCKER_INSTALLER" || die "could not download the docker installer"
  $SUDO sh "$DOCKER_INSTALLER" >/dev/null || die "docker install failed"
  rm -f "$DOCKER_INSTALLER"
  DOCKER_INSTALLER=""
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

# --- source tree ----------------------------------------------------------------
if [ "$RELEASE_ONLY" = true ]; then
  [ -f "$REMOTE_DIR/deploy/install-bun.sh" ] && [ -f "$REMOTE_DIR/deploy/docker-compose.yml" ] \
    || die "portable deployment templates are incomplete"
  log "using verified deployment templates from the released CLI (no checkout required)"
elif [ -f "$REMOTE_DIR/package.json" ]; then
  log "reusing existing checkout at $REMOTE_DIR"
  log "source updates require the explicit upgrade workflow; setup does not pull floating revisions"
else
  [ -n "$REPO_URL" ] \
    || die "no checkout at $REMOTE_DIR and no repo url given: rsync the repo there, or re-run with --repo-url <git-url>"
  [[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "a new source checkout requires an exact --revision commit; floating branches are not deployed"
  log "cloning $REPO_URL"
  CLONE_TMP="$(mktemp -d)"
  git -c core.hooksPath=/dev/null clone --no-checkout --filter=blob:none -- "$REPO_URL" "$CLONE_TMP/repo" >/dev/null 2>&1 || die "git clone failed"
  git -C "$CLONE_TMP/repo" -c core.hooksPath=/dev/null fetch --depth 1 origin "$SOURCE_REVISION" >/dev/null 2>&1 || die "could not fetch the pinned commit"
  git -C "$CLONE_TMP/repo" -c core.hooksPath=/dev/null checkout --detach "$SOURCE_REVISION" >/dev/null 2>&1 || die "could not check out the pinned commit"
  [ "$(git -C "$CLONE_TMP/repo" rev-parse HEAD)" = "$SOURCE_REVISION" ] || die "source commit verification failed"
  [ ! -e "$CLONE_TMP/repo/.env" ] && [ ! -L "$CLONE_TMP/repo/.env" ] && [ ! -e "$CLONE_TMP/repo/.laun-install.json" ] && [ ! -L "$CLONE_TMP/repo/.laun-install.json" ] || die "source checkout contains deployment configuration; refusing to replace credentials or marker"
  while IFS= read -r -d '' source_entry; do
    destination="$REMOTE_DIR/$(basename "$source_entry")"
    [ ! -e "$destination" ] && [ ! -L "$destination" ] || die "source checkout overlaps existing installation files; use explicit reviewed upgrade"
  done < <(find "$CLONE_TMP/repo" -mindepth 1 -maxdepth 1 -print0)
  shopt -s dotglob
  mv "$CLONE_TMP/repo"/* "$REMOTE_DIR"/ || die "could not move the checkout into $REMOTE_DIR"
  shopt -u dotglob
fi

# Setup never replaces or rotates the operator's credentials and guardrails.
[ ! -L "$ENV_FILE" ] && cmp -s "$ENV_BACKUP" "$ENV_FILE" || die "configuration changed during setup; refusing to continue"

# --- bun ------------------------------------------------------------------------
[ -f "$REMOTE_DIR/deploy/install-bun.sh" ] || die "pinned Bun helper is missing from deployment artifacts"
LAUN_BUN_BIN="$(bash "$REMOTE_DIR/deploy/install-bun.sh")" || die "pinned Bun provisioning failed"
export PATH="$(dirname "$LAUN_BUN_BIN"):$PATH"
SERVICE_IMAGE="$(bun -e 'import {pathToFileURL} from "node:url";const {readEnvValue}=await import(pathToFileURL(process.argv[1]).href);console.log(process.env.LAUN_SERVICE_IMAGE??readEnvValue(await Bun.file(process.argv[2]).text(),"LAUN_SERVICE_IMAGE")??"");' "$REMOTE_DIR/apps/laun/src/compose-profile.ts" "$ENV_FILE")" || die "could not read service image configuration"
PULL_ONLY="$RELEASE_ONLY"
[ -z "$SERVICE_IMAGE" ] || PULL_ONLY=true

# --- build ----------------------------------------------------------------------
if [ "$PULL_ONLY" = false ]; then
  log "installing dependencies"
  (cd "$REMOTE_DIR" && bun install --frozen-lockfile --ignore-scripts) || die "locked dependency installation failed"
  log "typechecking"
  (cd "$REMOTE_DIR" && bun run build) || die "typecheck failed; refusing to deploy an invalid build"
fi
RELEASE_TAG="$(sed -n 's/^LAUN_TAG=\(.*\)$/\1/p' "$ENV_FILE" | tail -1 | tr -d "\"'[:space:]")"
if [ "$RELEASE_ONLY" = true ]; then
  [[ "$RELEASE_TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "portable setup requires a pinned release LAUN_TAG"
fi

# --- start ----------------------------------------------------------------------
GATEWAY_PORT="$(sed -n 's/^GATEWAY_PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -1)"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"

if [ "${LAUN_NO_START:-false}" = "true" ]; then
  log "LAUN_NO_START=true — leaving the stack stopped"
else
  # `sudo docker compose` sets HOME=/root, which would make compose bind-mount
  # /root/.pi (empty) instead of the operator's pi credentials. Resolve the real
  # home and hand compose an explicit PI_CONFIG_DIR. It must end in /.pi — a
  # bare home directory would mount the whole home (ssh keys included).
  REAL_USER="${SUDO_USER:-$(id -un)}"
  PI_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
  [ -n "$PI_HOME" ] || PI_HOME="$HOME"
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
  export PI_CONFIG_DIR

  # Resolve the v2 controller credential reference before sudo changes HOME.
  # Read a static dotenv value; never source a credential-bearing environment.
  PI_CONTROLLER_AUTH_DIR="${PI_CONTROLLER_AUTH_DIR:-$(bun -e 'import {pathToFileURL} from "node:url";const {readEnvValue}=await import(pathToFileURL(process.argv[1]).href);console.log(readEnvValue(await Bun.file(process.argv[2]).text(),"PI_CONTROLLER_AUTH_DIR")??"");' "$REMOTE_DIR/apps/laun/src/compose-profile.ts" "$ENV_FILE")}"
  PI_CONTROLLER_AUTH_DIR="${PI_CONTROLLER_AUTH_DIR:-$PI_CONFIG_DIR/agent}"
  case "$PI_CONTROLLER_AUTH_DIR" in /*) ;; *) die "PI_CONTROLLER_AUTH_DIR must be an absolute host path";; esac
  [[ "$PI_CONTROLLER_AUTH_DIR" != *'$'* && "$PI_CONTROLLER_AUTH_DIR" != *$'\n'* && "$PI_CONTROLLER_AUTH_DIR" != *$'\r'* ]] || die "PI_CONTROLLER_AUTH_DIR must be a static single-line path"
  if [ ! -d "$PI_CONTROLLER_AUTH_DIR" ]; then mkdir -p "$PI_CONTROLLER_AUTH_DIR"; chmod 700 "$PI_CONTROLLER_AUTH_DIR"; fi
  if [ ! -f "$PI_CONTROLLER_AUTH_DIR/auth.json" ]; then warn "controller provider authentication is not configured; model execution remains unqualified"; fi
  export PI_CONTROLLER_AUTH_DIR

  # The isolation overlay is mandatory when requested; no missing identity
  # or invalid configuration may silently select the developer profile.
  source "$REMOTE_DIR/deploy/compose-profile.sh"
  laun_compose_profile "$ENV_FILE" "$REMOTE_DIR/deploy/docker-compose.yml" true \
    || die "compose profile preflight failed"
  log "validating deployment configuration"
  (cd "$REMOTE_DIR" && $SUDO env PI_CONFIG_DIR="$PI_CONFIG_DIR" PI_CONTROLLER_AUTH_DIR="$PI_CONTROLLER_AUTH_DIR" docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env config --quiet) \
    || die "docker compose configuration is invalid"
  if [ "$PULL_ONLY" = true ]; then
    (cd "$REMOTE_DIR" && $SUDO env PI_CONFIG_DIR="$PI_CONFIG_DIR" PI_CONTROLLER_AUTH_DIR="$PI_CONTROLLER_AUTH_DIR" LAUN_TAG="$RELEASE_TAG" LAUN_SERVICE_IMAGE="$SERVICE_IMAGE" docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env pull) || die "pinned image pull failed"
    (cd "$REMOTE_DIR" && $SUDO env PI_CONFIG_DIR="$PI_CONFIG_DIR" PI_CONTROLLER_AUTH_DIR="$PI_CONTROLLER_AUTH_DIR" LAUN_TAG="$RELEASE_TAG" LAUN_SERVICE_IMAGE="$SERVICE_IMAGE" docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env up -d --no-build) || die "released stack start failed"
  else
    (cd "$REMOTE_DIR" && $SUDO env PI_CONFIG_DIR="$PI_CONFIG_DIR" PI_CONTROLLER_AUTH_DIR="$PI_CONTROLLER_AUTH_DIR" docker compose "${LAUN_COMPOSE_FILES[@]}" --env-file .env up -d --build) || die "source stack start failed"
  fi
  healthy=0
  readiness_probe='import {pathToFileURL} from "node:url";const {readEnvValue}=await import(pathToFileURL(process.argv[1]).href);const key=readEnvValue(await Bun.file(process.argv[2]).text(),"LAUN_KEY");if(!key)process.exit(1);try{const headers={authorization:`Bearer ${key}`};const r=await fetch(`http://127.0.0.1:${process.argv[3]}/api/v2/me`,{headers,signal:AbortSignal.timeout(3000)});if(!r.ok)process.exit(1);const me=await r.json();if(typeof me.principalId!=="string"||!me.principalId)process.exit(1);}catch{process.exit(1);}'
  for _ in $(seq 1 20); do
    if bun -e "$readiness_probe" "$REMOTE_DIR/apps/laun/src/compose-profile.ts" "$ENV_FILE" "$GATEWAY_PORT" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 3
  done
  if [ "$healthy" = "1" ]; then
    log "authenticated v2 control is reachable on port ${GATEWAY_PORT}; run laun doctor to inspect execution/model readiness (no inference was invoked)"
  else
    die "authenticated v2 control probe did not pass — inspect the compose logs"
  fi
fi

# --- summary (last line is the agent key) ---------------------------------------
LAUN_KEY="$(sed -n 's/^LAUN_KEY=\(.*\)$/\1/p' "$ENV_FILE" | tail -1 | tr -d '[:space:]')"
[ -n "$LAUN_KEY" ] || die "no LAUN_KEY in $ENV_FILE — run laun setup to generate one"

log "done"
printf 'LAUN_DIR=%s\n' "$REMOTE_DIR"
printf 'LAUN_PORT=%s\n' "$GATEWAY_PORT"
printf 'LAUN_KEY=%s\n' "$LAUN_KEY"
