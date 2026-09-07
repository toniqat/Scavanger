// Single-player smoke test for the quick-use wheel slots (inventory side of Phase 2).
// Usage: node scripts/smoke-quickslots.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

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
    '--window-size=1280,760', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  // the relay is not part of this smoke: ignore the ws handshake failure
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('WebSocket connection')) errors.push(m.text()); });
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
    for (const n of ['inventory:quickSlotsChanged', 'inventory:itemRemoved', 'stim:countChanged', 'grenade:countChanged', 'inventory:bagChanged', 'inventory:itemDropped']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const slots = () => page.evaluate(() => window.__game.ctx.inventory.getQuickSlots().map((i) => i && { uid: i.uid, defId: i.defId, qty: i.qty }));
  const bagDef = (defId) => page.evaluate((d) => window.__game.ctx.inventory.getAllItems().filter((i) => i.defId === d).map((i) => ({ uid: i.uid, qty: i.qty })), defId);
  const centre = async (sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel);
  const dragMouse = async (from, to, onMid) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    await page.mouse.move(mid.x, mid.y, { steps: 4 });
    if (onMid) await onMid(mid);
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await sleep(60);
    await page.mouse.up();
    await sleep(120);
  };
  /** Centre of the drag ghost, so a drag can assert it rides the pointer. */
  const ghostCentre = () => page.evaluate(() => {
    const r = document.querySelector('.inv-ghost')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });

  console.log('selftest');
  // the dev server serves the TS module directly; a `vite preview` build has no /src → skipped
  const st = await page.evaluate(async () => { try { const m = await import('/src/inventory/index.ts'); return m.runInventorySelfTest(); } catch { return 'skipped'; } });
  if (st === 'skipped') { console.log('  skip runInventorySelfTest() (not a dev server)'); errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource'))); }
  else ok(st === true, 'runInventorySelfTest() passes (grid / sockets / quick slots)');

  console.log('starter kit');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  // the relay's profile document lands a moment after the hub entry and rebuilds the bag with fresh uids — wait
  // for it (or time out when no relay is running) so the uids captured below stay valid
  await page.evaluate(() => new Promise((res) => {
    let off = null;
    const done = () => { if (off) off(); res(true); };
    off = window.__game.ctx.bus.on('net:profileLoaded', () => setTimeout(done, 150));
    setTimeout(done, 2500);
  }));
  let s = await slots();
  ok(s.length === 8, 'getQuickSlots() has 8 entries');
  ok(s[0]?.defId === 'grenade_frag' && s[0].qty === 3, 'starter: grenades in slot 0 (N)', JSON.stringify(s[0]));
  const active = await page.evaluate(() => window.__game.ctx.inventory.getQuickSlotCount());
  ok(active === 2, 'starter bag_common → 2 usable slots', String(active));
  ok(s[4]?.defId === 'heal_bandage' && s[1] === null, 'starter: stims in slot 4 (S) — N + S are the first two unlocks', JSON.stringify(s));
  let q = await lastEv('inventory:quickSlotsChanged');
  ok(q && q.active === 2 && q.slots.length === 8 && q.slots[0]?.defId === 'grenade_frag', 'inventory:quickSlotsChanged emitted with {slots, active}');

  console.log('setQuickSlot / consumeItem');
  const [stim] = await bagDef('heal_bandage');
  const [nade] = await bagDef('grenade_frag');
  const [ammo] = await bagDef('ammo_light');
  let r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(2, u), stim.uid);
  ok(r === false, 'setQuickSlot into a locked slot (E, 3rd unlock) refused');
  r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(0, u), ammo.uid);
  ok(r === false, 'setQuickSlot with ammo refused (not QUICK_USABLE)');
  r = await page.evaluate(() => window.__game.ctx.inventory.setQuickSlot(9, null));
  ok(r === false, 'setQuickSlot out of range refused');
  const nEv = (await ev('inventory:quickSlotsChanged')).length;
  r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(0, u), stim.uid);
  s = await slots();
  ok(r === true && s[0]?.uid === stim.uid && s[4] === null, 'stim moved to slot 0 (one slot per uid), grenade unassigned', JSON.stringify(s));
  ok((await ev('inventory:quickSlotsChanged')).length === nEv + 1, 'exactly one quickSlotsChanged for the move');
  r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), nade.uid);
  s = await slots();
  ok(r === true && s[4]?.uid === nade.uid, 'grenade into slot 4 (S)');
  const removedBefore = (await ev('inventory:itemRemoved')).length;
  let n = await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 1), stim.uid);
  s = await slots();
  q = await lastEv('inventory:quickSlotsChanged');
  ok(n === 1 && s[0]?.qty === 1 && q.slots[0].qty === 1, 'consumeItem(stim,1) → 1 left, quickSlotsChanged carries the new qty', JSON.stringify(s[0]));
  const stimCount = await lastEv('stim:countChanged');
  ok(stimCount && stimCount.count === 1, 'stim:countChanged 1');
  n = await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 5), stim.uid);
  s = await slots();
  ok(n === 1 && s[0] === null, 'consumeItem over-ask removes the remaining 1 and clears the slot', JSON.stringify(s));
  ok((await ev('inventory:itemRemoved')).length === removedBefore + 1, 'inventory:itemRemoved at 0');
  ok((await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 1), stim.uid)) === 0, 'consumeItem on a gone uid returns 0');
  // drop clears
  r = await page.evaluate((u) => window.__game.ctx.inventory.dropItem(u), nade.uid);
  s = await slots();
  ok(r === true && s[4] === null && s.every((x) => x === null), 'dropItem clears the grenade slot', JSON.stringify(s));
  // sibling relink: two stim stacks, consume the assigned one to 0 → slot follows the other stack
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; inv.tryAddItem(window.__game.ctx.loot.createItem('heal_bandage', 1)); inv.tryAddItem(window.__game.ctx.loot.createItem('grenade_frag', 1)); });
  const stims = await bagDef('heal_bandage');
  ok(stims.length === 1, 'one stim stack in the bag again');
  // top the existing stack up to stackMax and leave exactly 1 in a second stack, whatever the starter left behind
  const bandageMax = await page.evaluate(() => window.__game.ctx.loot.getItemDef('heal_bandage').stackMax);
  await page.evaluate((n) => { const inv = window.__game.ctx.inventory; inv.tryAddItem(window.__game.ctx.loot.createItem('heal_bandage', n)); }, bandageMax - stims[0].qty + 1);
  const stims2 = await bagDef('heal_bandage');
  ok(stims2.length === 2, `two 붕대 stacks (${bandageMax} + 1)`, JSON.stringify(stims2));
  const small = stims2.find((x) => x.qty === 1), big = stims2.find((x) => x.qty === bandageMax);
  await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), small.uid);
  await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 1), small.uid);
  s = await slots();
  ok(s[4]?.uid === big.uid, 'consumed-to-0 stack hands its slot to the sibling stim stack', JSON.stringify(s[1]));

  console.log('reset → 장비 상실 / respawn → starter auto-assign');
  // 2026-09-07: reset() = a lost raid. With items in the 함선 창고 the kit is **not** refilled — it is emptied and
  // the player re-equips from the 창고; only the hellpod respawn still hands out the minimum kit.
  await page.evaluate(() => window.__game.ctx.inventory.reset());
  s = await slots();
  const lost = await page.evaluate(() => { const inv = window.__game.ctx.inventory; return { slots: inv.getQuickSlots().map((x) => x?.defId ?? null), items: inv.getAllItems().length, primary: inv.getLoadout().primary?.defId ?? null, stash: inv.getStashItems ? inv.getStashItems().length : -1 }; });
  ok(lost.items === 0 && lost.primary === null && lost.slots.every((x) => x === null), 'reset() with a stocked 창고 empties the kit instead of refilling it', JSON.stringify(lost));
  await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(0, null), null);
  await page.evaluate(() => window.__game.ctx.bus.emit('player:respawn', { position: window.__game.ctx.player.position.clone().set(0, 0, 0) }));
  s = await slots();
  ok(s[0]?.defId === 'grenade_frag' && s[4]?.defId === 'heal_bandage', 'player:respawn re-applies the starter kit + auto-assign');
  // bag swap: legendary tactical bag → 8 usable; back to no bag → 1 usable, assignments beyond it kept
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; const b = window.__game.ctx.loot.createItem('bag_epic_tac'); inv.tryAddItem(b); inv.equip(b.uid, 'bag'); });
  ok((await page.evaluate(() => window.__game.ctx.inventory.getQuickSlotCount())) === 8, 'bag_epic_tac → 8 usable slots');
  q = await lastEv('inventory:quickSlotsChanged');
  ok(q.active === 8, 'quickSlotsChanged re-emitted with active 8 on bag change');
  const [stimA] = await bagDef('heal_bandage');
  ok(await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(7, u), stimA.uid), 'stim into slot 7 (NW) now allowed');
  await page.evaluate(() => window.__game.ctx.inventory.equip(null, 'bag'));
  s = await slots();
  const cnt = await page.evaluate(() => window.__game.ctx.inventory.getQuickSlotCount());
  const stillThere = await bagDef('heal_bandage');
  ok(cnt === 1 && (stillThere.length === 0 ? s[7] === null : s[7]?.uid === stimA.uid), 'unequipping the bag → 1 usable; slot 7 keeps its item while it stays in the bag (cleared if it overflowed)', JSON.stringify({ cnt, s7: s[7], stillThere }));
  // 2026-09-07: reset() only empties the kit now — the hellpod respawn is what hands the starter kit back
  await page.evaluate(() => window.__game.ctx.bus.emit('player:respawn', { position: window.__game.ctx.player.position.clone() }));
  await sleep(150);

  console.log('bag window (real mouse)');
  await page.evaluate(() => window.__game.ctx.inventory.toggleBag());
  await sleep(300);
  ok(await page.evaluate(() => window.__game.ctx.inventory.isOpen), 'bag open');
  const cells = await page.evaluate(() => [...document.querySelectorAll('.inv-quick-cell')].map((c) => ({ i: c.dataset.index, locked: c.classList.contains('is-locked'), has: c.classList.contains('has-item'), title: c.title })));
  ok(cells.length === 8, '8 wheel cells rendered');
  ok(cells.filter((c) => c.locked).map((c) => c.i).sort().join() === '1,2,3,5,6,7' && cells.find((c) => c.i === '2').title === '가방 등급이 낮아 잠김', 'cells E W + diagonals locked (unlock order), locked tooltip', JSON.stringify(cells));
  ok(cells.find((c) => c.i === '0').has && cells.find((c) => c.i === '4').has && !cells.find((c) => c.i === '4').locked, 'cells N / S show the starter items, S unlocked');
  const badges = await page.evaluate(() => [...document.querySelectorAll('.inv-grid-bag .inv-tile-quick')].map((b) => b.textContent));
  ok(badges.length === 2 && badges.includes('▲') && badges.includes('▼'), 'bag tiles carry the direction badges', JSON.stringify(badges));
  const roseOrder = await page.evaluate(() => [...document.querySelector('.inv-quick-rose').children].map((c) => c.dataset.index ?? 'c').join(','));
  ok(roseOrder === '7,0,1,6,c,2,5,4,3', 'rose DOM order NW,N,NE / W,centre,E / SW,S,SE', roseOrder);
  // drag the stim tile from the bag grid onto cell 0 → stim moves to N, grenade unassigned
  const [stimB] = await bagDef('heal_bandage');
  const [nadeB] = await bagDef('grenade_frag');
  const stimTile = await centre(`.inv-grid-bag .inv-tile[data-uid="${stimB.uid}"]`);
  const cell0 = await centre('.inv-quick-cell[data-index="0"]');
  /* 2026-09-07: the ghost must sit **centred on the pointer**. `.inv-ghost` carried its 1.04 lift as a standalone
     `scale:`, which CSS applies before the `transform` the drag writes — so the translate was multiplied and the
     picture drifted further from the cursor the further right / down it went (42 px at x = 1080). */
  let ghostOff = null;
  await dragMouse(stimTile, cell0, async (mid) => {
    const g = await ghostCentre();
    ghostOff = g && { dx: Math.round(g.x - mid.x), dy: Math.round(g.y - mid.y) };
  });
  ok(ghostOff !== null && Math.abs(ghostOff.dx) <= 2 && Math.abs(ghostOff.dy) <= 2,
    'the drag ghost rides centred on the pointer', JSON.stringify(ghostOff));
  s = await slots();
  ok(s[0]?.uid === stimB.uid && s[4] === null, 'real-mouse drag stim → cell N assigns it (grenade unassigned)', JSON.stringify(s));
  // drag the grenade onto the locked cell 2 (E) → refused, still unassigned
  const nadeTile = await centre(`.inv-grid-bag .inv-tile[data-uid="${nadeB.uid}"]`);
  const cell2 = await centre('.inv-quick-cell[data-index="2"]');
  await dragMouse(nadeTile, cell2);
  s = await slots();
  ok(s[2] === null && s.filter(Boolean).length === 1, 'drag onto a locked cell refused', JSON.stringify(s));
  // drag the grenade onto cell 4 (S)
  await dragMouse(nadeTile, await centre('.inv-quick-cell[data-index="4"]'));
  s = await slots();
  ok(s[4]?.uid === nadeB.uid, 'drag grenade → cell S', JSON.stringify(s));
  // drag cell 0 tile → cell 4: stim moves to S, grenade (blocked) is replaced → unassigned
  const c0tile = await centre('.inv-quick-cell[data-index="0"] .inv-tile');
  await dragMouse(c0tile, await centre('.inv-quick-cell[data-index="4"]'));
  s = await slots();
  ok(s[4]?.uid === stimB.uid && s[0] === null, 'cell → cell drag moves the assignment', JSON.stringify(s));
  // drag cell 4 tile out onto the backdrop → cleared, item still in the bag, nothing dropped to the world
  const droppedBefore = (await ev('inventory:itemDropped')).length;
  const c1tile = await centre('.inv-quick-cell[data-index="4"] .inv-tile');
  await dragMouse(c1tile, { x: 40, y: 40 });
  s = await slots();
  const stimStill = await bagDef('heal_bandage');
  ok(s[4] === null && stimStill.length === 1 && (await ev('inventory:itemDropped')).length === droppedBefore, 'cell dragged to the backdrop clears the slot; the stim stays in the bag', JSON.stringify(s));
  // drag a non-usable item (ammo) onto cell 0 → red target, refused
  const [ammoB] = await bagDef('ammo_light');
  await dragMouse(await centre(`.inv-grid-bag .inv-tile[data-uid="${ammoB.uid}"]`), cell0);
  s = await slots();
  ok(s[0] === null, 'ammo onto a cell refused', JSON.stringify(s));
  // right-click a stim in the bag → menu has 빠른 슬롯에 등록; click it → first free slot (0)
  const stimTile2 = await centre(`.inv-grid-bag .inv-tile[data-uid="${stimB.uid}"]`);
  await page.mouse.click(stimTile2.x, stimTile2.y, { button: 'right' });
  await sleep(150);
  let items = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent));
  ok(items.some((t) => t.includes('빠른 슬롯에 등록')), 'bag stim context menu offers 빠른 슬롯에 등록', JSON.stringify(items));
  await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((b) => b.textContent.includes('빠른 슬롯에 등록')).click());
  await sleep(150);
  s = await slots();
  ok(s[0]?.uid === stimB.uid, '빠른 슬롯에 등록 → first free usable slot (N)', JSON.stringify(s));
  // right-click the cell → 빠른 슬롯 해제
  const c0tile2 = await centre('.inv-quick-cell[data-index="0"] .inv-tile');
  await page.mouse.click(c0tile2.x, c0tile2.y, { button: 'right' });
  await sleep(150);
  items = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent));
  ok(items[0]?.includes('빠른 슬롯 해제'), 'cell context menu: 빠른 슬롯 해제', JSON.stringify(items));
  await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((b) => b.textContent.includes('빠른 슬롯 해제')).click());
  await sleep(150);
  s = await slots();
  ok(s[0] === null, '해제 clears the cell', JSON.stringify(s));
  // bag stim menu now offers 등록 again; a stim already assigned offers 해제
  await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), stimB.uid);
  await sleep(100);
  const stimTile3 = await centre(`.inv-grid-bag .inv-tile[data-uid="${stimB.uid}"]`);
  await page.mouse.click(stimTile3.x, stimTile3.y, { button: 'right' });
  await sleep(150);
  items = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent));
  ok(items.some((t) => t.includes('빠른 슬롯 해제')), 'assigned bag stim context menu offers 빠른 슬롯 해제', JSON.stringify(items));
  await page.keyboard.press('Escape');
  await sleep(100);
  await page.evaluate(() => window.__game.ctx.inventory.closeAll());
  await sleep(250);
  ok(!(await page.evaluate(() => window.__game.ctx.inventory.isOpen)), 'bag closed');
} catch (e) {
  fail++;
  console.log('  FAIL exception', e && e.stack || e);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors`);
for (const e of errors.slice(0, 10)) console.log('  console:', e.slice(0, 300));
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
