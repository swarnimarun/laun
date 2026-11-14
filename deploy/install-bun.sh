#!/usr/bin/env bash
# Return a verified Bun path. Existing binaries and global installations are never overwritten.
set -euo pipefail
version=1.4.4
image='oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d'
if command -v bun >/dev/null 2>&1 && [ "$(bun --version 2>/dev/null)" = "$version" ]; then command -v bun; exit 0; fi
case "$(uname -s)" in Linux) ;; *) printf 'pinned host Bun provisioning supports Linux VPS hosts only\n' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) platform=linux/amd64;; aarch64|arm64) platform=linux/arm64;; *) printf 'unsupported Bun host architecture\n' >&2; exit 1;; esac
tools_dir="${LAUN_TOOLS_DIR:-$HOME/.local/share/laun/tools}"
target_dir="$tools_dir/bun/$version/bin"
target="$target_dir/bun"
if [ -e "$target" ] || [ -L "$target" ]; then
  [ ! -L "$target" ] && [ -x "$target" ] && [ "$("$target" --version 2>/dev/null)" = "$version" ] || { printf 'existing application Bun cache is invalid; inspect %s before retrying\n' "$target" >&2; exit 1; }
  printf '%s\n' "$target"; exit 0
fi
engine="${LAUN_CONTAINER_ENGINE:-docker}"
command -v "$engine" >/dev/null 2>&1 || { printf 'Bun %s needs a working Docker/Podman engine to extract the digest-pinned artifact; no unverified installer is run\n' "$version" >&2; exit 1; }
engine_command=("$engine")
if ! "$engine" info >/dev/null 2>&1; then
  if [ "$engine" = docker ] && command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then engine_command=(sudo -n docker)
  else printf 'the container engine is unavailable; fix its permissions/service before provisioning pinned Bun\n' >&2; exit 1; fi
fi
install -d -m 0755 "$target_dir"
working_dir="$(mktemp -d "$target_dir/.install.XXXXXX")"
container_id=
cleanup() { if [ -n "$container_id" ]; then "${engine_command[@]}" rm -f "$container_id" >/dev/null 2>&1 || true; fi; rm -rf "$working_dir"; }
trap cleanup EXIT HUP INT TERM
printf 'Preparing digest-pinned Bun %s (%s) in the application tool directory\n' "$version" "$platform" >&2
"${engine_command[@]}" pull --platform "$platform" "$image" >&2
container_id="$("${engine_command[@]}" create --platform "$platform" --entrypoint /bin/true "$image")"
"${engine_command[@]}" cp "$container_id:/usr/local/bin/bun" "$working_dir/bun"
chmod 0755 "$working_dir/bun"
[ "$("$working_dir/bun" --version 2>/dev/null)" = "$version" ] || { printf 'extracted Bun version did not match the pinned artifact\n' >&2; exit 1; }
# Hard-link publication refuses replacement even if another installer races us.
ln "$working_dir/bun" "$target" 2>/dev/null || { [ ! -L "$target" ] && [ -x "$target" ] && [ "$("$target" --version 2>/dev/null)" = "$version" ]; }
printf '%s\n' "$target"
