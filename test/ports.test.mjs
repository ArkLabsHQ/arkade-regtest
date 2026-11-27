import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ephemeralHostPorts,
  mergeReservedPorts,
  parsePortRange,
  shouldReservePorts,
} from '../lib/ports.mjs';

const range = { low: 32768, high: 60999 };

test('parses the kernel ephemeral port range', () => {
  assert.deepEqual(parsePortRange('32768\t60999\n'), range);
  assert.equal(parsePortRange(''), null);
});

test('picks only the host ports inside the ephemeral range', () => {
  const vars = {
    NBXPLORER_PORT: '32838',
    POSTGRES_PORT: '39372',
    FULCRUM_TCP_PORT: '50001',
    FULCRUM_WS_PORT: '50003',
    ARKD_PORT: '7070',
    BITCOIN_RPC_PORT: '18443',
    OTHER_NBXPLORER_PORT: '32838',
    ARKD_IMAGE: '50001',
    EMPTY_PORT: '',
  };

  assert.deepEqual(ephemeralHostPorts(vars, range), [32838, 39372, 50001, 50003]);
});

test('appends to the ports already reserved', () => {
  assert.equal(mergeReservedPorts('\n', [32838, 39372]), '32838,39372');
  assert.equal(mergeReservedPorts('8080,9000-9010\n', [32838]), '8080,9000-9010,32838');
});

test('reserves in Linux CI unless turned off', () => {
  assert.equal(shouldReservePorts({ CI: 'true' }, 'linux'), true);
  assert.equal(shouldReservePorts({}, 'linux'), false);
  assert.equal(shouldReservePorts({ REGTEST_RESERVE_PORTS: '1' }, 'linux'), true);
  assert.equal(shouldReservePorts({ CI: 'true', REGTEST_RESERVE_PORTS: '0' }, 'linux'), false);
  assert.equal(shouldReservePorts({ CI: 'true' }, 'darwin'), false);
});
