// Bitcoin Core helpers — the in-house replacement for `nigiri faucet` and
// `nigiri rpc --generate`.
//
//   mine(n)            = bitcoin-cli -generate n   (to the node's default wallet)
//   faucet(addr, amt)  = bitcoin-cli sendtoaddress + mine 1 to confirm
//
// Block production is explicit: there is no background auto-miner. The start
// flow mines at each funding point; tests that broadcast a tx and await a
// confirmation must mine themselves via `node regtest.mjs mine`.
import { dockerExec } from './proc.mjs';
import { log, warn } from './log.mjs';
import { waitFor, waitForOrFail } from './wait.mjs';

const CLI = ['bitcoin-cli', '-regtest', '-rpcuser=admin1', '-rpcpassword=123'];

// Name used only if we have to create a wallet ourselves (see bootstrapChain).
const WALLET = 'default';

function loadedWalletCount() {
  try {
    return JSON.parse(bitcoinCli(['listwallets'], { capture: true }).stdout).length;
  } catch {
    return 0;
  }
}

export function bitcoinCli(args, opts = {}) {
  return dockerExec('bitcoin', [...CLI, ...args], opts);
}

export function getBalance() {
  const r = bitcoinCli(['getbalance'], { capture: true });
  const n = parseFloat(r.stdout);
  return Number.isFinite(n) ? n : 0;
}

export function mine(n = 1) {
  const r = bitcoinCli(['-generate', String(n)], { capture: true });
  if (r.code !== 0) warn(`mine ${n} failed: ${r.stderr || r.stdout}`);
  return r.code === 0;
}

// Ensure the node has a loaded wallet and 101+ blocks (matured coinbase).
// The bitcoind RPC answers before its wallet subsystem is fully ready, so each
// step is retried — otherwise createwallet/getnewaddress can silently fail under
// load, leaving the chain at 0 blocks (which wedges fulcrum on "downloading
// headers" and stalls the whole stack).
export async function bootstrapChain() {
  // Ensure EXACTLY ONE wallet is loaded, so bitcoin-cli (and Boltz) can route
  // wallet RPCs without an explicit -rpcwallet. The wrinkle: btcpay/Core images
  // differ — Core 30's image auto-creates the empty-named "" wallet on startup,
  // while Core 31 creates none and rejects empty names. So we first wait for the
  // image's own wallet, and only create our own (named) wallet if none appears —
  // creating a second one would make every wallet RPC ambiguous.
  const auto = await waitFor('Bitcoin Core wallet', () => loadedWalletCount() > 0, {
    attempts: 15,
    intervalMs: 2000,
  });
  if (!auto) {
    await waitForOrFail('Bitcoin Core wallet (created)', () => {
      bitcoinCli(['createwallet', WALLET], { capture: true });
      return loadedWalletCount() > 0;
    }, { attempts: 10, intervalMs: 2000 });
  }

  if (getBalance() >= 1) return;

  // 2. Get a spendable address (retry until the wallet yields one).
  let addr = '';
  await waitForOrFail('Bitcoin Core address', () => {
    addr = bitcoinCli(['getnewaddress'], { capture: true }).stdout.trim();
    return Boolean(addr);
  }, { attempts: 15, intervalMs: 1000 });

  // 3. Mine 101 blocks and confirm the chain actually advanced.
  log('Mining 101 blocks to fund the node wallet...');
  bitcoinCli(['generatetoaddress', '101', addr], { capture: true });
  await waitForOrFail('Bitcoin Core blocks', () => {
    const h = parseInt(bitcoinCli(['getblockcount'], { capture: true }).stdout, 10);
    return Number.isFinite(h) && h >= 101;
  }, { attempts: 15, intervalMs: 1000 });
}

// Send `amountBtc` to `address` from the node wallet, then mine one block so the
// funds confirm immediately (chopsticks' faucet used to auto-confirm too).
export function faucet(address, amountBtc) {
  const r = bitcoinCli(['sendtoaddress', address, String(amountBtc)], { capture: true });
  if (r.code !== 0) {
    warn(`faucet ${amountBtc} -> ${address} failed: ${r.stderr || r.stdout}`);
    return false;
  }
  mine(1);
  return true;
}
