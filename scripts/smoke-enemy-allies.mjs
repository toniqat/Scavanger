// Single-player smoke for the 2026-09-15 android squadmates, **enemy side only** (src/enemies + src/shared/cover.ts):
// androids are a side target list (never in `all` / `alive`), humanoids pick and shoot them, bugs bump into them,
// blasts and fire zones reach them, `applyAllyHit` hurts an enemy without kill credit and turns it toward the shooter,
// an android's `ally:fired` alerts like a player's shot, and `pickCoverSpot` puts a body behind a real obstacle.
// Bodies are **injected** through `getSystem('enemies').debugAllyTargets(bodies, onDamage)`, so nothing here depends on
// src/allies — the enemy half can be verified while that folder is still being written.
// Usage: node scripts/smoke-enemy-allies.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
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
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
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

  console.log('mission (seed 31)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 31 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority && !window.__sys.replica), 'single-player: enemies run as the authority');

  // Fixtures: no ambient trickle while we stage things, a clean slate, and an injected android body.
  await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    sys.training = true;
    window.__clear = () => { for (const e of [...sys.active]) sys.despawn(e); };
    window.__clear();
    window.__hits = [];
    window.__killed = [];
    ctx.bus.on('enemy:killed', (p) => window.__killed.push(p));
    /** Minimal `AllyBodyView` — only what enemies read, plus every flag they branch on. */
    window.__ally = (id, x, z) => {
      const y = ctx.world.getHeightAt(x, z);
      return {
        id, name: id, bay: 0, slot: 1, mode: 'raid', state: 'follow', pose: 'stand',
        position: new V(x, y, z), velocity: new V(0, 0, 0), yaw: 0, pitch: 0,
        hp: 500, maxHp: 500, shield: 0, maxShield: 0, downHp: 0,
        downed: false, dead: false, hidden: false, flags: 0,
        weaponDefId: 'ar', armorDefId: 'armor_2', bagDefId: 'bag_common',
        carrying: null, lookAt: null, stridePhase: 0, moveBlend: 0,
      };
    };
    window.__inject = (bodies) => {
      window.__hits.length = 0;
      sys.debugAllyTargets(bodies, (id, amount) => window.__hits.push({ id, amount }));
    };
  });

  /* ── 1. side list, never in `all` / `alive` ──────────────────────────── */
  console.log('androids are a side target list');
  const lists = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    window.__body = window.__ally('android:test:0', pp.x + 40, pp.z + 40);
    window.__inject([window.__body]);
    const t = sys.targets;
    return {
      allies: sys.debugAllyTargetList,
      inAll: t.all.some((c) => c.allyId === 'android:test:0'),
      inAlive: t.alive.some((c) => c.allyId === 'android:test:0'),
      proxyId: t.allies[0] ? t.allies[0].id : null,
      alive: t.alive.length,
    };
  });
  ok(lists.allies.length === 1 && lists.allies[0].id === 'android:test:0', 'an injected android body becomes one target proxy', JSON.stringify(lists.allies));
  ok(!lists.inAll && !lists.inAlive, 'the proxy is **not** in `all` / `alive` (players only)');
  ok(lists.proxyId === 'ai', "the proxy's TargetId is 'ai' (no `dmg` wire can be addressed to it)", String(lists.proxyId));

  // hidden / downed / dead bodies drop out of the list
  const gated = await P(() => {
    const sys = window.__sys; const b = window.__body; const out = {};
    const probe = (k, mut) => { const c = { ...b, ...mut }; window.__inject([c]); out[k] = sys.debugAllyTargetList.length; };
    probe('hidden', { hidden: true });
    probe('downed', { downed: true });
    probe('dead', { dead: true });
    window.__inject([b]);
    out.back = sys.debugAllyTargetList.length;
    return out;
  });
  ok(gated.hidden === 0 && gated.downed === 0 && gated.dead === 0 && gated.back === 1, 'hidden / downed / dead androids are no targets', JSON.stringify(gated));

  /* ── 2. a humanoid picks and shoots the android ──────────────────────── */
  console.log('humanoid: target choice and rifle hit');
  const shot = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const b = window.__body;
    // put the rogue right next to the android and far from the player, so distance alone decides
    const ex = b.position.x + 10, ez = b.position.z;
    const e = sys.debugSpawn('rogue', { x: ex, z: ez }, true);
    if (!e) return null;
    sys.targets.refresh(ctx);
    const picked = sys.pickTarget(e);
    const proxy = sys.targets.allies[0];
    window.__hits.length = 0;
    // aim the rifle straight at the body (no spread) — `fireGun` resolves the capsule itself
    e.position.set(ex, ctx.world.getHeightAt(ex, ez), ez);
    e.yaw = Math.atan2(b.position.x - ex, b.position.z - ez);
    const hit = sys.fireGun(e, proxy, 0, 1);
    const out = {
      picked: picked ? picked.allyId : null,
      playerDist: Math.hypot(ctx.player.position.x - ex, ctx.player.position.z - ez),
      hit, hits: window.__hits.slice(),
    };
    void V;
    window.__clear();
    return out;
  });
  ok(!!shot && shot.picked === 'android:test:0', 'a rogue beside the android targets it (androids rank with players)', JSON.stringify(shot));
  ok(!!shot && shot.hit === true && shot.hits.length === 1 && shot.hits[0].amount > 0,
    'its rifle round hits the android body and routes to `AlliesRef.damage`', JSON.stringify(shot && shot.hits));

  /* ── 3. body contact (bug melee) and blasts ──────────────────────────── */
  console.log('melee contact, blast and fire zone');
  const area = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const b = window.__body; const p = b.position;
    const out = {};
    // body-contact query (charger rush / hunter leap / toxic swell all use this)
    const near = sys.targets.nearestAliveWithin(new V(p.x + 1, p.y, p.z), 2.5);
    out.contact = near ? near.allyId : null;
    // a bug bite through the normal melee path
    const bug = sys.debugSpawn('scavenger', { x: p.x + 1.2, z: p.z }, true);
    window.__hits.length = 0;
    if (bug) sys.hitTarget(bug, 12, 0, sys.targets.allies[0]);
    out.melee = window.__hits.slice();
    // a frag blast at its feet
    window.__hits.length = 0;
    sys.onGrenadeExploded(new V(p.x, p.y + 0.2, p.z), true, bug ? bug.id : 0, 'frag');
    out.blast = window.__hits.slice();
    // an incendiary fire zone tick over it
    window.__hits.length = 0;
    sys.onFireZoneTick(new V(p.x, p.y, p.z), 3, bug ? bug.id : 0, 'rogue', 0.5);
    out.fire = window.__hits.slice();
    window.__clear();
    return out;
  });
  ok(area.contact === 'android:test:0', '`nearestAliveWithin` (rush / leap / swell contact) finds the android', String(area.contact));
  ok(area.melee.length === 1 && area.melee[0].amount === 12, 'a bug bite damages it', JSON.stringify(area.melee));
  ok(area.blast.length === 1 && area.blast[0].amount > 0, 'a grenade blast damages it', JSON.stringify(area.blast));
  ok(area.fire.length === 1 && area.fire[0].amount > 0, 'an enemy fire zone burns it', JSON.stringify(area.fire));

  /* ── 4. applyAllyHit: no kill credit, retarget, replica refuses ──────── */
  console.log('applyAllyHit (android → enemy)');
  const back = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const b = window.__body; const p = b.position;
    const e = sys.debugSpawn('scavenger', { x: p.x + 8, z: p.z }, false);
    if (!e) return null;
    sys.targets.refresh(ctx);
    const proxy = sys.targets.allies[0];
    const hp0 = e.hp;
    const kills0 = ctx.stats.kills;
    const killXp0 = ctx.stats.killXp ?? 0;
    window.__killed.length = 0;
    const point = new V(e.position.x, e.position.y + 0.5, e.position.z);
    const applied = sys.applyAllyHit(e.id, 5, point, p);
    const out = {
      applied, dealt: hp0 - e.hp, aware: e.aware, damager: e.lastDamager,
      target: e.target ? e.target.allyId : null,
      kills: ctx.stats.kills - kills0,
    };
    // kill it outright: still no `enemy:killed` for us
    sys.applyAllyHit(e.id, e.maxHp * 4, point, p);
    out.dead = e.isDead || e.state === 'dead';
    out.killEvents = window.__killed.length;
    out.killsAfter = ctx.stats.kills - kills0;
    out.killXpAfter = (ctx.stats.killXp ?? 0) - killXp0;   // 2026-09-16: an android kill pays nobody raid XP either
    // a replica never touches enemies or androids (spawn first — spawning is authority-only too)
    const e2 = sys.debugSpawn('scavenger', { x: p.x + 9, z: p.z }, false);
    const was = sys.authority;
    sys.authority = false;
    out.replicaHp = e2 ? e2.hp : 0;
    out.replicaHit = e2 ? sys.applyAllyHit(e2.id, 5, point, p) : 'nospawn';
    out.replicaKept = e2 ? e2.hp === out.replicaHp : false;
    window.__hits.length = 0;
    sys.onGrenadeExploded(new V(p.x, p.y + 0.2, p.z), true, 0, 'frag');
    out.replicaBlast = window.__hits.length;
    sys.authority = was;
    window.__clear();
    return out;
  });
  ok(!!back && back.applied === true && back.dealt > 0, 'applyAllyHit damages the enemy on the authority', JSON.stringify(back));
  ok(!!back && back.damager === 'ai' && back.kills === 0 && back.killsAfter === 0 && back.killXpAfter === 0 && back.killEvents === 0,
    'no kill credit: `lastDamager` = ai, no `ctx.stats.kills` / `killXp`, no `enemy:killed`', JSON.stringify(back));
  ok(!!back && back.aware === true && back.target === 'android:test:0', 'the enemy wakes up and turns on the android that shot it', JSON.stringify(back));
  ok(!!back && back.replicaHit === false && back.replicaKept === true && back.replicaBlast === 0, 'a replica applies neither the hit nor the blast', JSON.stringify(back));

  /* ── 5. `ally:fired` is heard like a player's shot ───────────────────── */
  console.log('ally:fired alerts like a gunshot');
  const heard = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const b = window.__body; const p = b.position;
    // an unaware bug a few metres off the bullet path, well outside its own sight of the shooter
    const e = sys.debugSpawn('scavenger', { x: p.x + 30, z: p.z + 3 }, false);
    if (!e) return null;
    e.aware = false; e.investigating = false;
    // `alertShot` (like `reportShot`) is a no-op on the 훈련장 — drop the fixture flag for this one emit
    sys.training = false;
    const from = new V(p.x, p.y + 1.4, p.z);
    const to = new V(p.x + 60, p.y + 1.4, p.z);
    ctx.bus.emit('ally:fired', { id: b.id, from, to, weaponDefId: 'ar' });
    const out = { investigating: e.investigating, aware: e.aware, suspicion: e.suspicionTimer > 0 };
    sys.training = true;
    window.__clear();
    return out;
  });
  ok(!!heard && (heard.investigating || heard.aware || heard.suspicion),
    "an android's shot puts an unaware enemy near its path on alert", JSON.stringify(heard));

  /* ── 6. shared cover picker ──────────────────────────────────────────── */
  console.log('shared/cover.pickCoverSpot');
  const cover = await P(() => {
    const ctx = window.__game.ctx; const world = ctx.world; const sys = window.__sys; const V = window.__V;
    const blocker = (o) => (o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius) >= 0.5
      && (o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height) >= 0.8;
    const chest = (t) => new V(t.x, world.getHeightAt(t.x, t.z) + 1.17, t.z);
    const blocked = (x, y, z, target) => {
      const o = new V(x, y, z);
      const d = new V(target.x - o.x, target.y - o.y, target.z - o.z);
      const l = d.length(); d.multiplyScalar(1 / l);
      return world.raycast(o, d, l - 0.3) !== null;
    };
    for (let tries = 0; tries < 400; tries++) {
      const cx = (Math.random() - 0.5) * 420, cz = (Math.random() - 0.5) * 420;
      const list = world.getObstaclesNear(cx, cz, 20).filter(blocker);
      if (list.length === 0) continue;
      const o = list[Math.floor(Math.random() * list.length)];
      const a = Math.random() * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      const tx = o.position.x + dx * 12, tz = o.position.z + dz * 12;
      const fx = o.position.x - dx * 6, fz = o.position.z - dz * 6;
      if (!world.isInsideBounds(tx, tz) || !world.isInsideBounds(fx, fz)) continue;
      const spot = sys.debugCoverSpot([fx, world.getHeightAt(fx, fz), fz], [tx, world.getHeightAt(tx, tz), tz]);
      if (!spot) continue;
      const tgt = chest({ x: tx, z: tz });
      return {
        tries,
        coverBlocked: blocked(spot.cover[0], spot.cover[1] + 0.9, spot.cover[2], tgt),
        popOpen: !blocked(spot.pop[0], spot.pop[1] + 1.45, spot.pop[2], tgt),
        toThreat: Math.hypot(tx - spot.cover[0], tz - spot.cover[2]),
        score: spot.score,
      };
    }
    return null;
  });
  ok(!!cover, 'pickCoverSpot found a spot behind a real obstacle', JSON.stringify(cover));
  ok(!!cover && cover.coverBlocked === true, 'the chosen cover blocks the crouched-eye line to the threat', JSON.stringify(cover));
  ok(!!cover && cover.popOpen === true, 'the pop-out spot **does** see the threat from standing height', JSON.stringify(cover));
  ok(!!cover && cover.toThreat >= 4 - 0.05, 'the spot keeps at least the requested distance from the threat', JSON.stringify(cover));

  await P(() => { window.__sys.debugAllyTargets(null); window.__clear(); window.__sys.training = false; });
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
