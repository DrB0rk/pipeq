#!/usr/bin/env bash
set -euo pipefail

# PipeQ user-local installer.
# Usage: curl -fsSL https://raw.githubusercontent.com/DrB0rk/pipeq/main/install.sh | bash

readonly REPOSITORY="DrB0rk/pipeq"
readonly DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}"
readonly INSTALL_ROOT="${PIPEQ_INSTALL_DIR:-$DATA_ROOT/pipeq}"
readonly BIN_ROOT="${PIPEQ_BIN_DIR:-$HOME/.local/bin}"
readonly REQUESTED_VERSION="${PIPEQ_VERSION:-latest}"

fail() {
  printf 'pipeq install: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v readlink >/dev/null 2>&1 || fail "readlink is required"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 22 ]] || fail "Node.js 22 or newer is required (found $(node --version))"

if [[ "$REQUESTED_VERSION" == "latest" ]]; then
  release_json="$(curl --fail --silent --show-error --location \
    --header 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPOSITORY/releases/latest")" || fail "could not find the latest GitHub release"
  version="$(printf '%s\n' "$release_json" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
else
  version="$REQUESTED_VERSION"
fi

[[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "release version is invalid: $version"
version="v${version#v}"
archive_url="https://github.com/$REPOSITORY/archive/refs/tags/$version.tar.gz"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/pipeq-install.XXXXXX")"
staging_root="$(dirname -- "$INSTALL_ROOT")/.pipeq-install.$$"
backup_root="$(dirname -- "$INSTALL_ROOT")/.pipeq-backup.$$"
committed=0

cleanup() {
  if [[ "$committed" -eq 0 && -e "$backup_root" && ! -e "$INSTALL_ROOT" ]]; then
    mv "$backup_root" "$INSTALL_ROOT" || true
  fi
  rm -rf "$temporary_root" "$staging_root" "$backup_root"
}
trap cleanup EXIT

mkdir -p "$(dirname -- "$INSTALL_ROOT")" "$BIN_ROOT"
mkdir "$staging_root"

printf 'pipeq install: downloading %s\n' "$version"
curl --fail --silent --show-error --location "$archive_url" -o "$temporary_root/pipeq.tar.gz"
tar -xzf "$temporary_root/pipeq.tar.gz" -C "$temporary_root"
source_root="$(find "$temporary_root" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$source_root" && -f "$source_root/package.json" ]] || fail "downloaded archive did not contain a PipeQ project"
cp -a "$source_root/." "$staging_root/"

printf 'pipeq install: building locally (this keeps the installer independent of npm publishing)\n'
(
  cd "$staging_root"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
  chmod +x dist/cli.js bin/pq
)

if [[ -e "$INSTALL_ROOT" || -L "$INSTALL_ROOT" ]]; then
  mv "$INSTALL_ROOT" "$backup_root"
fi
mv "$staging_root" "$INSTALL_ROOT"
ln -sfn "$INSTALL_ROOT/bin/pq" "$BIN_ROOT/pq"
committed=1

printf 'pipeq install: installed %s in %s\n' "$version" "$INSTALL_ROOT"
if [[ ":$PATH:" != *":$BIN_ROOT:"* ]]; then
  printf 'pipeq install: add this directory to PATH to use pq:\n  export PATH="%s:$PATH"\n' "$BIN_ROOT"
fi
printf 'pipeq install: run with: pq\n'
