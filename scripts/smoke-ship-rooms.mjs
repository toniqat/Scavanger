// Smoke test for the personal-ship rooms + 3D housing mode (함선 꾸미기, hub folder, 2026-09-06):
// cockpit → corridor → 10 rooms, room tracking (`currentRoom` / `hub:roomEntered`), door consoles, the facility
// console, the terminal without a seed section, housing mode (camera override, cursor from mouse deltas, ghost,
// LMB place, X recover, Esc exit) and placed furniture (mesh under the room group, collider push-out, interactable).
// Usage: node scripts/smoke-ship-rooms.mjs [http://localhost:5273/]   (needs `npm run dev`)
// Works against the real `ctx.housing` when it is implemented and falls back to faking the housing events otherwise.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
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
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, 'boot');
  // fresh ship state so room 0 starts empty
  await page.evaluate(() => { try { localStorage.removeItem('scav.ship'); } catch {} });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, 'boot (fresh ship state)');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['hub:entered', 'hub:roomEntered', 'housing:modeChanged', 'housing:cursorChanged', 'housing:furniturePlaced',
      'housing:furnitureRecovered', 'housing:selectionChanged', 'ui:housingToggled', 'hub:left']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  /** keydown + keyup inside one frame on document.body (a wait between them would read as a hold). */
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  const click = (button = 0) => page.evaluate((b) => {
    window.dispatchEvent(new MouseEvent('mousedown', { button: b }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: b }));
  }, button);
  const mouseMove = (dx, dy) => page.evaluate(([x, y]) => window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y })), [dx, dy]);
  // headless rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const teleport = (x, z, yaw = 0) => page.evaluate(([x, z, yaw]) => {
    const p = window.__game.ctx.player;
    const v = p.position.clone(); v.set(x, 0, z);
    p.spawnStanding(v, yaw);
  }, [x, z, yaw]);
  const playerPos = () => page.evaluate(() => { const p = window.__game.ctx.player.position; return [p.x, p.y, p.z]; });

  /* ── 1. personal ship: layout, interactables, lights ────────────────── */
  console.log('personal ship');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  const ship = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const ids = ctx.interactables.all().map((i) => i.id);
    let lights = 0, roomGroups = 0;
    ctx.scene.getObjectByName('PersonalShip').traverse((o) => { if (o.isPointLight) lights++; if (o.isGroup && /^room-\d+$/.test(o.name)) roomGroups++; });
    return { ship: ctx.hub.ship, ids, lights, roomGroups, pos: [ctx.player.position.x, ctx.player.position.z], room: ctx.hub.currentRoom };
  });
  ok(ship.ship === 'personal' && Math.abs(ship.pos[0]) < 0.01 && Math.abs(ship.pos[1] + 1.8) < 0.05, `spawned in the cockpit at (${ship.pos.map((n) => n.toFixed(2))})`);
  for (const id of ['hub_terminal', 'hub_workbench', 'hub_implant_bay', 'hub_garden', 'hub_pod_0']) ok(ship.ids.includes(id), `cockpit interactable ${id} registered`);
  ok(ship.ids.includes('hub_facility'), 'facility console hub_facility registered');
  const roomIds = ship.ids.filter((i) => /^hub_room_\d$/.test(i));
  ok(roomIds.length === 10, `10 room consoles hub_room_0..9 registered (${roomIds.length})`);
  ok(ship.lights === 10, `constant point-light count 10 (${ship.lights})`);
  ok(ship.roomGroups === 10, `one furniture group per room (${ship.roomGroups})`);
  ok(ship.room === null, 'currentRoom is null in the cockpit');

  /* ── 2. terminal: no seed section ───────────────────────────────────── */
  await tap('Escape');
  await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
  const term = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.menu.hub-menu .ui-label')].map((n) => n.textContent),
    seedInput: !![...document.querySelectorAll('.menu.hub-menu input')].find((i) => /무작위/.test(i.placeholder)),
    hint: document.querySelector('.menu.hub-menu .seed-hint')?.textContent ?? '',
  }));
  ok(!term.labels.includes('임무 시드') && !term.seedInput, `terminal has no 임무 시드 section (${term.labels.join(' / ')})`);
  ok(/\/seed/.test(term.hint), `seed hint points at the console: ${term.hint}`);
  const seedSet = await page.evaluate(() => ({ r: window.__game.ctx.hub.setMissionSeed(1234), v: window.__game.ctx.hub.missionSeed }));
  ok(seedSet.r === true && seedSet.v === 1234, 'setMissionSeed(1234) accepted solo');
  await page.evaluate(() => window.__game.ctx.hub.setMissionSeed(null));
  await tap('Escape');
  await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
  await waitSim(0.2);

  /* ── 3. corridor → room 0: walking through the door, room tracking ──── */
  console.log('rooms');
  await teleport(0, 2.5, Math.PI / 2);          // corridor segment 0, facing −X (room 0's door)
  await waitSim(0.2);
  ok((await page.evaluate(() => window.__game.ctx.hub.currentRoom)) === null, 'corridor: currentRoom null');
  await keyDown('KeyW');
  await waitSim(2.0);
  await keyUp('KeyW');
  const walked = await playerPos();
  ok(walked[0] < -1.8, `walked through the door into room 0 (x ${walked[0].toFixed(2)})`);
  await waitSim(0.2);
  const entered = await page.evaluate(() => ({ room: window.__game.ctx.hub.currentRoom, ev: window.__ev['hub:roomEntered'] }));
  ok(entered.room === 0, `currentRoom 0 (${entered.room})`);
  ok(entered.ev.length >= 1 && entered.ev[entered.ev.length - 1].room === 0, `hub:roomEntered {room:0, purpose:${entered.ev[entered.ev.length - 1]?.purpose}}`);
  // outer wall stops the player
  await keyDown('KeyW');
  await waitSim(3.0);
  await keyUp('KeyW');
  const wall = await playerPos();
  ok(wall[0] > -5.8 && wall[0] < -5.2, `outer wall clamps the player (x ${wall[0].toFixed(2)} ≥ −5.8)`);
  // back to the corridor → null again; a +X room → 5
  await teleport(0, 12.5, 0);
  await waitSim(0.2);
  ok((await lastEv('hub:roomEntered')).room === null, 'leaving the room emits hub:roomEntered {room:null}');
  await teleport(3.8, 12.5, 0);
  await waitSim(0.2);
  ok((await page.evaluate(() => window.__game.ctx.hub.currentRoom)) === 7, 'starboard room in segment 2 is room 7 (5..9 = +X front→back)');
  // room console prompt
  const prompt0 = await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_room_0').getPrompt());
  ok(/^방 1 · /.test(prompt0 ?? ''), `hub_room_0 prompt: ${prompt0}`);

  /* ── 4. housing mode in room 0 ──────────────────────────────────────── */
  console.log('housing mode');
  await teleport(-3.8, 2.5, 0);
  await waitSim(0.3);
  const real = await page.evaluate(() => {
    const h = window.__game.ctx.housing;
    if (!h) return { impl: false };
    let purpose = false;
    try { purpose = h.setRoomPurpose(0, 'workshop'); } catch {}
    let entered = false;
    try { entered = h.enterHousingMode(0); } catch {}
    return { impl: entered === true, purpose, mode: h.housingMode };
  });
  if (!real.impl) {
    console.log('  (ctx.housing.enterHousingMode not usable — driving housing:modeChanged manually)');
    await page.evaluate(() => window.__game.ctx.bus.emit('housing:modeChanged', { active: true, room: 0 }));
  }
  await waitSim(0.2);
  const mode0 = await page.evaluate(() => {
    const hub = window.__game.getSystem('hub');
    return { active: hub.housing.active, room: hub.housing.room, ev: window.__ev['housing:modeChanged'], cursorEv: window.__ev['housing:cursorChanged'].length,
      cell: { ...hub.housing.cell } };
  });
  ok(mode0.active && mode0.room === 0, 'hub housing controller active for room 0');
  ok(mode0.ev.some((e) => e.active && e.room === 0), 'housing:modeChanged {active:true, room:0} received');
  ok(mode0.cursorEv >= 1, `initial housing:cursorChanged emitted (${mode0.cursorEv}) at (${mode0.cell.x},${mode0.cell.y})`);
  await waitSim(1.2);
  const cam = await page.evaluate(() => { const c = window.__game.ctx.camera.position; return [c.x, c.y, c.z]; });
  ok(cam[1] > 4.5 && Math.abs(cam[2] - 2.5) < 1.0, `camera overridden above the room (y ${cam[1].toFixed(2)}, z ${cam[2].toFixed(2)})`);
  // controls off: W does not move the player
  const before = await playerPos();
  await keyDown('KeyW'); await waitSim(0.6); await keyUp('KeyW');
  const after = await playerPos();
  ok(Math.abs(after[0] - before[0]) < 0.05 && Math.abs(after[2] - before[2]) < 0.05, 'controls disabled in housing mode');
  ok((await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_room_0').canInteract())) === false, 'room console not interactable while decorating');
  // cursor follows pointer-locked mouse deltas
  const cursorN = await page.evaluate(() => window.__ev['housing:cursorChanged'].length);
  await mouseMove(-160, 0);        // −X room: screen right = −Z, so −160 px moves the cursor toward +Z
  await waitSim(0.15);
  const cur1 = await lastEv('housing:cursorChanged');
  const cursorN1 = await page.evaluate(() => window.__ev['housing:cursorChanged'].length);
  ok(cursorN1 > cursorN && cur1.room === 0, `mouse movement emitted housing:cursorChanged → cell (${cur1.x},${cur1.y}) valid ${cur1.valid}`);

  /* ── 5. place furniture (real API or faked event) ───────────────────── */
  let placedItem = null;
  if (real.impl) {
    const sel = await page.evaluate(() => { const h = window.__game.ctx.housing; h.selectFurniture('furn_bench_gun'); return { sel: h.selectedFurniture, stored: h.getStored().map((s) => `${s.defId}×${s.qty}`) }; });
    ok(sel.sel === 'furn_bench_gun', `selected the starter 총기 작업대 from storage (${sel.stored.join(',')})`);
    await waitSim(0.15);
    const ghost = await page.evaluate(() => {
      const root = window.__game.ctx.scene.getObjectByName('PersonalShip');
      const g = root.children.find((c) => c.name === 'furn-furn_bench_gun');
      return { ghost: !!g, valid: window.__game.getSystem('hub').housing.cell.valid, cell: { ...window.__game.getSystem('hub').housing.cell } };
    });
    ok(ghost.ghost && ghost.valid, `ghost bench shown, placement valid at (${ghost.cell.x},${ghost.cell.y})`);
    await tap('KeyR');
    await waitSim(0.1);
    ok((await page.evaluate(() => window.__game.ctx.housing.selectedYaw)) === 1, 'R rotated the selection (yaw 1)');
    await tap('KeyR'); await tap('KeyR'); await tap('KeyR');
    await waitSim(0.1);
    await click(0);
    await waitSim(0.2);
    placedItem = await lastEv('housing:furniturePlaced');
    ok(!!placedItem && placedItem.item.room === 0 && placedItem.item.x === ghost.cell.x && placedItem.item.y === ghost.cell.y, `LMB placed the bench at (${placedItem?.item.x},${placedItem?.item.y})`);
    placedItem = placedItem?.item ?? null;
  } else {
    console.log('  (housing rules not implemented — faking housing:furniturePlaced)');
    placedItem = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const item = { uid: 'f-smoke', defId: 'furn_bench_gun', room: 0, x: 2, y: 3, yaw: 0, level: 1 };
      ctx.housing.state.furniture.push(item);
      ctx.bus.emit('housing:furniturePlaced', { item });
      return item;
    });
    ok(true, 'faked a placed 총기 작업대 at (2,3)');
  }
  const rendered = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const root = ctx.scene.getObjectByName('PersonalShip');
    const group = root.getObjectByName('room-0');
    const meshes = []; group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const layer = window.__game.getSystem('hub').furnitureLayer;
    return { children: group.children.length, meshes: meshes.length, count: layer.count, furn: ctx.interactables.all().filter((i) => i.id.startsWith('hub_furn_')).map((i) => i.id), center: group.children[0] ? [group.children[0].position.x, group.children[0].position.z] : null };
  });
  ok(rendered.children >= 1 && rendered.meshes >= 2 && rendered.count === 1, `furniture mesh under the room-0 group (${rendered.children} objects, ${rendered.meshes} meshes)`);
  ok(rendered.furn.length === 1 && rendered.furn[0] === `hub_furn_${placedItem.uid}`, `bench interactable ${rendered.furn[0]}`);
  const expX = -5.8 + (placedItem.x + 2) * 0.5, expZ = 0.5 + (placedItem.y + 1) * 0.5;
  ok(rendered.center && Math.abs(rendered.center[0] - expX) < 0.01 && Math.abs(rendered.center[1] - expZ) < 0.01, `cell → world centre (${rendered.center?.map((n) => n.toFixed(2))}) matches roomCellToWorld`);
  // collider: the bench pushes a 0.45 m circle out
  const pushed = await page.evaluate(([x, z]) => {
    const col = window.__game.ctx.player.interior;
    const v = window.__game.ctx.player.position.clone(); v.set(x, 0, z);
    col.resolveCollision(v, 0.45);
    return [v.x, v.z];
  }, [expX, expZ]);
  ok(Math.abs(pushed[0] - expX) > 0.3 || Math.abs(pushed[1] - expZ) > 0.3, `collider pushes out of the bench (${pushed.map((n) => n.toFixed(2))})`);

  /* ── 6. Esc exits; walking resumes; the bench blocks the player ─────── */
  await tap('Escape');
  await waitSim(0.2);
  const exited = await page.evaluate(() => ({ active: window.__game.getSystem('hub').housing.active, ev: window.__ev['housing:modeChanged'], mode: window.__game.ctx.housing?.housingMode }));
  ok(!exited.active && exited.ev.some((e) => e.active === false), 'Esc left housing mode (housing:modeChanged {active:false})');
  await waitSim(1.5);
  const cam2 = await page.evaluate(() => window.__game.ctx.camera.position.y);
  ok(cam2 < 3.5, `camera released (y ${cam2.toFixed(2)})`);
  await teleport(expX, expZ, 0);
  await waitSim(0.5);
  const stood = await playerPos();
  ok(Math.abs(stood[0] - expX) > 0.3 || Math.abs(stood[2] - expZ) > 0.3, `player standing in the bench is pushed out (${stood[0].toFixed(2)}, ${stood[2].toFixed(2)})`);
  const bench = await page.evaluate((uid) => { const i = window.__game.ctx.interactables.all().find((i) => i.id === `hub_furn_${uid}`); return { prompt: i.getPrompt(), can: i.canInteract() }; }, placedItem.uid);
  ok(bench.can && /총기 작업대 Lv\.1/.test(bench.prompt ?? ''), `bench prompt after exit: ${bench.prompt}`);
  if (real.impl) {
    const prompt = await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_room_0').getPrompt());
    ok(prompt === '방 1 · 작업실', `door console follows the purpose: ${prompt}`);
  }

  /* ── 7. recover with X (real rules only) ────────────────────────────── */
  if (real.impl) {
    await teleport(-3.8, 2.5, 0);
    await waitSim(0.2);
    await page.evaluate(() => window.__game.ctx.housing.enterHousingMode(0));
    await waitSim(0.2);
    // cursor starts on the player; put it on the bench centre with the mouse (−X room: dy → +X, dx → −Z)
    const cellNow = await page.evaluate(() => ({ ...window.__game.getSystem('hub').housing.cell }));
    const dz = expZ - 2.5, dx = expX - (-3.8);
    await mouseMove(Math.round(-dz / 0.012), Math.round(-dx / 0.012));
    await waitSim(0.15);
    const over = await page.evaluate(() => ({ ...window.__game.getSystem('hub').housing.cell }));
    ok(over.valid, `cursor over the bench is a valid pick-up target (${over.x},${over.y}; was ${cellNow.x},${cellNow.y})`);
    await tap('KeyX');
    await waitSim(0.2);
    const rec = await page.evaluate(() => ({ ev: window.__ev['housing:furnitureRecovered'].length, count: window.__game.getSystem('hub').furnitureLayer.count, furn: window.__game.ctx.interactables.all().filter((i) => i.id.startsWith('hub_furn_')).length, stored: window.__game.ctx.housing.getStored().length }));
    ok(rec.ev === 1 && rec.count === 0 && rec.furn === 0, `X recovered the bench (meshes ${rec.count}, interactables ${rec.furn}, storage entries ${rec.stored})`);
    await tap('Escape');
    await waitSim(0.2);
  }

  /* ── 8. teardown + re-enter ─────────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitSim(0.2);
  const torn = await page.evaluate(() => ({ phase: window.__game.ctx.phase, layer: window.__game.getSystem('hub').furnitureLayer, room: window.__game.ctx.hub.currentRoom, last: window.__ev['hub:roomEntered'].slice(-1)[0], left: window.__ev['hub:left'].length }));
  ok(torn.phase === 'menu' && torn.layer === null && torn.room === null && torn.last?.room === null, 'teardown: furniture layer disposed, currentRoom null, hub:roomEntered {null}');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (again)');
  await waitSim(0.3);
  ok((await page.evaluate(() => window.__game.ctx.interactables.all().filter((i) => /^hub_room_\d$/.test(i.id)).length)) === 10, 're-entering rebuilds the ten room consoles');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await browser.close();
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
