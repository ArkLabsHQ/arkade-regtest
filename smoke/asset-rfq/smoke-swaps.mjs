#!/usr/bin/env node
/**
 * Smoke-test asset RFQ against intent-solver:
 *   1. Send all asset → BTC (needs dust BTC carrier)
 *   2. Send all BTC → asset
 *   3. Random BTC ↔ asset back and forth
 * Verify fee_bps payouts against expected exact-in arithmetic.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSET_CARRIER_SATS,
  FEE_BPS,
  SOLVER_URL,
} from './lib/config.mjs';
import { loadOrCreateKeys } from './lib/keys.mjs';
import { STATE_PATH, SWAPS_DIR } from './lib/paths.mjs';
import {
  expectedPayoutExactIn,
  fundQuotedOffer,
  pairFor,
  requestAssetQuote,
  waitSettled,
} from './lib/rfq.mjs';
import { assetBalance, availableSats, openWallet } from './lib/wallet.mjs';
import { waitHttpOk, mine } from './lib/regtest.mjs';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function snapshot(wallet, assetId) {
  const b = await wallet.getBalance();
  return { sats: availableSats(b), asset: assetBalance(b, assetId) };
}

async function runSwap({
  session,
  assetId,
  direction,
  amount,
  feeBps,
  label,
}) {
  const before = await snapshot(session.wallet, assetId);
  const pair =
    direction === 'btc->asset'
      ? pairFor(null, assetId)
      : pairFor(assetId, null);

  console.log(`\n=== ${label} (${direction}, amount=${amount}) ===`);
  const quote = await requestAssetQuote({
    pair,
    amount,
    amountSide: 'from',
    makerPkScript: session.pkScript,
    makerPublicKey: session.publicKey,
  });

  const expectedTo = expectedPayoutExactIn(amount, feeBps);
  // sellBaseFeeFlat (carrier) is charged on BTC-input (sell_base) before bps;
  // for 1:1 feed at these decimals the e2e formula without flat fee is the
  // baseline — when flat fee applies, adjust expectation.
  let expected = expectedTo;
  if (direction === 'btc->asset') {
    const afterFlat = amount - ASSET_CARRIER_SATS;
    if (afterFlat <= 0n) throw new Error('amount too small for carrier flat fee');
    expected = expectedPayoutExactIn(afterFlat, feeBps);
  }

  console.log('quote', {
    from: quote.from_amount,
    to: quote.to_amount,
    expected: expected.toString(),
    valid_until: quote.valid_until,
    offer: quote.profile.offer_address,
  });
  assertEq(BigInt(quote.from_amount), amount, 'from_amount');
  assertEq(BigInt(quote.to_amount), expected, 'to_amount (fee check)');

  const { fundingTxid } = await fundQuotedOffer(session.wallet, quote, direction, assetId);
  console.log('funded', fundingTxid);
  // Confirm the funding batch so the solver's deposit watcher sees a live VTXO
  // before session expiry turns it recoverable.
  mine(1);

  const status = await waitSettled(quote.rfq_id);
  console.log('settled', status.state, status.fill_txid ?? status);

  const after = await snapshot(session.wallet, assetId);
  const record = {
    label,
    direction,
    amount: amount.toString(),
    expectedTo: expected.toString(),
    quote,
    fundingTxid,
    status,
    before: { sats: before.sats.toString(), asset: before.asset.toString() },
    after: { sats: after.sats.toString(), asset: after.asset.toString() },
  };
  writeFileSync(join(SWAPS_DIR, `${Date.now()}-${label.replace(/\s+/g, '_')}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function main() {
  if (!existsSync(STATE_PATH)) throw new Error('run bootstrap + start-solver + configure-market first');
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  const keys = loadOrCreateKeys();
  await waitHttpOk(`${SOLVER_URL}/healthz`, { label: 'solver' });

  const trader1 = await openWallet(keys.trader1.mnemonic, 'trader1');
  const trader2 = await openWallet(keys.trader2.mnemonic, 'trader2');
  const assetId = state.assetId;
  const feeBps = state.feeBps ?? FEE_BPS;

  // 1) Send ALL asset → BTC (leave dust carrier). Jitter the amount: identical
  // covenant terms derive one offer address, and the solver DB uniques on
  // offer_pk_script — a fixed amount collides with a prior run's row.
  {
    const bal = await snapshot(trader1.wallet, assetId);
    if (bal.asset <= 0n) throw new Error('trader1 has no asset');
    if (bal.sats < ASSET_CARRIER_SATS) {
      throw new Error(`trader1 needs >= ${ASSET_CARRIER_SATS} sats dust carrier for asset→BTC`);
    }
    const jitter = 1n + BigInt(Math.floor(Math.random() * 97));
    const amount = bal.asset > jitter ? bal.asset - jitter : bal.asset;
    await runSwap({
      session: trader1,
      assetId,
      direction: 'asset->btc',
      amount,
      feeBps,
      label: 'all-asset-to-btc',
    });
  }

  // 2) BTC → asset. Cap by a modest size: exact-in at 1:1 needs the solver to
  // hold that many asset units, and "spend nearly all BTC" overshoots the float.
  {
    const bal = await snapshot(trader1.wallet, assetId);
    const reserve = 5_000n;
    if (bal.sats <= reserve + ASSET_CARRIER_SATS + 2_000n) {
      throw new Error(`trader1 sats ${bal.sats} too low after asset→btc`);
    }
    const jitter = 1n + BigInt(Math.floor(Math.random() * 997));
    const amount = 10_000n + jitter;
    await runSwap({
      session: trader1,
      assetId,
      direction: 'btc->asset',
      amount,
      feeBps,
      label: 'btc-to-asset',
    });
  }

  // 3) Random back-and-forth on trader2.
  {
    const rounds = Number(process.env.RANDOM_ROUNDS ?? 4);
    for (let i = 0; i < rounds; i++) {
      const bal = await snapshot(trader2.wallet, assetId);
      const giveBtc = i % 2 === 0;
      if (giveBtc) {
        const max = bal.sats - 10_000n;
        if (max < 2_000n) throw new Error('trader2 BTC too low for random round');
        const amount = 2_000n + BigInt(Math.floor(Math.random() * Number(max - 2_000n)));
        await runSwap({
          session: trader2,
          assetId,
          direction: 'btc->asset',
          amount,
          feeBps,
          label: `random-btc-to-asset-${i}`,
        });
      } else {
        const max = bal.asset;
        if (max < 100n) throw new Error('trader2 asset too low for random round');
        if (bal.sats < ASSET_CARRIER_SATS) {
          throw new Error('trader2 needs dust BTC carrier for asset→btc');
        }
        const amount = 100n + BigInt(Math.floor(Math.random() * Number(max - 100n)));
        await runSwap({
          session: trader2,
          assetId,
          direction: 'asset->btc',
          amount,
          feeBps,
          label: `random-asset-to-btc-${i}`,
        });
      }
    }
  }

  console.log('\nall smoke scenarios passed');
  await trader1.wallet.dispose?.().catch(() => {});
  await trader2.wallet.dispose?.().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
