# Shared Regtest Across SDKs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make arkade-regtest the single regtest environment for ts-sdk, boltz-swap, and dotnet-sdk via git submodules, eliminating duplicated infrastructure.

**Architecture:** arkade-regtest gains `.env` auto-discovery and an `ARKD_IMAGE` override mechanism. Each SDK adds it as a submodule at `regtest/`, provides a `.env.regtest` with version pins, deletes its bespoke docker-compose/setup infra, and updates CI to call `./regtest/start-env.sh`.

**Tech Stack:** Bash, Docker Compose, GitHub Actions, Node.js (ts-sdk/boltz-swap test setup), .NET (dotnet-sdk test setup)

**Spec:** `docs/superpowers/specs/2026-03-26-shared-regtest-across-sdks-design.md`

---

## File Structure

### arkade-regtest (modifications)
- Modify: `start-env.sh` — add `.env` auto-discovery, `ARKD_IMAGE` override, idempotent start, summary output
- Modify: `.env.defaults` — add `ARKD_IMAGE`, `ARKD_WALLET_IMAGE` variables
- Modify: `clean-env.sh` — add `.env` auto-discovery (same chain as start-env.sh)
- Modify: `stop-env.sh` — add `.env` auto-discovery (same chain as start-env.sh)
- Create: `docker/docker-compose.arkd-override.yml` — compose file for custom arkd images

### ts-sdk (in separate repo: arkade-os/ts-sdk)
- Create: `.gitmodules` — submodule definition
- Create: `regtest/` — submodule directory
- Create: `.env.regtest` — arkd v0.9.0 pin
- Modify: `package.json` — replace docker scripts with regtest:* wrappers
- Modify: `test/setup.mjs` — remove infrastructure setup, keep SDK-specific test setup only
- Modify: `.github/workflows/ci.yml` — replace nigiri GH Action + docker-compose with regtest/start-env.sh
- Delete: `docker-compose.yml`
- Delete: `server.Dockerfile`
- Delete: `wallet.Dockerfile`

### boltz-swap (in separate repo: arkade-os/boltz-swap)
- Create: `.gitmodules` — submodule definition
- Create: `regtest/` — submodule directory
- Create: `.env.regtest` — arkd v0.8.11 pin
- Modify: `package.json` — replace docker scripts with regtest:* wrappers
- Modify: `test/e2e/setup.mjs` — remove infrastructure setup, keep SDK-specific test setup only
- Modify: `.github/workflows/ci.yml` — replace nigiri GH Action + docker-compose with regtest/start-env.sh
- Delete: `test.docker-compose.yml`
- Delete: `cors.nginx.conf`

### dotnet-sdk (in separate repo: arkade-os/dotnet-sdk)
- Create: `.gitmodules` — submodule definition
- Create: `regtest/` — submodule directory
- Create: `.env.regtest` — fulmine version pin
- Modify: `.github/workflows/build.yml` — replace Infrastructure/start-env.sh with regtest/start-env.sh
- Delete: `NArk.Tests.End2End/Infrastructure/docker-compose.ark.yml`
- Delete: `NArk.Tests.End2End/Infrastructure/start-env.sh`
- Delete: `NArk.Tests.End2End/Infrastructure/cors.nginx.conf`
- Delete: `NArk.Tests.End2End/Infrastructure/create-invoice.sh`
- Delete: `NArk.Tests.End2End/Infrastructure/pay-invoice.sh`

---

## Task 1: Add `.env` Auto-Discovery to arkade-regtest

**Files:**
- Modify: `start-env.sh` — replace line 12 (`source .env.defaults`) and lines 36-39 (`if USER_ENV` block). Lines 14-34 (argument parsing) stay as-is.
- Modify: `stop-env.sh:12-16` — replace env loading block
- Modify: `clean-env.sh:12-16` — replace env loading block
- Create: `lib/env.sh` — shared `load_env()` function

This task implements the `.env` layering logic: always load `.env.defaults`, then layer the first override found (--env flag > ../.env.regtest > .env).

- [ ] **Step 1: Create shared env-loading function**

