// Global fall damage + the landing feedback (2026-09-15, TODO E-12 · B-14).
//
// Why it exists: fall damage spans four folders — `player/PlayerController` (measures the height) → `player/parts/Fall`
// (the damage · `player:fell` · `camera:shake`) → `audio/AudioSystem.fallImpact` (the landing sound + the material
// footstep) · `ui/hud/FallVignette` (the red vignette). The last section of `smoke-ghost` calls `Fall.onLanded`
// **directly** and checks the wire only — this script lifts the body into the air for real and looks at the whole in-game
// path that **drops it under gravity**. Every expected value is read from `data/constants.csv` (no number in the code).
//
// Checks (a solo raid, not the tutorial):
//   1. The formula: real drops from below the safe height · just above it · 12 m give an HP loss ≈ min(MAX, (h − SAFE) ×
//      PER_M), and below the safe height there is neither damage nor `player:fell` (40 m, in 5, is the lethal fall that
//      sees the request capped at MAX)
//   2. The shield bypass (2026-09-16, user's decision): even with the armor shield full, fall damage goes entirely to HP —
//      the shield does not drop by a point
//   3. A lethal fall: solo goes straight to `player:died` (never downed)
//   4. A body something else lifted (`ctx.player.applyImpulse` as the jump pad does · `applyKnockback` · an impulse
//      mid-fall) is exempt on that landing, and the next ordinary fall hurts again
//   5. `player:fell {height, damage = what was actually lost, rule 'normal'}`
//   6. Every damaging landing gives exactly one `camera:shake` {min(FALL_SHAKE_MAX, damage × PER_DAMAGE), FALL_SHAKE_S} ·
//      one `fall_impact` (no position; the heavier the fall the lower the pitch · the louder it is) + the material footstep
//      layer under the feet · `.fall-vignette` at opacity min(1, damage / FULL) → 0 · hidden after FALL_VIGNETTE_S of
//      simulation time. A landing with no damage has none of it
//   7. A squadmate's fall: `remotePlayers.receiveFall` (a fake lobby member) at 5 m → an attenuated `fall_impact` (+ the
//      footstep layer), at 50 m → refused · silent; audio's own curve keeps a 50 m `player:remoteFell` silent too, and the
//      vignette does not react
//
// Usage: node scripts/smoke-fall-damage.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
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

