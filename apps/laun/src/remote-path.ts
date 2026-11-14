import { posix } from "node:path";
import { UsageError } from "./args.js";
import { shQuote } from "./shell-quote.js";

/** A deployment is an application leaf, never an OS/config/home/pseudo-filesystem base. */
export function validateInstallDirectory(value: string): string {
  if (
    !value.startsWith("/") ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    posix.normalize(value) !== value ||
    value.endsWith("/")
  )
    throw new UsageError(
      "remote-dir must be a canonical absolute application directory without dot components or control characters",
    );
  const parts = value.split("/").filter(Boolean),
    top = parts[0];
  if (
    parts.some((part) =>
      [".ssh", ".aws", ".gnupg", ".kube", ".azure", ".pi", ".codex"].includes(
        part,
      ),
    ) ||
    [".config", ".local"].includes(parts.at(-1)!)
  )
    throw new UsageError(
      "remote-dir must not be a credential directory or shared configuration base",
    );
  if (
    !top ||
    !["opt", "srv", "home", "root", "var", "tmp"].includes(top) ||
    parts.length < 2 ||
    (top === "home" && parts.length < 3) ||
    (top === "var" && !(parts[1] === "lib" && parts[2] === "laun"))
  )
    throw new UsageError(
      "remote-dir must be a dedicated application directory under /opt, /srv, a user home, /var/lib/laun, or /tmp; protected base directories are refused",
    );
  return value;
}

/** Walk safe ancestors; create/chown only new leaves and recognize an existing Laun marker. */
export function prepareRemoteDirectory(
  directory: string,
  kind: "controller" | "yard",
): string {
  validateInstallDirectory(directory);
  const marker = JSON.stringify({ version: 1, kind });
  return `set -euo pipefail
umask 077
install_dir=${shQuote(directory)}
install_uid=$(id -u)
install_gid=$(id -g)
current=
IFS=/ read -r -a components <<< "$install_dir"
for component in "\${components[@]}"; do
  [ -n "$component" ] || continue
  current="$current/$component"
  [ ! -L "$current" ] || { echo 'installation path has a symlink ancestor; choose a real private application path' >&2; exit 1; }
  if [ -e "$current" ]; then
    [ -d "$current" ] || { echo 'installation path contains a non-directory' >&2; exit 1; }
    owner=$(stat -c %u -- "$current"); mode=$(stat -c %a -- "$current")
    [ "$owner" = 0 ] || [ "$owner" = "$install_uid" ] || [ "$owner" = "\${SUDO_UID:-$install_uid}" ] || { echo 'installation ancestor belongs to another user' >&2; exit 1; }
    if (( (8#$mode & 0022) != 0 )); then
      (( (8#$mode & 01000) != 0 )) && [ "$current" != "$install_dir" ] || { echo 'installation ancestor is writable by other users' >&2; exit 1; }
    fi
    if [ "$current" = "$install_dir" ]; then (( (8#$mode & ${kind === "yard" ? "0027" : "0077"}) == 0 )) || { echo 'existing installation directory must be private; review permissions explicitly' >&2; exit 1; }; fi
  else
    mode=0755; [ "$current" != "$install_dir" ] || mode=0700
    if mkdir -m "$mode" -- "$current" 2>/dev/null; then :
    elif command -v sudo >/dev/null && sudo -n mkdir -m "$mode" -- "$current"; then
      if [ "$current" = "$install_dir" ]; then sudo -n chown "$install_uid:$install_gid" -- "$current"; fi
    else echo 'cannot create the dedicated application directory; root or passwordless sudo may be required' >&2; exit 1; fi
  fi
done
[ "$(stat -c %u -- "$install_dir")" = "$install_uid" ] || { echo 'existing installation directory belongs to another user; it will not be chowned' >&2; exit 1; }
marker="$install_dir/.laun-install.json"
expected=${shQuote(marker)}
if [ -e "$marker" ] || [ -L "$marker" ]; then
  [ ! -L "$marker" ] && [ -f "$marker" ] && [ "$(stat -c %u -- "$marker")" = "$install_uid" ] || { echo 'invalid Laun installation marker' >&2; exit 1; }
  marker_mode=$(stat -c %a -- "$marker"); (( (8#$marker_mode & 0077) == 0 )) || { echo 'installation marker must be private' >&2; exit 1; }
  printf '%s\n' "$expected" | cmp -s - "$marker" || { echo 'installation belongs to a different deployment kind; use an explicit reviewed migration' >&2; exit 1; }
else
  [ -z "$(find "$install_dir" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo 'nonempty directory has no verified Laun marker; use a fresh directory or the reviewed adoption/upgrade workflow' >&2; exit 1; }
  marker_tmp=$(mktemp "$install_dir/.marker.XXXXXX")
  trap 'rm -f "$marker_tmp"' EXIT
  printf '%s\n' "$expected" > "$marker_tmp"
  ln "$marker_tmp" "$marker"
  rm -f "$marker_tmp"
  trap - EXIT
fi`;
}

/** Existing asset parents remain installer-owned and cannot redirect writes. */
export function prepareAssetParent(
  directory: string,
  relative: string,
): string {
  validateInstallDirectory(directory);
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\\x00-\x1f\x7f]/.test(part),
    )
  )
    throw new UsageError("unsafe deployment asset parent");
  return `set -euo pipefail
umask 077
asset_parent=${shQuote(directory)}
for part in ${parts.map(shQuote).join(" ")}; do
  asset_parent="$asset_parent/$part"
  [ ! -L "$asset_parent" ] || { echo 'deployment asset parent must not be a symlink' >&2; exit 1; }
  if [ ! -e "$asset_parent" ]; then mkdir -m 0700 -- "$asset_parent"; fi
  [ -d "$asset_parent" ] && [ "$(stat -c %u -- "$asset_parent")" = "$(id -u)" ] || { echo 'deployment asset parent must be an installer-owned directory' >&2; exit 1; }
  parent_mode=$(stat -c %a -- "$asset_parent"); (( (8#$parent_mode & 0022) == 0 )) || { echo 'deployment asset parent is writable by other users' >&2; exit 1; }
done`;
}

/** Publish exactly once. Re-runs can compare the same private config but cannot rotate it. */
export function publishRemoteConfig(
  directory: string,
  file: ".env" | "worker.env",
): string {
  validateInstallDirectory(directory);
  return `set -euo pipefail
umask 077
destination=${shQuote(`${directory}/${file}`)}
config_tmp=$(mktemp ${shQuote(`${directory}/.config.XXXXXX`)})
trap 'rm -f "$config_tmp"' EXIT
cat > "$config_tmp"
check_existing() {
  [ ! -L "$destination" ] && [ -f "$destination" ] && [ "$(stat -c %u -- "$destination")" = "$(id -u)" ] || { echo 'existing configuration must be a regular file owned by the installer; symlinks are refused' >&2; return 1; }
  config_mode=$(stat -c %a -- "$destination"); (( (8#$config_mode & 0077) == 0 )) || { echo 'existing configuration is not private; review its permissions before retrying' >&2; return 1; }
  cmp -s "$config_tmp" "$destination" || { echo 'remote configuration differs; setup will not overwrite credentials or guardrails. Use an explicit reviewed configuration update/upgrade.' >&2; return 1; }
}
if [ -e "$destination" ] || [ -L "$destination" ]; then check_existing
else ln "$config_tmp" "$destination" || check_existing; fi`;
}
