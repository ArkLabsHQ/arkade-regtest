#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Verify script is not running from an empty submodule ─────────────────────
if [ ! -f "$SCRIPT_DIR/.env.defaults" ]; then
  echo "ERROR: $SCRIPT_DIR/.env.defaults not found."
  echo "If this is a git submodule, run: git submodule update --init"
  exit 1
fi

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  echo -e "\033[0;32m[$(date '+%H:%M:%S')] $1\033[0m"
}

# ── Parse arguments ──────────────────────────────────────────────────────────
CLEAN=false
USER_ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      CLEAN=true
      shift
      ;;
    --env)
      USER_ENV="$2"
      shift 2
      ;;
    *)
      log "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Load environment ────────────────────────────────────────────────────────
source "$SCRIPT_DIR/lib/env.sh"
load_env "$SCRIPT_DIR"

# ── Export vars for docker-compose interpolation ─────────────────────────────
export BOLTZ_LND_IMAGE FULMINE_IMAGE BOLTZ_IMAGE NGINX_IMAGE
export ARKD_IMAGE ARKD_WALLET_IMAGE
export BOLTZ_LND_P2P_PORT BOLTZ_LND_RPC_PORT FULMINE_HTTP_PORT FULMINE_API_PORT
export DELEGATOR_GRPC_PORT DELEGATOR_API_PORT DELEGATOR_HTTP_PORT
export BOLTZ_GRPC_PORT BOLTZ_API_PORT BOLTZ_WS_PORT NGINX_PORT
export ARKD_WALLET_SIGNER_KEY
export ARKD_SCHEDULER_TYPE ARKD_ALLOW_CSV_BLOCK_TYPE ARKD_VTXO_TREE_EXPIRY
export ARKD_UNILATERAL_EXIT_DELAY ARKD_BOARDING_EXIT_DELAY ARKD_LIVE_STORE_TYPE

# ── Nigiri resolution ───────────────────────────────────────────────────────
build_nigiri_from_source() {
  local branch="$1"
  local repo_dir="$SCRIPT_DIR/_build/nigiri"
  local os=$(uname -s | tr '[:upper:]' '[:lower:]')
  local arch=$(uname -m)
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac
  local bin_name="nigiri-${os}-${arch}"
  NIGIRI="${repo_dir}/build/${bin_name}"

  if [ ! -f "$NIGIRI" ] || [ "$CLEAN" = true ]; then
    log "Building nigiri from source (branch: $branch)..."
    if [ ! -d "$repo_dir" ]; then
      git clone -b "$branch" "$NIGIRI_REPO_URL" "$repo_dir"
    else
      cd "$repo_dir"
      git stash 2>/dev/null || true
      git fetch origin
      git checkout "$branch"
      git pull origin "$branch"
      cd "$SCRIPT_DIR"
    fi
    cd "$repo_dir" && make install && make build && cd "$SCRIPT_DIR"
    if [ ! -f "$NIGIRI" ]; then
      log "ERROR: Failed to build nigiri binary"
      exit 1
    fi
    log "Nigiri built successfully"
  else
    log "Nigiri found: $($NIGIRI --version)"
  fi

  # Symlink so nigiri can find itself
  local build_dir="${repo_dir}/build"
  if [ -f "$NIGIRI" ] && [ ! -f "${build_dir}/nigiri" ]; then
    ln -sf "$bin_name" "${build_dir}/nigiri"
  fi
  export PATH="${build_dir}:${PATH}"
}

resolve_nigiri() {
  if [ -n "${NIGIRI_BRANCH:-}" ]; then
    # Build from source using the specified branch
    build_nigiri_from_source "$NIGIRI_BRANCH"
  elif command -v nigiri &>/dev/null; then
    # NIGIRI_BRANCH was explicitly cleared — use system binary
    NIGIRI="nigiri"
    log "Using system nigiri: $(nigiri --version)"
  else
    log "ERROR: NIGIRI_BRANCH is empty and no system nigiri found on PATH"
    exit 1
  fi
}

