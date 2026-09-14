import WebSocket from 'ws';
import { NOSTR_RELAY_URL } from './config.mjs';

/**
 * The kind a directed RFQ negotiation rides: NIP-01's ephemeral range, so the
 * relay forwards it to live subscribers and stores nothing.
 *
 * Restated here rather than imported from `@arkade-os/swap`. This watcher is
 * the smoke's independent witness — if it read the constant off the code under
 * test, a client that moved to another kind would keep passing while talking to
 * nobody.
 */
export const RFQ_DIRECTED_KIND = 24859;

/**
 * A live subscription to the relay's directed-RFQ traffic.
 *
 * Ephemeral means the assertion has to be watching BEFORE the swap runs: there
 * is nothing to query afterwards, which is also what makes the evidence real —
 * every event counted here was forwarded by the relay while the negotiation was
 * happening.
 *
 * Content is NIP-44 ciphertext and stays unread. Direction is all this needs
 * and all it can have: an author and a `p` tag are public, so a request to the
 * solver's key and a reply from it are distinguishable without the conversation
 * key, and a watcher that could read the payload would be proving something
 * about its own keys rather than about the wire.
 */
export async function watchRfqTraffic({ url = NOSTR_RELAY_URL, kind = RFQ_DIRECTED_KIND } = {}) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const fail = (err) =>
      reject(new Error(`relay ${url} unreachable: ${err?.message ?? err}`));
    socket.once('open', resolve);
    socket.once('error', fail);
  });

  const events = [];
  const subId = `smoke-${Math.random().toString(16).slice(2, 10)}`;
  socket.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (frame[0] !== 'EVENT' || frame[1] !== subId) return;
    const event = frame[2];
    events.push({
      id: event.id,
      kind: event.kind,
      author: event.pubkey,
      recipients: (event.tags ?? []).filter((t) => t[0] === 'p').map((t) => t[1]),
      createdAt: event.created_at,
      bytes: (event.content ?? '').length,
    });
  });
  socket.send(JSON.stringify(['REQ', subId, { kinds: [kind] }]));

  return {
    kind,
    url,
    /** A cursor into the event log, for scoping a window to one swap. */
    mark: () => events.length,
    /** The negotiation seen since `mark`, split by who it was addressed to. */
    since(mark, solverPubkey) {
      const window = events.slice(mark);
      return {
        all: window,
        toSolver: window.filter((e) => e.recipients.includes(solverPubkey)),
        fromSolver: window.filter((e) => e.author === solverPubkey),
      };
    },
    async close() {
      try {
        socket.send(JSON.stringify(['CLOSE', subId]));
      } catch {}
      socket.close();
    },
  };
}

/**
 * Give the relay a moment to forward what is already in flight.
 *
 * `accept()` returns when the record is durable, which can be before the
 * solver's reply event has come back around to this second subscription.
 */
export const settleRelay = (ms = 500) => new Promise((r) => setTimeout(r, ms));
