import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILES, resolveProfiles } from '../lib/profiles.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Taxi is opt-in and resolves its dependencies', () => {
  assert.equal(DEFAULT_PROFILES.includes('taxi'), false);
  assert.deepEqual(resolveProfiles(['taxi']), ['taxi', 'ark', 'base', 'emulator']);
});

test('rendered Taxi stack isolates listeners and covers renewal headroom', () => {
  const output = execFileSync('docker', [
    'compose', '--env-file', join(root, '.env.defaults'), '--env-file', join(root, '.env.taxi'),
    '-f', join(root, 'docker', 'compose.base.yml'), '-f', join(root, 'docker', 'compose.ark.yml'),
    '--profile', 'base', '--profile', 'ark', '--profile', 'emulator', '--profile', 'taxi',
    'config', '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, TAXI_HTTP_PORT: '28080', TAXI_ADMIN_PORT: '28081' } });
  const { services } = JSON.parse(output);
  const taxi = services.taxi;
  assert.deepEqual(taxi.ports.map(({ host_ip, published }) => [host_ip, published]), [['127.0.0.1', '28080'], ['127.0.0.1', '28081']]);
  assert.ok(Number(services.arkd.environment.ARKD_VTXO_TREE_EXPIRY) >= Number(taxi.environment.TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS) + 43200);
});
