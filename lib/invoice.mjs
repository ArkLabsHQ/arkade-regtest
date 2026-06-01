// Lightning invoice helpers — ports of helpers/create-invoice.sh and
// helpers/pay-invoice.sh into the cross-platform CLI.
import { dockerExec } from './proc.mjs';
import { log, fail } from './log.mjs';

// The counterparty `lnd` keeps its data at /data/.lnd; boltz-lnd at /root/.lnd.
function lncliBase(container) {
  return container === 'lnd'
    ? ['lncli', '--network=regtest', '--lnddir=/data/.lnd']
    : ['lncli', '--network=regtest'];
}

function lncli(container, args) {
  const r = dockerExec(container, [...lncliBase(container), ...args], { capture: true });
  if (r.code !== 0) fail(`lncli ${args.join(' ')} on ${container} failed: ${r.stderr || r.stdout}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout;
  }
}

// Create a 100k-sat invoice on boltz-lnd (primary) or lnd (--secondary).
// Prints the bare payment request to stdout so it can be piped/captured.
export function createInvoice({ secondary = false } = {}) {
  const container = secondary ? 'lnd' : 'boltz-lnd';
  log(`Creating invoice on ${secondary ? 'secondary (lnd)' : 'primary (boltz-lnd)'} ...`);
  const { payment_request: invoice } = lncli(container, ['addinvoice', '--amt', '100000']);
  log('Invoice created');
  console.log(invoice);
  return invoice;
}

// Pay an invoice from whichever node is NOT its destination.
export function payInvoice(invoice) {
  if (!invoice) fail('usage: node regtest.mjs pay-invoice <invoice>');
  const dest = lncli('boltz-lnd', ['decodepayreq', invoice]).destination;
  const primary = lncli('boltz-lnd', ['getinfo']).identity_pubkey;
  const secondary = lncli('lnd', ['getinfo']).identity_pubkey;

  if (dest === primary) {
    log('Paying invoice from secondary (lnd) -> primary (boltz-lnd)...');
    lncli('lnd', ['payinvoice', '--force', invoice]);
  } else if (dest === secondary) {
    log('Paying invoice from primary (boltz-lnd) -> secondary (lnd)...');
    lncli('boltz-lnd', ['payinvoice', '--force', invoice]);
  } else {
    fail('Invoice destination matches neither boltz-lnd nor lnd');
  }
}
