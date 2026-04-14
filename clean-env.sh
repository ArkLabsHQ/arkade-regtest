#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  echo -e "\033[0;32m[$(date '+%H:%M:%S')] $1\033[0m"
}

# ── Parse arguments ──────────────────────────────────────────────────────────
CLEAN_BUILD=false
PRUNE_IMAGES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      CLEAN_BUILD=true
      shift
      ;;
    --prune)
      PRUNE_IMAGES=true
      shift
      ;;
    *)
      log "Unknown argument: $1"
      exit 1
      ;;
  esac
done

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
export BOLTZ_LND_P2P_PORT BOLTZ_LND_RPC_PORT FULMINE_GRPC_PORT FULMINE_API_PORT FULMINE_HTTP_PORT
export BOLTZ_GRPC_PORT BOLTZ_API_PORT BOLTZ_WS_PORT NGINX_PORT
export LNURL_IMAGE WALLET_IMAGE LNURL_PORT WALLET_PORT
export DELEGATOR_GRPC_PORT DELEGATOR_API_PORT DELEGATOR_HTTP_PORT

# ── Stop arkd override if custom image was used ──────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -q '^arkd$' && \
   [ -n "$(docker inspect arkd --format '{{.Config.Image}}' 2>/dev/null | grep -v 'nigiri')" ]; then
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
# Use a Docker container to remove them (runs as root, no sudo required).
NIGIRI_DATA="${HOME}/.nigiri"
if [ -d "$NIGIRI_DATA/volumes" ]; then
  log "Removing nigiri volumes..."
  docker run --rm -v "$NIGIRI_DATA/volumes:/vol" alpine sh -c 'rm -rf /vol/* /vol/.[!.]*' 2>/dev/null || true
  rm -rf "$NIGIRI_DATA/volumes" 2>/dev/null || true
fi

# Remove compose file and config so nigiri regenerates them from its template
# on next start. Prevents stale compose files (e.g. system vs dev nigiri mismatch).
rm -f "$NIGIRI_DATA/docker-compose.yml" "$NIGIRI_DATA/nigiri.config.json" 2>/dev/null || true

# ── Optionally remove _build/ ────────────────────────────────────────────────
if [[ "$CLEAN_BUILD" = true ]]; then
  log "Removing _build/ directory..."
  rm -rf "$SCRIPT_DIR/_build"
fi

# Remove any dangling images that may have been left behind by build scripts
if [[ "$PRUNE_IMAGES" = true ]]; then
  log "Removing dangling Docker images..."
  docker image prune -f
fi

log "Clean-up complete."
