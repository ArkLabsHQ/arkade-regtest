#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  echo -e "\033[0;32m[$(date '+%H:%M:%S')] $1\033[0m"
}

# ── Load environment ─────────────────────────────────────────────────────────
source "$SCRIPT_DIR/lib/env.sh"
load_env "$SCRIPT_DIR"

# ── Resolve nigiri binary ────────────────────────────────────────────────────
if [[ -n "${NIGIRI_BRANCH:-}" ]]; then
  NIGIRI="$SCRIPT_DIR/_build/nigiri/build/nigiri"
elif command -v nigiri &>/dev/null; then
  NIGIRI="nigiri"
else
  NIGIRI="$SCRIPT_DIR/_build/nigiri/build/nigiri"
fi

# ── Export vars for docker-compose interpolation ─────────────────────────────
export ARKD_IMAGE ARKD_WALLET_IMAGE
export BOLTZ_LND_IMAGE FULMINE_IMAGE BOLTZ_IMAGE NGINX_IMAGE
export BOLTZ_LND_P2P_PORT BOLTZ_LND_RPC_PORT FULMINE_HTTP_PORT FULMINE_API_PORT
export BOLTZ_GRPC_PORT BOLTZ_API_PORT BOLTZ_WS_PORT NGINX_PORT

# ── Stop arkd override if custom image was used ──────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -q '^ark$' && \
   [ -n "$(docker inspect ark --format '{{.Config.Image}}' 2>/dev/null | grep -v 'nigiri')" ]; then
  log "Stopping custom arkd override containers..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" down --volumes --remove-orphans 2>/dev/null || true
fi

# ── Stop ark overlay stack ───────────────────────────────────────────────────
log "Stopping ark overlay stack..."
docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" down --volumes --remove-orphans || true

# ── Stop nigiri ──────────────────────────────────────────────────────────────
log "Stopping nigiri..."
$NIGIRI stop --delete || true

# nigiri stop --delete may fail to remove volumes owned by container users (e.g. postgres).
# Fix ownership so the current user can clean them, then let nigiri recreate on next start.
NIGIRI_DATA="${HOME}/.nigiri"
if [ -d "$NIGIRI_DATA/volumes" ]; then
  log "Removing nigiri volumes..."
  sudo chown -R "$(id -u):$(id -g)" "$NIGIRI_DATA/volumes" 2>/dev/null || true
  rm -rf "$NIGIRI_DATA/volumes" 2>/dev/null || true
fi

# ── Optionally remove _build/ ────────────────────────────────────────────────
if [[ "${CLEAN_BUILD:-false}" == "true" ]]; then
  log "Removing _build/ directory..."
  rm -rf "$SCRIPT_DIR/_build"
fi

log "Clean-up complete."
