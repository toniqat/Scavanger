// Raid-entry loading gate smoke (2026-09-15, game/parts/LoadGate + core/ShaderWarmup.holdFor / compileProgress).
// What it checks:
//   ① Solo launch — the gate is armed and the screen is held black (`ui:screenFade` 1 + hold), mission clock 0,
//      `raid:loadProgress` climbs to 1 and, once `RAID_LOAD_MIN_BLACK_S` has passed,
//      `raid:loadReleased {timedOut:false}` + the fade-in → deploying → playing.
//   ② Squad — injecting a fake squadmate that never finishes (a debug hook) makes the host wait: the mission clock
//      and the hellpod stay frozen until a briefly overridden timeout releases it with `timedOut: true`.
//   ③ A rejoin and the training range do not go through the gate.
// Usage: node scripts/smoke-raid-loading.mjs [http://localhost:5273]   (needs a running vite)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
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
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    // The tutorial is not checked here (smoke-tutorial) — a fresh profile's automatic tutorial is marked as done.
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    // Nothing is drawn while the shader hold is up, so rAF can grow sparse — the frames are pushed by hand.
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    const ctx = window.__game.ctx;
    window.__ev = {};
    for (const n of ['game:newMission', 'world:ready', 'game:phaseChanged', 'raid:loadProgress', 'raid:loadReleased', 'ui:screenFade', 'player:landed', 'game:abort']) {
      window.__ev[n] = [];
      ctx.bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}))); });
    }
    // Take the release moment exactly, off `ctx.time` (polling cannot measure the minimum black time)
    window.__mark = { releasedAt: -1, startedAt: -1 };
    ctx.bus.on('raid:loadReleased', () => { window.__mark.releasedAt = ctx.time; });
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const resetEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k] = []; window.__mark.releasedAt = -1; window.__mark.startedAt = -1; });
  const waitReal = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `+${sec}s`, 120000, t0 + sec); };
  const snap = () => P(() => {
    const ctx = window.__game.ctx;
    const gf = window.__game.getSystem('gameflow');
    const hud = window.__game.getSystem('hud');
    return {
      gate: !!gf.loadGate.active, local: gf.loadGate.localProgress, squad: gf.loadGate.squadProgress, waiting: gf.loadGate.waiting,
      holding: !!ctx.shaders.holding, compile: ctx.shaders.compileProgress,
      phase: ctx.phase, missionTime: ctx.missionTime, time: ctx.time,
      fade: hud ? hud.screenFadeOpacity : -1, held: hud ? hud.screenFadeHeld : false,
      podY: ctx.player ? ctx.player.position.y : 0, dropping: ctx.player ? !!ctx.player.isDropping : false,
    };
  });
  const toHub = async () => {
    await P(() => window.__game.ctx.bus.emit('game:abort', {}));
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  };
  const launch = async (seed) => P((s) => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'raid';
    window.__mark.startedAt = ctx.time;
    ctx.bus.emit('game:newMission', { seed: s, mode: 'raid' });
  }, seed);

  console.log('① 솔로 발사: 게이트가 걸리고 검은 화면이 붙잡힌다');
  await toHub();
  await resetEv();
  await launch(4101);
  let s = await snap();
  ok(s.gate, 'raid launch arms the loading gate', JSON.stringify(s));
  ok(s.holding, 'the engine holds (sim dt 0, nothing drawn)', `${s.holding}`);
  ok(s.fade === 1 && s.held, 'screen is black and the plate is held across the phase change', `fade=${s.fade} held=${s.held}`);
  ok(s.missionTime === 0, 'mission clock has not started', `${s.missionTime}`);
  ok(s.phase === 'deploying', 'phase reached deploying behind the black screen', s.phase);

  await waitFor(page, () => !window.__game.getSystem('gameflow').loadGate.active, 'gate released', 40000);
  const marks = await P(() => window.__mark);
  ok(marks.releasedAt - marks.startedAt >= 0.75, `black for at least RAID_LOAD_MIN_BLACK_S (0.8 s)`, `${(marks.releasedAt - marks.startedAt).toFixed(2)}s`);
  const prog = await ev('raid:loadProgress');
  ok(prog.length >= 2, 'raid:loadProgress emitted repeatedly', `${prog.length}`);
  ok(prog[prog.length - 1].local === 1 && prog[prog.length - 1].waiting === 0, 'progress ends at local 1 / nobody waiting', JSON.stringify(prog[prog.length - 1]));
  const rel = await lastEv('raid:loadReleased');
  ok(rel && rel.timedOut === false, 'raid:loadReleased {timedOut:false}', JSON.stringify(rel));
  const fades = await ev('ui:screenFade');
  const fadeIn = fades[fades.length - 1];
  ok(fadeIn && fadeIn.opacity === 0 && fadeIn.durationS > 0, 'release fades back in', JSON.stringify(fadeIn));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing after the gate', 40000);
  s = await snap();
  ok(!s.holding && s.phase === 'playing', 'the drop plays only after the release', JSON.stringify(s));
  await waitReal(0.5);   // The mission clock runs only **after** `playing` — on the transition frame it is still 0
  s = await snap();
  ok(s.missionTime > 0, 'mission clock runs once released', `${s.missionTime}`);

  console.log('② 분대: 끝나지 않는 분대원 하나 — 호스트가 기다리다 상한에서 푼다');
  await toHub();
  await P(() => {
    const gate = window.__game.getSystem('gameflow').loadGate;
    // does not really wait `RAID_LOAD_TIMEOUT_S` out. 6 s, not 4 (2026-09-22, E-12): the 「a second later」 read lands
    // ~2.6 s in plus every poll's overshoot, and under 6 lanes that crossed 4 s and read a released gate.
    gate.debugSetTimeout(6);
    gate.debugAddMember('peer-x', 0.5);   // a fake squadmate that never reaches 1
  });
  await resetEv();
  await launch(4102);
  await waitReal(1.6);
  const a = await snap();
  ok(a.gate && a.holding, 'host still waits for the squadmate', JSON.stringify(a));
  ok(a.waiting >= 1, 'the unfinished squadmate is counted as waiting', `${a.waiting}`);
  ok(a.squad > 0 && a.squad < 1, 'squad progress is the average over humans (the squadmate drags it below 1)', `${a.squad}`);
  ok(a.missionTime === 0, 'mission clock still frozen while waiting', `${a.missionTime}`);
  await waitReal(1.0);
  const b = await snap();
  ok(Math.abs(b.podY - a.podY) < 0.001, 'the hellpod does not move during the hold', `${a.podY} → ${b.podY}`);
  ok(b.missionTime === 0 && b.gate, 'still held a second later', JSON.stringify(b));
  await waitFor(page, () => !window.__game.getSystem('gameflow').loadGate.active, 'gate released on timeout', 30000);
  const rel2 = await lastEv('raid:loadReleased');
  ok(rel2 && rel2.timedOut === true, 'release after the timeout is marked timedOut', JSON.stringify(rel2));
  const m2 = await P(() => window.__mark);
  ok(m2.releasedAt - m2.startedAt >= 5.5, 'the host really waited out the (shortened) timeout', `${(m2.releasedAt - m2.startedAt).toFixed(2)}s`);
  await P(() => { const g = window.__game.getSystem('gameflow').loadGate; g.debugClearMembers(); g.debugSetTimeout(null); });

  console.log('③ 재접속 · 훈련장은 게이트를 타지 않는다');
  await toHub();
  await resetEv();
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'raid';
    ctx.bus.emit('net:gameStarting', { seed: 4103, lobby: null, rejoin: true });
    ctx.bus.emit('game:newMission', { seed: 4103, mode: 'raid' });
  });
  let r = await snap();
  ok(!r.gate, 'a rejoin skips the loading gate', JSON.stringify(r));
  ok((await ev('raid:loadProgress')).length === 0, 'no raid:loadProgress on a rejoin');
  await P(() => { const gf = window.__game.getSystem('gameflow'); gf.rejoining = false; window.__game.ctx.rejoinPending = false; });

  await toHub();
  await resetEv();
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'training';
    ctx.bus.emit('game:newMission', { seed: 4104, mode: 'training' });
  });
  r = await snap();
  ok(!r.gate, 'the training range skips the loading gate', JSON.stringify(r));
  ok((await ev('raid:loadProgress')).length === 0, 'no raid:loadProgress on the training range');
  await toHub();

  const pageErrors = errors.filter((e) => !/favicon|WebGL|GPU stall|Deprecation/i.test(e));
  ok(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e && e.message ? e.message : e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
