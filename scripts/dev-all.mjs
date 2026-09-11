#!/usr/bin/env node
/**
 * Runs the relay server and the Vite dev server together with prefixed output.
 * `npm run dev:all` → `npm run server` + `npm run dev`. Ctrl+C (or either child exiting) stops both.
 * No dependencies beyond Node itself.
 */
import { spawn, spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const COLORS = { server: '\x1b[36m', dev: '\x1b[35m', reset: '\x1b[0m', dim: '\x1b[2m' };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const children = [];
let shuttingDown = false;

function prefixed(name, stream, out) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      writeLine(name, line, out);
    }
  });
  stream.on('end', () => { if (buf) writeLine(name, buf, out); });
}

function writeLine(name, line, out) {
  const tag = useColor ? `${COLORS[name]}[${name}]${COLORS.reset}` : `[${name}]`;
  out.write(`${tag} ${line}\n`);
}

function run(name, script) {
  // npm is `npm.cmd` on Windows and .cmd files must be spawned through a shell (Node ≥ 18.20 / 20.12 rule).
  // With a shell the whole command goes in one string (passing args separately trips DEP0190).
  const child = isWin
    ? spawn(`npm.cmd run ${script}`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    : spawn('npm', ['run', script], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  children.push(child);
  prefixed(name, child.stdout, process.stdout);
  prefixed(name, child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    writeLine(name, `${useColor ? COLORS.dim : ''}exited (${signal ?? code})${useColor ? COLORS.reset : ''}`, process.stdout);
    if (!shuttingDown) shutdown(code ?? 0);
  });
  child.on('error', (err) => {
    writeLine(name, `failed to start: ${err.message}`, process.stderr);
    if (!shuttingDown) shutdown(1);
  });
  return child;
}

function childEnv() {
  return { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? (useColor ? '1' : '0') };
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) {
    // The shell wrapper would otherwise leave node/vite running; taskkill /T takes the whole tree down.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\nstopping relay server and vite…\n');
  for (const c of children) killTree(c);
  const deadline = setTimeout(() => process.exit(code), 3000);
  deadline.unref();
  let remaining = children.filter((c) => c.exitCode === null && c.signalCode === null).length;
  if (remaining === 0) process.exit(code);
  for (const c of children) c.once('exit', () => { if (--remaining <= 0) process.exit(code); });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

writeLine('dev', 'starting relay server (npm run server) and vite (npm run dev)', process.stdout);
// E-4 (2026-09-11, 사용자 결정): this relay does NOT accept the dev credit reasons (`/credits` · smoke:* · e2e:* · shot) —
// `start-server.bat` runs this script for real LAN play. Only relays the smoke runners start themselves turn SCAV_DEV_ECONOMY on.
run('server', 'server');
run('dev', 'dev');
