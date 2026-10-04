#!/usr/bin/env bash
# Cloudbear OpenShell bring-up + verification probe (runs on the VPS).
#
# Idempotent and safe to re-run. Proves the sandbox boundary works instead of
# claiming it: applies our rendered restrictive policy to a fresh sandbox and
# shows that an allowed write succeeds while denied writes (and metadata
# egress, when testable) are refused.
#
# Usage:
#   MODEL_HOST=openrouter.ai bash deploy/openshell/install-and-verify.sh
#   bash deploy/openshell/install-and-verify.sh --dry-run   # plan only
#
# Environment (all optional except MODEL_HOST):
#   MODEL_HOST       model endpoint hostname, e.g. openrouter.ai (REQUIRED:
#                    baked into policy + provider profile; no default on purpose)
#   WORKDIR          in-sandbox working directory (default /workspace).
#                    This is the path INSIDE the sandbox, not the host path.
#   OS_SANDBOX       probe sandbox name (default cloudbear-probe)
#   OS_PROVIDER      provider instance name (default cloudbear-model)
#   PI_IMAGE         sandbox image (default pi-agent:local)
#   MODEL_API_KEY    model key. When set, the provider is created/updated from
#                    it via --from-existing. When unset, provider setup is
#                    skipped cleanly (OS_PROVIDER=none) and only the filesystem
#                    half of the boundary is probed. The key is never printed.
#   RENDER_DIR       where rendered policy/profile copies land
#                    (default /tmp/cloudbear-openshell)
#   OPENSHELL_VERSION  pinned OpenShell release for install.sh (default: latest)
#
# Output: progress lines, a PROBE=pass|fail line, and as its LAST lines a
# machine-readable summary the integrator parses to wire the executor:
#   OS_SANDBOX=<name>
#   OS_PROVIDER=<name|none>
#   OS_POLICY=<rendered policy path applied>
#   OS_GATEWAY=<gateway url>
#   OS_PROBE=<pass|fail>
#
# Exit status: 0 only when every step worked AND the probe passed. Anything
# else prints the summary first (OS_PROBE=fail) and exits non-zero.
set -euo pipefail

OS_SANDBOX="${OS_SANDBOX:-cloudbear-probe}"
OS_PROVIDER="${OS_PROVIDER:-cloudbear-model}"
PI_IMAGE="${PI_IMAGE:-pi-agent:local}"
MODEL_HOST="${MODEL_HOST:-}"
WORKDIR="${WORKDIR:-/workspace}"
RENDER_DIR="${RENDER_DIR:-/tmp/cloudbear-openshell}"
OS_POLICY="$RENDER_DIR/restrictive.yaml"
OS_GATEWAY="https://127.0.0.1:17670"
OS_PROBE="fail"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg (expected --dry-run)" >&2
      exit 2
      ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
warn() { printf '==> WARNING: %s\n' "$*" >&2; }

print_summary() {
  printf 'OS_SANDBOX=%s\n' "$OS_SANDBOX"
  printf 'OS_PROVIDER=%s\n' "$OS_PROVIDER"
  printf 'OS_POLICY=%s\n' "$OS_POLICY"
  printf 'OS_GATEWAY=%s\n' "$OS_GATEWAY"
  printf 'OS_PROBE=%s\n' "$OS_PROBE"
}

fail() {
  warn "$*"
  print_summary
  exit 1
}

if [ "$DRY_RUN" = 1 ]; then
  cat <<EOF
