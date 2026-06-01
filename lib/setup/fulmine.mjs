// Fulmine + delegator wallet bring-up. Both are the same Fulmine image; the
// delegator just runs without LND/Boltz. One generalized helper covers both.
import { env } from '../env.mjs';
import { log, warn, fail } from '../log.mjs';
import { sleep, waitFor, waitForOrFail, fetchJson, fetchText, httpOk } from '../wait.mjs';
import { faucet, mine } from '../chain.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Docker-internal arkd URL stored in the Fulmine wallet at creation time.
// Coupled to the `arkd` service name in docker/compose.ark.yml — keep in sync
// if that service is ever renamed.
const ARK_SERVER = 'http://arkd:7070';

async function status(base) {
  const { json } = await fetchJson(`${base}/api/v1/wallet/status`);
  return json || {};
}

function parseAddress(raw) {
  // Fulmine returns e.g. "bitcoin:bcrt1...?ark=..."; strip prefix + query.
  return String(raw || '')
    .replace(/^bitcoin:/, '')
    .replace(/\?ark=.*$/, '');
}

// label: human name for logs; port: host API port; faucetAmount: BTC to board.
async function setupWallet({ label, port, faucetAmount }) {
  const base = `http://localhost:${port}`;

  const existing = await status(base).catch(() => ({}));
  if (existing.initialized) {
    log(`${label} wallet already initialized, skipping...`);
    return;
  }

  await waitForOrFail(`${label} service`, () =>
    httpOk(`${base}/api/v1/wallet/status`),
  );

  log(`Creating ${label} wallet...`);
  const { json: seedResp } = await fetchJson(`${base}/api/v1/wallet/genseed`);
  const privateKey = seedResp && seedResp.nsec;
  if (!privateKey) fail(`${label}: failed to generate seed`);

  await fetchText(`${base}/api/v1/wallet/create`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ private_key: privateKey, password: 'password', server_url: ARK_SERVER }),
  });
  await fetchText(`${base}/api/v1/wallet/unlock`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: 'password' }),
  });

  await waitForOrFail(`${label} wallet ready`, async () => {
    const s = await status(base);
    return s.initialized === true && s.synced === true && s.unlocked === true;
  });

  // Board the wallet: faucet on-chain, confirm, then settle into a VTXO.
  const addr = parseAddress((await fetchJson(`${base}/api/v1/address`)).json?.address);
  if (!addr) fail(`${label}: failed to get a valid wallet address`);
  log(`${label} address: ${addr}`);

  log(`Funding ${label} wallet...`);
  faucet(addr, faucetAmount);
  mine(3);
  await sleep(10000);

  log(`Settling ${label} wallet...`);
  try {
    await fetchText(`${base}/api/v1/settle`, { timeoutMs: 110000 });
  } catch {
    warn(`${label} settle timed out or failed, continuing...`);
  }
  await sleep(15000);
  mine(3);
  await sleep(3000);

  log(`${label} wallet setup completed`);
}

export async function setupFulmine() {
  await setupWallet({
    label: 'Fulmine',
    port: env('FULMINE_API_PORT', '7003'),
    faucetAmount: env('FULMINE_FAUCET_AMOUNT', '0.01'),
  });
}

export async function setupDelegator() {
  await setupWallet({
    label: 'Delegator',
    port: env('DELEGATOR_API_PORT', '7011'),
    faucetAmount: '0.01',
  });
}
