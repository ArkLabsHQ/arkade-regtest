import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_PROFILES } from '../lib/compose.mjs';
import { DEFAULT_PROFILES, resolveProfiles } from '../lib/profiles.mjs';

test('the executor needs ark and the emulator, and its old delegatee name still brings it up', () => {
  assert.deepEqual(resolveProfiles(['executor']).sort(), ['ark', 'base', 'emulator', 'executor']);
  assert.ok(resolveProfiles(['delegatee']).includes('executor'));
  assert.ok(DEFAULT_PROFILES.includes('executor'));
  assert.ok(ALL_PROFILES.includes('executor'));
});
