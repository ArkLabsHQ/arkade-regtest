#!/usr/bin/env node
// arkade-regtest orchestrator — cross-platform, zero-dependency.
//
//   node regtest.mjs start [--env <path>] [--clean]
//   node regtest.mjs stop
//   node regtest.mjs clean [--prune]
//   node regtest.mjs faucet <address> <amountBtc>
//   node regtest.mjs mine [n]
//
// Replaces the old bash scripts + the nigiri binary entirely.
import { loadEnv, env } from './lib/env.mjs';
import { log, warn, fail } from './lib/log.mjs';
import { ROOT, composeUp, composeStop, composeDown } from './lib/compose.mjs';
import { docker } from './lib/proc.mjs';
import { sleep, waitForOrFail, httpOk, fetchJson } from './lib/wait.mjs';
import { bitcoinCli, bootstrapChain, mine, faucet } from './lib/chain.mjs';
import { setupArkd } from './lib/setup/arkd.mjs';
import { setupFulmine, setupDelegator } from './lib/setup/fulmine.mjs';
import { setupBoltz } from './lib/setup/boltz.mjs';
import { createInvoice, payInvoice } from './lib/invoice.mjs';

function parseArgs(argv) {
  const opts = { command: argv[0], env: '', clean: false, prune: false, positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') opts.env = argv[++i];
    else if (a === '--clean') opts.clean = true;
    else if (a === '--prune') opts.prune = true;
    else if (a === '--build') { /* legacy no-op: there is no build artifact anymore */ }
    else opts.positional.push(a);
  }
  return opts;
}

async function startEmulator() {
  if (!env('EMULATOR_IMAGE')) {
    log('Emulator disabled (EMULATOR_IMAGE empty), skipping...');
    return;
  }
  const port = env('EMULATOR_PORT', '7073');
  log(`Starting emulator overlay (${env('EMULATOR_IMAGE')})...`);
  composeUp(['emulator'], { profiles: ['emulator'] });
  await waitForOrFail('emulator /v1/info', () => httpOk(`http://localhost:${port}/v1/info`));
  const { json } = await fetchJson(`http://localhost:${port}/v1/info`);
  log(`Emulator up at http://localhost:${port} (signerPubkey: ${json?.signerPubkey || '?'})`);
}

function banner() {
  const lines = [
    '',
    '========================================',
    ' Regtest environment ready',
    '========================================',
    '',
    `  Bitcoin RPC     http://localhost:18443  (admin1 / 123)`,
    `  Mempool / API   http://localhost:${env('MEMPOOL_WEB_PORT', '3000')}  (Esplora REST under /api)`,
    `  Fulcrum         localhost:50001`,
    `  NBXplorer       http://localhost:32838`,
    `  Arkd            http://localhost:7070   (admin :7071)`,
    `  Arkd Wallet     http://localhost:6060`,
    `  Fulmine API     http://localhost:${env('FULMINE_API_PORT', '7003')}`,
    `  Delegator API   http://localhost:${env('DELEGATOR_API_PORT', '7011')}`,
    `  Boltz CORS      http://localhost:${env('NGINX_PORT', '9069')}`,
    `  Boltz gRPC      localhost:${env('BOLTZ_GRPC_PORT', '9000')}`,
    `  Boltz LND       localhost:${env('BOLTZ_LND_RPC_PORT', '10010')}`,
    `  Web Wallet      http://localhost:${env('WALLET_PORT', '3003')}`,
  ];
  if (env('EMULATOR_IMAGE')) {
    lines.push(`  Emulator        http://localhost:${env('EMULATOR_PORT', '7073')}`);
  }
  lines.push('', `  Arkd password:  ${env('ARKD_PASSWORD', 'secret')}`, '');
  console.log(lines.join('\n'));
}

async function start(opts) {
  if (opts.clean) await clean(opts);

  log('Starting arkade-regtest stack...');
  const up = composeUp([]);
  if (up.code !== 0) fail('docker compose up failed');

  // Chain first: wait for bitcoind RPC, then ensure the node wallet is funded.
  await waitForOrFail('Bitcoin Core RPC', () =>
    bitcoinCli(['getblockchaininfo'], { capture: true }).code === 0,
  );
  bootstrapChain();

  // Explorer must serve the Esplora API before arkd/fulmine can sync.
  await waitForOrFail('mempool Esplora API', () =>
    httpOk(`http://localhost:${env('MEMPOOL_WEB_PORT', '3000')}/api/blocks/tip/height`),
    { attempts: 60, intervalMs: 3000 },
  );

  await setupArkd();
  await setupFulmine();
  await setupDelegator();
  await setupBoltz();
  await startEmulator();

  banner();
}

async function stop() {
  log('Stopping arkade-regtest stack (data preserved)...');
  composeStop();
  log('Environment stopped.');
}

async function clean(opts) {
  log('Removing arkade-regtest containers and volumes...');
  composeDown({ volumes: true });
  if (opts.prune) {
    log('Pruning dangling images and volumes...');
    docker(['image', 'prune', '-f']);
    docker(['volume', 'prune', '-f']);
  }
  log('Clean-up complete.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command) {
    fail('usage: node regtest.mjs <start|stop|clean|faucet|mine> [options]');
  }

  // faucet/mine act on a running node and don't need override discovery, but
  // loading env is harmless and keeps ports/keys consistent.
  loadEnv(ROOT, opts.env);

  switch (opts.command) {
    case 'start':
      await start(opts);
      break;
    case 'stop':
      await stop();
      break;
    case 'clean':
      await clean(opts);
      break;
    case 'faucet': {
      const [address, amount] = opts.positional;
      if (!address || !amount) fail('usage: node regtest.mjs faucet <address> <amountBtc>');
      if (!faucet(address, amount)) fail('faucet failed');
      log(`Sent ${amount} BTC to ${address} and mined 1 block`);
      break;
    }
    case 'mine': {
      const n = parseInt(opts.positional[0] || '1', 10);
      if (!mine(n)) fail('mine failed');
      log(`Mined ${n} block(s)`);
      break;
    }
    case 'create-invoice':
      createInvoice({ secondary: process.argv.includes('--secondary') });
      break;
    case 'pay-invoice':
      payInvoice(opts.positional[0]);
      break;
    default:
      fail(`unknown command: ${opts.command}`);
  }
}

main().catch((err) => {
  // fail() already printed marked errors; print anything unexpected.
  if (!err?.handled) {
    console.error(`\x1b[0;31m${err && err.stack ? err.stack : String(err)}\x1b[0m`);
  }
  process.exitCode = 1;
});
