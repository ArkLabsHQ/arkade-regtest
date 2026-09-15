import { EventSource } from 'eventsource';
import {
  Wallet,
  MnemonicIdentity,
  EsploraProvider,
  RestArkProvider,
  RestIndexerProvider,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  ArkAddress,
} from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { ARK_SERVER_URL, ESPLORA_URL } from './config.mjs';

globalThis.EventSource ??= EventSource;

export async function openWallet(mnemonic, label = 'wallet') {
  // SDK 0.5 no longer reads `arkServerUrl` on Wallet.create — pass providers.
  const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: false });
  const arkProvider = new RestArkProvider(ARK_SERVER_URL);
  const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);
  const wallet = await Wallet.create({
    identity,
    arkProvider,
    indexerProvider,
    onchainProvider: new EsploraProvider(ESPLORA_URL),
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    // Smoke stack may advertise a seconds-mode checkpoint delay below the
    // SDK's default floor when operators tune ARKD_*_EXIT_DELAY; accept the
    // server's value rather than refusing Wallet.create.
    minCheckpointExitDelaySeconds: 512n,
    settlementConfig: false,
  });
  const address = await wallet.getAddress();
  if (!address.startsWith('tark1')) {
    throw new Error(`[${label}] expected regtest tark1 address, got ${address}`);
  }
  const pkScript = hex.encode(ArkAddress.decode(address).pkScript);
  const publicKey = hex.encode(await identity.xOnlyPublicKey());
  console.log(`[${label}] address ${address}`);
  return { wallet, identity, address, pkScript, publicKey, label };
}

export function assetBalance(balance, assetId) {
  const held = balance.availableAssets ?? balance.assets ?? [];
  const found = held.find((a) => a.assetId === assetId);
  return found ? BigInt(found.amount) : 0n;
}

export function availableSats(balance) {
  return BigInt(balance.available ?? 0);
}

export async function waitBalance(wallet, pred, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const b = await wallet.getBalance().catch(() => null);
    if (b && pred(b)) return b;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function settleBoarding(wallet, label) {
  const { mine } = await import('./regtest.mjs');
  for (let i = 0; i < 40; i++) {
    const boardingUtxos = await wallet.getBoardingUtxos().catch(() => []);
    const b = await wallet.getBalance();
    const boardingTotal = boardingUtxos.reduce((sum, u) => sum + BigInt(u.amount ?? u.value ?? 0), 0n);
    if (boardingTotal <= 0n && availableSats(b) > 0n) return b;
    if (boardingTotal > 0n || boardingUtxos.length > 0) {
      console.log(`[${label}] settling ${boardingUtxos.length} boarding utxo(s), ~${boardingTotal} sats...`);
      try {
        await wallet.settle();
      } catch (err) {
        console.log(`[${label}] settle attempt: ${err.message ?? err}`);
      }
      // Commitment txs need a block when automine/miner are off.
      try {
        mine(1);
      } catch {}
      const after = await wallet.getBalance();
      if (availableSats(after) > 0n && boardingTotal <= 0n) return after;
      const stillBoarding = await wallet.getBoardingUtxos().catch(() => []);
      if (stillBoarding.length === 0 && availableSats(after) > 0n) return after;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`[${label}] boarding never settled`);
}