/** One number out of `data/constants.csv`. */
const CSV = readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8');
function k(name) {
  const m = CSV.match(new RegExp(`^${name},([^,\\r\\n]+)`, 'm'));
  if (!m) throw new Error(`constant ${name} missing`);
  return Number(m[1]);
}
const C = {
  SAFE: k('FALL_DAMAGE_SAFE_M'), PER_M: k('FALL_DAMAGE_PER_M'), MAX: k('FALL_DAMAGE_MAX'),
  SHAKE_PER: k('FALL_SHAKE_PER_DAMAGE'), SHAKE_MAX: k('FALL_SHAKE_MAX'), SHAKE_S: k('FALL_SHAKE_S'),
  VIG_S: k('FALL_VIGNETTE_S'), VIG_FULL: k('FALL_VIGNETTE_FULL_DAMAGE'),
  REMOTE_RANGE: k('FALL_REMOTE_SOUND_RANGE'), FALLOFF_EXP: k('FOOTSTEP_FALLOFF_EXP'), GRAVITY: k('GRAVITY'),
};
const fallDamage = (h) => (h <= C.SAFE ? 0 : Math.min(C.MAX, (h - C.SAFE) * C.PER_M));
const shakeFor = (d) => Math.min(C.SHAKE_MAX, d * C.SHAKE_PER);
const vignetteFor = (d) => Math.min(1, d / C.VIG_FULL);

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const T0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });

  /* ── The ship: armor on (launch with the shield full) ───────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  const armor = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const was = ctx.inventory.getEquipped('armor');
    const before = { armor: was ? was.defId : null, shield: ctx.player.shield, max: ctx.player.maxShield };
    const it = ctx.loot.createItem('armor_4');
    if (it) { ctx.inventory.tryAddItemAnywhere(it); try { ctx.inventory.equip(it.uid, 'armor'); } catch { /* already worn */ } }
    const eq = ctx.inventory.getEquipped('armor');
    return { before, now: eq ? eq.defId : null };
  });
  ok(armor.now === 'armor_4', `armor equipped in the ship (${JSON.stringify(armor)})`);
  // The shield fills to a new maximum only on a **ship frame** (`syncShield` — a swap mid-raid does not fill it). So this waits at least one frame before the launch.
  const hubShield = await waitFor(page, (prevMax) => { const p = window.__game.ctx.player; return p.maxShield > 0 && p.maxShield !== prevMax && p.shield === p.maxShield && `${p.shield}/${p.maxShield}`; }, 'hub shield refill', 20000, armor.before.max);
  ok(!!hubShield, `ship refilled the shield to the new armor's max before deploy (${hubShield})`);

  await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), SEED);
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
  await waitFor(page, () => { const p = window.__game.ctx.player; return p.spawned && p.controlsEnabled && !p.isDropping && p.isGrounded; }, 'landed', 40000);

  /* ── Instrumentation: bus records · play / applyDamage spies · waits · flat ground ─── */
  const setup = await page.evaluate(async () => {
    const G = window.__game, ctx = G.ctx, bus = ctx.bus;
    const ps = G.getSystem('player'), hud = G.getSystem('hud'), audio = G.getSystem('audio'), en = G.getSystem('enemies');
    const V3 = ctx.camera.position.constructor;
    const vigEl = document.querySelector('.fall-vignette');
    const pool = () => ps.hp + ps.shield;
    const R = window.__rec = { fell: [], shake: [], died: [], downed: [], launched: [], remoteFell: [], snd: [], dmg: [] };
    bus.on('player:fell', (e) => R.fell.push({
      height: e.height, damage: e.damage, rule: e.rule, t: ctx.time, hp: ps.hp, shield: ps.shield, pool: pool(),
      vig: hud.fallVignetteOpacity, vigHidden: vigEl ? vigEl.hidden : null, vigStyle: vigEl ? Number(vigEl.style.opacity) : null,
      keys: Object.keys(e).sort().join(','),
    }));
    bus.on('camera:shake', (e) => R.shake.push({ intensity: e.intensity, duration: e.duration, t: ctx.time }));
    bus.on('player:died', () => R.died.push({ t: ctx.time }));
    bus.on('player:downed', () => R.downed.push({ t: ctx.time }));
    bus.on('player:launched', () => R.launched.push({ t: ctx.time }));
    bus.on('player:remoteFell', (e) => R.remoteFell.push({ peerId: e.peerId, damage: e.damage, p: [e.position.x, e.position.y, e.position.z], t: ctx.time }));
    const play = audio.play.bind(audio);
    audio.play = (id, pos, vol, pitch, auto, panOnly, dedupe, rateLimit) => {
      if (id === 'fall_impact' || id === 'player_land' || String(id).startsWith('footstep_')) {
        R.snd.push({ id, hasPos: !!pos, p: pos ? [pos.x, pos.y, pos.z] : null, vol, pitch, panOnly: !!panOnly, dedupe: dedupe !== false, t: ctx.time });
      }
      return play(id, pos, vol, pitch, auto, panOnly, dedupe, rateLimit);
    };
    const applyDamage = ps.applyDamage.bind(ps);
    // 2026-09-16: the source · the options (`bypassShield`) are passed straight through — passing the first three only loses the fall's shield bypass in the spy
    ps.applyDamage = (amount, from, dot, ...rest) => {
      const before = pool();
      const r = applyDamage(amount, from, dot, ...rest);
      R.dmg.push({ amount, dot: !!dot, hasFrom: !!from, source: rest[0]?.kind ?? null, bypass: !!rest[1]?.bypassShield, before, after: pool(), t: ctx.time });
      return r;
    };
    // A wait on simulation time (dt is clamped to 50 ms)
    window.__simWait = (sec) => new Promise((res) => { const t = ctx.time + sec; const f = () => (ctx.time >= t ? res() : setTimeout(f, 15)); f(); });
    window.__simUntil = (pred, simTimeout) => new Promise((res) => {
      const t = ctx.time + simTimeout;
      const f = () => { if (pred()) res(true); else if (ctx.time >= t) res(false); else setTimeout(f, 5); };
      f();
    });
    window.__calm = () => { try { en.killAll(); ctx.enemies.setThreatLevel(0); if (en.spawner) en.spawner.timer = 1e9; } catch { /* no enemies */ } };
    window.__calm();

    // Wakes the AudioContext — `fallImpact` looks for running **before** it calls `play`
    try { audio.ensureContext(); await audio.ac?.resume(); } catch { /* keep state */ }

    // Flat ground: the terrain height spread over a 2 m ring < 0.15, no obstacle in the 60 m column above, the body is not pushed out, inside the bounds
    const w = ctx.world, p0 = ctx.player.position;
    const down = new V3(0, -1, 0), o = new V3(), q = new V3();
    let spot = null;
    for (let r = 12; r <= 90 && !spot; r += 6) {
      for (let a = 0; a < 16 && !spot; a++) {
        const x = p0.x + Math.cos(a / 16 * Math.PI * 2) * r, z = p0.z + Math.sin(a / 16 * Math.PI * 2) * r;
        if (!w.isInsideBounds(x, z)) continue;
        const g = w.getHeightAt(x, z);
        let flat = true;
        for (let b = 0; b < 8 && flat; b++) {
          const gx = x + Math.cos(b / 8 * Math.PI * 2) * 2, gz = z + Math.sin(b / 8 * Math.PI * 2) * 2;
          if (Math.abs(w.getHeightAt(gx, gz) - g) > 0.15) flat = false;
        }
        if (!flat) continue;
        if (Math.abs(w.getSurfaceY(x, z, g + 60) - g) > 0.05) continue;
        let clear = true;
        for (const [dx, dz] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
          o.set(x + dx, g + 60, z + dz);
          const hit = w.raycast(o, down, 70);
          if (!hit || Math.abs(hit.distance - (60 - (w.getHeightAt(x + dx, z + dz) - g))) > 0.2) { clear = false; break; }
        }
        if (!clear) continue;
        q.set(x, g, z); w.resolveCollision(q, 0.6);
        if (Math.hypot(q.x - x, q.z - z) > 1e-3) continue;
        spot = { x, z, g, r };
      }
    }
    window.__spot = spot;
    const mat = spot && typeof w.getSurfaceMaterial === 'function' ? w.getSurfaceMaterial(spot.x, spot.z, spot.g) : null;
    return {
      spot, mat, audioState: audio.ac ? audio.ac.state : 'none', mode: ctx.missionMode, tutorial: w.tutorial ?? null,
      multi: ctx.isMultiplayer, maxShield: ps.maxShield, shield: ps.shield, hp: ps.hp, maxHp: ps.maxHp,
      grit: ctx.progression?.derived?.gritChance ?? 0, bag: ps.gear.tacticalBag, vig: !!vigEl,
    };
  });
  console.log(`setup: ${JSON.stringify(setup)}`);
  ok(setup.mode === 'raid' && !setup.tutorial && setup.multi === false, `solo raid, not the tutorial (mode ${setup.mode})`);
  ok(!!setup.spot, 'found a flat, obstacle-free drop column');
  ok(setup.maxShield > 0 && setup.shield === setup.maxShield, `armor shield full on deploy (${setup.shield}/${setup.maxShield})`);
  ok(setup.audioState === 'running', `AudioContext running (${setup.audioState})`);
  ok(setup.vig, '.fall-vignette element exists');
  ok(setup.bag === false, 'no tactical bag equipped (its auto-hover would exempt the falls)');
  if (!setup.spot) throw new Error('no drop spot');
  if (setup.grit > 0) { console.log(`  note: gritChance ${setup.grit} → forced 0 for the run`); }

  /**
   * One fall (inside the page): fill the pools → wait out the invulnerability → teleport `h` m above the flat spot →
   * airborne → landing → sample the vignette curve (halfway · FALL_VIGNETTE_S + slack). `mode`: 'drop' | 'impulse' |
   * 'knockback' | 'midair'.
   */
  const drop = (h, mode = 'drop', lift = 0) => page.evaluate(async ({ h, mode, lift, VIG_S }) => {
    const G = window.__game, ctx = G.ctx, R = window.__rec, s = window.__spot;
    const ps = G.getSystem('player'), hud = G.getSystem('hud');
    const V3 = ctx.camera.position.constructor;
    window.__calm();
    if (ctx.progression?.derived && ctx.progression.derived.gritChance > 0) ctx.progression.derived.gritChance = 0;
    // Gets clear of the previous landing and fills the pools (the next damage lands only once the INVULN window is over)
    ctx.player.teleport(new V3(s.x, s.g, s.z), undefined, true);
    await window.__simWait(0.35);
    ctx.player.heal(1e6); ps.chargeShield(1e6);
    await window.__simWait(0.05);
    const mark = { fell: R.fell.length, shake: R.shake.length, snd: R.snd.length, dmg: R.dmg.length, launched: R.launched.length, died: R.died.length, downed: R.downed.length };
    const start = { hp: ps.hp, shield: ps.shield, pool: ps.hp + ps.shield, invuln: ps.invuln };
    let y0;
    if (mode === 'impulse' || mode === 'knockback') {
      y0 = ctx.player.position.y;
      if (mode === 'impulse') ctx.player.applyImpulse(new V3(0, lift, 0));
      else ctx.player.applyKnockback(new V3(0, 1, 0), lift);
    } else {
      ctx.player.teleport(new V3(s.x, s.g + h, s.z), undefined, false);
      y0 = ctx.player.position.y;
    }
    const tStart = ctx.time;
    const airborne = await window.__simUntil(() => !ctx.player.isGrounded, 0.5);
    let midImpulseAt = null;
    if (mode === 'midair') {
      await window.__simUntil(() => ctx.player.position.y < y0 - h * 0.35, 3);
      midImpulseAt = ctx.player.position.y - s.g;
      ctx.player.applyImpulse(new V3(0, lift, 0));
    }
    let maxY = y0;
    const landed = await window.__simUntil(() => { maxY = Math.max(maxY, ctx.player.position.y); return ctx.player.isGrounded; }, 12);
    const tLand = ctx.time;
    const yLand = ctx.player.position.y;
    const at = { hp: ps.hp, shield: ps.shield, pool: ps.hp + ps.shield, dead: ps.isDead, downed: ps.isDowned, trauma: ps.rig.trauma };
    // The vignette: halfway · at the end (+0.15 s)
    await window.__simWait(VIG_S * 0.5);
    const vigMid = hud.fallVignetteOpacity;
    const el = document.querySelector('.fall-vignette');
    await window.__simUntil(() => ctx.time >= tLand + VIG_S + 0.15, 3);
    const vigEnd = { o: hud.fallVignetteOpacity, hidden: el.hidden, style: el.style.opacity };
    return {
      mode, h, y0: y0 - s.g, yLand: yLand - s.g, maxRise: maxY - s.g, airborne, landed, airTime: tLand - tStart, midImpulseAt, start, at, vigMid, vigEnd, tLand,
      fell: R.fell.slice(mark.fell), shake: R.shake.slice(mark.shake), snd: R.snd.slice(mark.snd), dmg: R.dmg.slice(mark.dmg),
      launched: R.launched.length - mark.launched, died: R.died.length - mark.died, downed: R.downed.length - mark.downed,
    };
  }, { h, mode, lift, VIG_S: C.VIG_S });

  /** A landing with no damage: no damage · no event · no shake · no landing sound · no vignette. */
  const checkQuiet = (r, label) => {
    const fi = r.snd.filter((x) => x.id === 'fall_impact');
    ok(r.landed && r.fell.length === 0 && r.dmg.length === 0 && near(r.start.pool, r.at.pool, 1e-6),
      `${label}: no damage, no player:fell (pool ${r.start.pool} → ${r.at.pool})`, JSON.stringify({ fell: r.fell, dmg: r.dmg }));
    ok(r.shake.length === 0 && fi.length === 0 && r.vigEnd.o === 0 && r.vigEnd.hidden && r.fell.length === 0,
      `${label}: no camera:shake, no fall_impact, vignette stays off`, JSON.stringify({ shake: r.shake, fi, vigMid: r.vigMid, vigEnd: r.vigEnd }));
  };
  const table = [];
  /** A damaging landing: the formula · the event shape · the shake · the sound · the vignette. The return value is the local `fall_impact` record (to compare the squadmate against). */
  const checkHurt = (r, label, { lethal = false } = {}) => {
    const measuredH = r.y0 - r.yLand;
    const expectReq = fallDamage(measuredH);
    const loss = r.start.hp - r.at.hp;   // 2026-09-16: a fall takes HP only (on a lethal fall, death empties the shield separately)
    const fell = r.fell[0];
    const fallDmg = r.dmg.filter((d) => !d.hasFrom && !d.dot);
    table.push({ label, h: r.h, measuredH: +measuredH.toFixed(3), reportedH: fell ? +fell.height.toFixed(3) : null, expected: +Math.min(expectReq, r.start.hp).toFixed(3),
      requested: fallDmg[0] ? +fallDmg[0].amount.toFixed(3) : null, loss: +loss.toFixed(3), shield: `${r.start.shield}→${+r.at.shield.toFixed(2)}`, hp: `${r.start.hp}→${+r.at.hp.toFixed(2)}` });
    ok(r.landed && r.fell.length === 1, `${label}: exactly one player:fell`, JSON.stringify(r.fell));
    if (!fell) return null;
    ok(near(measuredH, r.h, 0.1) && near(fell.height, measuredH, 0.05),
      `${label}: fallHeight = drop height (${fell.height.toFixed(3)} reported, ${measuredH.toFixed(3)} measured, ${r.h} set)`);
    ok(fallDmg.length === 1 && near(fallDmg[0].amount, expectReq, 1e-6) && near(fallDmg[0].amount, fallDamage(r.h), C.PER_M * 0.1 + 1e-6),
      `${label}: applyDamage asked for min(MAX, (h − SAFE) × PER_M) = ${expectReq.toFixed(2)} (got ${fallDmg[0] ? fallDmg[0].amount.toFixed(2) : '—'})`, JSON.stringify(r.dmg));
    ok(fallDmg.length === 1 && fallDmg[0].source === 'fall' && fallDmg[0].bypass === true,
      `${label}: the request carries source 'fall' + bypassShield`, JSON.stringify(fallDmg));
    // 2026-09-16: fall damage skips the shield — the loss comes out of HP only, and HP is the cap too
    ok(near(loss, Math.min(expectReq, r.start.hp), 0.01) && near(fell.damage, loss, 0.01),
      `${label}: HP loss ${loss.toFixed(2)} = min(damage, hp ${r.start.hp}) and player:fell.damage ${fell.damage.toFixed(2)} = actually dealt`);
    if (!lethal) ok(near(r.at.shield, r.start.shield, 1e-6), `${label}: shield untouched (${r.start.shield} → ${r.at.shield})`);
    ok(fell.rule === 'normal' && fell.keys === 'damage,height,rule', `${label}: payload {height, damage, rule:'normal'} (${fell.keys}, rule ${fell.rule})`);
    // The shake
    ok(r.shake.length === 1 && near(r.shake[0].intensity, shakeFor(fell.damage), 1e-9) && near(r.shake[0].duration, C.SHAKE_S, 1e-9) && near(r.shake[0].t, fell.t, 1e-9),
      `${label}: one camera:shake {${shakeFor(fell.damage).toFixed(3)}, ${C.SHAKE_S}} on the landing frame`, JSON.stringify(r.shake));
    ok(r.at.trauma > 0, `${label}: the rig took the shake (trauma ${r.at.trauma.toFixed(3)})`);
    // The sound
    const fi = r.snd.filter((x) => x.id === 'fall_impact');
    const layer = r.snd.filter((x) => x.id.startsWith('footstep_') && near(x.t, fell.t, 1e-9));
    ok(fi.length === 1 && !fi[0].hasPos && !fi[0].panOnly && near(fi[0].t, fell.t, 1e-9),
      `${label}: one local fall_impact, no position (vol ${fi[0]?.vol.toFixed(3)}, pitch ${fi[0]?.pitch.toFixed(3)})`, JSON.stringify(fi));
    ok(layer.length === 1 && !layer[0].hasPos && layer[0].dedupe === false && (!setup.mat || layer[0].id === `footstep_${setup.mat}`),
      `${label}: + surface footstep layer ${layer[0]?.id} (vol ${layer[0]?.vol.toFixed(3)}, pitch ${layer[0]?.pitch.toFixed(3)})`, JSON.stringify(layer));
    // The vignette
    const want = vignetteFor(fell.damage);
    ok(near(fell.vig, want, 1e-3) && fell.vigHidden === false && near(fell.vigStyle, want, 2e-3),
      `${label}: .fall-vignette shown at opacity ${fell.vig.toFixed(3)} ≈ min(1, ${fell.damage.toFixed(1)} / ${C.VIG_FULL}) = ${want.toFixed(3)}`, JSON.stringify(fell));
    ok(r.vigMid > 0 && r.vigMid < want, `${label}: fading at FALL_VIGNETTE_S / 2 (${r.vigMid.toFixed(3)} < ${want.toFixed(3)})`);
    ok(r.vigEnd.o === 0 && r.vigEnd.hidden === true, `${label}: off and hidden after FALL_VIGNETTE_S sim (${JSON.stringify(r.vigEnd)})`);
    if (!lethal) ok(!r.at.dead && r.died === 0 && r.downed === 0, `${label}: survives`);
    return { fi: fi[0], layer: layer[0], damage: fell.damage };
  };

  /* ── 1 · 5 · 6. the formula by height + the event + the feedback ─────── */
  console.log(`1/5/6. formula by real falls (SAFE ${C.SAFE} m, PER_M ${C.PER_M}, MAX ${C.MAX})`);
  const low = await drop(C.SAFE - 2);
  ok(low.airborne && low.airTime > 0.3, `${C.SAFE - 2} m: body actually fell (${low.airTime.toFixed(2)} s air)`);
  checkQuiet(low, `${C.SAFE - 2} m (below safe)`);
  ok(low.snd.some((x) => x.id === 'player_land'), `${C.SAFE - 2} m: the ordinary landing still registered (player_land)`);
  const safeEdge = await drop(C.SAFE - 0.3);
  checkQuiet(safeEdge, `${C.SAFE - 0.3} m (just under safe)`);
  const s6 = checkHurt(await drop(C.SAFE + 1), `${C.SAFE + 1} m (just above safe)`);
  const s12 = checkHurt(await drop(12), '12 m');

  /* ── 2. the shield bypass (2026-09-16: fall damage goes to HP) ─────── */
  console.log('2. fall damage bypasses the armor shield (HP only)');
  const S = setup.maxShield;
  const dHalf = Math.min(setup.maxHp * 0.5, C.MAX);
  const hHalf = C.SAFE + dHalf / C.PER_M;
  const rs = await drop(+hHalf.toFixed(3));
  const ss = checkHurt(rs, `${hHalf.toFixed(2)} m (damage = half max HP)`);
  if (ss) {
    ok(rs.start.shield === S && near(rs.at.shield, S, 1e-6) && near(rs.start.hp - rs.at.hp, ss.damage, 0.01),
      `full shield ${S} ignored: HP ${rs.start.hp} → ${rs.at.hp.toFixed(2)} (−${ss.damage.toFixed(2)}), shield stays ${rs.at.shield}`);
  }
  const r12 = table.find((t) => t.label === '12 m');
  ok(!!r12 && r12.shield.split('→')[0] === r12.shield.split('→')[1] && r12.hp.split('→')[0] !== r12.hp.split('→')[1],
    `12 m (63 < shield ${S}) still came out of HP (hp ${r12?.hp}, shield ${r12?.shield})`);

  /* ── 4. a body something else lifted is exempt until it lands ────────── */
  console.log('4. launched bodies are exempt until landing');
  const liftFor = (m) => Math.sqrt(2 * C.GRAVITY * m);
  const imp = await drop(0, 'impulse', liftFor(15));
  ok(imp.launched === 1 && imp.maxRise > C.SAFE + 6, `ctx.player.applyImpulse (the jump pad path) launched ${imp.maxRise.toFixed(2)} m up (player:launched ${imp.launched})`);
  checkQuiet(imp, `impulse launch ${imp.maxRise.toFixed(1)} m`);
  const kb = await drop(0, 'knockback', liftFor(15));
  ok(kb.maxRise > C.SAFE + 6, `applyKnockback launched ${kb.maxRise.toFixed(2)} m up`);
  checkQuiet(kb, `knockback launch ${kb.maxRise.toFixed(1)} m`);
  const mid = await drop(20, 'midair', 2);
  ok(mid.midImpulseAt !== null && mid.midImpulseAt > C.SAFE + 4, `mid-air impulse at ${mid.midImpulseAt?.toFixed(2)} m during a 20 m fall`);
  checkQuiet(mid, 'impulse mid-fall (20 m drop)');
  checkHurt(await drop(12), '12 m after the launches (exemption did not stick)');

  /* ── 7. the squadmate fall landing sound ─────────────────────────────────── */
  console.log('7. remote fall sound (in-game receive path)');
  const remote = await page.evaluate(async ({ dmg }) => {
    const G = window.__game, ctx = G.ctx, R = window.__rec;
    const rp = G.getSystem('remotePlayers'), audio = G.getSystem('audio'), hud = G.getSystem('hud');
    const V3 = ctx.camera.position.constructor;
    window.__calm();
    await window.__simWait(0.3);
    const net = ctx.net;
    const hadGlp = Object.prototype.hasOwnProperty.call(net, 'getLobbyPlayer'); const origGlp = net.getLobbyPlayer;
    net.getLobbyPlayer = (id) => (id.startsWith('peer-') ? { id } : undefined);
    const out = {};
    try {
      const cam = ctx.camera.position;
      const m0 = { snd: R.snd.length, rf: R.remoteFell.length, shake: R.shake.length, fell: R.fell.length };
      const pNear = [cam.x + 3, cam.y - 4, cam.z];
      out.nearReject = rp.receiveFall({ t: 'fall', p: pNear, d: dmg }, 'peer-near');
      out.nearDist = audio.camPos.distanceTo(new V3(...pNear));
      out.vigNear = hud.fallVignetteOpacity;
      await window.__simWait(0.1);
      out.vigNearLater = hud.fallVignetteOpacity;
      out.nearSnd = R.snd.slice(m0.snd).filter((x) => x.id === 'fall_impact' || (x.id.startsWith('footstep_') && x.hasPos));
      out.nearEv = R.remoteFell.slice(m0.rf);
      const m1 = { snd: R.snd.length, rf: R.remoteFell.length };
      const pFar = [cam.x + 50, cam.y, cam.z];
      out.farReject = rp.receiveFall({ t: 'fall', p: pFar, d: dmg }, 'peer-far');
      out.farEv = R.remoteFell.length - m1.rf;
      // audio's own curve is silent at 50 m too (this emits the event directly, past the check)
      ctx.bus.emit('player:remoteFell', { peerId: 'peer-direct', position: new V3(...pFar), damage: dmg });
      await window.__simWait(0.1);
      out.farSnd = R.snd.slice(m1.snd).filter((x) => x.id === 'fall_impact' || (x.id.startsWith('footstep_') && x.hasPos));
      out.vigFar = hud.fallVignetteOpacity;
      out.shake = R.shake.length - m0.shake;
      out.fell = R.fell.length - m0.fell;
      out.pNear = pNear;
    } finally { if (hadGlp) net.getLobbyPlayer = origGlp; else delete net.getLobbyPlayer; }
    return out;
  }, { dmg: s12 ? s12.damage : 63 });
  const gain = Math.pow(1 - remote.nearDist / C.REMOTE_RANGE, C.FALLOFF_EXP);
  const rfi = remote.nearSnd.filter((x) => x.id === 'fall_impact');
  const rlayer = remote.nearSnd.filter((x) => x.id.startsWith('footstep_'));
  ok(remote.nearReject === null && remote.nearEv.length === 1 && near(remote.nearEv[0].damage, s12 ? s12.damage : 63, 1e-9),
    `5 m: receiveFall accepted → player:remoteFell (${JSON.stringify(remote.nearEv[0])})`, String(remote.nearReject));
  ok(rfi.length === 1 && rfi[0].hasPos && rfi[0].panOnly && s12 && near(rfi[0].vol, s12.fi.vol * gain, 1e-6) && near(rfi[0].pitch, s12.fi.pitch, 1e-9),
    `5 m: positional fall_impact attenuated ${rfi[0]?.vol.toFixed(4)} = local ${s12?.fi.vol.toFixed(4)} × (1 − ${remote.nearDist.toFixed(2)}/${C.REMOTE_RANGE})^${C.FALLOFF_EXP} = ${(s12 ? s12.fi.vol * gain : NaN).toFixed(4)}`, JSON.stringify(rfi));
  ok(rlayer.length === 1 && s12 && near(rlayer[0].vol, s12.layer.vol * gain, 1e-6) && rlayer[0].id === s12.layer.id,
    `5 m: footstep layer ${rlayer[0]?.id} attenuated by the same curve (${rlayer[0]?.vol.toFixed(4)})`, JSON.stringify(rlayer));
  ok(remote.farReject === 'range' && remote.farEv === 0, `50 m: receiveFall rejects 'range' (${remote.farReject}), no event`);
  ok(remote.farSnd.length === 0, '50 m: no fall_impact / footstep layer (even from a direct player:remoteFell)', JSON.stringify(remote.farSnd));
  ok(remote.vigNear === 0 && remote.vigNearLater === 0 && remote.vigFar === 0 && remote.shake === 0 && remote.fell === 0,
    'remote falls: no vignette, no camera:shake, no player:fell', JSON.stringify({ v: [remote.vigNear, remote.vigNearLater, remote.vigFar], shake: remote.shake, fell: remote.fell }));

  /* ── 3. the lethal fall (last — dying starts the death flow) ──── */
  console.log('3. lethal fall (solo → dead, no downed)');
  const lethalH = 40;
  const leth = await drop(lethalH);
  const sl = checkHurt(leth, `${lethalH} m (lethal)`, { lethal: true });
  const lreq = leth.dmg.filter((d) => !d.hasFrom && !d.dot)[0];
  ok(!!lreq && near(lreq.amount, C.MAX, 1e-9), `${lethalH} m: request capped at FALL_DAMAGE_MAX ${C.MAX} (uncapped ${((lethalH - C.SAFE) * C.PER_M).toFixed(0)}, got ${lreq?.amount})`);
  ok(leth.at.dead && !leth.at.downed && leth.died === 1 && leth.downed === 0 && leth.at.hp <= 0,
    `${lethalH} m: solo player dead (player:died ${leth.died}, player:downed ${leth.downed}, hp ${leth.at.hp})`);
  if (sl && s12 && s6) {
    ok(s6.fi.pitch > s12.fi.pitch && s12.fi.pitch > sl.fi.pitch && s6.fi.vol < s12.fi.vol && s12.fi.vol < sl.fi.vol,
      `heavier falls: lower pitch (${s6.fi.pitch.toFixed(3)} > ${s12.fi.pitch.toFixed(3)} > ${sl.fi.pitch.toFixed(3)}), louder (${s6.fi.vol.toFixed(3)} < ${s12.fi.vol.toFixed(3)} < ${sl.fi.vol.toFixed(3)})`);
    ok(s6.layer.pitch > s12.layer.pitch && s6.layer.vol < s12.layer.vol && s12.layer.vol <= sl.layer.vol,
      `footstep layer also heavier (pitch ${s6.layer.pitch.toFixed(3)} → ${sl.layer.pitch.toFixed(3)}, vol ${s6.layer.vol.toFixed(3)} → ${sl.layer.vol.toFixed(3)})`);
    ok(near(leth.shake[0]?.intensity, C.SHAKE_MAX, 1e-9), `lethal shake capped at FALL_SHAKE_MAX (${leth.shake[0]?.intensity})`);
  }

  console.log('\nfall table (h set / measured / reported, expected loss / requested / measured loss):');
  for (const t of table) console.log(`  ${t.label.padEnd(44)} h ${String(t.h).padStart(6)} | ${String(t.measuredH).padStart(6)} | ${String(t.reportedH).padStart(6)}  dmg ${String(t.expected).padStart(7)} | ${String(t.requested).padStart(7)} | ${String(t.loss).padStart(7)}  shield ${t.shield}  hp ${t.hp}`);

  const gameErrors = errors.filter((e) => !/WebSocket|\/ws\b|ERR_CONNECTION_REFUSED/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e && e.stack || e)}`);
  if (errors.length) console.log(`    page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(fail === 0 ? 0 : 1);
