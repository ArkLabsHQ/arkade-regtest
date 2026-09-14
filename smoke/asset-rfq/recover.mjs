#!/usr/bin/env node
/**
 * Settle boarding / recoverable / preconfirmed VTXOs back to available.
 * Needed when ARKD_SESSION_DURATION is short and commitment txs were not mined.
 */
import { readFileSync } from 'node:fs';
import { loadOrCreateKeys } from './lib/keys.mjs';
import { mine } from './lib/regtest.mjs';
import { STATE_PATH } from './lib/paths.mjs';
import { assetBalance, availableSats, openWallet } from './lib/wallet.mjs';

const NAMES = ['solver', 'trader1', 'trader2', 'trader3', 'issuer'];

async function settleOne(name, assetId) {
  const session = await openWallet(loadOrCreateKeys()[name].mnemonic, name);
  const before = await session.wallet.getBalance();
  const need =
    Number(before.recoverable ?? 0) > 0 ||
    Number(before.boarding?.total ?? 0) > 0 ||
    Number(before.preconfirmed ?? 0) > 0;
  console.log(name, 'before', {
    available: availableSats(before).toString(),
    recoverable: String(before.recoverable ?? 0),
    preconfirmed: String(before.preconfirmed ?? 0),
    asset: assetBalance(before, assetId).toString(),
  });
  if (!need) {
    await session.wallet.dispose?.().catch(() => {});
    return;
  }
  for (let i = 0; i < 6; i++) {
    try {
      const txid = await session.wallet.settle();
      console.log(name, 'settle ok', txid);
      mine(1);
      break;
    } catch (err) {
      console.log(name, `settle attempt ${i}:`, err.message ?? err);
      try {
        mine(1);
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const after = await session.wallet.getBalance();
  console.log(name, 'after', {
    available: availableSats(after).toString(),
    recoverable: String(after.recoverable ?? 0),
    asset: assetBalance(after, assetId).toString(),
  });
  await session.wallet.dispose?.().catch(() => {});
}

async function main() {
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  for (const name of NAMES) {
    await settleOne(name, state.assetId);
  }
  console.log('recover done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
