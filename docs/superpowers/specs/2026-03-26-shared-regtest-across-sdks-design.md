# Shared Regtest Environment Across All Arkade SDKs

**Date:** 2026-03-26
**Status:** Approved
**Scope:** arkade-regtest, ts-sdk, boltz-swap, dotnet-sdk

## Problem

Each Arkade SDK independently maintains its own regtest infrastructure — docker-compose files, setup scripts, wallet initialization, LND channel setup, and CI workflows. This leads to:

- Duplicated infrastructure code across 3+ repos
- Version drift (ts-sdk pins arkd v0.9.0, boltz-swap pins v0.8.11, dotnet-sdk uses bump-arkd branch)
- Inconsistent environments between SDKs
- Maintenance burden when adding/changing services

`arkade-regtest` already consolidates the full stack (nigiri + arkd + fulmine + boltz + LND + nginx) but is not wired into any SDK.

## Solution

Each SDK adds `arkade-regtest` as a git submodule at `regtest/`. Infrastructure code is deleted from each SDK. A single `./regtest/start-env.sh` command starts the full environment. SDK-specific configuration is handled via `.env.regtest` overrides.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Service scope | Full stack everywhere | All SDKs need or will need boltz/LND; simplicity over optimization |
| Consumption method | Git submodule | Pinned, reproducible, works locally and in CI |
| Arkd version | Overridable via `.env` | SDKs pin different versions; `.env.regtest` per SDK |
| Post-setup hooks | None | SDK-specific setup stays in test code, not in arkade-regtest |
| CI nigiri | `start-env.sh` builds from source | Identical to local dev, no divergence from GH Action behavior |

## Section 1: arkade-regtest Changes

### 1.1 `.env` Auto-Discovery Chain

`start-env.sh` resolves configuration in this order (first found wins):

