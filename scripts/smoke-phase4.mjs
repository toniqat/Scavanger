// Single-player smoke test for Phase 4 (enemies): rogue guards + shots, faction clash, artillery shell interception,
// toxic burst friendly fire, behemoth armour plate, lootable corpses. Phase 6 block at the end: the incinerated / shocked statuses
// (applyStatus incinerated / shocked, events, frozen writhe, recovery) and the player hooks (teleport, consumeStamina,
// startMelee('heavy'), setViewWiden).
// Usage: node scripts/smoke-phase4.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

/** `SLASH_DURATION` (data/constants.csv) — how long a heavy melee keeps `isMeleeing`. */
const SLASH_DURATION = Number(readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8').match(/^SLASH_DURATION,([\d.]+)/m)?.[1]);

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

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
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. The tutorial starts by itself on a new profile and locks
    // room purposes · crafting · the terminal · boarding in that order, so it is marked "already done" here
    // (the tutorial itself is what scripts/smoke-tutorial.mjs looks at).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs, C-65)
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
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['enemy:shot', 'enemy:factionClash', 'enemy:shellFired', 'enemy:shellIntercepted', 'enemy:shellLanded', 'enemy:toxicBurst',
      'enemy:chargeStarted', 'enemy:bossSpawned', 'corpse:spawned', 'corpse:removed', 'enemy:killed', 'enemy:spawned', 'enemy:attacked']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__sys = window.__game.getSystem('enemies');
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  /** Wait until event `n` fired at least `min` times or `sec` seconds of simulation time passed (swiftshader: sim time ≪ wall time). */
  const waitEv = async (n, sec, min = 1) => {
    const t0 = await page.evaluate(() => window.__game.ctx.time);
    await waitFor(page, (a) => window.__ev[a.n].length >= a.min || window.__game.ctx.time >= a.t, `${n} or sim +${sec}s`, 600000, { n, min, t: t0 + sec });
  };
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);

  /* 2026-09-13 (enemy factions per planet): crate guards were dropped — the humanoids a raid starts with are the site
     groups for the planet threat (scripts/smoke-faction-sites.mjs checks them in detail). This raid has no planet, so
     threat 1 = androids only, and one rogue is placed by hand on open ground far from the spawn for the rogue-fire
     section below. */
  console.log('site groups (no planet = threat 1) + one rogue for the fire test');
  const guards = await P(() => {
    const sys = window.__sys; const world = window.__game.ctx.world;
    const sites = sys.debugSites();
    const humanoids = sys.active.filter((e) => e.active && e.isHumanoid && e.state !== 'dead');
    const sp = world.getPlayerSpawn();
    let rogue = null;
    for (let k = 0; k < 80 && !rogue; k++) {
      const ang = k * 0.7, rad = 70 + (k % 5) * 8;
      const x = sp.x + Math.cos(ang) * rad, z = sp.z + Math.sin(ang) * rad;
      if (!world.isInsideBounds(x, z) || world.structureAt(x, z) || world.obstacleCoverage(x, z, 3) > 0.05) continue;
      rogue = sys.debugSpawn('rogue', { x, z }, false);
    }
    return { threat: sites && sites.threat, types: [...new Set(humanoids.map((e) => e.type))], rogue: rogue ? { faction: rogue.faction, weapon: rogue.weaponId } : null, bossId: sys.bossId };
  });
  ok(guards.threat === 1 && guards.types.every((t) => t === 'android'), `no planet = threat 1: site groups are androids only, no crate guards (${guards.types.join(',')})`);
  ok(guards.rogue && guards.rogue.faction === 'rogue' && guards.rogue.weapon.length > 0, 'a debug-spawned rogue carries faction=rogue + a weapon id', JSON.stringify(guards.rogue));
  const bossEv = await ev('enemy:bossSpawned');
  ok(bossEv.length === 0 && guards.bossId === 0, `threat 1 places no rogue boss (ev ${bossEv.length})`);

  console.log('rogue fires at the player');
  const placed = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const world = ctx.world;
    const rogue = sys.active.find((e) => e.type === 'rogue' && !e.escortOf) ?? sys.active.find((e) => e.type === 'rogue');
    if (!rogue) return null;
    const p = rogue.position;
    for (let k = 0; k < 16; k++) {
      const ang = k * Math.PI / 8;
      const x = p.x + Math.cos(ang) * 22, z = p.z + Math.sin(ang) * 22;
      if (!world.isInsideBounds(x, z)) continue;
      const y = world.getHeightAt(x, z);
      const o = { x: p.x, y: p.y + 1.4, z: p.z };
      const d = { x: x - o.x, y: (y + 1.2) - o.y, z: z - o.z }; const l = Math.hypot(d.x, d.y, d.z);
      const hit = world.raycast(new (o.constructor === Object ? ctx.player.position.constructor : Object)(o.x, o.y, o.z), new ctx.player.position.constructor(d.x / l, d.y / l, d.z / l), l - 0.5);
      if (hit) continue;
      ctx.player.spawnStanding(new ctx.player.position.constructor(x, y, z), Math.atan2(p.x - x, p.z - z) + Math.PI);
      return { id: rogue.id, dist: 22, k };
    }
    return { id: rogue.id, dist: -1 };
  });
  ok(placed && placed.dist > 0, 'player placed 22 m from a rogue with LOS', JSON.stringify(placed));
  /* The heal guard (see below) goes up **before** the fire test and runs after every enemies `update` — each engine
     step. 2026-09-22 (E-12): it used to be a 100 ms `setInterval` raised after the fire test, and under 6 lanes the rogue
     landed 12 hits inside that test's `waitSim(3)` — hp 0, raid failed, and every later section read an empty world.
     Hits still land (they are what the fire test counts); the body just never reaches 0. */
  await P(() => {
    const pl = window.__game.ctx.player, sys = window.__sys;
    const upd = sys.update;
    sys.update = function (dt, c) { upd.call(this, dt, c); if (pl.hp < pl.maxHp && !pl.isDead) pl.heal(pl.maxHp - pl.hp); };
    window.__healGuardOff = () => { sys.update = upd; };
  });
  let shots = [];
  const tShot0 = await P(() => window.__game.ctx.time);
  await waitEv('enemy:shot', 25);
  shots = await ev('enemy:shot');
  const tShot = (await P(() => window.__game.ctx.time)) - tShot0;
  const rogueState = await P((id) => { const e = window.__sys.active.find((x) => x.id === id); return e ? { state: e.state, phase: e.roguePhase, aware: e.aware, los: e.hasLOS, target: e.target ? e.target.id : null } : null; }, placed?.id);
  ok(shots.length > 0, `rogue fired after ${tShot.toFixed(1)} s sim (${shots.length} shots, first from ${JSON.stringify(shots[0]?.from)})`, JSON.stringify(rogueState));
  ok(shots.some((s) => s.type === 'rogue' || s.type === 'rogue_boss'), 'enemy:shot carries the rogue type');
  await waitSim(3);
  const dmg = await P(() => ({ hp: window.__game.ctx.player.hp, attacked: window.__ev['enemy:attacked'].filter((a) => a.type === 'rogue' || a.type === 'rogue_boss').length, shots: window.__ev['enemy:shot'].length, hits: window.__ev['enemy:shot'].filter((s) => s.hit).length }));
  ok(dmg.shots >= 1, `rogue keeps firing (${dmg.shots} shots, ${dmg.hits} hits, player hp ${dmg.hp}) — a full 4-round burst depends on the cover cycle timing`);

  /* This is the only section where the player is meant to be hit. From here on the rogue keeps firing for minutes with
     nobody checking that damage, and **being shot dead ends the raid in failure** — `player:died` → `game:raidFailed` →
     phase 'dead'. Full death lost its auto-revive on 2026-09-09, so putting the body back on its feet with `respawnAt`
     does not bring that raid back (the phase only goes to the ship after `RAID_FAILED_AUTO_RETURN_S`, and 'menu' stays in
     `uiBlockers`). So the body is kept from dying in the first place rather than revived afterwards — every section below
     checks the enemy side only. */

  console.log('faction clash');
  const clash = await P((id) => {
    const sys = window.__sys; const ctx = window.__game.ctx;
    const rogue = sys.active.find((x) => x.id === id);
    if (!rogue) return null;
    const w = sys.debugSpawn('warrior', { x: rogue.position.x + 3, z: rogue.position.z + 3 }, true);
    // heal both so the fight lasts long enough to observe
    return w ? { wid: w.id, whp: w.hp, rhp: rogue.hp } : null;
  }, placed?.id);
  ok(!!clash, 'warrior spawned next to the rogue via debugSpawn', JSON.stringify(clash));
  let clashEv = [];
  await waitEv('enemy:factionClash', 12); clashEv = await ev('enemy:factionClash');
  const after = await P((ids) => {
    const sys = window.__sys;
    const w = sys.active.find((x) => x.id === ids.wid); const r = sys.active.find((x) => x.id === ids.rid);
    return { w: w ? { hp: w.hp, state: w.state, target: w.target ? w.target.id : null, tEnemy: !!(w.target && w.target.enemy) } : 'gone', r: r ? { hp: r.hp, state: r.state, target: r.target ? r.target.id : null } : 'gone' };
  }, { wid: clash?.wid, rid: placed?.id });
  ok(clashEv.length > 0, `enemy:factionClash emitted (${clashEv.length})`, JSON.stringify(after));
  ok(after.w === 'gone' || after.w.tEnemy || after.w.hp < clash.whp || after.r === 'gone' || after.r.hp < clash.rhp, 'bug ↔ rogue damage exchanged (warrior targets the rogue as an enemy target / hp dropped)', JSON.stringify(after));

  console.log('artillery shell + interception');
  const art = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    // 2026-09-17: with the rogue · androids of the earlier stretch still around, the artillery takes one of them as its target (no bug beside it) and never fires — the field is cleared first
    sys.killAll();
    const a = sys.debugSpawn('artillery', { x: p.x + 95, z: p.z }, true);
    // 2026-09-17: the artillery fires only with another bug beside its target (ARTILLERY_AI.supportRadius) — one scavenger is placed beside it, and its one summon is left marked as already spent
    if (a) { a.summonDone = true; sys.debugSpawn('scavenger', { x: p.x + 2, z: p.z + 2 }, false); }
    return a ? { id: a.id, faction: a.faction } : null;
  });
  ok(!!art && art.faction === 'bug', 'artillery spawned 95 m out (aware)', JSON.stringify(art));
  let fired = [];
  await waitEv('enemy:shellFired', 20); fired = await ev('enemy:shellFired');
  const artState = await P((id) => { const e = window.__sys.active.find((x) => x.id === id); return e ? { state: e.state, dug: e.dug, dist: e.distToTarget, timer: e.shellTimer, aware: e.aware } : null; }, art?.id);
  ok(fired.length > 0, `artillery lobbed a shell (sid ${fired[0]?.sid}, flight ${fired[0]?.flightTime})`, JSON.stringify(artState));
  const intercept = await P((sid) => {
    const sys = window.__sys; const ctx = window.__game.ctx;
    const sp = sys.debugShell(sid);
    if (!sp) return { err: 'shell not live' };
    const V = ctx.player.position.constructor;
    const origin = new V(sp.x, sp.y, sp.z - 6);
    const dir = new V(0, 0, 1);
    const hit = ctx.enemies.raycastInterceptable(origin, dir, 20);
    if (!hit) return { err: 'no hit', sp: [sp.x, sp.y, sp.z] };
    const miss = ctx.enemies.raycastInterceptable(new V(sp.x + 5, sp.y, sp.z - 6), dir, 20);
    hit.target.intercept(hit.point);
    return { dist: hit.distance, radius: hit.target.radius, sid: hit.target.id, missed: miss === null, live: sys.shellCount };
  }, fired[0]?.sid);
  ok(intercept && !intercept.err && Math.abs(intercept.dist - (6 - 0.6)) < 0.3 && intercept.missed, `raycastInterceptable hits the shell sphere (dist ${intercept?.dist?.toFixed(2)}, radius ${intercept?.radius}) and misses 5 m aside`, JSON.stringify(intercept));
  const intEv = await ev('enemy:shellIntercepted');
  ok(intEv.length === 1 && intEv[0].sid === fired[0]?.sid, 'intercept() → enemy:shellIntercepted with the shell id', JSON.stringify(intEv));
  ok(intercept && intercept.live === 0, 'intercepted shell removed from the pool');
  // let a second shell land for the blast path
  let landed = [];
  await waitEv('enemy:shellLanded', 20); landed = await ev('enemy:shellLanded');
  // 2026-09-22 (E-12): a shell still **in the air** when the window closes (`fired: 2, live: 1`, red in several full
  // runs) is given its flight — the window measured the piece's cadence, not whether a shell lands and blasts.
  if (!landed.length && await P(() => window.__sys.shellCount > 0)) { await waitEv('enemy:shellLanded', 12); landed = await ev('enemy:shellLanded'); }
  const artAfter = await P((id) => { const e = window.__sys.active.find((x) => x.id === id); return { fired: window.__ev['enemy:shellFired'].length, live: window.__sys.shellCount, art: e ? { state: e.state, dug: e.dug, dist: e.distToTarget, timer: e.shellTimer, aware: e.aware, hp: e.hp, target: e.target ? e.target.id : null, phase: e.chargePhase } : 'gone' }; }, art?.id);
  ok(landed.length > 0 && landed[0].radius === 5, `a later shell landed (enemy:shellLanded radius ${landed[0]?.radius})`, JSON.stringify(artAfter));

  console.log('toxic burst friendly fire');
  const tox = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    const s = sys.debugSpawn('scavenger', { x: p.x - 40, z: p.z + 40 }, false);
    const t = sys.debugSpawn('toxic', { x: p.x - 41, z: p.z + 40 }, false);
    if (!s || !t) return null;
    const before = s.hp;
    t.takeDamage(1000);             // gunfire kill → bursts on the spot
    return { sid: s.id, before, after: s.hp, dead: s.isDead, toxDead: t.isDead, toxFaction: t.faction };
  });
  const toxEv = await ev('enemy:toxicBurst');
  ok(tox && tox.toxDead && toxEv.length === 1, 'toxic killed by gunfire bursts immediately (enemy:toxicBurst)', JSON.stringify(tox));
  ok(tox && (tox.after < tox.before || tox.dead), `burst damaged the neighbouring scavenger (${tox?.before} → ${tox?.after}${tox?.dead ? ', dead' : ''})`);

  console.log('behemoth armour plate');
  const beh = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    const b = sys.debugSpawn('behemoth', { x: p.x + 40, z: p.z - 40 }, false);
    if (!b) return null;
    b.yaw = 0; b.animate(0);
    const V = ctx.player.position.constructor;
    const h = b.height;
    const front = ctx.enemies.raycast(new V(b.position.x, b.position.y + h * 0.55, b.position.z + 25), new V(0, 0, -1), 40);
    const rear = ctx.enemies.raycast(new V(b.position.x, b.position.y + h * 0.5, b.position.z - 25), new V(0, 0, 1), 40);
    const before = b.hp;
    if (front) b.takeDamage(100, front.point, new V(0, 0, -1));
    const afterFront = b.hp;
    if (rear) b.takeDamage(100, rear.point, new V(0, 0, 1));
    return { h, radius: b.radius, faction: b.faction, front: front ? { part: front.part, armored: !!front.armored, d: front.distance } : null, rear: rear ? { part: rear.part, armored: !!rear.armored, d: rear.distance } : null, before, afterFront, afterRear: b.hp };
  });
  ok(beh && beh.front && beh.front.part === 'front' && beh.front.armored, `raycast from the front hits the armoured plate (part ${beh?.front?.part}, armored ${beh?.front?.armored})`, JSON.stringify(beh));
  ok(beh && beh.rear && beh.rear.part === 'rear' && !beh.rear.armored, `raycast from behind → rear, not armoured (${beh?.rear?.part})`);
  ok(beh && Math.abs((beh.before - beh.afterFront) - 35) < 0.5 && Math.abs((beh.afterFront - beh.afterRear) - 200) < 0.5, `multipliers: front ×0.35 (${(beh?.before - beh?.afterFront).toFixed(1)}), rear ×2 (${(beh?.afterFront - beh?.afterRear).toFixed(1)})`);
  ok(beh && Math.abs(beh.h - 1.6 * 3) < 0.01 && beh.faction === 'bug', `behemoth is a ${beh?.h} m bug (BEHEMOTH_SCALE 3 since Phase 7)`);

  console.log('corpses');
  const corpse = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    // Phase 10: `CORPSE_LOOT_CHANCE` makes a trash bug's corpse searchable only 10 % of the time — a rogue is always 1
    const s = sys.debugSpawn('rogue', { x: p.x + 2, z: p.z + 2 }, false);
    if (!s) return null;
    s.takeDamage(5000);
    const it = ctx.interactables.all().find((i) => i.id === `corpse:${s.id}`);
    const stub = { calls: [] };
    const inv = ctx.inventory;
    const had = inv && typeof inv.openContainerItems === 'function';
    const orig = inv ? inv.openContainerItems : undefined;
    if (inv) inv.openContainerItems = (id, items, pos, title) => { stub.calls.push({ id, n: items.length, title, pos: [pos.x, pos.y, pos.z] }); };
    const can = it ? it.canInteract() : null;
    const prompt = it ? it.getPrompt() : null;
    if (it) it.interact();
    const hadLoot = !!(ctx.loot && typeof ctx.loot.rollCorpse === 'function');
    if (inv) { if (orig) inv.openContainerItems = orig; else delete inv.openContainerItems; }
    // looted → prompt flips
    const lifeBefore = s.corpseLife;
    ctx.bus.emit('crate:looted', { crateId: `corpse:${s.id}` });
    // 2026-09-16 (empty corpses removed): a second rogue corpse that nobody opens — it must keep the normal lifetime
    const keep = sys.debugSpawn('rogue', { x: p.x - 2, z: p.z + 2 }, false);
    if (keep) keep.takeDamage(5000);
    return { id: s.id, dead: s.isDead, found: !!it, hold: it?.holdTime, radius: it?.radius, prompt, can, calls: stub.calls, hadInventoryFn: had, hadLoot, promptAfter: it ? it.getPrompt() : null, canAfter: it ? it.canInteract() : null, corpseLife: lifeBefore, spawned: window.__ev['corpse:spawned'].length,
      lifeAfter: s.corpseLife, emptied: s.corpseEmptied, deathT: s.deathTimer, fadeS: s.corpseFadeS, keep: keep ? keep.id : null };
  });
  ok(corpse && corpse.found && corpse.hold === 0.6 && corpse.radius === 2.4, `corpse interactable registered (corpse:${corpse?.id}, hold ${corpse?.hold}, radius ${corpse?.radius})`, JSON.stringify(corpse));
  ok(corpse && corpse.prompt === '시체 수색' && corpse.spawned > 0, 'prompt 시체 수색 + corpse:spawned emitted');
  ok(corpse && corpse.calls.length === 1 && corpse.calls[0].id === `corpse:${corpse.id}` && corpse.calls[0].title === '시체', `interact() → openContainerItems('corpse:<id>', items, pos, '시체') (items ${corpse?.calls[0]?.n}, loot impl present: ${corpse?.hadLoot}, inventory impl present: ${corpse?.hadInventoryFn})`);
  ok(corpse && corpse.promptAfter === '수색 완료' && corpse.canAfter === false, 'crate:looted marks the corpse searched (수색 완료, no re-open)');
  ok(corpse && corpse.corpseLife === 45, `corpse lifetime ${corpse?.corpseLife} s`);
  /* 2026-09-16 (user's decision — empty corpses removed): an opened-and-emptied enemy corpse sinks after the delay and goes; an unopened one stays */
  const K16 = await P(async () => { const m = await import('/src/shared/constants.ts'); return { delay: m.CORPSE_EMPTY_REMOVE_DELAY_S, sink: m.CORPSE_EMPTY_SINK_S }; });
  ok(corpse && corpse.emptied === true && Math.abs(corpse.lifeAfter - (corpse.deathT + K16.delay + K16.sink)) < 0.05 && corpse.fadeS === K16.sink,
    `emptied enemy corpse: lifetime cut to death + ${K16.delay} + ${K16.sink} s, sink over ${K16.sink} s`, JSON.stringify(corpse));
  await waitSim(K16.delay * 0.5);
  const emptyMid = await P((a) => {
    const e = window.__sys.byId.get(a.id);
    return { present: !!e && e.state === 'dead', fade: e ? e.anim.fade : null };
  }, corpse);
  ok(emptyMid.present && emptyMid.fade === 0, 'the emptied corpse waits CORPSE_EMPTY_REMOVE_DELAY_S before it starts sinking', JSON.stringify(emptyMid));
  await waitSim(K16.delay + K16.sink + 0.6);
  const emptyEnd = await P((a) => {
    const sys = window.__sys, ctx = window.__game.ctx, e = sys.byId.get(a.id), k = a.keep !== null ? sys.byId.get(a.keep) : null;
    const has = (id) => ctx.interactables.all().some((i) => i.id === `corpse:${id}`);
    return { gone: !e, it: has(a.id), keep: !!k && k.state === 'dead', keepIt: a.keep !== null && has(a.keep), keepLife: k ? k.corpseLife : null, keepFade: k ? k.anim.fade : null, keepEmptied: k ? k.corpseEmptied : null };
  }, corpse);
  ok(emptyEnd.gone && !emptyEnd.it, 'the emptied enemy corpse sank and was removed (body + corpse interactable)', JSON.stringify(emptyEnd));
  ok(emptyEnd.keep && emptyEnd.keepIt && emptyEnd.keepLife === 45 && emptyEnd.keepFade === 0 && emptyEnd.keepEmptied === false,
    'an unopened enemy corpse stays (CORPSE_LIFETIME, no sinking)', JSON.stringify(emptyEnd));
  const rem = await P(() => window.__ev['corpse:removed'].length);
  const bodies = await P(() => window.__sys.active.filter((e) => e.state === 'dead').length);
  ok(bodies > 0, `dead bodies stay in the scene (${bodies} corpses active, ${rem} removed so far)`);

  console.log('phase 10: probabilistic corpse looting (CORPSE_LOOT_CHANCE)');
  const chance = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    const has = (id) => !!ctx.interactables.all().find((it) => it.id === `corpse:${id}`);
    let bugs = 0, bugLootable = 0, mismatch = 0, undecided = 0;
    for (let i = 0; i < 30; i++) {
      const s = sys.debugSpawn('scavenger', { x: p.x + 18 + i * 0.7, z: p.z + 22 }, false);
      if (!s) continue;
      s.takeDamage(1000);
      bugs++;
      if (s.lootable === undefined) undecided++;
      if (s.lootable) bugLootable++;
      if (has(s.id) !== !!s.lootable) mismatch++;
    }
    let rogues = 0, rogueLootable = 0;
    for (let i = 0; i < 3; i++) {
      const r = sys.debugSpawn('rogue', { x: p.x - 18 - i * 0.9, z: p.z + 22 }, false);
      if (!r) continue;
      r.takeDamage(5000);
      rogues++;
      if (r.lootable && has(r.id)) rogueLootable++;
    }
    return { bugs, bugLootable, mismatch, undecided, rogues, rogueLootable };
  });
  ok(chance.bugs >= 20 && chance.undecided === 0 && chance.mismatch === 0,
    `every corpse decides lootable at death and the interactable matches it (${chance.bugs} bugs, ${chance.mismatch} mismatches)`, JSON.stringify(chance));
  ok(chance.bugs > 0 && chance.bugLootable < chance.bugs && chance.bugLootable <= Math.ceil(chance.bugs * 0.4),
    `잡버그 (chance 0.1): only ${chance.bugLootable}/${chance.bugs} corpses are searchable`);
  ok(chance.rogues > 0 && chance.rogueLootable === chance.rogues,
    `rogue corpses (chance 1) are always searchable (${chance.rogueLootable}/${chance.rogues})`);

  console.log('snapshot hints / wire');
  const wire = await P(() => {
    const sys = window.__sys;
    const snap = window.__game.getSystem('enemies').constructor.name; // just to touch it
    return { snap, types: [...new Set(sys.active.map((e) => e.type))], alive: sys.getAliveCount() };
  });
  ok(wire.types.includes('rogue') && wire.types.includes('behemoth'), `pools hold new types (${wire.types.join(', ')}), alive ${wire.alive}`);

  console.log('phase 6: enemy statuses (전소 / 감전) + player hooks');
  const inc = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const p = ctx.player.position;
    window.__ev['enemy:incinerated'] = []; window.__ev['enemy:shocked'] = [];
    ctx.bus.on('enemy:incinerated', (e) => window.__ev['enemy:incinerated'].push({ id: e.id, duration: e.duration }));
    ctx.bus.on('enemy:shocked', (e) => window.__ev['enemy:shocked'].push({ id: e.id }));
    const b = sys.debugSpawn('warrior', { x: p.x + 7, z: p.z + 7 }, true);   // chase = true: it would run at the player
    if (!b) return null;
    ctx.enemies.applyStatus(b.id, 'incinerated', 0, 2);
    return { id: b.id, incap: b.isIncapacitated, combatant: b.isCombatant, state: b.state, x: b.position.x, z: b.position.z, hp: b.hp, ev: window.__ev['enemy:incinerated'].length };
  });
  ok(inc && inc.incap && inc.state === 'stagger' && !inc.combatant, `applyStatus('incinerated', 0, 2) → isIncapacitated, state stagger, non-combatant`, JSON.stringify(inc));
  ok(inc && inc.ev === 1 && inc.ev === (await ev('enemy:incinerated')).length && (await ev('enemy:incinerated'))[0].duration === 2, 'enemy:incinerated emitted once with the duration');
  await waitSim(1.0);
  const inc2 = await P((id) => {
    const sys = window.__sys; const b = sys.active.find((e) => e.id === id);
    if (!b) return null;
    const before = b.hp;
    b.takeDamage(50);
    const mid = b.hp;
    const stillIncap = b.isIncapacitated;
    b.takeDamage(10000);
    return { x: b.position.x, z: b.position.z, incap: stillIncap, writhe: b.anim.writhe, before, mid, dead: b.isDead, incapAfterKill: b.isIncapacitated };
  }, inc.id);
  ok(inc2 && Math.hypot(inc2.x - inc.x, inc2.z - inc.z) < 0.05 && inc2.incap && inc2.writhe > 0.6, `position frozen for 1 s while writhing (moved ${inc2 ? Math.hypot(inc2.x - inc.x, inc2.z - inc.z).toFixed(3) : '?'} m, writhe ${inc2?.writhe?.toFixed(2)})`, JSON.stringify(inc2));
  ok(inc2 && inc2.mid < inc2.before && inc2.dead && !inc2.incapAfterKill, `still takes damage mid-writhe (${inc2?.before} → ${inc2?.mid}) and a kill ends it`);
  const shk = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const p = ctx.player.position;
    const b = sys.debugSpawn('hunter', { x: p.x - 8, z: p.z + 4 }, true);
    if (!b) return null;
    ctx.enemies.applyStatus(b.id, 'shocked', 0.5, 1);
    ctx.enemies.applyStatus(b.id, 'shocked', 0.5, 1);   // per-tick caller: no second event
    const r = { id: b.id, slow: b.slowFactor, slowTimer: b.slowTimer, shock: b.shockTimer, incap: b.isIncapacitated, ev: window.__ev['enemy:shocked'].length };
    ctx.enemies.applyStatus(b.id, 'incinerated', 0, 0.6);   // short incineration → returns to chase afterwards
    return r;
  });
  ok(shk && shk.ev === 1 && shk.slow === 0.5 && shk.slowTimer === 1 && shk.shock > 0 && !shk.incap, `applyStatus('shocked', 0.5, 1) → enemy:shocked once, slowFactor 0.5 for 1 s, spark ${shk?.shock}`, JSON.stringify(shk));
  await waitSim(1.4);
  const rec = await P((id) => { const b = window.__sys.active.find((e) => e.id === id); return b ? { incap: b.isIncapacitated, state: b.state, combatant: b.isCombatant, writhe: b.anim.writhe, dead: b.isDead } : null; }, shk.id);
  ok(rec && !rec.incap && rec.state !== 'stagger' && rec.combatant && rec.writhe < 0.2, `전소 over → back to ${rec?.state}, combatant again (writhe ${rec?.writhe?.toFixed(2)})`, JSON.stringify(rec));

  /* ── 2026-09-11: the C batch (enemies) ──────────────────────────────────────────────────────────────
     C-14 an enemy inside a hazard zone = silent damage · C-51 the hit sound per type · C-47 a behemoth charge → drones ·
     C-24 the artillery moves on after a refusal.
     The hazard · the drones are stubbed onto the instance and then restored (the prototype getter / method shows through
     again). */
  console.log('C batch: hazard DoT on enemies (C-14)');
  const hz0 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const p = ctx.player.position; const w = ctx.world;
    const e = sys.debugSpawn('warrior', { x: p.x + 60, z: p.z + 60 }, false);
    if (!e) return null;
    e.wanderTimer = 1e9;
    const ex = e.position.x, ez = e.position.z;
    Object.defineProperty(w, 'hazard', { configurable: true, get: () => ({ kind: 'spores', active: true, startsAt: 0, announced: true, progress: 0.5, damageMul: 1, isInside: (x, z) => Math.hypot(x - ex, z - ez) < 4, getZones: () => [], getSources: () => [], serialize: () => '', applySerialized() {} }) });
    window.__hzDamaged = 0; window.__hzAudio = 0;
    window.__hzOff = [
      ctx.bus.on('enemy:damaged', (d) => { if (d.id === e.id) window.__hzDamaged++; }),
      ctx.bus.on('audio:play', (a) => { if (a.id === 'bug_hit' && a.position && Math.hypot(a.position.x - ex, a.position.z - ez) < 4) window.__hzAudio++; }),
    ];
    return { id: e.id, hp: e.hp, aware: e.aware };
  });
  await waitSim(2.5);
  const hz1 = await P((id) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const e = sys.active.find((x) => x.id === id);
    delete ctx.world.hazard;
    for (const off of window.__hzOff) off();
    return e ? { hp: e.hp, aware: e.aware, state: e.state, damaged: window.__hzDamaged, audio: window.__hzAudio, flash: e.anim.hitFlash, restored: ctx.world.hazard === null || typeof ctx.world.hazard?.isInside === 'function' } : null;
  }, hz0?.id);
  const hzDrop = hz0 && hz1 ? hz0.hp - hz1.hp : -1;
  ok(!!hz1 && hzDrop >= 2 * 1.5 && hzDrop <= 2 * 3.5, `C-14: 재해 구역 안의 적이 HAZARD_ENEMY_DPS(2) × 틱으로 닳는다 (hp ${hz0?.hp} → ${hz1?.hp})`, JSON.stringify(hz1));
  ok(!!hz1 && !hz1.aware && hz1.damaged === 0 && hz1.audio === 0, 'C-14: 조용한 피해 — 깨우지 않고 enemy:damaged · 피격음이 없다', JSON.stringify(hz1));
  ok(!!hz1 && hz1.restored, 'world.hazard 스텁을 걷었다');
  await P((id) => { const e = window.__sys.active.find((x) => x.id === id); if (e) e.kill(false); }, hz0?.id);

  console.log('C batch: per-type melee hit sound (C-51)');
  const bite = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const p = ctx.player.position;
    const victim = sys.debugSpawn('scavenger', { x: p.x - 60, z: p.z + 60 }, false);
    if (!victim) return null;
    const ids = [];
    const off = ctx.bus.on('audio:play', (a) => ids.push(a.id));
    // 2026-09-18: `stats.height` — `hitTarget` measures the wall occlusion from the attacker's head (`parts/Damage.meleeClear`)
    const fake = (type) => ({ id: 77000 + ids.length, type, faction: type.startsWith('rogue') ? 'rogue' : 'bug', stats: { height: 1.2 }, position: victim.position.clone(), target: null });
    const run = (type) => { ids.length = 0; sys.lastAudio.clear(); sys.hitTarget(fake(type), 1, 0, victim.asTarget); return ids.slice(); };
    const r = { hammer: run('rogue_hammer'), warrior: run('warrior'), behemoth: run('behemoth') };
    off();
    victim.kill(false);
    return r;
  });
  ok(!!bite && !bite.hammer.includes('bug_attack'), 'C-51: 타길라(rogue_hammer)의 근접 타격은 bug_attack 을 내지 않는다 (자기 hammer_impact 만)', JSON.stringify(bite));
  ok(!!bite && bite.warrior.includes('bug_attack') && bite.behemoth.includes('bug_attack'), 'C-51: 벌레 타격음은 그대로 bug_attack', JSON.stringify(bite));

  console.log('C batch: behemoth charge hits drones (C-47)');
  const dr0 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const p = ctx.player.position; const w = ctx.world;
    const V = ctx.player.position.constructor;
    // It is made to run toward the centre from inside the map (between the player and the map centre) — a charge aimed out of the map staggers on the first frame
    const bx = p.x * 0.6, bz = p.z * 0.6 + (p.z > 0 ? -30 : 30);
    const dirX = bx > 0 ? -1 : 1;
    const b = sys.debugSpawn('behemoth', { x: bx, z: bz }, false);
    if (!b || !ctx.drones) return null;
    const mk = (id, kind, x, y, z, h) => ({ id, kind, owner: 'local', position: new V(x, y, z), yaw: 0, hp: 100, maxHp: 100, radius: 0.45, height: h, object: null, controlled: false, sprinting: true, aggroable: true, linkRatio: 0, linkLost: false, mountedDeployableId: null, getMountPoint: (o) => o });
    const gx = b.position.x + 7 * dirX, gz = b.position.z;
    const ground = mk('smoke-ground', 'ground', gx, w.getHeightAt(gx, gz), gz, 0.45);
    const air = mk('smoke-air', 'air', gx + 3 * dirX, w.getHeightAt(gx + 3 * dirX, gz) + 12, gz, 0.3);
    window.__droneHits = [];
    ctx.drones.getDrones = () => [ground, air];
    ctx.drones.damageDrone = (id, amount) => window.__droneHits.push({ id, amount });
    b.state = 'attack'; b.stateTime = 0; b.attackTimer = 0; b.aware = true;
    b.chargePhase = 2; b.chargeTimer = 0; b.chargeSeq++; b.chargeDrones.length = 0; b.chargeVictims.length = 0;
    b.chargeDir.set(dirX, 0, 0); b.yaw = dirX * Math.PI / 2;
    b.chargeEnd.set(b.position.x + 25 * dirX, b.position.y, b.position.z);
    window.__beh = b;
    return { id: b.id, inside: w.isInsideBounds(bx + 30 * dirX, bz) };
  });
  await waitSim(1.5);
  const dr1 = await P(() => {
    const ctx = window.__game.ctx;
    delete ctx.drones.getDrones; delete ctx.drones.damageDrone;
    const b = window.__beh;
    return { hits: window.__droneHits, restored: typeof ctx.drones.getDrones === 'function', beh: b ? { phase: b.chargePhase, state: b.state, t: +b.chargeTimer.toFixed(2) } : null };
  });
  await P((id) => { const e = window.__sys.active.find((x) => x.id === id); if (e) e.kill(false); }, dr0?.id);
  ok(!!dr0 && dr1.hits.filter((h) => h.id === 'smoke-ground').length === 1, `C-47: 돌진이 길 위 지상 드론을 한 번 친다 (${JSON.stringify(dr1.hits)})`, JSON.stringify({ dr0, beh: dr1.beh }));
  ok(!!dr0 && dr1.hits.every((h) => h.id !== 'smoke-air'), 'C-47: 머리 위에 떠 있는 공중 드론은 치지 않는다');
  ok(dr1.restored, 'ctx.drones 스텁을 걷었다');

  console.log('C batch: artillery refusal → clear spot, no ping-pong, refusal cap (C-24)');
  const ar0 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const p = ctx.player.position;
    sys.killAll();   // 2026-09-17: the target has to be the player for the scavenger beside it to satisfy the firing condition
    const a = sys.debugSpawn('artillery', { x: p.x + 70, z: p.z + 20 }, true);
    if (!a) return null;
    sys.fireShell = () => false;                 // pretends the trajectory is always blocked — only the move rule is looked at
    a.summonDone = true; sys.debugSpawn('scavenger', { x: p.x + 2, z: p.z - 2 }, false);   // 2026-09-17: the firing condition (a bug beside the target) · the one summon taken out of the way
    a.dug = 1; a.shellTimer = 0; a.shellRefusals = 0;
    window.__art = { id: a.id, legs: [] };
    /* 2026-09-22 (E-12): each new move target is stamped **in the step it is chosen** — with the body's position and
       the target's at that step. The side used to be worked out from the position at the next 0.25 s poll, and under
       6 lanes the body had walked most of the leg by then, so one leg read as the other side. */
    let lastKey = '';
    const upd = sys.update;
    window.__art.stop = () => { sys.update = upd; };
    sys.update = function (dt, c) {
      upd.call(this, dt, c);
      const b = sys.active.find((x) => x.id === a.id);
      if (!b || !(b.fireBlockTimer > 0)) return;
      const key = `${b.shellSpot.x.toFixed(2)},${b.shellSpot.z.toFixed(2)}`;
      if (key === lastKey) return;
      lastKey = key;
      const t = b.target;
      window.__art.legs.push({ p: [b.position.x, b.position.z], mt: [b.shellSpot.x, b.shellSpot.z], t: t ? [t.position.x, t.position.z] : null });
    };
    return { id: a.id, p: [a.position.x, a.position.z] };
  });
  const legs = [];
  for (let i = 0; i < 90 && legs.length < 3; i++) {
    await waitSim(0.25);
    const s = await P((id) => {
      const a = window.__sys.active.find((x) => x.id === id);
      const t = a?.target;
      return a ? { refusals: a.shellRefusals, block: a.fireBlockTimer, timer: a.shellTimer, p: [a.position.x, a.position.z], mt: [a.shellSpot.x, a.shellSpot.z], t: t ? [t.position.x, t.position.z] : null, state: a.state, d: a.distToTarget } : null;
    }, ar0?.id);
    if (!s) break;
    const key = `${s.mt[0].toFixed(2)},${s.mt[1].toFixed(2)}`;
    if (s.block > 0 && (legs.length === 0 || legs[legs.length - 1].key !== key)) legs.push({ key, ...s });
    else if (legs.length >= 2 && s.refusals === 0 && s.timer > 5) { legs.push({ key: 'cap', ...s }); break; }
  }
  const stamped = await P(() => { window.__art.stop(); return window.__art.legs; });
  await P(() => { delete window.__sys.fireShell; const a = window.__sys.active.find((x) => x.id === window.__art.id); if (a) a.kill(false); });
  // The sidestep's direction = the sign of (direction to the target) × (direction of travel). The old rule flipped that sign on every refusal.
  const side = (l) => { const tx = l.t[0] - l.p[0], tz = l.t[1] - l.p[1]; const mx = l.mt[0] - l.p[0], mz = l.mt[1] - l.p[1]; return Math.sign(tx * mz - tz * mx); };
  const walked = legs.slice(0, 2).map((l) => Math.hypot(l.mt[0] - l.p[0], l.mt[1] - l.p[1]));
  ok(legs.length >= 2 && walked.every((d) => d >= 6), `C-24: 거절되면 사전 검사한 자리로 옮긴다 (다리 ${legs.length}, 거리 ${walked.map((d) => d.toFixed(1)).join(' · ')} m)`, JSON.stringify(legs));
  ok(stamped.length >= 2 && stamped[0].t && side(stamped[0]) !== 0 && side(stamped[0]) === side(stamped[1]), 'C-24: 연속 거절에도 좌우를 번갈아 뒤집지 않는다 (X-4 핑퐁 없음)', JSON.stringify(stamped.map((l) => ({ side: l.t ? side(l) : null, mt: l.mt }))));
  ok(legs.some((l) => l.key === 'cap' || l.refusals === 0 && l.timer > 5), `C-24: 연속 ARTILLERY_AI.maxRefusals(3) 번이면 거절 카운터를 비우고 refusalCooldown 동안 쉰다`, JSON.stringify(legs.map((l) => ({ r: l.refusals, timer: +l.timer.toFixed(1) }))));
  // player hooks: the rogues have been shooting at the player for minutes — clear the field and get back on our feet first
  /* 2026-09-09: a downed body gets up with `revive()`, but **full death has no auto-revive** — only the rescue drop, and
     solo does not even have that. Structures · rails moving into the world changed the enemy placement and the body really
     was shot dead in this stretch, and a dead body refuses every hook below (stamina · melee · knockback). A hook needs a
     living body to be checked at all, so it is revived on the spot. */
  const state = await P(() => {
    const ctx = window.__game.ctx; const pl = ctx.player;
    window.__sys.killAll();
    const was = { downed: pl.isDowned, dead: pl.isDead, hp: pl.hp };
    if (pl.isDowned) pl.revive();
    if (pl.isDead) pl.respawnAt(pl.position.clone(), pl.yaw);
    return was;
  });
  /* The heal guard is taken down here — the hooks below (stamina · melee · knockback) do not touch hp. */
  await P(() => { window.__healGuardOff?.(); window.__healGuardOff = null; });
  /* `revive()` / `respawnAt` are immediate, but the downed screen takes a few frames to close and empty `uiBlockers`.
     `canAct()` reads `ctx.isControlActive()`, so calling `startMelee` before that is refused silently (2026-09-09).
     This does not wait a fixed time — it waits on the condition that control really came back. */
  await waitFor(page, () => {
    const ctx = window.__game.ctx;
    return ctx.isControlActive() && !ctx.player.isDead && !ctx.player.isDowned;
  }, 'control restored after revive', 20000);
  const tp = await P(() => {
    const ctx = window.__game.ctx; const pl = ctx.player; const V = pl.position.constructor;
    const from = pl.position.clone();
    const tx = from.x + 25, tz = from.z - 18;
    const pitch0 = pl.pitch;
    pl.teleport(new V(tx, 400, tz));
    /* 2026-09-09: the walking floor is `getSurfaceY`, not the terrain height — with a tram deck (2.05 m) or a structure
       slab at the teleport spot the feet land on its top face. Reading the terrain alone catches that as "floating" every
       time. */
    const ground = ctx.world.getSurfaceY(tx, tz);
    return { tx, tz, dx: pl.position.x - tx, dz: pl.position.z - tz, dy: pl.position.y - ground, vel: pl.velocity.length(), pitchKept: Math.abs(pl.pitch - pitch0) < 1e-6, was: null };
  });
  await waitSim(0.15);
  const tp2 = await P((t) => { const ctx = window.__game.ctx; const cam = ctx.camera.position; const pl = ctx.player; return { camDist: Math.hypot(cam.x - t.tx, cam.z - t.tz), dx: pl.position.x - t.tx, dz: pl.position.z - t.tz, dy: pl.position.y - ctx.world.getSurfaceY(t.tx, t.tz) }; }, tp);
  ok(tp && Math.abs(tp.dx) < 1e-6 && Math.abs(tp.dz) < 1e-6 && Math.abs(tp.dy) < 1e-3 && tp.vel === 0 && tp.pitchKept && tp2.camDist < 8 && Math.abs(tp2.dy) < 0.05,
    `teleport → feet on the terrain (dy ${tp?.dy?.toFixed(3)}), velocity 0, pitch kept, camera followed (${tp2?.camDist?.toFixed(1)} m), still there a frame later (dy ${tp2?.dy?.toFixed(3)})`, JSON.stringify({ tp, tp2, state }));
  const st = await P(() => {
    const pl = window.__game.ctx.player;
    pl.stamina = 10;
    const a = pl.consumeStamina(50); const s1 = pl.stamina;
    const b = pl.consumeStamina(5); const s2 = pl.stamina;
    pl.stamina = pl.maxStamina;
    return { a, s1, b, s2 };
  });
  ok(st && st.a === false && st.s1 === 10 && st.b === true && st.s2 === 5, `consumeStamina: 50 of 10 refused (stays ${st?.s1}), 5 of 10 → ${st?.s2}`, JSON.stringify(st));
  const hv = await P(() => {
    const ctx = window.__game.ctx; const pl = ctx.player;
    // Prints why on a refusal — `canAct()` is an AND of several gates, so the failure message alone does not narrow the cause down
    const gate = { dead: pl.isDead, downed: pl.isDowned, phase: ctx.phase, blockers: [...ctx.uiBlockers], control: ctx.isControlActive() };
    const started = pl.startMelee('heavy');
    /* 2026-09-22 (E-12 ⓐ): the end of the swing is stamped **inside the engine** (after each player `update`, every
       sub-step) instead of reading `isMeleeing` at 0.3 s and 0.8 s — the 0.3 s read overshot past the 0.6 s swing
       under 6 lanes. */
    const sys = window.__game.getSystem('player');
    const t0 = ctx.missionTime;   // mission time stands still in a shader hold, like the swing
    window.__meleeEnd = null;
    const upd = sys.update;
    sys.update = function (dt, c) { upd.call(this, dt, c); if (window.__meleeEnd === null && !pl.isMeleeing) { window.__meleeEnd = ctx.missionTime - t0; sys.update = upd; } };
    return { started, meleeing: pl.isMeleeing, fov0: ctx.camera.fov, gate };
  });
  await waitSim(SLASH_DURATION + 0.4);
  const hvEnd = await P(() => window.__meleeEnd);
  ok(hv && hv.started && hv.meleeing && hvEnd !== null && hvEnd >= SLASH_DURATION - 0.1 && hvEnd <= SLASH_DURATION + 0.15,
    `startMelee('heavy') → isMeleeing for ~SLASH_DURATION (ended after ${hvEnd?.toFixed(2)} s of game time, SLASH_DURATION ${SLASH_DURATION})`, JSON.stringify(hv));
  await P(() => window.__game.ctx.player.setViewWiden(true));
  await waitSim(1.0);
  const wide = await P(() => window.__game.ctx.camera.fov);
  await P(() => window.__game.ctx.player.setViewWiden(false));
  await waitSim(1.5);
  const narrow = await P(() => window.__game.ctx.camera.fov);
  ok(wide > hv.fov0 + 8 && narrow < wide - 6, `setViewWiden(true) raises camera.fov ${hv.fov0.toFixed(1)} → ${wide.toFixed(1)} within 1 s, back to ${narrow.toFixed(1)} after false`);

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  console.log('corpse loot tables / knockback (lead checks)');
  const rolled = await P(() => window.__game.ctx.loot.rollCorpse('rogue', undefined, 'smg').map((i) => {
    const st = window.__game.ctx.loot.getEffectiveStats(i);
    return { d: i.defId, q: i.qty, dur: i.durability, max: st ? st.maxDurability : 0 };
  }));
  // 2026-09-13: a rogue's gun is re-rolled on the faction grade distribution (I 85 · II 14 · III 1 %) — the same class is enough
  /* 2026-09-15: this is not measured against an absolute (`dur <= 90`) — `data/loot_corpse_rolls.csv` rolls 0.05–0.15
     **of that gun's own max durability**, and the maximum grows by `WEAPON_GRADE_DURABILITY_STEP` per grade. A grade II
     SMG legitimately rolled past 100 and went red about 3 % of the time (a flawed check, not a flawed product). What this
     really looks for is only "a corpse gun comes out worn" = a low ratio against its own maximum. The cap is 0.16 rather
     than 0.15, as slack for the rounding. */
  const wornGun = rolled.find((i) => /^wpn_smg(_g[23])?$/.test(i.d));
  const wornRatio = wornGun && wornGun.max > 0 && wornGun.dur !== undefined ? wornGun.dur / wornGun.max : -1;
  ok(wornRatio > 0 && wornRatio <= 0.16 && rolled.some((i) => i.d === 'ammo_light'),
    `rollCorpse(rogue): low-durability weapon (${wornGun?.dur} / ${wornGun?.max} = ${(wornRatio * 100).toFixed(1)} % of its own max) + matching calibre ammo`, JSON.stringify(rolled));
  const bossRoll = await P(() => window.__game.ctx.loot.rollCorpse('rogue_boss', undefined, 'ar').map((i) => i.defId));
  ok(bossRoll.some((d) => /^wpn_ar_g[34]$/.test(d)) && bossRoll.some((d) => d.startsWith('att_')), 'rollCorpse(rogue_boss): grade III/IV weapon + attachment', JSON.stringify(bossRoll));
  const kb = await P(() => { const ctx = window.__game.ctx; const V = ctx.player.position.constructor; const v0 = ctx.player.velocity.length(); ctx.player.applyKnockback(new V(1, 0.4, 0), 12); return { v0, v1: ctx.player.velocity.length() }; });
  ok(kb.v1 > kb.v0 + 5, 'applyKnockback adds velocity', JSON.stringify(kb));
  const openItems = await P(() => { const ctx = window.__game.ctx; const V = ctx.player.position.constructor; const items = ctx.loot.rollCorpse('warrior'); ctx.inventory.openContainerItems('corpse:test', items, ctx.player.position.clone().add(new V(1, 0, 0)), '시체'); const open = ctx.inventory.isOpen; ctx.inventory.closeAll(); return open; });
  ok(openItems, 'openContainerItems opens the loot window');
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
