#!/usr/bin/env node
/**
 * Configure the BTC/<asset> market in the intent-solver admin console and
 * restart so ASSET_MARKETS corridors pick up the priced row.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ADMIN_URL,
  ASSET_CARRIER_SATS,
  FEE_BPS,
  PRICEFEED_PORT,
} from './lib/config.mjs';
import { STATE_PATH } from './lib/paths.mjs';
import { waitHttpOk } from './lib/regtest.mjs';

const NAME = process.env.INTENT_SOLVER_CONTAINER ?? 'intent-solver-asset-rfq';

async function main() {
  if (!existsSync(STATE_PATH)) throw new Error('run bootstrap first');
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));

  // From inside the container, reach the host pricefeed via the bridge gateway.
  const gateway =
    (existsSync(new URL('./data/docker-gateway', import.meta.url)) &&
      readFileSync(new URL('./data/docker-gateway', import.meta.url), 'utf8').trim()) ||
    (() => {
      const out = spawnSync(
        'docker',
        [
          'network',
          'inspect',
          spawnSync('docker', ['inspect', 'arkd', '--format', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'], {
            encoding: 'utf8',
          }).stdout.trim(),
          '--format',
          '{{(index .IPAM.Config 0).Gateway}}',
        ],
        { encoding: 'utf8' },
      );
      return out.stdout.trim();
    })();

  const feedUrl = `http://${gateway}:${PRICEFEED_PORT}/price`;
  console.log(`price feed (from solver container): ${feedUrl}`);

  // Ensure host feed is up
  await waitHttpOk(`http://127.0.0.1:${PRICEFEED_PORT}/price`, { label: 'pricefeed' });
  await waitHttpOk(`${ADMIN_URL}/api/markets`, { label: 'admin markets' });

  const body = {
    base: null,
    quote: state.assetId,
    baseDecimals: 8,
    quoteDecimals: state.decimals ?? 0,
    feedUrl,
    pricePath: '/price',
    toleranceBps: 9999,
    feeBps: state.feeBps ?? FEE_BPS,
    // When the solver delivers the asset it spends a dust BTC carrier; charge
    // that on the BTC-input direction so exact-in math stays honest.
    sellBaseFeeFlat: String(ASSET_CARRIER_SATS),
    buyBaseFeeFlat: '0',
    sellBase: { min: '1', max: '100000000' },
    buyBase: { min: '1', max: '100000000' },
    enabled: true,
  };

  const res = await fetch(`${ADMIN_URL}/api/markets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PUT /api/markets → ${res.status} ${JSON.stringify(json)}`);
  }
  console.log('market stored:', json.market?.marketKey ?? json);
  console.log(json.restartNotice ?? 'restart required');

  // Enable the RFQ corridors now that the console prices the asset.
  const assetMarkets = state.assetMarkets ?? `${state.ticker}:${state.assetId}`;
  const envPath = new URL('./data/solver.env', import.meta.url);
  let envText = readFileSync(envPath, 'utf8');
  if (/^ASSET_MARKETS=/m.test(envText)) {
    envText = envText.replace(/^ASSET_MARKETS=.*$/m, `ASSET_MARKETS=${assetMarkets}`);
  } else {
    envText = envText.trimEnd() + `\nASSET_MARKETS=${assetMarkets}\n`;
  }
  writeFileSync(envPath, envText);
  console.log(`wrote ASSET_MARKETS=${assetMarkets} → data/solver.env`);

  // Recreate so createServices rebuilds corridors with ASSET_MARKETS + market row.
  console.log(`recreating ${NAME} with ASSET_MARKETS...`);
  const start = spawnSync('bash', ['./start-solver.sh'], {
    cwd: new URL('.', import.meta.url).pathname,
    encoding: 'utf8',
  });
  if (start.status !== 0) {
    throw new Error(start.stderr || start.stdout || 'start-solver.sh failed');
  }
  process.stdout.write(start.stdout);

  await waitHttpOk(`${ADMIN_URL}/api/markets`, {
    attempts: 30,
    intervalMs: 1000,
    label: 'admin markets after recreate',
  });

  const check = await fetch(`${ADMIN_URL}/api/markets`).then((r) => r.json());
  console.log(
    'active markets:',
    check.active,
    'servedBy sample:',
    check.markets?.[0]?.servedBy,
  );
  console.log('configure-market done — ready for npm run smoke');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
