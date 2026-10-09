#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadOrCreateKeys } from './lib/keys.mjs';
import { mine } from './lib/regtest.mjs';
import { STATE_PATH } from './lib/paths.mjs';
import { assetBalance, availableSats, openWallet, waitBalance } from './lib/wallet.mjs';

const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
const keys = loadOrCreateKeys();
const names = ['issuer', 'solver', 'trader1', 'trader2', 'trader3'];
const sessions = {};
for (const n of names) {
  sessions[n] = await openWallet(keys[n].mnemonic, n);
  const b = await sessions[n].wallet.getBalance();
  console.log(n, {
    sats: availableSats(b).toString(),
    asset: assetBalance(b, state.assetId).toString(),
    rec: String(b.recoverable),
  });
}

const issuer = sessions.issuer;
const t1 = sessions.trader1;
if (assetBalance(await t1.wallet.getBalance(), state.assetId) < 10_000n) {
  console.log('refilling trader1 with 20000 asset');
  await issuer.wallet.send({
    address: t1.address,
    amount: 330,
    assets: [{ assetId: state.assetId, amount: 20_000n }],
  });
  mine(1);
  await waitBalance(
    t1.wallet,
    (b) => assetBalance(b, state.assetId) >= 20_000n,
    'trader1 asset refill',
  );
  const b = await t1.wallet.getBalance();
  console.log('trader1 after', availableSats(b).toString(), assetBalance(b, state.assetId).toString());
}

for (const n of names) await sessions[n].wallet.dispose?.().catch(() => {});
