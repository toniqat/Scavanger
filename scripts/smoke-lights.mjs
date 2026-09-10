// 2026-09-10 — 씬의 광원 개수 감시. three.js 는 `projectObject` 에서 보이지 않는 가지를 통째로 건너뛰므로
// 숨긴 그룹 · 씬 밖의 광원은 세지 않는다. 그 개수가 **플레이 중에** 바뀌면 그 프레임에 씬의 모든 머티리얼이
// 셰이더를 다시 컴파일한다 — 한 프레임이 통째로 멈춘다 (2026-09-10 "함선 도착 렉" 의 정체).
//
// 이 스크립트는 레이드를 처음부터 끝까지 돌리면서 매 프레임 개수를 세고, **로드 경계가 아닌 곳에서 숫자가
// 바뀌면 실패**한다. 로드 경계(허브 구축 · 미션 시작)는 원래 한 번 멎는 자리라 허용한다.
// 지금까지 이 그물에 걸린 것: 탈출 함선 · 신호탄 · 헬포드 · 분대장 기기.
//
// Usage: node scripts/smoke-lights.mjs [http://localhost:5273]   (needs a running vite)
import puppeteer from 'puppeteer-core';
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
const ok = (c, l, x = '') => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__mark = 'boot';
    window.__log = [];
    // exactly what `WebGLRenderer.projectObject` would collect
    window.__count = () => { let n = 0; window.__game.ctx.scene.traverseVisible((o) => { if (o.isLight && !o.isAmbientLight) n++; }); return n; };
    let prev = -1;
    setInterval(() => {
      const n = window.__count();
      if (n !== prev) { window.__log.push({ mark: window.__mark, phase: window.__game.ctx.phase, from: prev, to: n }); prev = n; }
    }, 16);
    window.__ev = { landed: 0 };
    window.__game.ctx.bus.on('extraction:shipLanded', () => window.__ev.landed++);
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const mark = (m) => P((m) => { window.__mark = m; }, m);
  const waitSim = async (s) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${s}s`, 180000, t0 + s); };

  console.log('레이드 한 판을 돌면서 씬의 광원 개수를 감시한다');
  await mark('hub');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitSim(1.0);

  await mark('mission-start');
  await P(() => { const c = window.__game.ctx; c.missionMode = 'raid'; c.bus.emit('game:newMission', { seed: 77 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  await mark('playing');
  await waitSim(3.0);

  // 분대장 기기의 광원은 기기 안이 아니라 씬에 미리 심겨 있어야 한다 (`game/parts/Leader`)
  const led = await P(() => {
    const l = window.__game.ctx.scene.getObjectByName('LeaderDeviceLight');
    return l ? { found: true, intensity: l.intensity } : { found: false };
  });
  ok(led.found && led.intensity === 0, '분대장 기기 광원이 init 때 씬에 심겨 있다 (intensity 0)', JSON.stringify(led));

  // 재접속 복귀 → `hellpod.hide()`, 이어서 구조선 강하 → `hellpod.start()`.
  // 고치기 전에는 이 둘이 광원 개수를 1 내렸다가 1 올렸다 (= 전체 셰이더 재컴파일 2회).
  await mark('rejoin restoreState (hellpod.hide)');
  await P(() => {
    const c = window.__game.ctx;
    c.player.restoreState({ hp: 80, state: 'alive', position: c.player.position.clone(), yaw: 0 });
  });
  await waitSim(1.5);
  await mark('rescue drop (hellpod.start)');
  await P(() => { const c = window.__game.ctx; const p = c.player.position.clone(); p.x += 6; c.bus.emit('player:respawn', { position: p }); });
  await waitSim(6.0);

  await mark('extraction: 신호탄');
  await P(() => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getExtractionPoints();
    ctx.player.teleport(pts[0].position.clone());
    ctx.interactables.all().find((i) => i.id.startsWith('extract_')).interact();
  });
  await waitSim(0.6);
  await mark('extraction: 함선 접근');
  await P(() => { window.__game.getSystem('extraction').countdown = 12.5; });
  await waitFor(page, () => window.__ev.landed > 0, 'shipLanded', 60000);
  await mark('extraction: 착륙');
  await waitSim(2.0);
  await mark('extraction: 이륙');
  await P(() => {
    const sys = window.__game.getSystem('extraction'), ctx = window.__game.ctx;
    const p = new (sys.ship.root.position.constructor)(0, 0, -2.5).applyMatrix4(sys.ship.root.matrixWorld);
    ctx.player.teleport(p, undefined, false);
  });
  await waitSim(0.6);
  await P(() => window.__game.getSystem('extraction').liftoff());
  await waitSim(5.0);
  await mark('done');
  await waitSim(1.0);

  const log = await P(() => window.__log);
  console.log('  광원 개수가 바뀐 지점:');
  for (const e of log) console.log(`    ${String(e.from).padStart(3)} → ${String(e.to).padStart(3)}   [${e.phase}] ${e.mark}`);
  // 허용: 첫 집계(-1)와 로드 경계(허브 구축 · 미션 시작). 그 밖은 전부 실패다.
  const bad = log.filter((e) => e.from >= 0 && e.mark !== 'hub' && e.mark !== 'mission-start');
  ok(bad.length === 0, '플레이 중에는 씬의 광원 개수가 한 번도 바뀌지 않는다',
    bad.map((e) => `${e.from}→${e.to} @ ${e.mark}`).join(' | '));
  ok(log.length >= 2, '감시 자체가 돌았다 (로드 경계에서는 숫자가 잡힌다)', JSON.stringify(log.length));

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