1. Explicit `--env <path>` flag (highest priority)
2. `../.env.regtest` (parent repo's override — the typical submodule case)
3. `.env` (local override in arkade-regtest itself)
4. `.env.defaults` (built-in fallback)

### 1.2 New Configurable Variables

Add to `.env.defaults`:

```bash
# Arkd image overrides (empty = use nigiri's built-in arkd)
ARKD_IMAGE=
ARKD_WALLET_IMAGE=

# Skip building nigiri from source, use system binary if available
NIGIRI_USE_SYSTEM=false
```

When `ARKD_IMAGE` is set, `start-env.sh` pulls and runs the specified image instead of relying on nigiri's bundled arkd.

### 1.3 Idempotent Start

`start-env.sh` detects if services are already running and skips redundant setup. Developers can re-run without `clean-env.sh` first.

### 1.4 Exit Codes & Summary

- Exit 0 on success, 1 on failure
- Print a summary of all service URLs on success:

```
Regtest environment ready

  Bitcoin RPC     http://localhost:18443
  Esplora         http://localhost:3000
  Arkd            http://localhost:7070
  Ark Wallet      http://localhost:6060
  Fulmine         http://localhost:7002
  Boltz API       http://localhost:9069
  Boltz LND       localhost:10010

  Arkd password:  secret
```

## Section 2: SDK Integration Pattern

### 2.1 Directory Structure

Each SDK:

```
sdk-repo/
  regtest/                    # git submodule -> arkade-os/arkade-regtest
  .env.regtest                # SDK-specific overrides (tracked in git)
  ...
```

### 2.2 `.env.regtest` Per SDK

**ts-sdk:**
```bash
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.0
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.0
```

**boltz-swap:**
```bash
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.8.11
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.8.11
```

**dotnet-sdk:**
```bash
# Uses nigiri's built-in arkd (bump-arkd branch) — no arkd override needed
FULMINE_IMAGE=ghcr.io/arklabshq/fulmine:v0.3.15
```

### 2.3 Wrapper Scripts

**ts-sdk & boltz-swap** (`package.json`):
```json
{
  "scripts": {
    "regtest:start": "./regtest/start-env.sh",
    "regtest:stop": "./regtest/stop-env.sh",
    "regtest:clean": "./regtest/clean-env.sh"
  }
}
```

**dotnet-sdk** (shell commands in README / CI):
```bash
./regtest/start-env.sh
dotnet test NArk.Tests.End2End
./regtest/stop-env.sh
```

### 2.4 Files Removed Per SDK

| SDK | Files Removed |
|-----|--------------|
| **ts-sdk** | `docker-compose.yml`, `server.Dockerfile`, `wallet.Dockerfile`, wallet-init logic from `test/setup.mjs` |
| **boltz-swap** | `test.docker-compose.yml`, infra logic from `test/e2e/setup.mjs`, `cors.nginx.conf` |
| **dotnet-sdk** | `Infrastructure/docker-compose.ark.yml`, `Infrastructure/start-env.sh`, `Infrastructure/cors.nginx.conf`, `Infrastructure/create-invoice.sh`, `Infrastructure/pay-invoice.sh` |

### 2.5 What Stays in SDK Test Code

- Test wallet/identity creation (SDK-specific)
- Test-specific funding (faucet calls for test addresses)
- Waiting for arkd readiness (simple HTTP poll)
- Assertions and test logic

Setup scripts (`setup.mjs` / `SharedArkInfrastructure.cs`) shrink to "wait for arkd ready + SDK-specific test setup." No more wallet init, LND channel setup, or fulmine config.

## Section 3: CI Pipeline Changes

### 3.1 Remove nigiri GitHub Action

No more `vulpemventures/nigiri-github-action@v1`. `start-env.sh` handles everything.

### 3.2 Prerequisites

Runner needs: `docker`, `go` (for nigiri build), `git` (for submodule checkout). All available on `ubuntu-latest`.

### 3.3 Uniform CI Pattern

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true

- uses: actions/setup-go@v5
  with:
    go-version: '1.23'

- uses: actions/cache@v4
  with:
    path: regtest/_build
    key: nigiri-${{ hashFiles('regtest/.env.defaults') }}

- name: Start regtest environment
  run: ./regtest/start-env.sh

- name: Run tests
  run: <sdk-specific test command>

- name: Capture logs on failure
  if: failure()
  run: |
    docker logs ark 2>&1 || true
    docker logs boltz 2>&1 || true
    docker logs boltz-lnd 2>&1 || true

- name: Stop regtest environment
  if: always()
  run: ./regtest/clean-env.sh
```

### 3.4 SDK-Specific Test Commands

| SDK | Test Command |
|-----|-------------|
| **ts-sdk** | `pnpm test:unit && pnpm test:integration-docker` |
| **boltz-swap** | `pnpm test:unit && pnpm test:integration-docker` |
| **dotnet-sdk** | `dotnet test NArk.Tests && dotnet test NArk.Tests.End2End` |

### 3.5 Nigiri Build Caching

Cache `regtest/_build/` keyed on `.env.defaults` hash to avoid rebuilding nigiri on every CI run.

## Section 4: Developer Experience

### 4.1 One-Shot Start

```bash
git clone --recurse-submodules <sdk-repo>
cd <sdk-repo>
./regtest/start-env.sh
# Full environment running. Run tests.
```

Fallback if cloned without submodules:
```bash
git submodule update --init
./regtest/start-env.sh
```

### 4.2 Missing Submodule Detection

If `regtest/` is empty, fail fast:
```
Error: regtest/ directory is empty. Run: git submodule update --init
```

### 4.3 Daily Workflow

```bash
./regtest/start-env.sh     # Start (idempotent — skips if running)
# ... develop and run tests ...
./regtest/stop-env.sh      # Pause (preserves state)
./regtest/start-env.sh     # Resume
./regtest/clean-env.sh     # Full reset when needed
```

### 4.4 Updating arkade-regtest

When arkade-regtest gets a new feature or bugfix:
```bash
cd regtest && git pull origin master && cd ..
git add regtest
git commit -m "chore: bump arkade-regtest"
```

## Implementation Order

1. **arkade-regtest**: Add `.env` auto-discovery, new config vars, idempotent start, summary output
2. **dotnet-sdk**: Add submodule, `.env.regtest`, update CI, remove old infrastructure
3. **boltz-swap**: Add submodule, `.env.regtest`, update CI, remove old infrastructure
4. **ts-sdk**: Add submodule, `.env.regtest`, update CI, remove old infrastructure, remove Dockerfiles

Each SDK gets its own PR. All PRs reference this spec.
