#!/usr/bin/env node
/**
 * Bootstrap asset-RFQ smoke env against a running arkade-regtest (ark + emulator):
 *   - persist trader/solver/issuer mnemonics
 *   - faucet + settle BTC
 *   - mint USDT-like asset
 *   - fund solver + traders with BTC and asset
 *   - write data/state.json + data/solver.env for the intent-solver RFQ path
 */
import { writeFileSync } from 'node:fs';
import {
  ASSET_DECIMALS,
  ASSET_SUPPLY,
  ASSET_TICKER,
  FEE_BPS,
  SOLVER_ASSET_UNITS,
  SOLVER_BTC_SATS,
  TRADER_ASSET_UNITS,
  TRADER_BTC_SATS,
  ASSET_CARRIER_SATS,
} from './lib/config.mjs';
import { loadOrCreateKeys } from './lib/keys.mjs';
import { KEYS_PATH, STATE_PATH, SOLVER_ENV_PATH } from './lib/paths.mjs';
import { faucet, mine, waitArkReady } from './lib/regtest.mjs';
import { assetBalance, availableSats, openWallet, settleBoarding, waitBalance } from './lib/wallet.mjs';

async function fundOffchain(session, sats, label) {
  const before = availableSats(await session.wallet.getBalance());
  if (before >= sats) {
    console.log(`[${label}] already has ${before} sats available`);
    return;
  }
  // Board onchain then settle — more reliable than the shared `ark` CLI when
  // its VTXOs have aged out of the spendable window.
  const boarding = await session.wallet.getBoardingAddress();
  const btc = Math.max(Number(sats + 100_000n) / 1e8, 0.001);
  console.log(`[${label}] faucet ${btc} BTC → boarding ${boarding}`);
  faucet(boarding, btc, { confirm: true });
  await settleBoarding(session.wallet, label);
  // Confirm the batch commitment so VTXOs do not age into recoverable while
  // ARKD_SESSION_DURATION elapses with the miner stopped.
  mine(1);
  await waitBalance(session.wallet, (b) => availableSats(b) >= sats, `${label} BTC >= ${sats}`);
}

async function sendAndConfirm(fromWallet, args, waitWallet, pred, label) {
  await fromWallet.send(args);
  mine(1);
  await waitBalance(waitWallet, pred, label);
}

