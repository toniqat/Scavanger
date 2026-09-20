// Structure reachability smoke (2026-09-12).
//
// Why it exists: four user reports — ① the ground floor → second floor stair entrance was walled off and could not
// be climbed from the ground floor ② the stairs broke out of the building instead of staying indoors ③ the basement
// stair railing blocked the ground-floor door ④ invisible walls indoors. `smoke-structures` only measures whether a
// collider stays **inside** what is drawn, and it caught none of the four — every one of them was 「the collider is
// right but a person cannot get past」. Here a body-radius 0.45 m flood fill is run through **real world queries**
// (`getSurfaceY` to lift the feet, then `resolveCollision` to push out — the same order as
// `player/PlayerController`), measuring over several seeds · building kinds whether a person really walks there.
//
// Checks (per building):
//   1. One can walk in from outside the front door (the crashed ship: the rear ramp)
//   2. **Without leaving the building** (no way back in through a breach · a window), from inside the front door:
//      - most of the standable cells of every room are reached (ground floor · second floor — the inside of the
//        locked room is left out)
//      - a two-floor building: the ground-floor stair landing → the second-floor arrival spot
//      - the foot of the roof ladder · in front of the basement door · in front of the locked room's door (a locked
//        door is still walked up to)
//      - within interaction range of every ground container
//   3. The negative control: the roof cannot be climbed on foot (the evidence that the flood fill does not go
//      through walls · ceilings)
//
// 2026-09-12 (the consumable master key · the lab's locked room · the ground drone's vent) — further checks:
//   4. The locked room: while it is locked a person's flood fill **does not reach** the cells inside it (no leak
//      through the door · the vent · a window)
//   5. The vent: walking straight from the door side to the room side, **a ground drone's body** (radius 0.35 ·
//      height 0.45, `resolveCollision(p, r, h)`) gets through and **a person's body** (0.45, no height) is blocked —
//      beside the basement door and beside the locked room's door alike
//   6. The key: no key → refused · the other kind of key → refused (and not consumed) · the right key → it opens and
//      **only that key, one unit** is consumed, and the door leaf's collider goes away
//      (an outpost = `key_basement`, a lab = `keycard_lab`)
//   7. After opening: from inside, the locked room's containers · the basement containers are within reach on foot
//   8. The preview: `world.previewContainerItems(id)` is the same when called twice, and is the same as the contents
//      inventory filled in when it was really opened (a structure's ground · the locked room · a map crate · a
//      container whose key bonus roll came up)
//
// 2026-09-13 — 9. Walking from inside the front door out through it with the **real `PlayerController`**. The flood
//   fill does not go through the controller's slope handling, so it missed the body stopping in front of a wall · the
//   front door on the floor plate over the basement pit because of the terrain normal (it could not get out from
//   inside).
//
// Seeds are cycled until at least so many outposts · labs · second floors · basements · locked rooms · crashed ships
// have turned up (at most MAX_SEEDS).
//
// Usage: node scripts/smoke-structure-reach.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEED_POOL = [21, 7, 1234, 3, 42, 99, 555, 808, 2026, 31337, 11, 64, 777, 4242, 9001, 123, 5150, 6060];
/* 2026-09-14 — it used to be `MAX_SEEDS = 16` plus 「stop once every wanted building kind has turned up」
 * (`enough()`), which stopped after five or six seeds. That early exit **was hiding a bug that had been there all
 * along** (seed 21's lab second floor · an outpost's ground containers). Now the whole pool is run to the end and
 * the failures are counted and reported once at the end — `ok()` never stopped anyway, so the counting is
 * unchanged. */
const MAX_SEEDS = SEED_POOL.length;
const WANT = { outpost: 4, lab: 4, twoFloor: 4, basement: 4, locked: 3, wreck: 2 };
/** Share of a room's standable cells that has to be reached — a corner too tight for a body is no cell at all. */
const ROOM_COVERAGE_MIN = 0.85;

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

/**
 * The flood fill that runs inside the browser. One result row per building.
 * `after` = the second pass **after** the key check opened the doors — only buildings that had a locked door, and it
 * measures nothing but whether the inner containers (`_l` · `_b`) are within reach.
 */