==> DRY-RUN plan (no changes will be made):
  1. check for 'openshell' on PATH; if missing, install via
     curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
     (OPENSHELL_VERSION=${OPENSHELL_VERSION:-<latest>})
  2. verify the gateway: 'openshell status' (fallback: 'openshell gateway status')
  3. render deploy/openshell/provider-model.yaml with MODEL_HOST=${MODEL_HOST:-<UNSET - will refuse to run>}
     and run 'openshell profile lint' + 'openshell profile import --global'
  4. provider: if MODEL_API_KEY is set in the environment, create provider
     '$OS_PROVIDER' from it (--from-existing); reuse it if it already exists;
     otherwise skip cleanly (OS_PROVIDER=none)
  5. render packages/policy restrictive (--target openshell) with
     WORKDIR=$WORKDIR MODEL_HOST=${MODEL_HOST:-<UNSET>} to $OS_POLICY
     (render validates its own output and fails closed)
  6. recreate sandbox '$OS_SANDBOX' from image '$PI_IMAGE' with --policy
     $OS_POLICY [--provider $OS_PROVIDER]  (filesystem/landlock/process are
     STATIC: the policy must be attached at creation, not set afterwards;
     only network_policies/network_middlewares hot-reload)
  7. probe inside the sandbox via 'openshell sandbox exec NAME -- ...':
       a. allowed: write+read back $WORKDIR/.openshell-probe (must succeed)
       b. denied:  touch /etc/.openshell-probe-denied and
                   /root/.openshell-probe-denied, each in its own exec
                   call (either succeeding = PROBE fail)
       c. denied egress: curl/node to https://169.254.169.254/ (success = fail;
          refusal = consistent-with-blocking; no tool = skip, noted)
  8. resource snapshot (free -m + gateway RSS, best effort) for VPS sizing
  9. print PROBE=pass|fail and the OS_* summary (last lines)
EOF
if [ -n "${MODEL_API_KEY:-}" ]; then echo "==> dry-run: MODEL_API_KEY is set (value hidden)"; else echo "==> dry-run: MODEL_API_KEY is unset (provider step will skip)"; fi
if [ -z "${MODEL_HOST:-}" ]; then echo "==> dry-run: MODEL_HOST is unset (a real run refuses to proceed)"; fi
echo '# dry-run: example summary, not executed:'
  OS_PROVIDER_PLACEHOLDER="$OS_PROVIDER"
  if [ -z "${MODEL_API_KEY:-}" ]; then OS_PROVIDER_PLACEHOLDER="none"; fi
  printf 'OS_SANDBOX=%s\n' "$OS_SANDBOX"
  printf 'OS_PROVIDER=%s\n' "$OS_PROVIDER_PLACEHOLDER"
  printf 'OS_POLICY=%s\n' "$OS_POLICY"
  printf 'OS_GATEWAY=%s\n' "$OS_GATEWAY"
  printf 'OS_PROBE=%s\n' "dry-run"
  exit 0
fi

[ -n "$MODEL_HOST" ] || fail "MODEL_HOST is required (e.g. MODEL_HOST=openrouter.ai); refusing to bake a wrong host into policy"

# --- 0. repo layout -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
POLICY_RENDER="$REPO_ROOT/packages/policy/src/render.ts"
PROFILE_SRC="$SCRIPT_DIR/provider-model.yaml"
[ -f "$POLICY_RENDER" ] || fail "cannot find $POLICY_RENDER (run from the cloudbear checkout)"
[ -f "$PROFILE_SRC" ] || fail "cannot find $PROFILE_SRC"
# bun installs itself into ~/.bun/bin, which is NOT on PATH for non-interactive
# ssh sessions — which is exactly how this script is normally run (over ssh by
# `cloudbear setup ssh`). Without this the script died before probing anything.
if ! command -v bun >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then
  PATH="$HOME/.bun/bin:$PATH"
  export PATH
fi
command -v bun >/dev/null 2>&1 || fail "bun is required to render the policy (install bun, then re-run)"
mkdir -p "$RENDER_DIR"

# --- 1. install OpenShell if missing ------------------------------------------
if command -v openshell >/dev/null 2>&1; then
  say "openshell present: $(openshell --version 2>/dev/null || echo version-unknown)"
else
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      debian | ubuntu) ;;
      *) warn "untested distro (ID=${ID:-unknown}); install.sh may not support it" ;;
    esac
  fi
  say "installing OpenShell..."
  if [ -n "${OPENSHELL_VERSION:-}" ]; then
    curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION="$OPENSHELL_VERSION" sh \
      || fail "OpenShell install failed (pinned OPENSHELL_VERSION=$OPENSHELL_VERSION)"
  else
    curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh \
      || fail "OpenShell install failed; see https://docs.nvidia.com/openshell/latest/about/installation"
  fi
  command -v openshell >/dev/null 2>&1 || fail "install finished but 'openshell' is not on PATH (try re-login for PATH/groups)"
fi

