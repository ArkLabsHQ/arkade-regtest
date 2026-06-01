// Shared lncli helpers used by both the Boltz setup and the invoice commands.
//
// The counterparty `lnd` keeps its data at /data/.lnd (HOME=/data + --lnddir),
// so lncli there needs --lnddir to find tls.cert/macaroons; `boltz-lnd` uses
// the default /root/.lnd path.
import { dockerExec } from './proc.mjs';

export function lncliBase(container) {
  return container === 'lnd'
    ? ['lncli', '--network=regtest', '--lnddir=/data/.lnd']
    : ['lncli', '--network=regtest'];
}

// Run an lncli command in a container. Returns { ok, json, raw, err }:
// ok=false on a non-zero exit; json is the parsed output when it is valid JSON,
// otherwise raw holds the plain stdout.
export function lncli(container, args) {
  const r = dockerExec(container, [...lncliBase(container), ...args], { capture: true });
  if (r.code !== 0) return { ok: false, json: null, err: r.stderr || r.stdout };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: true, json: null, raw: r.stdout };
  }
}