# ── Helper: setup_lnd_wallet ─────────────────────────────────────────────────
setup_lnd_wallet() {
  log "Setting up LND for Lightning swaps..."
  sleep 10

  log "Getting LND address..."
  ln_address=$(docker exec boltz-lnd lncli --network=regtest newaddress p2wkh | jq -r '.address')
  log "LND address: $ln_address"

  log "Funding LND wallet..."
  $NIGIRI faucet "$ln_address" "$LND_FAUCET_AMOUNT"

  log "Waiting for LND funding confirmation..."
  sleep 10

  lnd_balance=$(docker exec boltz-lnd lncli --network=regtest walletbalance | jq -r '.account_balance.default.confirmed_balance')
  if [ "$lnd_balance" -lt 1000000 ]; then
    log "ERROR: LND wallet balance ($lnd_balance) is less than 1,000,000 sats. Funding failed."
    exit 1
  fi
  log "LND balance: $lnd_balance"

  counterparty_node_pubkey=$(docker exec lnd lncli --network=regtest getinfo | jq -r '.identity_pubkey')
  log "Opening channel to counterparty node ($counterparty_node_pubkey)..."
  docker exec boltz-lnd lncli --network=regtest openchannel --node_key "$counterparty_node_pubkey" --connect "lnd:9735" --local_amt "$LND_CHANNEL_SIZE" --sat_per_vbyte 1 --min_confs 0

  log "Mining ten blocks to confirm channel..."
  $NIGIRI rpc --generate 10

  log "Waiting for channel to become active..."
  sleep 10

  log "Creating and paying test invoice..."
  invoice=$(docker exec lnd lncli --network=regtest addinvoice --amt 500000 | jq -r '.payment_request')
  docker exec boltz-lnd lncli --network=regtest payinvoice --force $invoice

  log "LND wallet setup completed successfully!"
}

