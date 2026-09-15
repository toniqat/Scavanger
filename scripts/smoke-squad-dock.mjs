// 분대 · 도킹 매칭 smoke (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」) — three headless clients against
// a relay this script starts itself from the working tree's `server/index.ts` (port 8894, temp profile store), so the
// shared relay (8787, possibly older code) is never touched:
//   1. A invites B (`social.playWith`) → A leads an **undocked** lobby; B accepts (P-hold path = `acceptInvite`) → both stay in
//      their personal ships, exchange no hub snapshots (no remote refs, `inHubSession` false), squad HUD shows 2 rows `개인 함선`.
//   2. Undocked locks: personal pod `podBlockReason` = 분대 대기 …, `startTraining()` refused with a toast.
//   3. A member's `requestDock` → `net:error not_host`, nobody moves.
//   4. B opens the inventory; A docks **public** → A fades out at once (`ui:screenFade {1, hold}`, never a countdown) → docking;
//      B shows the right-side countdown (`.hub-squad-dock`) → at the dock the inventory is closed and `uiBlockers` is empty →
//      both land in the shared ship and see each other.
//   5. Lone C `requestDock(true)` joins A's docked public ship (own dock: fade, no countdown).
//   6. C `leaveLobby` (도킹 해제) → only C undocks; A + B stay.
//   7. A invites C into the already docked lobby → C accepts → countdown → docks.
//   8. C leaves again, then `requestDock(false)` alone → a private docked lobby of one, own dock at once.
// Usage: node scripts/smoke-squad-dock.mjs [http://localhost:5273/]   (needs vite; starts and stops its own relay)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] ?? 'http://localhost:5273/';
const RELAY_PORT = Number(process.env.SQUAD_DOCK_RELAY_PORT ?? 8894);
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

