// 버그 굴착 스폰 (2026-09-13 — src/enemies: Enemy.startEmerge · ai/Burrow · parts/Burrow · fx/BurrowFx) 단독 스모크 — 릴레이 없이 싱글 플레이로 돈다.
// 검사: ① 월드 생성 때의 첫 배치는 파고 나오지 않는다 ② 레이드 중 상시 순찰(AmbientSpawner)은 파고 나온다
//       ③ debugSpawnBurrow: 그림(리그)이 땅속에서 시작 · 분진 방출기 · burrow_emerge 소리 · 가까우면 약한 흔들림
//       ④ 올라오는 동안 맞는다 · 움직이지 않는다 · 공격하지 않는다 ⑤ BURROW_EMERGE_S 뒤 다 올라와 싸운다
//       ⑥ 여러 마리가 한꺼번에 올라와도 흔들림은 한 번 ⑦ 멀면 흔들림이 없다 ⑧ 리플리카 `ee spawn.em` 도 같은 굴착 (em 없으면 없음)
//       ⑨ 지하벌레가 뱉은 몸(startSpat): 와이어 힌트 4 · 포물선 · 착지.
// Usage: node scripts/smoke-burrow.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

// 계약 값은 csv 에서 읽는다 (브라우저 안에서 상수를 import 할 수 없다)
const CONST = Object.fromEntries(readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')).filter((c) => c.length >= 2).map((c) => [c[0], Number(c[1])]));
const EMERGE_S = CONST.BURROW_EMERGE_S;
const SHAKE_RADIUS = CONST.BURROW_SHAKE_RADIUS;
const SHAKE_GAP_S = CONST.BURROW_SHAKE_GAP_S;

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.enemies, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__sys = window.__game.getSystem('enemies');
    window.__V = window.__game.ctx.camera.position.constructor;
    window.__ev = { spawned: [], audio: [], shake: [] };
    const bus = window.__game.ctx.bus;
    bus.on('enemy:spawned', ({ id, type }) => { const e = window.__sys.byId.get(id); window.__ev.spawned.push({ id, type, emergeDur: e ? e.emergeDur : -1, faction: e ? e.faction : '' }); });
    bus.on('audio:play', ({ id }) => window.__ev.audio.push(id));
    bus.on('camera:shake', ({ intensity }) => window.__ev.shake.push(intensity));
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission (seed 41)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => { window.__ev.spawned.length = 0; window.__game.ctx.bus.emit('game:newMission', { seed: 41 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority), 'single-player authority');

  /* ── 1. 첫 배치 ────────────────────────────────────────────────────────── */
  console.log('첫 배치');
  const initial = await P(() => window.__ev.spawned.filter((s) => s.faction === 'bug').map((s) => s.emergeDur));
  ok(initial.length > 0 && initial.every((d) => d === 0), `월드 생성 때의 벌레 ${initial.length}마리는 파고 나오지 않는다`, JSON.stringify(initial.slice(0, 8)));

  /* ── 2. 상시 순찰 ──────────────────────────────────────────────────────── */
  console.log('상시 순찰 (AmbientSpawner)');
  await P(() => { const sys = window.__sys; sys.killAll(); window.__game.ctx.enemies.setThreatLevel(1); window.__ambFrom = window.__ev.spawned.length; });
  let ambient = null;
  for (let k = 0; k < 8 && !ambient; k++) {
    await P(() => { window.__sys.spawner.timer = 0; });
    await waitSim(0.3);
    ambient = await P(() => { const l = window.__ev.spawned.slice(window.__ambFrom).filter((s) => s.faction === 'bug'); return l.length ? l : null; });
  }
  ok(!!ambient && ambient.every((s) => Math.abs(s.emergeDur - EMERGE_S) < 1e-6), `레이드 중 순찰은 BURROW_EMERGE_S(${EMERGE_S}s) 동안 파고 나온다 (${ambient ? ambient.length : 0}마리)`, JSON.stringify(ambient && ambient.slice(0, 4)));
  await P(() => { window.__sys.killAll(); window.__game.ctx.enemies.setThreatLevel(0); window.__sys.spawner.timer = 1e9; });

  /* ── 3. 굴착 시작 ──────────────────────────────────────────────────────── */
  console.log('굴착 시작 (debugSpawnBurrow)');
  await waitSim(SHAKE_GAP_S + 0.2);
  const s3 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    const shakes0 = sys.burrowShakes; const em0 = sys.burrowFx.emergeCount; const a0 = window.__ev.audio.length;
    const e = sys.debugSpawnBurrow('warrior', { x: pp.x + 8, z: pp.z });
    if (!e) return null;
    window.__w = e.id;
    return {
      dur: e.emergeDur, t: e.emergeT, rootY: e.rig.root.position.y, y: e.position.y, h: e.stats.height,
      em: sys.burrowFx.emergeCount - em0, emitters: sys.burrowFx.activeEmitters, shakes: sys.burrowShakes - shakes0,
      audio: window.__ev.audio.slice(a0).includes('burrow_emerge'),
    };
  });
  ok(!!s3 && Math.abs(s3.dur - EMERGE_S) < 1e-6 && s3.t > EMERGE_S * 0.9, `emergeDur = BURROW_EMERGE_S, 시작 직후 emergeT ≈ 전체 (${s3 && s3.t})`);
  ok(!!s3 && s3.rootY < s3.y - s3.h * 0.9, `리그가 몸 높이만큼 땅속에서 시작한다 (root ${s3 && s3.rootY.toFixed(2)} / feet ${s3 && s3.y.toFixed(2)})`);
  ok(!!s3 && s3.em === 1 && s3.emitters > 0, `분진 · 흙덩이 방출기가 선다 (emerge ${s3 && s3.em}, emitters ${s3 && s3.emitters})`);
  ok(!!s3 && s3.audio, '소리 burrow_emerge');
  ok(!!s3 && s3.shakes === 1, `8 m 앞 굴착 = 약한 흔들림 한 번 (BURROW_SHAKE_RADIUS ${SHAKE_RADIUS} m; ${s3 && s3.shakes})`);

  /* ── 4. 올라오는 동안 ──────────────────────────────────────────────────── */
  console.log('올라오는 동안');
  const s4 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const e = sys.byId.get(window.__w);
    const pp = ctx.player.position;
    ctx.player.heal(200);
    e.position.set(pp.x + 1.6, ctx.world.getHeightAt(pp.x + 1.6, pp.z), pp.z);
    e.spawnPos.copy(e.position);
    e.aware = true; e.state = 'chase';
    const hp0 = e.hp;
    e.takeDamage(20, undefined, undefined, 'local');
    window.__w4 = { px: e.position.x, pz: e.position.z, hp: ctx.player.hp, sh: ctx.player.shield ?? 0, attacked: 0 };
    ctx.bus.on('enemy:attacked', ({ id }) => { if (id === e.id) window.__w4.attacked++; });
    return { hit: hp0 - e.hp };
  });
  ok(s4.hit > 0, `올라오는 동안에도 맞는다 (−${s4.hit})`);
  await waitSim(Math.min(0.6, EMERGE_S * 0.5));
  const s4b = await P(() => {
    const e = window.__sys.byId.get(window.__w); const w = window.__w4;
    return { t: e.emergeT, moved: Math.hypot(e.position.x - w.px, e.position.z - w.pz), attacked: w.attacked };
  });
  ok(s4b.t > 0 && s4b.moved < 0.05, `올라오는 동안 움직이지 않는다 (emergeT ${s4b.t.toFixed(2)}, moved ${s4b.moved.toFixed(3)})`);
  ok(s4b.attacked === 0, '올라오는 동안 공격하지 않는다');

  /* ── 5. 다 올라온 뒤 ───────────────────────────────────────────────────── */
  console.log('다 올라온 뒤');
  await waitSim(EMERGE_S * 0.6);
  const s5 = await P(() => { const e = window.__sys.byId.get(window.__w); return { t: e.emergeT, dur: e.emergeDur, dy: Math.abs(e.rig.root.position.y - e.position.y) }; });
  ok(s5.t === 0 && s5.dur === 0 && s5.dy < 0.3, `다 올라왔다 (emergeT ${s5.t}, root−feet ${s5.dy.toFixed(2)})`);
  await waitSim(1.6);
  const s5b = await P(() => window.__w4.attacked);
  ok(s5b > 0, `다 올라온 뒤에는 공격한다 (enemy:attacked ×${s5b})`);
  await P(() => { const e = window.__sys.byId.get(window.__w); if (e && e.state !== 'dead') e.kill(false); window.__game.ctx.player.heal(200); });

  /* ── 6. 흔들림 중복 없음 ───────────────────────────────────────────────── */
  console.log('흔들림은 겹치지 않는다');
  await waitSim(SHAKE_GAP_S + 0.2);
  const s6 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    const s0 = sys.burrowShakes; const ids = [];
    for (let i = 0; i < 6; i++) { const e = sys.debugSpawnBurrow('scavenger', { x: pp.x + 10 + i, z: pp.z + 6 }); if (e) ids.push(e.id); }
    window.__many = ids;
    return { n: ids.length, d: sys.burrowShakes - s0 };
  });
  ok(s6.n === 6 && s6.d === 1, `여섯 마리가 한 프레임에 올라와도 흔들림은 한 번 (${s6.d})`);
  await waitSim(SHAKE_GAP_S + 0.2);
  const s7 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    const s0 = sys.burrowShakes;
    let x = pp.x + 70, z = pp.z;
    if (!ctx.world.isInsideBounds(x, z)) x = pp.x - 70;
    const e = sys.debugSpawnBurrow('scavenger', { x, z });
    return { spawned: !!e, d: sys.burrowShakes - s0 };
  });
  ok(s7.spawned && s7.d === 0, `70 m 밖 굴착은 흔들지 않는다 (${s7.d})`);
  await P(() => { const sys = window.__sys; for (const e of sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

  /* ── 8. 리플리카 ───────────────────────────────────────────────────────── */
  console.log('리플리카 (ee spawn.em)');
  const s8 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    sys.setAuthority(false);
    const c0 = sys.burrowFx.emergeCount;
    const x = pp.x + 9, z = pp.z + 3;
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spawn', id: 900001, ty: 'hunter', p: [x, ctx.world.getHeightAt(x, z), z], yaw: 0, em: 1 });
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spawn', id: 900002, ty: 'hunter', p: [x + 3, ctx.world.getHeightAt(x + 3, z), z], yaw: 0 });
    const a = sys.byId.get(900001); const b = sys.byId.get(900002);
    return { a: a ? a.emergeT : -1, b: b ? b.emergeT : -1, count: sys.burrowFx.emergeCount - c0 };
  });
  ok(s8.a > 0.9 && s8.count === 1, `리플리카가 em 을 받아 같은 굴착을 시작한다 (emergeT ${s8.a}, fx ${s8.count})`);
  ok(s8.b === 0, 'em 이 없는 ee spawn 은 바로 선다');
  await waitSim(1.3);
  const s8b = await P(() => { const a = window.__sys.byId.get(900001); return a ? a.emergeT : -1; });
  ok(s8b === 0, `리플리카도 1초 뒤 다 올라온다 (${s8b})`);
  await P(() => { window.__sys.setAuthority(true); for (const e of window.__sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

  /* ── 9. 뱉어진 몸 ──────────────────────────────────────────────────────── */
  console.log('뱉어진 몸 (startSpat)');
  const s9 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V; const pp = ctx.player.position;
    let bx = pp.x + 20; if (!ctx.world.isInsideBounds(bx, pp.z)) bx = pp.x - 20;
    const e = sys.debugSpawn('scavenger', { x: bx, z: pp.z });
    if (!e) return null;
    const from = new V(e.position.x, e.position.y + 8, e.position.z);
    const tx = bx + (bx > pp.x ? 6 : -6), tz = pp.z + 2;
    const to = new V(tx, ctx.world.getHeightAt(tx, tz), tz);
    // 착지 순간의 위치를 잡는다 — 착지하자마자 chase 로 달려 나가므로 1 초 뒤에 재면 이미 몇 m 옮겨 가 있다 (리드 2026-09-13)
    window.__sp = { id: e.id, to: [to.x, to.y, to.z], landed: null };
    if (!sys.__landWrap) {
      const orig = sys.burrowLanded.bind(sys);
      sys.burrowLanded = (b) => { if (window.__sp && b.id === window.__sp.id && !window.__sp.landed) window.__sp.landed = [b.position.x, b.position.z]; orig(b); };
      sys.__landWrap = true;
    }
    e.startSpat(from, to, 1.1);
    return { hint: sys.debugHint(e.id), airborne: e.airborne };
  });
  ok(!!s9 && s9.hint === 4 && s9.airborne, `날아가는 몸은 와이어 힌트 4 (airborne) (${s9 && s9.hint})`);
  await waitSim(0.5);
  const s9b = await P(() => { const ctx = window.__game.ctx; const e = window.__sys.byId.get(window.__sp.id); return { air: e.airborne, t: e.spatT, above: e.position.y - ctx.world.getHeightAt(e.position.x, e.position.z) }; });
  ok(s9b.air && s9b.t > 0 && s9b.above > 0.5, `포물선 한가운데 (spatT ${s9b.t.toFixed(2)}, 땅 위 ${s9b.above.toFixed(2)} m)`);
  await waitSim(1.0);
  const s9c = await P(() => { const e = window.__sys.byId.get(window.__sp.id); const to = window.__sp.to; const L = window.__sp.landed; return { air: e.airborne, t: e.spatT, d: L ? Math.hypot(L[0] - to[0], L[1] - to[2]) : 99, hint: window.__sys.debugHint(e.id), state: e.state }; });
  ok(!s9c.air && s9c.t === 0 && s9c.d < 0.8 && s9c.hint !== 4, `착지점에 내려앉는다 (d ${s9c.d.toFixed(2)}, hint ${s9c.hint}, ${s9c.state})`);

  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'back to hub', 20000);
  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
