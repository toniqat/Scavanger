// Single-player smoke test for Phase 3 ship calls (src/stratagems): G tap/wheel, ground + top-view targeting, effects.
// Usage: node scripts/smoke-stratagems.mjs [http://localhost:5273]   (needs `npm run dev`)
// Registers StratagemSystem at runtime when main.ts has not added it yet.
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
  await page.evaluate(async () => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    if (!window.__game.getSystem('stratagems')) {
      const m = await import('/src/stratagems/index.ts');
      window.__game.addSystem(new m.StratagemSystem());
      window.__addedAtRuntime = true;
    }
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['stratagem:wheelChanged', 'stratagem:armed', 'stratagem:chargeChanged', 'stratagem:targeting', 'stratagem:called', 'stratagem:landed',
      'stratagem:ended', 'stratagem:cooldown', 'structure:damaged', 'structure:destroyed', 'crate:open', 'ui:notify', 'camera:shake']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  // real key events target the focused element and bubble up to window (capture-phase window listeners see them first)
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true, cancelable: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true, cancelable: true })), code);
  const mouseDown = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mousedown', { button: x })), b);
  const mouseUp = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mouseup', { button: x })), b);
  const mouseMove = (dx, dy) => page.evaluate(([x, y]) => window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y })), [dx, dy]);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  // tap = keydown + keyup inside one frame (dt is clamped to 50 ms, so any wait between them counts as ≥ 0.05 s of hold)
  const key = async (code) => { await keyDown(code); await keyUp(code); await waitSim(0.15); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const S = (fn, arg) => page.evaluate((a) => { const s = window.__game.getSystem('stratagems'); return (0, eval)(`(${a.fn})`)(s, window.__game.ctx, a.arg); }, { fn: fn.toString(), arg });
  const state = () => S((s) => ({ armed: s.armed, targeting: s.targeting, cooldown: s.cooldown, total: s.cooldownTotal, calls: s.getCalls().length, structures: s.structureCount }));

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => !!window.__game.ctx.stratagems && window.__game.ctx.stratagems.name === 'stratagems'), 'ctx.stratagems published' + (await P(() => window.__addedAtRuntime) ? ' (registered at runtime by the smoke)' : ''));

  console.log('G tap / wheel');
  console.log('  lock/active:', JSON.stringify(await P(() => ({ locked: window.__game.ctx.input.isPointerLocked, gp: window.__game.ctx.isGameplayActive(), cuw: window.__game.ctx.player.canUseWeapons(), downed: window.__game.ctx.player.isDowned }))));
  await key('KeyG');
  let st = await state();
  ok(st.armed === 'orbital_laser', 'G tap arms the first call (orbital_laser)', JSON.stringify(st) + JSON.stringify(await ev('stratagem:armed')));
  ok((await lastEv('stratagem:armed'))?.id === 'orbital_laser', 'stratagem:armed {orbital_laser}');
  await key('KeyG');
  st = await state();
  ok(st.armed === null && (await lastEv('stratagem:armed'))?.id === null, 'G tap again puts the call away');
  await keyDown('KeyG'); await waitSim(0.4);
  ok((await lastEv('stratagem:wheelChanged'))?.open === true, 'G hold opens the wheel');
  await mouseMove(60, 0); await waitSim(0.1);
  ok((await lastEv('stratagem:wheelChanged'))?.hover === 'airstrike', 'drag right → hover E = airstrike', JSON.stringify(await lastEv('stratagem:wheelChanged')));
  await mouseMove(-60, 60); await waitSim(0.1);
  ok((await lastEv('stratagem:wheelChanged'))?.hover === 'supply_drop', 'drag down → hover S = supply_drop');
  await keyUp('KeyG'); await waitSim(0.15);
  st = await state();
  ok(st.armed === 'supply_drop' && (await lastEv('stratagem:wheelChanged'))?.open === false, 'release arms the hovered call, wheel closed', JSON.stringify(st));

  console.log('ground targeting (supply drop)');
  await waitSim(0.2);
  st = await state();
  const tg = await lastEv('stratagem:targeting');
  ok(st.targeting === true && tg?.active === true && tg.kind === 'supply_drop' && Array.isArray(tg.position), 'ground ring active with a position', JSON.stringify(tg));
  const ringWorld = await S((s) => { const r = s.ring; return { vis: r.group.visible, p: r.group.position.toArray() }; });
  ok(ringWorld.vis, 'targeting ring visible', JSON.stringify(ringWorld));
  await mouseDown(0); await waitSim(0.1); await mouseUp(0); await waitSim(0.1);
  st = await state();
  const called = await lastEv('stratagem:called');
  ok(called?.kind === 'supply_drop' && st.calls === 1 && st.armed === null && st.targeting === false, 'LMB confirms: stratagem:called, disarmed, targeting off', JSON.stringify({ st, called }));
  ok(st.cooldown > 59 && st.total === 60 && (await ev('stratagem:cooldown')).length >= 1, 'shared cooldown 60 s started', JSON.stringify(st));
  await key('KeyG');
  ok((await state()).armed === null && (await ev('ui:notify')).some((n) => /재충전/.test(n.text)), 'arming refused while on cooldown (ui:notify)', JSON.stringify(await ev('ui:notify')));
  const p0 = await P(() => window.__game.ctx.player.hp);
  await waitSim(3.5);
  const landed = await lastEv('stratagem:landed');
  ok(landed?.kind === 'supply_drop' && landed.callId === called.callId, 'supply crate landed after the delay');
  const sup = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id.startsWith('supply:'));
    if (!it) return null;
    const near = window.__game.ctx.world.getObstaclesNear(it.position.x, it.position.z, 1).length;
    const prompt = it.getPrompt(); it.interact();
    return { id: it.id, prompt, near, can: it.canInteract() };
  });
  ok(sup && sup.prompt === '보급 상자 열기' && sup.can, 'supply interactable registered', JSON.stringify(sup));
  ok(sup && sup.near >= 1, 'supply crate obstacle registered');
  const co = await lastEv('crate:open');
  ok(co && co.crateId === sup.id && co.tier === 5, 'interact → crate:open tier 5', JSON.stringify(co));
  await P((id) => window.__game.ctx.bus.emit('crate:looted', { crateId: id }), sup.id);
  await waitSim(0.1);
  ok((await lastEv('stratagem:ended'))?.callId === called.callId, 'crate:looted → stratagem:ended');
  const p1 = await P(() => window.__game.ctx.player.hp);
  console.log(`  (player hp ${p0} → ${p1}; crate dropped on the aim point)`);

  console.log('airstrike via debugCall');
  const target = await P(() => {
    const es = window.__game.ctx.enemies.getEnemies().filter((e) => !e.isDead);
    const pl = window.__game.ctx.player.position;
    es.sort((a, b) => b.position.distanceTo(pl) - a.position.distanceTo(pl));
    const e = es[0];
    return { id: e.id, hp: e.hp, p: e.position.toArray(), dist: e.position.distanceTo(pl) };
  });
  const airId = await S((s, ctx, t) => s.debugCall('airstrike', new (ctx.player.position.constructor)(t[0], t[1], t[2])), target.p);
  ok(typeof airId === 'string' && (await lastEv('stratagem:called'))?.kind === 'airstrike', 'debugCall creates an airstrike call');
  await waitSim(5.4);
  ok((await lastEv('stratagem:landed'))?.kind === 'airstrike', 'airstrike landed after 5 s');
  const after = await P((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); return e ? { hp: e.hp, dead: e.isDead } : { gone: true }; }, target.id);
  ok(after.gone || after.dead || after.hp < target.hp, `enemy ${target.id} damaged (${target.hp} → ${JSON.stringify(after)})`);
  ok((await ev('camera:shake')).length > 0, 'camera:shake emitted');
  await waitSim(2.2);
  ok((await lastEv('stratagem:ended'))?.callId === airId, 'airstrike FX ended');

  console.log('structure drop via debugCall');
  const sp = await P(() => { const p = window.__game.ctx.player.position; return [p.x + 14, p.y, p.z + 3]; });
  const structId = await S((s, ctx, t) => s.debugCall('structure_drop', new (ctx.player.position.constructor)(t[0], t[1], t[2])), sp);
  await waitSim(4.2);
  st = await state();
  const obs = await P((t) => window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).filter((o) => o.destructible), sp);
  ok(st.structures === 5, 'structureCount = 5 after the landing', JSON.stringify(st));
  ok(obs.length >= 5, `≥5 destructible obstacles registered (${obs.length})`);
  ok((await lastEv('stratagem:ended'))?.callId === structId, 'structure call ended once all blocks landed');
  const gaps = await P((t) => { const o = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).filter((o) => o.destructible); let min = 1e9;
    for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) min = Math.min(min, o[i].position.distanceTo(o[j].position)); return min; }, sp);
  ok(gaps >= 2.39, `blocks ≥ 2.4 m apart (min ${gaps.toFixed(2)})`);
  const dmg = await P((t) => { const o = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).filter((o) => o.destructible)[0]; const id = o.destructible.id;
    o.destructible.onDamage(500); const hp1 = o.destructible.hp; o.destructible.onDamage(2000);
    const still = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).some((x) => x.destructible && x.destructible.id === id);
    return { id, hp1, still }; }, sp);
  ok(dmg.hp1 === 1500 && (await lastEv('structure:damaged'))?.id === dmg.id, 'onDamage → hp 1500 + structure:damaged');
  ok((await lastEv('structure:destroyed'))?.id === dmg.id && !dmg.still, 'onDamage(2000) → structure:destroyed, obstacle removed');
  ok((await state()).structures === 4, 'structureCount = 4');
  await P((t) => window.__game.ctx.bus.emit('grenade:exploded', { position: new (window.__game.ctx.player.position.constructor)(t[0], t[1], t[2]), radius: 30 }), sp);
  const dmgEv = await ev('structure:damaged');
  ok(dmgEv.length >= 3, 'grenade:exploded damages standing structures');

  console.log('top view (orbital laser)');
  await S((s) => s.debugCooldownReset());
  ok((await lastEv('stratagem:cooldown'))?.remaining === 0 && (await state()).cooldown === 0, 'debugCooldownReset clears the cooldown');
  await key('KeyG');
  st = await state();
  ok(st.armed === 'supply_drop', 'G tap re-arms the last armed call', JSON.stringify(st));
  await keyDown('KeyG'); await waitSim(0.4); await mouseMove(0, -80); await waitSim(0.1); await keyUp('KeyG'); await waitSim(0.15);
  ok((await state()).armed === 'orbital_laser', 'wheel N → orbital_laser');
  await mouseDown(0); await waitSim(1.0);
  const ch = await lastEv('stratagem:chargeChanged');
  ok(ch && ch.t > 0.15 && ch.t < 0.6, `charge progresses (${ch?.t?.toFixed(2)})`);
  await mouseUp(0); await waitSim(0.1);
  ok((await lastEv('stratagem:chargeChanged'))?.t === -1 && !(await state()).targeting, 'early release → charge −1, no top view', JSON.stringify((await ev('stratagem:chargeChanged')).slice(-3)) + JSON.stringify(await state()));
  await mouseDown(0); await waitSim(3.3);
  st = await state();
  const cam = await P(() => window.__game.ctx.camera.position.toArray().map((v) => Math.round(v)));
  const ply = await P(() => window.__game.ctx.player.position.toArray().map((v) => Math.round(v)));
  ok(st.targeting === true && st.armed === 'orbital_laser', 'LMB held 3 s → top view targeting', JSON.stringify(st));
  ok(cam[1] - ply[1] > 60, `camera raised above the player (${cam[1] - ply[1]} m)`);
  const before = await lastEv('stratagem:targeting');
  await mouseUp(0); await mouseMove(100, 0); await waitSim(0.15);
  const afterMove = await lastEv('stratagem:targeting');
  ok(afterMove.position[0] - before.position[0] > 10 && Math.abs(afterMove.position[2] - before.position[2]) < 0.5, `mouse +X moves the cursor +X (${(afterMove.position[0] - before.position[0]).toFixed(1)} m)`);
  await mouseMove(0, 100); await waitSim(0.15);
  const afterDown = await lastEv('stratagem:targeting');
  ok(afterDown.position[2] - afterMove.position[2] > 10, 'mouse down moves the cursor +Z');
  ok(await P(() => window.__game.ctx.player.canUseWeapons() === false), 'controls disabled during the top view');
  await keyDown('Escape'); await keyUp('Escape'); await waitSim(0.15);
  st = await state();
  ok(st.targeting === false && st.armed === 'orbital_laser' && (await lastEv('stratagem:targeting'))?.active === false, 'Esc cancels the top view, call stays armed', JSON.stringify(st));
  ok(await P(() => window.__game.ctx.phase === 'playing' && window.__game.ctx.uiBlockers.size === 0), 'Esc was swallowed (no pause menu)', JSON.stringify(await P(() => ({ phase: window.__game.ctx.phase, blockers: [...window.__game.ctx.uiBlockers] }))));
  await mouseDown(0); await waitSim(3.3);
  ok((await state()).targeting === true, 'top view again');
  await mouseUp(0); await waitSim(0.1); await mouseDown(0); await waitSim(0.1); await mouseUp(0); await waitSim(0.15);
  st = await state();
  const laser = await lastEv('stratagem:called');
  ok(laser?.kind === 'orbital_laser' && st.targeting === false && st.armed === null, 'fresh LMB press confirms the laser', JSON.stringify(st));
  ok(await P(() => window.__game.ctx.player.canUseWeapons() === true), 'controls restored');
  await waitSim(5.4);
  ok((await lastEv('stratagem:landed'))?.kind === 'orbital_laser', 'laser ignited');
  ok(await S((s) => s.getCalls().find((c) => c.kind === 'orbital_laser')?.stage === 'active'), 'laser call stage active');

  console.log('cleanup');
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitSim(0.3);
  st = await state();
  ok(st.calls === 0 && st.structures === 0 && st.armed === null && !st.targeting, 'game:abort clears every call / structure', JSON.stringify(st));
  ok(await P(() => !window.__game.ctx.interactables.all().some((i) => i.id.startsWith('supply:'))), 'supply interactable unregistered');
  ok(await S((s) => s.group.children.length === 1), 'scene group left with only the targeting ring');
} catch (e) {
  fail++; console.log('  FAIL exception', e);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors`);
for (const e of errors.slice(0, 10)) console.log('  console:', e.slice(0, 300));
process.exit(fail || errors.length ? 1 : 0);