/* ── own relay (the pattern of scripts/smoke-netlink.mjs) ── */
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
const dataDir = mkdtempSync(resolve(os.tmpdir(), 'scav-squad-dock-relay-'));
let relay = null;
let relayOut = '';
async function startRelay() {
  for (let tryNo = 0; tryNo < 4; tryNo++) {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/index.ts'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', SCAV_DATA_DIR: dataDir },
    });
    relayOut = '';
    child.stdout.on('data', (d) => { relayOut += d; });
    child.stderr.on('data', (d) => { relayOut += d; });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && child.exitCode === null) {
      if (await healthy()) { relay = child; return; }
      await sleep(150);
    }
    try { child.kill(); } catch { /* gone */ }
    console.log(`  (relay start ${tryNo + 1} failed — ${relayOut.trim().split('\n').slice(-2).join(' | ')})`);
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
  console.error(`port ${RELAY_PORT} must be free (another smoke-squad-dock running? set SQUAD_DOCK_RELAY_PORT)`);
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net && !!window.__game.getSystem('hub'), `${tag} boot`, 60000);
  await page.evaluate(() => {
    const ctx = window.__game.ctx, bus = ctx.bus, hub = window.__game.getSystem('hub');
    window.__fades = []; bus.on('ui:screenFade', (e) => window.__fades.push({ o: e.opacity, hold: !!e.hold, phase: ctx.phase }));
    window.__dock = []; bus.on('hub:docking', (e) => window.__dock.push(`${e.stage}:${e.direction}`));
    window.__notify = []; bus.on('ui:notify', (e) => window.__notify.push(e.text));
    window.__netErr = []; bus.on('net:error', (e) => window.__netErr.push(e.code));
    // the largest countdown digit seen since the last reset — "never counted down" is `__cdMax === -1`
    window.__cdMax = -1;
    setInterval(() => { const s = hub.squadDockSeconds; if (s > window.__cdMax) window.__cdMax = s; }, 40);
    // the moment the docking cutscene starts: what was still open
    window.__atDock = null;
    bus.on('hub:docking', (e) => {
      if (e.stage !== 'start' || e.direction !== 'dock') return;
      const hudSys = window.__game.getSystem('hud');
      window.__atDock = {
        blockers: [...ctx.uiBlockers], inv: !!ctx.inventory?.isOpen, escape: ctx.escape.size,
        settings: !!hudSys?.isSettingsOpen, pause: !document.querySelector('.menu.pause')?.classList.contains('hidden'),
      };
    });
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  return page;
}
const S = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => S(page, () => {
  const ctx = window.__game.ctx, net = ctx.net, hub = window.__game.getSystem('hub');
  const l = net.lobby;
  return {
    phase: ctx.phase, ship: hub.ship, cd: hub.squadDockSeconds, fading: hub.dockFading, pending: net.dockPending,
    lobby: l ? { code: l.code, docked: l.docked, isPublic: l.isPublic, n: l.players.length, host: l.hostId === net.localId } : null,
    remotes: net.getRemotePlayers().length, inHub: net.inHubSession,
  };
});
const inShared = (page, code) => waitFor(page, (c) => {
  const ctx = window.__game.ctx;
  return ctx.phase === 'hub' && window.__game.getSystem('hub').ship === 'shared' && ctx.net.lobby?.code === (c ?? ctx.net.lobby?.code);
}, `shared ship ${code ?? ''}`, 120000, code);
const inPersonal = (page, tag) => waitFor(page, () => {
  const ctx = window.__game.ctx;
  return ctx.phase === 'hub' && window.__game.getSystem('hub').ship === 'personal' && !window.__game.getSystem('hub').cutscene;
}, `${tag} personal ship`, 120000);
const resetMarks = (page) => S(page, () => { window.__fades = []; window.__dock = []; window.__cdMax = -1; window.__atDock = null; window.__notify = []; window.__netErr = []; });

try {
  console.log(`relay ${RELAY_URL}`);
  await startRelay();

  console.log('boot three clients');
  const A = await open('A');
  const B = await open('B');
  const C = await open('C');
  const pages = { A, B, C };
  const codes = {};
  for (const [tag, page] of Object.entries(pages)) {
    await S(page, () => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    codes[tag] = await waitFor(page, () => {
      const ctx = window.__game.ctx;
      return ctx.phase === 'hub' && ctx.net.connected && ctx.net.social.available && ctx.net.social.me?.code;
    }, `${tag} personal + connected + social`, 60000);
  }
  ok(!!codes.A && !!codes.B && !!codes.C && new Set(Object.values(codes)).size === 3, `three profiles (${JSON.stringify(codes)})`);

  /* ── 1. invite → undocked squad, everyone stays home ───────────────────── */
  console.log('invite → undocked squad');
  await S(A, (c) => window.__game.ctx.net.social.playWith(c), codes.B);
  await waitFor(A, () => window.__game.ctx.net.lobby?.docked === false, 'A leads an undocked lobby', 15000);
  let a = await state(A);
  ok(a.lobby?.host && a.lobby.n === 1 && a.ship === 'personal', `sending the invite made A leader of an undocked lobby, still in the personal ship (${JSON.stringify(a)})`);
  await waitFor(B, (c) => window.__game.ctx.net.social.invites.some((i) => i.from === c), 'B receives the invite', 15000, codes.A);
  await S(B, (c) => window.__game.ctx.net.social.acceptInvite(c), codes.A);
  await waitFor(B, () => window.__game.ctx.net.lobby?.docked === false && window.__game.ctx.net.lobby.players.length === 2, 'B in the undocked squad', 15000);
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 2, 'A sees 2 members', 15000);
  await sleep(2500);   // several snapshot periods: any hub snapshot would have made a remote ref by now
  a = await state(A);
  let b = await state(B);
  ok(a.ship === 'personal' && b.ship === 'personal' && a.phase === 'hub' && b.phase === 'hub', `both stay in their personal ships (${a.ship}/${b.ship})`);
  ok(a.cd === -1 && b.cd === -1 && !a.fading && !b.fading, 'no countdown / fade while undocked');
  ok(a.remotes === 0 && b.remotes === 0 && !a.inHub && !b.inHub, `no hub snapshots between different personal ships (remotes ${a.remotes}/${b.remotes}, inHubSession ${a.inHub}/${b.inHub})`);
  const squadHud = (page) => S(page, () => {
    const root = document.querySelector('.squad');
    const rows = [...root.querySelectorAll('.srow')].filter((r) => !r.hidden);
    return { shown: !root.classList.contains('hidden'), rows: rows.length, states: rows.map((r) => r.querySelector('.state').textContent) };
  });
  const hudA = await squadHud(A);
  const hudB = await squadHud(B);
  ok(hudA.shown && hudA.rows === 2 && hudA.states.every((s) => s === '개인 함선'), `A squad HUD: 2 rows 개인 함선 (${JSON.stringify(hudA)})`);
  ok(hudB.shown && hudB.rows === 2 && hudB.states.every((s) => s === '개인 함선'), `B squad HUD: 2 rows 개인 함선 (${JSON.stringify(hudB)})`);

  /* ── 2. undocked locks ─────────────────────────────────────────────────── */
  console.log('pod / training locked');
  const locks = await S(B, () => {
    const hub = window.__game.getSystem('hub');
    const n0 = window.__notify.length;
    const trained = hub.startTraining();
    return { pod: hub.podBlockReason(0), trained, notes: window.__notify.slice(n0), phase: window.__game.ctx.phase };
  });
  ok(/분대 대기/.test(locks.pod ?? ''), `personal pod locked: "${locks.pod}"`);
  ok(locks.trained === false && locks.notes.some((t) => /분대 대기/.test(t)) && locks.phase === 'hub', `training refused with a toast (${JSON.stringify(locks.notes)})`);

  /* ── 3. a member cannot dock ───────────────────────────────────────────── */
  console.log('member requestDock → refused');
  await resetMarks(B);
  await S(B, () => window.__game.ctx.net.requestDock(false));
  await waitFor(B, () => window.__netErr.includes('not_host'), 'B gets not_host', 10000);
  await sleep(1200);
  b = await state(B);
  a = await state(A);
  ok(b.ship === 'personal' && b.phase === 'hub' && !b.pending && b.cd === -1 && !b.fading && b.lobby?.docked === false,
    `B stays put, dockPending cleared (${JSON.stringify(b)})`);
  ok(a.lobby?.docked === false && a.cd === -1 && a.ship === 'personal', 'A is not moved by it either');

  /* ── 4. leader docks: own fade at once, member counts down ─────────────── */
  console.log('leader docks (public)');
  await S(B, () => window.__game.ctx.inventory.toggleBag());
  await waitFor(B, () => window.__game.ctx.inventory.isOpen && window.__game.ctx.uiBlockers.size > 0, 'B inventory open', 10000);
  await resetMarks(A); await resetMarks(B);
  await S(A, () => window.__game.ctx.net.requestDock(true));
  await waitFor(A, () => window.__game.getSystem('hub').dockFading || window.__game.ctx.phase === 'docking', 'A fades out at once', 8000);
  const aFade = await S(A, () => ({ fades: window.__fades.slice(), cd: window.__cdMax }));
  ok(aFade.fades[0]?.o === 1 && aFade.fades[0]?.hold === true && aFade.cd === -1, `A: fade-out (hold) first, no countdown (${JSON.stringify(aFade)})`);
  const cdB = await waitFor(B, () => {
    const el = document.querySelector('.hub-squad-dock');
    const s = window.__game.getSystem('hub').squadDockSeconds;
    return s > 0 && el && !el.hidden ? { s, num: el.querySelector('.hsd-num').textContent, label: el.querySelector('.hsd-label').textContent, right: el.getBoundingClientRect().left > window.innerWidth / 2 } : null;
  }, 'B countdown shown', 10000);
  ok(cdB.num === String(cdB.s) && /분대장이 공용 함선으로 이동합니다/.test(cdB.label) && cdB.right, `B: right-side countdown ${cdB.num} "${cdB.label}"`);
  ok(await S(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.inventory.isOpen), 'B keeps playing during the countdown (inventory still open)');
  await waitFor(A, () => window.__game.ctx.phase === 'docking', 'A docking cutscene', 15000);
  await waitFor(B, () => window.__atDock !== null, 'B docking cutscene', 30000);
  const bDock = await S(B, () => ({ at: window.__atDock, fades: window.__fades.map((f) => f.o), cd: window.__cdMax, blockersNow: window.__game.ctx.uiBlockers.size }));
  ok(bDock.cd >= 2, `B counted down from ${bDock.cd}`);
  ok(bDock.at.blockers.length === 0 && !bDock.at.inv && bDock.at.escape === 0, `B: everything closed at the dock (${JSON.stringify(bDock.at)})`);
  ok(bDock.fades[0] === 1 && bDock.fades.includes(0), `B: fade out → fade in around the cutscene (${JSON.stringify(bDock.fades)})`);
  await inShared(A); await inShared(B);
  a = await state(A); b = await state(B);
  ok(a.lobby?.docked === true && a.lobby.isPublic === true && b.lobby?.code === a.lobby.code, `both in the docked public shared ship ${a.lobby?.code}`);
  await waitFor(A, () => window.__game.ctx.net.getRemotePlayers().length === 1, 'A sees B aboard', 20000);
  await waitFor(B, () => window.__game.ctx.net.getRemotePlayers().length === 1, 'B sees A aboard', 20000);
  ok(true, 'squadmates exchange hub snapshots once docked');
  const hudDocked = await squadHud(A);
  ok(hudDocked.rows === 2 && hudDocked.states.every((s) => s !== '개인 함선'), `docked squad HUD no longer says 개인 함선 (${JSON.stringify(hudDocked.states)})`);
  const shipCode = a.lobby.code;

  /* ── 5. lone C: public matching joins the open public ship ─────────────── */
  console.log('lone C public matching');
  await resetMarks(C);
  await S(C, () => window.__game.ctx.net.requestDock(true));
  await waitFor(C, () => window.__game.getSystem('hub').dockFading || window.__game.ctx.phase === 'docking', 'C fades out at once', 10000);
  await inShared(C, shipCode);
  const cJoin = await S(C, () => ({ cd: window.__cdMax, dock: window.__dock.slice() }));
  ok(cJoin.cd === -1 && cJoin.dock.join(',') === 'start:dock,end:dock', `C: own dock, no countdown (${JSON.stringify(cJoin)})`);
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 3, 'A sees 3 aboard', 15000);
  ok(true, 'C joined the docked public ship of A + B');

  /* ── 6. 도킹 해제 takes out only C ─────────────────────────────────────── */
  console.log('C 도킹 해제');
  await S(C, () => window.__game.ctx.net.leaveLobby());
  await inPersonal(C, 'C');
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 2, 'A back to 2', 15000);
  a = await state(A); b = await state(B);
  const c6 = await state(C);
  ok(c6.lobby === null && a.ship === 'shared' && b.ship === 'shared' && a.lobby?.code === shipCode && b.lobby?.code === shipCode,
    `only C left: C personal / no lobby, A + B still in ${shipCode}`);

  /* ── 7. invite into an already docked lobby → countdown → dock ─────────── */
  console.log('C accepts an invite into the docked ship');
  await resetMarks(C);
  await S(A, (c) => window.__game.ctx.net.social.playWith(c), codes.C);
  await waitFor(C, (c) => window.__game.ctx.net.social.invites.some((i) => i.from === c), 'C receives the invite', 15000, codes.A);
  // a housing station screen needs a piece to open on: plant a 식탁 in C's own ship (room 0), like smoke-hangar seeds a bench
  const planted = await S(C, () => {
    const h = window.__game.ctx.housing;
    h.state.furniture.push({ uid: 'smoke-dock-table', defId: 'furn_dining_table', room: 0, x: 1, y: 1, yaw: 0, level: 1 });
    window.__game.ctx.bus.emit('housing:changed', { reason: 'smoke' });
    return !!h.getPlacedByUid('smoke-dock-table');
  });
  ok(planted, 'C has a 식탁 placed for the station-screen check');
  await S(C, (c) => window.__game.ctx.net.social.acceptInvite(c), codes.A);
  await waitFor(C, () => window.__game.getSystem('hub').squadDockSeconds > 0, 'C counts down', 15000);
  ok((await state(C)).ship === 'personal', 'C is still home while counting down');
  /* 2026-09-15 (리드 후속): 「도킹 컷씬 직전에 모든 UI 메뉴가 닫힌다」 — a housing station screen (식탁), then the pause menu with its
     설정 sub-screen on top (설정 has neither a blocker nor an escape entry — it used to survive the dock). */
  const opened = await S(C, () => {
    const ctx = window.__game.ctx, hudSys = window.__game.getSystem('hud');
    ctx.housing.openDiningTable('smoke-dock-table');
    const station = ctx.uiBlockers.has('housing');
    ctx.bus.emit('game:paused', { paused: true, freeze: false });
    const btn = [...document.querySelectorAll('.menu.pause .actions .ui-btn')].find((b) => b.textContent === '설정');
    btn?.click();
    return { station, pause: ctx.uiBlockers.has('menu'), settings: hudSys.isSettingsOpen, blockers: [...ctx.uiBlockers], cd: window.__game.getSystem('hub').squadDockSeconds };
  });
  ok(opened.station && opened.pause && opened.settings, `C opened a station screen + pause + 설정 during the countdown (${JSON.stringify(opened)})`);
  await waitFor(C, () => window.__game.getSystem('hub').dockFading || window.__atDock !== null, 'C fade starts', 20000);
  const atFade = await S(C, () => ({ settings: window.__game.getSystem('hud').isSettingsOpen, blockers: [...window.__game.ctx.uiBlockers], escape: window.__game.ctx.escape.size }));
  ok(!atFade.settings && atFade.blockers.length === 0 && atFade.escape === 0, `at the fade-out everything is already closed (${JSON.stringify(atFade)})`);
  await waitFor(C, () => window.__atDock !== null, 'C docking cutscene', 30000);
  const cAt = await S(C, () => window.__atDock);
  ok(cAt.blockers.length === 0 && cAt.escape === 0 && !cAt.settings && !cAt.pause && !cAt.inv, `C: station · pause · 설정 all closed at the dock (${JSON.stringify(cAt)})`);
  await inShared(C, shipCode);
  const c7 = await S(C, () => ({ cd: window.__cdMax, dock: window.__dock.slice() }));
  ok(c7.cd >= 2 && c7.dock[0] === 'start:dock', `C counted down (${c7.cd}) then docked into ${shipCode}`);

  /* ── 8. alone, private matching → own private docked lobby at once ─────── */
  console.log('C alone: private matching');
  await S(C, () => window.__game.ctx.net.leaveLobby());
  await inPersonal(C, 'C');
  await resetMarks(C);
  await S(C, () => window.__game.ctx.net.requestDock(false));
  await waitFor(C, () => window.__game.getSystem('hub').dockFading || window.__game.ctx.phase === 'docking', 'C private: fades out at once', 10000);
  await inShared(C);
  const c8 = await state(C);
  const c8m = await S(C, () => window.__cdMax);
  ok(c8.lobby?.docked === true && c8.lobby.isPublic === false && c8.lobby.n === 1 && c8.lobby.code !== shipCode && c8m === -1,
    `C docked a private lobby of one without a countdown (${JSON.stringify(c8.lobby)})`);

  for (const page of Object.values(pages)) { try { await S(page, () => window.__game.ctx.net.leaveLobby()); } catch { /* closing */ } }
  await sleep(300);
  for (const [tag, list] of Object.entries(errors)) {
    const real = list.filter((e) => !/\/ws\b|WebSocket|websocket|ERR_CONNECTION_REFUSED/i.test(e));
    ok(real.length === 0, `${tag}: no console / page errors`, JSON.stringify(real.slice(0, 3)));
  }
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${e.message}`);
  if (relayOut && /error/i.test(relayOut)) console.log(`  relay tail: ${relayOut.trim().split('\n').slice(-4).join(' | ')}`);
} finally {
  for (const b of browsers) { try { await b.close(); } catch { /* gone */ } }
  stopRelay();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
}
console.log(`\n${pass} passed, ${fail} failed`);   // the tally format `scripts/verify.mjs` parses
process.exit(fail === 0 ? 0 : 1);
