# Asset RFQ smoke (intent-solver `ASSET_MARKETS`)

Exercises the **quoted RFQ path** for `arkade:BTC ↔ arkade:<asset>` — the client
asks first, funds the address both sides derive from the quote, and the solver
fills. This is **not** the offer-packet / stream-discovery path
(`OFFER_MARKETS`).

Two harnesses, at two layers:

| | `npm run smoke` | `npm run smoke:nostr` |
|---|---|---|
| Transport | HTTP `POST /v1/swap` | Nostr, kind 24859 |
| Solver mode | `serve` (port 8787) | `relay` (no swap port at all) |
| Client surface | hand-built `rfq_request` + `createOffer` | `createSwapClient().exchange()` |
| Proves | the wire | the product path |

Run both. The HTTP one is the cheaper wire check and pins the fee arithmetic;
the Nostr one is the one that proves an application gets this route by calling
`exchange()`, with the transport resolved from the solver's card rather than
handed to the client.

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

## Nostr RFQ through the swap client

```bash
node ../../regtest.mjs start --profile emulator,nostr   # or: docker start strfry
SOLVER_MODE=relay ./start-solver.sh
TS_SDK=/path/to/ts-sdk ./link-sdk.sh     # unreleased @arkade-os/swap
npm run smoke:nostr                      # BTC→asset and asset→BTC
```

`SOLVER_MODE=relay` runs `solverd relay` against `ws://strfry:7777` and
**publishes no swap port** — port 8787 does not exist, so an HTTP fallback
cannot quietly carry the test. Health moves to the admin API on 8788.

The client is handed a card, not a transport. `discovery.snapshot` injects one
built by `lib/card.mjs` carrying `discovery_pubkey` and the local relay;
`transportFor` is left unset, so the client resolves the rendezvous off the card
and opens its own Nostr transport. The card is built here rather than read from
`solver card` / `GET /api/card` because both refuse a relay that is not
`wss://`, and a local strfry is `ws://`.

What it asserts, beyond settlement:

- `market.backend === "rfq"` before anything is disclosed. This is the
  regression that matters: the feed-priced path settles these same swaps and
  sends not one packet.
- kind-24859 traffic in both directions, counted on a **second, independent**
  relay subscription (`lib/relayWatch.mjs`) that shares no code with the
  transport under test. The kind is ephemeral, so the watcher has to be
  subscribed before the swap runs — which is also what makes the count evidence.
- `rfq_status` answered over Nostr, on a fresh transport key, which is the only
  way to read the solver's `fill_txid` in relay mode.
- The record is in the repository with its `fundingTxid` before the payout
  arrives — the ordering `accept()` exists to guarantee, read back rather than
  trusted.
- Both legs moved by **exactly** the quoted amounts. The 330-sat carrier makes
  that an equality rather than a bound: it rides an asset deposit out and comes
  back inside the fill.

If relay ingress is down the run **fails** rather than skipping — verified by
stopping strfry, which the solver reports as `relay: unreachable` and the
harness refuses on.

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
- Both directions settled over **Nostr** through `client.exchange()`:
  `10017 sats → 9638 USDT` (fee 379 USDT) and `1043 USDT → 1037 sats` (fee 6
  sats), each `outcome: "filled"` with the solver's `fill_txid`, one kind-24859
  request and reply per negotiation, and balances landing on the quoted amounts
  to the satoshi.
- intent-solver image: `ghcr.io/arkade-os/intent-solver:0.3.1`.
- Client packages: `@arkade-os/sdk@0.5.0-rc.8`, `@arkade-os/swap@0.1.0-rc.11`
  (`createOffer` from `@arkade-os/swap/protocol`). The Nostr harness needs the
  `feat/v0.5` build instead — see `link-sdk.sh`.
- SDK 0.5 ignores bare `arkServerUrl` on `Wallet.create` — pass
  `RestArkProvider` + `RestIndexerProvider` + `EsploraProvider` explicitly.
- `quote.fee` on this market is the **whole** concession against the card's
  price: 50 bps plus, on a BTC input, the 330-sat carrier the registry schema
  has no honest field for. A bps-only ceiling refuses every BTC→asset swap here.
