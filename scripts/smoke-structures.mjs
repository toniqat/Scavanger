// Abandoned structures · rails · tram smoke (2026-09-09).
//
// Why it exists: this batch brought the first **box (OBB) colliders** (`Obstacle.box`) into world/. Walls · basement
// ceiling slabs · platform decks · the tram body are all boxes. It stops **by the numbers** the same accident the
// cylinders had — a collider growing past what is drawn and turning into an invisible wall (the 2026-09-09 incident
// in `scripts/smoke-props-collision.mjs`).
//
// Checks:
//   1. At least one structure stands per seed, and `structureAt` tells inside from outside
//   2. Every `box` collider sits **inside the bounding box its own structure draws** (slack SLACK_M)
//   3. The interior is walkable: **most** of a ground floor does not push a body out (a 1 m grid ratio, `centreMove`
//      — since 2026-09-11 it is a grid, not the single centre point, because a stairwell or a prop can stand there)
//   4. Walls stop bullets fired **from inside**: of 8 rays out from the structure's centre, at least 6 stop within
//      the outer wall (`raycast`)
//   5. The basement (2026-09-11 rework): the **standing door** at the end of the stair corridor blocks it while
//      locked, and the basement floor is a standing plate
//   6. Rails: platform deck top = the tram floor height (one steps across with no gap), and each stair step stays
//      within `PROP_STEP_UP_MAX`
//   7. The tram: ignition moves the deck and `getStandingObstacle(...).velocity` reports `TRAM_SPEED`
//      (player/PlayerController adds that value to the position — the evidence that a body really is carried)
//   8. The call console (2026-09-10): one stands on every platform's deck, it is locked at the platform the tram is
//      standing at (hold 0), calling from the far side shortens the **distance along the rail** as it approaches, and
//      while it runs a second call · the cab console are both refused
//   9. (2026-09-11) Ceiling · second floor · ladder · roof scanner · ramped stairs · windows · opened-model sync ·
//      the light pool · the scan wave
//   0. (2026-09-11, C-38) Floor tie: at the same top face the floor carrying `velocity` (the moving one) is picked
//      whatever the insertion order
//  10. (2026-09-11, C-22) Material underfoot: structure floors · stairs concrete, the crashed ship metal, rails ·
//      tram metal, the tram deck metal
//  11. (2026-09-11, C-39) Call console sounds: accepted = `tram_call` (at the console spot), refused = `tram_deny`
//
// Usage: node scripts/smoke-structures.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEEDS = [21, 7, 1234];
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/** Slack (m) allowed where a box collider reaches outside the silhouette it draws. */
const SLACK_M = 0.6;

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
/** swiftshader runs at a few fps, so the wall clock cannot be trusted — wait on simulation time. */
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs)
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

  for (const seed of SEEDS) {
    console.log(`seed ${seed}`);
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(400);

    /* ── 0. 2026-09-11 (C-38): floor tie — same top face, the **moving** floor wins 
     * A radius-0 query walks one cell in insertion order. The rail deck goes in before the tram, so the static floor
     * used to win every time. In both insertion orders — with a stopped (zero vector) floor, and with the moving one
     * slightly lower but still inside the window (`PROP_TOP_MARGIN`) — the moving one has to win. A floor outside the
     * window (far from the foot height) is still no candidate. Built in mid-air (the terrain +200 m). */
    if (seed === SEEDS[0]) {
      const tie = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world;
        const hash = window.__game.getSystem('world').hash;
        const V3 = ctx.camera.position.constructor;
        const sp = w.getPlayerSpawn();
        const x = sp.x, z = sp.z, base = w.getHeightAt(x, z) + 200;
        const run = (movingFirst, movingDrop, fixedLift) => {
          const mk = (kind, lift) => hash.addBox(new V3(x, base + lift, z), 2, 2, 0.3, 1, kind);
          let fixed, moving;
          if (movingFirst) { moving = mk('smoke_moving', -movingDrop); fixed = mk('smoke_fixed', fixedLift); }
          else { fixed = mk('smoke_fixed', fixedLift); moving = mk('smoke_moving', -movingDrop); }
          moving.velocity = new V3(0, 0, 0);
          const got = w.getStandingObstacle(x, z, base + 1);
          hash.remove(fixed); hash.remove(moving);
          return got ? got.kind : null;
        };
        return {
          fixedFirst: run(false, 0, 0),
          movingFirst: run(true, 0, 0),
          movingLower: run(false, 0.1, 0),          // the moving one even 0.1 m lower, inside the window (0.15)
          fixedAbove: run(false, 0, 0.1),           // the moving one even with the static floor 0.1 m higher
          outOfWindow: run(false, 0.5, 0),          // a moving floor outside the window is no candidate
        };
      });
      ok(tie.fixedFirst === 'smoke_moving' && tie.movingFirst === 'smoke_moving',
        'C-38: 같은 윗면의 고정 · 움직이는 발판 → 삽입 순서와 상관없이 움직이는 쪽', JSON.stringify(tie));
      ok(tie.movingLower === 'smoke_moving' && tie.fixedAbove === 'smoke_moving',
        'C-38: PROP_TOP_MARGIN 창 안에서는 높이보다 velocity 가 먼저', JSON.stringify(tie));
      ok(tie.outOfWindow === 'smoke_fixed', 'C-38: 창 밖의 움직이는 발판은 고르지 않는다', JSON.stringify(tie));
    }

    /* ── 1 · 2. Structures stand, colliders fit inside ── */
    const r = await page.evaluate((slack) => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const V3 = ctx.camera.position.constructor;
      const structs = world.getStructures().map((s) => ({
        id: s.id, kind: s.kind, x: s.position.x, y: s.position.y, z: s.position.z,
        radius: s.radius, hasBasement: s.hasBasement,
        door: s.basementDoor ? { x: s.basementDoor.x, y: s.basementDoor.y, z: s.basementDoor.z } : null,
        yaw: s.yaw,
      }));

      // The drawn bounding box: the union of the meshes whose name starts with the structure id
      // (body · glow · console · hatch)
      const drawn = new Map();
      const v = new V3();
      ctx.scene.traverse((n) => {
        if (!n.isMesh || !n.name) return;
        const owner = structs.find((s) => n.name.startsWith(s.id))?.id
          ?? (n.name.startsWith('rail_') || n.name === 'tram' ? 'rail' : null);
        if (!owner) return;
        n.updateWorldMatrix(true, false);
        const pos = n.geometry.getAttribute('position');
        if (!pos) return;
        let b = drawn.get(owner);
        if (!b) { b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: -Infinity }; drawn.set(owner, b); }
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(n.matrixWorld);
          if (v.x < b.minX) b.minX = v.x; if (v.x > b.maxX) b.maxX = v.x;
          if (v.z < b.minZ) b.minZ = v.z; if (v.z > b.maxZ) b.maxZ = v.z;
          if (v.y > b.maxY) b.maxY = v.y;
        }
      });

      // Measure every single box collider against its owner's bounding box
      let boxes = 0, worst = -Infinity, worstRow = null;
      for (const o of world.getObstacles()) {
        if (!o.box) continue;
        // 2026-09-13: the rover body is a box moving along its route — unrelated to what structures · rails draw
        if (o.kind === 'rover') continue;
        boxes++;
        // 2026-09-12: containers became box colliders too — around a structure it is that structure's,
        // otherwise a rail platform's
        const near = structs.find((s) => Math.hypot(s.x - o.position.x, s.z - o.position.z) < s.radius + 12)?.id;
        const owner = ['building', 'slab', 'hatch', 'console', 'door', 'glass'].includes(o.kind)
          ? near
          : o.kind === 'container' ? (near ?? 'rail') : 'rail';
        const b = owner ? drawn.get(owner) : null;
        if (!b) continue;
        const c = Math.cos(o.box.yaw), sn = Math.sin(o.box.yaw);
        let over = -Infinity;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const lx = sx * o.box.halfX, lz = sz * o.box.halfZ;
          const wx = o.position.x + lx * c - lz * sn, wz = o.position.z + lx * sn + lz * c;
          over = Math.max(over, b.minX - wx, wx - b.maxX, b.minZ - wz, wz - b.maxZ);
        }
        if (over > worst) { worst = over; worstRow = { kind: o.kind, owner, over: +over.toFixed(2) }; }
      }

      // The cylinder props have to be untouched (entries with no box are still the great majority)
      const cylinders = world.getObstacles().filter((o) => !o.box).length;
      return { structs, boxes, cylinders, worst, worstRow, slack };
    }, SLACK_M);

    ok(r.structs.length >= 1, `structures placed (${r.structs.length}: ${r.structs.map((s) => s.kind).join(', ')})`);
    ok(r.boxes > 0, `box colliders registered (${r.boxes})`);
    ok(r.cylinders > 200, `cylinder props untouched (${r.cylinders})`);
    ok(r.worst <= SLACK_M, `no box collider reaches outside what its structure draws (worst +${r.worst.toFixed(2)} m)`, JSON.stringify(r.worstRow));

    /* ── 3 · 4 · 5. Indoor movement · cover · the basement ─────── */
    const inside = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const V3 = ctx.camera.position.constructor;
      const s = world.getStructures()[0];
      if (!s) return null;
      const y = world.getSurfaceY(s.position.x, s.position.z, s.position.y + 0.5);

      // Most of the ground floor must not push a body out — a wall · stair · railing blocking a whole room is
      // caught here. (2026-09-11: the check used to read the single centre point and is now a grid — a stairwell
      // or a prop can stand there.)
      let onFloor = 0, free = 0;
      const R = Math.max(2, s.radius - 6);
      for (let gx = -R; gx <= R; gx += 1.0) for (let gz = -R; gz <= R; gz += 1.0) {
        if (gx * gx + gz * gz > R * R) continue;
        const x = s.position.x + gx, z = s.position.z + gz;
        const sy = world.getSurfaceY(x, z, s.position.y + 0.3);
        if (Math.abs(sy - s.position.y) > 0.05) continue;
        onFloor++;
        const q = new V3(x, sy, z);
        world.resolveCollision(q, 0.4);
        if (Math.hypot(q.x - x, q.z - z) < 0.01) free++;
      }
      const centreMove = onFloor > 0 ? 1 - free / onFloor : 1;

      // Shoot toward the outer wall — something has to stop it
      let blocked = 0, tries = 0;
      const o = new V3(s.position.x, y + 1.2, s.position.z), d = new V3();
      for (let a = 0; a < 8; a++) {
        d.set(Math.cos((a / 8) * Math.PI * 2), 0, Math.sin((a / 8) * Math.PI * 2));
        tries++;
        const hit = world.raycast(o, d, s.radius + 6);
        if (hit && hit.distance < s.radius + 2) blocked++;
      }

      // With a basement (2026-09-11): the locked door leaf blocks the corridor, the basement floor in front of the
      // door is a standing plate, and it lies more than 3 m below the ground floor
      let hatchTop = null, basementDrop = null, doorBlocks = null;
      const withBase = world.getStructures().find((x) => x.hasBasement);
      if (withBase && withBase.basementDoor) {
        const dpos = withBase.basementDoor;
        hatchTop = world.getSurfaceY(dpos.x, dpos.z, dpos.y + 0.5) - dpos.y;   // the basement floor = the height of the door's bottom edge
        basementDrop = withBase.position.y - dpos.y;
        const door = world.getObstacles().find((o) => o.kind === 'door' && Math.hypot(o.position.x - dpos.x, o.position.z - dpos.z) < 0.2);
        if (door) {
          const p = new V3(dpos.x, dpos.y, dpos.z);
          world.resolveCollision(p, 0.45);
          doorBlocks = Math.hypot(p.x - dpos.x, p.z - dpos.z);
        } else doorBlocks = -1;
      }
      return { centreMove, blocked, tries, hatchTop, basementDrop, doorBlocks, structs: world.getStructures().length };
    });

    if (inside) {
      ok(inside.centreMove < 0.4, `most of a structure's ground floor is standable (${((1 - inside.centreMove) * 100).toFixed(0)} % free)`);
      ok(inside.blocked >= 6, `walls stop shots from inside (${inside.blocked}/${inside.tries} directions blocked)`);
      if (inside.hatchTop !== null) {
        ok(Math.abs(inside.hatchTop) < 0.2, `basement floor in front of the door is a standing plate (Δ ${inside.hatchTop.toFixed(2)} m)`);
        ok(inside.basementDrop > 3, `the basement is a storey below the ground floor (${inside.basementDrop.toFixed(1)} m)`);
        ok(inside.doorBlocks > 0.2, `the locked standing door blocks the stair corridor (pushed ${inside.doorBlocks.toFixed(2)} m)`);
      } else {
        console.log('  --   no basement this seed (basementChance)');
      }
    }


    /* ── 10. 2026-09-11 (C-22): material underfoot ───────────────────────────────────────── */
    const surf = await page.evaluate(() => {
      const w = window.__game.ctx.world;
      const out = { floors: {}, wreck: {}, rail: {}, stair: {} };
      const bump = (t, m) => { t[m] = (t[m] ?? 0) + 1; };
      for (const s of w.getStructures()) {
        const R = Math.max(2, s.radius - 6);
        for (let gx = -R; gx <= R; gx += 1.5) for (let gz = -R; gz <= R; gz += 1.5) {
          const x = s.position.x + gx, z = s.position.z + gz;
          const sy = w.getSurfaceY(x, z, s.position.y + 0.3);
          if (Math.abs(sy - s.position.y) > 0.05) continue;
          const st = w.getStandingObstacle(x, z, sy);
          if (!st || (st.kind !== 'slab' && st.kind !== 'building')) continue;   // container · door tops excluded
          bump(s.kind === 'wreck' ? out.wreck : out.floors, w.getSurfaceMaterial(x, z, sy));
        }
      }
      for (const o of w.getObstacles()) {
        if (!o.ramp || o.kind !== 'slab') continue;
        const top = w.getSurfaceY(o.position.x, o.position.z, o.position.y + o.height);
        bump(out.stair, w.getSurfaceMaterial(o.position.x, o.position.z, top));
      }
      const line = w.getRailLines()[0];
      if (line) {
        for (let i = 0; i < line.points.length; i += Math.max(1, Math.floor(line.points.length / 12))) {
          const p = line.points[i];
          const top = w.getSurfaceY(p.x, p.z);
          const st = w.getStandingObstacle(p.x, p.z, top);
          if (st && (st.kind === 'rail' || st.kind === 'tram')) bump(out.rail, w.getSurfaceMaterial(p.x, p.z, top));
        }
      }
      return out;
    });
    const only = (t, m) => Object.keys(t).length === 0 || (Object.keys(t).length === 1 && t[m] > 0);
    ok(Object.keys(surf.floors).length > 0 && only(surf.floors, 'concrete'), `C-22: 전진기지 · 연구실 바닥 → concrete`, JSON.stringify(surf.floors));
    ok(only(surf.stair, 'concrete'), `C-22: 구조물 계단(경사면) → concrete`, JSON.stringify(surf.stair));
    ok(only(surf.wreck, 'metal'), `C-22: 불시착 함선 데크 → metal (${JSON.stringify(surf.wreck)})`);
    ok(only(surf.rail, 'metal'), `C-22: 선로 발판 · 전차 → metal (${JSON.stringify(surf.rail)})`);

    /* ── 9. 2026-09-11: ceiling · 2F · ladder · roof · ramps · windows ──────────────── */
    const b = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const ws = window.__game.getSystem('world');
      const st = ws.structures;
      const V3 = ctx.camera.position.constructor;
      const rows = [];
      for (const s of world.getStructures()) {
        if (s.kind === 'wreck') continue;
        const lad = world.getLadders().filter((l) => l.id.startsWith(`ladder_${s.id}_`));
        const scan = ctx.interactables.all().find((i) => i.id === `struct:${s.id}:scan`);
        const l = lad[0];
        rows.push({
          id: s.id, ladders: lad.length,
          storeys: l ? Math.round((l.topY - s.position.y) / 4.1) : 0,
          roofStand: l ? +(world.getSurfaceY(l.exit.x, l.exit.z, l.exit.y + 0.5) - l.exit.y).toFixed(2) : null,
          baseStand: l ? +(world.getSurfaceY(l.base.x, l.base.z, l.base.y + 0.5) - l.base.y).toFixed(2) : null,
          scanOnRoof: !!scan && !!l && Math.abs(scan.position.y - l.topY) < 0.05,
          // Shooting up from the middle of the ground floor hits the ceiling (the underside of the floor plate)
          ceil: (() => { const h = world.raycast(new V3(s.position.x, s.position.y + 1.2, s.position.z), new V3(0, 1, 0), 10); return h ? +(h.point.y - s.position.y).toFixed(2) : null; })(),
        });
      }
      const wreckScan = world.getStructures().filter((s) => s.kind === 'wreck').some((s) => ctx.interactables.all().some((i) => i.id === `struct:${s.id}:scan`));

      // Ramped stairs: the biggest single step in the surface height, sampled every 0.1 m from the low end to
      // the high end
      let ramps = 0, worstStep = 0, worstEnd = 0;
      for (const o of world.getObstacles()) {
        // 2026-09-12: stairs only (a structure's 'slab' · a platform's 'platform') — the crashed ship's wing
        // and ramp slopes ('building') have no floor above them
        if (!o.ramp || !o.box || (o.kind !== 'slab' && o.kind !== 'platform')) continue;
        ramps++;
        const c = Math.cos(o.box.yaw), sn = Math.sin(o.box.yaw);
        let prev = null;
        for (let lx = -o.box.halfX + 0.05; lx <= o.box.halfX - 0.05; lx += 0.1) {
          const x = o.position.x + lx * c, z = o.position.z + lx * sn;
          const y = world.getSurfaceY(x, z, prev === null ? o.position.y + o.height - o.ramp.rise + 0.1 : prev + 0.1);
          if (prev !== null) worstStep = Math.max(worstStep, y - prev);
          prev = y;
        }
        const hx = o.position.x + o.box.halfX * c, hz = o.position.z + o.box.halfX * sn;
        worstEnd = Math.max(worstEnd, Math.abs(world.getSurfaceY(hx, hz, o.position.y + o.height + 0.3) - (o.position.y + o.height)));
      }

      // Windows: a ray hits the glass; once broken the ray passes, a person-sized body is still blocked and a
      // grenade-sized one passes
      const glass = st.glassSet;
      let win = { count: glass.count, hit: false, passAfter: false, bodyBlocked: false, smallPasses: false, broken: 0 };
      const pane = world.getObstacles().find((o) => o.kind === 'glass' && o.fragile);
      if (pane) {
        const c = Math.cos(pane.box.yaw), sn = Math.sin(pane.box.yaw);
        const nx = -sn, nz = c;                                  // the normal of the pane
        const mid = new V3(pane.position.x, pane.position.y + pane.height / 2, pane.position.z);
        const from = new V3(mid.x + nx * 3, mid.y, mid.z + nz * 3);
        const dir = new V3(-nx, 0, -nz);
        const h1 = world.raycast(from, dir, 5);
        win.hit = !!h1 && h1.obstacle === pane;
        if (h1 && h1.obstacle && h1.obstacle.destructible) h1.obstacle.destructible.onDamage(10, h1.point);
        const h2 = world.raycast(from, dir, 5);
        win.passAfter = !h2 || h2.obstacle !== pane;
        const body = new V3(mid.x, pane.position.y + 0.1, mid.z);
        world.resolveCollision(body, 0.45);
        win.bodyBlocked = Math.hypot(body.x - mid.x, body.z - mid.z) > 0.1;
        const small = new V3(mid.x, mid.y, mid.z);
        world.resolveCollision(small, 0.08);
        win.smallPasses = Math.hypot(small.x - mid.x, small.z - mid.z) < 0.01;
        win.broken = glass.brokenCount;
      }

      // The opened model: mark one container as if somebody else had opened it
      const cont = ctx.interactables.all().find((i) => i.id.startsWith('container:struct_'));
      const cid = cont ? cont.id.slice('container:'.length) : null;
      const markOk = cid ? st.markContainerOpened(cid) && st.isContainerOpened(cid) : false;

      // The light pool
      const pool = st.lights;
      // 2026-09-13: a seed with no reason at all for stairs (a second floor · a basement · a rail platform) is right
      // to have zero ramps (the dirt-road corridor moved the layout and seed 7 became one)
      const needRamps = rows.some((r) => r.storeys >= 2) || world.getStructures().some((s) => s.hasBasement) || world.getRailLines().length > 0;
      return { rows, wreckScan, ramps, needRamps, worstStep, worstEnd, win, markOk, pool: pool ? { size: pool.size, fixtures: pool.fixtureList.length } : null };
    });
    ok(b.rows.length >= 1 && b.rows.every((r) => r.ladders >= 1), `전진기지 · 연구실마다 옥상 사다리가 있다 (${b.rows.map((r) => `${r.id}:${r.storeys}층`).join(', ')})`, JSON.stringify(b.rows));
    ok(b.rows.every((r) => r.roofStand !== null && Math.abs(r.roofStand) < 0.1), '사다리 꼭대기의 내리는 자리가 옥상 바닥이다', JSON.stringify(b.rows.map((r) => r.roofStand)));
    ok(b.rows.every((r) => r.baseStand !== null && Math.abs(r.baseStand) < 0.1), '사다리 발치가 맨 위층 바닥이다', JSON.stringify(b.rows.map((r) => r.baseStand)));
    ok(b.rows.every((r) => r.scanOnRoof), '맵 스캐너가 옥상에 있다', JSON.stringify(b.rows.map((r) => r.scanOnRoof)));
    ok(!b.wreckScan, '불시착 함선에는 스캐너가 없다');
    ok(b.rows.every((r) => r.ceil !== null && r.ceil > 3 && r.ceil < 4.5), `1층에 천장이 있다 (천장 높이 ${b.rows.map((r) => r.ceil).join(', ')} m)`);
    if (!b.needRamps && b.ramps === 0) console.log('  --   no stairs this seed (1층 구조물뿐 · 지하실 · 선로 없음)');
    else ok(b.ramps >= 1 && b.worstStep < 0.12, `계단이 경사면이라 한 걸음(0.1 m)에 튀지 않는다 (경사 ${b.ramps}개, 최대 ${b.worstStep.toFixed(3)} m)`);
    ok(b.worstEnd < 0.1, `계단 높은 끝이 위층 바닥과 이어진다 (Δ ${b.worstEnd.toFixed(3)} m)`);
    ok(b.win.count > 0 && b.win.hit, `창문 유리가 레이를 막는다 (창 ${b.win.count}장)`, JSON.stringify(b.win));
    ok(b.win.passAfter && b.win.broken >= 1, '깨진 창은 총알이 지나간다', JSON.stringify(b.win));
    ok(b.win.bodyBlocked && b.win.smallPasses, '깨진 창은 몸은 막고 투척물은 지나간다', JSON.stringify(b.win));
    ok(b.markOk, '남이 연 컨테이너가 열린 모습이 된다');
    ok(!!b.pool && b.pool.size === 4 && b.pool.fixtures > 0, `구조물 조명 풀 (${b.pool && b.pool.size}개 광원 · 자리 ${b.pool && b.pool.fixtures})`);

    // The scan wave: pressing the roof console sends a wave out
    const wave = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const st = window.__game.getSystem('world').structures;
      const s = ctx.world.getStructures().find((x) => x.kind !== 'wreck');
      const c = s && ctx.interactables.all().find((i) => i.id === `struct:${s.id}:scan`);
      if (!c) return null;
      c.interact();
      return { active: st.scanWaves.activeCount, scanned: s.scanned };
    });
    ok(!!wave && wave.scanned && wave.active >= 1, '맵 스캔이 파동을 쏜다', JSON.stringify(wave));
    await waitSim(page, 7);
    const waveEnd = await page.evaluate(() => window.__game.getSystem('world').structures.scanWaves.activeCount);
    ok(waveEnd === 0, `파동이 STRUCTURE_SCAN_WAVE_S 뒤에 끝난다 (남은 ${waveEnd})`);

    /* ── 6 · 7. Rails · platform · tram ───────────────────────── */
    const rail = await page.evaluate(() => {
      const world = window.__game.ctx.world;
      const lines = world.getRailLines();
      if (lines.length === 0) return null;
      const line = lines[0];
      const tram = world.getTrams()[0] ?? null;
      const plat = line.platforms[0];
      const deckTop = world.getSurfaceY(plat.position.x, plat.position.z, plat.position.y + 0.5);
      return {
        kind: line.kind, length: line.length, platforms: line.platforms.length,
        deckDelta: deckTop - plat.position.y,
        tram: tram ? { id: tram.id, s: tram.s, state: tram.state, y: tram.position.y } : null,
        platY: plat.position.y,
      };
    });

    if (!rail) {
      console.log('  --   no rail line this seed (RAIL_CHANCE)');
    } else {
      ok(rail.platforms >= 2, `rail has platforms (${rail.kind}, ${rail.platforms}, ${rail.length.toFixed(0)} m)`);
      ok(Math.abs(rail.deckDelta) < 0.2, `platform deck top is standable at its own height (Δ ${rail.deckDelta.toFixed(2)} m)`);
      ok(rail.tram !== null && rail.tram.state === 'idle', 'the tram waits until a console starts it');

      /* 2026-09-10 — the rail itself has to be a **floor to stand on** and has to sit above the terrain.
       * If `getSurfaceY` (with no foot-height limit) returns the rail's top face over the centreline the collider is
       * registered, and if that height is clearly above the terrain it is not buried. */
      const deck = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const line = w.getRailLines()[0];
        const step = Math.max(1, Math.floor(line.points.length / 12));
        const out = [];
        for (let i = 0; i < line.points.length; i += step) {
          const p = line.points[i];
          const ground = w.getHeightAt(p.x, p.z);
          out.push({ deck: +(w.getSurfaceY(p.x, p.z) - ground).toFixed(2), clear: +(p.y - ground).toFixed(2) });
        }
        return out;
      });
      ok(deck.every((d) => d.deck >= d.clear - 0.35), `선로 위에 발판 콜라이더가 있다 (표본 ${deck.length}곳)`, JSON.stringify(deck));
      ok(deck.every((d) => d.clear > 0.4), '선로가 지형에 파묻히지 않는다', JSON.stringify(deck.map((d) => d.clear)));

      /* 2026-09-10 — **the car body is long along the rail.** The floor collider's box half-length (local +X = the
       * tangent) has to be greater than its half-width (local +Z). It used to be exactly the other way round, and a
       * slab hung across the rail. */
      const body = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const t = w.getTrams()[0];
        // The floor plate = the box carrying `velocity` with the largest cross-section. Reading it through
        // `getStandingObstacle` can tie with the rail deck beside the tram (the same height) and make the check a
        // flake — pick it straight out of the collider list instead.
        let floor = null;
        for (const o of w.getObstacles()) {
          if (o.kind !== 'tram' || !o.box || !o.velocity) continue;
          if (!floor || o.box.halfX * o.box.halfZ > floor.box.halfX * floor.box.halfZ) floor = o;
        }
        const con = window.__game.ctx.interactables.all().find((i) => i.id === 'rail:tram_rail_0:console');
        if (!floor) return { halfX: 0, halfZ: 0, console: null, ride: false };
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const dx = con ? con.position.x - t.position.x : 0, dz = con ? con.position.z - t.position.z : 0;
        const st = w.getStandingObstacle(t.position.x, t.position.z, t.position.y);
        return {
          halfX: floor.box.halfX, halfZ: floor.box.halfZ,
          console: con ? { lx: dx * c + dz * s, lz: -dx * s + dz * c } : null,
          ride: !!(st && st.velocity),
        };
      });
      ok(body.ride, '전차 바닥에 서면 탑승 발판(velocity)이 잡힌다 — 옆 선로 발판에 밀리지 않는다');
      ok(body.halfX > body.halfZ * 1.5, `차체가 선로 방향으로 길쭉하다 (반길이 ${body.halfX.toFixed(1)} m · 반폭 ${body.halfZ.toFixed(1)} m)`);
      ok(!!body.console && Math.abs(body.console.lx) < body.halfX && Math.abs(body.console.lz) < body.halfZ,
        '시동 콘솔이 전차 차체 **안**에 있다', JSON.stringify(body.console));

      /* 2026-09-10 — **a platform stair step has to stay within `PROP_STEP_UP_MAX` (0.9)** to be walked up.
       * Sample along the axis leading off the deck and measure the largest rise in the surface height. */
      const stairs = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const plat = w.getRailLines()[0].platforms[0];
        const ax = -Math.sin(plat.yaw), az = Math.cos(plat.yaw);
        const ys = [];
        for (let off = 16; off >= 2.5; off -= 0.1) {
          ys.push(w.getSurfaceY(plat.position.x + ax * off, plat.position.z + az * off));
        }
        let worst = 0;
        for (let i = 1; i < ys.length; i++) worst = Math.max(worst, ys[i] - ys[i - 1]);
        return { worst: +worst.toFixed(3), top: ys[ys.length - 1], deck: plat.position.y };
      });
      ok(stairs.worst <= 0.9 + 1e-3, `플랫폼 계단 한 단이 PROP_STEP_UP_MAX 안이다 (최대 ${stairs.worst.toFixed(2)} m)`);
      ok(Math.abs(stairs.top - stairs.deck) < 0.25, `계단이 데크 상판으로 이어진다 (Δ ${(stairs.top - stairs.deck).toFixed(2)} m)`);

      /* 2026-09-10 (second) — **the platform call console**.
       * Since ignition moved into the cab it is the only way to call the tram from a platform. Its state has to show
       * through the **prompt + the hold time**, not through `canInteract` (cannot call = hold 0 = pressing refuses at
       * once). Dropping `canInteract` makes `findBest` filter it out entirely and not even a prompt appears. */
      /* Whether the tram comes toward the platform that called has to be measured as the **distance along the
       * rail** — on a loop the opposite platform sits at the two ends of a diameter, so the straight XZ distance
       * shrinks by only 2 m over 40 m of travel. The two functions below are the **smoke's own re-implementation**
       * of `rails/model`'s `nearestS` · `deltaS` (they do not call that code). */
      const callIdle = await page.evaluate(() => {
        const railS = (line, x, z) => {
          const segs = line.kind === 'loop' ? line.points.length : line.points.length - 1;
          let cum = 0, bestS = 0, bestD = Infinity;
          for (let i = 0; i < segs; i++) {
            const a = line.points[i], b = line.points[(i + 1) % line.points.length];
            const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz), len2 = dx * dx + dz * dz;
            const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
            const px = a.x + dx * t, pz = a.z + dz * t;
            const d = (px - x) * (px - x) + (pz - z) * (pz - z);
            if (d < bestD) { bestD = d; bestS = cum + len * t; }
            cum += len;
          }
          return bestS;
        };
        const gapS = (line, from, to) => {
          let d = to - from;
          if (line.kind === 'loop') { const h = line.length / 2; while (d > h) d -= line.length; while (d < -h) d += line.length; }
          return Math.abs(d);
        };
        const ctx = window.__game.ctx, w = ctx.world;
        const line = w.getRailLines()[0], t = w.getTrams()[0];
        const cab = ctx.interactables.all().find((x) => x.id === 'rail:tram_rail_0:console');
        return {
          cons: line.platforms.map((p) => {
            const i = ctx.interactables.all().find((x) => x.id === `rail:${p.id}:call`);
            return {
              id: p.id, found: !!i,
              onDeck: i ? Math.hypot(i.position.x - p.position.x, i.position.z - p.position.z) <= p.radius : false,
              prompt: i ? i.getPrompt() : null, hold: i ? (i.holdTime ?? 0) : -1, can: i ? i.canInteract() : false,
              gap: +gapS(line, t.s, railS(line, p.position.x, p.position.z)).toFixed(1),
            };
          }),
          cab: cab ? { prompt: cab.getPrompt(), hold: cab.holdTime ?? 0, can: cab.canInteract() } : null,
        };
      });
      ok(callIdle.cons.length >= 2 && callIdle.cons.every((c) => c.found && c.onDeck && c.can),
        `플랫폼마다 호출 콘솔이 데크 위에 있다 (${callIdle.cons.length}개)`, JSON.stringify(callIdle.cons));
      const here = callIdle.cons.reduce((a, b) => (a.gap <= b.gap ? a : b));
      const far = callIdle.cons.reduce((a, b) => (a.gap >= b.gap ? a : b));
      ok(here.hold === 0 && /대기/.test(here.prompt ?? ''),
        `전차가 선 승강장에서는 호출이 잠긴다 (${here.prompt})`, JSON.stringify(here));
      ok(far.hold > 0 && /호출/.test(far.prompt ?? ''),
        `반대편 승강장에서는 부를 수 있다 (${far.prompt} · 홀드 ${far.hold}s · ${far.gap} m)`, JSON.stringify(far));
      ok(!!callIdle.cab && callIdle.cab.can && callIdle.cab.hold > 0,
        `정차 중에는 운전실 콘솔이 눌린다 (${callIdle.cab?.prompt})`, JSON.stringify(callIdle.cab));

      // Calling runs the usual departure procedure (the announcement → a 1 s wait → 3 s of acceleration), so
      // measure again 5.5 s later. 2026-09-11 (C-39): once accepted, `tram_call` sounds on this client at the
      // console that called.
      const callSnd = await page.evaluate((id) => {
        const ctx = window.__game.ctx;
        const snd = [];
        const off = ctx.bus.on('audio:play', (p) => { if (/^tram_|keycard_deny/.test(p.id)) snd.push({ id: p.id, p: p.position ? [p.position.x, p.position.z] : null }); });
        const con = ctx.interactables.all().find((i) => i.id === `rail:${id}:call`);
        con?.interact();
        off();
        return { snd, at: con ? [con.position.x, con.position.z] : null };
      }, far.id);
      const chime = callSnd.snd.find((s) => s.id === 'tram_call');
      ok(!!chime && !!chime.p && !!callSnd.at && Math.hypot(chime.p[0] - callSnd.at[0], chime.p[1] - callSnd.at[1]) < 0.5,
        'C-39: 호출이 수락되면 부른 콘솔 자리에서 tram_call 차임', JSON.stringify(callSnd));
      await waitSim(page, 5.5);
      const called = await page.evaluate((farId) => {
        const railS = (line, x, z) => {
          const segs = line.kind === 'loop' ? line.points.length : line.points.length - 1;
          let cum = 0, bestS = 0, bestD = Infinity;
          for (let i = 0; i < segs; i++) {
            const a = line.points[i], b = line.points[(i + 1) % line.points.length];
            const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz), len2 = dx * dx + dz * dz;
            const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
            const px = a.x + dx * t, pz = a.z + dz * t;
            const d = (px - x) * (px - x) + (pz - z) * (pz - z);
            if (d < bestD) { bestD = d; bestS = cum + len * t; }
            cum += len;
          }
          return bestS;
        };
        const gapS = (line, from, to) => {
          let d = to - from;
          if (line.kind === 'loop') { const h = line.length / 2; while (d > h) d -= line.length; while (d < -h) d += line.length; }
          return Math.abs(d);
        };
        const ctx = window.__game.ctx, w = ctx.world;
        const line = w.getRailLines()[0], t = w.getTrams()[0];
        const p = line.platforms.find((q) => q.id === farId);
        const cab = ctx.interactables.all().find((x) => x.id === 'rail:tram_rail_0:console');
        return {
          state: t.state, s: t.s,
          gap: +gapS(line, t.s, railS(line, p.position.x, p.position.z)).toFixed(1),
          cons: line.platforms.map((q) => {
            const i = ctx.interactables.all().find((x) => x.id === `rail:${q.id}:call`);
            return { id: q.id, hold: i ? (i.holdTime ?? 0) : -1, prompt: i ? i.getPrompt() : null };
          }),
          cabCan: cab ? cab.canInteract() : true,
        };
      }, far.id);
      ok(called.state === 'moving', `호출로 전차가 출발한다 (${called.state})`);
      ok(called.gap < far.gap - 20, `부른 승강장 쪽으로 다가온다 (${far.gap} → ${called.gap} m)`);
      ok(called.cons.every((c) => c.hold === 0 && /운행/.test(c.prompt ?? '')),
        '운행 중에는 중복 호출이 거부된다 (홀드 0 + 이유가 적힌 프롬프트)', JSON.stringify(called.cons));
      ok(!called.cabCan, '운행 중에는 운전실 콘솔도 잠긴다');
      // 2026-09-11 (C-39): a call while it runs = the refusal-only sound `tram_deny` (it used to be the
      // basement card reader's `keycard_deny`)
      const denySnd = await page.evaluate((id) => {
        const ctx = window.__game.ctx;
        const snd = [];
        const off = ctx.bus.on('audio:play', (p) => { if (/^tram_|keycard_deny/.test(p.id)) snd.push(p.id); });
        ctx.interactables.all().find((i) => i.id === `rail:${id}:call`)?.interact();
        off();
        return snd;
      }, far.id);
      ok(denySnd.includes('tram_deny') && !denySnd.includes('keycard_deny') && !denySnd.includes('tram_call'),
        'C-39: 부를 수 없을 때는 tram_deny 만 울린다', JSON.stringify(denySnd));

      // Whether the deck carries a ride velocity while it runs — the console is **inside the tram** (2026-09-10).
      // The tram is already running from the **call** above, so this press does nothing (by design).
      await page.evaluate(() => {
        window.__game.ctx.interactables.all().find((i) => i.id === 'rail:tram_rail_0:console')?.interact();
      });
      // 2026-09-10: departure is the announcement, then a `TRAM_START_DELAY_S` (1 s) wait + `TRAM_ACCEL_S` (3 s) of
      // cubic acceleration — waiting only 2 s as before does not even reach 1 m/s. Measure once it is at top speed.
      await waitSim(page, 5.5);
      const riding = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const t = w.getTrams()[0];
        const st = w.getStandingObstacle(t.position.x, t.position.z, t.position.y);
        return {
          state: t.state, s: t.s,
          hasDeck: !!st,
          speed: st && st.velocity ? Math.hypot(st.velocity.x, st.velocity.z) : 0,
          deckTop: w.getSurfaceY(t.position.x, t.position.z, t.position.y + 0.5) - t.position.y,
          material: w.getSurfaceMaterial(t.position.x, t.position.z, t.position.y),
        };
      });
      ok(riding.material === 'metal', `C-22: 달리는 전차 데크 → metal (${riding.material})`);

      /* 2026-09-11 (C-18): a running tram **hits enemies · disconnected squadmates too** (the authority = this
         single page). Two enemies are stood in the middle of the body — one with its feet at the deck top − 1.0 m
         (the ground beside the rail = hit), one on the deck (a rider = not hit). `rails.update` is run directly
         once, before the AI moves a single frame, so only the judgement is read. The ghost is a fake squadmate
         slipped into `net.getRemotePlayers()`. Running the same enemy again straight away must not hit it — the
         **per-target cooldown**. */
      const hit = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world;
        const ws = window.__game.getSystem('world');
        const es = window.__game.getSystem('enemies');
        const rp = window.__game.getSystem('remotePlayers');
        const t = w.getTrams()[0];
        const V3 = ctx.camera.position.constructor;
        const ground = es.debugSpawn('warrior', { x: t.position.x, z: t.position.z }, false);
        const rider = es.debugSpawn('warrior', { x: t.position.x + Math.cos(t.yaw) * 2, z: t.position.z + Math.sin(t.yaw) * 2 }, false);
        if (!ground || !rider) return { spawned: false };
        ground.position.set(t.position.x, t.position.y - 1.0, t.position.z);
        rider.position.set(t.position.x + Math.cos(t.yaw) * 2, t.position.y, t.position.z + Math.sin(t.yaw) * 2);
        const ref = rp.debugSpawn({ id: 'tram-ghost', slot: 3, position: new V3(t.position.x - Math.cos(t.yaw) * 2, t.position.y - 1.0, t.position.z - Math.sin(t.yaw) * 2) });
        ref.hp = 100; ref.position.set(t.position.x - Math.cos(t.yaw) * 2, t.position.y - 1.0, t.position.z - Math.sin(t.yaw) * 2);
        rp.debugSuspend('tram-ghost', true);
        const net = ctx.net; const orig = net.getRemotePlayers.bind(net);
        net.getRemotePlayers = () => [...orig(), ref];
        const snd = [], gd = [];
        const offA = ctx.bus.on('audio:play', (p) => { if (p.id === 'tram_hit') snd.push(p.id); });
        const offG = ctx.bus.on('ghost:damage', (e) => gd.push({ id: e.id, amount: e.amount, kb: !!e.kb }));
        const g0 = ground.hp, r0 = rider.hp, gv0 = Math.hypot(ground.velocity.x, ground.velocity.z);
        // The enemy spatial grid was built in this frame's enemy update — it would miss the enemy just moved,
        // so force the linear search. (In a real frame world runs before enemies, so it always is one anyway.)
        es.gridTime = -1;
        ws.rails.update(1 / 120, ctx.time);
        const g1 = ground.hp, r1 = rider.hp, gv1 = Math.hypot(ground.velocity.x, ground.velocity.z);
        ground.position.set(t.position.x, t.position.y - 1.0, t.position.z);
        es.gridTime = -1;
        ws.rails.update(1 / 120, ctx.time);
        const g2 = ground.hp;
        offA(); offG(); delete net.getRemotePlayers; rp.debugClear();
        return { spawned: true, state: t.state, g0, g1, g2, r0, r1, gv0, gv1, snd: snd.length, gd, keys: [...ws.rails.tram.hitUntil.keys()] };
      });
      ok(hit.spawned && hit.g1 < hit.g0 && hit.gv1 > hit.gv0 + 1, `C-18: 달리는 전차가 선로 옆 적을 치고 민다 (hp ${hit.g0} → ${hit.g1}, 속도 ${hit.gv0?.toFixed?.(1)} → ${hit.gv1?.toFixed?.(1)})`, JSON.stringify(hit));
      ok(hit.spawned && hit.r1 === hit.r0, `C-18: 데크 위에 탄 적은 치지 않는다 (hp ${hit.r0} → ${hit.r1})`, JSON.stringify(hit));
      ok(hit.spawned && hit.g2 === hit.g1, 'C-18: 쿨다운은 대상별 — 방금 친 적은 곧바로 다시 치이지 않는다', JSON.stringify(hit));
      ok(hit.spawned && hit.gd.length === 1 && hit.gd[0].id === 'tram-ghost' && hit.gd[0].kb && hit.snd >= 2,
        'C-18: 끊긴 분대원(고스트)은 ghost:damage {kb} 로 치이고 치임음은 tram_hit', JSON.stringify(hit));
      ok(riding.state === 'moving' && riding.s !== rail.tram.s, `호출로 출발한 전차가 계속 달린다 (s ${rail.tram.s.toFixed(0)} → ${riding.s.toFixed(0)})`);
      ok(Math.abs(riding.deckTop) < 0.2, `the tram deck is standable at the tram floor (Δ ${riding.deckTop.toFixed(2)} m)`);
      ok(riding.hasDeck && riding.speed > 5, `standing on the deck reports a ride velocity (${riding.speed.toFixed(1)} m/s)`, JSON.stringify(riding));
    }
  }

  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
