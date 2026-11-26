import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { KEYS_PATH } from './paths.mjs';

/**
 * Persist BIP39 phrases so restarts keep the same Arkade addresses.
 * Regtest only — these files are gitignored.
 */
export const WALLET_NAMES = ['issuer', 'solver', 'trader1', 'trader2', 'trader3'];

export function loadOrCreateKeys() {
  if (existsSync(KEYS_PATH)) {
    const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
    for (const name of WALLET_NAMES) {
      if (!keys[name]?.mnemonic) throw new Error(`keys.json missing mnemonic for ${name}`);
    }
    return keys;
  }

  // Prefer the stack's published INTENT_SOLVER_MNEMONIC when present so a
  // compose-started solver and this harness share one identity.
  const solverFromEnv = process.env.INTENT_SOLVER_MNEMONIC?.replace(/^"|"$/g, '').trim();
  const keys = Object.fromEntries(
    WALLET_NAMES.map((name) => [
      name,
      {
        mnemonic:
          name === 'solver' && solverFromEnv
            ? solverFromEnv
            : generateMnemonic(wordlist, 128),
        createdAt: new Date().toISOString(),
      },
    ]),
  );
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2) + '\n');
  console.log(`wrote persistent keys → ${KEYS_PATH}`);
  return keys;
}
