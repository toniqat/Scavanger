// Blast · melee occlusion smoke (2026-09-18, user's decision 「explosions and melee do not pass walls, roofs or floors」).
// What it checks:
//   ① the judging functions (`shared/explosion.blastReachesBody` · `meleeReachesBody`) — on boxes floated in the sky, so
//      the terrain plays no part: in the open = hit · through a wall = blocked · the head over a low wall = hit · a blast
//      on a roof → below the roof = blocked · a person on the roof = hit · a blast downstairs → on the floor above =
//      blocked · a blast against a wall face → in front of the wall = hit / behind it = blocked · melee: through a wall
//      blocked · downstairs blocked.
//   ② the real paths — an enemy `explode` (where the player's weapons · gadgets · ship calls all meet), an artillery shell
//      landing → the player, an enemy melee `hitTarget` → the player, the player's melee → an enemy: with a wall the
//      damage is 0, with the wall taken away there is damage.
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

  /* ── ① the judging functions — boxes in the sky ───────────── */
  console.log('① blastReachesBody / meleeReachesBody on floating boxes');
  const pure = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    const X = await import('/src/shared/explosion.ts');
    const V = ctx.player.position.constructor;
    const w = ctx.world;
    const bx = ctx.player.position.x, bz = ctx.player.position.z;
    const H = w.getHeightAt(bx, bz) + 120;   // a height that has nothing to do with the terrain · props
    const removes = [];
    const box = (cx, y, cz, hx, hz, h) => {
      const rm = w.addObstacle({ position: new V(cx, y, cz), radius: Math.hypot(hx, hz), height: h, box: { halfX: hx, halfZ: hz, yaw: 0 } });
      removes.push(rm);
      return rm;
    };
    const PH = 1.8;
    const r = {};
    // The floor plate (top face = H) — the blast centre and the person stand on it
    box(bx, H - 0.3, bz, 12, 12, 0.3);
    const C = new V(bx + 6, H, bz);   // the blast centre: on the floor
    r.open = X.blastReachesBody(w, C, bx, H, bz, PH);
    // A wall (3 high) between them
    const wall = box(bx + 3, H, bz, 0.15, 4, 3);
    r.wall = X.blastReachesBody(w, C, bx, H, bz, PH);
    r.meleeWall = X.meleeReachesBody(w, new V(bx + 3.6, H + 1.2, bz), bx + 2.4, H, bz, PH);
    wall();
    // A low wall (0.8 m) — the head is still visible
    const low = box(bx + 3, H, bz, 0.15, 4, 0.8);
    r.lowWall = X.blastReachesBody(w, C, bx, H, bz, PH);
    low();
    // A blast against the wall face (where a shell hit the wall) — in front of the wall it hits, behind it it is blocked
    const face = box(bx + 3, H, bz, 0.15, 4, 3);
    const onFace = new V(bx + 3.15, H + 1.0, bz);
    r.faceFront = X.blastReachesBody(w, onFace, bx + 5, H, bz, PH);
    r.faceBehind = X.blastReachesBody(w, onFace, bx + 1, H, bz, PH);
    face();
    // The roof (top face H + 3.2) — a blast on the roof
    box(bx + 3, H + 3, bz, 4, 4, 0.2);
    const onRoof = new V(bx + 3, H + 3.2, bz);
    r.roofBelow = X.blastReachesBody(w, onRoof, bx + 3.5, H, bz, PH);
    r.roofTop = X.blastReachesBody(w, onRoof, bx + 5, H + 3.2, bz, PH);
    // Through the floor plate above — a blast downstairs / a bite from a bug downstairs
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

  /* ── ② the real damage paths ──────────────────────────────────── */
  console.log('② real damage paths with and without a wall');
  const setup = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const w = ctx.world;
    // Finds flat ground — the spot around the spawn with the smallest ±8 m height spread
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

  // Moves the player first and lets a frame pass — the enemy target list (`targets`) re-reads the position every frame
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
    // A shell landing → the player (x − 2)
    const rm2 = wall();
    player.invuln = 0; ctx.player.heal(1000); let php = hpOf(); enemies.onShellLanded(-1, blast.clone()); out.shellWall = php - hpOf();
    rm2();
    player.invuln = 0; ctx.player.heal(1000); php = hpOf(); enemies.onShellLanded(-1, blast.clone()); out.shellOpen = php - hpOf();
    // An enemy melee hitTarget → the player (the range test belongs to the caller — only the wall is looked at here)
    const bug = enemies.debugSpawn('scavenger', { x: x + 1.2, z }, false);
    const local = enemies.targets.local();
    out.localAt = local ? +Math.hypot(local.position.x - (x - 2), local.position.z - z).toFixed(2) : -1;
    const rm3 = wall();
    player.invuln = 0; ctx.player.heal(1000); php = hpOf(); enemies.hitTarget(bug, 15, 0, local); out.biteWall = php - hpOf();
    rm3();
    player.invuln = 0; ctx.player.heal(1000); php = hpOf(); enemies.hitTarget(bug, 15, 0, local); out.biteOpen = php - hpOf();
    bug.position.set(x + 40, w.getHeightAt(x + 40, z), z);
    // An enemy explode: the blast centre at x + 2.5, the enemy at x − 2 (the player stands aside — only the enemy's share of the blast damage is looked at)
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

  // The player's melee → an enemy: the enemy is placed 1.4 m straight ahead and the MeleeController is resolved directly
  const swing = async (withWall) => page.evaluate((wantWall) => {
    const ctx = window.__game.ctx;
    const V = ctx.player.position.constructor;
    const w = ctx.world;
    const { x, z } = window.__site;
    const e = window.__meleeBug;
    ctx.player.respawnAt(new V(x - 0.9, w.getHeightAt(x - 0.9, z), z), -Math.PI / 2);   // yaw −π/2 → faces +X
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
    weapons.melee.damage = 20;   // the one damage figure `begin()` decides — no swing animation, only the resolve
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
