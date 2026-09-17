// 폭발 · 근접 차폐 smoke (2026-09-18, 사용자 결정 「폭발 · 근접 공격이 벽 · 지붕 · 바닥을 뚫지 않는다」).
// 검사하는 것:
//   ① 판정 함수 (`shared/explosion.blastReachesBody` · `meleeReachesBody`) — 하늘에 띄운 상자로 지형과 무관하게:
//      트인 곳 = 맞음 · 벽 너머 = 막힘 · 낮은 벽 너머 머리 = 맞음 · 지붕 위 폭발 → 지붕 아래 = 막힘 · 지붕 위 사람 = 맞음 ·
//      아래층 폭발 → 위층 바닥 위 = 막힘 · 벽면에 붙어 터진 폭발 → 벽 앞 = 맞음 / 벽 뒤 = 막힘 · 근접: 벽 너머 막힘 · 아래층 막힘.
//   ② 실제 경로 — 적 `explode` (플레이어 무기 · 가젯 · 함선 호출이 모이는 곳), 포병 포탄 착탄 → 플레이어,
//      적 근접 `hitTarget` → 플레이어, 플레이어 근접 → 적: 벽이 있으면 피해 0, 치우면 피해.
// Usage: node scripts/smoke-blast-occlusion.mjs [http://localhost:5273]   (needs a running vite)
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
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=960,540', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game?.ctx?.inventory && !!window.__game.ctx.enemies, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const waitSim = async (sec) => {
    const t0 = await page.evaluate(() => window.__game.ctx.time);
    await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec);
  };

  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 4242 }));
  await waitFor(page, () => { const c = window.__game.ctx; return c.world?.ready && c.isGameplayPhase() && c.player?.isDropping === false; }, 'mission + drop-in');
  await waitSim(0.5);

  /* ── ① 판정 함수 — 하늘의 상자 ─────────────────────────────────────── */
  console.log('① blastReachesBody / meleeReachesBody on floating boxes');
  const pure = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    const X = await import('/src/shared/explosion.ts');
    const V = ctx.player.position.constructor;
    const w = ctx.world;
    const bx = ctx.player.position.x, bz = ctx.player.position.z;
    const H = w.getHeightAt(bx, bz) + 120;   // 지형 · 소품과 무관한 높이
    const removes = [];
    const box = (cx, y, cz, hx, hz, h) => {
      const rm = w.addObstacle({ position: new V(cx, y, cz), radius: Math.hypot(hx, hz), height: h, box: { halfX: hx, halfZ: hz, yaw: 0 } });
      removes.push(rm);
      return rm;
    };
    const PH = 1.8;
    const r = {};
    // 바닥판 (윗면 = H) — 폭심과 사람이 그 위에 선다
    box(bx, H - 0.3, bz, 12, 12, 0.3);
    const C = new V(bx + 6, H, bz);   // 폭심: 바닥 위
    r.open = X.blastReachesBody(w, C, bx, H, bz, PH);
    // 벽 (높이 3) 사이에
    const wall = box(bx + 3, H, bz, 0.15, 4, 3);
    r.wall = X.blastReachesBody(w, C, bx, H, bz, PH);
    r.meleeWall = X.meleeReachesBody(w, new V(bx + 3.6, H + 1.2, bz), bx + 2.4, H, bz, PH);
    wall();
    // 낮은 벽 (0.8 m) — 머리는 보인다
    const low = box(bx + 3, H, bz, 0.15, 4, 0.8);
    r.lowWall = X.blastReachesBody(w, C, bx, H, bz, PH);
    low();
    // 벽면에 붙어 터진 폭발 (포탄이 벽에 맞은 자리) — 벽 앞은 맞고 벽 뒤는 막힌다
    const face = box(bx + 3, H, bz, 0.15, 4, 3);
    const onFace = new V(bx + 3.15, H + 1.0, bz);
    r.faceFront = X.blastReachesBody(w, onFace, bx + 5, H, bz, PH);
    r.faceBehind = X.blastReachesBody(w, onFace, bx + 1, H, bz, PH);
    face();
    // 지붕 (윗면 H + 3.2) — 지붕 위 폭발
    box(bx + 3, H + 3, bz, 4, 4, 0.2);
    const onRoof = new V(bx + 3, H + 3.2, bz);
    r.roofBelow = X.blastReachesBody(w, onRoof, bx + 3.5, H, bz, PH);
    r.roofTop = X.blastReachesBody(w, onRoof, bx + 5, H + 3.2, bz, PH);
    // 위층 바닥판 너머 — 아래층 폭발 / 아래층 벌레의 물기
    r.floorAbove = X.blastReachesBody(w, new V(bx + 3.5, H, bz + 1), bx + 3, H + 3.2, bz, PH);
    r.meleeFloor = X.meleeReachesBody(w, new V(bx + 3, H + 1.0, bz), bx + 3, H + 3.2, bz, PH);
    r.meleeOpen = X.meleeReachesBody(w, new V(bx + 7.5, H + 0.8, bz), bx + 8.5, H, bz, PH);
    for (const rm of removes) rm();
    return r;
  });
  ok(pure.open === true, 'open floor: blast reaches the body', JSON.stringify(pure));
  ok(pure.wall === false, 'wall between: blast blocked');
  ok(pure.lowWall === true, 'low wall (0.8 m): head still visible → reaches');
  ok(pure.faceFront === true && pure.faceBehind === false, `blast on a wall face: front hit ${pure.faceFront} · behind blocked ${!pure.faceBehind}`);
  ok(pure.roofBelow === false && pure.roofTop === true, `blast on a roof: below blocked ${!pure.roofBelow} · on the roof hit ${pure.roofTop}`);
  ok(pure.floorAbove === false, 'blast downstairs: upstairs floor blocks');
  ok(pure.meleeWall === false && pure.meleeFloor === false && pure.meleeOpen === true, `melee: wall ${pure.meleeWall} · floor ${pure.meleeFloor} · open ${pure.meleeOpen}`);

  /* ── ② 실제 피해 경로 ───────────────────────────────────────────────── */
  console.log('② real damage paths with and without a wall');
  const setup = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const V = ctx.player.position.constructor;
    const w = ctx.world;
    // 평평한 곳을 찾는다 — 스폰 둘레에서 ±8 m 높이 차가 가장 작은 자리
    const p0 = ctx.player.position;
    let best = null;
    for (let i = 0; i < 60; i++) {
      const a = i * 0.7, d = 6 + i * 1.5;
      const x = p0.x + Math.cos(a) * d, z = p0.z + Math.sin(a) * d;
      const h = w.getHeightAt(x, z);
      let spread = 0;
      for (const [dx, dz] of [[-6, 0], [6, 0], [0, -3], [0, 3]]) spread = Math.max(spread, Math.abs(w.getHeightAt(x + dx, z + dz) - h));
      const near = w.getObstaclesNear(x, z, 9).length;
      if (near === 0 && (!best || spread < best.spread)) best = { x, z, spread };
    }
    window.__site = best;
    return best;
  });
  ok(!!setup, `flat clear site found (spread ${setup?.spread?.toFixed(2)} m)`);

  // 플레이어를 먼저 옮기고 한 프레임 넘긴다 — 적의 표적 목록(`targets`)은 프레임마다 위치를 다시 읽는다
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const V = ctx.player.position.constructor;
    const { x, z } = window.__site;
    ctx.player.respawnAt(new V(x - 2, ctx.world.getHeightAt(x - 2, z), z), 0);
  });
  await waitSim(0.3);
  const realPaths = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const V = ctx.player.position.constructor;
    const w = ctx.world;
    const enemies = window.__game.getSystem('enemies');
    const player = window.__game.getSystem('player');
    const { x, z } = window.__site;
    const wall = () => { const c = new V(x, w.getHeightAt(x, z) - 5, z); return w.addObstacle({ position: c, radius: 5.01, height: 60, box: { halfX: 0.2, halfZ: 5, yaw: 0 } }); };
    const out = {};
    const hpOf = () => ctx.player.hp + (ctx.player.shield ?? 0);
    const blast = new V(x + 2.5, w.getHeightAt(x + 2.5, z), z);
    // 포탄 착탄 → 플레이어 (x − 2)
    const rm2 = wall();
    player.invuln = 0; ctx.player.heal(1000); let php = hpOf(); enemies.onShellLanded(-1, blast.clone()); out.shellWall = php - hpOf();
    rm2();
    player.invuln = 0; ctx.player.heal(1000); php = hpOf(); enemies.onShellLanded(-1, blast.clone()); out.shellOpen = php - hpOf();
    // 적 근접 hitTarget → 플레이어 (거리 판정은 호출부 몫 — 여기서는 벽만 본다)
    const bug = enemies.debugSpawn('scavenger', { x: x + 1.2, z }, false);
    const local = enemies.targets.local();
    out.localAt = local ? +Math.hypot(local.position.x - (x - 2), local.position.z - z).toFixed(2) : -1;
    const rm3 = wall();
    player.invuln = 0; ctx.player.heal(1000); php = hpOf(); enemies.hitTarget(bug, 15, 0, local); out.biteWall = php - hpOf();
    rm3();
    player.invuln = 0; ctx.player.heal(1000); php = hpOf(); enemies.hitTarget(bug, 15, 0, local); out.biteOpen = php - hpOf();
    bug.position.set(x + 40, w.getHeightAt(x + 40, z), z);
    // 적 explode: 폭심 x + 2.5, 적 x − 2 (플레이어는 비켜 둔다 — 폭발 피해는 적 몫만 본다)
    const e = enemies.debugSpawn('scavenger', { x: x - 2, z: z + 0.5 }, false);
    const rm1 = wall();
    let hp0 = e.hp; enemies.explode(blast, 6, 5, 'local', null, null); out.enemyWall = hp0 - e.hp;
    rm1();
    hp0 = e.hp; enemies.explode(blast, 6, 5, 'local', null, null); out.enemyOpen = hp0 - e.hp;
    window.__meleeBug = e;
    return out;
  });
  ok(realPaths.localAt >= 0 && realPaths.localAt < 0.5, `target list sees the moved player (${realPaths.localAt} m)`);
  ok(realPaths.enemyWall === 0 && realPaths.enemyOpen > 0, `enemy explode: wall ${realPaths.enemyWall} · open ${realPaths.enemyOpen}`, JSON.stringify(realPaths));
  ok(realPaths.shellWall === 0 && realPaths.shellOpen > 0, `artillery shell → player: wall ${realPaths.shellWall} · open ${realPaths.shellOpen}`);
  ok(realPaths.biteWall === 0 && realPaths.biteOpen > 0, `enemy melee hitTarget → player: wall ${realPaths.biteWall} · open ${realPaths.biteOpen}`);

  // 플레이어 근접 → 적: 적을 정면 1.4 m 에 세우고 MeleeController 를 직접 푼다
  const swing = async (withWall) => page.evaluate((wantWall) => {
    const ctx = window.__game.ctx;
    const V = ctx.player.position.constructor;
    const w = ctx.world;
    const weapons = window.__game.getSystem('weapons');
    const { x, z } = window.__site;
    const e = window.__meleeBug;
    ctx.player.respawnAt(new V(x - 0.9, w.getHeightAt(x - 0.9, z), z), -Math.PI / 2);   // yaw −π/2 → +X 를 본다
    e.position.set(x + 0.7, w.getHeightAt(x + 0.7, z), z);
    e.velocity.set(0, 0, 0);
    window.__rmWall = wantWall ? w.addObstacle({ position: new V(x, w.getHeightAt(x, z) - 5, z), radius: 3.01, height: 60, box: { halfX: 0.05, halfZ: 3, yaw: 0 } }) : null;
    window.__hp0 = e.hp;
    return true;
  }, withWall);
  const resolveSwing = () => page.evaluate(() => {
    const ctx = window.__game.ctx;
    const weapons = window.__game.getSystem('weapons');
    const e = window.__meleeBug;
    const V = ctx.player.position.constructor;
    e.position.x = window.__site.x + 0.7; e.position.z = window.__site.z;
    const dir = new V(); const o = new V();
    ctx.player.getAimRay(o, dir);
    weapons.melee.damage = 20;   // `begin()` 이 정하는 한 번의 피해 — 휘두르기 연출 없이 판정만 푼다
    weapons.melee.resolve(ctx.player);
    const dealt = window.__hp0 - e.hp;
    if (window.__rmWall) { window.__rmWall(); window.__rmWall = null; }
    return { dealt, dir: [dir.x, dir.y, dir.z].map((v) => +v.toFixed(2)) };
  });
  await swing(true); await waitSim(0.3);
  const mWall = await resolveSwing();
  await swing(false); await waitSim(0.3);
  const mOpen = await resolveSwing();
  ok(mWall.dealt === 0 && mOpen.dealt > 0, `player melee → enemy: wall ${mWall.dealt} · open ${mOpen.dealt}`, JSON.stringify({ mWall, mOpen }));

  ok(errors.length === 0, 'no page errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack || e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
