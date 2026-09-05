// Single-player smoke test for Phase 3: ship-call wheel, cooldown, top-view targeting, airstrike / laser / supply / structures, off-screen indicators.
// Usage: node scripts/smoke-phase3.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['stratagem:wheelChanged', 'stratagem:armed', 'stratagem:chargeChanged', 'stratagem:targeting', 'stratagem:called', 'stratagem:landed',
      'stratagem:ended', 'stratagem:cooldown', 'structure:damaged', 'structure:destroyed', 'crate:open', 'weapon:fired', 'player:damaged', 'enemy:damaged', 'enemy:killed']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  const mouseDown = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mousedown', { button: x })), b);
  const mouseUp = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mouseup', { button: x })), b);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  // a tap = keydown + keyup in the same frame (dt is clamped to 50 ms, so any wait between them can read as a hold)
  const key = async (code) => { await page.evaluate((c) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })); }, code); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => !!window.__game.ctx.stratagems && !!window.__game.ctx.weapons), 'ctx.stratagems and ctx.weapons published');

  console.log('wheel / arm');
  await key('KeyG');
  await waitSim(0.4);
  let armed = await lastEv('stratagem:armed');
  ok(armed && armed.id !== null, 'G tap arms a call', JSON.stringify(armed));
  const gunBlocked = await P(async () => { const n0 = window.__ev['weapon:fired'].length; window.dispatchEvent(new MouseEvent('mousedown', { button: 0 })); return n0; });
  await waitSim(0.3);
  await mouseUp(0);
  await waitSim(0.2);
  const firedWhileArmed = await P((n0) => window.__ev['weapon:fired'].length - n0, gunBlocked);
  ok(firedWhileArmed === 0, 'gun does not fire while a call is armed', `${firedWhileArmed}`);
  await key('KeyG');
  await waitSim(0.3);
  armed = await lastEv('stratagem:armed');
  ok(armed && armed.id === null, 'G again puts the call away', JSON.stringify(armed));
  await keyDown('KeyG'); await waitSim(0.5);
  let wheel = await lastEv('stratagem:wheelChanged');
  ok(wheel && wheel.open === true, 'G hold opens the ship-call wheel', JSON.stringify(wheel));
  await P(() => { window.__game.ctx.input.mouseDX += 80; });
  await waitSim(0.2);
  wheel = await lastEv('stratagem:wheelChanged');
  ok(wheel && wheel.hover === 'airstrike', 'drag right hovers 항공 폭탄 (E)', JSON.stringify(wheel));
  await keyUp('KeyG'); await waitSim(0.3);
  armed = await lastEv('stratagem:armed');
  ok(armed && armed.id === 'airstrike', 'release arms the airstrike', JSON.stringify(armed));

  console.log('top-view targeting');
  await mouseDown(0);
  await waitSim(1.0);
  let charge = await lastEv('stratagem:chargeChanged');
  ok(charge && charge.t > 0.2 && charge.t < 0.6, 'LMB hold charges (~1/3 after 1 s)', JSON.stringify(charge));
  await waitSim(2.4);
  let tg = await lastEv('stratagem:targeting');
  ok(tg && tg.active === true && tg.kind === 'airstrike', 'charge complete → top-view targeting', JSON.stringify(tg));
  const camState = await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; return { camY: ctx.camera.position.y - p.y, controls: ctx.player.controlsEnabled }; });
  ok(camState.camY > 40, 'camera is high above the player', JSON.stringify(camState));
  await mouseUp(0);
  await waitSim(0.2);
  await P(() => { window.__game.ctx.input.mouseDX += 200; });
  await waitSim(0.3);
  tg = await lastEv('stratagem:targeting');
  const playerPos = await P(() => window.__game.ctx.player.position.toArray());
  const cursorDist = tg && tg.position ? Math.hypot(tg.position[0] - playerPos[0], tg.position[2] - playerPos[2]) : 0;
  ok(cursorDist > 5, 'mouse drag moves the ground cursor', `${cursorDist.toFixed(1)} m`);
  await mouseDown(2); await waitSim(0.1); await mouseUp(2);
  await waitSim(0.3);
  tg = await lastEv('stratagem:targeting');
  armed = await lastEv('stratagem:armed');
  ok(tg && tg.active === false && (await ev('stratagem:called')).length === 0, 'RMB cancels targeting without calling', JSON.stringify(tg));
  await waitSim(1.5); // the override eases back to the rig (damp 4)
  const camBack = await P(() => { const ctx = window.__game.ctx; return ctx.camera.position.y - ctx.player.position.y; });
  ok(camBack < 10, 'camera returns to the rig after cancel', `${camBack.toFixed(1)}`);

  console.log('airstrike via debugCall');
  // target the nearest live bug so the blast has a victim (fallback: 30 m ahead)
  const picked = await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; const es = ctx.enemies.getEnemies().filter((e) => !e.isDead).sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p)); if (!es.length) return null; const e = es[0]; return { id: e.id, hp: e.hp, t: [e.position.x, e.position.y, e.position.z] }; });
  const target = picked ? picked.t : await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; const f = ctx.player.getForward(); const t = [p.x + f.x * 30, 0, p.z + f.z * 30]; t[1] = ctx.world.getHeightAt(t[0], t[2]); return t; });
  const bugId = picked ? { id: picked.id, hp: picked.hp } : null;
  const sys = await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; s.debugCall('airstrike', new V(t[0], t[1], t[2])); return { cd: s.cooldown, total: s.cooldownTotal, calls: s.getCalls().length }; }, target);
  ok(sys.calls === 1, 'debugCall creates the call (debug path skips the cooldown by design)', JSON.stringify(sys));
  const called = await lastEv('stratagem:called');
  ok(called && called.kind === 'airstrike', 'stratagem:called emitted', JSON.stringify(called));
  await P(() => { window.__game.ctx.timeScale = 4; });
  // bugs patrol during the 5 s incoming delay: keep the picked one parked on the target until impact
  await waitFor(page, (a) => { if (a) { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === a.id); if (e && !e.isDead) e.position.set(a.t[0], a.t[1], a.t[2]); } return window.__ev['stratagem:landed'].some((e) => e.kind === 'airstrike'); }, 'airstrike landed', 240000, picked ? { id: picked.id, t: target } : null);
  await waitSim(0.3);
  await P(() => { window.__game.ctx.timeScale = 1; });
  ok(true, 'airstrike lands after its delay');
  if (bugId) {
    const bugAfter = await P((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); return e ? { hp: e.hp, dead: e.isDead } : null; }, bugId.id);
    ok(!bugAfter || bugAfter.dead || bugAfter.hp < bugId.hp, 'enemy inside the blast took damage', JSON.stringify({ before: bugId.hp, after: bugAfter }));
  }

  console.log('structures');
  await P(() => { const s = window.__game.getSystem('stratagems'); s.debugCooldownReset?.(); });
  const st = await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; const before = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).length; s.debugCall('structure_drop', new V(t[0], t[1], t[2])); return { before }; }, target);
  await P(() => { window.__game.ctx.timeScale = 4; });
  await waitFor(page, () => window.__ev['stratagem:landed'].some((e) => e.kind === 'structure_drop'), 'structures landed', 240000);
  await waitSim(2.5);
  await P(() => { window.__game.ctx.timeScale = 1; });
  const obs = await P((t) => { const w = window.__game.ctx.world; const near = w.getObstaclesNear(t[0], t[2], 12); return { total: near.length, destructible: near.filter((o) => o.destructible).length, count: window.__game.getSystem('stratagems').structureCount }; }, target);
  ok(obs.destructible === 5 && obs.count === 5, '5 destructible cover obstacles registered in the world', JSON.stringify(obs));
  const destroyed = await P((t) => { const w = window.__game.ctx.world; const o = w.getObstaclesNear(t[0], t[2], 12).find((x) => x.destructible); const id = o.destructible.id; o.destructible.onDamage(500); const hpMid = o.destructible.hp; o.destructible.onDamage(5000); const still = w.getObstaclesNear(t[0], t[2], 12).some((x) => x.destructible && x.destructible.id === id); return { hpMid, still, count: window.__game.getSystem('stratagems').structureCount }; }, target);
  ok(destroyed.hpMid === 1500, 'structure hp 2000 → 1500 after 500 damage', `${destroyed.hpMid}`);
  ok(!destroyed.still && destroyed.count === 4, 'destroyed structure leaves the world', JSON.stringify(destroyed));
  ok((await ev('structure:destroyed')).length === 1 && (await ev('structure:damaged')).length >= 1, 'structure:damaged / destroyed emitted');

  console.log('supply drop');
  await P(() => { const s = window.__game.getSystem('stratagems'); s.debugCooldownReset?.(); });
  const sTarget = await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; const f = ctx.player.getForward(); const t = [p.x + f.x * 3, 0, p.z + f.z * 3]; t[1] = ctx.world.getHeightAt(t[0], t[2]); return t; });
  await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; s.debugCall('supply_drop', new V(t[0], t[1], t[2])); }, sTarget);
  await P(() => { window.__game.ctx.timeScale = 4; });
  await waitFor(page, () => window.__ev['stratagem:landed'].some((e) => e.kind === 'supply_drop'), 'supply landed', 240000);
  await P(() => { window.__game.ctx.timeScale = 1; });
  const supply = await P(() => { const all = window.__game.ctx.interactables.all(); const s = all.find((i) => i.id.startsWith('supply:')); if (!s) return { found: false }; s.interact(); return { found: true, prompt: s.getPrompt() }; });
  ok(supply.found, 'supply crate registers an interactable', JSON.stringify(supply));
  const crate = await lastEv('crate:open');
  ok(crate && crate.tier === 5 && String(crate.crateId).startsWith('supply:'), 'interact → crate:open tier 5', JSON.stringify(crate));
  const invOpen = await P(() => window.__game.ctx.inventory.isOpen);
  ok(invOpen, 'inventory loot window opened for the supply crate');
  if (invOpen) { await P(() => window.__game.ctx.inventory.closeAll()); await waitSim(0.3); }
  ok(await P(() => window.__game.ctx.isGameplayActive()), 'gameplay active again after closing the loot window');

  console.log('laser');
  await P(() => { const s = window.__game.getSystem('stratagems'); s.debugCooldownReset?.(); });
  await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; s.debugCall('orbital_laser', new V(t[0], t[1], t[2])); }, target);
  await P(() => { window.__game.ctx.timeScale = 4; });
  await waitFor(page, () => window.__ev['stratagem:landed'].some((e) => e.kind === 'orbital_laser'), 'laser ignited', 240000);
  const laserActive = await P(() => window.__game.getSystem('stratagems').getCalls().some((c) => c.kind === 'orbital_laser' && c.stage === 'active'));
  ok(laserActive, 'laser call is active after landing');
  await waitFor(page, () => window.__ev['stratagem:ended'].some((e) => e.kind === 'orbital_laser'), 'laser ended', 300000);
  await P(() => { window.__game.ctx.timeScale = 1; });
  ok(true, 'laser ends after its duration');

  console.log('hud');
  const hud = await P(() => ({
    swheel: !!document.querySelector('.swheel'),
    panel: !!document.querySelector('.strat-panel'),
    offscr: !!document.querySelector('.offscr'),
  }));
  ok(hud.swheel, 'stratagem wheel element exists');
  ok(hud.panel, 'stratagem panel element exists');
  ok(hud.offscr, 'off-screen indicator layer exists');
  const grenViews = await P(() => Array.isArray(window.__game.ctx.weapons.getGrenades()));
  ok(grenViews, 'ctx.weapons.getGrenades() returns a list');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
