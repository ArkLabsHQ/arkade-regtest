# arkade-regtest

A self-contained, cross-platform regtest environment for Ark protocol development. It orchestrates Bitcoin Core, Fulcrum, mempool, NBXplorer, arkd, Fulmine, Boltz, and an LND node into a single reproducible Docker Compose stack — driven by a small zero-dependency Node CLI.

There is **no dependency on nigiri** and **no compiled binary** to maintain: everything is standard Docker images plus a Node orchestrator. It runs the same on Linux, macOS, and Windows (no WSL required).

## Requirements

- **Docker** + the **`docker compose`** plugin
- **Node.js >= 18** (uses only the standard library — no `npm install` needed)

## Quick start

```bash
# Start the whole environment
node regtest.mjs start

# Stop all services (preserves data)
node regtest.mjs stop

# Stop and remove all containers + volumes
node regtest.mjs clean
```

`package.json` also exposes `npm start` / `npm stop` / `npm run clean` as aliases.

### Other commands

```bash
node regtest.mjs faucet <address> <amountBtc>   # send on-chain coins + confirm
node regtest.mjs mine [n]                        # mine n blocks (default 1)
node regtest.mjs create-invoice [--secondary]    # 100k-sat invoice (boltz-lnd, or lnd)
node regtest.mjs pay-invoice <invoice>           # pay from the non-destination node
```

> **Block production is explicit.** Unlike the old nigiri/chopsticks setup, there is no background auto-miner: regtest produces blocks only when you mine. The `start` flow mines at each funding step, and `faucet` confirms its own transaction. If a test broadcasts a transaction and waits for a confirmation, it must call `node regtest.mjs mine`.

## Architecture

Two compose files are merged into one project (`arkade-regtest`):

- **`docker/compose.base.yml`** — chain + indexers + explorer + counterparty LN:
  `bitcoin` (Bitcoin Core regtest), `postgres`, `nbxplorer`, `fulcrum` (Electrum server),
  `mempool_api` + `mempool_web` + `mempool_mariadb` (block explorer & Esplora REST API), and `lnd`.
- **`docker/compose.ark.yml`** — the Ark stack: `arkd` + `arkd-wallet`, `boltz`, `boltz-lnd`,
  `boltz-fulmine`, `fulmine-delegator`, `nginx-boltz`, `lnurl-server`, `arkade-wallet`, and the
  profile-gated `emulator`.

arkd and Fulmine consume the **Esplora-compatible REST API that mempool serves under `/api`**
(`http://mempool_web/api` inside the network) — an officially supported arkd explorer backend.

Configuration files for the chain and counterparty LND node live in `docker/conf/`.

## Configuration

All defaults live in `.env.defaults`. Overrides are discovered in this priority order:

1. `--env <path>` (explicit, highest priority)
2. `../.env.regtest` (parent repo override — typical submodule case)
3. `.env` (local override in arkade-regtest itself)

Variables in the override file replace their `.env.defaults` counterparts; unspecified variables keep their defaults. A variable already set in your shell environment wins over the files.

### Custom arkd version

arkd is always run from `ARKD_IMAGE` / `ARKD_WALLET_IMAGE` (there is no built-in fallback). Pin a version in your override file:

```bash
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.4
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.4
```

### Emulator (arkade-script signing service)

The [arkade-os/emulator](https://github.com/arkade-os/emulator) runs **by default** at `http://localhost:${EMULATOR_PORT}` (default `7073`). It is started last, after arkd is wallet-ready. Disable it for a faster boot by clearing the image in your override:

```bash
EMULATOR_IMAGE=
```

## Service URLs

| Service            | URL / endpoint                         | Default port |
| ------------------ | -------------------------------------- | ------------ |
| Bitcoin Core RPC   | `localhost:18443` (admin1 / 123)       | 18443        |
| Mempool explorer   | `http://localhost:3000`                | 3000         |
| Esplora REST API   | `http://localhost:3000/api`            | 3000         |
| Fulcrum (Electrum) | `localhost:50001`                      | 50001        |
| NBXplorer          | `http://localhost:32838`               | 32838        |
| Arkd               | `http://localhost:7070` (admin `7071`) | 7070         |
| Arkd Wallet        | `http://localhost:6060`                | 6060         |
| Fulmine API        | `http://localhost:7003`                | 7003         |
| Delegator API      | `http://localhost:7011`                | 7011         |
| Boltz CORS proxy   | `http://localhost:9069`                | 9069         |
| Boltz gRPC         | `localhost:9000`                       | 9000         |
| Boltz LND RPC      | `localhost:10010`                      | 10010        |
| Web wallet         | `http://localhost:3003`                | 3003         |
| Emulator           | `http://localhost:7073`                | 7073         |

## Using as a git submodule

```bash
git submodule add https://github.com/arkade-os/arkade-regtest.git regtest
```

Create `.env.regtest` in your repo root to override defaults, then:

```bash
node regtest/regtest.mjs start
```

The CLI auto-discovers `../.env.regtest` from the parent directory.

### CI integration

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true

- uses: actions/setup-node@v4
  with:
    node-version: '20'

- name: Start regtest environment
  run: node regtest/regtest.mjs start

- name: Run tests
  run: <your test command>

- name: Cleanup
  if: always()
  run: node regtest/regtest.mjs clean
```

No build cache step is needed — the stack is pulled Docker images only.

## Migrating from the nigiri-based version

- Entry points changed: `./start-env.sh` → `node regtest.mjs start` (same for `stop` / `clean`). Update local usage and CI.
- The `NIGIRI_*` variables and the `_build/` cache are gone.
- The explorer/indexer is now Fulcrum + mempool instead of electrs + chopsticks + esplora. The Esplora REST API moved from `http://localhost:3000` (chopsticks root) to `http://localhost:3000/api` (mempool).
- There is no auto-miner — mine explicitly (see the note above).