function reachAll({ roomMin, after }) {
  const ctx = window.__game.ctx, w = ctx.world;
  const V3 = ctx.camera.position.constructor;
  const ws = window.__game.getSystem('world');
  const R = 0.45, STEP = 0.3, MARGIN = 4, NODE_CAP = 80000;
  const DRONE_R = 0.35, DRONE_H = 0.45;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const p = new V3();
  const rows = [];
  const defs = new Map(w.getStructures().map((d) => [d.id, d]));

  for (const s of ws.structures.debugNav()) {
    if (after && !s.lockedDoor && !s.basementDoor) continue;
    const t0 = performance.now();
    const nav = s.nav;
    const c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
    const toW = (lx, lz) => [nav.cx + lx * c - lz * sn, nav.cz + lx * sn + lz * c];
    const toL = (x, z) => { const dx = x - nav.cx, dz = z - nav.cz; return [dx * c + dz * sn, -dx * sn + dz * c]; };
    // The grid has to take in the starting spot (outside the front door · beyond the rear ramp) — beyond the
    // crashed ship's ramp is further out than halfD + 4 m
    const I = Math.ceil((Math.max(nav.halfW, Math.abs(nav.doorOut[0])) + MARGIN) / STEP);
    const J = Math.ceil((Math.max(nav.halfD, Math.abs(nav.doorOut[1])) + MARGIN) / STEP);
    const keyOf = (i, j, y) => `${i},${j},${Math.round(y * 2)}`;
    /** The height a body stands at after one step into cell (i, j) from foot height `feet`, null if pushed out. */
    const stand = (i, j, feet) => {
      const [x, z] = toW(i * STEP, j * STEP);
      const y = w.getSurfaceY(x, z, feet);
      p.set(x, y, z);
      w.resolveCollision(p, R);
      return Math.hypot(p.x - x, p.z - z) < 0.02 ? y : null;
    };

    const bfs = (startL, startY, inside) => {
      const seen = new Map();
      const bad = new Set();
      const si = Math.round(startL[0] / STEP), sj = Math.round(startL[1] / STEP);
      const sy = stand(si, sj, startY + 0.3);
      if (sy === null) return { seen, startBlocked: true, capped: false };
      const q = [[si, sj, sy]];
      seen.set(keyOf(si, sj, sy), q[0]);
      const limX = nav.halfW - 0.1, limZ = nav.halfD - 0.1;
      let head = 0;
      while (head < q.length) {
        const [i, j, y] = q[head++];
        for (const [di, dj] of DIRS) {
          const ni = i + di, nj = j + dj;
          if (Math.abs(ni) > I || Math.abs(nj) > J) continue;
          if (inside && (Math.abs(ni * STEP) > limX || Math.abs(nj * STEP) > limZ)) continue;
          const [x, z] = toW(ni * STEP, nj * STEP);
          const ny = w.getSurfaceY(x, z, y);
          const k = keyOf(ni, nj, ny);
          if (seen.has(k) || bad.has(k)) continue;
          p.set(x, ny, z);
          w.resolveCollision(p, R);
          if (Math.hypot(p.x - x, p.z - z) >= 0.02) { bad.add(k); continue; }
          const node = [ni, nj, ny];
          seen.set(k, node);
          q.push(node);
          if (q.length > NODE_CAP) return { seen, startBlocked: false, capped: true };
        }
      }
      return { seen, startBlocked: false, capped: false };
    };
    const near = (seen, lx, lz, y, tol, ytol = 0.35) => {
      let best = Infinity;
      for (const [i, j, yy] of seen.values()) {
        if (Math.abs(yy - y) > ytol) continue;
        const d = Math.hypot(i * STEP - lx, j * STEP - lz);
        if (d < best) best = d;
      }
      return { ok: best <= tol, d: Number.isFinite(best) ? +best.toFixed(2) : null };
    };
    /** Walk straight: local `a` → `b` in 0.1 m steps, surface first · push-out after. The distance left to `b`. */
    const walk = (a, b, y, r, h) => {
      const [ax, az] = toW(a[0], a[1]), [bx, bz] = toW(b[0], b[1]);
      p.set(ax, w.getSurfaceY(ax, az, y + 0.3), az);
      for (let it = 0; it < 90; it++) {
        const dx = bx - p.x, dz = bz - p.z, d = Math.hypot(dx, dz);
        if (d < 0.04) break;
        const st = Math.min(0.1, d);
        p.x += (dx / d) * st; p.z += (dz / d) * st;
        p.y = w.getSurfaceY(p.x, p.z, p.y);
        if (h === undefined) w.resolveCollision(p, r); else w.resolveCollision(p, r, h);
      }
      return +Math.hypot(bx - p.x, bz - p.z).toFixed(2);
    };
    const containersOf = (set, prefix, tol) => {
      const out = { total: 0, reached: 0, missing: [] };
      for (const it of ctx.interactables.all()) {
        if (!it.id.startsWith(`container:${s.id}_${prefix}`)) continue;
        out.total++;
        const [lx, lz] = toL(it.position.x, it.position.z);
        const r = near(set, lx, lz, it.position.y, tol);
        if (r.ok) out.reached++;
        else out.missing.push({ id: it.id.slice(10), d: r.d });
      }
      return out;
    };

    const y0 = nav.levels[0];
    const inside = bfs(nav.doorIn, y0, true);
    const def = defs.get(s.id);

    if (after) {
      rows.push({
        id: s.id, kind: s.kind, unlocked: !!def?.unlocked, inBlocked: inside.startBlocked, capped: inside.capped,
        locked: s.lockedDoor ? containersOf(inside.seen, 'l', 1.5) : null,
        basement: s.basementDoor ? containersOf(inside.seen, 'b', 1.5) : null,
        ms: Math.round(performance.now() - t0),
      });
      continue;
    }

    const outside = bfs(nav.doorOut, y0, false);
    /* 9. (2026-09-13) Walk from inside the front door out through it with the **real `PlayerController`**. The
     * flood fill above only imitates `getSurfaceY` + `resolveCollision`, so it missed the body stopping in front of
     * a wall because the controller's slope handling read the terrain under the floor plate (the basement pit). */
    let exitGap = null;
    if (s.kind !== 'wreck') {
      const Ctl = window.__game.getSystem('player').controller.constructor;
      const ctl = new Ctl();
      const [sx, sz] = toW(nav.doorIn[0], nav.doorIn[1] + 1.5);
      ctl.reset(new V3(sx, w.getSurfaceY(sx, sz, y0 + 0.3), sz));
      const [tx, tz] = toW(nav.doorOut[0], nav.doorOut[1]);
      const mv = { x: 0, z: 1, sprint: false, jump: false, stance: 'stand', aiming: false };
      const res = { footstep: false, landed: 0, jumped: false, rollEnded: false, rung: false, climbEnded: null };
      for (let it = 0; it < 900; it++) {
        const dx = tx - ctl.position.x, dz = tz - ctl.position.z;
        if (Math.hypot(dx, dz) < 0.3) break;
        ctl.update(1 / 60, mv, Math.atan2(-dx, -dz), w, res);
      }
      exitGap = +Math.hypot(tx - ctl.position.x, tz - ctl.position.z).toFixed(2);
    }
    const lockedR = nav.locked;
    const row = {
      exitGap,
      id: s.id, kind: s.kind, floors: nav.levels.length, basement: !!s.basementDoor, lockedRoom: !!s.lockedDoor, breach: nav.breach,
      outBlocked: outside.startBlocked, inBlocked: inside.startBlocked, capped: outside.capped || inside.capped,
      nodes: inside.seen.size,
      doorIn: near(outside.seen, nav.doorIn[0], nav.doorIn[1], y0, 0.45),
      stairBottom: null, stairTop: null, ladder: null, basementDoor: null, lockedDoor: null, lockedLeak: null,
      vents: [],
      containers: { total: 0, reached: 0, missing: [] },
      rooms: [],
      roofWalk: false,
    };
    const set = s.kind === 'wreck' ? outside.seen : inside.seen;

    if (nav.stairBottom) row.stairBottom = near(set, nav.stairBottom[0], nav.stairBottom[1], y0, 0.5);
    if (nav.stairTop) row.stairTop = near(set, nav.stairTop[0], nav.stairTop[1], nav.levels[1], 0.5);
    const lad = w.getLadders().find((l) => l.id.startsWith(`ladder_${s.id}_`));
    if (lad) {
      const [lx, lz] = toL(lad.base.x, lad.base.z);
      row.ladder = near(set, lx, lz, lad.base.y, 0.6);
      // The negative control: if even one cell at roof height was reached on foot, the flood fill went through
      // something. 2026-09-13: only cells **inside the footprint** count as the roof — a cell on a hill outside the
      // building that happens to sit at roof height (seed 7's lab, whose layout the dirt-road corridor moved) is
      // not counted as roof
      for (const [ii, jj, yy] of outside.seen.values()) {
        if (Math.abs(ii * STEP) > nav.halfW || Math.abs(jj * STEP) > nav.halfD) continue;
        if (Math.abs(yy - lad.topY) < 0.3) { row.roofWalk = true; break; }
      }
    }
    if (s.basementDoor) {
      const [lx, lz] = toL(s.basementDoor.x, s.basementDoor.z);
      row.basementDoor = near(set, lx, lz, s.basementDoor.y, 0.6);
    }
    if (s.lockedDoor) {
      const [lx, lz] = toL(s.lockedDoor.x, s.lockedDoor.z);
      row.lockedDoor = near(set, lx, lz, s.lockedDoor.y, 0.6);
    }
    if (lockedR) {
      // While it is locked, a person reaching a cell inside the room (the rectangle inset 0.3 m from the walls)
      // is a leak — from inside or from outside
      const ly = nav.levels[lockedR.k];
      let leak = 0;
      for (const seenSet of [inside.seen, outside.seen]) {
        for (const [i, j, yy] of seenSet.values()) {
          if (Math.abs(yy - ly) > 0.35) continue;
          const x = i * STEP, z = j * STEP;
          if (x > lockedR.x0 + 0.3 && x < lockedR.x1 - 0.3 && z > lockedR.z0 + 0.3 && z < lockedR.z1 - 0.3) leak++;
        }
      }
      row.lockedLeak = leak;
    }
    for (const v of nav.vents) {
      row.vents.push({
        drone: walk(v.out, v.in, v.y, DRONE_R, DRONE_H),
        person: walk(v.out, v.in, v.y, R, undefined),
      });
    }
    row.containers = containersOf(set, 'c', 1.5);
    for (const room of nav.rooms) {
      const level = nav.levels[room.k];
      let clear = 0, got = 0;
      const lost = [];
      for (let i = Math.ceil(room.x0 / STEP); i * STEP <= room.x1; i++) {
        for (let j = Math.ceil(room.z0 / STEP); j * STEP <= room.z1; j++) {
          // A cell inside the locked room (+ the wall-thickness slack) is rightly unreachable while locked —
          // it is not counted
          if (lockedR && room.k === lockedR.k) {
            const x = i * STEP, z = j * STEP;
            if (x > lockedR.x0 - 0.8 && x < lockedR.x1 + 0.8 && z > lockedR.z0 - 0.8 && z < lockedR.z1 + 0.8) continue;
          }
          const y = stand(i, j, level + 0.3);
          if (y === null || Math.abs(y - level) > 0.05) continue;
          clear++;
          if (set.has(keyOf(i, j, y))) got++;
          else if (lost.length < 3) lost.push([+(i * STEP).toFixed(1), +(j * STEP).toFixed(1)]);
        }
      }
      row.rooms.push({ k: room.k, clear, got, cov: clear > 0 ? +(got / clear).toFixed(3) : 1, lost });
    }
    row.ms = Math.round(performance.now() - t0);
    row.roomsOk = row.rooms.every((r) => r.cov >= roomMin);
    rows.push(row);
  }
  return rows;
}

