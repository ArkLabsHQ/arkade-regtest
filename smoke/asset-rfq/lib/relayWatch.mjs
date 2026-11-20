import WebSocket from 'ws';
import { NOSTR_RELAY_URL } from './config.mjs';

/** Kind 24859, restated so a client that moved kinds fails this watcher. */
export const RFQ_DIRECTED_KIND = 24859;

/** Subscribe before the swap: ephemeral events are not queryable after. */
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

export const settleRelay = (ms = 500) => new Promise((r) => setTimeout(r, ms));