# --- 2. gateway up ------------------------------------------------------------
STATUS_OUT=""
if STATUS_OUT="$(openshell status 2>&1)"; then
  say "gateway reachable (openshell status ok)"
else
  warn "'openshell status' failed; trying 'openshell gateway status'"
  STATUS_OUT="$(openshell gateway status 2>&1)" || fail "no OpenShell gateway reachable. Output: $STATUS_OUT"
  say "gateway reachable (openshell gateway status ok)"
fi
DETECTED_URL="$(printf '%s\n' "$STATUS_OUT" | grep -oE 'https?://[^[:space:]"\x27]+' | head -n 1 || true)"
if [ -n "$DETECTED_URL" ]; then OS_GATEWAY="$DETECTED_URL"; fi

# --- 3. provider profile: render, lint, import ---------------------------------
RENDERED_PROFILE="$RENDER_DIR/provider-model.yaml"
sed "s|\${MODEL_HOST}|$MODEL_HOST|g" "$PROFILE_SRC" > "$RENDERED_PROFILE"
grep -q '\${' "$RENDERED_PROFILE" && fail "rendered profile still contains placeholders"
say "linting provider profile..."
openshell profile lint -f "$RENDERED_PROFILE" || fail "'openshell profile lint' rejected the rendered profile"
if openshell profile import --global -f "$RENDERED_PROFILE" 2> /tmp/os-profile-import.err; then
  say "provider profile imported"
else
  if openshell profile list 2>/dev/null | grep -q "cloudbear-model"; then
    warn "profile import reported an error but id cloudbear-model already exists; continuing with the existing profile"
  else
    warn "$(cat /tmp/os-profile-import.err)"
    fail "'openshell profile import' failed for a new profile id"
  fi
fi

# --- provider instance from env (never a literal) ------------------------------
if [ -n "${MODEL_API_KEY:-}" ]; then
  if openshell provider get "$OS_PROVIDER" >/dev/null 2>&1; then
    say "provider '$OS_PROVIDER' already exists; reusing (not printing or changing credentials)"
  else
    say "creating provider '$OS_PROVIDER' from MODEL_API_KEY (--from-existing)"
    MODEL_API_KEY="$MODEL_API_KEY" openshell provider create \
      --name "$OS_PROVIDER" --type cloudbear-model --from-existing \
      || fail "provider create failed (key stays in env only; nothing was printed)"
    say "provider '$OS_PROVIDER' created"
  fi
else
  warn "MODEL_API_KEY is unset; skipping provider create (network half of the probe will be skipped)"
  OS_PROVIDER="none"
fi

# --- 4. render restrictive policy (validates its own output, fails closed) ----
say "rendering restrictive policy (WORKDIR=$WORKDIR)..."
WORKDIR="$WORKDIR" MODEL_HOST="$MODEL_HOST" bun "$POLICY_RENDER" restrictive --target openshell > "$OS_POLICY" \
  || fail "policy render/validation failed; refusing to apply an invalid policy"
say "policy rendered to $OS_POLICY"

# NOTE: filesystem_policy/landlock/process are STATIC (take effect only at
# sandbox creation); network_policies/network_middlewares hot-reload. That is
# why the policy is attached with --policy at create below and never applied
# afterwards with `policy set`. Newly attached provider credentials apply only
# to newly launched processes, so the probe sandbox is created (and its probe
# processes launched) AFTER the provider exists.
# --- 5. fresh probe sandbox ----------------------------------------------------
if openshell sandbox get "$OS_SANDBOX" >/dev/null 2>&1; then
  say "removing previous probe sandbox '$OS_SANDBOX'..."
  openshell sandbox delete "$OS_SANDBOX" >/dev/null 2>&1 || fail "cannot delete previous sandbox '$OS_SANDBOX'"
fi
say "creating sandbox '$OS_SANDBOX' from '$PI_IMAGE' with restrictive policy..."
CREATE_ARGS=(sandbox create --name "$OS_SANDBOX" --from "$PI_IMAGE" --policy "$OS_POLICY")
if [ "$OS_PROVIDER" != "none" ]; then CREATE_ARGS+=(--provider "$OS_PROVIDER"); fi
# shellcheck disable=SC2206
if ! openshell "${CREATE_ARGS[@]}" -- sleep infinity >/tmp/os-sandbox-create.log 2>&1; then
  warn "$(cat /tmp/os-sandbox-create.log)"
  fail "sandbox create failed (policy rejected? image missing? see log above)"