/** The key check (6) per locked-door building — no key · the wrong kind · the right key. Solo = the host path. */
function keyFlow() {
  const ctx = window.__game.ctx, w = ctx.world, inv = ctx.inventory, loot = ctx.loot;
  const count = (id) => inv.countWhere((d) => d.id === id);
  const clear = (id) => { const n = count(id); if (n > 0) inv.consumeWhere((d) => d.id === id, n); };
  const give = (id) => inv.tryAddItem(loot.createItem(id, 1));
  const rows = [];
  for (const s of w.getStructures()) {
    if (!s.unlockDefId || s.unlocked) continue;
    const it = ctx.interactables.all().find((x) => x.id === `struct:${s.id}:door`);
    const doorPos = s.basementDoor ?? s.lockedRoomDoor;
    if (!it || !doorPos) { rows.push({ id: s.id, missing: true }); continue; }
    const doorObs = () => w.getObstacles().some((o) => o.kind === 'door' && Math.hypot(o.position.x - doorPos.x, o.position.z - doorPos.z) < 0.25);
    const key = s.unlockDefId;
    /* 2026-09-21: keys are planet-bound — the id is `<family>_<planet>` (`key_basement_amber` …). The 「wrong key」
     * this test hands over is the **other family on the same planet**, so it stays a real, creatable item. */
    const family = key.startsWith('keycard_lab') ? 'keycard_lab' : 'key_basement';
    const planet = key.slice(family.length + 1);
    const other = `${family === 'key_basement' ? 'keycard_lab' : 'key_basement'}_${planet}`;
    clear(key); clear(other);
    const r = { id: s.id, kind: s.kind, key, basement: !!s.hasBasement, lockedRoom: !!s.hasLockedRoom, missing: false };
    r.promptNoKey = it.getPrompt();
    r.holdNoKey = it.holdTime ?? null;
    it.interact();
    r.denyKeepsLocked = !s.unlocked && doorObs();
    r.otherGiven = give(other);
    it.interact();
    r.wrongKeyKeepsLocked = !s.unlocked && doorObs() && count(other) === 1;
    r.keyGiven = give(key);
    r.promptWithKey = it.getPrompt();
    r.holdWithKey = it.holdTime ?? null;
    it.interact();
    r.unlocked = s.unlocked;
    r.doorGone = !doorObs();
    r.keyLeft = count(key);
    r.otherLeft = count(other);
    r.promptAfter = it.getPrompt();
    clear(other);
    rows.push(r);
  }
  return rows;
}

