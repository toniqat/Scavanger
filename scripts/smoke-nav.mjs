// Shared pathfinding smoke (TODO A-18, 2026-09-21).
//
// Why it exists: the nav graph (`src/world/nav/`) is only worth anything if a body that follows its waypoints really
// arrives. A path status of `ok` proves nothing about that — the graph could link two cells a real body cannot walk
// between (a doorway too tight, a stair the grid cut) and every android would walk into the wall it was meant to go
// round. So every path here is **walked** with the movers' own world queries (`getSurfaceY` first, `resolveCollision`
// second, 0.1 m steps — `player/PlayerController`'s order) and must reach every waypoint; a ladder link is taken as
// the teleport the climb is.
//
// Checks (per seed, per building):
//   1. The bake finishes (`WorldRef.nav.ready`) and reports its node count and wall-clock cost.
//   2. Outside the front door → inside it: `ok`, walked to the end.
//   3. A two-floor building: outside → the floor-2 arrival spot: `ok`, ends on floor 2, walked to the end.
//   4. Outside → the roof (the ladder's exit): `ok`, the path takes that ladder (`kind: 'ladder'` with its id).
//   5. The lab's locked room while it is locked: **not** `ok` (the door is a wall). After the door opens and the
//      re-measure ran: `ok`, walked to the end — the hash change reached the graph.
//   6. `walkable`: straight through a building's wall is false; a straight line inside one room is true.
//   7. Cost: a long open-ground search and a search to an unreachable goal each stay under a frame budget.
//   8. An android (`/android 1`) told to go (`저쪽으로 가자`) to a floor-2 spot and to a roof from outside the front
//      door gets there — the second one by climbing the ladder (`ALLY_FLAGS.CLIMB` seen on the way).
//
// Usage: node scripts/smoke-nav.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:5273/';
/** `--android`: only the android trips (section 8) — the graph checks take a minute and a half on their own. */
const ONLY_ANDROID = process.argv.includes('--android');
const SEEDS = [21, 7, 1234, 42, 99, 2026];
/** A search may take at most this long (ms) — it runs on the authority's frame. */
const SEARCH_MS_MAX = 25;

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

