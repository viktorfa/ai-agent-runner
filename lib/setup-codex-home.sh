#!/usr/bin/env sh
set -eu

CODEX_HOME_DIR=${CODEX_HOME_DIR:-/home/node/.codex}
CODEX_SEED_DIR=${CODEX_SEED_DIR:-/tmp/host-codex}

umask 077

mkdir -p "$CODEX_HOME_DIR"
chmod 700 "$CODEX_HOME_DIR"

if [ "${DEVCONTAINER:-}" = "true" ]; then
  export npm_config_store_dir=/home/node/.pnpm-store
fi

copy_if_present() {
  src=$1
  dest=$2

  if [ -f "$src" ]; then
    cp "$src" "$dest"
    chmod 600 "$dest" 2>/dev/null || true
  fi
}

copy_if_present "$CODEX_SEED_DIR/auth.json" "$CODEX_HOME_DIR/auth.json"
copy_if_present "$CODEX_SEED_DIR/config.toml" "$CODEX_HOME_DIR/config.toml"

if [ ! -f "$CODEX_HOME_DIR/auth.json" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: Codex auth was not found. Seed ~/.codex/auth.json or set OPENAI_API_KEY."
  exit 1
fi