Create a helper function `load_env()`. In `start-env.sh`, replace line 12 (`source "$SCRIPT_DIR/.env.defaults"`) and lines 36-39 (the `if [ -n "$USER_ENV" ]` block) with a call to `load_env`. Keep the argument parsing block (lines 14-34) unchanged between them:

```bash
# ── Load environment ─────────────────────────────────────────────────────────
load_env() {
  # Always load defaults as base
  source "$SCRIPT_DIR/.env.defaults"

  # Layer override: first found wins
  local override=""
  if [ -n "${USER_ENV:-}" ] && [ -f "$USER_ENV" ]; then
    override="$USER_ENV"
  elif [ -f "$SCRIPT_DIR/../.env.regtest" ]; then
    override="$SCRIPT_DIR/../.env.regtest"
  elif [ -f "$SCRIPT_DIR/.env" ]; then
    override="$SCRIPT_DIR/.env"
  fi

  if [ -n "$override" ]; then
    log "Loading overrides from $override"
    source "$override"
  fi
}
```

Replace lines 11-12 (`source "$SCRIPT_DIR/.env.defaults"`) and lines 35-39 (the `if [ -n "$USER_ENV" ]` block) with a single call to `load_env` after argument parsing. The `--env` flag still sets `USER_ENV` which `load_env` checks first.

- [ ] **Step 2: Apply same pattern to `stop-env.sh`**

Replace lines 11-16 of `stop-env.sh` with the same `load_env()` function and call.

- [ ] **Step 3: Apply same pattern to `clean-env.sh`**

Replace lines 11-16 of `clean-env.sh` with the same `load_env()` function and call.

- [ ] **Step 4: Extract shared function to avoid duplication**

The `load_env()` function is identical across all three scripts. Extract it to a new file `lib/env.sh`:

```bash
mkdir -p lib/
```

```bash
#!/usr/bin/env bash
# Shared environment loading logic for arkade-regtest scripts.
# Sources .env.defaults as base, then layers the first override found.

load_env() {
  local script_dir="$1"

  source "$script_dir/.env.defaults"

  local override=""
  if [ -n "${USER_ENV:-}" ] && [ -f "$USER_ENV" ]; then
    override="$USER_ENV"
  elif [ -f "$script_dir/../.env.regtest" ]; then
    override="$script_dir/../.env.regtest"
  elif [ -f "$script_dir/.env" ]; then
    override="$script_dir/.env"
  fi

  if [ -n "$override" ]; then
    log "Loading overrides from $override"
    source "$override"
  fi
}
```

All three scripts source it: `source "$SCRIPT_DIR/lib/env.sh"` then call `load_env "$SCRIPT_DIR"`.

- [ ] **Step 5: Test locally**

```bash
cd /c/Git/arkade-regtest
# Test 1: No override — should load .env.defaults only
bash -x start-env.sh 2>&1 | head -20
# Verify: logs show loading .env.defaults, no override

# Test 2: Create .env.regtest in parent dir
echo 'ARKD_PASSWORD=test123' > ../.env.regtest
bash -x start-env.sh 2>&1 | head -20
# Verify: logs show "Loading overrides from ../.env.regtest"
rm ../.env.regtest

# Test 3: --env flag
echo 'ARKD_PASSWORD=custom' > /tmp/test.env
bash -x start-env.sh --env /tmp/test.env 2>&1 | head -20
# Verify: logs show "Loading overrides from /tmp/test.env"
```

- [ ] **Step 6: Commit**

Also ensure `lib/env.sh` is covered by `.gitattributes` LF enforcement. Add `lib/*.sh text eol=lf` if not already covered by an existing pattern.

```bash
git add lib/env.sh start-env.sh stop-env.sh clean-env.sh .gitattributes
git commit -m "feat: add .env auto-discovery chain for submodule usage

Always loads .env.defaults as base, then layers the first override
found: --env flag > ../.env.regtest > .env"
```

---

## Task 2: Add `ARKD_IMAGE` Override Variables

**Files:**
- Modify: `.env.defaults:11-15`
- Modify: `start-env.sh:42-44` (export block)

- [ ] **Step 1: Add variables to `.env.defaults`**

Add after line 9 (after `NIGIRI_REPO_URL`):

