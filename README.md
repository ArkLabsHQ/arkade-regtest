# arkade-regtest

A self-contained, cross-platform regtest environment for Ark protocol development. It orchestrates Bitcoin Core, Fulcrum, mempool, NBXplorer, arkd, Fulmine, Boltz, an LND node, an end-to-end-encrypted bucket sync server, and a strfry Nostr relay into a single reproducible Docker Compose stack — driven by a small zero-dependency Node CLI.

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

The lifecycle commands have npm aliases too, so from inside this repo you can use either form:

```bash
npm start        # = node regtest.mjs start
npm stop         # = node regtest.mjs stop
npm run clean    # = node regtest.mjs clean
```

Use **`node regtest.mjs`** for the argument-taking commands below (npm would need the awkward `npm run … -- <args>` form), and whenever this repo is embedded as a submodule (`node regtest/regtest.mjs start`).

### Other commands

```bash
node regtest.mjs faucet <address> <amountBtc> [--confirm]   # send from the node wallet; --confirm mines 1
node regtest.mjs mine [n]                        # mine n blocks (default 1)
node regtest.mjs reorg [depth]                   # simulate a reorg of `depth` blocks (default 1)
node regtest.mjs rpc <args...>                   # bitcoin-cli passthrough (replaces `nigiri rpc`)
node regtest.mjs create-invoice [--secondary]    # 100k-sat invoice (boltz-lnd, or lnd)
node regtest.mjs pay-invoice <invoice>           # pay from the non-destination node
node regtest.mjs ark <args...>                   # ark client CLI, run inside the arkd container
node regtest.mjs arkd <args...>                  # arkd server CLI, run inside the arkd container
node regtest.mjs rotate-signer [--cutoff <secs>] # rotate the operator signer; deprecate the previous key
node regtest.mjs signer-info                     # print the active + deprecated signer set
```

`start` initializes the `ark` client (pointed at the local arkd + mempool explorer) and seeds it with offchain funds, so commands like `node regtest.mjs ark balance` / `ark receive` / `ark send …` work out of the box. The `arkd` passthrough exposes the server CLI (e.g. `node regtest.mjs arkd note --amount 100000000`).