/** The preview check (8): two previews agree, and it is really opened and compared against inventory's cache. */
function previewFlow() {
  const ctx = window.__game.ctx, w = ctx.world;
  const invSys = window.__game.getSystem('inventory');
  const sig = (items) => {
    const m = new Map();
    for (const it of items) m.set(it.defId, (m.get(it.defId) ?? 0) + it.qty);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, q]) => `${d}x${q}`).join(',');
  };
  const ids = [];
  const all = ctx.interactables.all().filter((x) => x.id.startsWith('container:struct_')).map((x) => x.id.slice(10));
  const keyed = all.filter((id) => (w.previewContainerItems(id) ?? []).some((it) => it.defId.startsWith('key_basement') || it.defId.startsWith('keycard_lab')));
  ids.push(...keyed.slice(0, 3));
  for (const id of all.filter((x) => /_c\d+$/.test(x)).slice(0, 2)) if (!ids.includes(id)) ids.push(id);
  for (const id of all.filter((x) => /_l\d+$/.test(x)).slice(0, 1)) if (!ids.includes(id)) ids.push(id);
  const crate = w.getCrates()[0];
  const rows = [];
  for (const id of ids) {
    const a = w.previewContainerItems(id), b = w.previewContainerItems(id);
    const it = ctx.interactables.all().find((x) => x.id === `container:${id}`);
    const wasCached = !!invSys.containers.get(id);
    it?.interact();
    const cont = invSys.containers.get(id);
    const got = cont ? cont.grid.items().map((pl) => pl.item) : null;
    ctx.inventory.closeAll();
    rows.push({
      id, kind: 'structure', keyed: keyed.includes(id), wasCached,
      stable: !!a && !!b && sig(a) === sig(b), preview: a ? sig(a) : null, opened: got ? sig(got) : null,
    });
  }
  if (crate && !invSys.containers.get(crate.id)) {
    const a = w.previewContainerItems(crate.id);
    ctx.bus.emit('crate:open', { crateId: crate.id, tier: crate.tier, position: crate.position });
    const cont = invSys.containers.get(crate.id);
    ctx.inventory.closeAll();
    rows.push({
      id: crate.id, kind: 'crate', keyed: false, wasCached: false, stable: true,
      preview: a ? sig(a) : null, opened: cont ? sig(cont.grid.items().map((pl) => pl.item)) : null,
    });
  }
  rows.push({ id: 'unknown-id', kind: 'unknown', unknownIsNull: w.previewContainerItems('nope_container') === null });
  return rows;
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

  const seen = { outpost: 0, lab: 0, twoFloor: 0, basement: 0, locked: 0, wreck: 0 };
  const enough = () => Object.entries(WANT).every(([k, v]) => seen[k] >= v);
  const failedSeeds = new Map();      // seed → how many failures that seed had (for the closing summary)
  let seeds = 0, keyedPreviews = 0;
  for (const seed of SEED_POOL) {
    if (seeds >= MAX_SEEDS) break;
    seeds++;
    const failBefore = fail;
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(300);
    const rows = await page.evaluate(reachAll, { roomMin: ROOM_COVERAGE_MIN, after: false });
    console.log(`seed ${seed}: ${rows.length} structures`);
    for (const r of rows) {
      if (r.kind === 'outpost' || r.kind === 'lab') seen[r.kind]++;
      if (r.kind === 'wreck') seen.wreck++;
      if (r.floors === 2) seen.twoFloor++;
      if (r.basement) seen.basement++;
      if (r.lockedRoom) seen.locked++;
      const tag = `${r.id} (${r.kind}${r.floors === 2 ? ' · 2층' : ''}${r.basement ? ' · 지하실' : ''}${r.lockedRoom ? ' · 잠긴 방' : ''}${r.breach ? ` · 틈 ${['북', '서', '동'][r.breach.side]}` : ''})`;
      const detail = JSON.stringify({ ...r, rooms: r.rooms.map((x) => `${x.k}:${x.got}/${x.clear}${x.lost.length ? ` ${JSON.stringify(x.lost)}` : ''}`) });
      console.log(`  --   ${tag}: 노드 ${r.nodes} · 방 ${r.rooms.map((x) => `${x.k}F ${Math.round(x.cov * 100)}%`).join(' ')} · 컨테이너 ${r.containers.reached}/${r.containers.total}${r.vents.length ? ` · 개구멍 ${r.vents.map((v) => `드론 ${v.drone} / 사람 ${v.person}`).join(' · ')}` : ''} · ${r.ms} ms`);
      ok(!r.outBlocked && !r.inBlocked && !r.capped, `${tag}: flood fill 시작 자리가 비어 있다`, detail);
      ok(r.doorIn.ok, `${tag}: 바깥에서 ${r.kind === 'wreck' ? '후미 램프로' : '정문으로'} 걸어 들어간다`, detail);
      if (r.kind !== 'wreck') ok(r.exitGap !== null && r.exitGap < 0.5, `${tag}: 진짜 PlayerController 로 안에서 정문 밖까지 걸어 나간다 (남은 ${r.exitGap} m)`, detail);
      if (r.kind !== 'wreck') ok(r.roomsOk, `${tag}: 방마다 서 있을 수 있는 칸의 ${Math.round(ROOM_COVERAGE_MIN * 100)}% 이상에 **안에서** 닿는다`, detail);
      if (r.stairBottom) ok(r.stairBottom.ok, `${tag}: 1층 안에서 계단 층계참에 닿는다`, detail);
      if (r.stairTop) ok(r.stairTop.ok, `${tag}: 실내 계단으로 2층에 올라간다`, detail);
      if (r.ladder) ok(r.ladder.ok, `${tag}: 옥상 사다리 발치에 안에서 닿는다`, detail);
      if (r.basementDoor) ok(r.basementDoor.ok, `${tag}: 지하 계단으로 지하실 문 앞까지 내려간다`, detail);
      if (r.lockedDoor) ok(r.lockedDoor.ok, `${tag}: 2층 잠긴 방 문 앞까지 안에서 걸어간다`, detail);
      if (r.lockedLeak !== null) ok(r.lockedLeak === 0, `${tag}: 잠긴 동안 사람은 잠긴 방 안쪽 칸에 닿지 못한다 (${r.lockedLeak}칸)`, detail);
      if (r.kind === 'lab') ok(!r.basement, `${tag}: 연구소에는 지하실이 없다`, detail);
      if (r.basement || r.lockedRoom) ok(r.vents.length >= 1, `${tag}: 잠긴 문 옆에 개구멍이 있다 (${r.vents.length})`, detail);
      r.vents.forEach((v, i) => {
        ok(v.drone < 0.15, `${tag}: 개구멍 ${i} — 지상드론 몸(0.35 · 키 0.45)은 지나간다 (남은 ${v.drone} m)`, detail);
        ok(v.person > 0.6, `${tag}: 개구멍 ${i} — 사람 몸(0.45)은 막힌다 (남은 ${v.person} m)`, detail);
      });
      ok(r.containers.reached === r.containers.total, `${tag}: 지상 컨테이너 ${r.containers.total}개 모두 손이 닿는다`, detail);
      if (r.kind !== 'wreck') ok(!r.roofWalk, `${tag}: (음성 대조) 걸어서는 옥상에 못 올라간다`, detail);
    }

    // 8. The preview = the first opening (before the key check · the after-opening flood fill — opening a door
    //    does not change a container's contents, but the order is pinned down)
    const prev = await page.evaluate(previewFlow);
    for (const p of prev) {
      if (p.kind === 'unknown') { ok(p.unknownIsNull, 'previewContainerItems(모르는 id) === null'); continue; }
      if (p.keyed) keyedPreviews++;
      const tag = `seed ${seed} ${p.id}${p.keyed ? ' (열쇠 부가 굴림)' : ''}`;
      ok(p.preview !== null && p.stable, `${tag}: 미리보기가 있고 두 번 불러도 같다`, JSON.stringify(p));
      if (!p.wasCached) ok(p.preview === p.opened, `${tag}: 미리보기 = 실제로 열었을 때의 내용물`, JSON.stringify(p));
    }

    // 6. Keys
    const keys = await page.evaluate(keyFlow);
    for (const k of keys) {
      if (k.missing) { ok(false, `seed ${seed} ${k.id}: 잠긴 문 상호작용 · 위치가 있다`); continue; }
      const tag = `seed ${seed} ${k.id} (${k.kind}, ${k.key})`;
      const detail = JSON.stringify(k);
      ok(k.kind === 'outpost' ? k.key.startsWith('key_basement') && k.basement : k.key.startsWith('keycard_lab') && k.lockedRoom,
        `${tag}: 전진기지 지하실 = 열쇠 · 연구소 잠긴 방 = 키카드`, detail);
      ok(/필요/.test(k.promptNoKey ?? '') && k.holdNoKey === 0, `${tag}: 열쇠 없으면 「… 필요」 프롬프트 · 홀드 0 (${k.promptNoKey})`, detail);
      ok(k.denyKeepsLocked, `${tag}: 열쇠 없이 누르면 문이 그대로 잠겨 있다`, detail);
      ok(k.otherGiven && k.wrongKeyKeepsLocked, `${tag}: 다른 종류 열쇠로는 안 열리고 그 열쇠도 안 줄어든다`, detail);
      ok(k.keyGiven && /개방/.test(k.promptWithKey ?? '') && k.holdWithKey > 0, `${tag}: 맞는 열쇠가 있으면 「… 개방 (E)」 · 홀드 (${k.promptWithKey})`, detail);
      ok(k.unlocked && k.doorGone && k.promptAfter === null, `${tag}: 맞는 열쇠로 열린다 — 문짝 콜라이더가 빠진다`, detail);
      ok(k.keyLeft === 0 && k.otherLeft === 1, `${tag}: 연 열쇠만 1 개 소모된다 (남은 ${k.keyLeft} · 다른 종류 ${k.otherLeft})`, detail);
    }

    // 7. After opening — the inner containers within reach (the door leaf's sliding animation has nothing to do
    //    with the collider)
    const afterRows = await page.evaluate(reachAll, { roomMin: ROOM_COVERAGE_MIN, after: true });
    for (const r of afterRows) {
      const tag = `seed ${seed} ${r.id} (연 뒤)`;
      const detail = JSON.stringify(r);
      if (!r.unlocked) continue;
      if (r.locked) ok(r.locked.total >= 2 && r.locked.reached === r.locked.total, `${tag}: 잠긴 방 컨테이너 ${r.locked.total}개 모두 손이 닿는다 (2–3개)`, detail);
      if (r.basement) ok(r.basement.reached === r.basement.total, `${tag}: 지하실 컨테이너 ${r.basement.total}개 모두 손이 닿는다`, detail);
    }
    if (fail > failBefore) failedSeeds.set(seed, fail - failBefore);
  }
  console.log(`seeds ${seeds}: ${JSON.stringify(seen)} · 열쇠 부가 굴림이 맞은 컨테이너 미리보기 ${keyedPreviews}개`);
  if (failedSeeds.size > 0) console.log(`  --   실패가 난 시드: ${[...failedSeeds].map(([s, n]) => `${s} (${n})`).join(' · ')}`);
  ok(enough(), `건물 종류가 충분히 나왔다 (원하는 수 ${JSON.stringify(WANT)})`, JSON.stringify(seen));
  if (keyedPreviews === 0) console.log('  --   이번 시드들에서는 열쇠 부가 굴림이 맞은 지상 컨테이너가 없었다 (keyChance) — 그 경로의 미리보기 대조는 건너뛰었다');
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