fi

say "waiting for sandbox exec readiness..."
READY=0
for _ in $(seq 1 30); do
  if openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 10 -- true >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[ "$READY" = 1 ] || fail "sandbox '$OS_SANDBOX' never became exec-ready"

# --- 6. the probe --------------------------------------------------------------
say "probe (a): allowed write+read in $WORKDIR..."
if openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 30 -- \
  sh -c "printf probe-ok > $WORKDIR/.openshell-probe && cat $WORKDIR/.openshell-probe" 2>/tmp/os-probe-a.err; then
  say "probe (a): allowed write succeeded"
else
  warn "$(cat /tmp/os-probe-a.err)"
  fail "probe (a) FAILED: cannot write the allowed path $WORKDIR (policy too tight or workdir wrong)"
fi

say "probe (b): denied writes must each fail..."
# Each denied path gets its OWN exec call: a compound `a && b` would exit
# non-zero (read as "refused") when only ONE of the two is denied, hiding a
# proven escape through the other. Fail if EITHER write succeeds.
for DENIED_PATH in /etc/.openshell-probe-denied /root/.openshell-probe-denied; do
  if openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 30 -- \
    sh -c "touch $DENIED_PATH" 2>/dev/null; then
    fail "probe (b) FAILED: write to $DENIED_PATH SUCCEEDED -- filesystem policy is not enforced"
  else
    say "probe (b): write to $DENIED_PATH refused"
  fi
done

say "probe (c): denied egress to metadata address..."
NET_RESULT="skip"
if openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 10 -- sh -c 'command -v curl' >/dev/null 2>&1; then
  if openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 30 -- \
    sh -c 'curl -m 8 -sS -o /dev/null https://169.254.169.254/' >/dev/null 2>&1; then
    fail "probe (c) FAILED: egress to 169.254.169.254 SUCCEEDED -- network policy is not enforced"
  else
    NET_RESULT="refused"
    say "probe (c): egress to metadata address refused (consistent with blocking)"
  fi
elif openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 10 -- sh -c 'command -v node' >/dev/null 2>&1; then
  if openshell sandbox exec "$OS_SANDBOX" --no-login-shell --timeout 30 -- \
    node -e 'fetch("https://169.254.169.254/",{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    fail "probe (c) FAILED: egress to 169.254.169.254 SUCCEEDED -- network policy is not enforced"
  else
    NET_RESULT="refused"
    say "probe (c): egress to metadata address refused (consistent with blocking)"
  fi
else
  warn "probe (c): neither curl nor node in sandbox; egress check skipped (filesystem boundary still proven above)"
fi
printf 'PROBE_NET=%s\n' "$NET_RESULT"

say "recent sandbox log tail (best effort)..."
openshell logs "$OS_SANDBOX" --tail 20 2>/dev/null || warn "cannot tail sandbox logs (non-fatal)"

# --- 7. resource snapshot (VPS sizing: measure, don't guess) --------------------
# There is no official OpenShell RAM benchmark, so record free memory plus
# best-effort gateway RSS alongside the verdict. Never fails the run.
say "resource snapshot..."
if command -v free >/dev/null 2>&1; then
  free -m || true
  MEM_LINE="$(free -m | awk '/^Mem:/ {print "total_mb="$2" available_mb="$7}')"
  echo "==> MEM ${MEM_LINE:-unknown}"
else
  echo "==> MEM unknown (no free(1))"
fi
for pat in openshell-gateway openshell openshell-supervisor; do
  RSS="$(ps -eo comm,rss 2>/dev/null | awk -v p="$pat" '$1==p {sum+=$2} END {if (sum>0) print sum}')"
  if [ -n "${RSS:-}" ]; then echo "==> MEM process '$pat' RSS total: ${RSS} KiB"; fi
done || true

OS_PROBE="pass"
printf 'PROBE=%s\n' "$OS_PROBE"
say "probe sandbox '$OS_SANDBOX' left running for inspection; delete with: openshell sandbox delete $OS_SANDBOX"
print_summary