> **Block production.** A built-in auto-miner mines one block every `AUTOMINE_INTERVAL` seconds (default **600 / 10 min**); set `AUTOMINE_INTERVAL=0` to disable it and mine only explicitly. `faucet` spends from the node wallet's balance and does **not** confirm by default — pass `--confirm` to mine a block immediately, or rely on the auto-miner / an explicit `node regtest.mjs mine`. The `start` flow mines explicitly where it needs confirmed funds, so a fresh start is deterministic regardless of the auto-miner. arkd's default locktimes are themselves block-denominated (see [Fast VTXO expiry & sweeps](#fast-vtxo-expiry--sweeps-block-denominated-locktimes)), so the auto-miner will eventually drive a default stack toward expiry/sweeps too — disable it (`AUTOMINE_INTERVAL=0`) for deterministic tests, so background mining can't advance the chain tip and fire sweeps mid-test.

## Architecture

Two compose files are merged into one project (`arkade-regtest`):

- **`docker/compose.base.yml`** — chain + indexers + explorer + counterparty LN:
  `bitcoin` (Bitcoin Core regtest), `postgres`, `nbxplorer`, `fulcrum` (Electrum server),
  `mempool_api` + `mempool_web` + `mempool_mariadb` (block explorer & Esplora REST API), and `lnd`.
- **`docker/compose.ark.yml`** — the Ark stack: `arkd` + `arkd-wallet`, `boltz`, `boltz-lnd`,
  `boltz-fulmine`, `fulmine-delegator`, `nginx-boltz`, `lnurl-server`, `arkade-wallet`, and the
  profile-gated `emulator` and `intent-solver` — plus `bucket-sync` (and its one-shot
  `bucket-sync-initdb`) and `strfry`, which ride on the same base but have no Ark dependency of
  their own.

arkd and Fulmine consume the **Esplora-compatible REST API that mempool serves under `/api`**
(`http://mempool_web/api` inside the network) — an officially supported arkd explorer backend.

Bitcoin Core and the counterparty LND node use the BTCPay images, so their configuration is embedded directly via `BITCOIN_EXTRA_ARGS` / `LND_EXTRA_ARGS` in `compose.base.yml` — there are no bind-mounted conf files.

## Profiles

Services are grouped into compose profiles so you can bring up just the tier you need. The CLI resolves the dependency closure automatically:

| Profile         | Services                                                          | Depends on                 |
| --------------- | ----------------------------------------------------------------- | -------------------------- |
| `base`          | bitcoin, postgres, nbxplorer, fulcrum, mempool (api/web/db), lnd  | —                          |
| `ark`           | arkd, arkd-wallet, arkade-wallet, arkade-explorer                 | `base`                     |
| `delegate`      | fulmine-delegator                                                 | `ark`                      |
| `boltz`         | boltz, boltz-fulmine, boltz-lnd, nginx-boltz, lnurl-server        | `ark`                      |
| `emulator`      | emulator                                                          | `ark`                      |
| `solver`        | solver, pricefeed                                                 | `ark`, `emulator`          |
| `intent-solver` | intent-solver                                                     | `ark`, `emulator`, `boltz` |
| `sync`          | bucket-sync, bucket-sync-initdb                                   | `base`                     |
| `nostr`         | strfry                                                            | `base`                     |

```bash
node regtest.mjs start                      # full stack (all profiles)
node regtest.mjs start --profile base       # just the chain + explorer/indexer
node regtest.mjs start --profile ark        # base + ark (incl. web wallet + explorer)
node regtest.mjs start --profile boltz      # base + ark + boltz (incl. boltz-fulmine)
node regtest.mjs start --profile solver     # base + ark + emulator + solver
node regtest.mjs start --profile intent-solver   # base + ark + emulator + boltz + the swap solver
node regtest.mjs start --profile sync       # base + bucket sync server (no arkd)
node regtest.mjs start --profile nostr      # base + strfry Nostr relay (no arkd)
node regtest.mjs start --profile emulator --profile boltz   # combine targets
```

You can also pin profiles via the `REGTEST_PROFILES` env var (comma-separated, e.g. in `.env.regtest`) instead of passing `--profile`. Precedence: `--profile` flags > `REGTEST_PROFILES` > full stack.

Starting the `solver` profile also bootstraps it: once solverd is up, a one-shot container funds it with BTC and a freshly minted regtest asset, then registers a bidirectional `BTC/<asset>` market against the mock `pricefeed`. Amounts are tunable via `SOLVER_INIT_BTC`, `SOLVER_INIT_ASSET_SUPPLY`, and `SOLVER_INIT_ASSET_FUNDING`.

`stop` and `clean` always act on the whole project regardless of profiles.

## Configuration

All defaults live in `.env.defaults`. Overrides are discovered in this priority order:

1. `--env <path>` (explicit, highest priority)
2. `../.env.regtest` (parent repo override — typical submodule case)
3. `.env` (local override in arkade-regtest itself)

Variables in the override file replace their `.env.defaults` counterparts; unspecified variables keep their defaults. A variable already set in your shell environment wins over the files.

### Host ports

Every host-exposed port is configurable via `${VAR:-default}` so you can avoid local collisions or run multiple stacks side by side — only the host side is remapped; container-internal ports stay fixed. Base layer: `BITCOIN_RPC_PORT` (18443), `BITCOIN_P2P_PORT` (18444), `BITCOIN_ZMQ_BLOCK_PORT` (28332), `BITCOIN_ZMQ_TX_PORT` (28333), `NBXPLORER_PORT` (32838), `POSTGRES_PORT` (39372), `FULCRUM_TCP_PORT` (50001), `FULCRUM_WS_PORT` (50003), `LND_P2P_PORT` (9735), `LND_RPC_PORT` (10009), `MEMPOOL_WEB_PORT` (3000). Ark layer: `ARKD_PORT` (7070), `ARKD_ADMIN_PORT` (7071), `ARKD_WALLET_PORT` (6060), plus the existing Fulmine/Boltz/solver port vars. The CLI reads `ARKD_PORT`/`ARKD_ADMIN_PORT` itself, so overriding them keeps `start`'s arkd setup pointed at the right host ports.

### Custom arkd version

arkd is always run from `ARKD_IMAGE` / `ARKD_WALLET_IMAGE` (there is no built-in fallback). The defaults are `v0.9.14` — the [signer rotation](#operator-signer-rotation) feature needs deprecated-signer support, which landed in arkd `v0.9.10`+ (after `v0.9.6`). Pin a different version in your override file:

```bash
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.14
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.14
```

### Operator signer rotation

Simulate an arkd operator rotating its VTXO **signer key**: generate a new active key and advertise the previous one as a *deprecated signer* with an optional cutoff date. This drives the client-side migration / recovery flows — clients must re-sign or recover VTXOs locked to a retired signer before its cutoff.

```bash
node regtest.mjs rotate-signer                 # new active key; deprecate the current one (no cutoff → DUE_NOW)
node regtest.mjs rotate-signer --cutoff +86400 # …deprecate with a cutoff 1 day in the future (MIGRATABLE)
node regtest.mjs rotate-signer --cutoff -3600  # …deprecate with a cutoff 1 hour in the past (EXPIRED)
node regtest.mjs rotate-signer --new-key <hex> # rotate to a specific 32-byte hex private key
node regtest.mjs set-signers --active <priv> --deprecated <priv>:<cutoff>,<priv>  # apply an EXPLICIT set
node regtest.mjs signer-info                   # print the active + deprecated signer set
```

`--cutoff` is a Unix-seconds timestamp, or a signed `+N` / `-N` offset in seconds from now. arkd classifies each deprecated signer by its cutoff: **no cutoff → DUE_NOW**, **future → MIGRATABLE**, **past → EXPIRED**.

`set-signers` applies a **precise** set rather than generating keys: `--active <priv>` plus a comma-separated `--deprecated <priv>[:<cutoff>],…` (each cutoff a Unix-seconds timestamp or `+N`/`-N` offset). It's the primitive the ts-sdk e2e drives rotation through; `rotate-signer` is the convenience wrapper that generates + tracks keys for you.

How it works: arkd reads its signer set from arkd-wallet's `ARKD_WALLET_SIGNER_KEY` (active) and `ARKD_WALLET_DEPRECATED_SIGNER_KEYS` (`<hexpriv>[:<cutoff>],…`) env, so a rotation recreates arkd-wallet with the new env (reusing its on-chain volume), unlocks it, and restarts arkd so it re-fetches the rotated set. The wallet boots from a **known default signer key** (`ARKD_WALLET_SIGNER_KEY` in `.env.defaults`) rather than self-generating one, and the CLI seeds `.signer-state.json` with it — so even the **first** rotation can advertise the boot signer as deprecated (arkd needs the deprecated **private** key to co-sign migration of pre-rotation funds). `clean` resets the signer set along with the wallet volume. Requires the rc images (see [Custom arkd version](#custom-arkd-version)).

### Fast VTXO expiry & sweeps (block-denominated locktimes)

arkd interprets `ARKD_VTXO_TREE_EXPIRY` and the exit delays (`ARKD_*_EXIT_DELAY`) **by magnitude** — the BIP68 boundary is **512** — and auto-selects its scheduler from the result:

| Value      | Interpreted as              | Scheduler           | Expiry / sweeps fire when…                                            |
| ---------- | --------------------------- | ------------------- | -------------------------------------------------------------------- |
| **≥ 512**  | seconds                     | time (wall-clock)   | the real-time deadline passes                                        |
| **< 512**  | **blocks** *(regtest only)* | block (polls the tip)| the chain **tip height** reaches the target — i.e. when you **mine** |

The block path is the "fast regtest" trick: set small values and trigger VTXO-tree expiry / sweeps **instantly by mining** instead of waiting real time (arkd's mainnet default is 7 days). arkd **rejects** block-denominated locktimes on any non-regtest network.

**arkade-regtest's own defaults are already block-denominated** — `ARKD_VTXO_TREE_EXPIRY=180`, `ARKD_UNILATERAL_EXIT_DELAY=5`, `ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=5`, `ARKD_BOARDING_EXIT_DELAY=180`, `ARKD_CHECKPOINT_EXIT_DELAY=5` (all < 512, see `docker/compose.ark.yml`) — so a default stack already runs the **block** scheduler, and the auto-miner (on by default, one block per `AUTOMINE_INTERVAL` seconds) will eventually drive it toward expiry/sweeps on its own. Override all five vars to seconds values (≥ 512) if you want the old wall-clock behaviour instead.

For even faster iteration than the defaults, shrink the values further — these are arkd's own e2e values:

```bash
ARKD_VTXO_TREE_EXPIRY=40
ARKD_UNILATERAL_EXIT_DELAY=20
ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=20
ARKD_BOARDING_EXIT_DELAY=30
ARKD_CHECKPOINT_EXIT_DELAY=10
AUTOMINE_INTERVAL=0   # required — see below
```

Two rules when using block values:

- **Disable the auto-miner** (`AUTOMINE_INTERVAL=0`) for deterministic tests. Otherwise the background miner advances the chain tip on its own and fires sweeps/expiry mid-test, making block-height-sensitive tests non-deterministic — mine explicitly with `node regtest.mjs mine <n>` instead.
- **All values must share the same type** (all blocks *or* all seconds). arkd validates this and refuses to start on a mismatch.

### Emulator (arkade-script signing service)

The [arkade-os/emulator](https://github.com/arkade-os/emulator) runs **by default** at `http://localhost:${EMULATOR_PORT}` (default `7073`). It is started last, after arkd is wallet-ready. Disable it for a faster boot by clearing the image in your override:

```bash
EMULATOR_IMAGE=
```

### Intent solver (Lightning <-> Arkade swaps)

[arkade-os/intent-solver](https://github.com/arkade-os/intent-solver) is the reference swap solver: it quotes and settles Lightning <-> Arkade swaps against a real LND node. It is **not** the `solver` service — that one is solverd, the virtual-mempool intent solver. Two different daemons under two different profiles.

It runs in the `intent-solver` profile at `http://localhost:${INTENT_SOLVER_PORT}` (default `8787`), started last so its dependencies are ready. That profile resolves to `ark`, `emulator` **and `boltz`** — boltz is not optional here: its setup is the only thing in this repo that funds the base `lnd` node and opens a channel to it, so without it every Lightning corridor would be dead on arrival. The solver reuses that node rather than adding a second funding path (`lnd:10009`, with the cert and admin macaroon read straight off the `lnd_datadir` volume).

The profile is **off by default**, because the image is not published yet. Name a build in your override file to turn it on:

```bash
INTENT_SOLVER_IMAGE=ghcr.io/arkade-os/intent-solver:v0.1.0
```

Until then `start` logs `intent-solver disabled (INTENT_SOLVER_IMAGE empty; set it to enable the profile)` and skips it — including in the full-stack default — the same "clear the image to disable it" idiom as `EMULATOR_IMAGE`, in reverse.

It runs the image's `serve` command (an HTTP host) rather than its default `relay` (outbound-only, no port), bound to `0.0.0.0` so the published port is reachable. Liveness is `/healthz`:

```bash
curl -s http://localhost:8787/healthz    # {"ok":true,"network":"regtest"}
```

Its Arkade wallet is derived from `INTENT_SOLVER_MNEMONIC`, fixed in `.env.defaults` so the solver's address is stable across restarts. That phrase is public — regtest only. Its databases live in the `intent_solver_datadir` volume, so swaps survive `stop`/`start` and `clean` drops them with everything else.

> **The container runs as root, on purpose.** lnd's admin macaroon is `0640 root:root` behind `0700` directories, and the image's own user (`node`) cannot read it. The volume is mounted read-only. This is a regtest convenience — don't copy it to a deployment.

> **Known gap: the Arkade side has no explorer knob.** `LND_ESPLORA_URL` points the Lightning side at mempool, but the Arkade side falls back to the SDK's regtest default `http://localhost:3000/api` — which, inside the container, is the container. The solver logs `Failed to fetch chain tip; height-based expiry will not be evaluated` and keeps serving, so this stack's block-denominated VTXO expiry goes unwatched. It needs an env knob in the solver itself; nothing in this repo can supply one.

### Bucket sync server (encrypted backup / restore / sync)

The [bucket-sync-server](https://github.com/Kukks/bucket-sync-server) runs in the `sync` profile at `http://localhost:${BUCKET_SYNC_PORT}` (default `7100`). It's a schema-agnostic, end-to-end-encrypted key/value **bucket** store: clients encrypt before they upload, so the server only ever holds opaque ciphertext. That means it has no Ark dependency — `sync` resolves to `base` alone, and `--profile sync` gives you the chain plus a sync server without booting arkd.

Point a client at it with the URL its SDKs expect:

```bash
BUCKET_SYNC_URL=http://localhost:7100
```

It gets its own database (`BUCKET_SYNC_DB`, default `bucketsync`) on the shared `postgres`, created on `start` by the one-shot `bucket-sync-initdb` container; the server applies its own migrations at boot. Buckets therefore survive `stop`/`start`, and `clean` discards them with the rest of the volumes. Pin a different build in your override file:

```bash
BUCKET_SYNC_IMAGE=ghcr.io/kukks/bucket-sync-server:latest
```

`:latest` is a mutable tag, so Docker will keep using an older copy you already have cached rather than re-pulling (true of the other `:latest` images here too). Refresh it explicitly when you need the current server, or pin a `sha-<commit>` tag in your override file:

```bash
docker compose -f docker/compose.base.yml -f docker/compose.ark.yml pull bucket-sync
```

Browser clients can call it directly. The stack passes `BUCKET_SYNC_CORS` through as the server's `Cors__AllowedOrigins`, defaulting to `*` since this is a local dev environment — so a page on `http://localhost:3003` (or a Vite dev server on any port) can reach it without a proxy. Narrow it to a comma-separated origin list, or clear it to send no CORS headers at all:

```bash
BUCKET_SYNC_CORS=http://localhost:5173   # only this origin
BUCKET_SYNC_CORS=                        # no CORS headers
```

Credentials are never enabled server-side — clients authenticate with an explicit `Authorization` header rather than cookies — so a wildcard origin stays legal, and preflight accepts `Authorization` and SSE's `Last-Event-ID`. A `BUCKET_SYNC_IMAGE` pinned to a build older than this setting simply ignores it and sends no CORS headers.

### strfry (Nostr relay)

[strfry](https://github.com/hoytech/strfry) runs in the `nostr` profile at `ws://localhost:${STRFRY_PORT}` (default `7777`). It's a plain relay: it stores and forwards signed Nostr events and knows nothing about Ark, so `nostr` resolves to `base` alone and `--profile nostr` gives you the chain plus a relay without booting arkd. It's here for services that reach each other over a relay instead of an inbound port — a provider that publishes nothing but connects out, and clients that address it by pubkey.

Point a client at it:

```bash
RELAY_URL=ws://localhost:7777
```

The same port answers plain HTTP, which is where the NIP-11 relay document lives — handy as a liveness check without a websocket client:

```bash
curl -s -H 'Accept: application/nostr+json' http://localhost:7777/ | jq
```

Three settings differ from the image's defaults, all in [`docker/strfry.conf`](docker/strfry.conf): it binds `0.0.0.0` (the default is loopback, unreachable from other containers or the published port); NIP-42 auth is **off**, so any client can read and write without an AUTH challenge — a dev-relay stance, don't copy this config to anything public; and `relay.nofiles` is `0`, meaning leave the OS file-descriptor limit alone. Upstream's `524288` is fatal, not a warning, wherever the container's `RLIMIT_NOFILE` hard limit is lower — GitHub runners cap it at 65536 — and strfry exits 1 on boot. strfry takes its whole configuration from that one file, not env vars, so the file is a copy of the image's default with those deltas marked at the top; diff it against a newer image's `/app/strfry.conf` when you bump the image.

Events live in an LMDB database in the `strfry_db` volume, so they survive `stop`/`start` and `clean` drops them with everything else. Upstream publishes only a mutable `latest` tag, so Docker keeps using whatever copy you already cached — refresh or pin it explicitly:

```bash
docker compose -f docker/compose.base.yml -f docker/compose.ark.yml pull strfry
STRFRY_IMAGE=ghcr.io/hoytech/strfry@sha256:<digest>   # in your override file
```

> **Relay clients must speak Nostr.** The relay only accepts NIP-01 frames (`["EVENT", …]`, `["REQ", …]`, `["CLOSE", …]`) carrying schnorr-signed events. A client using its own JSON framing over the same websocket will connect and then have every frame silently dropped. `lightning-swap-service` ships both dialects behind one codec seam and defaults to Nostr, so point it here with `RELAY_PROTOCOL=nostr RELAY_URL=ws://localhost:7777`; its `dev` framing is for its own mock relay, not for this one.

## Service URLs

| Service            | URL / endpoint                         | Default port |
| ------------------ | -------------------------------------- | ------------ |
| Bitcoin Core RPC   | `localhost:18443` (admin1 / 123)       | 18443        |
| Mempool explorer   | `http://localhost:3000`                | 3000         |
| Esplora REST API   | `http://localhost:3000/api`            | 3000         |
| Fulcrum (Electrum) | `localhost:50001` (TCP), `localhost:50003` (WS) | 50001 / 50003 |
| NBXplorer          | `http://localhost:32838`               | 32838        |
| Postgres           | `localhost:39372` (trust; DBs: arkd, nbxplorer, bucketsync) | 39372 |
| Arkd               | `http://localhost:7070` (admin `7071`) | 7070         |
| Arkd Wallet        | `http://localhost:6060`                | 6060         |
| Fulmine API        | `http://localhost:7003`                | 7003         |
| Delegator API      | `http://localhost:7011`                | 7011         |
| Boltz CORS proxy   | `http://localhost:9069`                | 9069         |
| Boltz gRPC         | `localhost:9000`                       | 9000         |
| Boltz LND RPC      | `localhost:10010`                      | 10010        |
| Web wallet         | `http://localhost:3003`                | 3003         |
| Arkade explorer    | `http://localhost:7080`                | 7080         |
| Emulator           | `http://localhost:7073`                | 7073         |
| Solver HTTP        | `http://localhost:7091`                | 7091         |
| Solver gRPC        | `localhost:7090`                       | 7090         |
| Pricefeed          | `http://localhost:8088`                | 8088         |
| Intent solver      | `http://localhost:8787` (`/healthz`)   | 8787         |
| Bucket sync server | `http://localhost:7100`                | 7100         |
| strfry (Nostr)     | `ws://localhost:7777` (NIP-11 over `http://`) | 7777  |

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
