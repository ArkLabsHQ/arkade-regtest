export const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? 'http://localhost:7070';
export const ESPLORA_URL = process.env.ESPLORA_URL ?? 'http://localhost:3000/api';
export const EMULATOR_URL = process.env.EMULATOR_URL ?? 'http://localhost:7073';
export const SOLVER_URL = process.env.SOLVER_URL ?? 'http://localhost:8787';
export const ADMIN_URL = process.env.ADMIN_URL ?? 'http://localhost:8788';
export const PRICEFEED_URL = process.env.PRICEFEED_URL ?? 'http://127.0.0.1:18088/price';
export const PRICEFEED_PORT = Number(process.env.PRICEFEED_PORT ?? 18088);

/** 1 asset unit per sat at baseDecimals=8 / quoteDecimals=0 (matches intent-solver e2e). */
export const FEED_PRICE = process.env.FEED_PRICE ?? '100000000';
export const FEE_BPS = Number(process.env.FEE_BPS ?? 50);
export const ASSET_TICKER = process.env.ASSET_TICKER ?? 'USDT';
export const ASSET_DECIMALS = Number(process.env.ASSET_DECIMALS ?? 0);
const big = (v, fallback) => BigInt(String(v ?? fallback).replace(/_/g, ''));

export const ASSET_SUPPLY = big(process.env.ASSET_SUPPLY, '1000000');

/** Offchain sats funded to each trader after boarding. */
export const TRADER_BTC_SATS = big(process.env.TRADER_BTC_SATS, '500000');
/** Asset units each trader receives at bootstrap. */
export const TRADER_ASSET_UNITS = big(process.env.TRADER_ASSET_UNITS, '100000');
/** Solver float in sats (needs room for carriers + fills). */
export const SOLVER_BTC_SATS = big(process.env.SOLVER_BTC_SATS, '5000000');
/** Solver asset inventory. */
export const SOLVER_ASSET_UNITS = big(process.env.SOLVER_ASSET_UNITS, '400000');

/** Dust carrier when an asset VTXO must move (SDK ASSET_CARRIER_SATS). */
export const ASSET_CARRIER_SATS = 330n;
