// Smoke test for the personal-ship rooms + 3D housing mode (함선 꾸미기, hub folder, 2026-09-06):
// cockpit → corridor → 10 rooms, room tracking (`currentRoom` / `hub:roomEntered`), the terminal without a seed
// section, the removed door / facility consoles (Phase 8 UI pass), housing mode (camera override, cursor from mouse deltas, ghost,
// LMB place, X recover, Esc exit), placed furniture (mesh under the room group, collider push-out, interactable) and the
// ship computer (Phase 5: `hub_computer` → corp screen `ui:corpToggled` or the fallback warning toast, Esc, desk collider,
// `크레딧` line on the terminal screen).
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket (a save in another editor would full-reload the page mid-run); the relay socket is untouched.
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, 'boot');
  // fresh ship state so room 0 starts empty
  await page.evaluate(() => { try { localStorage.removeItem('scav.s1.ship'); } catch {} });
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
      'housing:furnitureRecovered', 'housing:selectionChanged', 'ui:housingToggled', 'hub:left', 'ui:corpToggled', 'ui:notify', 'ui:hubMenuToggled']) {
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
    const pool = window.__game.getSystem('hub').interior?.lights?.size ?? -1;
    return { ship: ctx.hub.ship, ids, lights, pool, roomGroups, pos: [ctx.player.position.x, ctx.player.position.z], room: ctx.hub.currentRoom };
  });
  ok(ship.ship === 'personal' && Math.abs(ship.pos[0]) < 0.01 && Math.abs(ship.pos[1] + 1.8) < 0.05, `spawned in the cockpit at (${ship.pos.map((n) => n.toFixed(2))})`);
  // Phase 8: the cockpit lost its built-in 정비 벤치 (now 작업실 furniture) and its 수경 재배 rack (now 온실 재배층).
  for (const id of ['hub_terminal', 'hub_implant_bay', 'hub_pod_0', 'hub_computer']) ok(ship.ids.includes(id), `cockpit interactable ${id} registered`);
  for (const id of ['hub_workbench', 'hub_garden']) ok(!ship.ids.includes(id), `cockpit no longer registers ${id}`);
  // Phase 8 UI pass: the door consoles and the cockpit facility console are gone (rooms / facilities live in the
  // Tab 함선 tab and in 시설 관리), so neither interactable exists any more.
  ok(!ship.ids.includes('hub_facility'), 'facility console hub_facility removed');
  const roomIds = ship.ids.filter((i) => /^hub_room_\d$/.test(i));
  ok(roomIds.length === 0, `no room door consoles registered (${roomIds.length})`);
  // 2026-09-10: the ship owns exactly its `LightPool` (HUB_POINT_LIGHTS) — the pool re-anchors to the nearest fixtures
  // (cockpit / corridor / airlock / nearest lit rooms) and the count stays constant. Read the size, not a literal.
  ok(ship.pool > 0 && ship.lights === ship.pool, `constant point-light count = light pool size (${ship.lights} / pool ${ship.pool})`);
  ok(ship.roomGroups === 10, `one furniture group per room (${ship.roomGroups})`);
  ok(ship.room === null, 'currentRoom is null in the cockpit');
  // 2026-09-07: a ship starts with ten empty rooms and no furniture — the room-1 작업실 is gone. The housing-mode
  // walk-through below needs a 작업실 with a bench in storage, so seed room 1 the way a player would build it.
  const room0 = await page.evaluate(() => {
    const h = window.__game.ctx.housing;
    const before = { purpose: h.getRoom(0).purpose, placed: h.getPlaced(0).length };
    h.state.rooms[0] = { purpose: 'workshop', level: 1 };
    h.state.furnitureStorage.push({ defId: 'furn_bench_gun', level: 1, qty: 1 });
    return { ...before, seeded: h.getRoom(0).purpose, stored: h.getStored().map((e) => e.defId).join(',') };
  });
  ok(room0.purpose === 'empty' && room0.placed === 0, `a fresh ship has no built-in 작업실 (방 1 = ${room0.purpose}, ${room0.placed} 가구)`);
  ok(room0.seeded === 'workshop' && room0.stored === 'furn_bench_gun', `seeded 방 1 = 작업실 with a 총기 작업대 in storage (${room0.stored})`);
  await waitSim(0.1);

  /* ── 2. terminal: no seed section ───────────────────────────────────── */
  // Phase 8: Escape in the ship opens the PAUSE menu now, so the terminal is opened through its interactable.
  await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
  await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
  const term = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.menu.hub-menu .ui-label')].map((n) => n.textContent),
    seedInput: !![...document.querySelectorAll('.menu.hub-menu input')].find((i) => /무작위/.test(i.placeholder)),
    hint: document.querySelector('.menu.hub-menu .seed-hint')?.textContent ?? '',
  }));
  ok(!term.labels.includes('임무 시드') && !term.seedInput, `terminal has no 임무 시드 section (${term.labels.join(' / ')})`);
  // 2026-09-08: the `/seed` hint line is gone (당연한 설명은 화면에서 지운다) — the console still owns the seed.
  ok(term.hint === '', `no seed hint line in the terminal ("${term.hint}")`);
  const seedSet = await page.evaluate(() => ({ r: window.__game.ctx.hub.setMissionSeed(1234), v: window.__game.ctx.hub.missionSeed }));
  ok(seedSet.r === true && seedSet.v === 1234, 'setMissionSeed(1234) accepted solo');
  await page.evaluate(() => window.__game.ctx.hub.setMissionSeed(null));
  await tap('KeyE');   // 2026-09-08: the terminal closes on E (Escape is the 일시정지 메뉴)
  await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
  await waitSim(0.2);

  /* ── 2b. ship computer (기업 네트워크) ───────────────────────────────── */
  console.log('ship computer');
  const comp = await page.evaluate(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_computer');
    return it ? { pos: [it.position.x, it.position.z], radius: it.radius, prompt: it.getPrompt(), can: it.canInteract(), hold: it.holdTime ?? 0 } : null;
  });
  ok(!!comp && comp.prompt === '기업 네트워크' && comp.radius === 2.2 && comp.hold === 0, `hub_computer: prompt ${comp?.prompt}, radius ${comp?.radius}, instant`);
  // Phase 9 UI pass: the desk moved off the +X wall (where its prompt fought the launch pod) to the port half of
  // the rear wall, replacing the lockers that overlapped the bunk. Anchor ≈ (−3.15, −1.83), facing −Z.
  ok(!!comp && comp.pos[0] > -4.2 && comp.pos[0] < -2.1 && comp.pos[1] > -2.6 && comp.pos[1] < -1.0, `anchor on the rear wall, port side (${comp?.pos.map((n) => n.toFixed(2))})`);
  // desk collider (desk + chair box x −3.92 … −2.38, z −1.18 … −0.03): a 0.45 m circle inside it is pushed into the room
  const deskPush = await page.evaluate(() => {
    const col = window.__game.ctx.player.interior;
    const v = window.__game.ctx.player.position.clone(); v.set(-3.15, 0, -1.0);
    col.resolveCollision(v, 0.45);
    return [v.x, v.z];
  });
  ok(deskPush[1] < -1.2 && deskPush[1] > -2.8, `desk collider pushes a circle out toward the room (${deskPush.map((n) => n.toFixed(2))})`);
  // terminal screen carries a 크레딧 line (meta) — read the TextPlane's last drawn key
  const screenText = () => page.evaluate(() => window.__game.getSystem('hub').terminal?.def.screen.last ?? '');
  const hasMeta = await page.evaluate(() => !!window.__game.ctx.meta && typeof window.__game.ctx.meta.credits === 'number');
  if (hasMeta) {
    const c0 = await page.evaluate(() => window.__game.ctx.meta.credits);
    ok((await screenText()).includes(`크레딧 ${c0.toLocaleString('ko-KR')}`), `terminal screen shows 크레딧 ${c0}`);
    const c1 = await page.evaluate(() => { const m = window.__game.ctx.meta; m.addCredits(100, 'smoke'); return m.credits; });
    if (c1 !== c0) {
      await page.evaluate((c) => window.__game.ctx.bus.emit('meta:creditsChanged', { credits: c, delta: 100, reason: 'smoke' }), c1);
      await waitSim(0.1);
      ok((await screenText()).includes(`크레딧 ${c1.toLocaleString('ko-KR')}`), `meta:creditsChanged refreshes the screen (크레딧 ${c1})`);
      await page.evaluate(() => window.__game.ctx.meta.addCredits(-100, 'smoke'));
    } else console.log('  (meta.addCredits is a stub — refresh check skipped)');
  } else console.log('  (ctx.meta missing — 크레딧 line skipped)');
  // stand at the anchor facing the desk (+X) and press E
  await teleport(comp.pos[0], comp.pos[1], -Math.PI / 2);
  await waitSim(0.3);
  const best = await page.evaluate(() => { const p = window.__game.ctx.player; return window.__game.ctx.interactables.findBest(p.position)?.id ?? null; });
  ok(best === 'hub_computer', `findBest at the anchor is hub_computer (${best})`);
  await tap('KeyE');
  await waitSim(0.3);
  const used = await page.evaluate(() => ({
    corp: window.__ev['ui:corpToggled'].slice(), toasts: window.__ev['ui:notify'].filter((n) => /기업 네트워크/.test(n.text)),
    metaOpen: !!window.__game.ctx.meta?.isMenuOpen, blockers: [...window.__game.ctx.uiBlockers],
  }));
  const corpOpened = used.corp.some((e) => e.open) || used.metaOpen;
  if (corpOpened) {
    ok(used.metaOpen, `E opened the corp screen (ui:corpToggled ${JSON.stringify(used.corp[used.corp.length - 1])}, blockers ${used.blockers.join(',')})`);
    ok((await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').canInteract())) === false, 'terminal not interactable while the corp screen is open');
    await tap('Tab');   // 2026-09-08: the 기업 screen is a tab of the Tab window, so Tab closes it
    await waitSim(0.3);
    const closed = await page.evaluate(() => ({ metaOpen: !!window.__game.ctx.meta?.isMenuOpen, corp: window.__ev['ui:corpToggled'].slice(-1)[0], hubMenu: !document.querySelector('.menu.hub-menu').hidden, blockers: [...window.__game.ctx.uiBlockers] }));
    ok(!closed.metaOpen && closed.corp?.open === false, `Tab closed the corp screen (${JSON.stringify(closed.corp)})`);
    ok(!closed.hubMenu && closed.blockers.length === 0, `terminal menu stayed closed after Tab (blockers ${closed.blockers.join(',') || 'none'})`);
  } else {
    console.log('  (ctx.meta.openCorpMenu is a stub — checking the fallback toast)');
    ok(used.toasts.length >= 1 && used.toasts[0].kind === 'warning', `E emitted the fallback warning toast (${used.toasts[0]?.text})`);
    ok(used.blockers.length === 0, 'no blocker left behind by the fallback');
  }
  ok((await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_computer').canInteract())) === true, 'computer usable again afterwards');
  // a player standing in the front edge of the desk is pushed back into the room
  await teleport(-3.15, -1.0, 0);
  await waitSim(0.5);
  const inDesk = await playerPos();
  ok(inDesk[2] < -1.2 && inDesk[2] > -2.8, `player spawned in the desk edge is pushed out into the room (${inDesk[0].toFixed(2)}, ${inDesk[2].toFixed(2)})`);

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

  /* ── 4. housing mode in room 0 ──────────────────────────────────────── */
  console.log('housing mode');
  await teleport(-3.8, 2.5, 0);
  await waitSim(0.3);
  const real = await page.evaluate(() => {
    const h = window.__game.ctx.housing;
    if (!h) return { impl: false };
    const purpose = h.getRoom(0).purpose === 'workshop';   // seeded above (시설 증축 costs materials now)
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
  ok((await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').canInteract())) === false, 'stations not interactable while decorating');
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
    // Rotation changes the footprint, so the clamped top-left cell moves with it — sample the ghost again
    // right before the click instead of comparing against the pre-rotation cell.
    const ghostNow = await page.evaluate(() => ({ ...window.__game.getSystem('hub').housing.cell }));
    await click(0);
    await waitSim(0.2);
    placedItem = await lastEv('housing:furniturePlaced');
    ok(!!placedItem && placedItem.item.room === 0 && placedItem.item.x === ghostNow.x && placedItem.item.y === ghostNow.y, `LMB placed the bench at (${placedItem?.item.x},${placedItem?.item.y}), ghost at (${ghostNow.x},${ghostNow.y})`);
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
    return { children: group.children.length, meshes: meshes.length, count: layer.count, furn: ctx.interactables.all().filter((i) => i.id.startsWith('hub_furn_')).map((i) => i.id), center: (() => { const m = group.children.find((c) => typeof c.name === 'string' && c.name.startsWith('furn-')) ?? group.children[0]; return m ? [m.position.x, m.position.z] : null; })() };
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

  /* ── 6. M exits; walking resumes; the bench blocks the player ──────── */
  await tap('KeyM');   // 2026-09-08: housing mode leaves on M, the key that entered it
  await waitSim(0.2);
  const exited = await page.evaluate(() => ({ active: window.__game.getSystem('hub').housing.active, ev: window.__ev['housing:modeChanged'], mode: window.__game.ctx.housing?.housingMode }));
  ok(!exited.active && exited.ev.some((e) => e.active === false), 'M left housing mode (housing:modeChanged {active:false})');
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
    const purpose = await page.evaluate(() => window.__game.ctx.housing.getRoom(0).purpose);
    ok(purpose === 'workshop', `room 1 keeps its 작업실 purpose through housing mode: ${purpose}`);
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
    // the two built-in benches were already recovered in section 1, so count the events relative to that
    const recBefore = await page.evaluate(() => window.__ev['housing:furnitureRecovered'].length);
    await tap('KeyX');
    await waitSim(0.2);
    const rec = await page.evaluate(() => ({ ev: window.__ev['housing:furnitureRecovered'].length, count: window.__game.getSystem('hub').furnitureLayer.count, furn: window.__game.ctx.interactables.all().filter((i) => i.id.startsWith('hub_furn_')).length, stored: window.__game.ctx.housing.getStored().length }));
    ok(rec.ev === recBefore + 1 && rec.count === 0 && rec.furn === 0, `X recovered the bench (meshes ${rec.count}, interactables ${rec.furn}, storage entries ${rec.stored})`);
    await tap('KeyM');
    await waitSim(0.2);
  }

  /* ── 7b. 시설 관리 (M): M / C leave cleanly (2026-09-08: was Esc) ───── */
  if (real.impl) {
    console.log('시설 관리 (M)');
    await teleport(0, -1.8, 0);
    await waitSim(0.3);
    await tap('KeyM');
    await waitSim(0.4);
    const mng = await page.evaluate(() => ({
      manage: window.__game.ctx.housing.shipManageMode, ctrl: window.__game.getSystem('hub').housing.manage,
      blocker: window.__game.ctx.uiBlockers.has('shipmanage'),
      screen: !!document.querySelector('.ship-manage')?.classList.contains('show'),
      hint: !!document.querySelector('.ship-hint')?.classList.contains('show'),
      hintText: document.querySelector('.ship-hint .t')?.textContent ?? '',
    }));
    ok(mng.manage && mng.ctrl && mng.blocker && mng.screen, 'M opens 시설 관리 (screen up, shipmanage blocker taken)');
    ok(!mng.hint && mng.hintText === '시설 관리', `the corner hint reads 시설 관리 and hides while the screen is up (${mng.hintText})`);
    await tap('KeyM');
    await waitSim(0.5);
    const left = await page.evaluate(() => ({
      manage: window.__game.ctx.housing.shipManageMode, blockers: [...window.__game.ctx.uiBlockers],
      controls: window.__game.ctx.player.controlsEnabled,
      screen: !!document.querySelector('.ship-manage')?.classList.contains('show'),
      hint: !!document.querySelector('.ship-hint')?.classList.contains('show'),
      pause: !document.querySelector('.menu.pause')?.classList.contains('hidden'),
    }));
    // the Phase 8 bug: Esc gave the camera back but kept the shipmanage blocker → no controls, no corner hint
    ok(!left.manage && left.blockers.length === 0 && left.controls === true, `Esc leaves 시설 관리: blockers [${left.blockers.join(',')}], controls ${left.controls}`);
    ok(!left.screen && left.hint && !left.pause, 'screen hidden, 시설 관리(M) hint back, Esc consumed (no pause menu)');
    await tap('KeyM');
    await waitSim(0.4);
    await tap('KeyC');
    await waitSim(0.5);
    const byC = await page.evaluate(() => ({ manage: window.__game.ctx.housing.shipManageMode, blockers: window.__game.ctx.uiBlockers.size, controls: window.__game.ctx.player.controlsEnabled }));
    ok(!byC.manage && byC.blockers === 0 && byC.controls === true, 'C with an empty cursor leaves 시설 관리 as well');
    /* 2026-09-08: **Escape cancels the mode too** — the global "Esc = 일시정지" rule has the documented carve-out
       that the innermost thing eats the key first, and 하우징 모드 owns the camera and the controls. Before this,
       Escape stacked the 일시정지 메뉴 on top of a still-running 시설 관리. */
    await tap('KeyM');
    await waitSim(0.4);
    await tap('Escape');
    await waitSim(0.5);
    const byEsc = await page.evaluate(() => ({
      manage: window.__game.ctx.housing.shipManageMode, blockers: [...window.__game.ctx.uiBlockers],
      controls: window.__game.ctx.player.controlsEnabled,
      pause: !document.querySelector('.menu.pause')?.classList.contains('hidden'),
    }));
    ok(!byEsc.manage && byEsc.blockers.length === 0 && byEsc.controls === true && !byEsc.pause,
      'Escape leaves 시설 관리 and does NOT open the 일시정지 메뉴', JSON.stringify(byEsc));
  }

  /* ── 7c. starboard rooms use the SAME camera + cursor convention (Phase 10) ──
     `HousingMode` used to place the eye at `cx − rb.side · 2.2` (over each room's own door wall) and multiply the
     locked cursor deltas by the same `rb.side`, so rooms 6–10 read 180° rotated. Both now use the port convention:
     eye on the room's +X side looking −X, screen-right = world −Z. The port checks above only look at camera y / z
     and only drive the cursor in room 0, so they pass either way — this block is the starboard half. */
  console.log('starboard housing camera (rooms 6-10)');
  await teleport(3.8, 2.5, 0);
  await waitSim(0.3);
  await page.evaluate(() => window.__game.ctx.bus.emit('housing:modeChanged', { active: true, room: 5 }));
  await waitSim(1.6);
  const sb = await page.evaluate(() => {
    const h = window.__game.getSystem('hub').housing, c = window.__game.ctx.camera.position;
    return { active: h.active, room: h.room, x: c.x, y: c.y, z: c.z, cell: { ...h.cell } };
  });
  ok(sb.active && sb.room === 5, `housing controller active for starboard room 5 (room ${sb.room})`);
  // room 5 spans x 1.8..5.8 (centre 3.8), z 0.5..4.5 (centre 2.5) → eye (6.0, 6.6, 2.5), the outer-hull side
  ok(sb.x > 4.8 && sb.y > 4.5 && Math.abs(sb.z - 2.5) < 1.0,
    `starboard camera looks from the outer hull toward the corridor (x ${sb.x.toFixed(2)}, y ${sb.y.toFixed(2)}, z ${sb.z.toFixed(2)})`);
  await mouseMove(-160, 0);
  await waitSim(0.2);
  const sbCur = await page.evaluate(() => ({ ...window.__game.getSystem('hub').housing.cell }));
  ok(sbCur.y > sb.cell.y, `−160 px moves the starboard cursor toward +Z exactly like a port room — not mirrored (cell y ${sb.cell.y} → ${sbCur.y})`);
  await tap('KeyM');
  await waitSim(0.4);
  ok((await page.evaluate(() => window.__game.getSystem('hub').housing.active)) === false, 'M left the starboard housing session');

  /* ── 8. teardown + re-enter ─────────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitSim(0.2);
  const torn = await page.evaluate(() => ({ phase: window.__game.ctx.phase, layer: window.__game.getSystem('hub').furnitureLayer, room: window.__game.ctx.hub.currentRoom, last: window.__ev['hub:roomEntered'].slice(-1)[0], left: window.__ev['hub:left'].length }));
  ok(torn.phase === 'menu' && torn.layer === null && torn.room === null && torn.last?.room === null, 'teardown: furniture layer disposed, currentRoom null, hub:roomEntered {null}');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (again)');
  await waitSim(0.3);
  ok((await page.evaluate(() => window.__game.ctx.interactables.all().filter((i) => /^hub_room_\d$/.test(i.id)).length)) === 0, 're-entering registers no room consoles');
  ok((await page.evaluate(() => window.__game.ctx.interactables.all().some((i) => i.id === 'hub_computer'))) === true, 're-entering re-registers hub_computer');

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