/** In the page: every building's paths, walked. `phase` = 'before' (doors as generated) or 'after' (locked doors opened). */
function probe({ phase }) {
  const ctx = window.__game.ctx, w = ctx.world;
  const ws = window.__game.getSystem('world');
  const g = w.nav;
  const V3 = ctx.camera.position.constructor;
  const CAN = 1 | 8;   // NAV_CAN.LADDER | NAV_CAN.INDOOR
  const R = 0.45;
  const path = g.createPath();
  const p = new V3();

  /** Walks the path from `from` with real world queries. `{ ok, stuckAt, left }`. */
  const walk = (from) => {
    p.copy(from);
    for (let i = 0; i < path.count; i++) {
      const wp = path.points[i];
      if (wp.kind === 'ladder') { p.copy(wp.position); continue; }
      for (let it = 0; it < 4000; it++) {
        const dx = wp.position.x - p.x, dz = wp.position.z - p.z, d = Math.hypot(dx, dz);
        if (d < 0.05) break;
        const st = Math.min(0.1, d);
        const ox = p.x, oz = p.z;
        p.x += (dx / d) * st; p.z += (dz / d) * st;
        p.y = w.getSurfaceY(p.x, p.z, p.y);
        w.resolveCollision(p, R);
        p.y = w.getSurfaceY(p.x, p.z, p.y);
        if (Math.hypot(p.x - ox, p.z - oz) < 0.01) break;   // pinned against something
      }
      const left = Math.hypot(wp.position.x - p.x, wp.position.z - p.z);
      const dy = Math.abs(wp.position.y - p.y);
      if (left > 0.6 || dy > 0.6) {
        return { ok: false, stuckAt: i, of: path.count, left: +left.toFixed(2), dy: +dy.toFixed(2),
          at: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)], wp: [+wp.position.x.toFixed(1), +wp.position.y.toFixed(1), +wp.position.z.toFixed(1)] };
      }
    }
    return { ok: true };
  };
  const plan = (from, to) => {
    const t0 = performance.now();
    const st = g.findPath(from, to, CAN, path);
    const ms = performance.now() - t0;
    const kinds = [];
    for (let i = 0; i < path.count; i++) kinds.push(path.points[i].kind === 'ladder' ? `ladder:${path.points[i].ladderId}` : path.points[i].kind);
    const last = path.count > 0 ? path.points[path.count - 1].position : null;
    return { st, ms: +ms.toFixed(2), n: path.count, kinds, lastY: last ? +last.y.toFixed(2) : null, walked: st === 'ok' || st === 'partial' ? walk(from) : null };
  };

  const rows = [];
  const defs = new Map(w.getStructures().map((d) => [d.id, d]));
  for (const s of ws.structures.debugNav()) {
    const nav = s.nav;
    const c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
    const at = (lx, lz, y) => new V3(nav.cx + lx * c - lz * sn, y, nav.cz + lx * sn + lz * c);
    const y0 = nav.levels[0];
    const outside = at(nav.doorOut[0], nav.doorOut[1], 0);
    outside.y = w.getSurfaceY(outside.x, outside.z, y0 + 0.5);
    const row = { id: s.id, kind: s.kind, floors: nav.levels.length, def: defs.get(s.id) };
    if (phase === 'before') {
      row.enter = plan(outside, at(nav.doorIn[0], nav.doorIn[1], y0));
      if (nav.stairTop) row.upstairs = plan(outside, at(nav.stairTop[0], nav.stairTop[1], nav.levels[1]));
      const ladder = w.getLadders().find((l) => l.id.startsWith(`ladder_${s.id}_`));
      if (ladder) { row.ladderId = ladder.id; row.roof = plan(outside, new V3(ladder.exit.x, ladder.topY, ladder.exit.z)); }
      // walkable: straight through the back wall (outside the back → inside) vs. a line inside the first room
      const behind = at(0, nav.halfD + 2, 0); behind.y = w.getSurfaceY(behind.x, behind.z, y0 + 0.5);
      const innerBack = at(0, nav.halfD - 1.2, y0);
      row.throughWall = g.walkable(behind, innerBack);
      // The back wall (local +Z, the breach's side 0 'north') — skipped when the collapsed breach is in it.
      if (nav.breach?.side === 0) row.throughWall = null;
      // The doorway approach is kept clear by construction (`OPENING_APPROACH`), so the first metres in are open floor.
      const a = at(nav.doorIn[0], nav.doorIn[1], y0), b = at(nav.doorIn[0], nav.doorIn[1] + 1.2, y0);
      row.inRoomProbe = { a: [a.x, a.z], b: [b.x, b.z] };
      row.inRoom = s.kind === 'wreck' ? undefined : g.walkable(a, b);
    }
    if (nav.locked) {
      const L = nav.locked;
      row.locked = plan(outside, at((L.x0 + L.x1) / 2, (L.z0 + L.z1) / 2, nav.levels[L.k]));
      row.unlocked = !!row.def?.unlocked;
    }
    delete row.def;
    rows.push(row);
  }

  // Cost: a long open-ground search and one to an unreachable spot (the middle of the first locked room, when locked)
  const spawn = w.getPlayerSpawn();
  const far = new V3(-spawn.x * 0.8 || 200, 0, -spawn.z * 0.8 || 200);
  far.y = w.getHeightAt(far.x, far.z);
  const long = plan(spawn, far);
  delete long.walked;
  return { info: window.__game.getSystem('world').debugNav.debugInfo(), rows, long };
}

/** Opens every locked door the way the relay's `struct unlocked` does (no key — the smoke is not testing keys). */
function unlockAll() {
  const st = window.__game.getSystem('world').structures;
  let n = 0;
  for (const inst of st.byId.values()) {
    if (inst.def.unlocked || !inst.doorEntry) continue;
    st.applyUnlock(inst, null, false);
    n++;
  }
  return n;
}

