// Keep the stack's host ports out of the kernel's ephemeral pool.
//
// Several default host ports (NBXplorer 32838, Postgres 39372, Fulcrum
// 50001/50003) sit inside Linux's ephemeral range (32768–60999 by default),
// which the kernel draws on for the local end of outbound connections. When an
// outbound socket on the host (an image pull, an npm fetch) happens to hold one
// of them as `docker compose up` publishes it, the bind fails with
// "address already in use". Adding the ports to `ip_local_reserved_ports` stops
// the kernel handing them out; an explicit bind to a reserved port still works.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { log, warn } from './log.mjs';

const PORT_RANGE = '/proc/sys/net/ipv4/ip_local_port_range';
const RESERVED_PORTS = '/proc/sys/net/ipv4/ip_local_reserved_ports';

// Parse `ip_local_port_range` ("32768\t60999").
export function parsePortRange(text) {
  const [low, high] = text.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(low) || !Number.isInteger(high)) return null;
  return { low, high };
}

// The configured host ports (`*_PORT` vars) the kernel could hand out as
// ephemeral ports, sorted and deduplicated.
export function ephemeralHostPorts(vars, range) {
  const ports = new Set();
  for (const [key, value] of Object.entries(vars)) {
    if (!key.endsWith('_PORT')) continue;
    const port = Number(value);
    if (Number.isInteger(port) && port >= range.low && port <= range.high) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

// Append `ports` to an existing `ip_local_reserved_ports` value (a comma list
// of ports and ranges), since writing the sysctl replaces it.
export function mergeReservedPorts(existing, ports) {
  return [existing.trim(), ...ports].filter(Boolean).join(',');
}

// Whether to reserve: on by default in CI on Linux, where the runner is
// throwaway and sudo needs no password. REGTEST_RESERVE_PORTS=1 forces it,
// =0 turns it off.
export function shouldReservePorts(vars, platform) {
  if (platform !== 'linux') return false;
  if (vars.REGTEST_RESERVE_PORTS === '0') return false;
  return vars.REGTEST_RESERVE_PORTS === '1' || vars.CI === 'true';
}

// Best effort: a failure only warns, since the stack usually starts anyway.
export function reserveHostPorts(vars = process.env, platform = process.platform) {
  if (!shouldReservePorts(vars, platform)) return;
  if (!existsSync(PORT_RANGE) || !existsSync(RESERVED_PORTS)) return;

  const range = parsePortRange(readFileSync(PORT_RANGE, 'utf8'));
  if (!range) return;
  const ports = ephemeralHostPorts(vars, range);
  if (ports.length === 0) return;

  const value = mergeReservedPorts(readFileSync(RESERVED_PORTS, 'utf8'), ports);
  const sysctl = ['sysctl', '-w', `net.ipv4.ip_local_reserved_ports=${value}`];
  const [cmd, args] = process.getuid?.() === 0 ? [sysctl[0], sysctl.slice(1)] : ['sudo', ['-n', ...sysctl]];
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.status === 0) {
    log(`Reserved host ports ${ports.join(', ')} outside the ephemeral pool`);
  } else {
    warn(`Could not reserve host ports ${ports.join(', ')}: ${(res.stderr || res.error?.message || '').trim()}`);
  }
}
