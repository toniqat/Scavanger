// 2026-09-10 — 씬의 광원 개수 감시. three.js 는 `projectObject` 에서 보이지 않는 가지를 통째로 건너뛰므로
// 숨긴 그룹 · 씬 밖의 광원은 세지 않는다. 그 개수가 **플레이 중에** 바뀌면 그 프레임에 씬의 모든 머티리얼이
// 셰이더를 다시 컴파일한다 — 한 프레임이 통째로 멈춘다 (2026-09-10 "함선 도착 렉" 의 정체).
//
// 이 스크립트는 세션을 처음부터 끝까지 돌리면서 매 프레임 개수를 세고, **숫자가 한 번이라도 바뀌면 실패**한다.
// (2차, 2026-09-10) 예전에는 로드 경계(허브 구축 · 미션 시작)를 허용했지만 이제 `core/LightBudget` 이 여분 광원으로
// 개수를 세션 내내 고정하므로 경계도 예외가 아니다 — 멀티에서 도킹 · 강하가 몇 초씩 멈추던 것이 바로 그 경계였다.
// 함선 ↔ 도킹 컷씬 ↔ 공유 함선 · 격납고 ↔ 행성, 분대원 포드 강하까지 돈다. 진짜 광원이 예산 안인지도 본다.
// 지금까지 이 그물에 걸린 것: 탈출 함선 · 신호탄 · 헬포드 · 분대장 기기 · 원격 포드 · 함선 인테리어 (6).
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
    // 2026-09-10 2차: 세는 시점은 **그리는 순간**이다 (`scene.onBeforeRender` — three.js 가 광원을 모으기 직전).
    // 타이머로 세면 전환(네트워크 메시지 핸들러 안의 도킹 시작 등)과 다음 프레임의 여분 광원 보충 사이 — 아무것도
    // 그려지지 않는 틈 — 까지 잡아서, 셰이더가 한 번도 보지 않은 숫자로 실패한다.
    let prev = -1;
    const scene = window.__game.ctx.scene;
    const prevHook = scene.onBeforeRender;
    scene.onBeforeRender = function (...args) {
      const n = window.__count();
      if (n !== prev) { window.__log.push({ mark: window.__mark, phase: window.__game.ctx.phase, from: prev, to: n }); prev = n; }
      return prevHook.apply(this, args);
    };
    window.__ev = { landed: 0 };
    window.__game.ctx.bus.on('extraction:shipLanded', () => window.__ev.landed++);
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const mark = (m) => P((m) => { window.__mark = m; }, m);
  const waitSim = async (s) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${s}s`, 180000, t0 + s); };

  // 진짜 점광원(여분 제외)이 `SCENE_POINT_LIGHT_BUDGET` 안이어야 여분이 개수를 붙잡을 수 있다
  const budgetOk = async (label) => {
    const b = await P(() => {
      const L = window.__game.lights;
      return L ? { content: L.contentCount(), budget: L.budget, pads: L.padsShown } : null;
    });
    ok(!!b && b.content <= b.budget, `${label}: 진짜 점광원이 예산 안이다 (${b && b.content} ≤ ${b && b.budget}, 여분 ${b && b.pads})`, JSON.stringify(b));
  };

  console.log('세션 한 바퀴를 돌면서 씬의 광원 개수를 감시한다');
  await mark('hub');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitSim(1.0);
  await budgetOk('개인 함선');

  // 도킹 → 공유 함선 · 격납고 → 도킹 해제. 릴레이가 필요하다 (`npm run verify` 러너가 띄운다)
  const online = await waitFor(page, () => window.__game.ctx.net?.connected, 'relay', 10000).then(() => true, () => false);
  if (!online) {
    console.log('  skip 도킹 구간 (릴레이 없음 — 단독 실행)');
  } else {
    await mark('docking');
    await P(() => window.__game.ctx.net.createLobby());
    await waitFor(page, () => window.__game.ctx.phase === 'docking', 'docking', 15000);
    await waitFor(page, () => !!window.__game.getSystem('hub').pendingInterior, 'prebuilt ship', 10000).catch(() => null);
    ok(await P(() => !!window.__game.getSystem('hub').pendingInterior), '도킹 컷씬 도중에 도착할 함선을 미리 짓는다 (pendingInterior)');
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'shared ship', 30000);
    ok(await P(() => window.__game.getSystem('hub').pendingInterior === null), '도착하면 미리 지은 함선을 쓰고 비운다');
    await waitSim(1.0);
    await budgetOk('공유 함선');
    await mark('격납고');
    await P(() => { const c = window.__game.ctx; const V = c.player.position.constructor; c.player.teleport(new V(0, 0, 20), Math.PI, true); });
    await waitSim(1.5);
    const zone = await P(() => {
      const pool = window.__game.getSystem('hub').interior.lights;
      return pool.assignment.map((i) => (i >= 0 ? pool.fixtureList[i].zone : null));
    });
    ok(zone.length > 0 && zone.every((z) => z === 1), `격납고에 서면 풀 광원이 전부 격납고 자리에 걸린다 ${JSON.stringify(zone)}`);
    await mark('undock');
    await P(() => window.__game.ctx.net.leaveLobby());
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'personal', 'undock', 30000);
    await waitSim(1.0);
  }

  await mark('mission-start');
  await P(() => { const c = window.__game.ctx; c.missionMode = 'raid'; c.bus.emit('game:newMission', { seed: 77 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  ok(await P(() => window.__game.shaders && window.__game.shaders.holding === false), '강하 셰이더 hold 가 풀렸다');
  await mark('playing');
  await waitSim(3.0);
  await budgetOk('레이드');

  // 분대장 기기의 광원은 기기 안이 아니라 씬에 미리 심겨 있어야 한다 (`game/parts/Leader`)
  const led = await P(() => {
    const l = window.__game.ctx.scene.getObjectByName('LeaderDeviceLight');
    return l ? { found: true, intensity: l.intensity } : { found: false };
  });
  ok(led.found && led.intensity === 0, '분대장 기기 광원이 init 때 씬에 심겨 있다 (intensity 0)', JSON.stringify(led));

  // 분대원 포드: 예전에는 처음 강하하는 분대원마다 `new Hellpod()` 가 씬에 들어가 전부 재컴파일했다 (실측 2.7 · 3.1초)
  await mark('분대원 포드 강하 (새 peer 둘)');
  const podCount = await P(() => {
    const pods = window.__game.getSystem('remotePlayers')?.pods;
    if (!pods) return null;
    const c = window.__game.ctx; const p = c.player.position.clone(); p.x += 10;
    pods.drop(c, 'smoke-peer-1', p, 0, 1);
    p.z += 6;
    pods.drop(c, 'smoke-peer-2', p, 0, 1);
    return pods.count;
  });
  ok(podCount === 2, `분대원 포드 둘이 배정된다 (count ${podCount})`);
  await waitSim(4.0);

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
  // 허용: 첫 집계(-1) 하나. 로드 경계도 예외가 아니다 (2026-09-10 2차 — `core/LightBudget`).
  const bad = log.filter((e) => e.from >= 0);
  ok(bad.length === 0, '세션 내내 씬의 광원 개수가 한 번도 바뀌지 않는다 (함선 · 도킹 · 행성 · 포드 포함)',
    bad.map((e) => `${e.from}→${e.to} @ ${e.mark}`).join(' | '));
  ok(log.length >= 1, '감시 자체가 돌았다 (첫 집계가 잡힌다)', JSON.stringify(log.length));

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
