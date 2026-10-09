#!/usr/bin/env bash
# Install @arkade-os/sdk and @arkade-os/swap from a local ts-sdk checkout.
#
# The Nostr smoke needs a build that is not on npm: negotiating an asset swap
# over the card's Nostr rendezvous is arkade-os/ts-sdk#886 + #919, and the
# published `@arkade-os/swap` still prices that route from the card's feed.
# `smoke-nostr.mjs` checks for the behaviour rather than a version and refuses
# to run without it, so a stale install fails loudly instead of quietly proving
# the wrong thing.
#
#   TS_SDK=/path/to/ts-sdk ./link-sdk.sh
#
# Packs rather than links: `pnpm pack` runs each package's `prepack` build and
# rewrites `workspace:*` to the real version, so what the smoke imports is the
# tarball a release would ship.
set -euo pipefail
SMOKE="$(cd "$(dirname "$0")" && pwd)"
TS_SDK="${TS_SDK:-$(cd "$SMOKE/../../../ts-sdk" 2>/dev/null && pwd || true)}"

if [[ -z "$TS_SDK" || ! -f "$TS_SDK/packages/swap/package.json" ]]; then
  echo "set TS_SDK to a ts-sdk checkout (looked for \$TS_SDK/packages/swap/package.json)" >&2
  exit 1
fi

OUT="$SMOKE/data/pkg"
rm -rf "$OUT"
mkdir -p "$OUT"

# Core first: the swap package's own build resolves it through dist/.
echo "building @arkade-os/sdk..."
pnpm -C "$TS_SDK/packages/ts-sdk" run build >/dev/null
echo "packing..."
pnpm -C "$TS_SDK/packages/ts-sdk" pack --pack-destination "$OUT" >/dev/null
pnpm -C "$TS_SDK/packages/swap" pack --pack-destination "$OUT" >/dev/null

SDK_TGZ="$(ls "$OUT"/arkade-os-sdk-*.tgz)"
SWAP_TGZ="$(ls "$OUT"/arkade-os-swap-*.tgz)"
echo "installing $(basename "$SDK_TGZ") + $(basename "$SWAP_TGZ")..."
# --no-save: package.json keeps naming the published versions the HTTP smoke
# runs against, and this is an override for one session.
npm --prefix "$SMOKE" install --no-save "$SDK_TGZ" "$SWAP_TGZ"

node --input-type=module -e "
  const { createSwapClient } = await import('@arkade-os/swap');
  const { nostrRfqTransport } = await import('@arkade-os/swap/nostr');
  if (typeof createSwapClient !== 'function') throw new Error('createSwapClient missing');
  if (typeof nostrRfqTransport !== 'function') throw new Error('nostrRfqTransport missing');
  console.log('linked local @arkade-os/swap (createSwapClient + /nostr resolve)');
"
