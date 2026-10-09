import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ARK_SERVER_URL } from './config.mjs';

const REGTEST = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function runRegtest(args) {
  const result = spawnSync(process.execPath, ['regtest.mjs', ...args], {
    cwd: REGTEST,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`regtest ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Fund an Arkade offchain address from the stack's seeded `ark` client. */
export function arkSend(address, sats) {
  return runRegtest([
    'ark',
    'send',
    '--to',
    address,
    '--amount',
    String(sats),
    '--password',
    process.env.ARKD_PASSWORD ?? 'secret',
  ]);
}

export function faucet(address, btcAmount, { confirm = true } = {}) {
  const args = ['faucet', address, String(btcAmount)];
  if (confirm) args.push('--confirm');
  return runRegtest(args);
}

export function mine(n = 1) {
  return runRegtest(['mine', String(n)]);
}

export async function waitHttpOk(url, { attempts = 60, intervalMs = 1000, label = url } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    if (i === attempts) throw new Error(`${label} not ready after ${attempts} attempts`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function waitArkReady() {
  await waitHttpOk(`${ARK_SERVER_URL}/v1/info`, { label: 'arkd' });
}