```bash
# Arkd image overrides (empty = use nigiri's built-in arkd)
# When set, start-env.sh stops nigiri's arkd and starts these images instead.
ARKD_IMAGE=
ARKD_WALLET_IMAGE=
```

- [ ] **Step 2: Add to export block in `start-env.sh`**

Modify line 42 to add the new variables:

```bash
export BOLTZ_LND_IMAGE FULMINE_IMAGE BOLTZ_IMAGE NGINX_IMAGE
export ARKD_IMAGE ARKD_WALLET_IMAGE
export BOLTZ_LND_P2P_PORT BOLTZ_LND_RPC_PORT FULMINE_HTTP_PORT FULMINE_API_PORT
export BOLTZ_GRPC_PORT BOLTZ_API_PORT BOLTZ_WS_PORT NGINX_PORT
```

- [ ] **Step 3: Commit**

```bash
git add .env.defaults start-env.sh
git commit -m "feat: add ARKD_IMAGE and ARKD_WALLET_IMAGE config vars"
```

---

## Task 3: Create arkd Override Compose File

**Files:**
- Create: `docker/docker-compose.arkd-override.yml`

This compose file is only used when `ARKD_IMAGE` is set. It replaces nigiri's built-in arkd and arkd-wallet with custom images.

- [ ] **Step 1: Create the override compose file**

```yaml
# Used when ARKD_IMAGE is set to override nigiri's built-in arkd.
# start-env.sh stops nigiri's arkd containers and starts these instead.
name: nigiri
services:
  ark-wallet:
    image: ${ARKD_WALLET_IMAGE}
    container_name: ark-wallet
    restart: unless-stopped
    environment:
      - ARKD_WALLET_NBXPLORER_URL=http://nbxplorer:32838
    ports:
      - '6060:6060'
    volumes:
      - ark_wallet_datadir:/app/wallet-data

  ark:
    image: ${ARKD_IMAGE}
    container_name: ark
    restart: unless-stopped
    depends_on:
      - ark-wallet
    environment:
      - ARKD_NO_TLS=true
      - ARKD_NO_MACAROONS=true
      - ARKD_WALLET_ADDR=ark-wallet:6060
      - ARKD_ESPLORA_URL=http://chopsticks:3000
      - ARKD_VTXO_MIN_AMOUNT=1
      - ARKD_DB_TYPE=sqlite
      - ARKD_EVENT_DB_TYPE=badger
      - ARKD_UNLOCKER_PASSWORD=${ARKD_PASSWORD:-secret}
    ports:
      - '7070:7070'
      - '7071:7071'
    volumes:
      - ark_datadir:/app/data

volumes:
  ark_wallet_datadir:
  ark_datadir:

networks:
  default:
    name: nigiri
    external: true
```

- [ ] **Step 2: Commit**

```bash
git add docker/docker-compose.arkd-override.yml
git commit -m "feat: add arkd override compose for custom image versions"
```

---

## Task 4: Implement ARKD_IMAGE Override + Idempotent Start in `start-env.sh`

**Files:**
- Modify: `start-env.sh:243-328` (nigiri start through boltz verification)
- Modify: `clean-env.sh` (add arkd-override cleanup)
- Modify: `stop-env.sh` (add arkd-override cleanup)

This task replaces the entire "main" section of `start-env.sh` (from nigiri start through service setup) with the final idempotent version that also supports `ARKD_IMAGE` override. Writing the idempotent version from the start avoids rewriting the same code twice.

- [ ] **Step 1: Replace nigiri start + bitcoin config (lines 243-255) with idempotent version**

```bash
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
```

- [ ] **Step 2: Add arkd override logic with idempotent check (after nigiri start)**

```bash
# ── Override arkd if custom image specified ──────────────────────────────────
if [ -n "${ARKD_IMAGE:-}" ]; then
  if docker ps --format '{{.Names}}' | grep -q '^ark$' && \
     [ "$(docker inspect ark --format '{{.Config.Image}}')" = "$ARKD_IMAGE" ]; then
    log "Custom arkd already running with correct image, skipping..."
  else
    log "Custom ARKD_IMAGE set: $ARKD_IMAGE"
    docker stop ark ark-wallet 2>/dev/null || true
    docker rm ark ark-wallet 2>/dev/null || true
    docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" pull
    docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" up -d
    sleep 5
  fi
fi
```