/** Seed whose first two-floor building the android trips use (seed 1234: `struct_lab_1` has floor 2 and a roof ladder). */
const ANDROID_SEED = 1234;
/** Sim seconds an android gets for one trip (outside the door → floor 2 / the roof). */
const TRIP_S = 40;

/** 8. Android trips: outside the front door → floor 2, and → the roof by the ladder. */
async function androidTrip(page) {
  const P = (fn, arg) => page.evaluate(fn, arg);
  console.log('android trips');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.allies.devSetAndroid(true));
  const id = await P(async () => (await import('/src/shared/index.ts')).androidIdOf('local', 0));
  await P((s) => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: s }); }, ANDROID_SEED);
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  await waitFor(page, (i) => { const b = window.__game.ctx.allies.getBody(i); return !!b && !b.hidden; }, 'ally lands', 30000, id);
  await waitFor(page, () => window.__game.ctx.world.nav?.ready, 'nav baked', 30000);
  await P(() => { const s = window.__game.getSystem('enemies'); s.training = true; for (const e of [...s.active]) s.despawn(e); });

  const spots = await P(() => {
    const ctx = window.__game.ctx, w = ctx.world, ws = window.__game.getSystem('world');
    const s = ws.structures.debugNav().find((r) => r.nav.stairTop && w.getLadders().some((l) => l.id.startsWith(`ladder_${r.id}_`)));
    if (!s) return null;
    const nav = s.nav, c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
    const at = (lx, lz) => [nav.cx + lx * c - lz * sn, nav.cz + lx * sn + lz * c];
    const out = at(nav.doorOut[0], nav.doorOut[1]);
    const up = at(nav.stairTop[0], nav.stairTop[1]);
    const L = w.getLadders().find((l) => l.id.startsWith(`ladder_${s.id}_`));
    return {
      id: s.id,
      out: [out[0], w.getSurfaceY(out[0], out[1], nav.levels[0] + 0.5), out[1]],
      floor2: [up[0], nav.levels[1], up[1]],
      roof: [L.exit.x, L.topY, L.exit.z],
    };
  });
  ok(!!spots, `seed ${ANDROID_SEED} has a two-floor building with a roof ladder`);
  if (!spots) return;

  for (const [name, goal] of [['floor 2', spots.floor2], ['the roof', spots.roof]]) {
    await P(({ i, out, goal }) => {
      const ctx = window.__game.ctx, sys = window.__game.getSystem('allies');
      const V = ctx.player.position.constructor;
      sys.debugTeleport(i, out[0], out[1], out[2]);
      sys.debugLeaderAt(new V(goal[0], goal[1], goal[2]));
      window.__pingN = (window.__pingN ?? 100) + 1;
      ctx.bus.emit('ping:placedV3', { id: window.__pingN, position: new V(goal[0], goal[1], goal[2]), kind: 'attack', expires: ctx.time + 60, owner: null });
      window.__climbSeen = false;
    }, { i: id, out: spots.out, goal });
    const t0 = await P(() => window.__game.ctx.time);
    let best = null, climbed = false;
    for (;;) {
      const r = await P(({ i, goal }) => {
        const ctx = window.__game.ctx, b = ctx.allies.getBody(i);
        if ((b.flags & 32) !== 0) window.__climbSeen = true;
        return { t: ctx.time, d: Math.hypot(b.position.x - goal[0], b.position.z - goal[2]), dy: Math.abs(b.position.y - goal[1]), climb: window.__climbSeen, state: b.state,
          pos: [+b.position.x.toFixed(1), +b.position.y.toFixed(1), +b.position.z.toFixed(1)] };
      }, { i: id, goal });
      climbed = r.climb;
      if (!best || r.d + r.dy < best.d + best.dy) best = r;
      if (r.d < 2 && r.dy < 0.6) break;
      if (r.t - t0 > TRIP_S) break;
      await sleep(150);
    }
    ok(best.d < 2 && best.dy < 0.6, `android reaches ${name} of ${spots.id} from outside the door`, JSON.stringify(best));
    if (name === 'the roof') ok(climbed, 'android climbed the ladder (CLIMB flag seen)');
  }
  await P(() => { window.__game.getSystem('allies').debugLeaderAt(null); window.__game.ctx.bus.emit('game:abort', {}); });
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
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

  const seen = { twoFloor: 0, roof: 0, locked: 0 };
  for (const seed of ONLY_ANDROID ? [] : SEEDS) {
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready && window.__game.ctx.world.nav, 'world ready', 30000);
    const t0 = Date.now();
    await waitFor(page, () => window.__game.ctx.world.nav.ready, 'nav baked', 60000);
    const before = await page.evaluate(probe, { phase: 'before' });
    const inf = before.info;
    console.log(`seed ${seed}: ${before.rows.length} structures · ${inf.total} nodes · ${inf.regions} regions · ${inf.links} links · bake ${inf.bakeMs.toFixed(0)} ms cpu over ${Date.now() - t0} ms wall`);
    ok(inf.ready, `seed ${seed} nav baked`);
    for (const r of before.rows) {
      const tag = `seed ${seed} ${r.id} (${r.kind})`;
      if (r.enter) ok(r.enter.st === 'ok' && r.enter.walked?.ok, `${tag} outside → inside the door`, JSON.stringify(r.enter));
      if (r.upstairs) { seen.twoFloor++; ok(r.upstairs.st === 'ok' && r.upstairs.walked?.ok, `${tag} outside → floor 2`, JSON.stringify(r.upstairs)); }
      if (r.roof) {
        seen.roof++;
        ok(r.roof.st === 'ok' && r.roof.kinds.includes(`ladder:${r.ladderId}`) && r.roof.walked?.ok, `${tag} outside → roof by its ladder`, JSON.stringify(r.roof));
      }
      if (r.kind !== 'wreck' && r.throughWall !== null) ok(r.throughWall === false, `${tag} walkable() through the back wall is false`);
      if (r.inRoom !== undefined) ok(r.inRoom === true, `${tag} walkable() just inside the door is true`, JSON.stringify(r.inRoomProbe));
      if (r.locked) { seen.locked++; ok(r.locked.st !== 'ok', `${tag} locked room unreachable while locked`, JSON.stringify(r.locked)); }
    }
    ok(before.long.ms <= SEARCH_MS_MAX, `seed ${seed} long open-ground search ${before.long.ms} ms (${before.long.st}, ${before.long.n} pts)`);
    const lockedCost = before.rows.filter((r) => r.locked).map((r) => r.locked.ms);
    for (const ms of lockedCost) ok(ms <= SEARCH_MS_MAX, `seed ${seed} unreachable-goal search ${ms} ms`);

    const opened = await page.evaluate(unlockAll);
    if (opened > 0) {
      await sleep(1200);   // a few re-measure passes (`NAV_REMEASURE_HZ`)
      const after = await page.evaluate(probe, { phase: 'after' });
      for (const r of after.rows) {
        if (!r.locked) continue;
        ok(r.locked.st === 'ok' && r.locked.walked?.ok, `seed ${seed} ${r.id} locked room reachable once opened`, JSON.stringify(r.locked));
      }
    }
    await page.evaluate(() => window.__game.ctx.bus.emit('game:abort', {}));
    await sleep(200);
  }
  await androidTrip(page);
  if (!ONLY_ANDROID) {
    ok(seen.twoFloor >= 2, `two-floor buildings seen (${seen.twoFloor})`);
    ok(seen.roof >= 3, `roofs seen (${seen.roof})`);
    ok(seen.locked >= 1, `locked rooms seen (${seen.locked})`);
  }
  // The relay is not this smoke's business — a run without one logs WebSocket refusals that say nothing about nav.
  const real = errors.filter((e) => !e.includes('WebSocket'));
  ok(real.length === 0, 'no page errors', real.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
