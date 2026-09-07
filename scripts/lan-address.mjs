#!/usr/bin/env node
/**
 * Prints the LAN IPv4 address other machines should use to reach this one, for `start-server.bat` and for filling in
 * `electron/default-relay.txt`. `--all` lists every candidate with its adapter, `--url` prints the relay ws:// line.
 *
 * A dev box usually has several IPv4 addresses (Hyper-V / WSL / VPN / VirtualBox switches), and `ipconfig` order is not
 * a useful ranking, so virtual adapters are demoted by name and real private ranges are preferred.
 */
import { networkInterfaces } from 'node:os';
import { NET_DEFAULT_PORT, NET_WS_PATH } from '../src/shared/net.ts';

const VIRTUAL = /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Loopback|TAP|Tailscale|ZeroTier|Bluetooth|Npcap/i;

/** Higher is better. Real adapter first, then the ranges a home / office LAN actually hands out. */
function score(name, address) {
  let s = VIRTUAL.test(name) ? 0 : 100;
  if (address.startsWith('192.168.')) s += 30;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 20;
  else if (address.startsWith('10.')) s += 10;
  else if (address.startsWith('169.254.')) s -= 50;          // APIPA: no DHCP answered
  else if (address.startsWith('100.')) s += 5;               // CGNAT range, also Tailscale
  return s;
}

const candidates = Object.entries(networkInterfaces())
  .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
  .filter((a) => a.family === 'IPv4' && !a.internal)
  .map((a) => ({ name: a.name, address: a.address, score: score(a.name, a.address) }))
  .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));

const args = process.argv.slice(2);
if (args.includes('--all')) {
  if (!candidates.length) console.log('(no LAN address)');
  for (const c of candidates) console.log(`${c.address.padEnd(16)} ${c.name}`);
  process.exit(0);
}

const best = candidates[0]?.address;
if (!best) process.exit(1);
console.log(args.includes('--url') ? `ws://${best}:${NET_DEFAULT_PORT}${NET_WS_PATH}` : best);
