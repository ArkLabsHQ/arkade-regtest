# Asset RFQ smoke (intent-solver `ASSET_MARKETS`)

Exercises the **quoted RFQ path** for `arkade:BTC ↔ arkade:<asset>` — the client
asks first (`POST /v1/swap` with `maker_pk_script` / `maker_public_key`), funds
the address both sides derive from the quote (`createOffer` + `wallet.send`),
and the solver fills. This is **not** the offer-packet / stream-discovery path
(`OFFER_MARKETS`).

Requires a running [arkade-regtest](../..) stack with at least `ark` + `emulator`.

## Stack prerequisites

Default arkd delays are **block-denominated** (`ARKD_VTXO_TREE_EXPIRY=180`). The
SDK surfaces those as a short wall-clock `expiresAt`, and balances flip to
`recoverable` before a multi-step smoke can finish. Use the seconds-mode pin in
`.env.smoke-rfq` (checkpoint ≥ 1200s for intent-solver 0.3.1's SDK floor):

```bash
cd ../..
grep -vE '^(ARKD_VTXO_TREE_EXPIRY|ARKD_UNILATERAL_EXIT_DELAY|ARKD_PUBLIC_UNILATERAL_EXIT_DELAY|ARKD_BOARDING_EXIT_DELAY|ARKD_CHECKPOINT_EXIT_DELAY|ARKD_SESSION_DURATION|AUTOMINE_INTERVAL)=' .env.defaults > .env
cat smoke/asset-rfq/env.smoke-rfq >> .env

AUTOMINE_INTERVAL=0 node regtest.mjs start --profile emulator
docker stop bitcoin-miner   # do not burn through tree expiry; mine(1) after funding in scripts
```

On this VM, unpublished docker-bridge ports are filtered — re-run
`/tmp/fix-docker-bridge.sh` (or equivalent `DOCKER-USER` ACCEPT) after the
compose network is recreated.

## Steps

```bash
cd smoke/asset-rfq
npm install
npm run bootstrap          # persist keys, mint asset, fund solver + traders
chmod +x start-solver.sh
FRESH_VOLUME=1 ./start-solver.sh   # wipe solver DB when the chain was recreated
npm run configure-market   # admin PUT market, append ASSET_MARKETS, recreate
npm run smoke              # asset→BTC, BTC→asset, random back/forth + fee checks
npm run balances
```

`ASSET_MARKETS` is omitted on first boot (the process refuses to start when it
names an asset the admin console has not priced). `configure-market` PUTs the
market, writes `ASSET_MARKETS`, and recreates the container.

Keys live in `data/keys.json` (gitignored). Set `FRESH_VOLUME=1` when restarting
against a wiped chain so the solver wallet DB does not keep dead outpoints.

## Fee check

With a 1:1 feed (`price=100000000` at baseDecimals=8 / quoteDecimals=0) and
`feeBps`, exact-in payouts must match:

```
to = from - ceil(from * feeBps / 10000)
```

On `btc→asset`, `sellBaseFeeFlat` (dust carrier, 330 sats) is removed from the
BTC input before the bps cut.

Amounts are jittered so two runs do not derive the same `offer_pk_script` (the
solver DB uniques on it).

## Session notes (proven)

- Quote → fund → fill settled on regtest via HTTP RFQ (`servedBy: ["rfq"]`).
- intent-solver image: `ghcr.io/arkade-os/intent-solver:0.3.1`.
- Client packages: `@arkade-os/sdk@0.5.0-rc.8`, `@arkade-os/swap@0.1.0-rc.11`
  (`createOffer` from `@arkade-os/swap/protocol`).
- SDK 0.5 ignores bare `arkServerUrl` on `Wallet.create` — pass
  `RestArkProvider` + `RestIndexerProvider` + `EsploraProvider` explicitly.
