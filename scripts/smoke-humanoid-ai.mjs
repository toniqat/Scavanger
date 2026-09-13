// Single-player smoke for the 2026-09-13 humanoid faction AI (src/enemies — ai/RogueAI · ai/HumanoidProfile · ai/SquadFlank ·
// parts/Attacks · fx/RogueGrenade): grenade loadouts per faction, the distance aim curve (rogue close vs far, raider far),
// the android (no cover phases, never throws, slower / weaker fire than a rogue), grenades as real inventory (count
// decrements to 0, then no more throws), the incendiary fire zone (burns the player over time, burns other factions but
// not the thrower's, a replica's visual zone does no damage, expires) and the raider squad flanker (breaks far off the
// squad's line toward the player's side; a lone "flanker" never flanks).
// Numbers are read from data/enemy_abilities.csv so the assertions follow the table.
// Usage: node scripts/smoke-humanoid-ai.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
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

/** block → key → number, straight from the csv the game reads. */
function readAbilities() {
  const out = {};
  const text = readFileSync(new URL('../data/enemy_abilities.csv', import.meta.url), 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('block,')) continue;
    const [block, key, value] = line.split(',');
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    (out[block] ??= {})[key] = n;
  }
  return out;
}
const AB = readAbilities();
const ROGUE = AB.HUMANOID_ROGUE, RAIDER = AB.HUMANOID_RAIDER, ANDROID = AB.HUMANOID_ANDROID, FIRE = AB.ENEMY_INCENDIARY;

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
  if (!ROGUE || !RAIDER || !ANDROID || !FIRE) throw new Error('enemy_abilities.csv: HUMANOID_* / ENEMY_INCENDIARY blocks missing');
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
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority && !window.__sys.replica), 'single-player: enemies run as the authority');

  // Test fixtures: no ambient trickle / waves while we stage fights (`training` gates only the spawners), a clean slate,
  // rifle shots recorded instead of resolved (`host.fireGun` is an instance lookup), an open flat spot finder.
  await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world;
    sys.training = true;
    window.__clear = () => { for (const e of [...sys.active]) sys.despawn(e); };
    window.__clear();
    window.__shots = [];
    window.__stubGun = (on) => {
      if (on) sys.fireGun = function (e, t, err, mul) { window.__shots.push({ id: e.id, err, mul, t: ctx.time, enemy: !!t.enemy }); return false; };
      else delete sys.fireGun;
    };
    const blocker = (o) => (o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius) >= 0.5 && (o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height) >= 0.8;
    /** Flattest, emptiest spot of `samples` random ones: blockers within `clear` m, height spread on a `clear` m ring. */
    window.__open = (clear, samples = 500) => {
      let best = null;
      for (let k = 0; k < samples; k++) {
        const x = (Math.random() - 0.5) * 460, z = (Math.random() - 0.5) * 460;
        if (!world.isInsideBounds(x - clear, z - clear) || !world.isInsideBounds(x + clear, z + clear)) continue;
        const h0 = world.getHeightAt(x, z);
        let spread = 0;
        for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; spread = Math.max(spread, Math.abs(world.getHeightAt(x + Math.cos(a) * clear, z + Math.sin(a) * clear) - h0)); }
        const n = world.getObstaclesNear(x, z, clear).filter(blocker).length;
        const score = n * 4 + spread;
        if (!best || score < best.score) best = { x, z, y: h0, n, spread, score };
      }
      return best;
    };
    /**
     * A heading from (x, z) along which a body `dist` m out is **fully** visible from a standing gunner, or null: clear rays
     * to the chest and the feet, and no terrain between rising above the gunner → feet line (a low shot must reach the
     * shins, or the measured hit rate depends on how hilly the lane is rather than on the aim curve).
     */
    window.__clearHeading = (x, z, dist) => {
      const V = window.__V;
      for (let k = 0; k < 24; k++) {
        const a = k * Math.PI / 12;
        const dx = Math.cos(a), dz = Math.sin(a);
        const tx = x + dx * dist, tz = z + dz * dist;
        if (!world.isInsideBounds(tx, tz)) continue;
        const o = new V(x, world.getHeightAt(x, z) + 1.4, z);
        const ty = world.getHeightAt(tx, tz);
        let blocked = false;
        for (const lift of [1.3, 0.15]) {
          const d = new V(tx - x, ty + lift - o.y, tz - z); const l = d.length(); d.multiplyScalar(1 / l);
          if (world.raycast(o, d, l - 0.5)) { blocked = true; break; }
        }
        if (blocked) continue;
        for (let s = 1; s < 24 && !blocked; s++) {
          const f = s / 24; const hx = x + dx * dist * f, hz = z + dz * dist * f;
          if (world.getHeightAt(hx, hz) > o.y + (ty + 0.05 - o.y) * f - 0.1) blocked = true;
        }
        if (!blocked) return { dx, dz };
      }
      return null;
    };
  });

  /* ── 1. grenade loadouts ─────────────────────────────────────────────── */
  console.log('grenade loadouts per faction');
  const loads = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    const out = { rogue: [], raider: [], android: [], hammer: null };
    const put = (type, i) => sys.debugSpawn(type, { x: pp.x + 120 + (i % 6) * 3, z: pp.z + 120 + Math.floor(i / 6) * 3 }, false);
    let i = 0;
    for (const type of ['rogue', 'raider', 'android']) {
      const n = type === 'android' ? 6 : 14;
      for (let k = 0; k < n; k++) { const e = put(type, i++); if (e) out[type].push({ n: e.grenadeCount, k: e.grenadeKind }); }
    }
    const h = sys.debugSpawnNamed ? sys.debugSpawnNamed('rogue_hammer', { x: pp.x + 150, z: pp.z + 150 }) : null;
    out.hammer = h ? h.grenadeCount : null;
    window.__clear();
    return out;
  });
  const inRange = (list, lo, hi) => list.length > 0 && list.every((g) => g.n >= lo && g.n <= hi && Number.isInteger(g.n));
  ok(inRange(loads.rogue, ROGUE.grenadeMin, ROGUE.grenadeMax), `rogues carry ${ROGUE.grenadeMin}–${ROGUE.grenadeMax} grenades (${loads.rogue.map((g) => g.n).join('')})`);
  ok(inRange(loads.raider, RAIDER.grenadeMin, RAIDER.grenadeMax), `raiders carry ${RAIDER.grenadeMin}–${RAIDER.grenadeMax} grenades (${loads.raider.map((g) => g.n).join('')})`);
  ok(loads.android.length > 0 && loads.android.every((g) => g.n === 0), `androids carry none (${loads.android.map((g) => g.n).join('')})`);
  const kinds = new Set([...loads.rogue, ...loads.raider].map((g) => g.k));
  ok(kinds.has('frag') && kinds.has('incendiary') && [...kinds].every((k) => k === 'frag' || k === 'incendiary'), `both kinds are rolled (${[...kinds].join(', ')})`);
  ok(loads.hammer === null || loads.hammer === 0, `a named rogue (타길라) carries none (${loads.hammer})`);

  /* ── 2. distance aim curve (fireGun sampled directly) ───────────────── */
  console.log('distance accuracy (fireGun, settled aim error from the faction curve)');
  const range = await P(() => {
    const ctx = window.__game.ctx; const world = ctx.world; const V = window.__V;
    for (let tries = 0; tries < 6; tries++) {
      const spot = window.__open(12, 300);
      if (!spot) continue;
      const h = window.__clearHeading(spot.x, spot.z, 84);
      if (!h) continue;
      ctx.player.spawnStanding(new V(spot.x, world.getHeightAt(spot.x, spot.z), spot.z), Math.atan2(-h.dx, -h.dz));
      ctx.player.hp = ctx.player.maxHp;
      window.__range = { x: spot.x, z: spot.z, dx: h.dx, dz: h.dz };
      return window.__range;
    }
    return null;
  });
  ok(!!range, 'found an open spot with an 84 m clear line', JSON.stringify(range));
  await waitSim(0.4);
  const acc = await P(async (a) => {
    const M = await import('/src/enemies/ai/HumanoidProfile.ts');
    const ctx = window.__game.ctx; const sys = window.__sys; const r = window.__range;
    const target = sys.targets.local();
    if (!target) return null;
    const out = {};
    for (const c of a.cases) {
      window.__clear();
      const e = sys.debugSpawn(c.type, { x: r.x + r.dx * c.d, z: r.z + r.dz * c.d }, false);
      if (!e) { out[`${c.type}${c.d}`] = null; continue; }
      e.yaw = Math.atan2(r.x - e.position.x, r.z - e.position.z);
      e.anim.aim = 1;
      e.animate(0);
      const err = M.humanoidAimError(M.profileOfFaction(e.faction), c.d, 1);
      let hits = 0;
      for (let i = 0; i < a.n; i++) {
        ctx.player.hp = ctx.player.maxHp;
        if (sys.fireGun(e, target, err, 0.01)) hits++;
      }
      out[`${c.type}${c.d}`] = { rate: hits / a.n, err: +err.toFixed(4) };
      sys.despawn(e);
    }
    ctx.player.hp = ctx.player.maxHp;
    return out;
  }, { n: 600, cases: [{ type: 'rogue', d: 20 }, { type: 'rogue', d: 80 }, { type: 'raider', d: 80 }, { type: 'android', d: 20 }] });
  const rate = (k) => acc?.[k]?.rate ?? -1;
  console.log(`  rates: ${JSON.stringify(acc)}`);
  ok(rate('rogue20') >= 0.5, `rogue at 20 m is threatening (hit rate ${rate('rogue20').toFixed(2)} ≥ 0.5)`);
  ok(rate('rogue80') >= 0 && rate('rogue80') <= 0.15 && rate('rogue80') < rate('rogue20') * 0.4, `rogue at 80 m is very inaccurate (${rate('rogue80').toFixed(3)} ≤ 0.15 and < 40 % of 20 m)`);
  ok(rate('raider80') >= Math.max(rate('rogue80') * 3, rate('rogue80') + 0.05), `raider at 80 m is clearly more accurate than a rogue (${rate('raider80').toFixed(3)} vs ${rate('rogue80').toFixed(3)}, ≥ 3× and +0.05)`);
  ok(rate('android20') >= 0 && rate('android20') < rate('rogue20'), `android at 20 m hits less than a rogue (${rate('android20').toFixed(2)} < ${rate('rogue20').toFixed(2)})`);

  /* ── 3. android: no cover, no grenades, slow weak fire ──────────────── */
  console.log('android: stands, never takes cover, never throws; fires less than a rogue');
  const watch = async (type, seconds, opts = {}) => {
    const setup = await P((a) => {
      const ctx = window.__game.ctx; const sys = window.__sys; const r = window.__range;
      window.__clear();
      window.__shots.length = 0;
      window.__stubGun(true);
      const e = sys.debugSpawn(a.type, { x: r.x + r.dx * 22, z: r.z + r.dz * 22 }, false);
      if (!e) return null;
      e.yaw = Math.atan2(r.x - e.position.x, r.z - e.position.z);
      e.aware = true; e.state = 'alert'; e.stateTime = 0;
      if (a.grenades) { e.grenadeCount = 3; e.grenadeKind = 'frag'; e.grenadeCd = 0; }
      if (a.wall) {
        const world = ctx.world; const V = window.__V;
        window.__rc = world.raycast;
        world.raycast = function (o, d, max) { if (max > 3) return { point: new V(o.x + d.x, o.y + d.y, o.z + d.z), normal: new V(-d.x, -d.y, -d.z), distance: 1 }; return window.__rc.call(world, o, d, max); };
      }
      window.__watch = { id: e.id, phases: {}, throwSeen: false, thrown0: sys.grenadesThrown, maxHint: -1, hints: {} };
      ctx.player.hp = ctx.player.maxHp;
      return { id: e.id };
    }, { type, grenades: !!opts.grenades, wall: !!opts.wall });
    if (!setup) return null;
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const s = await P(() => {
        const ctx = window.__game.ctx; const sys = window.__sys; const w = window.__watch;
        ctx.player.hp = ctx.player.maxHp;
        const e = sys.find(w.id);
        if (!e || e.state === 'dead') return { gone: true, t: ctx.time };
        if (e.state !== 'chase' && e.state !== 'alert' && e.state !== 'stagger') { e.aware = true; e.state = 'chase'; e.stateTime = 0; }
        w.phases[e.roguePhase] = (w.phases[e.roguePhase] ?? 0) + 1;
        const hint = sys.debugHint(w.id); w.hints[hint] = (w.hints[hint] ?? 0) + 1;
        if (e.throwTimer > 0) w.throwSeen = true;
        return { t: ctx.time };
      });
      if (s.gone || s.t - t0 >= seconds) break;
      await sleep(40);
    }
    return P(() => {
      const ctx = window.__game.ctx; const sys = window.__sys; const w = window.__watch;
      if (window.__rc) { ctx.world.raycast = window.__rc; window.__rc = null; }
      const shots = window.__shots.filter((x) => x.id === w.id);
      const e = sys.find(w.id);
      const out = { phases: w.phases, hints: w.hints, throwSeen: w.throwSeen, thrown: sys.grenadesThrown - w.thrown0, shots: shots.length,
        meanErr: shots.length ? shots.reduce((s, x) => s + x.err, 0) / shots.length : 0, mul: shots.length ? shots[0].mul : 0, grenades: e ? e.grenadeCount : -1 };
      window.__clear();
      return out;
    });
  };
  const android = await watch('android', 14);
  ok(!!android, 'android spawned 22 m from the player with a clear line', JSON.stringify(android));
  ok(android && !android.phases[1] && !android.phases[2] && !android.phases[4], `android never enters cover (1, 2) or rush (4) phases (${JSON.stringify(android?.phases)})`);
  ok(android && android.shots >= 1, `android fires (${android?.shots} shots in 14 s)`);
  ok(android && !android.hints[6] && !android.hints[13], `android never shows the cover / throw hints (${JSON.stringify(android?.hints)})`);
  const rogue = await watch('rogue', 14);
  ok(rogue && android && rogue.shots > android.shots, `a rogue in the same spot fires more (${rogue?.shots} vs android ${android?.shots})`);
  ok(rogue && android && android.mul < rogue.mul && android.meanErr > rogue.meanErr, `android damage × ${android?.mul} < rogue × ${rogue?.mul}, aim error ${android?.meanErr.toFixed(3)} > ${rogue?.meanErr.toFixed(3)}`);
  const hidden = await watch('android', 9, { grenades: true, wall: true });
  ok(hidden && !hidden.throwSeen && hidden.thrown === 0 && hidden.grenades === 3, `a hidden target never draws an android grenade even with 3 in hand (${JSON.stringify({ seen: hidden?.throwSeen, thrown: hidden?.thrown, left: hidden?.grenades })})`);
  ok(hidden && !hidden.phases[1] && !hidden.phases[2], `…and it still takes no cover (${JSON.stringify(hidden?.phases)})`);

  /* ── 4. rogue grenades are inventory ────────────────────────────────── */
  console.log('rogue grenades: only while carrying, one per throw, then none');
  const gset = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V; const r = window.__range;
    window.__clear();
    window.__stubGun(true);
    const e = sys.debugSpawn('rogue', { x: r.x + r.dx * 15, z: r.z + r.dz * 15 }, false);
    if (!e) return null;
    e.aware = true; e.state = 'chase'; e.roguePhase = 0; e.stateTime = 0; e.grenadeCount = 2; e.grenadeKind = 'frag'; e.grenadeCd = 0; e.noLosHold = 0;
    window.__anchor = [e.position.x, e.position.y, e.position.z];
    window.__rc = world.raycast;
    world.raycast = function (o, d, max) { if (max > 3) return { point: new V(o.x + d.x, o.y + d.y, o.z + d.z), normal: new V(-d.x, -d.y, -d.z), distance: 1 }; return window.__rc.call(world, o, d, max); };
    return { id: e.id, thrown0: sys.grenadesThrown };
  });
  ok(!!gset, 'rogue placed 15 m away with 2 frag grenades, target hidden behind a virtual wall');
  const counts = [];
  let gthrown = gset?.thrown0 ?? 0;
  for (let k = 0; k < 2 && gset; k++) {
    const t0 = await P(() => window.__game.ctx.time);
    let got = null;
    for (;;) {
      const s = await P((a) => {
        const ctx = window.__game.ctx; const sys = window.__sys;
        ctx.player.hp = ctx.player.maxHp;
        const e = sys.find(a.id);
        if (!e || e.state === 'dead') return { gone: true, t: ctx.time };
        if (e.throwTimer <= 0 && window.__anchor) e.position.set(window.__anchor[0], window.__anchor[1], window.__anchor[2]);
        if (e.state !== 'chase' && e.state !== 'stagger') { e.aware = true; e.state = 'chase'; e.stateTime = 0; }
        return { t: ctx.time, thrown: sys.grenadesThrown, count: e.grenadeCount };
      }, gset);
      if (s.gone) break;
      if (s.thrown > gthrown) { gthrown = s.thrown; got = s.count; break; }
      if (s.t - t0 > 30) break;
      await sleep(40);
    }
    counts.push(got);
    await P((a) => { const e = window.__sys.find(a.id); if (e) { e.grenadeCd = 0; e.noLosHold = 0; } }, gset);
  }
  ok(counts[0] === 1 && counts[1] === 0, `grenadeCount 2 → ${counts[0]} → ${counts[1]} after two throws`);
  {
    const t0 = await P(() => window.__game.ctx.time);
    let seen = false, thrownAfter = gthrown;
    for (;;) {
      const s = await P((a) => {
        const ctx = window.__game.ctx; const sys = window.__sys;
        ctx.player.hp = ctx.player.maxHp;
        const e = sys.find(a.id);
        if (!e || e.state === 'dead') return { gone: true, t: ctx.time };
        e.grenadeCd = 0;                      // nothing but the empty pouch may stop it
        if (window.__anchor) e.position.set(window.__anchor[0], window.__anchor[1], window.__anchor[2]);
        if (e.state !== 'chase' && e.state !== 'stagger') { e.aware = true; e.state = 'chase'; e.stateTime = 0; }
        return { t: ctx.time, throwing: e.throwTimer > 0, thrown: sys.grenadesThrown, hold: e.noLosHold };
      }, gset);
      if (s.gone) break;
      if (s.throwing) seen = true;
      thrownAfter = s.thrown;
      if (s.t - t0 > 9) break;
      await sleep(40);
    }
    ok(!seen && thrownAfter === gthrown, `with 0 left it never winds up or throws again (${thrownAfter - gthrown} more)`);
  }
  await P(() => { const w = window.__game.ctx.world; if (window.__rc) { w.raycast = window.__rc; window.__rc = null; } window.__anchor = null; window.__clear(); });

  /* ── 5. incendiary fire zone ─────────────────────────────────────────── */
  console.log('incendiary: a real fire zone');
  const inc = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V; const r = window.__range;
    window.__clear();
    const px = r.x + r.dx * 30, pz = r.z + r.dz * 30;
    const e = sys.debugSpawn('rogue', { x: r.x + r.dx * 18, z: r.z + r.dz * 18 }, false);
    if (!e) return null;
    e.grenadeKind = 'incendiary'; e.grenadeCount = 1;
    e.yaw = Math.atan2(r.x - e.position.x, r.z - e.position.z); e.animate(0);
    const aim = new V(r.x + r.dx * 6, 0, r.z + r.dz * 6); aim.y = world.getHeightAt(aim.x, aim.z);
    const exploded0 = sys.grenadesExploded;
    const thrown = sys.throwGrenade(e, aim);
    const left = e.grenadeCount;
    const refused = sys.throwGrenade(e, aim);      // empty now: must refuse
    sys.despawn(e);
    ctx.player.spawnStanding(new V(px, world.getHeightAt(px, pz), pz), 0);   // out of the blast
    return { thrown, left, refused, exploded0 };
  });
  ok(inc && inc.thrown === true && inc.left === 0 && inc.refused === false, `throwGrenade spends the last incendiary and then refuses (${JSON.stringify(inc)})`);
  await waitFor(page, (n) => window.__sys.grenadesExploded > n, 'incendiary fuse', 20000, inc?.exploded0 ?? 0);
  const zone = await P(() => { const zs = window.__sys.grenades.debugFireZones(); return zs.length ? zs[0] : null; });
  ok(zone && zone.authority === true && zone.faction === 'rogue' && Math.abs(zone.radius - FIRE.radius) < 1e-6 && zone.life > 0, `a fire zone burns where it landed (authority, thrower's faction, radius ${FIRE.radius}) (${JSON.stringify(zone)})`);
  const burn = { hp0: 0, hp1: 0, burning: false };
  if (zone) {
    Object.assign(burn, await P((z) => {
      const ctx = window.__game.ctx; const V = window.__V;
      ctx.player.spawnStanding(new V(z.x, ctx.world.getHeightAt(z.x, z.z), z.z), 0);
      return { hp0: ctx.player.hp + (ctx.player.shield ?? 0) };
    }, zone));
    await waitSim(2.5);
    Object.assign(burn, await P(() => { const pl = window.__game.ctx.player; return { hp1: pl.hp + (pl.shield ?? 0), burning: !!pl.isBurning }; }));
  }
  const expected = FIRE.dps * 2.0;
  ok(zone && burn.burning && burn.hp0 - burn.hp1 >= expected * 0.5, `the player standing in it burns over time (hp+shield ${burn.hp0.toFixed(1)} → ${burn.hp1.toFixed(1)}, ≥ ${(expected * 0.5).toFixed(0)} expected; burning ${burn.burning})`);
  // other factions burn, the thrower's does not
  const fac = zone ? await P((z) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V; const r = window.__range;
    ctx.player.spawnStanding(new V(r.x - r.dx * 40, ctx.world.getHeightAt(r.x - r.dx * 40, r.z - r.dz * 40), r.z - r.dz * 40), 0);
    ctx.player.hp = ctx.player.maxHp;
    const bug = sys.debugSpawn('scavenger', { x: z.x + 1, z: z.z }, false);
    const raider = sys.debugSpawn('raider', { x: z.x - 1, z: z.z }, false);
    const rogue = sys.debugSpawn('rogue', { x: z.x, z: z.z + 1 }, false);
    window.__pins = [bug, raider, rogue].filter(Boolean).map((e) => ({ id: e.id, p: [e.position.x, e.position.y, e.position.z], hp0: e.hp, burned: false }));
    return window.__pins.length;
  }, zone) : 0;
  if (fac) {
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const t = await P(() => {
        const sys = window.__sys;
        for (const pin of window.__pins) {
          const e = sys.find(pin.id);
          if (!e || e.state === 'dead') continue;
          e.position.set(pin.p[0], pin.p[1], pin.p[2]);
          if (e.burnTimer > 0) pin.burned = true;
        }
        return window.__game.ctx.time;
      });
      if (t - t0 > 1.6) break;
      await sleep(40);
    }
  }
  const pins = await P(() => (window.__pins ?? []).map((pin) => { const e = window.__sys.find(pin.id); return { type: e?.type, burned: pin.burned, dhp: e ? +(pin.hp0 - e.hp).toFixed(1) : null, attacker: e ? e.burnAttacker : null }; }));
  const byType = Object.fromEntries(pins.map((x) => [x.type, x]));
  ok(byType.scavenger && byType.scavenger.burned && byType.scavenger.dhp > 0, `a bug in the zone burns (${JSON.stringify(byType.scavenger)})`);
  ok(byType.raider && byType.raider.burned && byType.raider.dhp > 0, `a raider (other faction) in the zone burns (${JSON.stringify(byType.raider)})`);
  // (hp is not asserted for the rogue: the pinned scavenger next to it is hostile and bites it)
  ok(byType.rogue && !byType.rogue.burned && byType.rogue.attacker === null, `a rogue (the thrower's faction) does not burn (${JSON.stringify(byType.rogue)})`);
  ok(pins.filter((x) => x.burned).every((x) => x.attacker === 'ai' || x.attacker === null), `the enemy fire credits nobody (${pins.map((x) => x.attacker).join(', ')})`);
  await P(() => window.__clear());
  // a replica's visual zone (host `grenadeHit {k: incendiary}`): FX + zone, no damage
  const vis = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V; const r = window.__range;
    const qx = r.x - r.dx * 20, qz = r.z - r.dz * 20;
    const q = new V(qx, ctx.world.getHeightAt(qx, qz), qz);
    ctx.player.spawnStanding(q.clone(), 0);
    ctx.player.hp = ctx.player.maxHp;
    const n0 = sys.grenades.fireZoneCount();
    sys.grenadeHitRemote(q, 'incendiary');
    const zs = sys.grenades.debugFireZones();
    return { n0, n1: zs.length, visual: zs.some((z) => !z.authority && Math.hypot(z.x - qx, z.z - qz) < 0.5), hp0: ctx.player.hp + (ctx.player.shield ?? 0) };
  });
  await waitSim(1.5);
  const vis2 = await P(() => { const pl = window.__game.ctx.player; return { hp1: pl.hp + (pl.shield ?? 0), burning: !!pl.isBurning }; });
  ok(vis.visual && vis.n1 === vis.n0 + 1, `grenadeHitRemote(p, incendiary) lights a visual (non-authority) zone (${vis.n0} → ${vis.n1})`);
  ok(Math.abs(vis.hp0 - vis2.hp1) < 0.01 && !vis2.burning, `the visual zone does no damage (${vis.hp0} → ${vis2.hp1})`);
  const gone = await waitFor(page, () => window.__sys.grenades.fireZoneCount() === 0, 'fire zones expire', Math.round((FIRE.duration + 4) * 1000 * 4)).catch(() => false);
  ok(!!gone, `fire zones expire after ENEMY_INCENDIARY.duration (${FIRE.duration} s)`);

  /* ── 6. raider squad flanker ─────────────────────────────────────────── */
  console.log('raider squad: the flanker breaks off to the player\'s side');
  const sq = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V;
    window.__clear();
    window.__stubGun(true);
    let best = null;
    for (let t = 0; t < 4 && !best; t++) {
      const spot = window.__open(38, 600);
      if (!spot) continue;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4 + Math.random() * 0.3;
        const dx = Math.cos(a), dz = Math.sin(a);
        if (world.isInsideBounds(spot.x + dx * 45, spot.z + dz * 45)) { best = { ...spot, dx, dz }; break; }
      }
    }
    if (!best) return null;
    const p = new V(best.x, world.getHeightAt(best.x, best.z), best.z);
    ctx.player.spawnStanding(p, Math.atan2(-best.dx, -best.dz));   // facing the squad (player forward = −sin, −cos)
    ctx.player.hp = ctx.player.maxHp;
    const sx = best.x + best.dx * 30, sz = best.z + best.dz * 30;
    const px = -best.dz, pz = best.dx;
    const mk = (off, role) => {
      const e = sys.debugSpawn('raider', { x: sx + px * off, z: sz + pz * off }, false, { squadId: 7701, role, site: 'outpost' });
      if (!e) return null;
      e.yaw = Math.atan2(best.x - e.position.x, best.z - e.position.z);
      e.aware = true; e.state = 'chase'; e.stateTime = 0; e.grenadeCount = 0;
      return e.id;
    };
    const ids = { m1: mk(-3.5, 'member'), m2: mk(3.5, 'member'), fl: mk(0, 'flanker') };
    window.__sq = { ids, p: [p.x, p.z], d: [best.dx, best.dz], spot: best };
    return { ...window.__sq, n: best.n, spread: +best.spread.toFixed(2) };
  });
  ok(sq && sq.ids.m1 && sq.ids.m2 && sq.ids.fl, `3 raiders (squad 7701, one flanker) 30 m in front of the player (${sq?.n} blockers within 38 m)`, JSON.stringify(sq));
  const fl = { phase1: false, push: false, maxAng: 0, maxLat: 0, memberMaxAng: 0, samples: 0, last: null };
  if (sq) {
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const s = await P(() => {
        const ctx = window.__game.ctx; const sys = window.__sys; const q = window.__sq;
        ctx.player.hp = ctx.player.maxHp;
        const ang = (e) => {
          const vx = e.position.x - q.p[0], vz = e.position.z - q.p[1]; const l = Math.hypot(vx, vz) || 1;
          return { ang: Math.acos(Math.max(-1, Math.min(1, (vx * q.d[0] + vz * q.d[1]) / l))) * 180 / Math.PI, lat: Math.abs(vx * q.d[1] - vz * q.d[0]), dist: l };
        };
        const out = { t: ctx.time };
        for (const k of ['m1', 'm2', 'fl']) {
          const e = sys.find(q.ids[k]);
          if (!e || e.state === 'dead') { out[k] = null; continue; }
          if (e.state !== 'chase' && e.state !== 'stagger') { e.aware = true; e.state = 'chase'; e.stateTime = 0; }
          out[k] = { ...ang(e), flank: e.flankPhase, phase: e.roguePhase, hint: sys.debugHint(e.id) };
        }
        return out;
      });
      if (s.fl) {
        fl.samples++;
        if (s.fl.flank === 1) fl.phase1 = true;
        if (fl.phase1 && s.fl.phase === 4) fl.push = true;
        if (s.fl.ang > fl.maxAng) { fl.maxAng = s.fl.ang; fl.last = s; }
        fl.maxLat = Math.max(fl.maxLat, s.fl.lat);
      }
      // members that rushed / leapfrogged inside 12 m show big angles from tiny sideways offsets — judge the line only farther out
      for (const k of ['m1', 'm2']) if (s[k] && s[k].dist >= 12) fl.memberMaxAng = Math.max(fl.memberMaxAng, s[k].ang);
      if (s.t - t0 > 26 || (fl.push && s.t - t0 > 8)) break;
      await sleep(40);
    }
  }
  ok(fl.phase1, `the flanker started a flank arc (flankPhase 1 seen, ${fl.samples} samples)`, JSON.stringify(fl.last));
  ok(fl.maxAng >= 60 && fl.maxLat >= 10, `it went far off the squad's line toward the player's side (max ${fl.maxAng.toFixed(0)}° from the line, ${fl.maxLat.toFixed(1)} m lateral)`, JSON.stringify(fl.last));
  ok(fl.maxAng >= fl.memberMaxAng + 20, `the other two stayed on the line (members max ${fl.memberMaxAng.toFixed(0)}° vs flanker ${fl.maxAng.toFixed(0)}°)`);
  ok(fl.push, 'after the arc it pushed (roguePhase 4 = rush hint 7)');
  // a "flanker" with no squadmates is a normal raider
  const lone = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const q = window.__sq;
    window.__clear();
    if (!q) return null;
    const e = sys.debugSpawn('raider', { x: q.p[0] + q.d[0] * 30, z: q.p[1] + q.d[1] * 30 }, false, { squadId: 7702, role: 'flanker' });
    if (!e) return null;
    e.aware = true; e.state = 'chase'; e.stateTime = 0; e.grenadeCount = 0; e.flankCd = 0;
    window.__lone = { id: e.id, seen: false };
    return { id: e.id };
  });
  if (lone) {
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const t = await P(() => {
        const ctx = window.__game.ctx; const e = window.__sys.find(window.__lone.id);
        ctx.player.hp = ctx.player.maxHp;
        if (e && e.flankPhase === 1) window.__lone.seen = true;
        if (e && e.state !== 'chase' && e.state !== 'stagger') { e.aware = true; e.state = 'chase'; }
        return ctx.time;
      });
      if (t - t0 > 6) break;
      await sleep(60);
    }
  }
  ok(lone && !(await P(() => window.__lone.seen)), 'a lone raider marked flanker (no squadmates) never flanks');

  await P(() => { window.__stubGun(false); window.__clear(); window.__sys.training = false; });
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
