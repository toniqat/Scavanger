// Single-player smoke for android squadmates (src/allies) — the core loop:
//   cheat roster in the personal ship, solo raid spawn with the bound base kit, follow + harness shrink,
//   enemy sense → enemy ping → fire → applyAllyHit, damage → downed → revive, death → corpse call.
// Everything runs through the debug hooks on getSystem('allies'), so it does not depend on the hub bays,
// the extraction pads or the inventory ally APIs other agents are still writing.
// Usage: node scripts/smoke-allies-core.mjs [http://localhost:5273]   (needs `npm run dev`)
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

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const skipped = (label, why) => { skip++; console.log(`  skip ${label} (${why})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
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
  // A single-player smoke never needs the relay; a refused /ws is the environment, not this folder.
  const relayNoise = (t) => /WebSocket|\/ws\?/.test(String(t));
  page.on('console', (m) => { if (m.type() === 'error' && !relayNoise(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.allies && !!window.__game.ctx.console, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['ally:rosterChanged', 'ally:podDrop', 'ally:ping', 'ally:chat', 'ally:fired',
      'ally:damaged', 'ally:downed', 'ally:revived', 'ally:died']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => P((k) => window.__ev[k], n);
  const resetEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k] = []; });
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const info = (id) => P((i) => window.__game.getSystem('allies').debugInfo(i), id);

  const K = await P(async () => {
    const s = await import('/src/shared/index.ts');
    return {
      hpMul: s.ALLY_HP_MUL, maxHp: s.PLAYER_MAX_HP, reviveHp: s.ALLY_REVIVE_HP,
      harness: s.ALLY_HARNESS_RADIUS_M, minFrac: s.ALLY_HARNESS_MIN_FRAC, sense: s.ALLY_SENSE_RADIUS_M,
      kit: s.ANDROID_KIT, localId: s.androidIdOf('local', 0),
    };
  });

  /* ── 1. cheat roster in the personal ship ─────────────────────────────── */
  console.log('cheat roster (/android 1) in the personal ship');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await resetEv();
  const line = await P(() => window.__game.ctx.allies.devSetAndroid(true));
  ok(typeof line === 'string' && line.length > 0, 'devSetAndroid(true) answers a line', String(line));
  await waitSim(0.3);
  const roster = await P(() => window.__game.ctx.allies.roster.map((e) => ({ id: e.id, bay: e.bay, slot: e.slot, local: e.local })));
  ok(roster.length === 1 && roster[0].id === K.localId && roster[0].local === true, 'one local android on bay 0', JSON.stringify(roster));
  ok((await ev('ally:rosterChanged')).length >= 1, 'ally:rosterChanged fired');
  const shipBody = await P((id) => { const b = window.__game.ctx.allies.getBody(id); return b ? { hidden: b.hidden, mode: b.mode } : null; }, K.localId);
  ok(!!shipBody && shipBody.mode === 'hub' && shipBody.hidden === false, 'the body walks the personal ship', JSON.stringify(shipBody));

  /* ── 2. solo raid: pod drop, bound base kit, vitals ───────────────────── */
  console.log('solo raid: drop pod, base kit, vitals');
  await resetEv();
  await P(() => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: 4041 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  ok((await ev('ally:podDrop')).length === 1, 'one ally:podDrop went out');
  await waitFor(page, (id) => { const b = window.__game.ctx.allies.getBody(id); return !!b && !b.hidden; }, 'ally lands', 30000, K.localId);
  const kit = await P((id) => { const b = window.__game.ctx.allies.getBody(id); return b ? { w: b.weaponDefId, a: b.armorDefId, g: b.bagDefId, hp: b.hp, maxHp: b.maxHp, shield: b.shield, mode: b.mode } : null; }, K.localId);
  ok(!!kit && kit.mode === 'raid', 'the body is in the raid', JSON.stringify(kit));
  // ANDROID_KIT.primary is the weapon **family** id; the item def is `wpn_<id>` (allies/parts/Bag resolves it).
  ok((kit.w === K.kit.primary || kit.w === `wpn_${K.kit.primary}`) && kit.a === K.kit.armor && kit.g === K.kit.bag,
    'wears the bound base kit', JSON.stringify(kit));
  ok(Math.abs(kit.maxHp - K.maxHp * K.hpMul) < 0.01 && kit.hp === kit.maxHp, `hp = PLAYER_MAX_HP × ALLY_HP_MUL (${kit.maxHp})`);
  ok(kit.shield > 0, `the armor gives a shield pool (${kit.shield})`);
  const loadout = await P((id) => { const l = window.__game.ctx.allies.getLoadout(id); return l ? { cols: l.cols, rows: l.rows, items: l.items.length } : null; }, K.localId);
  ok(!!loadout, 'getLoadout answers', JSON.stringify(loadout));
  if (loadout && loadout.cols === 0) skipped('the ally bag has a grid', 'InventoryRef.createAllyBag not implemented yet');
  else ok(loadout.cols > 0 && loadout.rows > 0, 'the ally bag has a grid', JSON.stringify(loadout));

  /* ── 3. follow: dragged back inside the harness ───────────────────────── */
  console.log('follow: pulled back into the harness');
  const far = await P((a) => {
    const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
    const p = ctx.player.position;
    const x = p.x + 60, z = p.z;
    sys.debugTeleport(a.id, x, ctx.world.getHeightAt(x, z), z);
    return Math.hypot(x - p.x, z - p.z);
  }, { id: K.localId });
  ok(far > 50, `teleported ${far.toFixed(0)} m away`);
  await waitSim(14);
  const near = await P((id) => {
    const ctx = window.__game.ctx; const b = ctx.allies.getBody(id);
    return Math.hypot(b.position.x - ctx.player.position.x, b.position.z - ctx.player.position.z);
  }, K.localId);
  ok(near < far - 10, `walked back toward the leader (${far.toFixed(0)} m → ${near.toFixed(0)} m)`);

  /* ── 4. harness shrinks while the leader keeps going one way ──────────── */
  console.log('harness halves when the leader commits to a direction');
  const base = await P(() => window.__game.getSystem('allies').debugHarness());
  // The leader must move **every frame** for the EMA to see a heading — a teleport every few frames reads as noise.
  await P(() => {
    window.__drive = setInterval(() => {
      const ctx = window.__game.ctx; const p = ctx.player.position;
      ctx.player.teleport(new p.constructor(p.x + 0.12, p.y, p.z));
    }, 16);
  });
  await waitSim(9);
  const moved = await P(() => window.__game.getSystem('allies').debugHarness());
  await P(() => { clearInterval(window.__drive); });
  ok(moved.commit > 0.4, `direction consistency rose (${base.commit.toFixed(2)} → ${moved.commit.toFixed(2)})`);
  ok(moved.radius < K.harness * 0.95 && moved.radius >= K.harness * K.minFrac - 0.01,
    `harness shrank toward the half (${K.harness} → ${moved.radius.toFixed(1)} m, floor ${(K.harness * K.minFrac).toFixed(1)})`);
  await waitSim(6);   // stand still: it grows back
  const rested = await P(() => window.__game.getSystem('allies').debugHarness());
  ok(rested.radius > moved.radius, `standing still grows it back (${moved.radius.toFixed(1)} → ${rested.radius.toFixed(1)} m)`);

  /* ── 5. sense → enemy ping → fire → applyAllyHit ──────────────────────── */
  console.log('combat: sense, enemy ping, burst, damage to the enemy');
  const staged = await P(async (a) => {
    const ctx = window.__game.ctx; const world = ctx.world;
    const esys = window.__game.getSystem('enemies');
    esys.training = true;                                  // no ambient trickle while we stage the fight
    for (const e of [...esys.active]) esys.despawn(e);
    // flattest, emptiest spot we can find — the ally needs a clear line
    let best = null;
    for (let k = 0; k < 400; k++) {
      const x = (Math.random() - 0.5) * 420, z = (Math.random() - 0.5) * 420;
      if (!world.isInsideBounds(x - 30, z - 30) || !world.isInsideBounds(x + 30, z + 30)) continue;
      const h0 = world.getHeightAt(x, z);
      let spread = 0;
      for (let i = 0; i < 12; i++) { const ang = i * Math.PI / 6; spread = Math.max(spread, Math.abs(world.getHeightAt(x + Math.cos(ang) * 24, z + Math.sin(ang) * 24) - h0)); }
      const n = world.getObstaclesNear(x, z, 26).length;
      const score = n * 4 + spread;
      if (!best || score < best.score) best = { x, z, y: h0, score };
    }
    if (!best) return null;
    const V = ctx.player.position.constructor;
    const sys = window.__game.getSystem('allies');
    // ally in the middle, leader behind it (never in the line of fire), enemy 20 m ahead
    sys.debugTeleport(a.id, best.x, world.getHeightAt(best.x, best.z), best.z);
    ctx.player.teleport(new V(best.x - 6, world.getHeightAt(best.x - 6, best.z), best.z));
    ctx.player.hp = ctx.player.maxHp;
    const ex = best.x + 20;
    const e = esys.debugSpawn('scavenger', { x: ex, z: best.z }, false);
    return e ? { id: e.id, hp: e.hp, maxHp: e.maxHp } : null;
  }, { id: K.localId });
  if (!staged) {
    skipped('an enemy could be staged', 'enemies.debugSpawn returned nothing');
  } else {
    await resetEv();
    // Assert `combat` while the fight is on — a scavenger dies fast and the android is back to `follow` after.
    const sawCombat = await waitFor(page, (id) => {
      const s2 = window.__game.getSystem('allies').debugInfo(id);
      return !!s2 && s2.state === 'combat';
    }, 'combat state', 60000, K.localId).then(() => true).catch(() => false);
    ok(sawCombat, 'state goes to combat while the enemy lives');
    await waitSim(10);
    const pings = (await ev('ally:ping')).filter((p) => p.kind === 'enemy');
    ok(pings.length >= 1, 'the android pinged the enemy it spotted', JSON.stringify(pings.slice(0, 1)));
    const fired = await ev('ally:fired');
    ok(fired.length >= 1, `it fired (${fired.length} shots)`);
    const hurt = await P((eid) => {
      const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === eid);
      return e ? { hp: e.hp, maxHp: e.maxHp, dead: e.isDead } : { hp: 0, maxHp: 1, dead: true };
    }, staged.id);
    ok(hurt.dead || hurt.hp < staged.hp, `the enemy took ally damage (${staged.hp} → ${hurt.hp}${hurt.dead ? ', dead' : ''})`);
    await P(() => { const s = window.__game.getSystem('enemies'); for (const e of [...s.active]) s.despawn(e); });
  }

  /* ── 6. damage → downed → revive ──────────────────────────────────────── */
  console.log('downed like a human, revivable');
  await resetEv();
  await P((id) => window.__game.ctx.allies.damage(id, 1e6), K.localId);
  await waitSim(0.3);
  let st = await info(K.localId);
  ok(st.downed === true && st.dead === false, 'a huge hit downs it instead of killing it', JSON.stringify(st));
  ok((await ev('ally:downed')).length === 1, 'ally:downed fired');
  ok((await ev('ally:damaged')).length >= 1, 'ally:damaged fired');
  const revived = await P((id) => window.__game.ctx.allies.requestRevive(id), K.localId);
  await waitSim(0.2);
  st = await info(K.localId);
  ok(revived === true && st.downed === false && Math.abs(st.hp - K.reviveHp) < 0.01, `revive puts it back at ALLY_REVIVE_HP (${st.hp})`);
  ok((await ev('ally:revived')).length === 1, 'ally:revived fired');

  /* ── 7. death leaves a corpse (game/ call) ────────────────────────────── */
  console.log('bleeding out leaves an android corpse');
  await P(() => {
    const ctx = window.__game.ctx;
    window.__corpseCalls = [];
    if (ctx.corpses && typeof ctx.corpses.spawnAllyCorpse === 'function') {
      const inner = ctx.corpses.spawnAllyCorpse.bind(ctx.corpses);
      ctx.corpses.spawnAllyCorpse = (id, name, slot, pos, yaw, items) => {
        window.__corpseCalls.push({ id, name, slot, items: items.length });
        return inner(id, name, slot, pos, yaw, items);
      };
    } else window.__corpseCalls = null;
  });
  await resetEv();
  await P((id) => { window.__game.ctx.allies.damage(id, 1e6); window.__game.ctx.allies.damage(id, 1e6); }, K.localId);
  await waitSim(0.4);
  st = await info(K.localId);
  ok(st.dead === true && st.hidden === true, 'it dies and the body is hidden', JSON.stringify(st));
  ok((await ev('ally:died')).length === 1, 'ally:died fired');
  const corpseCalls = await P(() => window.__corpseCalls);
  if (corpseCalls === null) skipped('CorpsesRef.spawnAllyCorpse was called', 'game/ has not implemented it yet');
  else ok(corpseCalls.length === 1 && corpseCalls[0].id === K.localId, 'CorpsesRef.spawnAllyCorpse was called once', JSON.stringify(corpseCalls));
  const combat = await P(() => window.__game.ctx.allies.getCombatBodies().length);
  ok(combat === 0, 'a dead android is not an enemy target any more');

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e && e.message ? e.message : e}`);
} finally {
  await browser.close();
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