- [ ] **Step 3: Replace docker-compose overlay start (lines 257-262) with idempotent version**

```bash
# ── Docker compose overlay ──────────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^boltz$'; then
  log "Ark stack already running, skipping..."
else
  log "Pulling latest custom Ark stack images..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" pull
  log "Starting ark stack..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" up -d
fi
```

- [ ] **Step 4: Replace wallet init (lines 264-283) with idempotent version**

Use the arkd HTTP endpoint for a robust readiness check instead of relying on CLI output format:

```bash
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
```

- [ ] **Step 5: Replace service setup calls (lines 285-288) with idempotent versions**

```bash
# ── Setup services (idempotent) ─────────────────────────────────────────────
# Fulmine: check if wallet already exists
fulmine_status=$(curl -s http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status 2>/dev/null || echo "")
if echo "$fulmine_status" | jq -e '.initialized' 2>/dev/null | grep -q 'true'; then
  log "Fulmine wallet already initialized, skipping..."
else
  setup_fulmine_wallet
fi

# LND: check if channel already exists
channel_count=$(docker exec boltz-lnd lncli --network=regtest listchannels 2>/dev/null | jq '.channels | length' 2>/dev/null || echo "0")
if [ "$channel_count" -gt 0 ]; then
  log "LND channel already open, skipping setup..."
else
  setup_lnd_wallet
fi

setup_arkd_fees
```

- [ ] **Step 6: Add arkd-override cleanup to `clean-env.sh` and `stop-env.sh`**

In `clean-env.sh`, add before the "Stop ark overlay stack" line (before line 28). Check if ARKD_IMAGE was used by detecting the container's image, not file existence:

```bash
# ── Stop arkd override if custom image was used ──────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -q '^ark$' && \
   [ -n "$(docker inspect ark --format '{{.Config.Image}}' 2>/dev/null | grep -v 'nigiri')" ]; then
  log "Stopping custom arkd override containers..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" down --volumes --remove-orphans 2>/dev/null || true
fi
```

In `stop-env.sh`, add before line 28:

```bash
if docker ps --format '{{.Names}}' | grep -q '^ark$' && \
   [ -n "$(docker inspect ark --format '{{.Config.Image}}' 2>/dev/null | grep -v 'nigiri')" ]; then
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" stop 2>/dev/null || true
fi
```

Also add `export ARKD_IMAGE ARKD_WALLET_IMAGE` to `stop-env.sh` and `clean-env.sh` after the `load_env` call so docker-compose can interpolate the variables during cleanup.

- [ ] **Step 7: Commit**

```bash
git add start-env.sh clean-env.sh stop-env.sh
git commit -m "feat: implement ARKD_IMAGE override + idempotent start

- When ARKD_IMAGE is set, stops nigiri's built-in arkd and starts custom image
- All sections are idempotent: skip setup if services already running
- Uses HTTP endpoint check for arkd readiness (robust vs CLI output parsing)
- Cleanup scripts detect custom arkd by container image, not file existence"
```

---

## Task 5: Add Summary Output

**Files:**
- Modify: `start-env.sh:330-343` (the "Done" section at the end)

- [ ] **Step 1: Replace the current output block**

Replace lines 330-343 with:

```bash
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
echo "  Boltz CORS      http://localhost:${NGINX_PORT}  (nginx proxy)"
echo "  Boltz gRPC      localhost:${BOLTZ_GRPC_PORT}"
echo "  Boltz LND       localhost:${BOLTZ_LND_RPC_PORT}"
echo ""
echo "  Arkd password:  ${ARKD_PASSWORD}"
if [ -n "${ARKD_IMAGE:-}" ]; then
  echo "  Arkd image:     ${ARKD_IMAGE}"
fi
echo ""
```

- [ ] **Step 2: Commit**

```bash
git add start-env.sh
git commit -m "feat: add service summary output on startup"
```

---

