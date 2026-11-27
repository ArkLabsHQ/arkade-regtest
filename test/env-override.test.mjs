import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('loadEnv throws when an explicit --env override path does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkade-regtest-env-'));
  try {
    writeFileSync(join(dir, '.env.defaults'), 'ARKD_PORT=7070\n');
    writeFileSync(join(dir, '.env'), 'ARKD_PORT=9999\n');

    const missing = join(dir, 'does-not-exist.env');
    assert.throws(
      () => loadEnv(dir, missing, { quiet: true }),
      (err) => err instanceof Error && err.message.includes(missing),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEnv applies explicit override without clobbering pre-set process.env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkade-regtest-env-'));
  const prevPort = process.env.TEST_ARKD_PORT;
  const prevPreset = process.env.TEST_PRESET_VAR;
  try {
    delete process.env.TEST_ARKD_PORT;
    process.env.TEST_PRESET_VAR = 'from-process';

    writeFileSync(join(dir, '.env.defaults'), 'TEST_ARKD_PORT=7070\nTEST_PRESET_VAR=from-defaults\n');
    writeFileSync(join(dir, '.env'), 'TEST_ARKD_PORT=8080\n');
    const explicit = join(dir, 'custom.env');
    writeFileSync(explicit, 'TEST_ARKD_PORT=27070\nTEST_PRESET_VAR=from-explicit\n');

    loadEnv(dir, explicit, { quiet: true });
    assert.equal(process.env.TEST_ARKD_PORT, '27070');
    assert.equal(process.env.TEST_PRESET_VAR, 'from-process');
  } finally {
    if (prevPort === undefined) delete process.env.TEST_ARKD_PORT;
    else process.env.TEST_ARKD_PORT = prevPort;
    if (prevPreset === undefined) delete process.env.TEST_PRESET_VAR;
    else process.env.TEST_PRESET_VAR = prevPreset;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits non-zero when --env points to a missing file', () => {
  const missing = join(root, 'nonexistent-override-for-test.env');
  const result = spawnSync(
    process.execPath,
    [join(root, 'regtest.mjs'), 'rpc', '--env', missing, 'getblockcount'],
    { encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Env override file not found/);
});
