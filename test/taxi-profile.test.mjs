import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILES, resolveProfiles } from '../lib/profiles.mjs';
import { ALL_PROFILES } from '../lib/compose.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Taxi is opt-in, resolves its dependencies and participates in cleanup', () => {
  assert.equal(DEFAULT_PROFILES.includes('taxi'), false);
  assert.deepEqual(resolveProfiles(['taxi']), ['taxi', 'ark', 'base', 'emulator']);
  assert.ok(ALL_PROFILES.includes('taxi'));
});

test('rendered Taxi stack persists state, isolates listeners and covers recovery headroom', () => {
  const output = execFileSync('docker', [
    'compose', '--env-file', join(root, '.env.defaults'), '--env-file', join(root, '.env.taxi'),
    '-f', join(root, 'docker', 'compose.base.yml'), '-f', join(root, 'docker', 'compose.ark.yml'),
    '--profile', 'base', '--profile', 'ark', '--profile', 'emulator', '--profile', 'taxi',
    'config', '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, REGTEST_PROJECT: 'taxi-profile-test', REGTEST_CONTAINER_PREFIX: 'taxi-profile-test-', TAXI_HTTP_PORT: '28080', TAXI_ADMIN_PORT: '28081' } });
  const { services, volumes } = JSON.parse(output);
  const taxi = services.taxi;
  assert.equal(taxi.container_name, 'taxi-profile-test-taxi');
  assert.deepEqual(taxi.ports.map(({ host_ip, published }) => [host_ip, published]), [['127.0.0.1', '28080'], ['127.0.0.1', '28081']]);
  assert.ok(taxi.volumes.some(({ source, target }) => source === 'taxi_datadir' && target === '/data'));
  assert.ok(volumes.taxi_datadir);
  assert.equal(taxi.environment.TAXI_ESPLORA_URL, 'http://mempool_web/api');
  assert.equal(taxi.environment.TAXI_PUBLIC_ARKD_URL, 'http://localhost:7070');
  assert.equal(taxi.environment.TAXI_PUBLIC_EMULATOR_URL, 'http://localhost:7073');
  assert.ok(Number(services.arkd.environment.ARKD_VTXO_TREE_EXPIRY) >= Number(taxi.environment.TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS) + 43200);
  assert.ok(Number(taxi.environment.TAXI_MIN_EXPIRY_HEADROOM_SECONDS) > Number(taxi.environment.TAXI_RECOVERY_BROADCAST_SECONDS));
});
