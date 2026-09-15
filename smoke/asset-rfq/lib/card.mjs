import { readFileSync } from 'node:fs';
import { MnemonicIdentity } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { SOLVER_ENV_PATH } from './paths.mjs';
import { ASSET_CARRIER_SATS, FEE_BPS, NOSTR_RELAY_URL, PRICEFEED_URL } from './config.mjs';

/** x-only key from the container's mnemonic — same seed `nostrCodecForWallet` uses. */
export function solverPubkeyFromEnv(path = SOLVER_ENV_PATH) {
  const env = readFileSync(path, 'utf8');
  const match = /^ARK_MNEMONIC=(.+)$/m.exec(env);
  if (!match) throw new Error(`${path} names no ARK_MNEMONIC — run: npm run bootstrap`);
  const identity = MnemonicIdentity.fromMnemonic(match[1].trim(), { isMainnet: false });
  return identity.xOnlyPublicKey().then((key) => hex.encode(key));
}

/**
 * Card for `discovery.snapshot`. Built here because `solver card` / `GET /api/card`
 * refuse relays that are not `wss://`, and strfry is `ws://`.
 *
 * No `fee_flat`: the registry field is quote-denominated and this market charges
 * the carrier on the BTC input. The solver's own builder refuses that too.
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