async function main() {
  await waitArkReady();
  const keys = loadOrCreateKeys();

  const issuer = await openWallet(keys.issuer.mnemonic, 'issuer');
  const solver = await openWallet(keys.solver.mnemonic, 'solver');
  const traders = [];
  for (const name of ['trader1', 'trader2', 'trader3']) {
    traders.push(await openWallet(keys[name].mnemonic, name));
  }

  // Issuer holds the mint + distributes inventory.
  const issuerNeed =
    SOLVER_BTC_SATS +
    TRADER_BTC_SATS * BigInt(traders.length) +
    ASSET_SUPPLY + // carriers for minted supply
    1_000_000n;
  await fundOffchain(issuer, issuerNeed, 'issuer');

  // Mint once; reuse asset id from a prior run if issuer already holds it.
  let assetId;
  {
    const bal = await issuer.wallet.getBalance();
    const existing = (bal.availableAssets ?? []).find((a) => BigInt(a.amount) > 0n);
    if (existing && process.env.REUSE_ASSET === '1') {
      assetId = existing.assetId;
      console.log(`[issuer] reusing asset ${assetId}`);
    } else {
      console.log(`[issuer] minting ${ASSET_SUPPLY} ${ASSET_TICKER}...`);
      const issued = await issuer.wallet.assetManager.issue({
        amount: ASSET_SUPPLY,
        metadata: { ticker: ASSET_TICKER, name: 'Regtest USD', decimals: ASSET_DECIMALS },
      });
      assetId = issued.assetId;
      console.log(`[issuer] minted ${assetId} (tx ${issued.arkTxId})`);
      // Issuance can leave balances mid-restructure; settle if needed.
      await issuer.wallet.settle().catch(() => {});
      mine(1);
      await waitBalance(
        issuer.wallet,
        (b) => assetBalance(b, assetId) >= ASSET_SUPPLY,
        'issuer asset supply',
      );
    }
  }

  // Fund solver BTC first (before asset VTXOs compete as carriers).
  {
    const bal = await solver.wallet.getBalance();
    if (availableSats(bal) < SOLVER_BTC_SATS) {
      console.log(`[issuer→solver] ${SOLVER_BTC_SATS} sats`);
      await sendAndConfirm(
        issuer.wallet,
        { address: solver.address, amount: Number(SOLVER_BTC_SATS) },
        solver.wallet,
        (b) => availableSats(b) >= SOLVER_BTC_SATS,
        'solver BTC',
      );
    }
  }

  {
    const bal = await solver.wallet.getBalance();
    if (assetBalance(bal, assetId) < SOLVER_ASSET_UNITS) {
      console.log(`[issuer→solver] ${SOLVER_ASSET_UNITS} ${ASSET_TICKER}`);
      await sendAndConfirm(
        issuer.wallet,
        {
          address: solver.address,
          amount: Number(ASSET_CARRIER_SATS),
          assets: [{ assetId, amount: SOLVER_ASSET_UNITS }],
        },
        solver.wallet,
        (b) => assetBalance(b, assetId) >= SOLVER_ASSET_UNITS,
        'solver asset',
      );
    }
  }

  for (const trader of traders) {
    const bal = await trader.wallet.getBalance();
    if (availableSats(bal) < TRADER_BTC_SATS) {
      console.log(`[issuer→${trader.label}] ${TRADER_BTC_SATS} sats`);
      await sendAndConfirm(
        issuer.wallet,
        { address: trader.address, amount: Number(TRADER_BTC_SATS) },
        trader.wallet,
        (b) => availableSats(b) >= TRADER_BTC_SATS,
        `${trader.label} BTC`,
      );
    }
    if (assetBalance(await trader.wallet.getBalance(), assetId) < TRADER_ASSET_UNITS) {
      console.log(`[issuer→${trader.label}] ${TRADER_ASSET_UNITS} ${ASSET_TICKER}`);
      await sendAndConfirm(
        issuer.wallet,
        {
          address: trader.address,
          amount: Number(ASSET_CARRIER_SATS),
          assets: [{ assetId, amount: TRADER_ASSET_UNITS }],
        },
        trader.wallet,
        (b) => assetBalance(b, assetId) >= TRADER_ASSET_UNITS,
        `${trader.label} asset`,
      );
    }
  }

  const assetMarkets = `${ASSET_TICKER}:${assetId}`;
  const state = {
    network: 'regtest',
    assetId,
    ticker: ASSET_TICKER,
    decimals: ASSET_DECIMALS,
    feeBps: FEE_BPS,
    assetMarkets,
    keysPath: KEYS_PATH,
    addresses: {
      issuer: issuer.address,
      solver: solver.address,
      traders: Object.fromEntries(traders.map((t) => [t.label, t.address])),
    },
    fundedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  // Intent-solver env. ASSET_MARKETS is omitted on first boot: the process
  // refuses to start when ASSET_MARKETS names an asset the admin console has
  // not priced yet. configure-market.mjs PUTsthe market, then appends
  // ASSET_MARKETS and recreates the container.
  const solverEnv = `# Generated by bootstrap.mjs — asset RFQ smoke
SWAP_NETWORK=regtest
ARK_MNEMONIC=${keys.solver.mnemonic}
ARK_SERVER_URL=http://arkd:7070
EMULATOR_URL=http://emulator:7073
ARK_ESPLORA_URL=http://mempool_web/api
HOST=0.0.0.0
PORT=8787
ADMIN_HOST=0.0.0.0
ADMIN_PORT=8788
ADMIN_RESTART_ENABLED=true
DB_DIR=/data
LN_SEND_ENABLED=false
LN_RECEIVE_ENABLED=false
ONCHAIN_SEND_ENABLED=false
ONCHAIN_RECEIVE_ENABLED=false
ASSET_${ASSET_TICKER}_BUY_ENABLED=true
ASSET_${ASSET_TICKER}_SELL_ENABLED=true
ASSET_QUOTE_VALIDITY_SECONDS=120
SOLVER_NAME=regtest-asset-rfq
`;
  writeFileSync(SOLVER_ENV_PATH, solverEnv);

  console.log('\nbootstrap complete');
  console.log(`  state → ${STATE_PATH}`);
  console.log(`  keys  → ${KEYS_PATH}`);
  console.log(`  env   → ${SOLVER_ENV_PATH}`);
  console.log(`  asset → ${assetId}`);
  console.log('\nnext: ./start-solver.sh && npm run configure-market && npm run smoke');

  await issuer.wallet.dispose?.().catch(() => {});
  await solver.wallet.dispose?.().catch(() => {});
  for (const t of traders) await t.wallet.dispose?.().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
