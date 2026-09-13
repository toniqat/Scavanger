// 2026-09-13 탈출 개편 smoke (solo, no relay): 20 s ship call · touchdown hull colliders (8 world boxes, rays stop at the
// hull, a body in a side slab is pushed out) · the enemy-only doorway (`ctx.extraction.keepEnemyOut`) · interior switch →
// uncancellable 10 s departure grace (`extraction:departureStarted` / `departureTick`, boarding still possible) → liftoff
// aboard (phase liftoff · camera override · `ui:cinematic` + `.hud.cinematic` · hull colliders gone once it climbs ·
// `game:complete` with `stats.extracted`) · left behind by the idle auto-departure (phase stays, `extraction:reset`, phase
// back to playing, console callable again) · a corpse in the bay lies on the deck, rides the ship and is gone with it.
// Usage: node scripts/smoke-extraction.mjs [http://localhost:5273]   (needs a running vite)
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['game:phaseChanged', 'game:complete', 'game:abort', 'extraction:activated', 'extraction:shipLanded', 'extraction:boarded',
      'extraction:departureStarted', 'extraction:departureTick', 'extraction:liftoff', 'extraction:reset', 'ui:cinematic']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    // ship-local (x, z) → world, on the deck plane (the ship's yaw frame, see `Dropship.bayToWorld`)
    window.__shipPoint = (lx, lz, dy = 0) => {
      const ship = window.__game.getSystem('extraction').ship;
      const p = new (ship.root.position.constructor)();
      ship.bayToWorld(lx, lz, ship.root.position.y + dy, p);
      return p;
    };
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => P((k) => window.__ev[k], n);
  const resetEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k] = []; });
  const K = await P(async () => {
    const s = await import('/src/shared/index.ts');
    return {
      countdown: s.EXTRACTION_COUNTDOWN, grace: s.EXTRACTION_DEPART_GRACE_S, idle: s.EXTRACTION_AUTO_DEPART_IDLE_S,
      toComplete: s.EXTRACTION_LIFTOFF_TO_COMPLETE_S, blend: s.EXTRACTION_CINEMATIC_BLEND_S,
    };
  });
  const startMission = async (seed) => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
    await resetEv();
    await P((s) => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: s }); }, seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
    await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
    await waitSim(0.3);
  };
  const callShipAndLand = async () => {
    const activated = await P(() => {
      const ctx = window.__game.ctx;
      const pts = ctx.world.getExtractionPoints();
      if (!pts.length) return false;
      // stand beside the pad (its right vector), never where the nose or a nacelle comes down
      const yaw = pts[0].yaw;
      ctx.player.teleport(pts[0].position.clone().add(new (pts[0].position.constructor)(Math.cos(yaw) * 16, 0, -Math.sin(yaw) * 16)));
      const it = ctx.interactables.all().find((i) => i.id.startsWith('extract_') && i.canInteract());
      if (!it) return false;
      it.interact();
      return true;
    });
    ok(activated, 'a console accepts the call');
    await P(() => { window.__game.getSystem('extraction').countdown = 12.5; });
    await waitFor(page, () => window.__ev['extraction:shipLanded'].length > 0, 'shipLanded', 60000);
    await waitSim(1.8);   // ramp
  };

  console.log(`timings from data/constants.csv: ${JSON.stringify(K)}`);
  ok(K.countdown === 20 && K.grace === 10 && K.idle === 60, 'EXTRACTION_COUNTDOWN 20 · grace 10 · idle 60', JSON.stringify(K));

  /* ── 1. call → touchdown → hull · enemy doorway → switch → grace → liftoff aboard → cinematic → complete ── */
  console.log('1. aboard: switch → 10 s grace → cinematic → extracted');
  await startMission(77);
  await callShipAndLand();
  let st = await P(() => window.__ev['extraction:activated'][0]);
  ok(st && st.duration === K.countdown, 'extraction:activated carries the 20 s countdown', JSON.stringify(st));
  st = await P(() => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('extraction');
    const o = sys.ship.root.position;
    const hull = ctx.world.getObstaclesNear(o.x, o.z, 14).filter((b) => b.kind === 'dynamic' && b.box);
    return { phase: ctx.phase, stage: ctx.extraction?.stage, idle: ctx.extraction?.idleRemaining, hull: hull.length };
  });
  ok(st.phase === 'shipLanded' && st.stage === 'landed', 'landed: phase shipLanded · ctx.extraction.stage landed', JSON.stringify(st));
  ok(st.idle > K.idle - 5 && st.idle <= K.idle, 'idle timer counts down from EXTRACTION_AUTO_DEPART_IDLE_S', JSON.stringify(st));
  ok(st.hull === 8, 'touchdown registers 8 hull box colliders in the world', JSON.stringify(st));
  st = await P(() => {
    const ctx = window.__game.ctx;
    const from = window.__shipPoint(7, -3, 1.4), to = window.__shipPoint(0, -3, 1.4);
    const dir = to.clone().sub(from).normalize();
    const hit = ctx.world.raycast(from, dir, 10);
    // a body standing inside the right side slab is pushed out of it
    const body = window.__shipPoint(1.85, -3, 0);
    ctx.world.resolveCollision(body, 0.5);
    const sys = window.__game.getSystem('extraction');
    const lx = Math.abs(sys.ship.bayLocal(body, body.clone()).x);
    return { hit: hit ? hit.distance : null, hitDynamic: hit?.obstacle?.kind === 'dynamic', lx };
  });
  ok(st.hit !== null && st.hit < 6 && st.hitDynamic, 'a ray from beside the ship stops at the hull (not at the bay centre)', JSON.stringify(st));
  ok(st.lx <= 1.1 + 0.03 || st.lx >= 2.6 - 0.03, 'a body inside a side slab is pushed clear of it', JSON.stringify(st));
  st = await P(() => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('extraction');
    const inside = window.__shipPoint(0.4, -2.5, 0);
    const wasIn = ctx.extraction.isInShipBay(inside);
    const moved = ctx.extraction.keepEnemyOut(inside, 0.6);
    const after = sys.ship.bayLocal(inside, inside.clone());
    const outside = window.__shipPoint(0, 5, 0);
    const outMoved = ctx.extraction.keepEnemyOut(outside.clone(), 0.6);
    const beside = window.__shipPoint(3.0, -3, 0);
    const besideMoved = ctx.extraction.keepEnemyOut(beside.clone(), 0.6);
    return { wasIn, moved, afterZ: after.z, afterIn: ctx.extraction.isInShipBay(inside), outMoved, besideMoved };
  });
  ok(st.wasIn && st.moved && !st.afterIn && st.afterZ > 0.25 + 0.6, 'keepEnemyOut pushes an enemy in the bay out through the doorway', JSON.stringify(st));
  ok(!st.outMoved && !st.besideMoved, 'keepEnemyOut leaves bodies behind the ramp / beside the hull alone', JSON.stringify(st));

  await P(() => window.__game.ctx.player.teleport(window.__shipPoint(0, -2.5, 0), undefined, false));
  await waitSim(0.4);
  st = await P(() => {
    const ctx = window.__game.ctx;
    const sw = ctx.interactables.all().find((i) => i.id === 'ship_liftoff_switch');
    return { boarded: window.__ev['extraction:boarded'].length, inShip: ctx.player.isInShip, can: sw?.canInteract() ?? null, prompt: sw?.getPrompt() ?? null };
  });
  ok(st.boarded > 0 && st.inShip, 'player boards the bay', JSON.stringify(st));
  ok(st.can === true && /출발/.test(st.prompt ?? ''), 'interior switch offers 출발 시퀀스 while aboard', JSON.stringify(st));
  await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'ship_liftoff_switch').interact());
  await waitSim(0.3);
  st = await P(() => {
    const ctx = window.__game.ctx;
    const sw = ctx.interactables.all().find((i) => i.id === 'ship_liftoff_switch');
    return { started: window.__ev['extraction:departureStarted'], stage: ctx.extraction.stage, rem: ctx.extraction.departRemaining,
      ticks: window.__ev['extraction:departureTick'].filter((t) => t.stage === 'departing').length, can: sw?.canInteract() ?? null, liftoff: window.__ev['extraction:liftoff'].length };
  });
  ok(st.started.length === 1 && st.started[0].auto === false, 'switch → extraction:departureStarted {auto:false}', JSON.stringify(st.started));
  ok(st.stage === 'departing' && st.rem > K.grace - 1 && st.rem < K.grace, 'grace running (stage departing, ~10 s left)', JSON.stringify(st));
  ok(st.ticks > 0 && st.can === false && st.liftoff === 0, 'departureTick flows, switch no longer interactable, not lifted yet', JSON.stringify(st));
  // walk out and back in during the grace — boarding stays open
  await P(() => window.__game.ctx.player.teleport(window.__shipPoint(0, 6, 0), undefined, false));
  await waitSim(0.3);
  const outDuring = await P(() => !window.__game.ctx.player.isInShip);
  await P(() => window.__game.ctx.player.teleport(window.__shipPoint(0, -2.5, 0), undefined, false));
  await waitSim(0.3);
  const backIn = await P(() => window.__game.ctx.player.isInShip && window.__game.ctx.extraction.stage === 'departing');
  ok(outDuring && backIn, 'boarding (leaving and re-entering) still works during the grace', JSON.stringify({ outDuring, backIn }));
  await waitFor(page, () => window.__ev['extraction:liftoff'].length > 0, 'liftoff after grace', 40000);
  st = await P(() => {
    const ctx = window.__game.ctx;
    return { lift: window.__ev['extraction:liftoff'][0], phase: ctx.phase, riding: ctx.extraction.riding, cine: window.__ev['ui:cinematic'],
      hudCine: document.querySelector('.hud.gameplay')?.classList.contains('cinematic') ?? null, hudSys: window.__game.getSystem('hud')?.isCinematic ?? null };
  });
  ok(st.lift && st.lift.aboard === true && st.lift.squadDone === true, 'liftoff {aboard:true, squadDone:true}', JSON.stringify(st.lift));
  ok(st.phase === 'liftoff' && st.riding, 'phase liftoff · riding', JSON.stringify(st));
  ok(st.cine.length === 1 && st.cine[0].active === true && st.hudCine === true, 'ui:cinematic {active:true} → .hud.gameplay.cinematic', JSON.stringify(st));
  const cam0 = await P(() => window.__game.ctx.camera.position.toArray());
  await waitSim(K.blend + 0.8);
  st = await P((c0) => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('extraction');
    const o = sys.ship.root.position;
    const cam = ctx.camera.position;
    const hull = ctx.world.getObstaclesNear(o.x, o.z, 30).filter((b) => b.kind === 'dynamic' && b.box).length;
    return { dist: cam.distanceTo(o), moved: Math.hypot(cam.x - c0[0], cam.y - c0[1], cam.z - c0[2]), shipUp: o.y - sys.ship.getGroundY(), hull,
      overridden: window.__game.getSystem('player').rig?.isOverridden ?? null, playerToShip: ctx.player.position.distanceTo(o) };
  }, cam0);
  ok(st.overridden === true && st.dist > 8 && st.moved > 3, 'camera has left the character for an external ship shot', JSON.stringify(st));
  ok(st.shipUp > 3 && st.hull === 0, 'ship climbs and the hull colliders are gone', JSON.stringify(st));
  ok(st.playerToShip < 7, 'the rider rides inside the ship', JSON.stringify(st));
  await waitFor(page, () => window.__ev['game:complete'].length > 0, 'game:complete', 40000);
  st = await P(() => ({ stats: window.__ev['game:complete'][0].stats, phase: window.__game.ctx.phase }));
  ok(st.phase === 'complete' && st.stats.extracted === true, 'result screen: extracted true', JSON.stringify({ phase: st.phase, extracted: st.stats.extracted }));
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'abort 1', 20000);
  st = await P(() => ({ cine: window.__ev['ui:cinematic'].map((c) => c.active), hud: window.__game.getSystem('hud')?.isCinematic ?? null,
    overridden: window.__game.getSystem('player').rig?.isOverridden ?? null, stage: window.__game.ctx.extraction?.stage }));
  ok(st.cine[st.cine.length - 1] === false && st.hud === false && st.stage === 'idle', 'abort hands the camera and HUD back, flow idle', JSON.stringify(st));

  /* ── 2. left behind by the idle auto-departure → reset → call again ── */
  console.log('2. left behind: idle auto-departure leaves without the player, raid continues');
  await startMission(78);
  await callShipAndLand();
  await P(() => window.__game.ctx.player.teleport(window.__shipPoint(0, 25, 0), undefined, false));
  await P(() => { window.__game.getSystem('extraction').idleRemaining = 0.6; });
  await waitFor(page, () => window.__ev['extraction:departureStarted'].length > 0, 'auto departure', 20000);
  st = await P(() => window.__ev['extraction:departureStarted'][0]);
  ok(st.auto === true, 'idle timer out → departureStarted {auto:true}', JSON.stringify(st));
  await P(() => { window.__game.getSystem('extraction').departRemaining = 0.4; });
  await waitFor(page, () => window.__ev['extraction:liftoff'].length > 0, 'liftoff (left behind)', 20000);
  await waitSim(0.5);
  st = await P(() => ({ lift: window.__ev['extraction:liftoff'][0], phase: window.__game.ctx.phase, cine: window.__ev['ui:cinematic'].length,
    completeTimer: window.__game.getSystem('gameflow').completeTimer, controls: window.__game.getSystem('player').controlsEnabled }));
  ok(st.lift.aboard === false && st.lift.squadDone === false, 'liftoff {aboard:false, squadDone:false}', JSON.stringify(st.lift));
  ok(st.phase === 'shipLanded' && st.completeTimer < 0 && st.cine === 0, 'left behind: no liftoff phase, no result timer, no cinematic', JSON.stringify(st));
  await P(() => { window.__game.getSystem('extraction').liftoffElapsed = 999; });
  await waitFor(page, () => window.__ev['extraction:reset'].length > 0, 'extraction:reset', 20000);
  await waitSim(0.2);
  st = await P(() => {
    const ctx = window.__game.ctx;
    const consoles = ctx.interactables.all().filter((i) => i.id.startsWith('extract_'));
    return { phase: ctx.phase, stage: ctx.extraction.stage, consoles: consoles.length, callable: consoles.filter((c) => c.canInteract()).length,
      sw: ctx.interactables.all().some((i) => i.id === 'ship_liftoff_switch') };
  });
  ok(st.phase === 'playing' && st.stage === 'idle', 'extraction:reset → phase playing, flow idle', JSON.stringify(st));
  ok(st.consoles > 0 && st.callable === st.consoles && !st.sw, 'every console can call a new ship', JSON.stringify(st));

  /* ── 3. a corpse in the bay rides away with the ship ── */
  console.log('3. corpse on the deck leaves with the ship');
  await resetEv();
  await callShipAndLand();
  st = await P(() => {
    const ctx = window.__game.ctx, gf = window.__game.getSystem('gameflow'), sys = window.__game.getSystem('extraction');
    const inBay = window.__shipPoint(0.6, -2.2, 0);
    const outside = window.__shipPoint(0, 9, 0);
    outside.y = ctx.world.getSurfaceY(outside.x, outside.z, outside.y + 0.5);
    gf.corpses.add('pcorpse:smokeA:1', 'smokeA', '분대원A', inBay, 0, ctx.missionTime, [], 1);
    gf.corpses.add('pcorpse:smokeB:1', 'smokeB', '분대원B', outside, 0, ctx.missionTime, [], 2);
    const a = gf.corpses.get('pcorpse:smokeA:1'), b = gf.corpses.get('pcorpse:smokeB:1');
    return { aShip: a.onShip, aParent: a.group.parent === sys.ship.root, aDeck: a.position.y - sys.ship.root.position.y, bShip: b.onShip };
  });
  ok(st.aShip && st.aParent && Math.abs(st.aDeck) < 0.1, 'a corpse spawned in the bay lies on the deck, parented to the ship', JSON.stringify(st));
  ok(st.bShip === false, 'a corpse outside the bay stays on the ground', JSON.stringify(st));
  const y0 = await P(() => window.__game.getSystem('gameflow').corpses.get('pcorpse:smokeA:1').position.y);
  await P(() => { const sys = window.__game.getSystem('extraction'); sys.startDeparture(false); sys.departRemaining = 0.3; });
  await waitFor(page, () => window.__ev['extraction:liftoff'].length > 0, 'liftoff (corpse)', 20000);
  await waitSim(4.0);
  st = await P((yy) => {
    const gf = window.__game.getSystem('gameflow'), sys = window.__game.getSystem('extraction');
    const a = gf.corpses.get('pcorpse:smokeA:1');
    return { rise: a ? a.position.y - yy : null, near: a ? a.position.distanceTo(sys.ship.root.position) : null };
  }, y0);
  ok(st.rise > 5 && st.near < 7, 'the corpse rides up with the ship', JSON.stringify(st));
  await P(() => { window.__game.getSystem('extraction').liftoffElapsed = 999; });
  await waitFor(page, () => window.__ev['extraction:reset'].length > 0, 'extraction:reset (corpse)', 20000);
  st = await P(() => {
    const gf = window.__game.getSystem('gameflow'), ctx = window.__game.ctx;
    return { a: gf.corpses.get('pcorpse:smokeA:1'), b: !!gf.corpses.get('pcorpse:smokeB:1'),
      aInteract: ctx.interactables.all().some((i) => i.id === 'pcorpse:smokeA:1') };
  });
  ok(st.a === null && !st.aInteract && st.b, 'the corpse that flew off is gone after the reset; the ground one stays', JSON.stringify(st));

  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'abort 3', 20000);
  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
