#!/usr/bin/env node
/**
 * BTC <-> asset RFQ over Nostr through `client.exchange()`.
 *
 * Solver is `relay` mode (no :8787). `transportFor` unset — the client opens
 * the card's rendezvous. A second relay subscription counts kind 24859.
 * Needs the local swap build: `./link-sdk.sh`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSwapClient,
  InMemoryAssetSwapRepository,
  quoteIdOfSwapId,
} from '@arkade-os/swap';
import { nostrRfqTransport } from '@arkade-os/swap/nostr';
import {
  ADMIN_URL,
  ASSET_CARRIER_SATS,
  FEE_BPS,
  NOSTR_RELAY_URL,
} from './lib/config.mjs';
import { buildSolverCard, publicLegIds, solverPubkeyFromEnv } from './lib/card.mjs';
import { loadOrCreateKeys } from './lib/keys.mjs';
import { DATA, STATE_PATH } from './lib/paths.mjs';
import { mine } from './lib/regtest.mjs';
import { settleRelay, watchRfqTraffic } from './lib/relayWatch.mjs';
import { assetBalance, availableSats, openWallet } from './lib/wallet.mjs';

const OUT = join(DATA, 'swaps-nostr');
mkdirSync(OUT, { recursive: true });

const fail = (message) => {
  throw new Error(message);
};
const assertEq = (actual, expected, label) =>
  actual === expected || fail(`${label}: expected ${expected}, got ${actual}`);

/** Fail if the solver is not quoting this asset over a live relay. */
async function assertRelayIngress(assetId) {
  const backends = await fetch(`${ADMIN_URL}/api/backends`)
    .then((r) => r.json())
    .catch((err) =>
      fail(`solver admin API unreachable at ${ADMIN_URL} — start it with SOLVER_MODE=relay: ${err.message}`),
    );
  const relay = backends.backends?.find((b) => b.name === 'relay');
  if (!relay) fail('solver reports no `relay` backend — it is running in serve mode, not relay mode');
  if (!relay.ok) fail(`solver's relay ingress is ${relay.detail}: ${relay.error ?? 'no detail'}`);
  console.log(`relay ingress ${relay.detail} ${relay.target}`);

  const { markets } = await fetch(`${ADMIN_URL}/api/markets`).then((r) => r.json());
  const market = markets?.find((m) => m.quote === assetId || m.base === assetId);
  if (!market) fail(`solver serves no market for asset ${assetId}`);
  if (!market.enabled) fail(`market ${market.marketKey} is disabled`);
  if (!market.servedBy?.includes('rfq')) {
    fail(`market ${market.marketKey} is servedBy ${JSON.stringify(market.servedBy)}, not rfq`);
  }
  console.log(`market ${market.marketKey} servedBy ${market.servedBy.join(',')} feeBps=${market.feeBps}`);
  return market;
}

/** Take-leg ceiling: published bps plus this market's flat fee for the direction. */
const feeCeiling = (amount, direction, market) => {
  const bps = (amount * BigInt(market.feeBps) + 9_999n) / 10_000n;
  const flat = BigInt(
    (direction === 'btc->asset' ? market.sellBaseFeeFlat : market.buyBaseFeeFlat) ?? 0,
  );
  return bps + flat;
};

/** What the wallet holds on both legs, for the before/after assertion. */
async function snapshot(wallet, assetId) {
  const balance = await wallet.getBalance();
  return { sats: availableSats(balance), asset: assetBalance(balance, assetId) };
}

