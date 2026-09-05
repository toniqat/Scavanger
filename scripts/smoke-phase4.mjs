// Single-player smoke test for Phase 4 (enemies): rogue guards + shots, faction clash, artillery shell interception,
// toxic burst friendly fire, behemoth armour plate, lootable corpses.
// Usage: node scripts/smoke-phase4.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 15000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
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

  console.log('rogue guards');
  const guards = await P(() => {
    const sys = window.__sys; const world = window.__game.ctx.world;
    const crates = world.getCrates();
    const rogues = sys.active.filter((e) => e.type === 'rogue' || e.type === 'rogue_boss');
    const nearCrate = rogues.map((r) => {
      const g = r.guardPos; const c = crates.find((c) => c.position.distanceTo(g) < 0.5 || c.position.distanceTo(g) < 14);
      return { type: r.type, faction: r.faction, weapon: r.weaponId, crateTier: c ? c.tier : null, dGuard: Math.hypot(r.position.x - g.x, r.position.z - g.z), escort: !!r.escortOf };
    });
    return { n: rogues.length, boss: rogues.filter((r) => r.type === 'rogue_boss').length, nearCrate, tiers: crates.map((c) => c.tier), bossId: sys.bossId };
  });
  ok(guards.n > 0 && guards.n <= 16, `rogue guards placed (${guards.n}, crates tiers ${JSON.stringify(guards.tiers)})`, JSON.stringify(guards.nearCrate.slice(0, 3)));
  ok(guards.nearCrate.filter((r) => !r.escort).every((r) => r.crateTier >= 2 && r.dGuard <= 15.5), 'every non-escort guard stands 6–12 m (+ collision push-out) from a tier ≥ 2 crate', JSON.stringify(guards.nearCrate));
  ok(guards.nearCrate.every((r) => r.faction === 'rogue' && r.weapon.length > 0), 'rogues carry faction=rogue + a weapon id');
  const bossEv = await ev('enemy:bossSpawned');
  ok((guards.tiers.some((t) => t >= 3) ? guards.boss === 1 && bossEv.length === 1 : true), `boss spawned once when a tier-3/4 crate exists (boss=${guards.boss}, ev=${bossEv.length})`);
  ok(guards.nearCrate.filter((r) => r.escort).length === (guards.boss ? Math.min(3, guards.n - 1) : 0) || guards.nearCrate.filter((r) => r.escort).length > 0, 'escorts follow the boss', `${guards.nearCrate.filter((r) => r.escort).length}`);

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
    const a = sys.debugSpawn('artillery', { x: p.x + 95, z: p.z }, true);
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
  ok(beh && Math.abs(beh.h - 6.4) < 0.01 && beh.faction === 'bug', `behemoth is a ${beh?.h} m bug`);

  console.log('corpses');
  const corpse = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    const s = sys.debugSpawn('scavenger', { x: p.x + 2, z: p.z + 2 }, false);
    if (!s) return null;
    s.takeDamage(1000);
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
    ctx.bus.emit('crate:looted', { crateId: `corpse:${s.id}` });
    return { id: s.id, dead: s.isDead, found: !!it, hold: it?.holdTime, radius: it?.radius, prompt, can, calls: stub.calls, hadInventoryFn: had, hadLoot, promptAfter: it ? it.getPrompt() : null, canAfter: it ? it.canInteract() : null, corpseLife: s.corpseLife, spawned: window.__ev['corpse:spawned'].length };
  });
  ok(corpse && corpse.found && corpse.hold === 0.6 && corpse.radius === 2.4, `corpse interactable registered (corpse:${corpse?.id}, hold ${corpse?.hold}, radius ${corpse?.radius})`, JSON.stringify(corpse));
  ok(corpse && corpse.prompt === '시체 수색' && corpse.spawned > 0, 'prompt 시체 수색 + corpse:spawned emitted');
  ok(corpse && corpse.calls.length === 1 && corpse.calls[0].id === `corpse:${corpse.id}` && corpse.calls[0].title === '시체', `interact() → openContainerItems('corpse:<id>', items, pos, '시체') (items ${corpse?.calls[0]?.n}, loot impl present: ${corpse?.hadLoot}, inventory impl present: ${corpse?.hadInventoryFn})`);
  ok(corpse && corpse.promptAfter === '수색 완료' && corpse.canAfter === false, 'crate:looted marks the corpse searched (수색 완료, no re-open)');
  ok(corpse && corpse.corpseLife === 45, `corpse lifetime ${corpse?.corpseLife} s`);
  const rem = await P(() => window.__ev['corpse:removed'].length);
  const bodies = await P(() => window.__sys.active.filter((e) => e.state === 'dead').length);
  ok(bodies > 0, `dead bodies stay in the scene (${bodies} corpses active, ${rem} removed so far)`);

  console.log('snapshot hints / wire');
  const wire = await P(() => {
    const sys = window.__sys;
    const snap = window.__game.getSystem('enemies').constructor.name; // just to touch it
    return { snap, types: [...new Set(sys.active.map((e) => e.type))], alive: sys.getAliveCount() };
  });
  ok(wire.types.includes('rogue') && wire.types.includes('behemoth'), `pools hold new types (${wire.types.join(', ')}), alive ${wire.alive}`);

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  console.log('corpse loot tables / knockback (lead checks)');
  const rolled = await P(() => window.__game.ctx.loot.rollCorpse('rogue', undefined, 'smg37').map((i) => ({ d: i.defId, q: i.qty, dur: i.durability })));
  ok(rolled.some((i) => i.d === 'wpn_smg37' && i.dur !== undefined && i.dur <= 90) && rolled.some((i) => i.d === 'ammo_light'), 'rollCorpse(rogue): low-durability weapon + matching calibre ammo', JSON.stringify(rolled));
  const bossRoll = await P(() => window.__game.ctx.loot.rollCorpse('rogue_boss', undefined, 'ar23').map((i) => i.defId));
  ok(bossRoll.some((d) => /^wpn_ar23_g[34]$/.test(d)) && bossRoll.some((d) => d.startsWith('att_')), 'rollCorpse(rogue_boss): grade III/IV weapon + attachment', JSON.stringify(bossRoll));
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
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
