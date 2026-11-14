#!/bin/sh
# Install only the pinned portable CLI, without changing host gateway services.
# Release asset hashes are from NVIDIA/OpenShell v0.1.8's published SHA-256
# digests. Requalify CLI/gateway/SDK together before changing this version.
set -eu
version=v0.1.8
case "$(uname -m)" in
  x86_64|amd64) target=x86_64-unknown-linux-musl; checksum=87f5c41d396dcd36b4c30a7b5e6f41643a656cb31a82b0edbb00319c9a719c2d ;;
  aarch64|arm64) target=aarch64-unknown-linux-musl; checksum=9a2e8f522ccfb3fbd1ed1985a51191a60e083f3404903a56bd4813710a2c7080 ;;
  *) printf 'unsupported OpenShell CLI architecture\n' >&2; exit 1 ;;
esac
case "$(uname -s)" in Linux) ;; *) printf 'this portable CLI installer supports Linux only\n' >&2; exit 1 ;; esac
install_dir="${1:-/usr/local/bin}"
archive="openshell-${target}.tar.gz"
working_dir="$(mktemp -d)"
trap 'rm -rf "$working_dir"' EXIT HUP INT TERM
curl --fail --location --silent --show-error --retry 3 \
  "https://github.com/NVIDIA/OpenShell/releases/download/${version}/${archive}" -o "$working_dir/$archive"
printf '%s  %s\n' "$checksum" "$working_dir/$archive" | sha256sum --check --status
# The trusted, digest-pinned archive contains the CLI executable.
tar -xzf "$working_dir/$archive" -C "$working_dir"
binary="$(find "$working_dir" -type f -name openshell | head -n 1)"
[ -n "$binary" ] || { printf 'OpenShell archive has no CLI executable\n' >&2; exit 1; }
install -d -m 755 "$install_dir"
install -m 755 "$binary" "$install_dir/openshell"
"$install_dir/openshell" --version