/** Poll `rfq_status` over Nostr until settled. Relays the fill_txid HTTP cannot. */
async function waitFilled(transport, rfqId, { timeoutMs = 240_000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await transport.status(rfqId).catch(() => null);
    if (last?.state === 'settled') return last;
    if (last?.state === 'failed' || last?.state === 'refused') {
      fail(`rfq ${rfqId} ended ${last.state}: ${JSON.stringify(last)}`);
    }
    if (Date.now() > deadline) {
      fail(`rfq ${rfqId} never settled over Nostr; last status ${JSON.stringify(last)}`);
    }
    // The fill spends the deposit VTXO, which needs a block under manual mining.
    mine(1);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function runSwap({ client, session, watcher, statusTransport, solverPubkey, legs, market, assetId, direction, amount, label }) {
  const give = direction === 'btc->asset' ? legs.btc : legs.asset;
  const take = direction === 'btc->asset' ? legs.asset : legs.btc;
  const before = await snapshot(session.wallet, assetId);
  console.log(`\n=== ${label} (${direction}, give ${amount}) ===`);

  const ceiling = feeCeiling(amount, direction, market);
  const mark = watcher.mark();
  const swap = await client.exchange({
    give,
    take,
    amount,
    amountOn: 'give',
    maxFee: { amount: ceiling, asset: take },
  });

  assertEq(swap.family, 'offer', 'swap.family');
  assertEq(swap.give.asset, give, 'swap.give.asset');
  assertEq(swap.take.asset, take, 'swap.take.asset');
  assertEq(swap.give.amount, amount, 'swap.give.amount');
  assertEq(swap.market.backend, 'rfq', 'swap.market.backend');
  // The quote's own `solver_pubkey`, and this deployment derives its Nostr key
  // from the same seed — so this is also the responder check having passed
  // against the card's `discovery_pubkey` rather than against nothing.
  assertEq(swap.solver, solverPubkey, 'swap.solver');
  assertEq(swap.fee.asset, take, 'fee is denominated on the take leg');
  if (!swap.fundingTxid) fail('accept() returned no fundingTxid — nothing was funded');
  // Positivity on both legs, never `take > give`: the legs carry different
  // assets, so 10_017 sats for 9_638 asset units and its reverse are both
  // correct quotes and a numeric comparison refuses one of the two.
  if (swap.take.amount <= 0n) fail(`non-positive take amount ${swap.take.amount}`);
  if (swap.fee.amount <= 0n || swap.fee.amount > ceiling) {
    fail(`fee ${swap.fee.amount} outside (0, ${ceiling}]`);
  }
  console.log('accepted', {
    id: swap.id,
    outcome: swap.outcome,
    give: `${swap.give.amount} ${swap.give.asset}`,
    take: `${swap.take.amount} ${swap.take.asset}`,
    fee: `${swap.fee.amount} ${swap.fee.asset}`,
    fundingTxid: swap.fundingTxid,
  });

  // The record is durable before the funding moved — the ordering `accept()`
  // exists to guarantee, read back off the repository rather than trusted.
  const persisted = (await client.swaps()).find((s) => s.id === swap.id);
  if (!persisted) fail(`accept() returned ${swap.id} and the repository has no record of it`);
  assertEq(persisted.fundingTxid, swap.fundingTxid, 'persisted fundingTxid');

  await settleRelay();
  const traffic = watcher.since(mark, solverPubkey);
  if (traffic.toSolver.length === 0) {
    fail(
      `no kind-${watcher.kind} event addressed to the solver — the quote did not go over the relay`,
    );
  }
  if (traffic.fromSolver.length === 0) {
    fail(`no kind-${watcher.kind} event authored by the solver — nothing answered over the relay`);
  }
  console.log(
    `nostr kind-${watcher.kind}: ${traffic.toSolver.length} to solver, ${traffic.fromSolver.length} from solver`,
  );

  // The covenant is funded; the fill is the solver's move and needs a block.
  mine(1);
  const rfqId = client.preparationOf(quoteIdOfSwapId(swap.id))?.rfqId;
  if (!rfqId) fail(`no preparation retained for ${swap.id} — cannot read the solver's status`);
  const statusMark = watcher.mark();
  const status = await waitFilled(statusTransport, rfqId);
  const fillTxid = status.profile?.fill_txid ?? status.fill_txid;
  if (!fillTxid) fail(`solver settled rfq ${rfqId} without a fill_txid: ${JSON.stringify(status)}`);
  console.log('settled', { rfqId, state: status.state, fillTxid });

  await settleRelay();
  const statusTraffic = watcher.since(statusMark, solverPubkey);
  if (statusTraffic.fromSolver.length === 0) {
    fail(`the solver answered no rfq_status over kind-${watcher.kind}`);
  }
  console.log(`nostr status: ${statusTraffic.toSolver.length} asked, ${statusTraffic.fromSolver.length} answered`);

  const after = await waitForPayout(session.wallet, assetId, before, direction, swap);
  const record = {
    label,
    direction,
    swapId: swap.id,
    rfqId,
    solver: swap.solver,
    market: swap.market,
    give: { asset: swap.give.asset, amount: swap.give.amount.toString() },
    take: { asset: swap.take.asset, amount: swap.take.amount.toString() },
    fee: { asset: swap.fee.asset, amount: swap.fee.amount.toString() },
    fundingTxid: swap.fundingTxid,
    fillTxid,
    status,
    outcome: (await client.swaps()).find((s) => s.id === swap.id)?.outcome ?? swap.outcome,
    nostr: {
      relay: watcher.url,
      kind: watcher.kind,
      toSolver: traffic.toSolver.length,
      fromSolver: traffic.fromSolver.length,
    },
    before: { sats: before.sats.toString(), asset: before.asset.toString() },
    after: { sats: after.sats.toString(), asset: after.asset.toString() },
  };
  writeFileSync(
    join(OUT, `${Date.now()}-${label.replace(/\s+/g, '_')}.json`),
    JSON.stringify(record, null, 2),
  );
  return record;
}

/** Both legs equal the quote, carrier included. */
async function waitForPayout(wallet, assetId, before, direction, swap, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const wantsAsset = direction === 'btc->asset';
  const expected = wantsAsset
    ? {
        asset: before.asset + swap.take.amount,
        sats: before.sats - swap.give.amount + ASSET_CARRIER_SATS,
      }
    : {
        asset: before.asset - swap.give.amount,
        sats: before.sats + swap.take.amount - ASSET_CARRIER_SATS,
      };
  for (;;) {
    const now = await snapshot(wallet, assetId);
    if (now.sats === expected.sats && now.asset === expected.asset) {
      console.log(
        `payout sats ${before.sats} -> ${now.sats}, asset ${before.asset} -> ${now.asset}` +
          ` (carrier ${ASSET_CARRIER_SATS} ${wantsAsset ? 'returned with the fill' : 'rode the deposit out'})`,
      );
      return now;
    }
    if (Date.now() > deadline) {
      fail(
        `balances never reached the quoted amounts: sats ${now.sats} (want ${expected.sats}),` +
          ` asset ${now.asset} (want ${expected.asset})`,
      );
    }
    mine(1);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function main() {
  if (!existsSync(STATE_PATH)) fail('run bootstrap + start-solver + configure-market first');
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  const assetId = state.assetId;
  const market = await assertRelayIngress(assetId);

  const solverPubkey = await solverPubkeyFromEnv();
  const legs = publicLegIds(assetId, state.network ?? 'regtest');
  const card = buildSolverCard({
    assetId,
    ticker: state.ticker,
    decimals: state.decimals,
    discoveryPubkey: solverPubkey,
    network: state.network ?? 'regtest',
    feeBps: state.feeBps ?? FEE_BPS,
    min: market.sellBase?.min ?? '1',
    max: market.sellBase?.max ?? '100000000',
  });
  console.log(`card: ${card.solver} → ${solverPubkey.slice(0, 16)}… over ${NOSTR_RELAY_URL}`);

  const watcher = await watchRfqTraffic();
  const statusTransport = nostrRfqTransport({ relays: [NOSTR_RELAY_URL], solverPubkey });
  const keys = loadOrCreateKeys();
  const trader = await openWallet(keys.trader1.mnemonic, 'trader1');

  const client = await createSwapClient({
    wallet: trader.wallet,
    repository: new InMemoryAssetSwapRepository(),
    // `registryUrl: null` is the point: no registry is reachable from here, and
    // an injected snapshot is the trusted-config path a self-hosted deployment
    // uses. It is also what lets the card name a `ws://` relay, which a
    // registry-served card may not.
    discovery: { registryUrl: null, snapshot: [card], network: state.network ?? 'regtest' },
    // `transportFor` deliberately unset — the client opens the card's own
    // rendezvous. Passing one here would make this a test of the harness.
  });
  await client.ready;

  const offered = await client.markets();
  const priced = offered.find((m) => m.backend === 'rfq');
  if (!priced) {
    fail(
      `no market routes through RFQ: ${JSON.stringify(offered.map((m) => ({ key: m.key, backend: m.backend })))}`,
    );
  }
  console.log(`client routes ${priced.key} through ${priced.backend}`);

  const records = [];
  try {
    const opening = await snapshot(trader.wallet, assetId);
    console.log(`trader1 holds ${opening.sats} sats, ${opening.asset} ${state.ticker}`);

    // Jitter: the solver uniques fills on offer_pk_script, a fixed amount collides.
    const jitter = (base, spread) => base + BigInt(1 + Math.floor(Math.random() * spread));

    if (opening.sats < 20_000n) fail(`trader1 has ${opening.sats} sats, needs 20k for the BTC leg`);
    records.push(
      await runSwap({
        client,
        session: trader,
        watcher,
        statusTransport,
        solverPubkey,
        legs,
        market,
        assetId,
        direction: 'btc->asset',
        amount: jitter(10_000n, 997),
        label: 'nostr-btc-to-asset',
      }),
    );

    const mid = await snapshot(trader.wallet, assetId);
    if (mid.asset < 1_000n) fail(`trader1 has ${mid.asset} asset units, needs 1000 for the return leg`);
    if (mid.sats < ASSET_CARRIER_SATS) {
      fail(`trader1 needs ${ASSET_CARRIER_SATS} sats as the asset deposit's carrier, has ${mid.sats}`);
    }
    records.push(
      await runSwap({
        client,
        session: trader,
        watcher,
        statusTransport,
        solverPubkey,
        legs,
        market,
        assetId,
        direction: 'asset->btc',
        amount: jitter(1_000n, 97),
        label: 'nostr-asset-to-btc',
      }),
    );

    console.log('\nboth directions settled over Nostr:');
    for (const r of records) {
      console.log(
        `  ${r.label}: ${r.give.amount} ${r.give.asset} -> ${r.take.amount} ${r.take.asset}` +
          ` (fee ${r.fee.amount} ${r.fee.asset}, fill ${r.fillTxid})`,
      );
    }
    console.log(`\nartifacts → ${OUT}`);
  } finally {
    await watcher.close();
    await statusTransport.close().catch(() => {});
    await client[Symbol.asyncDispose]?.().catch(() => {});
    await trader.wallet.dispose?.().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
