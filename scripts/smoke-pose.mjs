// 가구 자세 스모크 (2026-09-12, A-3a · A-3e — `src/player/parts/FurniturePose.ts`).
//
// 왜 있나: 흔들의자 앉기와 운동 기구 자세는 hub 가 가구 위치에서 anchor 를 계산해 `ctx.player.setFurniturePose` 로 건다.
// 이 스크립트는 **player 쪽**만 본다 — 가구 모델을 기다리지 않고 함선 바닥 위 가짜 anchor 로 계약을 직접 몬다.
//
// 검사:
//   1. 거절: 드론 조종 · 사다리 · 포드 · 전투불능 · 사망 · 함선 밖 페이즈 · NaN anchor · 모르는 kind → false, 아무것도 안 바뀐다
//   2. 앉기: 발이 anchor XZ · 직전 바닥 높이에 박힘 · 모델 루트가 anchor 로 · 몸 방향 = yaw · 발바닥이 anchor 아래 좌판 높이 ·
//      무기 불가 · 카메라 오버라이드 없음(자유 시점) · `일어나기` 캡션 · WASD / Space / C / V 무시 · 드라이브 받음
//   3. E 로 일어나기: `player:furniturePoseEnded {sit, interact}` 한 번 · 바로 옆 가짜 가구의 interact 가 **안** 불림 ·
//      발 = 직전 자리 정확히 · 자세 복원 · 블렌드가 빠지면 몸 방향 · 루트 복귀 · 다음 E 는 가구를 친다
//   4. 벤치 + 고정 카메라: 오버라이드 블렌드 · 몸이 누움 · 머리 쪽 = yaw(루트 yaw+π) · 위상 0 / 1 의 주먹 높이 · E 무시 ·
//      null → `caller` · 오버라이드 해제 · 자리 복귀
//   5. 달리기 자기 구동 → 사이클로 바로 갈아타기(끝 이벤트 없음) · 위상 0 / 0.5 의 좌우 발 높이 · 크랭크 높이
//   6. spawnStanding → `reset`, 페이즈 변경(미션 시작) → `reset` 한 번, 레이드에서는 거절
//   7. 캐릭터 버프 (2026-09-12, `parts/Buffs`) — 같은 목록을 다시 모으면 배열 · 리비전이 그대로 · progression 실제 API
//      (`useMeal` · `usePrep` · `applyGymSession`)로 식사 · 준비물 pending · 운동 디버프 타이머(startedAt = until − GYM_FATIGUE_HOURS) ·
//      한 프레임의 두 변경 = 리비전 하나 · `player:buffsChanged` 가 게시된 배열을 싣는다 · 1 초 틱이 리비전을 안 올린다 ·
//      만료는 틱이 잡는다 · 앉기 = `rest` · housing 운동 세션(맨 `gymState` 레코드) + 달리기 = `exercise` + stat / minigame · 순서
//   7b. 레이드: 식사 · 준비물 active · 디버프 유지 · 환경 노출(`world.env` 를 잠깐 가린다 — 내열 없음 = 노출, 방독 = 없음)
//   8. `furniturePoseState` 누적 위상 — run 자기 구동 = steps + phase · 감김을 넘어 단조 · cycle 바퀴 수 · bench 0 … 1 · 해제 = null
//   9. 원격 아바타 (디버그 원격 ref 의 `furniturePose`) — 보이던 몸은 블렌드 인 · 루트 (ref.x, anchorY, ref.z) · 벤치 yaw + π ·
//      위상 0 / 1 주먹 높이 · run 누적 걸음 → 보행 위상 · cycle 3.0 / 3.5 바퀴 페달 · 끝나면 블렌드 아웃 · 자세를 든 채 처음 보이면
//      스냅 · 명판 높이 · 다른 함선 자리에서 숨으면 잊고 다시 보이면 스냅
//
// Usage: node scripts/smoke-pose.mjs [http://localhost:5273/]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEED = 33;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];
const SHOTS = process.argv.includes('--shots');