# ── Helper: setup_arkd_fees ──────────────────────────────────────────────────
setup_arkd_fees() {
  log "Configuring arkd intent fees..."
  local fee_response
  fee_response=$(docker exec ark wget -qO- \
    --post-data="{\"fees\":{\"offchainInputFee\":\"${ARK_OFFCHAIN_INPUT_FEE}\",\"onchainInputFee\":\"${ARK_ONCHAIN_INPUT_FEE}\",\"offchainOutputFee\":\"${ARK_OFFCHAIN_OUTPUT_FEE}\",\"onchainOutputFee\":\"${ARK_ONCHAIN_OUTPUT_FEE}\"}}" \
    --header="Content-Type: application/json" \
    http://localhost:7071/v1/admin/intentFees 2>&1) || {
    log "WARNING: Failed to set arkd fees (admin port may not be available)"
    return 0
  }
  local verify
  verify=$(docker exec ark wget -qO- http://localhost:7071/v1/admin/intentFees 2>&1)
  log "arkd fees configured: $verify"
}

# ── Helper: setup_fulmine_wallet ─────────────────────────────────────────────
setup_fulmine_wallet() {
  log "Setting up Fulmine wallet..."

  log "Waiting for Fulmine service to be ready..."
  max_attempts=15
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if curl -s http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status >/dev/null 2>&1; then
      log "Fulmine service is ready!"
      break
    fi
    log "Waiting for Fulmine service... (attempt $attempt/$max_attempts)"
    sleep 2
    ((attempt++))
  done
  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: Fulmine service failed to start within expected time"
    exit 1
  fi

  log "Generating seed..."
  seed_response=$(curl -s -X GET http://localhost:${FULMINE_API_PORT}/api/v1/wallet/genseed)
  private_key=$(echo "$seed_response" | jq -r '.nsec')
  log "Generated private key: $private_key"

  log "Creating Fulmine wallet..."
  curl -X POST http://localhost:${FULMINE_API_PORT}/api/v1/wallet/create \
       -H "Content-Type: application/json" \
       -d "{\"private_key\": \"$private_key\", \"password\": \"password\", \"server_url\": \"http://ark:7070\"}"

  log "Unlocking Fulmine wallet..."
  curl -X POST http://localhost:${FULMINE_API_PORT}/api/v1/wallet/unlock \
       -H "Content-Type: application/json" \
       -d '{"password": "password"}'

  log "Checking Fulmine wallet status..."
  local status_response=$(curl -s -X GET http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status)
  log "Wallet status: $status_response"

  log "Getting Fulmine wallet address..."
  max_attempts=5
  attempt=1
  local fulmine_address=""
  while [ $attempt -le $max_attempts ]; do
    local address_response=$(curl -s -X GET http://localhost:${FULMINE_API_PORT}/api/v1/address)
    fulmine_address=$(echo "$address_response" | jq -r '.address' | sed 's/bitcoin://' | sed 's/?ark=.*//')
    if [[ "$fulmine_address" != "null" && -n "$fulmine_address" ]]; then
      log "Fulmine address: $fulmine_address"
      break
    fi
    log "Address not ready yet (attempt $attempt/$max_attempts), waiting..."
    sleep 2
    ((attempt++))
  done
  if [[ "$fulmine_address" == "null" || -z "$fulmine_address" ]]; then
    log "ERROR: Failed to get valid Fulmine wallet address"
    exit 1
  fi

  log "Funding Fulmine wallet..."
  $NIGIRI faucet "$fulmine_address" "$FULMINE_FAUCET_AMOUNT"
  sleep 5

  log "Settling Fulmine wallet..."
  curl -X GET http://localhost:${FULMINE_API_PORT}/api/v1/settle

  log "Getting transaction history..."
  curl -X GET http://localhost:${FULMINE_API_PORT}/api/v1/transactions

  log "Fulmine wallet setup completed successfully!"
}

# ── Helper: setup_delegator_wallet ───────────────────────────────────────────
setup_delegator_wallet() {
  log "Setting up Fulmine delegator wallet..."

  # Wait for delegator service to be ready (fulmine needs arkd to be fully serving)
  max_attempts=30
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if curl -s http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/status >/dev/null 2>&1; then
      log "Delegator service is ready!"
      break
    fi
    log "Waiting for delegator service... (attempt $attempt/$max_attempts)"
    sleep 2
    ((attempt++))
  done

  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: Delegator service failed to start within expected time"
    exit 1
  fi

  # Generate seed and create wallet
  log "Generating delegator seed..."
  seed_response=$(curl -s -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/genseed)
  private_key=$(echo "$seed_response" | jq -r '.nsec')

  log "Creating delegator wallet..."
  curl -s -X POST http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/create \
       -H "Content-Type: application/json" \
       -d "{\"private_key\": \"$private_key\", \"password\": \"password\", \"server_url\": \"http://ark:7070\"}"

  log "Unlocking delegator wallet..."
  curl -s -X POST http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/unlock \
       -H "Content-Type: application/json" \
       -d '{"password": "password"}'

  # Fund delegator wallet
  log "Getting delegator address..."
  max_attempts=5
  attempt=1
  local delegator_address=""
  while [ $attempt -le $max_attempts ]; do
    local address_response=$(curl -s -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/address)
    delegator_address=$(echo "$address_response" | jq -r '.address' | sed 's/bitcoin://' | sed 's/?ark=.*//')
    if [[ "$delegator_address" != "null" && -n "$delegator_address" ]]; then
      break
    fi
    log "Address not ready yet (attempt $attempt/$max_attempts), waiting..."
    sleep 2
    ((attempt++))
  done

  if [[ "$delegator_address" == "null" || -z "$delegator_address" ]]; then
    log "ERROR: Failed to get delegator address"
    exit 1
  fi

  log "Delegator address: $delegator_address"
  $NIGIRI faucet "$delegator_address" 0.01

  # Mine blocks to confirm boarding UTXO before settling
  log "Mining blocks for delegator boarding confirmation..."
  $NIGIRI rpc generatetoaddress 3 "$($NIGIRI rpc getnewaddress)"
  sleep 5

  log "Settling delegator wallet..."
  curl -s -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/settle

  # Wait for batch round and mine commitment tx
  sleep 15
  $NIGIRI rpc generatetoaddress 3 "$($NIGIRI rpc getnewaddress)"
  sleep 3

  log "Delegator wallet setup completed!"
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

resolve_nigiri

# ── Clean if requested ───────────────────────────────────────────────────────
if [ "$CLEAN" = true ]; then
  export USER_ENV
  source "$SCRIPT_DIR/clean-env.sh"
fi

# ── Pull and start Nigiri ────────────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^bitcoin$'; then
  log "Nigiri already running, skipping start..."
else
  log "Pulling latest Nigiri images..."
  $NIGIRI update || log "Nigiri update failed, continuing with existing images..."

  log "Starting Nigiri with Ark and LN support..."
  $NIGIRI start --ark --ln || log "Nigiri may already be running, continuing..."

  # ── Bitcoin Core low-fee config ──────────────────────────────────────────
  log "Configuring Bitcoin Core to accept low-fee transactions..."
  docker exec bitcoin sh -c 'printf "\nminrelaytxfee=0.0\nmintxfee=0.0\n" >> /data/.bitcoin/bitcoin.conf'
  docker restart bitcoin
  sleep 3
  log "Bitcoin Core restarted with minrelaytxfee=0 and mintxfee=0"
fi

# ── Override arkd if custom image specified ──────────────────────────────────
if [ -n "${ARKD_IMAGE:-}" ]; then
  log "Custom ARKD_IMAGE set: $ARKD_IMAGE"
  # Always recreate with override compose to ensure custom env vars are applied
  docker stop ark ark-wallet 2>/dev/null || true
  docker rm ark ark-wallet 2>/dev/null || true
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" pull
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" up -d
  sleep 5
fi

# ── Docker compose overlay ──────────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^boltz$'; then
  log "Ark stack already running, skipping..."
else
  log "Pulling latest custom Ark stack images..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" pull
  log "Starting ark stack..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" up -d
fi

# ── Wait for arkd and init wallet ────────────────────────────────────────────
arkd_ready=$(curl -s http://localhost:7070/v1/info 2>/dev/null | jq -r '.pubkey // empty' 2>/dev/null || echo "")
if [ -n "$arkd_ready" ]; then
  log "arkd wallet already initialized, skipping..."
else
  log "Waiting for arkd to be ready..."
  max_attempts=30
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if $NIGIRI ark init --password "$ARKD_PASSWORD" --server-url localhost:7070 --explorer http://chopsticks:3000 2>/dev/null; then
      log "arkd wallet initialized"
      break
    fi
    log "Waiting for arkd... (attempt $attempt/$max_attempts)"
    sleep 3
    ((attempt++))
  done
  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: arkd failed to start within expected time"
    exit 1
  fi

  $NIGIRI faucet $($NIGIRI ark receive | jq -r ".onchain_address") "$ARKD_FAUCET_AMOUNT"
  $NIGIRI ark redeem-notes -n $($NIGIRI arkd note --amount 100000000) --password "$ARKD_PASSWORD"
fi

# ── Setup services (idempotent) ─────────────────────────────────────────────
# Fulmine: check if wallet already exists
fulmine_status=$(curl -s http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status 2>/dev/null || echo "")
if echo "$fulmine_status" | jq -e '.initialized' 2>/dev/null | grep -q 'true'; then
  log "Fulmine wallet already initialized, skipping..."
else
  setup_fulmine_wallet
fi

# Delegator: check if wallet already exists
delegator_status=$(curl -s http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/status 2>/dev/null || echo "")
if echo "$delegator_status" | jq -e '.initialized' 2>/dev/null | grep -q 'true'; then
  log "Delegator wallet already initialized, skipping..."
else
  setup_delegator_wallet
fi

# LND: check if channel already exists
channel_count=$(docker exec boltz-lnd lncli --network=regtest listchannels 2>/dev/null | jq '.channels | length' 2>/dev/null || echo "0")
if [ "$channel_count" -gt 0 ]; then
  log "LND channel already open, skipping setup..."
else
  setup_lnd_wallet
fi

setup_arkd_fees

# ── Wait for boltz-lnd, restart boltz, verify pairs ─────────────────────────
log "Waiting for boltz-lnd wallet to be ready..."
max_attempts=30
attempt=1
while [ $attempt -le $max_attempts ]; do
  if docker exec boltz-lnd lncli --network=regtest getinfo >/dev/null 2>&1; then
    log "boltz-lnd wallet is ready"
    break
  fi
  log "boltz-lnd wallet not ready yet (attempt $attempt/$max_attempts)"
  sleep 2
  ((attempt++))
done
if [ $attempt -gt $max_attempts ]; then
  log "ERROR: boltz-lnd wallet failed to initialize"
  exit 1
fi

log "Restarting Boltz to reconnect to boltz-lnd..."
docker restart boltz
sleep 5

log "Verifying Boltz ARK/BTC pairs..."
max_attempts=30
attempt=1
while [ $attempt -le $max_attempts ]; do
  pairs=$(curl -s http://localhost:${NGINX_PORT}/v2/swap/submarine 2>/dev/null || echo "{}")
  if echo "$pairs" | grep -q '"ARK"'; then
    log "Boltz ARK/BTC pairs loaded successfully"
    break
  fi
  log "Waiting for Boltz pairs... (attempt $attempt/$max_attempts)"
  sleep 2
  ((attempt++))
done
if [ $attempt -gt $max_attempts ]; then
  log "ERROR: Boltz ARK/BTC pairs not available after restart"
  exit 1
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo " Regtest environment ready"
echo "========================================"
echo ""
echo "  Bitcoin RPC     http://localhost:18443"
echo "  Esplora         http://localhost:3000"
echo "  Arkd            http://localhost:7070"
echo "  Ark Wallet      http://localhost:6060"
echo "  Fulmine HTTP    http://localhost:${FULMINE_HTTP_PORT}"
echo "  Fulmine API     http://localhost:${FULMINE_API_PORT}"
echo "  Delegator gRPC  localhost:${DELEGATOR_GRPC_PORT}"
echo "  Delegator API   http://localhost:${DELEGATOR_API_PORT}"
echo "  Delegator HTTP  http://localhost:${DELEGATOR_HTTP_PORT}"
echo "  Boltz CORS      http://localhost:${NGINX_PORT}  (nginx proxy)"
echo "  Boltz gRPC      localhost:${BOLTZ_GRPC_PORT}"
echo "  Boltz LND       localhost:${BOLTZ_LND_RPC_PORT}"
echo ""
echo "  Arkd password:  ${ARKD_PASSWORD}"
if [ -n "${ARKD_IMAGE:-}" ]; then
  echo "  Arkd image:     ${ARKD_IMAGE}"
fi
echo ""
