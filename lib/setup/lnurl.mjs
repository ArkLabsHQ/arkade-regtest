// LNURL server bring-up (profile `lnurl`).
//
// The service needs three things no other tier provides, all assembled here so
// the compose file stays declarative:
//
//  1. The intent-solver's live signed registry card, written to LNURL_CARDS_FILE
//     and mounted read-only as the service's SOLVER_CARDS_FILE. Fetched from
//     the running solver (`card` prints this deployment's card), never
//     checked in: the discovery pubkey is stable only while INTENT_SOLVER_MNEMONIC
//     is, and the limits move with the solver's config. The file card keeps the
//     solver's identity, markets and signature and only adapts the relays to
//     the TLS-less dev relay (the card schema admits wss:// only; the stack's
//     strfry answers ws://) — both sides dial the same strfry either way.
//     When the card cannot be obtained the file is written as `[]` instead —
//     valid, zero candidates — so the relay flow still comes up and only
//     offline discovery stays dark.
//  2. The container itself, started explicitly (not in the app wave): the cards
//     file does not exist until step 1 runs.
//  3. A readiness gate on /readyz, which is 200 only once solver discovery
//     holds a lightning-receive candidate — one poll covering the cards file,
//     the market IDs and the offline trio (COVCLAIMD_URL + ARK_SERVER_URL).
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { env } from '../env.mjs';
import { fail, log, warn } from '../log.mjs';
import { waitForOrFail, fetchJson } from '../wait.mjs';
import { compose, ROOT } from '../compose.mjs';
import { containerName, docker } from '../proc.mjs';

// The solver CLI, same invocation the float funding uses.
const SOLVER_CLI = ['node', '--enable-source-maps', '--experimental-eventsource', 'packages/solver-app/dist/cli.js'];

// Compose resolves a relative bind source against the compose file's own
// directory (docker/), not the caller's cwd — mirror that here so the
// orchestrator writes exactly the file the mount will read.
function cardsHostPath() {
  const raw = env('LNURL_CARDS_FILE', './.lnurl-solver-cards.json');
  return isAbsolute(raw) ? raw : join(ROOT, 'docker', raw);
}

// The `card` command shares stdout with timestamped log lines, so parse the
// outer JSON object rather than the whole stream — and accept only a card that
// can actually yield a candidate (pubkey + markets + Nostr relays).
function extractCard(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const card = JSON.parse(stdout.slice(start, end + 1));
    if (typeof card?.discovery_pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(card.discovery_pubkey)) return null;
    if (!Array.isArray(card?.markets) || card.markets.length === 0) return null;
    const relays = card?.transports?.nostr?.relays;
    if (!Array.isArray(relays) || relays.length === 0) return null;
    return card;
  } catch {
    return null;
  }
}

function writeCardsFile(path, cards) {
  const body = JSON.stringify(cards, null, 2) + '\n';
  let changed = true;
  try {
    // A previous boot without the file lets Docker create a directory at the
    // mount point instead — remove it, or the write below fails with EISDIR
    // and every later boot bind-mounts a directory.
    if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
    changed = readFileSync(path, 'utf8') !== body;
  } catch {
    changed = true;
  }
  if (changed) writeFileSync(path, body);
  return changed;
}

export function clearLnurlCards() {
  rmSync(cardsHostPath(), { force: true });
}

export async function setupLnurl() {
  // The in-network relay both sides actually dial (the service's RELAY_URL).
  const relayUrl = env('INTENT_SOLVER_RELAY_URL', 'ws://strfry:7777');
  // The card command inherits the container's env, so it signs as the
  // deployment the solver is actually running — no key material here. Its one
  // lie is the relay scheme: the card schema admits wss:// only, while strfry
  // terminates no TLS, so emission runs with the scheme upgraded and the file
  // below carries the dialable ws:// value. The override is exec-scoped — the
  // service keeps its real RELAY_URL for a future relay-mode run.
  const emission = docker(
    ['exec', '-e', `RELAY_URL=${relayUrl.replace(/^ws:\/\//, 'wss://')}`, containerName('intent-solver'), ...SOLVER_CLI, 'card', 'regtest'],
    { capture: true },
  );
  const emitted = emission.code === 0 ? extractCard(emission.stdout) : null;
  // The relays are rewritten, not passed through: the emitted card names the
  // upgraded wss:// URL nothing serves. Identity, markets and signature ride
  // through untouched (clients validate the shape, never the signature).
  const card = emitted ? { ...emitted, transports: { nostr: { relays: [relayUrl] } } } : null;
  if (card) {
    log(`lnurl-server solver card: ${card.name} (${card.discovery_pubkey.slice(0, 12)}…, ${card.markets.length} market(s) via ${relayUrl})`);
  } else {
    warn(`lnurl-server cards skipped (${emission.code !== 0 ? (emission.stderr || emission.stdout || 'card command failed') : 'unparseable card output'}); relay flow only`);
  }
  const changed = writeCardsFile(cardsHostPath(), card ? [card] : []);

  log(`Starting lnurl-server overlay (${env('LNURL_IMAGE')})...`);
  // New card content only takes effect on container (re)creation — the service
  // reads the file once at boot — so recreate exactly when the file moved.
  const args = changed ? ['up', '-d', '--force-recreate', 'lnurl-server'] : ['up', '-d', 'lnurl-server'];
  if (compose(args, { profiles: ['lnurl'] }).code !== 0) fail('lnurl-server compose up failed');

  const port = env('LNURL_PORT', '9090');
  await waitForOrFail('lnurl-server /readyz', async () => {
    const { json } = await fetchJson(`http://localhost:${port}/readyz`);
    return json?.status === 'ready';
  }, { attempts: 45, intervalMs: 2000 });
  const { json } = await fetchJson(`http://localhost:${port}/readyz`);
  log(`lnurl-server up at http://localhost:${port} (${json?.components?.solverDiscovery?.detail || 'relay flow only'})`);
  // Serve mode answers swaps over HTTP and subscribes to nothing, while the
  // server's corridor client negotiates over Nostr only — discovery ready is
  // therefore necessary but not sufficient for a live offline quote. Said once
  // here rather than discovered from a timeout at 2am.
  log('lnurl-server note: live offline quotes need the solver Nostr ingress (relay mode); this stack runs serve mode');
}
