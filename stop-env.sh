#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  echo -e "\033[0;32m[$(date '+%H:%M:%S')] $1\033[0m"
}

# ── Load environment ─────────────────────────────────────────────────────────
source "$SCRIPT_DIR/.env.defaults"
if [[ -n "${USER_ENV:-}" && -f "$USER_ENV" ]]; then
  log "Loading user env from $USER_ENV"
  source "$USER_ENV"
fi

# ── Resolve nigiri binary ────────────────────────────────────────────────────
if [[ -n "${NIGIRI_BRANCH:-}" ]]; then
  NIGIRI="$SCRIPT_DIR/_build/nigiri/build/nigiri"
elif command -v nigiri &>/dev/null; then
  NIGIRI="nigiri"
else
  NIGIRI="$SCRIPT_DIR/_build/nigiri/build/nigiri"
fi

# ── Stop ark overlay stack ───────────────────────────────────────────────────
log "Stopping ark overlay stack..."
docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" stop || true

# ── Stop nigiri ──────────────────────────────────────────────────────────────
log "Stopping nigiri..."
$NIGIRI stop || true

log "Environment stopped."