## Task 6: Add Missing Submodule Detection

**Files:**
- Modify: `start-env.sh` (add at top, after SCRIPT_DIR)

- [ ] **Step 1: Add check at start of script**

Add after line 4 (`SCRIPT_DIR=...`):

```bash
# ── Verify script is not running from an empty submodule ─────────────────────
if [ ! -f "$SCRIPT_DIR/.env.defaults" ]; then
  echo "ERROR: $SCRIPT_DIR/.env.defaults not found."
  echo "If this is a git submodule, run: git submodule update --init"
  exit 1
fi
```

- [ ] **Step 2: Commit**

```bash
git add start-env.sh
git commit -m "feat: detect empty submodule and show helpful error"
```

---

## Task 7: Push arkade-regtest Changes and Open PR

**Files:** None (git operations only)

- [ ] **Step 1: Create branch and push**

```bash
git checkout -b feat/shared-regtest-env-discovery
git push -u origin feat/shared-regtest-env-discovery
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: shared regtest env with .env auto-discovery" --body "$(cat <<'EOF'
## Summary
- Add `.env` auto-discovery chain (`.env.defaults` base + first override from `--env` / `../.env.regtest` / `.env`)
- Add `ARKD_IMAGE` / `ARKD_WALLET_IMAGE` override variables with compose overlay
- Add idempotent start detection (skip setup if services already running)
- Add service summary output on startup
- Add missing submodule detection with helpful error

## Context
This enables arkade-regtest to be used as a git submodule across ts-sdk, boltz-swap, and dotnet-sdk. See `docs/superpowers/specs/2026-03-26-shared-regtest-across-sdks-design.md`.

## Test plan
- [ ] `./start-env.sh` works from repo root (no override)
- [ ] `./start-env.sh --env /path/to/.env` works with explicit override
- [ ] Place `.env.regtest` in parent dir, run from submodule — override detected
- [ ] Set `ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.0` in override — custom arkd starts
- [ ] Run `./start-env.sh` twice — second run skips already-running services
- [ ] `./clean-env.sh && ./start-env.sh` — clean restart works
EOF
)"
```

- [ ] **Step 3: Iterate until CI is green**

Check CI status, fix failures, push fixes, repeat.

---

---

> **IMPORTANT:** Tasks 8-10 (SDK integrations) require that the arkade-regtest PR (Task 7) is **merged to master first**. The `git submodule add` command pins to the default branch, so all new features must be on `master` before SDKs can consume them. If the PR is not yet merged, temporarily track the feature branch: `git submodule add -b feat/shared-regtest-env-discovery https://github.com/arkade-os/arkade-regtest.git regtest`

---

## Task 8: Integrate arkade-regtest into ts-sdk

**Repo:** `C:\Git\ts-sdk` (arkade-os/ts-sdk)

**Files:**
- Create: `.gitmodules`
- Create: `.env.regtest`
- Delete: `docker-compose.yml` (128 lines)
- Delete: `server.Dockerfile` (39 lines)
- Delete: `wallet.Dockerfile` (32 lines)
- Modify: `package.json` (scripts section)
- Modify: `test/setup.mjs` (remove infra setup, ~100 lines)
- Modify: `.github/workflows/ci.yml` (81 lines)

- [ ] **Step 1: Add submodule**

```bash
cd /c/Git/ts-sdk
git checkout -b feat/use-arkade-regtest
git submodule add https://github.com/arkade-os/arkade-regtest.git regtest
```

- [ ] **Step 2: Create `.env.regtest`**

```bash
# ts-sdk arkade-regtest overrides
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.0
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.0
```

- [ ] **Step 3: Delete old infrastructure files**

```bash
git rm docker-compose.yml server.Dockerfile wallet.Dockerfile
```

- [ ] **Step 4: Update `package.json` scripts**

Replace the docker-related test scripts with:

```json
"regtest:start": "./regtest/start-env.sh",
"regtest:stop": "./regtest/stop-env.sh",
"regtest:clean": "./regtest/clean-env.sh",
"regtest": "pnpm regtest:clean && pnpm regtest:start && pnpm test:setup-docker",
"test:setup-docker": "node test/setup.mjs docker",
"test:integration-docker": "ARK_ENV=docker vitest run test/e2e/**",
```