/* src/player/SoldierModel.ts 의 FURN_* 와 같은 값 (anchor 기준) */
const SIT_SOLE_Y = -0.36;
const BENCH_BAR_Y0 = 0.5, BENCH_BAR_Y1 = 0.81;
const CYCLE_CRANK_Y = -0.6, CYCLE_R = 0.16;

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
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitFor(page, () => { const p = window.__game.ctx.player; return p.spawned && p.controlsEnabled && !!p.interior; }, 'standing in the ship', 40000);
  await waitSim(page, 0.6);

  const key = (type, code) => page.evaluate(([t, c]) => { document.body.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true })); }, [type, code]);
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const state = () => page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, sys = window.__game.getSystem('player');
    const r = sys.model.root.position;
    return {
      t: ctx.time, kind: p.furniturePose, x: p.position.x, y: p.position.y, z: p.position.z,
      rx: r.x, ry: r.y, rz: r.z, bodyYaw: sys.bodyYaw, stance: p.stance, canUse: p.canUseWeapons(),
      blend: sys.furn.blend, vis: sys.furn.visKind, over: sys.rig.isOverridden, phase: sys.furn.phase, steps: sys.furn.steps,
      driven: sys.furn.driven, lie: sys.model.bodyGroup.rotation.x, ev: window.__poseEv.length, prompt: window.__prompt,
      grounded: p.isGrounded,
    };
  });
  /** 모델 뼈의 한 점(월드) — 손: 장갑 중심, 발: 발바닥 접점. */
  const limbs = () => page.evaluate(() => {
    const sys = window.__game.getSystem('player'), m = sys.model;
    const V3 = window.__game.ctx.camera.position.constructor;
    m.root.updateMatrixWorld(true);
    const at = (o, y) => { const v = o.localToWorld(new V3(0, y, 0)); return { x: v.x, y: v.y, z: v.z }; };
    return { handR: at(m.armR.lower, -0.29), handL: at(m.armL.lower, -0.29), footR: at(m.legR.lower, -0.42), footL: at(m.legL.lower, -0.42),
      hips: at(m.hips, 0) };
  });
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `scripts/logs/pose-${name}.png` }); };

  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    window.__poseEv = [];
    window.__performed = [];
    window.__prompt = null;
    ctx.bus.on('player:furniturePoseEnded', (e) => window.__poseEv.push({ kind: e.kind, reason: e.reason, t: ctx.time }));
    ctx.bus.on('interact:performed', (e) => window.__performed.push(e.id));
    ctx.bus.on('interact:promptChanged', (e) => { window.__prompt = e.text; });
  });
  const start = await state();

  /* ── 1. 거절 ─────────────────────────────────────────────────────────────── */
  console.log('refusals');
  const ref = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, sys = window.__game.getSystem('player');
    const V3 = ctx.camera.position.constructor;
    const a = new V3(p.position.x + 1, p.position.y + 0.36, p.position.z);
    const pose = () => ({ kind: 'sit', anchor: a, yaw: 0, releaseOnInteract: true });
    const x0 = p.position.x, y0 = p.position.y, z0 = p.position.z, st0 = p.stance;
    const same = () => p.position.x === x0 && p.position.y === y0 && p.position.z === z0 && p.furniturePose === null && p.stance === st0;
    const out = {};
    sys._droneControl = true; out.drone = p.setFurniturePose(pose()) === false && same(); sys._droneControl = false;
    sys.controller.climbLadder = { id: 'fake' }; out.ladder = p.setFurniturePose(pose()) === false && same(); sys.controller.climbLadder = null;
    p.setInPod(true); out.pod = p.setFurniturePose(pose()) === false && same(); p.setInPod(false);
    sys._downed = true; out.downed = p.setFurniturePose(pose()) === false && same(); sys._downed = false;
    sys.isDead = true; out.dead = p.setFurniturePose(pose()) === false && same(); sys.isDead = false;
    const ph = ctx.phase; ctx.phase = 'playing'; out.phase = p.setFurniturePose(pose()) === false && same(); ctx.phase = ph;
    out.nan = p.setFurniturePose({ kind: 'sit', anchor: new V3(Number.NaN, 0, 0), yaw: 0 }) === false && same();
    out.badKind = p.setFurniturePose({ kind: 'lie', anchor: a, yaw: 0 }) === false && same();
    out.badYaw = p.setFurniturePose({ kind: 'sit', anchor: a, yaw: Number.POSITIVE_INFINITY }) === false && same();
    out.nullIdle = p.setFurniturePose(null) === true && same();
    p.setFurniturePoseDrive(0.5);   // no pose → ignored
    out.driveIdle = sys.furn.driven === false;
    out.noEvents = window.__poseEv.length === 0;
    return out;
  });
  for (const [k, v] of Object.entries(ref)) ok(v === true, `refused / untouched: ${k}`);

  /* ── 2. 앉기 ─────────────────────────────────────────────────────────────── */
  console.log('sit (rocking chair, free look)');
  const SIT_YAW = 0.8;
  const sitA = await page.evaluate((yaw) => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    const a = new V3(p.position.x + 0.9, p.position.y + 0.36, p.position.z + 0.5);
    window.__sitAnchor = a;
    const res = p.setFurniturePose({ kind: 'sit', anchor: a, yaw, releaseOnInteract: true });
    return { res, ax: a.x, ay: a.y, az: a.z, kind: p.furniturePose, x: p.position.x, y: p.position.y, z: p.position.z };
  }, SIT_YAW);
  ok(sitA.res === true && sitA.kind === 'sit', 'setFurniturePose(sit) → true, furniturePose = sit');
  ok(sitA.x === sitA.ax && sitA.z === sitA.az && sitA.y === start.y, 'feet pinned under the anchor at the floor height');
  await waitSim(page, 1.2);
  let s = await state();
  ok(s.blend > 0.95 && s.vis === 'sit', `pose blend settles (${s.blend.toFixed(2)})`);
  ok(Math.hypot(s.rx - sitA.ax, s.ry - sitA.ay, s.rz - sitA.az) < 0.02, 'model root on the anchor');
  ok(Math.abs(wrap(s.bodyYaw - SIT_YAW)) < 0.05, `body faces yaw (${s.bodyYaw.toFixed(2)})`);
  ok(s.canUse === false, 'canUseWeapons() false while seated');
  ok(s.over === false, 'no camera override (free look)');
  ok(s.prompt === '일어나기', `prompt is 일어나기 (${s.prompt})`);
  let L = await limbs();
  ok(Math.abs(L.footR.y - (sitA.ay + SIT_SOLE_Y)) < 0.07 && Math.abs(L.footL.y - (sitA.ay + SIT_SOLE_Y)) < 0.07,
    `soles at seat height below the anchor (${(L.footR.y - sitA.ay).toFixed(2)} / ${(L.footL.y - sitA.ay).toFixed(2)})`);
  ok(L.hips.y > sitA.ay && L.hips.y < sitA.ay + 0.3, `pelvis on the seat (${(L.hips.y - sitA.ay).toFixed(2)} above)`);
  await shot('sit');
  // input is ignored
  await key('keydown', 'KeyW');
  await tap('Space'); await tap('KeyC'); await tap('KeyV');
  await waitSim(page, 0.5);
  await key('keyup', 'KeyW');
  s = await state();
  ok(s.x === sitA.ax && s.z === sitA.az && s.y === start.y && s.kind === 'sit', 'W / Space / C / V do not move or stand the body');
  ok(s.stance === 'stand', 'stance untouched by C');
  await page.evaluate(() => window.__game.ctx.player.setFurniturePoseDrive(0.3));
  s = await state();
  ok(s.driven === true && Math.abs(s.phase - 0.3) < 1e-9, 'setFurniturePoseDrive accepted');

  /* ── 3. E 로 일어나기 ─────────────────────────────────────────────────────── */
  console.log('E stands up');
  await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player;
    window.__iaHits = 0;
    ctx.interactables.register({
      id: 'pose_smoke_ia', position: p.position.clone(), radius: 4,
      getPrompt: () => '가짜 가구', canInteract: () => true, interact: () => { window.__iaHits++; },
    });
  });
  await waitSim(page, 0.2);
  ok((await state()).prompt === '일어나기', 'a nearby interactable does not replace the 일어나기 caption');
  await tap('KeyE');
  await waitFor(page, () => window.__game.ctx.player.furniturePose === null, 'E release', 5000);
  await waitSim(page, 0.1);
  s = await state();
  const ev1 = await page.evaluate(() => window.__poseEv.slice());
  ok(ev1.length === 1 && ev1[0].kind === 'sit' && ev1[0].reason === 'interact', `one furniturePoseEnded {sit, interact} (${JSON.stringify(ev1)})`);
  ok((await page.evaluate(() => window.__iaHits)) === 0 && !(await page.evaluate(() => window.__performed.includes('pose_smoke_ia'))),
    'the E that stood up did not fire the interactable');
  ok(s.x === start.x && s.y === start.y && s.z === start.z, `feet back on the exact spot (${(s.x - start.x).toExponential(1)}, ${(s.z - start.z).toExponential(1)})`);
  ok(s.stance === start.stance, 'stance restored');
  await waitSim(page, 1.2);
  s = await state();
  ok(s.vis === null && s.blend === 0, 'model pose blended out');
  ok(Math.abs(wrap(s.bodyYaw - start.bodyYaw)) < 0.05, `body yaw back (${s.bodyYaw.toFixed(2)} vs ${start.bodyYaw.toFixed(2)})`);
  ok(Math.hypot(s.rx - s.x, s.ry - s.y, s.rz - s.z) < 0.03, 'model root back on the feet');
  ok(s.canUse === true || !(await page.evaluate(() => window.__game.ctx.player.weaponState?.hasWeapon)), 'weapons gate lifted');
  await tap('KeyE');
  await waitSim(page, 0.2);
  ok((await page.evaluate(() => window.__iaHits)) === 1, 'the next E reaches the furniture again');
  await page.evaluate(() => window.__game.ctx.interactables.unregister('pose_smoke_ia'));
  await waitSim(page, 0.5);

  /* ── 4. 벤치 + 고정 카메라 ──────────────────────────────────────────────────── */
  console.log('bench (fixed camera, drive)');
  const BENCH_YAW = 0.3;
  const benchA = await page.evaluate((yaw) => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    const a = new V3(p.position.x - 0.6, p.position.y + 0.42, p.position.z + 0.7);
    const cam = { position: new V3(a.x + 2.6, a.y + 0.9, a.z - 0.4), lookAt: new V3(a.x, a.y + 0.3, a.z - 0.3) };
    const res = p.setFurniturePose({ kind: 'bench', anchor: a, yaw, camera: cam });
    return { res, ax: a.x, ay: a.y, az: a.z };
  }, BENCH_YAW);
  ok(benchA.res === true, 'setFurniturePose(bench, camera) → true');
  await page.evaluate(() => window.__game.ctx.player.setFurniturePoseDrive(0));
  await waitSim(page, 1.4);
  s = await state();
  ok(s.over === true, 'camera override blended in');
  ok(s.lie > 1.5, `body lies back (bodyGroup.x ${s.lie.toFixed(2)})`);
  ok(Math.abs(wrap(s.bodyYaw - (BENCH_YAW + Math.PI))) < 0.05, 'root turned to yaw + π (head toward yaw)');
  L = await limbs();
  // 머리 쪽 = yaw 방향 (−sin, −cos)
  const hx = -Math.sin(BENCH_YAW), hz = -Math.cos(BENCH_YAW);
  const along = (pt) => (pt.x - benchA.ax) * hx + (pt.z - benchA.az) * hz;
  ok(along(L.handR) > -0.15 && along(L.hips) < -0.3, `head end toward yaw (hands ${along(L.handR).toFixed(2)}, hips ${along(L.hips).toFixed(2)})`);
  const h0 = (L.handR.y + L.handL.y) / 2;
  ok(Math.abs(h0 - (benchA.ay + BENCH_BAR_Y0)) < 0.08, `phase 0: fists at the chest (${(h0 - benchA.ay).toFixed(2)} above anchor)`);
  await shot('bench0');
  await page.evaluate(() => window.__game.ctx.player.setFurniturePoseDrive(1));
  await waitSim(page, 0.8);
  L = await limbs();
  const h1 = (L.handR.y + L.handL.y) / 2;
  ok(Math.abs(h1 - (benchA.ay + BENCH_BAR_Y1)) < 0.08, `phase 1: arms locked out (${(h1 - benchA.ay).toFixed(2)} above anchor)`);
  await shot('bench1');
  await tap('KeyE');
  await waitSim(page, 0.3);
  s = await state();
  ok(s.kind === 'bench' && s.ev === 1, 'E does not release a pose without releaseOnInteract');
  ok(await page.evaluate(() => window.__game.ctx.player.setFurniturePose(null)) === true, 'setFurniturePose(null) → true');
  const ev2 = await page.evaluate(() => window.__poseEv[window.__poseEv.length - 1]);
  s = await state();
  ok(s.ev === 2 && ev2.kind === 'bench' && ev2.reason === 'caller', `furniturePoseEnded {bench, caller} (${JSON.stringify(ev2)})`);
  ok(s.x === start.x && s.y === start.y && s.z === start.z, 'feet back on the exact spot');
  await waitSim(page, 1.2);
  s = await state();
  ok(s.over === false && s.vis === null, 'camera override released and the body stood up');

  /* ── 5. 달리기 → 사이클 ──────────────────────────────────────────────────── */
  console.log('run (self-driven) → cycle');
  await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    window.__runOk = p.setFurniturePose({ kind: 'run', anchor: new V3(p.position.x, p.position.y + 0.15, p.position.z - 0.8), yaw: 1.2 });
  });
  const r0 = await state();
  await waitSim(page, 1.0);
  const r1 = await state();
  ok((await page.evaluate(() => window.__runOk)) === true && r1.kind === 'run', 'run pose on');
  ok(r1.driven === false && (r1.steps + r1.phase) - (r0.steps + r0.phase) > 1.5, `self-driven stride advances (${((r1.steps + r1.phase) - (r0.steps + r0.phase)).toFixed(2)} steps)`);
  // one synchronous block — the self-drive keeps advancing between separate evaluates
  const wrapRes = await page.evaluate(() => {
    const p = window.__game.ctx.player, f = window.__game.getSystem('player').furn;
    p.setFurniturePoseDrive(0.3);
    const base = f.steps;
    for (const v of [0.6, 0.95, 0.1]) p.setFurniturePoseDrive(v);
    return { d: f.steps - base, phase: f.phase, driven: f.driven };
  });
  ok(wrapRes.driven && wrapRes.d === 1 && Math.abs(wrapRes.phase - 0.1) < 1e-9, `drive wraps 1 → 0 as one more step (${JSON.stringify(wrapRes)})`);
  const cycA = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor, sys = window.__game.getSystem('player');
    const a = new V3(sys.furn.restorePos.x + 0.7, sys.furn.restorePos.y + 0.9, sys.furn.restorePos.z);
    const res = p.setFurniturePose({ kind: 'cycle', anchor: a, yaw: -0.5 });
    p.setFurniturePoseDrive(0);
    return { res, ax: a.x, ay: a.y, az: a.z, kind: p.furniturePose, ev: window.__poseEv.length };
  });
  ok(cycA.res === true && cycA.kind === 'cycle' && cycA.ev === 2, 'switching run → cycle directly: no end event');
  await waitSim(page, 1.2);
  L = await limbs();
  const fL0 = L.footL.y, fR0 = L.footR.y;
  ok(Math.abs(fL0 - (cycA.ay + CYCLE_CRANK_Y + CYCLE_R + 0.02)) < 0.07, `phase 0: left sole on the top pedal (${(fL0 - cycA.ay).toFixed(2)})`);
  await shot('cycle0');
  await page.evaluate(() => window.__game.ctx.player.setFurniturePoseDrive(0.5));
  await waitSim(page, 0.6);
  L = await limbs();
  ok(L.footR.y > fR0 + 0.2 && L.footL.y < fL0 - 0.2, `phase 0.5: right pedal up, left down (L ${(L.footL.y - cycA.ay).toFixed(2)}, R ${(L.footR.y - cycA.ay).toFixed(2)})`);
  await page.evaluate(() => window.__game.ctx.player.setFurniturePose(null));
  s = await state();
  const ev3 = await page.evaluate(() => window.__poseEv[window.__poseEv.length - 1]);
  ok(ev3.kind === 'cycle' && ev3.reason === 'caller' && s.x === start.x && s.z === start.z && s.y === start.y, 'release returns to the spot held before the first pose');
  await waitSim(page, 1.0);
  // 7–9 add pose events of their own; section 6 counts from here, so they are cut back out afterwards
  const poseEvBase = await page.evaluate(() => window.__poseEv.length);

  /* ── 7. 캐릭터 버프 모으기 (함선) ─────────────────────────────────────────────── */
  console.log('character buffs (ship)');
  const FATIGUE_H = Number((readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8').match(/^GYM_FATIGUE_HOURS,([\d.]+)/m) ?? [])[1]);
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    window.__buffEv = [];
    ctx.bus.on('player:buffsChanged', (e) => window.__buffEv.push({ rev: e.revision, same: e.buffs === ctx.player.buffs, keys: e.buffs.map((b) => b.key) }));
  });
  const buffs = () => page.evaluate(() => {
    const p = window.__game.ctx.player;
    return { rev: p.buffsRevision, list: JSON.parse(JSON.stringify(p.buffs)), ev: window.__buffEv.length };
  });
  const idem = await page.evaluate(() => {
    const p = window.__game.ctx.player, sys = window.__game.getSystem('player');
    const arr = p.buffs, rev = p.buffsRevision;
    const r1 = sys.recomputeBuffs(), r2 = sys.recomputeBuffs();
    return { r1, r2, same: p.buffs === arr, rev: p.buffsRevision === rev, arr: Array.isArray(arr), hasPose: arr.some((b) => b.key === 'pose') };
  });
  ok(idem.arr && idem.r1 === false && idem.r2 === false && idem.same && idem.rev, `identical recompute: same array, no revision bump (${JSON.stringify(idem)})`);
  ok(!idem.hasPose, 'no pose buff once the earlier poses ended');
  const b0 = await buffs();
  const useRes = await page.evaluate(() => {
    const prog = window.__game.ctx.progression;
    return { meal: prog.useMeal('meal_tuber_stew'), prep: prog.usePrep('prep_respirator') };
  });
  ok(useRes.meal === null && useRes.prep === null, `progression.useMeal / usePrep accepted in the ship (${JSON.stringify(useRes)})`);
  await waitSim(page, 0.1);
  let B = await buffs();
  const mealB = B.list.find((b) => b.key === 'meal'), prepB = B.list.find((b) => b.key === 'prep:toxin');
  ok(mealB && mealB.kind === 'meal' && mealB.state === 'pending' && mealB.defId === 'meal_tuber_stew' && mealB.debuff === false && mealB.endsAt === undefined,
    `meal pending in the ship (${JSON.stringify(mealB)})`);
  ok(prepB && prepB.kind === 'prep' && prepB.state === 'pending' && prepB.env === 'toxin' && prepB.defId === 'prep_respirator', `prep:toxin pending in the ship (${JSON.stringify(prepB)})`);
  ok(B.rev === b0.rev + 1 && B.ev === b0.ev + 1, `two changes in one frame → one revision / one event (${b0.rev} → ${B.rev}, events ${b0.ev} → ${B.ev})`);
  const lastEv = await page.evaluate(() => window.__buffEv[window.__buffEv.length - 1]);
  ok(lastEv && lastEv.same === true && lastEv.rev === B.rev, `player:buffsChanged carries the published array + revision (${JSON.stringify(lastEv)})`);
  const fat = await page.evaluate(() => {
    const prog = window.__game.ctx.progression;
    const res = prog.applyGymSession('strength', 0.5);
    return { res: !!res, until: prog.getGymFatigueUntil('strength') };
  });
  ok(fat.res && fat.until > Date.now(), 'applyGymSession put the strength debuff on');
  await waitSim(page, 0.1);
  B = await buffs();
  const fatB = B.list.find((b) => b.key === 'fatigue:strength');
  ok(fatB && fatB.kind === 'gym_fatigue' && fatB.debuff === true && fatB.state === 'active' && fatB.stat === 'strength' && fatB.endsAt === fat.until
    && FATIGUE_H > 0 && fatB.endsAt - fatB.startedAt === FATIGUE_H * 3600e3, `fatigue timer startedAt = until − ${FATIGUE_H} h, endsAt = until (${JSON.stringify(fatB)})`);
  ok(B.list.map((b) => b.kind).join() === 'gym_fatigue,meal,prep', `order: debuff → meal → prep (${B.list.map((b) => b.key).join()})`);
  const revT = B.rev;
  await waitSim(page, 2.3);
  B = await buffs();
  ok(B.rev === revT, `1 s ticks with nothing changed keep the revision (${revT} → ${B.rev})`);
  // expiry has no event: the tick has to find it
  await page.evaluate(() => {
    const prog = window.__game.getSystem('progression');
    window.__fatigueSaved = prog._profile.gymFatigueUntil.strength;
    prog._profile.gymFatigueUntil.strength = Date.now() + 600;
  });
  await waitFor(page, () => !window.__game.ctx.player.buffs.some((b) => b.key === 'fatigue:strength'), 'fatigue expiry by tick', 8000);
  ok(true, 'an expired debuff leaves the list on the 1 s tick');
  await page.evaluate(() => { window.__game.getSystem('progression')._profile.gymFatigueUntil.strength = window.__fatigueSaved; });
  await waitFor(page, () => window.__game.ctx.player.buffs.some((b) => b.key === 'fatigue:strength'), 'fatigue back', 8000);

  const sitW = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    const a = new V3(p.position.x + 0.8, p.position.y + 0.36, p.position.z);
    const res = p.setFurniturePose({ kind: 'sit', anchor: a, yaw: 0.4, releaseOnInteract: true, furnitureUid: 'f-901' });
    const w = p.furniturePoseState;
    return { res, w: w && { kind: w.kind, yaw: w.yaw, phase: w.phase, uid: w.furnitureUid, ax: w.anchor.x, ay: w.anchor.y, az: w.anchor.z }, ax: a.x, ay: a.y, az: a.z };
  });
  ok(sitW.res && sitW.w && sitW.w.kind === 'sit' && sitW.w.phase === 0 && sitW.w.uid === 'f-901' && sitW.w.yaw === 0.4
    && sitW.w.ax === sitW.ax && sitW.w.ay === sitW.ay && sitW.w.az === sitW.az, `furniturePoseState for sit (${JSON.stringify(sitW.w)})`);
  await waitSim(page, 0.1);
  B = await buffs();
  const restB = B.list.find((b) => b.key === 'pose');
  ok(restB && restB.kind === 'rest' && restB.pose === 'sit' && restB.furnitureUid === 'f-901' && restB.state === 'active' && restB.debuff === false,
    `rest buff while seated (${JSON.stringify(restB)})`);
  const exW = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor, sys = window.__game.getSystem('player');
    const housing = window.__game.getSystem('housing');
    window.__gymOld = housing.gymState;
    // a bare session record (no gym screen / furniture) — only `gymSession` is read by the buff list
    housing.gymState = { info: { uid: 'f-902', defId: 'smoke', stat: 'endurance', minigame: 'breath' }, pose: 'run', finished: false, result: null, score: 0 };
    const a = new V3(sys.furn.restorePos.x, sys.furn.restorePos.y + 0.15, sys.furn.restorePos.z - 0.8);
    const res = p.setFurniturePose({ kind: 'run', anchor: a, yaw: 1.0, furnitureUid: 'f-902' });
    return { res, session: ctx.housing.gymSession && ctx.housing.gymSession.uid };
  });
  ok(exW.res === true && exW.session === 'f-902', 'switched to run with a housing gym session');
  await waitSim(page, 0.1);
  B = await buffs();
  const exB = B.list.find((b) => b.key === 'pose');
  ok(exB && exB.kind === 'exercise' && exB.pose === 'run' && exB.stat === 'endurance' && exB.minigame === 'breath' && exB.furnitureUid === 'f-902',
    `exercise buff with stat / minigame (${JSON.stringify(exB)})`);
  ok(B.list.map((b) => b.kind).join() === 'gym_fatigue,exercise,meal,prep', `order: debuff → exercise → meal → prep (${B.list.map((b) => b.key).join()})`);

  /* ── 8. furniturePoseState: 누적 위상 ──────────────────────────────────────────── */
  console.log('furniturePoseState (cumulative phase)');
  await waitSim(page, 1.0);
  const cum = await page.evaluate(() => {
    const p = window.__game.ctx.player, f = window.__game.getSystem('player').furn;
    const out = {};
    const w0 = p.furniturePoseState;
    out.self = w0.phase; out.selfOk = Math.abs(w0.phase - (f.steps + f.phase)) < 1e-9;
    out.reused = p.furniturePoseState === w0;
    p.setFurniturePoseDrive(0.3); const a = p.furniturePoseState.phase;
    p.setFurniturePoseDrive(0.8); const b = p.furniturePoseState.phase;
    p.setFurniturePoseDrive(0.1); const c = p.furniturePoseState.phase;
    out.run = [a, b, c];
    out.runOk = Math.abs(b - a - 0.5) < 1e-9 && Math.abs(c - b - 0.3) < 1e-9 && Math.abs(c - Math.floor(c) - 0.1) < 1e-9;
    const V3 = window.__game.ctx.camera.position.constructor;
    p.setFurniturePose({ kind: 'cycle', anchor: new V3(f.restorePos.x + 0.7, f.restorePos.y + 0.9, f.restorePos.z), yaw: -0.5, furnitureUid: 'f-902' });
    for (const v of [0.3, 0.6, 0.95, 0.1, 0.5]) p.setFurniturePoseDrive(v);
    out.cycle = p.furniturePoseState.phase; out.cycleKind = p.furniturePoseState.kind;
    p.setFurniturePose({ kind: 'bench', anchor: new V3(f.restorePos.x, f.restorePos.y + 0.42, f.restorePos.z), yaw: 0 });
    p.setFurniturePoseDrive(0.7); out.bench = p.furniturePoseState.phase;
    p.setFurniturePoseDrive(1.6); out.benchClamp = p.furniturePoseState.phase;
    out.benchUid = p.furniturePoseState.furnitureUid;
    return out;
  });
  ok(cum.self > 1.5 && cum.selfOk, `run self-driven: phase = steps + phase (${cum.self.toFixed(3)})`);
  ok(cum.reused, 'furniturePoseState returns one reused object');
  ok(cum.runOk, `run drive 0.3 → 0.8 → 0.1 is monotonic across the wrap (${cum.run.map((v) => v.toFixed(2)).join(' → ')})`);
  ok(cum.cycleKind === 'cycle' && Math.abs(cum.cycle - 1.5) < 1e-9, `cycle drive 0.3 … 0.95 → 0.1 → 0.5 = 1.5 revolutions (${cum.cycle})`);
  ok(Math.abs(cum.bench - 0.7) < 1e-9 && cum.benchClamp === 1 && cum.benchUid === null, `bench phase 0 … 1, no uid when omitted (${cum.bench}, ${cum.benchClamp}, ${cum.benchUid})`);
  await page.evaluate(() => {
    window.__game.ctx.player.setFurniturePose(null);
    window.__game.getSystem('housing').gymState = window.__gymOld ?? null;
  });
  await waitSim(page, 0.1);
  const offW = await page.evaluate(() => window.__game.ctx.player.furniturePoseState);
  B = await buffs();
  ok(offW === null && !B.list.some((b) => b.key === 'pose'), 'released: furniturePoseState null, pose buff gone');

  /* ── 9. 원격 아바타 가구 자세 (디버그 원격 ref) ───────────────────────────────────── */
  console.log('remote avatar furniture pose');
  const remote = (id) => page.evaluate((rid) => {
    const av = window.__game.getSystem('remotePlayers').getAvatar(rid);
    if (!av) return null;
    const m = av.model, V3 = window.__game.ctx.camera.position.constructor;
    m.root.updateMatrixWorld(true);
    const at = (o, y) => { const v = o.localToWorld(new V3(0, y, 0)); return { x: v.x, y: v.y, z: v.z }; };
    const q = m.root.quaternion, pv = av.poseView, head = av.getHeadPosition(new V3());
    return {
      shown: av.isShown, blend: av.furniturePoseBlend, kind: av.furniturePoseKind,
      rx: m.root.position.x, ry: m.root.position.y, rz: m.root.position.z, yaw: 2 * Math.atan2(q.y, q.w), lie: m.bodyGroup.rotation.x,
      handR: at(m.armR.lower, -0.29), handL: at(m.armL.lower, -0.29), footR: at(m.legR.lower, -0.42), footL: at(m.legL.lower, -0.42),
      stride: pv.stridePhase, move: pv.moveBlend, fPhase: pv.furniturePhase, furn: pv.furniture, headY: head.y,
    };
  }, id);
  const remA = await page.evaluate(() => {
    const ctx = window.__game.ctx, rs = window.__game.getSystem('remotePlayers');
    const r = rs.debugSpawn({ slot: 1, id: 'pose-remote' });
    r.hubSite = ctx.hub?.hubSite ?? null;   // a personal ship hides peers from other ship sites
    window.__remRef = r;
    return { id: r.id, x: r.position.x, y: r.position.y, z: r.position.z };
  });
  await waitFor(page, (id) => { const av = window.__game.getSystem('remotePlayers').getAvatar(id); return !!av && av.isShown; }, 'remote avatar shown', 10000, remA.id);
  await waitSim(page, 0.3);
  let R = await remote(remA.id);
  ok(R && R.blend === 0 && R.kind === null && R.furn === 0, 'no pose on a plain remote ref');
  const RB_YAW = -0.7, RB_AY = remA.y + 0.42;
  await page.evaluate(([yaw, ay]) => { window.__remRef.furniturePose = { kind: 'bench', anchorY: ay, yaw, phase: 0, furnitureUid: 'f-903' }; }, [RB_YAW, RB_AY]);
  await waitSim(page, 0.12);
  R = await remote(remA.id);
  ok(R.kind === 'bench' && R.blend > 0 && R.blend < 0.9, `an already-shown avatar blends into the pose (${R.blend.toFixed(2)})`);
  await waitSim(page, 1.4);
  R = await remote(remA.id);
  ok(R.blend > 0.95, `remote pose blend settles (${R.blend.toFixed(2)})`);
  ok(Math.abs(R.rx - remA.x) < 1e-6 && Math.abs(R.rz - remA.z) < 1e-6 && Math.abs(R.ry - RB_AY) < 0.02, `root at (ref.x, anchorY, ref.z) (dy ${(R.ry - RB_AY).toFixed(3)})`);
  ok(Math.abs(wrap(R.yaw - (RB_YAW + Math.PI))) < 0.05, `remote bench body yaw = yaw + π (${wrap(R.yaw).toFixed(2)})`);
  ok(R.lie > 1.5, `remote body lies back (${R.lie.toFixed(2)})`);
  const rh0 = (R.handR.y + R.handL.y) / 2;
  ok(Math.abs(rh0 - (RB_AY + BENCH_BAR_Y0)) < 0.08, `remote phase 0: fists at the chest (${(rh0 - RB_AY).toFixed(2)})`);
  await page.evaluate(() => { window.__remRef.furniturePose = { ...window.__remRef.furniturePose, phase: 1 }; });
  await waitSim(page, 0.8);
  R = await remote(remA.id);
  const rh1 = (R.handR.y + R.handL.y) / 2;
  ok(Math.abs(rh1 - (RB_AY + BENCH_BAR_Y1)) < 0.08, `remote phase 1: arms locked out (${(rh1 - RB_AY).toFixed(2)})`);
  await page.evaluate(([ay]) => { window.__remRef.furniturePose = { kind: 'run', anchorY: ay, yaw: 1.0, phase: 7.25, furnitureUid: 'f-904' }; }, [remA.y + 0.15]);
  await waitSim(page, 1.2);
  R = await remote(remA.id);
  ok(R.kind === 'run' && Math.abs(R.stride - Math.PI * 7.25) < 1e-6 && R.move > 1.1 && Math.abs(R.fPhase - 0.25) < 1e-9,
    `remote run rides the walk cycle on the cumulative steps (stride ${R.stride.toFixed(3)}, move ${R.move.toFixed(2)})`);
  ok(Math.abs(wrap(R.yaw - 1.0)) < 0.05, `remote run body yaw = yaw (${wrap(R.yaw).toFixed(2)})`);
  const RC_AY = remA.y + 0.9;
  await page.evaluate(([ay]) => { window.__remRef.furniturePose = { kind: 'cycle', anchorY: ay, yaw: -0.5, phase: 3.0, furnitureUid: null }; }, [RC_AY]);
  await waitSim(page, 1.2);
  R = await remote(remA.id);
  const rfL0 = R.footL.y, rfR0 = R.footR.y;
  ok(R.kind === 'cycle' && R.fPhase === 0 && Math.abs(rfL0 - (RC_AY + CYCLE_CRANK_Y + CYCLE_R + 0.02)) < 0.07, `remote cycle 3.0 rev: left sole on the top pedal (${(rfL0 - RC_AY).toFixed(2)})`);
  await page.evaluate(() => { window.__remRef.furniturePose = { ...window.__remRef.furniturePose, phase: 3.5 }; });
  await waitSim(page, 0.6);
  R = await remote(remA.id);
  ok(R.footR.y > rfR0 + 0.2 && R.footL.y < rfL0 - 0.2, `remote cycle 3.5 rev: right pedal up, left down (L ${(R.footL.y - RC_AY).toFixed(2)}, R ${(R.footR.y - RC_AY).toFixed(2)})`);
  await page.evaluate(() => { window.__remRef.furniturePose = null; });
  await waitSim(page, 0.12);
  R = await remote(remA.id);
  ok(R.kind === 'cycle' && R.blend < 0.95 && R.blend > 0, `pose ended: blending out (${R.blend.toFixed(2)})`);
  await waitSim(page, 1.6);
  R = await remote(remA.id);
  ok(R.kind === null && R.blend === 0 && R.furn === 0 && Math.abs(R.ry - remA.y) < 0.02, `blended back to standing at the ref (${(R.ry - remA.y).toFixed(3)})`);
  // a body that appears already posed (visitor boarding a ship) snaps into it instead of sitting down in front of them
  const rem2 = await page.evaluate(() => {
    const ctx = window.__game.ctx, rs = window.__game.getSystem('remotePlayers');
    const r = rs.debugSpawn({ slot: 2, id: 'pose-remote-2' });
    r.hubSite = ctx.hub?.hubSite ?? null;
    r.furniturePose = { kind: 'sit', anchorY: r.position.y + 0.36, yaw: 0.2, phase: 0, furnitureUid: 'f-905' };
    window.__remRef2 = r;
    return { id: r.id, y: r.position.y, ay: r.position.y + 0.36 };
  });
  await waitFor(page, (id) => { const av = window.__game.getSystem('remotePlayers').getAvatar(id); return !!av && av.isShown; }, 'posed remote shown', 10000, rem2.id);
  R = await remote(rem2.id);
  ok(R.kind === 'sit' && R.blend === 1 && Math.abs(R.ry - rem2.ay) < 1e-6, `first visible frame with a pose snaps into it (blend ${R.blend})`);
  ok(R.headY < rem2.y + 1.55 && R.headY > rem2.ay + 0.6, `nameplate anchor follows the seated head (${(R.headY - rem2.y).toFixed(2)} above the floor)`);
  await page.evaluate(() => { window.__remRef2.hubSite = 'pose-elsewhere'; });
  await waitSim(page, 0.12);
  R = await remote(rem2.id);
  ok(R.shown === false && R.kind === null && R.blend === 0, 'hidden at another ship site: pose forgotten');
  await page.evaluate(() => { window.__remRef2.hubSite = window.__game.ctx.hub?.hubSite ?? null; });
  await waitSim(page, 0.12);
  R = await remote(rem2.id);
  ok(R.shown === true && R.kind === 'sit' && R.blend === 1, 'shown again: snaps back into the pose');
  await page.evaluate(() => window.__game.getSystem('remotePlayers').debugClear());
  await page.evaluate((n) => { window.__poseEv.length = n; }, poseEvBase);
  await waitSim(page, 0.3);

  /* ── 6. reset ─────────────────────────────────────────────────────────────── */
  console.log('resets');
  await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    p.setFurniturePose({ kind: 'sit', anchor: new V3(p.position.x + 0.5, p.position.y + 0.36, p.position.z), yaw: 0, releaseOnInteract: true });
  });
  await waitSim(page, 0.3);
  await page.evaluate(() => { const p = window.__game.ctx.player; p.spawnStanding(p.position.clone(), 0); });
  s = await state();
  const ev4 = await page.evaluate(() => window.__poseEv[window.__poseEv.length - 1]);
  ok(s.kind === null && s.vis === null && ev4.reason === 'reset' && ev4.kind === 'sit' && s.ev === 4, 'spawnStanding releases with reason reset');
  await waitSim(page, 0.3);
  await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    window.__sitAgain = p.setFurniturePose({ kind: 'sit', anchor: new V3(p.position.x + 0.5, p.position.y + 0.36, p.position.z), yaw: 0 });
  });
  ok((await page.evaluate(() => window.__sitAgain)) === true, 'sit again before the mission');
  await page.evaluate((seed) => window.__game.ctx.bus.emit('game:newMission', { seed }), SEED);
  await waitFor(page, () => window.__game.ctx.phase !== 'hub', 'left the hub', 40000);
  await waitSim(page, 0.2);
  const evs = await page.evaluate(() => window.__poseEv.slice(4));
  ok(evs.length === 1 && evs[0].reason === 'reset' && evs[0].kind === 'sit', `leaving the ship releases once with reset (${JSON.stringify(evs)})`);
  ok((await state()).kind === null, 'no pose outside the ship');
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 60000);
  await waitFor(page, () => { const p = window.__game.ctx.player; return p.spawned && p.controlsEnabled && !p.isDropping; }, 'landed', 60000);
  const raid = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, V3 = ctx.camera.position.constructor;
    const x = p.position.x;
    const res = p.setFurniturePose({ kind: 'sit', anchor: new V3(x + 1, p.position.y, p.position.z), yaw: 0 });
    return res === false && p.furniturePose === null && p.position.x === x;
  });
  ok(raid, 'refused during a raid');

  /* ── 7b. 캐릭터 버프 (레이드) — 출격이 식사 · 준비물을 active 로 옮겼다 ───────────────────── */
  console.log('character buffs (raid)');
  await waitSim(page, 0.2);
  B = await buffs();
  const rMeal = B.list.find((b) => b.key === 'meal'), rPrep = B.list.find((b) => b.key === 'prep:toxin'), rFat = B.list.find((b) => b.key === 'fatigue:strength');
  ok(rMeal && rMeal.state === 'active' && rMeal.defId === 'meal_tuber_stew', `meal active in the raid (${JSON.stringify(rMeal)})`);
  ok(rPrep && rPrep.state === 'active' && rPrep.env === 'toxin', `prep:toxin active in the raid (${JSON.stringify(rPrep)})`);
  ok(rFat && rFat.state === 'active', 'fatigue carries into the raid');
  ok(!B.list.some((b) => b.key === 'pose' || b.state === 'pending'), `no pending / pose buffs in the raid (${B.list.map((b) => `${b.key}:${b.state}`).join()})`);
  ok((await page.evaluate(() => window.__game.getSystem('player').recomputeBuffs())) === false, 'identical recompute in the raid: no bump');
  // environment exposure: shadow the world's `env` getter for a moment (seed 33 is a plain planet)
  await page.evaluate(() => { Object.defineProperty(window.__game.ctx.world, 'env', { get: () => 'heat', configurable: true }); });
  await waitSim(page, 0.2);
  B = await buffs();
  const envB = B.list.find((b) => b.key === 'env');
  ok(envB && envB.kind === 'env_exposed' && envB.env === 'heat' && envB.debuff === true && envB.state === 'active' && B.list[0].key === 'env',
    `heat without a coolant → env_exposed first (${B.list.map((b) => b.key).join()})`);
  await page.evaluate(() => { Object.defineProperty(window.__game.ctx.world, 'env', { get: () => 'toxin', configurable: true }); });
  await waitSim(page, 0.2);
  B = await buffs();
  ok(!B.list.some((b) => b.key === 'env'), 'toxin with the respirator loaded → no exposure buff');
  await page.evaluate(() => { delete window.__game.ctx.world.env; });
  await waitSim(page, 0.2);
  B = await buffs();
  ok(!B.list.some((b) => b.key === 'env'), 'environment gone → no exposure buff');

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
