#!/usr/bin/env bash
# Start intent-solver for the asset RFQ path (ASSET_MARKETS), not the offer-packet path.
# Requires: ark+emulator up, smoke/asset-rfq/data/solver.env from bootstrap.
#
# SOLVER_MODE picks the ingress, and the two are mutually exclusive — one CLI
# command each, and both would bind the same ports:
#
#   serve  (default)  HTTP on :8787, admin on :8788     -> npm run smoke
#   relay             Nostr on RELAY_URL, admin only    -> npm run smoke:nostr
#
# In relay mode NO swap port is published, which is what makes "the Nostr smoke
# used no HTTP RFQ endpoint" structural rather than a claim: there is nothing
# listening to fall back to.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SMOKE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SMOKE}/data/solver.env"
IMAGE="${INTENT_SOLVER_IMAGE:-ghcr.io/arkade-os/intent-solver:0.3.1}"
NAME="${INTENT_SOLVER_CONTAINER:-intent-solver-asset-rfq}"
MODE="${SOLVER_MODE:-serve}"
RELAY_URL="${INTENT_SOLVER_RELAY_URL:-ws://strfry:7777}"

case "$MODE" in
  serve|relay) ;;
  *) echo "SOLVER_MODE must be serve or relay, got $MODE" >&2; exit 1 ;;
esac

# Ensure inter-container bridge traffic works on this VM (iptables DROP on unpublished ports).
if [[ -x /tmp/fix-docker-bridge.sh ]]; then
  /tmp/fix-docker-bridge.sh >/dev/null || true
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — run: npm run bootstrap" >&2
  exit 1
fi

# Price feed the admin market probe + runtime pricing read.
if ! curl -sf "http://127.0.0.1:${PRICEFEED_PORT:-18088}/price" >/dev/null 2>&1; then
  echo "starting pricefeed on :${PRICEFEED_PORT:-18088}..."
  node --input-type=module -e "
    import { startPriceFeed } from './lib/pricefeed.mjs';
    const { server } = await startPriceFeed();
    process.on('SIGTERM', () => server.close());
    process.on('SIGINT', () => server.close());
  " &
  echo $! > "${SMOKE}/data/pricefeed.pid"
  sleep 1
fi

# Keep --format in single quotes so bash leaves Go template vars alone.
NETWORK="$(docker inspect arkd --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || true)"
if [[ -z "$NETWORK" ]]; then
  echo "arkd is not running — start arkade-regtest first" >&2
  exit 1
fi

# The relay is the whole ingress in relay mode: a solver that comes up against a
# relay nobody is running answers every request with silence, and silence is the
# one failure a client cannot tell from an unserved pair.
if [[ "$MODE" == "relay" ]]; then
  if ! docker ps --filter name=strfry --filter status=running --format '{{.Names}}' | grep -q strfry; then
    echo "strfry is not running — start it with:" >&2
    echo "  cd $ROOT && node regtest.mjs start --profile nostr" >&2
    exit 1
  fi
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

# Host pricefeed is reachable via the compose bridge gateway.
GATEWAY="$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')"

# Optional wipe: FRESH_VOLUME=1 discards the solver wallet DB (needed when the
# regtest chain was recreated under the same mnemonic/volume).
if [[ "${FRESH_VOLUME:-}" == "1" ]]; then
  docker volume rm intent_solver_asset_rfq_datadir >/dev/null 2>&1 || true
fi
docker volume create intent_solver_asset_rfq_datadir >/dev/null

# `serve` probes its own swap port; `relay` has none, so the admin console is
# the only surface with an answer. Whether the relay SOCKET is up is a separate
# question and a separate assertion — /api/backends carries it.
if [[ "$MODE" == "serve" ]]; then
  PORTS=(-p 8787:8787 -p 8788:8788)
  HEALTH="node -e \"fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""
  READY_URL="http://127.0.0.1:8787/healthz"
else
  PORTS=(-p 8788:8788)
  HEALTH="node -e \"fetch('http://127.0.0.1:8788/api/markets').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""
  READY_URL="http://127.0.0.1:8788/api/markets"
fi

docker run -d --name "$NAME" \
  --network "$NETWORK" \
  --user root \
  --env-file "$ENV_FILE" \
  -e ARK_SERVER_URL=http://arkd:7070 \
  -e EMULATOR_URL=http://emulator:7073 \
  -e ARK_ESPLORA_URL=http://mempool_web/api \
  -e RELAY_URL="$RELAY_URL" \
  -e RELAY_HEALTH_PATH=/data/relay-health \
  "${PORTS[@]}" \
  -v intent_solver_asset_rfq_datadir:/data \
  --health-cmd "$HEALTH" \
  --health-interval 10s \
  --health-timeout 5s \
  --health-retries 12 \
  "$IMAGE" \
  "$MODE"

echo "waiting for $NAME ($MODE) at $READY_URL..."
for i in $(seq 1 60); do
  if curl -sf "$READY_URL" >/dev/null; then
    if [[ "$MODE" == "serve" ]]; then
      echo "intent-solver (asset RFQ, HTTP) up at http://localhost:8787 (admin :8788)"
    else
      echo "intent-solver (asset RFQ, relay) subscribed to $RELAY_URL (admin :8788)"
    fi
    echo "host gateway for pricefeed from container: $GATEWAY"
    echo "$GATEWAY" > "${SMOKE}/data/docker-gateway"
    exit 0
  fi
  sleep 2
done
echo "solver failed to become healthy:" >&2
docker logs "$NAME" 2>&1 | tail -80 >&2
exit 1