Remove: `test:build-docker`, `test:up-docker`, `test:down-docker`.

- [ ] **Step 5: Trim `test/setup.mjs`**

Remove the `setupArkServer()` function and all infrastructure setup logic (wallet creation, wallet unlocking, wallet funding, note creation/redemption). These are now handled by `regtest/start-env.sh`.

Keep only:
- `waitForArkServer()` — SDK tests still need to wait for readiness
- `setupFulmine()` — only if ts-sdk needs SDK-specific fulmine config beyond what arkade-regtest provides
- Any SDK-specific test wallet setup

The script should reduce to roughly: wait for arkd → done.

- [ ] **Step 6: Update `.github/workflows/ci.yml`**

Replace the CI workflow with:

```yaml
name: ci
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit

  integration:
    runs-on: ubuntu-latest
    needs: [lint, unit]
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      - uses: actions/cache@v4
        with:
          path: regtest/_build
          key: nigiri-${{ hashFiles('regtest/.env.defaults', '.env.regtest') }}
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Start regtest environment
        run: ./regtest/start-env.sh
      - name: Setup test wallets
        run: pnpm test:setup-docker
      - name: Run integration tests
        run: pnpm test:integration-docker
        env:
          ARK_ENV: docker
      - name: Capture logs on failure
        if: failure()
        run: |
          docker logs ark 2>&1 || true
          docker logs boltz 2>&1 || true
          docker logs boltz-lnd 2>&1 || true
          docker logs boltz-fulmine 2>&1 || true
      - name: Cleanup
        if: always()
        run: ./regtest/clean-env.sh
```

- [ ] **Step 7: Commit all changes**

```bash
git add .gitmodules regtest .env.regtest package.json test/setup.mjs .github/workflows/ci.yml
git commit -m "feat: use arkade-regtest submodule for regtest environment

Replace bespoke docker-compose + Dockerfiles with shared arkade-regtest
submodule. Pins arkd to v0.9.0 via .env.regtest."
```

- [ ] **Step 8: Push and open PR**

```bash
git push -u origin feat/use-arkade-regtest
gh pr create --title "feat: use arkade-regtest for regtest environment" --body "$(cat <<'EOF'
## Summary
- Replace custom docker-compose.yml, server.Dockerfile, wallet.Dockerfile with arkade-regtest submodule
- Pin arkd to v0.9.0 via .env.regtest
- Simplify CI: remove nigiri GH Action, use regtest/start-env.sh
- Trim test/setup.mjs to SDK-specific setup only

## Test plan
- [ ] `./regtest/start-env.sh` starts full environment
- [ ] `pnpm test:unit` passes
- [ ] `pnpm test:integration-docker` passes
- [ ] CI workflow completes successfully
EOF
)"
```

- [ ] **Step 9: Iterate until CI is green**

---

## Task 9: Integrate arkade-regtest into boltz-swap

**Repo:** `C:\Git\boltz-swap` (arkade-os/boltz-swap)

**Files:**
- Create: `.gitmodules`
- Create: `.env.regtest`
- Delete: `test.docker-compose.yml` (282 lines)
- Delete: `cors.nginx.conf`
- Modify: `package.json` (scripts section)
- Modify: `test/e2e/setup.mjs` (remove infra setup, ~250 lines)
- Modify: `.github/workflows/ci.yml` (86 lines)

- [ ] **Step 1: Add submodule**

```bash
cd /c/Git/boltz-swap
git checkout -b feat/use-arkade-regtest
git submodule add https://github.com/arkade-os/arkade-regtest.git regtest
```

- [ ] **Step 2: Create `.env.regtest`**

```bash
# boltz-swap arkade-regtest overrides
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.8.11
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.8.11
```

- [ ] **Step 3: Delete old infrastructure files**

```bash
git rm test.docker-compose.yml cors.nginx.conf
```

- [ ] **Step 4: Update `package.json` scripts**

Replace docker-related test scripts with:

