import { randomBytes } from 'node:crypto';
import { createOffer } from '@arkade-os/swap/protocol';
import { asset } from '@arkade-os/sdk';
import { ASSET_CARRIER_SATS, SOLVER_URL } from './config.mjs';

export function expectedPayoutExactIn(fromAmount, feeBps) {
  return fromAmount - (fromAmount * BigInt(feeBps) + 9_999n) / 10_000n;
}

export function pairFor(fromAssetId, toAssetId) {
  const from = fromAssetId ?? 'BTC';
  const to = toAssetId ?? 'BTC';
  return `arkade:${from}->arkade:${to}`;
}

export async function requestAssetQuote({
  pair,
  amount,
  amountSide = 'from',
  makerPkScript,
  makerPublicKey,
  solverUrl = SOLVER_URL,
}) {
  const rfqId = randomBytes(32).toString('hex');
  const body = {
    v: 1,
    type: 'rfq_request',
    rfq_id: rfqId,
    pair,
    amount_side: amountSide,
    amount: amount.toString(),
    profile: {
      maker_pk_script: makerPkScript,
      maker_public_key: makerPublicKey,
    },
  };
  const res = await fetch(`${solverUrl}/v1/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (payload?.type === 'rfq_refusal') {
    const err = new Error(`rfq_refusal ${payload.reason}: ${JSON.stringify(payload)}`);
    err.payload = payload;
    throw err;
  }
  if (payload?.type !== 'rfq_quote') {
    throw new Error(`unexpected quote reply HTTP ${res.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export async function statusFor(rfqId, solverUrl = SOLVER_URL) {
  const res = await fetch(`${solverUrl}/v1/rfq/${rfqId}`);
  if (res.status === 404) return null;
  return res.json();
}

/**
 * Fund the covenant both sides derive from the quote (RFQ atomic class).
 * Compare-only against the solver's offer_address / offer_pk_script.
 *
 * @param {'btc->asset' | 'asset->btc'} direction
 */
export async function fundQuotedOffer(wallet, quote, direction, assetId) {
  const wantAmount = BigInt(quote.to_amount);
  const fromAmount = BigInt(quote.from_amount);
  const params =
    direction === 'btc->asset'
      ? { wantAmount, wantAsset: asset.AssetId.fromString(assetId) }
      : { wantAmount, offerAsset: asset.AssetId.fromString(assetId) };

  const offer = await createOffer(wallet, params);
  if (offer.address !== quote.profile.offer_address) {
    throw new Error(
      `offer address mismatch: client=${offer.address} quote=${quote.profile.offer_address}`,
    );
  }

  const fundingTxid =
    direction === 'btc->asset'
      ? await wallet.send({
          address: offer.address,
          amount: Number(fromAmount),
          extensions: [offer.extension],
        })
      : await wallet.send({
          address: offer.address,
          amount: Number(ASSET_CARRIER_SATS),
          assets: [{ assetId, amount: fromAmount }],
          extensions: [offer.extension],
        });

  return { offer, fundingTxid };
}

export async function waitSettled(rfqId, { timeoutMs = 180_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await statusFor(rfqId);
    if (status?.state === 'settled') return status;
    if (status?.state === 'failed' || status?.state === 'refused') {
      throw new Error(`rfq ${rfqId} ended ${status.state}: ${JSON.stringify(status)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`rfq ${rfqId} not settled; last=${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
