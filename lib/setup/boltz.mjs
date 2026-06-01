// Boltz Lightning + swap bring-up: fund the boltz-lnd wallet, open a channel to
// the counterparty `lnd`, balance it, then fund Boltz's Bitcoin Core wallet and
// verify the ARK/BTC pairs are live.
import { env } from '../env.mjs';
import { log, warn, fail } from '../log.mjs';
import { sleep, waitFor, waitForOrFail, fetchText } from '../wait.mjs';
import { faucet, mine, bitcoinCli } from '../chain.mjs';
import { dockerExec } from '../proc.mjs';
import { compose } from '../compose.mjs';

// The counterparty `lnd` stores its data at /data/.lnd (HOME=/data + --lnddir),
// so lncli there needs --lnddir to find tls.cert/macaroons. boltz-lnd uses the
// default /root/.lnd path.
function lncliBase(container) {
  return container === 'lnd'
    ? ['lncli', '--network=regtest', '--lnddir=/data/.lnd']
    : ['lncli', '--network=regtest'];
}

// Run an lncli command in a container and parse its JSON output.
function lncli(container, args) {
  const r = dockerExec(container, [...lncliBase(container), ...args], { capture: true });
  if (r.code !== 0) return { ok: false, json: null, err: r.stderr || r.stdout };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: true, json: null, raw: r.stdout };
  }
}

function channelCount() {
  const { json } = lncli('boltz-lnd', ['listchannels']);
  return json && Array.isArray(json.channels) ? json.channels.length : 0;
}

async function setupLndChannel() {
  if (channelCount() > 0) {
    log('LND channel already open, skipping setup...');
    return;
  }

  log('Setting up LND for Lightning swaps...');
  await waitForOrFail('boltz-lnd wallet', () => lncli('boltz-lnd', ['getinfo']).ok);

  const addr = lncli('boltz-lnd', ['newaddress', 'p2wkh']).json?.address;
  if (!addr) fail('Could not get boltz-lnd address');
  log(`Funding boltz-lnd at ${addr}...`);
  faucet(addr, env('LND_FAUCET_AMOUNT', '2'));
  await sleep(10000);

  const bal = parseInt(
    lncli('boltz-lnd', ['walletbalance']).json?.account_balance?.default?.confirmed_balance ?? '0',
    10,
  );
  if (bal < 1000000) fail(`boltz-lnd balance (${bal}) < 1,000,000 sats — funding failed`);
  log(`boltz-lnd balance: ${bal}`);

  await waitForOrFail('counterparty lnd', () => lncli('lnd', ['getinfo']).ok);
  const counterparty = lncli('lnd', ['getinfo']).json?.identity_pubkey;
  if (!counterparty) fail('Could not get counterparty lnd pubkey');
  log(`Opening channel to counterparty (${counterparty})...`);
  dockerExec('boltz-lnd', [
    ...lncliBase('boltz-lnd'), 'openchannel',
    '--node_key', counterparty,
    '--connect', 'lnd:9735',
    '--local_amt', env('LND_CHANNEL_SIZE', '1000000'),
    '--sat_per_vbyte', '1',
    '--min_confs', '0',
  ]);

  log('Mining 10 blocks to confirm channel...');
  mine(10);
  await sleep(10000);

  // Push some liquidity so the channel is balanced for reverse swaps.
  log('Balancing channel via a test invoice...');
  const invoice = lncli('lnd', ['addinvoice', '--amt', '500000']).json?.payment_request;
  if (invoice) dockerExec('boltz-lnd', [...lncliBase('boltz-lnd'), 'payinvoice', '--force', invoice]);
  log('LND channel setup completed');
}

async function fundBoltzCore() {
  // Boltz uses preferredWallet="core" → Bitcoin Core's default wallet.
  log('Funding Boltz Bitcoin Core wallet...');
  const addr = bitcoinCli(['getnewaddress'], { capture: true }).stdout;
  if (addr) {
    faucet(addr, 5);
    log(`Boltz core wallet funded at ${addr}`);
  } else {
    warn('Could not get a Bitcoin Core address to fund Boltz');
  }
}

async function verifyPairs() {
  const port = env('NGINX_PORT', '9069');
  log('Verifying Boltz ARK/BTC pairs...');
  // Boltz must (re)connect to the ark/fulmine endpoint before it publishes the
  // ARK pair; on cold CI runners that handshake can take a couple of minutes.
  const ok = await waitFor(
    'Boltz ARK/BTC pairs',
    async () => {
      const { text } = await fetchText(`http://localhost:${port}/v2/swap/submarine`, { timeoutMs: 15000 });
      return text.includes('"ARK"');
    },
    { attempts: 90, intervalMs: 2000 },
  );
  if (!ok) fail('Boltz ARK/BTC pairs not available');
  log('Boltz ARK/BTC pairs loaded successfully');
}

// Step run after the wallets exist: ensure the channel, restart boltz so it
// reconnects to a ready boltz-lnd, fund its core wallet, verify pairs.
export async function setupBoltz() {
  await setupLndChannel();

  log('Restarting Boltz to reconnect to boltz-lnd...');
  compose(['restart', 'boltz']);
  await sleep(5000);

  await fundBoltzCore();
  await verifyPairs();
}
