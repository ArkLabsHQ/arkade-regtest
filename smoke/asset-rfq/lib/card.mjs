import { readFileSync } from 'node:fs';
import { MnemonicIdentity } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { SOLVER_ENV_PATH } from './paths.mjs';
import { ASSET_CARRIER_SATS, FEE_BPS, NOSTR_RELAY_URL, PRICEFEED_URL } from './config.mjs';

/**
 * The solver's x-only pubkey — what a client addresses an RFQ to, and what the
 * card must carry as `discovery_pubkey`.
 *
 * Derived from the same mnemonic the container boots with rather than scraped
 * out of its log, because that is the check worth having: `nostrCodecForWallet`
 * refuses to start when the key it derives is not the one the service reports,
 * so a key derived here that the relay ingress does not answer on means the
 * container is running a different seed than `data/solver.env` names.
 */
export function solverPubkeyFromEnv(path = SOLVER_ENV_PATH) {
  const env = readFileSync(path, 'utf8');
  const match = /^ARK_MNEMONIC=(.+)$/m.exec(env);
  if (!match) throw new Error(`${path} names no ARK_MNEMONIC — run: npm run bootstrap`);
  const identity = MnemonicIdentity.fromMnemonic(match[1].trim(), { isMainnet: false });
  return identity.xOnlyPublicKey().then((key) => hex.encode(key));
}

/**
 * The registry card for this deployment, in the shape the discovery client
 * hands the v2 swap client.
 *
 * Built here instead of read off `solver card` / `GET /api/card` for one
 * reason: both refuse a relay that is not `wss://`, and a local strfry is
 * `ws://`. Everything else is what the solver would have published — the
 * CAIP-19 leg ids, the feed pointer, `price_decimals` as
 * `baseDecimals - quoteDecimals`, and the console's own `fee_bps` and bounds.
 *
 * `price_feed` is the HOST url, not the container gateway one the solver reads:
 * the client runs on the host, and the card's feed is what IT fetches to price
 * the fee against. Both point at the same process.
 *
 * `sellBaseFeeFlat` is deliberately NOT published as `fee_flat`. The registry
 * schema denominates that field in quote-asset units and this deployment
 * charges it on the BTC input (the dust carrier the fill spends), so there is
 * no honest field for it — the solver's own card builder refuses the market for
 * exactly this. The consequence is visible and correct: the carrier lands in
 * `quote.fee`, which measures the whole concession against the card's price
 * rather than only the part the card can name.
 */
export function buildSolverCard({
  assetId,
  ticker,
  decimals,
  discoveryPubkey,
  relays = [NOSTR_RELAY_URL],
  network = 'regtest',
  feedUrl = PRICEFEED_URL,
  feeBps = FEE_BPS,
  solver = 'regtest-asset-rfq',
  min = '1',
  max = '100000000',
}) {
  return {
    solver,
    source: `local:${solver}`,
    sourceType: 'local',
    discovery_pubkey: discoveryPubkey,
    transports: { nostr: { relays } },
    base_asset: {
      id: `arkade:${network}/slip44:0`,
      name: 'Bitcoin',
      ticker: 'BTC',
      decimals: 8,
    },
    quote_asset: {
      id: `arkade:${network}/asset:${assetId}`,
      name: `Arkade asset ${ticker}`,
      ticker,
      decimals,
    },
    price_feed: feedUrl,
    price_feed_schema: { type: 'json', price_path: '/price' },
    // Feed is quote-display per base-display; the card publishes atomic per
    // atomic, so the exponent is the difference in precision.
    price_decimals: 8 - decimals,
    fee_bps: feeBps,
    min_base_amount: min,
    max_base_amount: max,
    min_quote_amount: min,
    max_quote_amount: max,
  };
}

/** The public asset ids the v2 client routes by, for this card's two legs. */
export function publicLegIds(assetId, network = 'regtest') {
  return {
    btc: `arkade:${network}/slip44:0`,
    asset: `arkade:${network}/asset:${assetId}`,
  };
}

/** The dust carrier an asset deposit rides, restated for the harness's reserves. */
export const CARRIER_SATS = ASSET_CARRIER_SATS;
