#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { loadOrCreateKeys } from './lib/keys.mjs';
import { STATE_PATH } from './lib/paths.mjs';
import { assetBalance, availableSats, openWallet } from './lib/wallet.mjs';

async function main() {
  const keys = loadOrCreateKeys();
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null;
  const assetId = state?.assetId;

  for (const name of Object.keys(keys)) {
    const s = await openWallet(keys[name].mnemonic, name);
    const b = await s.wallet.getBalance();
    const row = {
      sats: availableSats(b).toString(),
      assets: assetId ? assetBalance(b, assetId).toString() : (b.availableAssets ?? []),
    };
    console.log(name, s.address, row);
    await s.wallet.dispose?.().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
