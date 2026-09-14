#!/usr/bin/env bash
# Start intent-solver for the asset RFQ path (ASSET_MARKETS), not the offer-packet path.
# Requires: ark+emulator up, smoke/asset-rfq/data/solver.env from bootstrap.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SMOKE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SMOKE}/data/solver.env"
IMAGE="${INTENT_SOLVER_IMAGE:-ghcr.io/arkade-os/intent-solver:0.3.1}"
NAME="${INTENT_SOLVER_CONTAINER:-intent-solver-asset-rfq}"

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

docker rm -f "$NAME" >/dev/null 2>&1 || true

# Host pricefeed is reachable via the compose bridge gateway.
GATEWAY="$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')"

# Optional wipe: FRESH_VOLUME=1 discards the solver wallet DB (needed when the
# regtest chain was recreated under the same mnemonic/volume).
if [[ "${FRESH_VOLUME:-}" == "1" ]]; then
  docker volume rm intent_solver_asset_rfq_datadir >/dev/null 2>&1 || true
fi
docker volume create intent_solver_asset_rfq_datadir >/dev/null

docker run -d --name "$NAME" \
  --network "$NETWORK" \
  --user root \
  --env-file "$ENV_FILE" \
  -e ARK_SERVER_URL=http://arkd:7070 \
  -e EMULATOR_URL=http://emulator:7073 \
  -e ARK_ESPLORA_URL=http://mempool_web/api \
  -e RELAY_URL=ws://strfry:7777 \
  -p 8787:8787 \
  -p 8788:8788 \
  -v intent_solver_asset_rfq_datadir:/data \
  --health-cmd "node -e \"fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\"" \
  --health-interval 10s \
  --health-timeout 5s \
  --health-retries 12 \
  "$IMAGE" \
  serve

echo "waiting for $NAME /healthz..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8787/healthz >/dev/null; then
    echo "intent-solver (asset RFQ) up at http://localhost:8787 (admin :8788)"
    echo "host gateway for pricefeed from container: $GATEWAY"
    echo "$GATEWAY" > "${SMOKE}/data/docker-gateway"
    exit 0
  fi
  sleep 2
done
echo "solver failed to become healthy:" >&2
docker logs "$NAME" 2>&1 | tail -80 >&2
exit 1
