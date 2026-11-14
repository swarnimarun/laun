#!/usr/bin/env bash
# Sourced by installation scripts. Bun owns the same static dotenv reader and
# validation as local CLI setup; .env is never sourced or executed.
laun_compose_profile() {
  local env_file="$1" compose_file="$2" default_enabled="${3:-false}" selector result
  selector="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../apps/laun/src/compose-profile.ts"
  result="$(bun "$selector" "$env_file" "$compose_file" "$default_enabled")" || return 1
  mapfile -t LAUN_COMPOSE_FILES <<< "$result"
}
