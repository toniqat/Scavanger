#!/usr/bin/env node
/**
 * Verification runner — the one command to run after a change.
 *
 *   node scripts/verify.mjs                      # --changed: smokes for the folders touched in the working tree
 *   node scripts/verify.mjs --all                # everything (typecheck, build, selftest, 8 smokes, e2e) — before a merge
 *   node scripts/verify.mjs --folders weapons,ui # smokes mapped to those feature folders
 *   node scripts/verify.mjs --only smoke-weapons,e2e-mp
 *   node scripts/verify.mjs --rerun-failed       # only what failed in the previous run (scripts/logs/last-run.json)
 *   node scripts/verify.mjs --list               # folder → smoke map
 *
 * Options: --jobs N (parallel Chrome instances, default 4; use 1–2 with SMOKE_GL=swiftshader, which is CPU-bound) · --serial · --base <git ref> (diff base for --changed,
 *          default = working tree vs HEAD, falling back to HEAD~1) · --build · --no-typecheck · --no-e2e ·
 *          --keep-relay (do not restart a relay already listening on 8787) · --url http://host:port/ · --timeout <min>
 *
 * What it does:
 *   1. typecheck (client + server) and net:selftest in parallel — seconds.
 *   2. Starts vite (5273) and the relay (8787) if they are not up. When e2e-mp is in the set the relay is always
 *      restarted first: public lobbies left by an interrupted run live for the 5-min grace and hijack quick match.
 *   3. Runs the selected smoke scripts concurrently (each owns its own headless Chrome on the real GPU via ANGLE D3D11,
 *      10–50 s each; lanes start 8 s apart so vite warm-up and Chrome launches never coincide). Output goes to
 *      scripts/logs/<name>.log; only the summary and the FAIL lines are printed. SMOKE_GL=swiftshader (no GPU / CI) is
 *      ~10× slower and CPU-bound: measured 2026-09-06, one script ≈ 140 s alone and 2 lanes gained nothing (31 min total).
 *   4. e2e-mp runs alone at the end (two browsers, 15 s waits — sensitive to CPU contention).
 *   5. Writes scripts/logs/last-run.json and prints a one-line result string ready to paste into docs/VERIFICATION.md.
 *   Servers started here are stopped on exit; servers found running are left alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = resolve(ROOT, 'scripts/logs');
const LAST_RUN = resolve(LOG_DIR, 'last-run.json');
const isWin = process.platform === 'win32';

// ─── Job catalogue ─────────────────────────────────────────────────────────────────────────────────────────────
// `folders` = feature folders (src/<name>, or `server`) whose changes make this script relevant.
// Keep this in sync with the "Verification" section of CLAUDE.md when a smoke is added.
const SMOKES = {
  'smoke-weapons':      { file: 'scripts/smoke-weapons.mjs',      folders: ['weapons', 'items', 'inventory', 'hub', 'pickups', 'audio'] },
  'smoke-phase2':       { file: 'scripts/smoke-phase2.mjs',       folders: ['player', 'weapons', 'inventory', 'game', 'ui'] },
  'smoke-quickslots':   { file: 'scripts/smoke-quickslots.mjs',   folders: ['inventory', 'ui', 'weapons'] },
  'smoke-phase3':       { file: 'scripts/smoke-phase3.mjs',       folders: ['stratagems', 'world', 'ui', 'weapons'] },
  'smoke-stratagems':   { file: 'scripts/smoke-stratagems.mjs',   folders: ['stratagems', 'world'] },
  'smoke-phase4':       { file: 'scripts/smoke-phase4.mjs',       folders: ['enemies', 'items', 'world', 'inventory', 'weapons', 'player'] },
  'smoke-tactical':     { file: 'scripts/smoke-tactical.mjs',     folders: ['implants', 'gadgets', 'progression', 'player', 'world', 'enemies', 'inventory', 'items', 'weapons', 'audio'] },
  'smoke-controls-hub': { file: 'scripts/smoke-controls-hub.mjs', folders: ['ui', 'hub', 'inventory', 'implants', 'progression', 'player'] },
  'smoke-ship-rooms':   { file: 'scripts/smoke-ship-rooms.mjs',   folders: ['hub', 'housing'] },
  'smoke-inventory-p6': { file: 'scripts/smoke-inventory-p6.mjs', folders: ['inventory', 'housing', 'items'] },
  'smoke-loadout':      { file: 'scripts/smoke-loadout.mjs',      folders: ['inventory'] },
  'smoke-housing':      { file: 'scripts/smoke-housing.mjs',      folders: ['housing', 'hub', 'inventory', 'progression'] },
  'smoke-console':      { file: 'scripts/smoke-console.mjs',      folders: ['console', 'progression', 'inventory', 'player', 'hub'] },
  'smoke-progression':  { file: 'scripts/smoke-progression.mjs',  folders: ['progression'] },
  'smoke-ui-p6':        { file: 'scripts/smoke-ui-p6.mjs',        folders: ['ui'] },
  'smoke-ui-p5':        { file: 'scripts/smoke-ui-p5.mjs',        folders: ['ui', 'meta', 'game'] },
  'smoke-uniques':      { file: 'scripts/smoke-uniques.mjs',      folders: ['weapons', 'items', 'enemies', 'player', 'ui'] },
  'smoke-meta':         { file: 'scripts/smoke-meta.mjs',         folders: ['meta', 'inventory', 'hub', 'ui', 'game'] },
  'e2e-mp':             { file: 'scripts/e2e-multiplayer.mjs',    folders: ['net', 'server', 'game', 'extraction', 'hub', 'pickups', 'player', 'enemies'], exclusive: true, freshRelay: true },
};
// Anything under these paths touches the contract / bootstrap → run everything.
const GLOBAL_PATHS = [/^src\/shared\//, /^src\/core\//, /^src\/main\.ts$/, /^index\.html$/, /^vite\.config/, /^package\.json$/, /^tsconfig/];

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = {
  all: has('--all'), list: has('--list'), rerunFailed: has('--rerun-failed'),
  folders: val('--folders', '').split(',').filter(Boolean),
  only: val('--only', '').split(',').filter(Boolean),
  base: val('--base', null),
  jobs: has('--serial') ? 1 : Math.max(1, Number(val('--jobs', 4)) || 4),
  build: has('--build') || has('--all'),
  typecheck: !has('--no-typecheck'),
  e2e: !has('--no-e2e'),
  keepRelay: has('--keep-relay'),
  url: val('--url', 'http://localhost:5273/'),
  timeoutMs: (Number(val('--timeout', 15)) || 15) * 60_000,
};

if (opts.list) {
  const byFolder = {};
  for (const [name, j] of Object.entries(SMOKES)) for (const f of j.folders) (byFolder[f] ??= []).push(name);
  console.log('folder → smoke scripts');
  for (const f of Object.keys(byFolder).sort()) console.log(`  ${f.padEnd(12)} ${byFolder[f].join(', ')}`);
  console.log(`  ${'(global)'.padEnd(12)} src/shared, src/core, main.ts, package.json → all`);
  process.exit(0);
}

// ─── Selection ─────────────────────────────────────────────────────────────────────────────────────────────────
function git(args) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''; }
function changedFiles() {
  if (opts.base) return git(['diff', '--name-only', opts.base]).split('\n').filter(Boolean);
  const status = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim()).map((p) => p.includes(' -> ') ? p.split(' -> ')[1] : p);
  if (status.length) return status;
  return git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
}
function foldersOf(files) {
  const folders = new Set(); let global = false;
  for (const f of files) {
    const p = f.replace(/\\/g, '/');
    if (GLOBAL_PATHS.some((re) => re.test(p))) { global = true; continue; }
    const m = p.match(/^src\/([^/]+)\//); if (m) folders.add(m[1]);
    if (/^server\//.test(p)) folders.add('server');
  }
  return { folders: [...folders], global };
}
function select() {
  const names = Object.keys(SMOKES);
  let picked, reason;
  if (opts.only.length) {
    const bad = opts.only.filter((n) => !SMOKES[n]);
    if (bad.length) { console.error(`unknown script(s): ${bad.join(', ')}. Known: ${names.join(', ')}`); process.exit(2); }
    picked = opts.only; reason = '--only';
  } else if (opts.rerunFailed) {
    if (!existsSync(LAST_RUN)) { console.error('no previous run recorded (scripts/logs/last-run.json)'); process.exit(2); }
    const last = JSON.parse(readFileSync(LAST_RUN, 'utf8'));
    picked = last.results.filter((r) => !r.ok).map((r) => r.name).filter((n) => SMOKES[n]);
    reason = `--rerun-failed (${last.time})`;
  } else if (opts.all) {
    picked = names; reason = '--all';
  } else if (opts.folders.length) {
    picked = names.filter((n) => SMOKES[n].folders.some((f) => opts.folders.includes(f)));
    reason = `--folders ${opts.folders.join(',')}`;
  } else {
    const files = changedFiles();
    const { folders, global } = foldersOf(files);
    if (global) { picked = names; reason = `changed: shared/core/bootstrap → all (${files.length} files)`; }
    else { picked = names.filter((n) => SMOKES[n].folders.some((f) => folders.includes(f))); reason = `changed folders: ${folders.join(', ') || '(none)'}`; }
  }
  if (!opts.e2e) picked = picked.filter((n) => n !== 'e2e-mp');
  return { picked, reason };
}

// ─── Process helpers ───────────────────────────────────────────────────────────────────────────────────────────
const children = new Set();
function npmRun(script, logName) {
  const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
  const child = isWin
    ? spawn(`npm.cmd run ${script}`, { shell: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } })
    : spawn('npm', ['run', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}
function pidsOnPort(port) {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    return [...new Set(out.split('\n').map((l) => l.match(re)?.[1]).filter((p) => p && p !== '0'))];
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean);
}
function killPort(port) {
  for (const pid of pidsOnPort(port)) {
    if (isWin) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
  }
}
async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, label, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await isUp(url)) return true; await sleep(500); }
  throw new Error(`${label} did not come up at ${url} within ${ms / 1000}s (see scripts/logs/)`);
}
/** Run a command, capture everything to a log, return {code, out, seconds}. */
function runCapture(cmd, args, logName, { shell = false, timeoutMs = opts.timeoutMs } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
    let out = '';
    const child = spawn(cmd, args, { shell, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
    children.add(child);
    const onData = (chunk) => { out += chunk; log.write(chunk); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { out += `\n[verify] timeout after ${timeoutMs / 60000} min — killed\n`; killTree(child); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); children.delete(child); log.end();
      done({ code: code ?? (signal ? 1 : 0), out, seconds: Math.round((Date.now() - t0) / 1000) });
    });
    child.on('error', (err) => { clearTimeout(timer); children.delete(child); done({ code: 1, out: String(err), seconds: 0 }); });
  });
}
function summarize(name, r) {
  const m = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const ratio = r.out.match(/(\d+)\/(\d+) passed/); // server selftest prints "selftest: 101/101 passed"
  const passed = m ? Number(m[1]) : ratio ? Number(ratio[1]) : null;
  const failed = m ? Number(m[2]) : ratio ? Number(ratio[2]) - Number(ratio[1]) : null;
  const consoleErrs = r.out.match(/(\d+) console errors/)?.[1];
  const ok = r.code === 0 && (failed === null || failed === 0);
  const fails = r.out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 12);
  const score = passed !== null ? `${passed}/${passed + failed}` : (r.code === 0 ? 'ok' : `exit ${r.code}`);
  return { name, ok, score, passed, failed, consoleErrs: consoleErrs ? Number(consoleErrs) : undefined, seconds: r.seconds, code: r.code, fails, log: `scripts/logs/${name}.log` };
}
function report(s) {
  const mark = s.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${mark} ${s.name.padEnd(20)} ${s.score.padEnd(9)} ${String(s.seconds).padStart(4)} s${s.ok ? '' : `   → ${s.log}`}`);
  for (const f of s.fails) console.log(`      ${f.trim()}`);
  if (!s.ok && !s.fails.length) console.log(`      (no FAIL line — crashed or timed out; tail of ${s.log}:)\n      ${tail(s.log)}`);
}
function tail(logRel, n = 6) {
  try { return readFileSync(resolve(ROOT, logRel), 'utf8').trim().split('\n').slice(-n).join('\n      '); } catch { return ''; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(LOG_DIR, { recursive: true });
const started = { vite: null, relay: null };
const results = [];
const tStart = Date.now();
let exiting = false;
function cleanup() {
  if (exiting) return; exiting = true;
  for (const c of children) killTree(c);
  killTree(started.vite); killTree(started.relay);
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  const { picked, reason } = select();
  console.log(`verify — ${reason}`);
  console.log(`  smokes: ${picked.length ? picked.join(', ') : '(none)'}   jobs: ${opts.jobs}   cpus: ${os.cpus().length}`);

  // 1. Fast static checks, all in parallel.
  const npx = isWin ? 'npx.cmd' : 'npx';
  const fast = [];
  if (opts.typecheck) {
    fast.push(runCapture(npx, ['tsc', '--noEmit'], 'typecheck', { shell: isWin }).then((r) => summarize('typecheck', r)));
    fast.push(runCapture(npx, ['tsc', '--noEmit', '-p', 'server/tsconfig.json'], 'typecheck-server', { shell: isWin }).then((r) => summarize('typecheck-server', r)));
  }
  fast.push(runCapture(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/selftest.ts'], 'net-selftest').then((r) => summarize('net-selftest', r)));
  if (opts.build) fast.push(runCapture(npx, ['vite', 'build'], 'build', { shell: isWin }).then((r) => {
    const s = summarize('build', r);
    const js = r.out.match(/index-[\w-]+\.js\s+([\d.,]+ kB)/)?.[1]; const css = r.out.match(/index-[\w-]+\.css\s+([\d.,]+ kB)/)?.[1];
    if (js) s.score = `${js} JS${css ? ` / ${css} CSS` : ''}`;
    return s;
  }));
  for (const s of await Promise.all(fast)) { results.push(s); report(s); }

  if (picked.length) {
    // 2. Servers.
    const relayUrl = 'http://localhost:8787/health';
    const needFreshRelay = picked.some((n) => SMOKES[n].freshRelay) && !opts.keepRelay;
    if (needFreshRelay && pidsOnPort(8787).length) { console.log('  restarting relay (stale lobbies would hijack quick match)'); killPort(8787); await sleep(500); }
    if (!(await isUp(relayUrl))) { started.relay = npmRun('server', 'relay'); await waitUp(relayUrl, 'relay'); console.log('  relay started (8787)'); }
    else console.log('  relay already up (8787)');
    if (!(await isUp(opts.url))) { started.vite = npmRun('dev', 'vite'); await waitUp(opts.url, 'vite'); console.log(`  vite started (${opts.url})`); }
    else console.log(`  vite already up (${opts.url})`);

    // 3. Smokes in a pool; exclusive jobs afterwards, one at a time.
    const pool = picked.filter((n) => !SMOKES[n].exclusive);
    const solo = picked.filter((n) => SMOKES[n].exclusive);
    const runSmoke = async (name) => {
      const s = summarize(name, await runCapture(process.execPath, [SMOKES[name].file, opts.url], name));
      results.push(s); report(s);
    };
    let next = 0;
    const lane = async (i) => { await sleep(i * 8_000); while (next < pool.length) await runSmoke(pool[next++]); };
    await Promise.all(Array.from({ length: Math.min(opts.jobs, pool.length) }, (_, i) => lane(i)));
    for (const name of solo) await runSmoke(name);
  }
} catch (err) {
  console.error(`\nverify aborted: ${err.message}`);
  results.push({ name: 'runner', ok: false, score: 'aborted', seconds: 0, fails: [], log: 'scripts/logs/' });
} finally {
  cleanup();
}

// 4. Summary + record.
const total = Math.round((Date.now() - tStart) / 1000);
const failed = results.filter((r) => !r.ok);
const line = results.map((r) => `${r.name} ${r.score}${r.consoleErrs ? ` (${r.consoleErrs} console errors)` : ''}`).join(', ');
console.log(`\n${failed.length ? `\x1b[31m${failed.length} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} in ${Math.floor(total / 60)} min ${total % 60} s`);
console.log(`docs line: ${new Date().toISOString().slice(0, 10)}: ${line}`);
if (failed.length) console.log('re-run only the failures: node scripts/verify.mjs --rerun-failed');
writeFileSync(LAST_RUN, JSON.stringify({ time: new Date().toISOString(), totalSeconds: total, results }, null, 2));
process.exit(failed.length ? 1 : 0);
