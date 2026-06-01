// arkd bring-up: create/unlock/sync the server wallet, fund it, set intent fees.
// One code path — there is no longer a "nigiri built-in arkd" variant.
import { env } from '../env.mjs';
import { log, warn, fail } from '../log.mjs';
import { waitFor, waitForOrFail, fetchJson, fetchText, httpOk } from '../wait.mjs';
import { faucet } from '../chain.mjs';
import { dockerExec } from '../proc.mjs';

const ADMIN = 'http://localhost:7071';
const INFO = 'http://localhost:7070';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function isInitialized() {
  // arkd exposes its signer pubkey on /v1/info only once the wallet is created
  // and unlocked, so its presence is a reliable "already set up" signal.
  const { json } = await fetchJson(`${INFO}/v1/info`);
  return Boolean(json && (json.signerPubkey || json.pubkey));
}

async function walletStatus() {
  const { json } = await fetchJson(`${ADMIN}/v1/admin/wallet/status`);
  return json || {};
}

async function setupWallet() {
  const password = env('ARKD_PASSWORD', 'secret');

  // arkd only serves its admin endpoint once it has connected to arkd-wallet,
  // which in turn waits on nbxplorer + bitcoind. On cold/loaded hosts that whole
  // chain (and any Docker restart backoff while it settles) can take a while.
  await waitForOrFail('arkd admin endpoint', () =>
    httpOk(`${ADMIN}/v1/admin/wallet/status`),
    { attempts: 60, intervalMs: 3000 },
  );

  let status = await walletStatus();
  if (!status.initialized) {
    log('Creating arkd server wallet...');
    const { json: seedResp } = await fetchJson(`${ADMIN}/v1/admin/wallet/seed`);
    const seed = seedResp && seedResp.seed;
    if (!seed) fail('Failed to generate wallet seed');
    const { text } = await fetchText(`${ADMIN}/v1/admin/wallet/create`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ seed, password }),
    });
    log(`Server wallet created: ${text}`);
  } else {
    log('arkd server wallet already initialized');
  }

  status = await walletStatus();
  if (!status.unlocked) {
    log('Unlocking arkd server wallet...');
    await fetchText(`${ADMIN}/v1/admin/wallet/unlock`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password }),
    });
  }

  await waitForOrFail(
    'arkd wallet sync',
    async () => (await walletStatus()).synced === true,
    { attempts: 60, intervalMs: 3000 },
  );
  log('arkd wallet synced');

  // Fund the SERVER wallet with 21 confirmed txs so fee estimation has history.
  const { json: addrResp } = await fetchJson(`${ADMIN}/v1/admin/wallet/address`);
  const serverAddr = addrResp && addrResp.address;
  if (!serverAddr) {
    warn('Could not get arkd server wallet address; skipping funding');
    return;
  }
  log(`Funding arkd server wallet at ${serverAddr} (21 txs for fee estimation)...`);
  for (let i = 0; i < 21; i++) faucet(serverAddr, 1);
  const { text: balance } = await fetchText(`${ADMIN}/v1/admin/wallet/balance`);
  log(`Server wallet balance: ${balance}`);

  // Best-effort: top up the client (ark CLI) wallet via redeem-notes for SDK
  // E2E suites that drive `ark send`. Older arkd builds may lack these verbs.
  log('Funding ark client wallet via redeem-notes...');
  const note = dockerExec('arkd', ['arkd', 'note', '--amount', '100000000'], { capture: true });
  if (note.code === 0 && note.stdout) {
    const redeem = dockerExec(
      'arkd',
      ['arkd', 'redeem-notes', '-n', note.stdout, '--password', password],
      { capture: true },
    );
    if (redeem.code !== 0) warn('client redeem-notes failed (older arkd version?)');
  } else {
    warn('arkd note generation failed (older arkd version?)');
  }
}

async function setupFees() {
  log('Configuring arkd intent fees...');
  const fees = {
    offchainInputFee: env('ARK_OFFCHAIN_INPUT_FEE'),
    onchainInputFee: env('ARK_ONCHAIN_INPUT_FEE'),
    offchainOutputFee: env('ARK_OFFCHAIN_OUTPUT_FEE'),
    onchainOutputFee: env('ARK_ONCHAIN_OUTPUT_FEE'),
  };
  try {
    await fetchText(`${ADMIN}/v1/admin/intentFees`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ fees }),
    });
    const { text } = await fetchText(`${ADMIN}/v1/admin/intentFees`);
    log(`arkd fees configured: ${text}`);
  } catch {
    warn('Failed to set arkd fees (admin endpoint unavailable?)');
  }
}

export async function setupArkd() {
  if (await isInitialized()) {
    log('arkd wallet already initialized, skipping wallet setup...');
  } else {
    await setupWallet();
  }
  await setupFees();
}
