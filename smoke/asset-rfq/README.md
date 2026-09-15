# Asset RFQ smoke

End-to-end `arkade:BTC ↔ arkade:<asset>` against intent-solver’s `ASSET_MARKETS` path.

| Command | What it hits |
|---|---|
| `npm run smoke` | HTTP `POST /v1/swap` (`solverd serve`, port 8787) |
| `npm run smoke:nostr` | Nostr kind 24859 via `createSwapClient().exchange()` (`solverd relay`, no 8787) |

Run from the **repo root** unless a block says otherwise.

## 1. Stack

Default arkd delays are block-denominated and expire mid-run. Pin seconds mode, then start ark + emulator (no auto-miner):

```bash
grep -vE '^(ARKD_VTXO_TREE_EXPIRY|ARKD_UNILATERAL_EXIT_DELAY|ARKD_PUBLIC_UNILATERAL_EXIT_DELAY|ARKD_BOARDING_EXIT_DELAY|ARKD_CHECKPOINT_EXIT_DELAY|ARKD_SESSION_DURATION|AUTOMINE_INTERVAL)=' .env.defaults > .env
cat smoke/asset-rfq/env.smoke-rfq >> .env

AUTOMINE_INTERVAL=0 node regtest.mjs start --profile emulator
docker stop bitcoin-miner
```

`FRESH_VOLUME=1` on the solver whenever this chain is new or was `clean`ed.

## 2. HTTP smoke

```bash
cd smoke/asset-rfq
npm install
npm run bootstrap
chmod +x start-solver.sh
FRESH_VOLUME=1 ./start-solver.sh
npm run configure-market
npm run smoke
npm run balances
```

`configure-market` must run after the first solver boot: `ASSET_MARKETS` will not start until an admin market already prices that asset.

## 3. Nostr smoke

Needs strfry and a ts-sdk checkout that can RFQ this route off the card (published `@arkade-os/swap` still feed-prices it).

```bash
# repo root
node regtest.mjs start --profile emulator,nostr   # or: docker start strfry

cd smoke/asset-rfq
SOLVER_MODE=relay ./start-solver.sh
TS_SDK=/path/to/ts-sdk ./link-sdk.sh
npm run smoke:nostr
```

Relay mode publishes **no** swap HTTP port. The harness builds a `ws://` card locally (`solver card` / `GET /api/card` reject that).

## Helpers

```bash
npm run refill     # top up trader1
npm run recover    # if a VTXO flipped recoverable
```

Keys: `data/keys.json` (gitignored).
