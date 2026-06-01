#!/usr/bin/env node
// arkade-regtest orchestrator — cross-platform, zero-dependency.
//
//   node regtest.mjs start [--env <path>] [--clean] [--profile <name>...]
//   node regtest.mjs stop
//   node regtest.mjs clean [--prune]
//   node regtest.mjs faucet <address> <amountBtc>
//   node regtest.mjs mine [n]
//
// Profiles (and their dependencies) let you bring up a subset of the stack:
//   base → ark → fulmine → boltz,  emulator → ark,  solver → ark + emulator.
// `--profile boltz` brings up base+ark+fulmine+boltz; no --profile = full stack.
//
// Replaces the old bash scripts + the nigiri binary entirely.
import { loadEnv, env } from './lib/env.mjs';
import { log, warn, fail } from './lib/log.mjs';
import { ROOT, composeUp, composeStop, composeDown, ALL_PROFILES } from './lib/compose.mjs';
import { docker } from './lib/proc.mjs';
import { sleep, waitForOrFail, httpOk, fetchJson } from './lib/wait.mjs';
import { bitcoinCli, bootstrapChain, mine, faucet } from './lib/chain.mjs';
import { setupArkd } from './lib/setup/arkd.mjs';
import { setupFulmine, setupDelegator } from './lib/setup/fulmine.mjs';
import { setupBoltz } from './lib/setup/boltz.mjs';
import { setupSolver } from './lib/setup/solver.mjs';
import { createInvoice, payInvoice } from './lib/invoice.mjs';

// Each profile's direct prerequisites. resolveProfiles() expands the transitive
// closure so the orchestrator can enable every profile a target tier needs.
const PROFILE_DEPS = {
  base: [],
  ark: ['base'],
  fulmine: ['ark'],
  boltz: ['fulmine'],
  emulator: ['ark'],
  solver: ['ark', 'emulator'],
};

function resolveProfiles(requested) {
  const out = new Set();
  const visit = (p) => {
    if (out.has(p)) return;
    if (!(p in PROFILE_DEPS)) {
      fail(`unknown profile "${p}" (valid: ${Object.keys(PROFILE_DEPS).join(', ')})`);
    }
    out.add(p);
    PROFILE_DEPS[p].forEach(visit);
  };
  requested.forEach(visit);
  return [...out];
}

function parseArgs(argv) {
  const opts = { command: argv[0], env: '', clean: false, prune: false, profiles: [], positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') opts.env = argv[++i] || fail('--env requires a path');
    else if (a === '--clean') opts.clean = true;
    else if (a === '--prune') opts.prune = true;
    else if (a === '--profile') {
      const val = argv[++i] || fail('--profile requires a name');
      opts.profiles.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
    }
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

function banner(active) {
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
  ];
  if (active.has('ark')) {
    lines.push(`  Arkd            http://localhost:7070   (admin :7071)`);
    lines.push(`  Arkd Wallet     http://localhost:6060`);
  }
  if (active.has('fulmine')) {
    lines.push(`  Fulmine API     http://localhost:${env('FULMINE_API_PORT', '7003')}`);
    lines.push(`  Delegator API   http://localhost:${env('DELEGATOR_API_PORT', '7011')}`);
    lines.push(`  Boltz LND       localhost:${env('BOLTZ_LND_RPC_PORT', '10010')}`);
  }
  if (active.has('boltz')) {
    lines.push(`  Boltz CORS      http://localhost:${env('NGINX_PORT', '9069')}`);
    lines.push(`  Boltz gRPC      localhost:${env('BOLTZ_GRPC_PORT', '9000')}`);
    lines.push(`  Web Wallet      http://localhost:${env('WALLET_PORT', '3003')}`);
  }
  if (active.has('emulator')) {
    lines.push(`  Emulator        http://localhost:${env('EMULATOR_PORT', '7073')}`);
  }
  if (active.has('solver')) {
    lines.push(`  Solver HTTP     http://localhost:${env('SOLVER_HTTP_PORT', '7091')}`);
    lines.push(`  Solver gRPC     localhost:${env('SOLVER_GRPC_PORT', '7090')}`);
  }
  lines.push(
    '',
    `  Active profiles: ${[...active].join(', ')}`,
    `  Arkd password:   ${env('ARKD_PASSWORD', 'secret')}`,
    '',
  );
  console.log(lines.join('\n'));
}

async function start(opts) {
  if (opts.clean) await clean(opts);

  const requested = opts.profiles.length ? opts.profiles : ALL_PROFILES;
  const active = new Set(resolveProfiles(requested));

  // Emulator opt-out: clearing EMULATOR_IMAGE disables it — and the solver,
  // which requires the emulator (SOLVER_EMULATOR_URL).
  if (!env('EMULATOR_IMAGE')) {
    if (active.delete('emulator')) log('Emulator disabled (EMULATOR_IMAGE empty)');
    if (active.delete('solver')) warn('Solver needs the emulator; skipping it (EMULATOR_IMAGE is empty)');
  }

  const profiles = [...active];
  log(`Starting arkade-regtest stack (profiles: ${profiles.join(', ')})...`);
  const up = composeUp([], { profiles });
  if (up.code !== 0) fail('docker compose up failed');

  // base (always in any closure): wait for bitcoind RPC, fund the node wallet,
  // and wait for the explorer's Esplora API before anything tries to sync.
  await waitForOrFail('Bitcoin Core RPC', () =>
    bitcoinCli(['getblockchaininfo'], { capture: true }).code === 0,
  );
  bootstrapChain();
  await waitForOrFail('mempool Esplora API', () =>
    httpOk(`http://localhost:${env('MEMPOOL_WEB_PORT', '3000')}/api/blocks/tip/height`),
    { attempts: 60, intervalMs: 3000 },
  );

  if (active.has('ark')) await setupArkd();
  if (active.has('fulmine')) {
    await setupFulmine();
    await setupDelegator();
  }
  if (active.has('boltz')) await setupBoltz();
  if (active.has('emulator')) await startEmulator();
  if (active.has('solver')) await setupSolver();

  banner(active);
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
