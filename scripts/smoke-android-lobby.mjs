// 안드로이드 분대원 — 봇 로비 멤버 smoke (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
// 두 헤드리스 클라이언트가 **이 스크립트가 직접 띄운** 릴레이(8896, 임시 프로필 저장소)에 붙는다 — 공용 릴레이(8787, 옛 코드일 수
// 있다)는 건드리지 않는다. 여기서 보는 것은 `src/net` 과 `server/` 의 계약뿐이다 (조종실 슬롯 연출 · 몸 · AI 는 hub/allies 의 스모크).
//   1. 분대장이 `setAndroidBay(bay, true)` 로 세 기를 들인다 → 로비 멤버로 `bot`·`bay`·`ready`·`recruitedAt` 이 실려 온다.
//   2. 봇은 **사람이 아니다** — `net:peerJoined` 도, `RemotePlayerRef` 도 생기지 않는다.
//   3. 사람이 합류하면 **가장 늦게 들어온 기**가 슬롯으로 돌아간다 — 새로 온 사람까지 `net:androidReturned {human_joined}` 를 받는다.
//   4. 분대원이 부르면 `net:error not_host`, 분대가 가득 차면 `net:error full` + 요청자에게만 `net:androidReturned {full}`.
//   5. 돌려보내기(`recruit:false`)로 명단이 줄고, 사람이 나가면 `net:peerLeft` 는 그 사람 하나뿐이다.
// Usage: node scripts/smoke-android-lobby.mjs [http://localhost:5273/]   (needs vite; starts and stops its own relay)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] ?? 'http://localhost:5273/';
const RELAY_PORT = Number(process.env.ANDROID_LOBBY_RELAY_PORT ?? 8896);
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}/ws`;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 30000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* page still loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/* ── own relay (the pattern of scripts/smoke-squad-dock.mjs) ── */
function portFree(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}
async function healthy() {
  try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}
const dataDir = mkdtempSync(resolve(os.tmpdir(), 'scav-android-relay-'));
let relay = null;
async function startRelay() {
  for (let tryNo = 0; tryNo < 4; tryNo++) {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/index.ts'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', SCAV_DATA_DIR: dataDir },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && child.exitCode === null) {
      if (await healthy()) { relay = child; return; }
      await sleep(150);
    }
    try { child.kill(); } catch { /* gone */ }
    console.log(`  (relay start ${tryNo + 1} failed — ${out.trim().split('\n').slice(-2).join(' | ')})`);
    await sleep(800);
  }
  throw new Error(`relay did not come up on ${RELAY_PORT}`);
}
function stopRelay() {
  const child = relay;
  relay = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

if (!(await portFree(RELAY_PORT))) {
  console.error(`port ${RELAY_PORT} must be free (another smoke-android-lobby running? set ANDROID_LOBBY_RELAY_PORT)`);
  process.exit(2);
}

const LAUNCH = {
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox'],
};
const browsers = [];
const errors = {};
/** One browser per client: separate localStorage → distinct session tokens / profiles. */
async function open(tag) {
  const browser = await puppeteer.launch(LAUNCH);
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument((relayUrl) => {
    try {
      localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } }));
      localStorage.setItem('scav.relay', relayUrl);   // 설정 › 서버 설정 (slot-shared) → this script's relay
    } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  }, RELAY_URL);
  await quietViteHmr(page);
  errors[tag] = [];
  page.on('pageerror', (e) => errors[tag].push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net, `${tag} boot`, 60000);
  await page.evaluate(() => {
    const bus = window.__game.ctx.bus;
    window.__joined = []; bus.on('net:peerJoined', (e) => window.__joined.push(e.id));
    window.__left = []; bus.on('net:peerLeft', (e) => window.__left.push(e.id));
    window.__returned = []; bus.on('net:androidReturned', (e) => window.__returned.push(`${e.bay}:${e.reason}`));
    window.__netErr = []; bus.on('net:error', (e) => window.__netErr.push(e.code));
    // headless tabs throttle rAF when nothing is visible — keep the loop ticking (the squad-dock smoke does the same)
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  return page;
}
const S = (page, fn, arg) => page.evaluate(fn, arg);
/** Everything this smoke judges: the lobby roster split into humans / androids, plus the recorded bus events. */
const state = (page) => S(page, () => {
  const net = window.__game.ctx.net;
  const l = net.lobby;
  return {
    code: l?.code ?? null,
    host: !!l && l.hostId === net.localId,
    humans: l ? l.players.filter((p) => p.bot !== true).length : 0,
    bots: l ? l.players.filter((p) => p.bot === true).map((p) => ({ id: p.id, bay: p.bay, slot: p.slot, ready: p.ready, at: p.recruitedAt, host: p.isHost, name: p.name })) : [],
    remotes: net.getRemotePlayers().map((r) => r.id),
    joined: [...window.__joined], left: [...window.__left], returned: [...window.__returned], err: [...window.__netErr],
  };
});
const marks = (page) => S(page, () => { window.__joined = []; window.__left = []; window.__returned = []; window.__netErr = []; });
/** The relay answers every `lobby:android` with a fresh `lobby:state` — wait for the roster to settle. */
const waitBots = (page, n, tag) => waitFor(page, (k) => (window.__game.ctx.net.lobby?.players.filter((p) => p.bot === true).length ?? -1) === k, `${tag} ${n} androids`, 20000, n);

try {
  console.log(`relay ${RELAY_URL}`);
  await startRelay();

  console.log('boot two clients');
  const A = await open('A');
  const B = await open('B');
  for (const [tag, page] of [['A', A], ['B', B]]) {
    await S(page, () => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.net.connected && !!window.__game.ctx.net.localId, `${tag} connected`, 60000);
  }

  /* ── 1. 분대장이 조종실 슬롯 3칸을 채운다 ─────────────────────────────── */
  console.log('leader recruits three androids');
  await S(A, () => window.__game.ctx.net.createLobby());
  const code = await waitFor(A, () => window.__game.ctx.net.lobby?.code ?? null, 'A leads a lobby', 20000);
  await marks(A);
  for (const bay of [0, 1, 2]) {
    await S(A, (n) => window.__game.ctx.net.setAndroidBay(n, true), bay);
    await waitBots(A, bay + 1, 'A');
  }
  let a = await state(A);
  ok(a.host && a.humans === 1 && a.bots.length === 3, `the leader's squad is 1 human + 3 androids (${a.humans}/${a.bots.length})`);
  ok(a.bots.map((b) => b.bay).join(',') === '0,1,2' && a.bots.every((b) => b.id.startsWith('android:') && b.ready === true && !b.host && typeof b.at === 'number' && !!b.name),
    `each android carries bay · id · ready · recruitedAt · name and is never the host (${JSON.stringify(a.bots.map((b) => [b.bay, b.ready, b.host]))})`);
  ok(new Set(a.bots.map((b) => b.slot)).size === 3 && !a.bots.some((b) => b.slot === 0),
    `androids take real lobby slots of their own (${a.bots.map((b) => b.slot).join(',')})`);

  /* ── 2. 봇은 사람이 아니다 ───────────────────────────────────────────── */
  await sleep(1200);   // several snapshot periods: a peer would have made a remote ref by now
  a = await state(A);
  ok(a.joined.length === 0, `recruiting an android is no peer join (net:peerJoined ${JSON.stringify(a.joined)})`);
  ok(a.remotes.length === 0, `and creates no RemotePlayerRef (${JSON.stringify(a.remotes)})`);
  ok(a.err.length === 0, `no net:error on the way (${JSON.stringify(a.err)})`);

  /* ── 3. 사람이 이긴다: 가장 늦게 들어온 기가 슬롯으로 돌아간다 ─────────── */
  console.log('a human joins the full squad');
  await marks(A); await marks(B);
  await S(B, (c) => window.__game.ctx.net.joinLobby(c), code);
  await waitFor(B, (c) => window.__game.ctx.net.lobby?.code === c, 'B in the squad', 20000, code);
  await waitBots(A, 2, 'A');
  await waitBots(B, 2, 'B');
  await sleep(300);
  a = await state(A);
  let b = await state(B);
  ok(a.returned.join(',') === '2:human_joined', `the latest recruited android goes back to its bay (A saw ${JSON.stringify(a.returned)})`);
  ok(b.returned.join(',') === '2:human_joined', `the newcomer is told too — it joined after the eviction (B saw ${JSON.stringify(b.returned)})`);
  ok(a.humans === 2 && a.bots.map((x) => x.bay).join(',') === '0,1', `2 humans + the two older androids remain (${a.humans}/${JSON.stringify(a.bots.map((x) => x.bay))})`);
  ok(a.joined.length === 1 && !a.joined[0].startsWith('android:'), `exactly one net:peerJoined, for the person (${JSON.stringify(a.joined)})`);
  ok(!b.remotes.some((id) => id.startsWith('android:')), `androids never become remote players on the joiner either (${JSON.stringify(b.remotes)})`);

  /* ── 4. 분대원은 부를 수 없고, 가득 차면 요청자만 되돌림을 듣는다 ──────── */
  console.log('refusals');
  await marks(A); await marks(B);
  await S(B, () => window.__game.ctx.net.setAndroidBay(0, false));
  await sleep(700);
  b = await state(B);
  a = await state(A);
  ok(b.err.includes('not_host') && b.bots.length === 2 && a.bots.length === 2,
    `a member asking for an android is refused locally with not_host, nothing changes (${JSON.stringify(b.err)})`);
  await marks(A); await marks(B);
  await S(A, () => window.__game.ctx.net.setAndroidBay(2, true));
  await sleep(900);
  a = await state(A);
  b = await state(B);
  ok(a.err.includes('full') && a.returned.join(',') === '2:full', `a squad with no free slot answers full + net:androidReturned {full} (${JSON.stringify(a.err)} ${JSON.stringify(a.returned)})`);
  ok(b.returned.length === 0, `the "full" notice reaches the requester only (B saw ${JSON.stringify(b.returned)})`);
  ok(a.bots.length === 2, `and the roster is untouched (${a.bots.length})`);

  /* ── 5. 돌려보내기 · 사람이 나가기 ───────────────────────────────────── */
  console.log('dismiss and leave');
  await marks(A);
  await S(A, () => window.__game.ctx.net.setAndroidBay(0, false));
  await waitBots(A, 1, 'A');
  await waitBots(B, 1, 'B');
  a = await state(A);
  ok(a.bots.length === 1 && a.bots[0].bay === 1, `dismissing bay 0 leaves only bay 1 (${JSON.stringify(a.bots.map((x) => x.bay))})`);
  ok(a.returned.length === 0, `a deliberate dismissal sends no net:androidReturned (${JSON.stringify(a.returned)})`);
  await marks(A);
  await S(B, () => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => (window.__game.ctx.net.lobby?.players.filter((p) => p.bot !== true).length ?? 0) === 1, 'B gone', 20000);
  await sleep(300);
  a = await state(A);
  ok(a.left.length === 1 && !a.left[0].startsWith('android:'), `net:peerLeft only for the person who left (${JSON.stringify(a.left)})`);
  ok(a.bots.length === 1, `the android stays with its leader (${a.bots.length})`);

  const pageErrors = Object.entries(errors).flatMap(([tag, list]) => list.map((e) => `${tag}: ${e}`));
  ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
} catch (e) {
  fail++;
  console.log(`  FAIL exception ${e && e.message ? e.message : e}`);
} finally {
  for (const b of browsers) { await closeBrowser(b); }
  stopRelay();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\nsmoke-android-lobby: ${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
