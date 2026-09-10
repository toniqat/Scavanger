// 사다리 · 단차 보간 · 월드 천장 스모크 (2026-09-11).
//
// 왜 있나: 사다리는 `world/` 가 구조물 안에 세우고 `player/` 가 매달린다. 이 스크립트는 **player 쪽**만 본다 —
// world 의 사다리를 기다리지 않고 가짜 `LadderDef` 를 만들어 `ladder:grab` 을 직접 낸다 (world 가 E 로 내는 것과
// 같은 이벤트). 수치는 `data/constants.csv` 에서 읽으므로 밸런스를 바꿔도 스크립트는 그대로다.
//
// 검사:
//   1. 발치에서 잡기 → `climbingLadder` · `player:climbChanged {id}` 한 번 · 몸이 base XZ · 무기 잠금 · CLIMBING 비트 ·
//      오르기 블렌드 · 무기 소켓 숨김
//   2. 발치에서 S → 접지로 내려섬
//   3. W ≈ LADDER_CLIMB_SPEED, 가로대 소리
//   4. Shift+W ≈ LADDER_SPRINT_SPEED, 스태미나가 준다
//   5. 계속 W → 꼭대기 올라서기가 exit 에서 접지로 끝난다
//   6. 꼭대기에서 잡기 → 발 topY − 1.1, E → normal 쪽으로 떨어진다
//   7. 점프 → 위로 LADDER_JUMP_SPEED × 점프 배율, -normal 로 LADDER_JUMP_PUSH, 스태미나 STAMINA_JUMP_COST
//   8. 단차 보간: 접지 상태에서 높이가 한 프레임에 튀면 bodyOffset.y 가 쌓였다가 감쇠한다
//   9. 월드 천장: 천장 있는 구조물이 있으면 실내 점프의 머리가 천장 아래에서 멈추고 옆으로 밀려나지 않는다 (없으면 건너뜀)
//  10. 매달린 채 사망 → 놓는다
//
// Usage: node scripts/smoke-ladder.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEED = 21;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/** `data/constants.csv` 의 숫자 하나. */
const CSV = readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8');
function k(name) {
  const m = CSV.match(new RegExp(`^${name},([^,\\r\\n]+)`, 'm'));
  if (!m) throw new Error(`constant ${name} missing`);
  return Number(m[1]);
}
const C = {
  CLIMB: k('LADDER_CLIMB_SPEED'), SPRINT: k('LADDER_SPRINT_SPEED'), DRAIN: k('LADDER_SPRINT_DRAIN'),
  JUMP: k('LADDER_JUMP_SPEED'), PUSH: k('LADDER_JUMP_PUSH'), DROP: k('LADDER_DROP_PUSH'),
  HEIGHT: k('PLAYER_HEIGHT'),
};
const k_GRAVITY = k('GRAVITY');
const CLIMBING_BIT = 1 << 29;   // shared/net.ts PlayerFlags.CLIMBING
const LADDER_H = 4;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}
/** 시뮬레이션 시간으로 기다린다 (dt 는 50 ms 로 잘린다). */
async function waitSim(page, seconds) {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${seconds}s`, 120000, t0 + seconds);
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
        // vite HMR (a reload would kill the run) and the relay (a real profile must not arrive mid-run)
        if (protos.includes('vite-hmr') || String(args[0]).includes('/ws')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), SEED);
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
  await waitFor(page, () => { const p = window.__game.ctx.player; return p.spawned && p.controlsEnabled && !p.isDropping && p.isGrounded; }, 'landed', 40000);
  await waitSim(page, 0.5);

  const key = (type, code) => page.evaluate(([t, c]) => { document.body.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true })); }, [type, code]);
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const state = () => page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, sys = window.__game.getSystem('player');
    return {
      t: ctx.time, id: p.climbingLadder ?? null, x: p.position.x, y: p.position.y, z: p.position.z,
      vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z, grounded: p.isGrounded, stamina: p.stamina,
      canUse: p.canUseWeapons(), blend: sys.climbBlend, socket: sys.model.weaponSocket.visible,
      offY: sys.bodyOffset.y, rung: window.__rung, ev: window.__climbEv.length, mount: sys.controller.climbMount,
    };
  });

  // 이벤트 기록 + 사다리를 스폰 지점에 세운다 (발치 = 지면, 위로 LADDER_H, normal +Z, exit = 사다리 너머 0.9 m)
  const L = await page.evaluate((h) => {
    const ctx = window.__game.ctx;
    const V3 = ctx.camera.position.constructor;
    window.__climbEv = [];
    window.__rung = 0;
    ctx.bus.on('player:climbChanged', (e) => {
      const p = ctx.player;
      window.__climbEv.push({ id: e.ladderId, t: ctx.time, x: p.position.x, y: p.position.y, z: p.position.z,
        vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z, grounded: p.isGrounded, stamina: p.stamina });
    });
    ctx.bus.on('audio:play', (e) => { if (e.id === 'ladder_step') window.__rung++; });
    const p = ctx.player.position;
    const g = ctx.world.getSurfaceY(p.x, p.z, p.y);
    window.__ladder = {
      id: 'ladder_smoke_0', base: new V3(p.x, g, p.z), topY: g + h, normal: new V3(0, 0, 1),
      exit: new V3(p.x, g + h, p.z - 0.9),
    };
    window.__grab = (from) => ctx.bus.emit('ladder:grab', { ladder: window.__ladder, from });
    const l = window.__ladder;
    return { bx: l.base.x, by: l.base.y, bz: l.base.z, top: l.topY, ex: l.exit.x, ey: l.exit.y, ez: l.exit.z };
  }, LADDER_H);

  /* ── 1. 발치에서 잡기 ─────────────────────────────────────────────────── */
  console.log('grab (bottom)');
  await page.evaluate(() => window.__grab('bottom'));
  let s = await state();
  ok(s.id === 'ladder_smoke_0', 'climbingLadder is the ladder id right after ladder:grab', JSON.stringify(s));
  ok(s.ev === 1 && (await page.evaluate(() => window.__climbEv[0].id)) === 'ladder_smoke_0', 'one player:climbChanged {ladderId}');
  ok(Math.abs(s.x - L.bx) < 1e-3 && Math.abs(s.z - L.bz) < 1e-3, 'body XZ locked to the ladder base');
  ok(s.canUse === false, 'canUseWeapons() is false while hanging');
  const snapBit = await page.evaluate(() => {
    const net = window.__game.getSystem('net');
    if (!net || !net.snapshotter) return -1;
    const m = net.snapshotter.build(window.__game.ctx);
    return m ? m.f : -1;
  });
  if (snapBit === -1) console.log('  skip snapshot bit (no NetSystem snapshotter)');
  else ok((snapBit & CLIMBING_BIT) !== 0, 'Snapshotter sets PlayerFlags.CLIMBING');
  await page.evaluate(() => window.__grab('bottom'));
  ok((await state()).ev === 1, 'a second ladder:grab while hanging is ignored (no extra event)');
  await waitSim(page, 0.4);
  s = await state();
  ok(s.id === 'ladder_smoke_0' && Math.abs(s.y - L.by) < 0.05, `hangs still without input (y ${s.y.toFixed(2)} vs base ${L.by.toFixed(2)})`);
  ok(s.blend > 0.8, `climb pose blend rises (${s.blend.toFixed(2)})`);
  ok(s.socket === false, 'weapon socket hidden while climbing');
  ok(s.grounded === false, 'not grounded while hanging (no landing logic)');

  /* ── 2. 발치에서 S ─────────────────────────────────────────────────────── */
  console.log('S at the bottom');
  await key('keydown', 'KeyS');
  await waitSim(page, 0.2);
  await key('keyup', 'KeyS');
  s = await state();
  const evBottom = await page.evaluate(() => window.__climbEv[window.__climbEv.length - 1]);
  ok(s.id === null && evBottom.id === null && s.ev === 2, 'S at the base releases the ladder (one null event)', JSON.stringify(evBottom));
  ok(evBottom.grounded === true && Math.abs(evBottom.y - L.by) < 0.05, 'released onto the floor, grounded');
  await waitSim(page, 0.3);
  s = await state();
  ok(s.canUse === true, 'weapons usable again on the ground');

  /* ── 3. W ≈ LADDER_CLIMB_SPEED ─────────────────────────────────────────── */
  console.log('climb (W)');
  await page.evaluate(() => window.__grab('bottom'));
  await waitSim(page, 0.1);
  const rung0 = (await state()).rung;
  await key('keydown', 'KeyW');
  await waitSim(page, 0.15);
  let a = await state();
  await waitSim(page, 0.5);
  let b = await state();
  await key('keyup', 'KeyW');
  const climbSpeed = (b.y - a.y) / (b.t - a.t);
  ok(Math.abs(climbSpeed - C.CLIMB) < C.CLIMB * 0.2, `W climbs at ≈ LADDER_CLIMB_SPEED (${climbSpeed.toFixed(2)} vs ${C.CLIMB})`);
  ok(b.id === 'ladder_smoke_0' && Math.abs(b.x - L.bx) < 1e-3 && Math.abs(b.z - L.bz) < 1e-3, 'still on the ladder, XZ locked');
  ok(b.rung - rung0 >= 2, `ladder_step played per rung (${b.rung - rung0})`);

  /* ── 4. Shift+W ─────────────────────────────────────────────────────────── */
  console.log('fast climb (Shift+W)');
  await key('keydown', 'ShiftLeft');
  await key('keydown', 'KeyW');
  await waitSim(page, 0.1);
  a = await state();
  await waitSim(page, 0.3);
  b = await state();
  await key('keyup', 'KeyW');
  await key('keyup', 'ShiftLeft');
  const fastSpeed = (b.y - a.y) / (b.t - a.t);
  ok(Math.abs(fastSpeed - C.SPRINT) < C.SPRINT * 0.2, `Shift+W climbs at ≈ LADDER_SPRINT_SPEED (${fastSpeed.toFixed(2)} vs ${C.SPRINT})`);
  const drained = a.stamina - b.stamina;
  ok(drained > C.DRAIN * (b.t - a.t) * 0.6, `fast climbing drains stamina (${drained.toFixed(1)} over ${(b.t - a.t).toFixed(2)} s)`);

  /* ── 5. 꼭대기 올라서기 ─────────────────────────────────────────────────── */
  console.log('mount at the top');
  const evBefore = (await state()).ev;
  await key('keydown', 'KeyW');
  const sawMount = await waitFor(page, () => window.__game.getSystem('player').controller.climbMount >= 0 || window.__game.ctx.player.climbingLadder === null, 'mount start', 20000);
  await waitFor(page, () => window.__game.ctx.player.climbingLadder === null, 'mount end', 20000);
  await key('keyup', 'KeyW');
  const evTop = await page.evaluate(() => window.__climbEv[window.__climbEv.length - 1]);
  ok(!!sawMount && (await state()).ev === evBefore + 1, 'reaching the top ends in exactly one null event');
  ok(Math.hypot(evTop.x - L.ex, evTop.z - L.ez) < 0.05 && Math.abs(evTop.y - L.ey) < 0.05 && evTop.grounded,
    `mount ends at exit, grounded (Δxz ${Math.hypot(evTop.x - L.ex, evTop.z - L.ez).toFixed(3)}, y ${evTop.y.toFixed(2)} / ${L.ey.toFixed(2)})`);
  // the fabricated exit is mid-air over open terrain: the body falls back down
  await waitFor(page, () => window.__game.ctx.player.isGrounded && window.__game.ctx.player.position.y < window.__ladder.base.y + 1, 'fell back to the ground', 20000);

  /* ── 6. 꼭대기에서 잡기 + E ─────────────────────────────────────────────── */
  console.log('grab (top) + E');
  await page.evaluate(() => window.__grab('top'));
  s = await state();
  ok(s.id === 'ladder_smoke_0' && Math.abs(s.y - (L.top - 1.1)) < 0.02, `grab from the top hangs the feet at topY − 1.1 (${(s.y - L.by).toFixed(2)} m up)`);
  await waitSim(page, 0.2);
  await tap('KeyE');
  await waitFor(page, () => window.__game.ctx.player.climbingLadder === null, 'E release', 5000);
  const evDrop = await page.evaluate(() => window.__climbEv[window.__climbEv.length - 1]);
  ok(evDrop.id === null && !evDrop.grounded, 'E lets go (not grounded)');
  ok(Math.abs(evDrop.vz - C.DROP) < 0.05 && Math.abs(evDrop.vx) < 0.05, `drop push along +normal (vz ${evDrop.vz.toFixed(2)} vs ${C.DROP})`);
  await waitSim(page, 0.3);
  s = await state();
  ok(s.y < evDrop.y - 0.3, `the body falls after E (${evDrop.y.toFixed(2)} → ${s.y.toFixed(2)})`);
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'landed after drop', 20000);
  await waitSim(page, 1.2);   // let stamina regen a bit

  /* ── 7. 점프 ─────────────────────────────────────────────────────────────── */
  console.log('jump off the ladder');
  await page.evaluate(() => window.__grab('top'));
  await waitSim(page, 0.2);
  const staminaBefore = (await state()).stamina;
  await tap('Space');
  await waitFor(page, () => window.__game.ctx.player.climbingLadder === null, 'jump release', 5000);
  const evJump = await page.evaluate(() => window.__climbEv[window.__climbEv.length - 1]);
  const jumpMul = await page.evaluate(() => window.__game.getSystem('player').controller.jumpSpeedMul);
  ok(Math.abs(evJump.vy - C.JUMP * jumpMul) < 0.05, `jump leaps up at LADDER_JUMP_SPEED × jump mul (${evJump.vy.toFixed(2)} vs ${(C.JUMP * jumpMul).toFixed(2)})`);
  ok(Math.abs(evJump.vz + C.PUSH) < 0.05, `jump pushes over the ladder (-normal, vz ${evJump.vz.toFixed(2)})`);
  await waitSim(page, 0.1);
  s = await state();
  ok(s.y > evJump.y && s.vy < evJump.vy, 'rising after the jump, gravity applies');
  ok(staminaBefore - s.stamina >= 11, `jump costs the normal jump stamina (${(staminaBefore - s.stamina).toFixed(1)})`);
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'landed after jump', 20000);
  await waitSim(page, 0.6);

  /* ── 8. 단차 보간 ────────────────────────────────────────────────────────── */
  console.log('step smoothing');
  const step = await page.evaluate(() => new Promise((resolve) => {
    const sys = window.__game.getSystem('player');
    const c = sys.controller;
    const before = c.position.y;
    c.position.y += 0.3;   // a one-frame 0.3 m discontinuity; the ground snap takes it back inside `update`
    let maxOff = 0, maxRoot = 0, frames = 0;
    const tick = () => {
      maxOff = Math.max(maxOff, sys.bodyOffset.y);
      maxRoot = Math.max(maxRoot, sys.model.root.position.y - c.position.y);
      if (++frames < 90) requestAnimationFrame(tick);
      else resolve({ maxOff, maxRoot, end: sys.bodyOffset.y, dy: c.position.y - before });
    };
    requestAnimationFrame(tick);
  }));
  ok(Math.abs(step.dy) < 0.05, `the physics position snapped back to the ground (Δ ${step.dy.toFixed(3)})`);
  ok(step.maxOff > 0.1 && step.maxRoot > 0.05, `the model keeps the old height for a moment (offset ${step.maxOff.toFixed(2)}, root ${step.maxRoot.toFixed(2)})`);
  ok(Math.abs(step.end) < 0.02, `…and settles onto the feet (${step.end.toFixed(3)})`);

  /* ── 9. 월드 천장 ─────────────────────────────────────────────────────────── */
  console.log('world ceiling clamp');
  const room = await page.evaluate((H) => {
    const ctx = window.__game.ctx, w = ctx.world;
    if (typeof w.getStructures !== 'function') return null;
    const V3 = ctx.camera.position.constructor;
    const o = new V3(), up = new V3(0, 1, 0);
    // prefer the lowest standable ceiling: under ~3.3 m a free jump (apex ≈ 1.2 m) would push feet + 2.1 into the
    // slab, so the clamp has to engage there — a 3.6 m room only proves nothing shoves the body
    let best = null;
    for (const st of w.getStructures()) {
      for (const [dx, dz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [2.5, 2.5], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5]]) {
        const x = st.position.x + dx, z = st.position.z + dz;
        const ground = w.getHeightAt(x, z);
        const floor = w.getSurfaceY(x, z, ground + 0.6);
        o.set(x, floor + 0.6, z);
        const hit = w.raycast(o, up, 6);
        if (!hit) continue;
        const ceil = o.y + hit.distance;
        if (ceil - floor < 2.1 + 0.1 || ceil - floor > H + 2.2) continue;   // standable, and a jump must reach it
        if (!best || ceil - floor < best.ceil - best.floor) best = { x, z, floor, ceil };
      }
    }
    return best;
  }, C.HEIGHT);
  if (!room) {
    console.log('  skip (no structure with a reachable ceiling in this seed)');
  } else {
    const placed = await page.evaluate((r) => {
      const ctx = window.__game.ctx, V3 = ctx.camera.position.constructor;
      ctx.player.teleport(new V3(r.x, r.floor + 0.02, r.z), undefined, false);
      return true;
    }, room);
    await waitSim(page, 0.4);
    const rest = await state();
    const pushed = Math.hypot(rest.x - room.x, rest.z - room.z);
    if (!placed || pushed > 0.2 || !rest.grounded) {
      console.log(`  skip (spot not free: pushed ${pushed.toFixed(2)} m, grounded ${rest.grounded})`);
    } else {
      const jump = await page.evaluate(() => new Promise((resolve) => {
        const ctx = window.__game.ctx, p = ctx.player, w = ctx.world;
        const V3 = ctx.camera.position.constructor, o = new V3(), up = new V3(0, 1, 0);
        const x0 = p.position.x, z0 = p.position.z;
        let maxY = p.position.y, maxSide = 0, frames = 0;
        const trace = [];
        document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: 'Space', bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: 'Space', bubbles: true }));
        const tick = () => {
          maxY = Math.max(maxY, p.position.y);
          maxSide = Math.max(maxSide, Math.hypot(p.position.x - x0, p.position.z - z0));
          if (frames < 24) {
            o.set(p.position.x, p.position.y + 0.6, p.position.z);
            const h = w.raycast(o, up, 6);
            trace.push(`${ctx.time.toFixed(2)} y${p.position.y.toFixed(2)} vy${p.velocity.y.toFixed(1)} x${(p.position.x - x0).toFixed(2)} z${(p.position.z - z0).toFixed(2)} g${p.isGrounded ? 1 : 0} up${h ? (o.y + h.distance).toFixed(2) : '-'}`);
          }
          if (++frames < 60) requestAnimationFrame(tick); else resolve({ maxY, maxSide, trace });
        };
        requestAnimationFrame(tick);
      }));
      // the clamp keeps feet + world/obb BOX_HEADROOM (2.1) under the slab — the height the box push-out starts at
      const CLEAR = Math.max(C.HEIGHT, 2.1);
      const headOk = jump.maxY + CLEAR <= room.ceil + 0.06, sideOk = jump.maxSide < 0.15;
      ok(headOk, `feet + headroom stay under the ceiling (${(jump.maxY + CLEAR).toFixed(2)} ≤ ceiling ${room.ceil.toFixed(2)}, floor ${room.floor.toFixed(2)})`);
      ok(sideOk, `the jump is not shoved sideways out of the slab (${jump.maxSide.toFixed(3)} m)`);
      const apex = await page.evaluate(() => { const c = window.__game.getSystem('player').controller; return (7.6 * c.jumpSpeedMul) ** 2; });
      const freeRise = apex / (2 * k_GRAVITY);
      if (room.ceil - room.floor - CLEAR < freeRise - 0.15) {
        ok(jump.maxY <= room.ceil - CLEAR + 0.06 && jump.maxY - rest.y < freeRise - 0.1,
          `low ceiling: the clamp cut the jump short (rise ${(jump.maxY - rest.y).toFixed(2)} of a free ${freeRise.toFixed(2)} m)`);
      } else {
        console.log(`  note: lowest ceiling found leaves ${(room.ceil - room.floor - CLEAR).toFixed(2)} m over a free ${freeRise.toFixed(2)} m jump — clamp not exercised`);
      }
      if (!headOk || !sideOk) console.log(`    room ${JSON.stringify(room)} rest y ${rest.y.toFixed(2)}\n    ${jump.trace.join('\n    ')}`);
    }
  }

  /* ── 9b. 월드 천장 — 기하에 기대지 않는 결정적 검사 ─────────────────────────────
     실제 구조물의 천장 높이는 world 가 바꾸면 따라 바뀐다 (3.6 m 방이면 자유 점프가 닿지 않아 클램프가 안 켜진다).
     그래서 새 `PlayerController` 를 **가짜 WorldRef**(평지 + 높이 SLAB 의 판 밑면) 위에서 직접 굴린다. */
  console.log('world ceiling clamp (mock world)');
  const SLAB = 2.5;
  const mock = await page.evaluate((slab) => {
    const sys = window.__game.getSystem('player');
    const Ctor = sys.controller.constructor;
    const V3 = window.__game.ctx.camera.position.constructor;
    const run = (withSlab) => {
      const c = new Ctor();
      c.reset(new V3(0, 0, 0));
      let pushes = 0;
      const world = {
        ready: true,
        getSurfaceY: () => 0, getHeightAt: () => 0,
        getNormalAt: (x, z, out) => (out ? out.set(0, 1, 0) : new V3(0, 1, 0)),
        getStandingObstacle: () => null,
        resolveCollision: (p) => { if (withSlab && p.y + 2.1 > slab) { pushes++; p.x += 3; } },   // world's box push-out rule
        raycast: (o, d, max) => { if (!withSlab || d.y <= 0) return null; const dist = slab - o.y; return dist >= 0 && dist <= max ? { distance: dist } : null; },
      };
      const inp = { x: 0, z: 0, sprint: false, jump: true, stance: 'stand', aiming: false };
      const out = { footstep: false, landed: 0, jumped: false, rollEnded: false, rung: false, climbEnded: null };
      let maxY = 0;
      for (let i = 0; i < 90; i++) { c.update(1 / 60, inp, 0, world, out); inp.jump = false; maxY = Math.max(maxY, c.position.y); }
      return { maxY, x: c.position.x, pushes, grounded: c.grounded };
    };
    return { slab: run(true), free: run(false) };
  }, SLAB);
  ok(mock.free.maxY > 1.0, `without a ceiling the jump rises freely (${mock.free.maxY.toFixed(2)} m)`);
  ok(mock.slab.maxY <= SLAB - 2.1 + 0.01, `under a slab at ${SLAB} m feet stay ≤ slab − BOX_HEADROOM (${mock.slab.maxY.toFixed(2)} ≤ ${(SLAB - 2.1).toFixed(2)})`);
  ok(mock.slab.pushes === 0 && Math.abs(mock.slab.x) < 1e-6 && mock.slab.grounded, `the clamp runs before the push-out — never shoved (pushes ${mock.slab.pushes}, x ${mock.slab.x.toFixed(2)})`);

  /* ── 10. 매달린 채 사망 ──────────────────────────────────────────────────── */
  console.log('death while hanging');
  await page.evaluate(() => {
    const ctx = window.__game.ctx, V3 = ctx.camera.position.constructor, l = window.__ladder;
    ctx.player.teleport(new V3(l.base.x, l.base.y, l.base.z), undefined, false);
  });
  await waitSim(page, 0.3);
  await page.evaluate(() => window.__grab('bottom'));
  const hanging = (await state()).id;
  const evCount = (await state()).ev;
  await page.evaluate(() => window.__game.ctx.player.takeDamage(100000));
  await waitSim(page, 0.1);
  s = await state();
  ok(hanging === 'ladder_smoke_0' && s.id === null && s.ev === evCount + 1, 'death while hanging releases the ladder (one null event)');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
  if (errors.length) console.log(`    page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
