import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('rpc stdout contains only the bitcoin-cli response when an override is loaded', () => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'regtest.mjs'), 'rpc', 'getblockcount', '--env', join(root, '.env.defaults')],
    {
      encoding: 'utf8',
      env: { ...process.env, REGTEST_CONTAINER_PREFIX: `no-such-test-${process.pid}-` },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, '');
});