```json
"regtest:start": "./regtest/start-env.sh",
"regtest:stop": "./regtest/stop-env.sh",
"regtest:clean": "./regtest/clean-env.sh",
"regtest": "pnpm regtest:clean && pnpm regtest:start && pnpm test:setup-docker",
"test:setup-docker": "node test/e2e/setup.mjs",
"test:integration-docker": "ARK_ENV=docker vitest run test/e2e/**",
```

Remove: `test:build-docker`, `test:up-docker`, `test:down-docker`.

- [ ] **Step 5: Trim `test/e2e/setup.mjs`**

Remove: `setupArkServer()` (lines 160-231), `setupBoltz()` (lines 233-391), and all infrastructure helper functions (faucet, waitForCmd, health checks that duplicate arkade-regtest's setup).

Keep only:
- `waitForArkServer()` — wait for arkd readiness before running tests
- Any SDK-specific setup (e.g., creating test-specific funded wallets)

The script should reduce to roughly: wait for arkd + wait for boltz pairs → done.

- [ ] **Step 6: Update `.github/workflows/ci.yml`**

Same structure as ts-sdk (Task 8, Step 6). The integration job:

```yaml
  integration:
    runs-on: ubuntu-latest
    needs: [lint, unit]
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      - uses: actions/cache@v4
        with:
          path: regtest/_build
          key: nigiri-${{ hashFiles('regtest/.env.defaults', '.env.regtest') }}
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Start regtest environment
        run: ./regtest/start-env.sh
      - name: Setup test wallets
        run: pnpm test:setup-docker
      - name: Run integration tests
        run: pnpm test:integration-docker
        env:
          ARK_ENV: docker
      - name: Capture logs on failure
        if: failure()
        run: |
          docker logs ark 2>&1 || true
          docker logs boltz 2>&1 || true
          docker logs boltz-lnd 2>&1 || true
          docker logs boltz-fulmine 2>&1 || true
      - name: Cleanup
        if: always()
        run: ./regtest/clean-env.sh
```

Remove: `vulpemventures/nigiri-github-action@v1` step, `test:build-docker`, `test:up-docker`, `test:down-docker` steps.

- [ ] **Step 7: Commit, push, open PR**

```bash
git add .gitmodules regtest .env.regtest package.json test/e2e/setup.mjs .github/workflows/ci.yml
git commit -m "feat: use arkade-regtest submodule for regtest environment

Replace bespoke test.docker-compose.yml + cors.nginx.conf with shared
arkade-regtest submodule. Pins arkd to v0.8.11 via .env.regtest."

git push -u origin feat/use-arkade-regtest
gh pr create --title "feat: use arkade-regtest for regtest environment" --body "$(cat <<'EOF'
## Summary
- Replace custom test.docker-compose.yml and cors.nginx.conf with arkade-regtest submodule
- Pin arkd to v0.8.11 via .env.regtest
- Simplify CI: remove nigiri GH Action, use regtest/start-env.sh
- Trim test/e2e/setup.mjs to SDK-specific setup only

## Test plan
- [ ] `./regtest/start-env.sh` starts full environment
- [ ] `pnpm test:unit` passes
- [ ] `pnpm test:integration-docker` passes
- [ ] CI workflow completes successfully
EOF
)"
```

- [ ] **Step 8: Iterate until CI is green**

---

## Task 10: Integrate arkade-regtest into dotnet-sdk

**Repo:** `C:\Git\arkade-dotnet-sdk` (arkade-os/dotnet-sdk)

**Files:**
- Create: `.gitmodules`
- Create: `.env.regtest`
- Delete: `NArk.Tests.End2End/Infrastructure/docker-compose.ark.yml` (223 lines)
- Delete: `NArk.Tests.End2End/Infrastructure/start-env.sh` (467 lines)
- Delete: `NArk.Tests.End2End/Infrastructure/cors.nginx.conf` (48 lines)
- Delete: `NArk.Tests.End2End/Infrastructure/create-invoice.sh`
- Delete: `NArk.Tests.End2End/Infrastructure/pay-invoice.sh`
- Modify: `.github/workflows/build.yml` (141 lines)

- [ ] **Step 1: Add submodule**

```bash
cd /c/Git/arkade-dotnet-sdk
git checkout -b feat/use-arkade-regtest
git submodule add https://github.com/arkade-os/arkade-regtest.git regtest
```

- [ ] **Step 2: Create `.env.regtest`**

```bash
# dotnet-sdk arkade-regtest overrides
# Uses nigiri's built-in arkd (bump-arkd branch) — no arkd override needed
FULMINE_IMAGE=ghcr.io/arklabshq/fulmine:v0.3.15
```

- [ ] **Step 3: Delete old infrastructure files**

```bash
git rm NArk.Tests.End2End/Infrastructure/docker-compose.ark.yml
git rm NArk.Tests.End2End/Infrastructure/start-env.sh
git rm NArk.Tests.End2End/Infrastructure/cors.nginx.conf
git rm NArk.Tests.End2End/Infrastructure/create-invoice.sh
git rm NArk.Tests.End2End/Infrastructure/pay-invoice.sh
```

Note: Keep the `NArk.Tests.End2End/Infrastructure/` directory if it contains other files needed by tests (e.g., DockerHelper.cs references). Check before deleting the directory itself.

- [ ] **Step 4: Update `.github/workflows/build.yml`**

In the `e2e` job, replace:
```yaml
- name: Start environment
  run: |
    chmod +x ./NArk.Tests.End2End/Infrastructure/start-env.sh
    ./NArk.Tests.End2End/Infrastructure/start-env.sh --clean
```

With:
```yaml
- uses: actions/cache@v4
  with:
    path: regtest/_build
    key: nigiri-${{ hashFiles('regtest/.env.defaults', '.env.regtest') }}
- name: Start regtest environment
  run: ./regtest/start-env.sh
```

Update the checkout step to include submodules:
```yaml
- uses: actions/checkout@v4
  with:
    submodules: true
```

Update cleanup step:
```yaml
- name: Cleanup
  if: always()
  run: ./regtest/clean-env.sh
```

Remove any `go-version` setup if not already present (check if the workflow already sets up Go for nigiri build — if not, add the `actions/setup-go@v5` step).

- [ ] **Step 5: Verify DockerHelper.cs still works**

The dotnet-sdk's `DockerHelper.cs` uses `docker exec ark` for commands. Since arkade-regtest names the container `ark` (same as nigiri's default), this should work without changes. Verify by checking container names match.

