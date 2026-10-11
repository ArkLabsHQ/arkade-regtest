import { env } from '../env.mjs';
import { log, warn, fail } from '../log.mjs';
import { composeUp } from '../compose.mjs';
import { dockerExec } from '../proc.mjs';
import { fetchJson, httpOk, waitForOrFail } from '../wait.mjs';

export async function setupTaxi() {
  const publicUrl = `http://localhost:${env('TAXI_HTTP_PORT', '8080')}`;
  const adminUrl = `http://localhost:${env('TAXI_ADMIN_PORT', '8081')}/admin/api`;
  const up = composeUp(['taxi'], { profiles: ['taxi'] });
  if (up.code !== 0) fail('taxi compose up failed');
  await waitForOrFail('Taxi /v1/info', () => httpOk(`${publicUrl}/v1/info`));
  const read = async (path) => {
    const result = await fetchJson(`${adminUrl}/${path}`);
    if (!result.ok || !result.json) fail(`Taxi ${path} failed (${result.status}): ${JSON.stringify(result.json || result.text)}`);
    return result.json;
  };
  const policy = await read('policy');
  const { history } = await read('policy/history?limit=1');
  if (!Array.isArray(history)) fail('Taxi policy history is unavailable');
  const initial = history.length === 0 && policy.paused && policy.maxOutstandingSats === '0' && policy.assetRules.length === 0;
  if (initial) {
    const float = BigInt(env('TAXI_FLOAT_SATS', '500000'));
    const { ok, json: info } = await fetchJson(`${publicUrl}/v1/info`);
    if (!ok || !/^[0-9a-f]{64}$/.test(info?.operatorKey ?? '') || !/^[1-9]\d*$/.test(info?.dust ?? '')) fail('Taxi funding parameters are unavailable');
    const coinsUrl = `http://localhost:${env('ARKD_PORT', '7070')}/v1/indexer/vtxos?scripts=5120${info.operatorKey}&spendableOnly=true`;
    const funding = await read('funding');
    if (!/^\d+$/.test(funding.usableSats ?? '') || !/^\d+$/.test(funding.reservedSats ?? '') || !funding.arkAddress) fail('Taxi funding inventory is unavailable');
    const missing = float - BigInt(funding.usableSats) - BigInt(funding.reservedSats);
    if (missing > 0n) {
      log(`Funding Taxi with ${missing} sats at ${funding.arkAddress}...`);
      const sent = dockerExec('arkd', ['ark', 'send', '--to', funding.arkAddress, '--amount', missing.toString(), '--password', env('ARKD_PASSWORD', 'secret')], { capture: true });
      if (sent.code !== 0) fail(`Taxi funding failed: ${sent.stderr || sent.stdout}`);
    }
    await waitForOrFail('Taxi float', async () => {
      const indexed = await fetchJson(coinsUrl);
      return indexed.ok && Array.isArray(indexed.json?.vtxos) && indexed.json.vtxos.reduce((sum, coin) => sum + BigInt(coin.amount), 0n) >= float;
    });
    const response = await fetchJson(`${adminUrl}/policy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paused: false,
        maxOutstandingSats: float.toString(),
        maxPerPaymentTopupSats: '100000',
        maxConcurrentAdvances: 20,
        assetRules: [null, '*'].map((assetId) => ({
          assetId, enabled: true,
          fares: [{ id: 'sats', currency: { kind: 'sats' }, pricing: { kind: 'flat', units: '0' } }],
          claim: 'either', maxTopupSats: null,
        })),
      }),
    });
    if (!response.ok) fail(`Taxi policy bootstrap failed (${response.status}): ${JSON.stringify(response.json || response.text)}`);
    const rescan = await fetchJson(`${adminUrl}/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!rescan.ok) fail(`Taxi rescan failed (${rescan.status}): ${JSON.stringify(rescan.json || rescan.text)}`);
    if (float >= BigInt(info.dust) * 2n) {
      await waitForOrFail('Taxi inventory split', async () => (await fetchJson(coinsUrl)).json?.vtxos?.length >= 2, { attempts: 60, intervalMs: 2000 });
    }
  }
  if (!initial && policy.paused) {
    await waitForOrFail('Taxi paused wallet sync', async () => {
      const rescan = await fetchJson(`${adminUrl}/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return rescan.ok && (await fetchJson(`${publicUrl}/health`)).json?.runtime?.walletSynced === true;
    });
    warn('Taxi retained its paused policy; use the admin API to resume it');
  } else {
    await waitForOrFail('Taxi /ready', () => httpOk(`${publicUrl}/ready`));
  }
  log(`Taxi up at ${publicUrl} (admin http://localhost:${env('TAXI_ADMIN_PORT', '8081')})`);
}