- [ ] **Step 6: Commit, push, open PR**

```bash
git add .gitmodules regtest .env.regtest .github/workflows/build.yml
git add -u  # stage deletions
git commit -m "feat: use arkade-regtest submodule for regtest environment

Replace custom Infrastructure/ scripts and docker-compose with shared
arkade-regtest submodule. Fulmine pinned to v0.3.15 via .env.regtest."

git push -u origin feat/use-arkade-regtest
gh pr create --title "feat: use arkade-regtest for regtest environment" --body "$(cat <<'EOF'
## Summary
- Replace custom Infrastructure/ directory (start-env.sh, docker-compose.ark.yml, etc.) with arkade-regtest submodule
- Pin fulmine to v0.3.15 via .env.regtest
- Simplify CI: use regtest/start-env.sh instead of custom script

## Test plan
- [ ] `./regtest/start-env.sh` starts full environment
- [ ] `dotnet test NArk.Tests` passes
- [ ] `dotnet test NArk.Tests.End2End` passes
- [ ] CI workflow completes successfully
EOF
)"
```

- [ ] **Step 7: Iterate until CI is green**

---

## Task 11: Update arkade-regtest README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add "Using as a Submodule" section to README**

Add a section documenting the submodule usage pattern:

```markdown
## Using as a Git Submodule

Add arkade-regtest to your project:

    git submodule add https://github.com/arkade-os/arkade-regtest.git regtest

Create `.env.regtest` in your repo root to override defaults:

    # Pin specific arkd version
    ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.0
    ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.0

Start the environment:

    ./regtest/start-env.sh

The script auto-discovers `.env.regtest` from the parent directory.

See `.env.defaults` for all available configuration options.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add submodule usage instructions to README"
```

- [ ] **Step 3: Push to the open arkade-regtest PR branch and verify CI**

```bash
git push
```
