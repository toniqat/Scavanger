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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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
    for (const n of ['inventory:quickSlotsChanged', 'inventory:itemRemoved', 'stim:countChanged', 'grenade:countChanged', 'inventory:bagChanged', 'inventory:itemDropped', 'inventory:full']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const slots = () => page.evaluate(() => window.__game.ctx.inventory.getQuickSlots().map((i) => i && { uid: i.uid, defId: i.defId, qty: i.qty }));
  // 2026-09-09: `getAllItems()` is the **bag grid only** — a stack registered on the wheel is not in it any more
  // (the wheel is its own container). Wheel stacks come from `getQuickSlots()` instead.
  const bagDef = (defId) => page.evaluate((d) => window.__game.ctx.inventory.getAllItems().filter((i) => i.defId === d).map((i) => ({ uid: i.uid, qty: i.qty })), defId);
  const bagCount = () => page.evaluate(() => window.__game.ctx.inventory.getAllItems().length);
  // a stack coming back from the wheel is `autoPlace`d, which **merges into an existing stack first** — its uid can
  // disappear into a sibling, so "did it come back?" is counted in units, not uids
  const bagUnits = async (defId) => (await bagDef(defId)).reduce((a, x) => a + x.qty, 0);
  const hasBagTile = (uid) => page.evaluate((u) => !!document.querySelector(`.inv-grid-bag .inv-tile[data-uid="${u}"]`), uid);
  /** 붕대 units the player carries, counted independently of the count events (bag grid + wheel). */
  const stimUnits = () => page.evaluate(() => {
    const inv = window.__game.ctx.inventory, loot = window.__game.ctx.loot;
    const isStim = (i) => !!i && loot.getItemDef(i.defId)?.category === 'stim';
    return [...inv.getAllItems(), ...inv.getQuickSlots()].filter(isStim).reduce((a, i) => a + i.qty, 0);
  });
  const addToBag = (defId, qty = 1) => page.evaluate(([d, n]) => window.__game.ctx.inventory.tryAddItem(window.__game.ctx.loot.createItem(d, n)), [defId, qty]);
  /** A quick-usable stim that is **not** the starter 붕대 — since `tryAddItem` merges into matching wheel stacks
   *  first, only a different def is guaranteed to land in the bag grid. */
  const HERB = 'heal_bandage_herb';
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
  // 2026-09-09 — the wheel is another bag space: the starter 수류탄 / 붕대 live **in their slots** and are gone from
  // the grid, so their uids come from `getQuickSlots()` (the old model kept the stacks in the bag and linked them).
  const stim = s[4], nade = s[0];
  ok((await bagDef('heal_bandage')).length === 0 && (await bagDef('grenade_frag')).length === 0,
    'the starter wheel stacks left the bag grid entirely', JSON.stringify(await bagDef('heal_bandage')));
  const [ammo] = await bagDef('ammo_light');
  // A spare stim in the grid is what a "가방 → 휠" move needs. It must be a **different def** from the 붕대 already on
  // the wheel: since `mergeIntoQuick` was wired into `tryAddItem`, a second 붕대 would top that wheel stack up
  // instead of landing in the grid (checked explicitly further down). 약초 붕대 is the same category, its own stack.
  ok(await addToBag(HERB, 1), 'a spare 약초 붕대 added to the bag grid');
  const [bagStim] = await bagDef(HERB);
  let r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(2, u), bagStim.uid);
  ok(r === false && (await bagDef(HERB)).length === 1,
    'setQuickSlot into a locked slot (E, 3rd unlock) refused — the stack stays in the bag');
  r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(0, u), ammo.uid);
  ok(r === false, 'setQuickSlot with ammo refused (not QUICK_USABLE)');
  r = await page.evaluate(() => window.__game.ctx.inventory.setQuickSlot(9, null));
  ok(r === false, 'setQuickSlot out of range refused');
  const nEv = (await ev('inventory:quickSlotsChanged')).length;
  r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(0, u), bagStim.uid);
  s = await slots();
  ok(r === true && s[0]?.uid === bagStim.uid && (await bagDef(HERB)).length === 0,
    'setQuickSlot **moves** the bag 약초 붕대 into slot 0 — its cells free up', JSON.stringify(s[0]));
  const displaced = await bagDef('grenade_frag');
  ok(displaced.length === 1 && displaced[0].uid === nade.uid,
    'the displaced 수류탄 went back into the bag grid (never destroyed, never dropped)', JSON.stringify(displaced));
  ok((await ev('inventory:quickSlotsChanged')).length === nEv + 1, 'exactly one quickSlotsChanged for the move');
  // a uid already on the wheel: pure swap of the two slots, the bag never sees it
  const bagBefore = await bagCount();
  r = await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), bagStim.uid);
  s = await slots();
  ok(r === true && s[4]?.uid === bagStim.uid && s[0]?.uid === stim.uid && (await bagCount()) === bagBefore,
    'wheel → wheel swaps the two slots and leaves the bag untouched', JSON.stringify(s));
  // a full bag has nowhere to put the wheel stack: the move is refused, nothing changes, `inventory:full` names it
  // full stacks, not single units — `autoPlace` merges into an existing stack first, so 1-unit adds would fill 10× fewer cells
  await page.evaluate(() => { const g = window.__game.ctx; const max = g.loot.getItemDef('mat_scrap').stackMax; for (let i = 0; i < 80; i++) if (!g.inventory.tryAddItem(g.loot.createItem('mat_scrap', max))) break; });
  const fullBefore = (await ev('inventory:full')).length;
  r = await page.evaluate(() => window.__game.ctx.inventory.setQuickSlot(4, null));
  s = await slots();
  ok(r === false && s[4]?.uid === bagStim.uid && (await ev('inventory:full')).length === fullBefore + 1,
    'a full bag refuses setQuickSlot(i, null): the stack stays on the wheel and inventory:full is emitted', JSON.stringify(s[4]));
  ok((await page.evaluate(() => window.__game.ctx.inventory.unregisterQuick(4))) === 'fail', 'unregisterQuick on a full bag → fail');
  ok((await page.evaluate(() => window.__game.ctx.inventory.unregisterQuick(2))) === 'noop', 'unregisterQuick on an empty slot → noop');
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; for (const i of inv.getAllItems().filter((x) => x.defId === 'mat_scrap')) inv.takeItem(i.uid); });
  ok((await page.evaluate(() => window.__game.ctx.inventory.unregisterQuick(4))) === 'ok', 'unregisterQuick with room → ok');
  s = await slots();
  ok(s[4] === null && (await bagDef(HERB)).some((x) => x.uid === bagStim.uid),
    'unregisterQuick moved the 약초 붕대 back into the bag grid', JSON.stringify(s));
  await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), bagStim.uid);
  const removedBefore = (await ev('inventory:itemRemoved')).length;
  let n = await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 1), stim.uid);
  s = await slots();
  q = await lastEv('inventory:quickSlotsChanged');
  ok(n === 1 && s[0]?.qty === 1 && q.slots[0].qty === 1, 'consumeItem(stim,1) → 1 left, quickSlotsChanged carries the new qty', JSON.stringify(s[0]));
  const stimCount = await lastEv('stim:countChanged');
  const carried = await stimUnits();
  const stimsInBag = (await bagUnits('heal_bandage')) + (await bagUnits(HERB));
  // every 회복 아이템 the player has is on the wheel right now, so a count that ignored the wheel would read 0
  ok(stimCount && stimCount.count === carried && carried === 2 && stimsInBag === 0,
    'stim:countChanged counts the wheel stacks (nothing is left in the grid)', JSON.stringify({ ev: stimCount, carried, stimsInBag }));
  n = await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 5), stim.uid);
  s = await slots();
  ok(n === 1 && s[0] === null, 'consumeItem over-ask removes the remaining 1 and clears the slot', JSON.stringify(s));
  ok((await ev('inventory:itemRemoved')).length === removedBefore + 1, 'inventory:itemRemoved at 0');
  ok((await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 1), stim.uid)) === 0, 'consumeItem on a gone uid returns 0');
  // 2026-09-09 — a pickup / craft tops the matching **wheel** stack up before it ever makes a bag tile
  // (`mergeIntoQuick` in `tryAddItem` / `addUnits`). Slot 4 holds one 약초 붕대 with room for stackMax − 1 more.
  const herbMax = await page.evaluate((d) => window.__game.ctx.loot.getItemDef(d).stackMax, HERB);
  const qEvTop = (await ev('inventory:quickSlotsChanged')).length;
  ok(await addToBag(HERB, herbMax - 1), `tryAddItem(${herbMax - 1} × 약초 붕대) accepted`);
  s = await slots();
  ok(s[4]?.qty === herbMax && (await bagDef(HERB)).length === 0,
    'a pickup tops up the matching wheel stack instead of making a bag stack', JSON.stringify({ s4: s[4], bag: await bagDef(HERB) }));
  ok((await ev('inventory:quickSlotsChanged')).length > qEvTop, 'the top-up emits inventory:quickSlotsChanged (the HUD qty moved)');
  // the wheel stack is full now: the next unit has to become a bag stack
  ok(await addToBag(HERB, 1), 'one more 약초 붕대 on top of a full wheel stack');
  const sibling = (await bagDef(HERB))[0];
  s = await slots();
  ok(!!sibling && sibling.qty === 1 && s[4]?.qty === herbMax,
    'the overflow becomes a bag stack once the wheel stack is at stackMax', JSON.stringify({ sibling, s4: s[4] }));
  // ...and there is **no sibling relink**: a wheel stack consumed to 0 just empties its slot, the bag stack stays put
  n = await page.evaluate((u) => window.__game.ctx.inventory.consumeItem(u, 99), bagStim.uid);
  s = await slots();
  const survivors = await bagDef(HERB);
  ok(n === herbMax && s[4] === null && survivors.length === 1 && survivors[0].uid === sibling.uid,
    'a wheel stack consumed to 0 empties its slot; the sibling bag stack is not promoted into it', JSON.stringify({ n, s4: s[4], survivors }));
  // takeItem (상점 판매 · 건네주기) reaches the wheel too: it decrements the slot and clears it at 0
  await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), sibling.uid);
  await addToBag(HERB, 2);   // tops the wheel stack up to 3 (same path as the pickup above)
  s = await slots();
  ok(s[4]?.uid === sibling.uid && s[4]?.qty === 3, 'the sibling is on the wheel with 3 units', JSON.stringify(s[4]));
  let took = await page.evaluate((u) => window.__game.ctx.inventory.takeItem(u, 1), sibling.uid);
  s = await slots();
  ok(took === 1 && s[4]?.qty === 2, 'takeItem(uid, 1) decrements the wheel stack', JSON.stringify({ took, s4: s[4] }));
  took = await page.evaluate((u) => window.__game.ctx.inventory.takeItem(u), sibling.uid);
  s = await slots();
  ok(took === 2 && s[4] === null && (await bagDef(HERB)).length === 0, 'takeItem of the rest clears the slot', JSON.stringify({ took, s4: s[4] }));
  // splitItem stays grid-only by design — a wheel slot is one cell, there is nowhere to put the half
  await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(4, u), nade.uid);
  s = await slots();
  ok(s[4]?.uid === nade.uid && s[4].qty >= 2, 'the 수류탄 stack (≥ 2) is on the wheel for the split check', JSON.stringify(s[4]));
  ok((await page.evaluate((u) => window.__game.ctx.inventory.splitItem(u, 1), nade.uid)) === false
    && (await slots())[4]?.qty === s[4].qty, 'splitItem refuses a wheel stack (grid-only by design)');
  // drop: `locate()` sees the wheel now, so a wheel stack can be thrown straight out of its slot
  const removedDrop = (await ev('inventory:itemRemoved')).length;
  const qEvDrop = (await ev('inventory:quickSlotsChanged')).length;
  const bagBeforeDrop = await bagCount();
  r = await page.evaluate((u) => window.__game.ctx.inventory.dropItem(u), nade.uid);
  s = await slots();
  ok(r === true && s[4] === null && (await bagCount()) === bagBeforeDrop,
    'dropItem on a wheel stack empties that slot and leaves the bag grid alone', JSON.stringify({ r, s4: s[4] }));
  ok((await ev('inventory:itemRemoved')).length === removedDrop + 1 && (await ev('inventory:quickSlotsChanged')).length > qEvDrop,
    'the wheel drop emits inventory:itemRemoved + inventory:quickSlotsChanged');
  ok((await bagDef('grenade_frag')).length === 0 && (await slots()).every((x) => x === null), 'the 수류탄 is gone from the player entirely');
  // the other route still works: 가방으로 되돌린 뒤 버리기
  ok(await addToBag('grenade_frag', 1), 'a fresh 수류탄 into the bag (no wheel stack to top up)');
  const nade2 = (await bagDef('grenade_frag'))[0];
  ok((await page.evaluate((u) => window.__game.ctx.inventory.registerQuick(u), nade2.uid)) === 'ok', 'registerQuick moves it onto the wheel');
  ok((await page.evaluate(() => window.__game.ctx.inventory.unregisterQuick(0))) === 'ok', 'unregisterQuick(0) puts it back in the bag');
  r = await page.evaluate((u) => window.__game.ctx.inventory.dropItem(u), nade2.uid);
  s = await slots();
  ok(r === true && s.every((x) => x === null) && (await bagDef('grenade_frag')).length === 0,
    'dropping it from the bag leaves the wheel and the grid empty', JSON.stringify(s));

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
  ok((await bagDef('grenade_frag')).length === 0 && (await bagDef('heal_bandage')).length === 0,
    'the starter picks are **moved** onto the wheel, not linked from the grid');
  // bag swap: legendary tactical bag → 8 usable; back to no bag → 1 usable, the stranded stack returns to the bag
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; const b = window.__game.ctx.loot.createItem('bag_epic_tac'); inv.tryAddItem(b); inv.equip(b.uid, 'bag'); });
  ok((await page.evaluate(() => window.__game.ctx.inventory.getQuickSlotCount())) === 8, 'bag_epic_tac → 8 usable slots');
  q = await lastEv('inventory:quickSlotsChanged');
  ok(q.active === 8, 'quickSlotsChanged re-emitted with active 8 on bag change');
  const stimA = (await slots())[4];
  ok(await page.evaluate((u) => window.__game.ctx.inventory.setQuickSlot(7, u), stimA.uid), 'stim into slot 7 (NW) now allowed');
  s = await slots();
  ok(s[7]?.uid === stimA.uid && s[4] === null, 'the 붕대 sits in the freshly unlocked NW slot', JSON.stringify(s));
  const droppedBeforeBag = (await ev('inventory:itemDropped')).length;
  await page.evaluate(() => window.__game.ctx.inventory.equip(null, 'bag'));
  s = await slots();
  const cnt = await page.evaluate(() => window.__game.ctx.inventory.getQuickSlotCount());
  const backInBag = (await bagDef('heal_bandage')).some((x) => x.uid === stimA.uid);
  const fellOut = (await ev('inventory:itemDropped')).length > droppedBeforeBag;
  // 2026-09-09: a locked slot never keeps an item — `lockedQuickItems` hands it back to the grid (ground on overflow)
  ok(cnt === 1 && s[7] === null && (backInBag || fellOut),
    'unequipping the bag → 1 usable; the stack stranded in the now-locked NW slot goes back to the bag (ground when it no longer fits)',
    JSON.stringify({ cnt, s7: s[7], backInBag, fellOut }));
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
  // 2026-09-09: no direction badges any more — a registered stack is **not** in the grid, so there is no tile to badge
  const badges = await page.evaluate(() => document.querySelectorAll('.inv-grid-bag .inv-tile-quick').length);
  const wheelUids = (await slots()).filter(Boolean).map((x) => x.uid);
  const ghostTiles = [];
  for (const u of wheelUids) if (await hasBagTile(u)) ghostTiles.push(u);
  ok(badges === 0 && wheelUids.length === 2 && ghostTiles.length === 0,
    'no direction badges: the wheel stacks have no bag tile at all', JSON.stringify({ badges, wheelUids, ghostTiles }));
  const roseOrder = await page.evaluate(() => [...document.querySelector('.inv-quick-rose').children].map((c) => c.dataset.index ?? 'c').join(','));
  ok(roseOrder === '7,0,1,6,c,2,5,4,3', 'rose DOM order NW,N,NE / W,centre,E / SW,S,SE', roseOrder);
  // drag a bag stim onto cell 0 (held by the starter 수류탄) → the stim moves in, the 수류탄 is pushed into the bag.
  // 약초 붕대 again: a plain 붕대 would be merged into the wheel stack by `tryAddItem` and never reach the grid.
  ok(await addToBag(HERB, 1), 'a spare 약초 붕대 for the drag tests');
  await sleep(200);
  const [stimB] = await bagDef(HERB);
  const nadeB = (await slots())[0];
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
  ok(s[0]?.uid === stimB.uid && !(await hasBagTile(stimB.uid)),
    'real-mouse drag stim → cell N moves it onto the wheel (its bag tile is gone)', JSON.stringify(s));
  ok((await bagDef('grenade_frag')).some((x) => x.uid === nadeB.uid),
    'the 수류탄 the drag displaced is back in the bag grid', JSON.stringify(await bagDef('grenade_frag')));
  // drag the grenade onto the locked cell 2 (E) → refused, it stays in the bag
  const nadeTile = await centre(`.inv-grid-bag .inv-tile[data-uid="${nadeB.uid}"]`);
  const cell2 = await centre('.inv-quick-cell[data-index="2"]');
  await dragMouse(nadeTile, cell2);
  s = await slots();
  ok(s[2] === null && (await bagDef('grenade_frag')).some((x) => x.uid === nadeB.uid), 'drag onto a locked cell refused', JSON.stringify(s));
  // drag the grenade onto cell 4 (S) — the starter 붕대 sitting there is pushed back into the bag
  await dragMouse(nadeTile, await centre('.inv-quick-cell[data-index="4"]'));
  s = await slots();
  ok(s[4]?.uid === nadeB.uid && !(await hasBagTile(nadeB.uid)), 'drag grenade → cell S', JSON.stringify(s));
  // drag cell 0 tile → cell 4: the two slots swap, the bag is not touched
  const bagBeforeSwap = await bagCount();
  const c0tile = await centre('.inv-quick-cell[data-index="0"] .inv-tile');
  await dragMouse(c0tile, await centre('.inv-quick-cell[data-index="4"]'));
  s = await slots();
  ok(s[4]?.uid === stimB.uid && s[0]?.uid === nadeB.uid && (await bagCount()) === bagBeforeSwap,
    'cell → cell drag swaps the two slots without touching the bag', JSON.stringify(s));
  // drag cell 4 tile out onto the backdrop → the slot empties and the stack goes back into the bag (never the world)
  const droppedBefore = (await ev('inventory:itemDropped')).length;
  const stimUnitsBefore = await bagUnits(HERB);
  const stimBQty = (await slots())[4].qty;
  const c1tile = await centre('.inv-quick-cell[data-index="4"] .inv-tile');
  await dragMouse(c1tile, { x: 40, y: 40 });
  s = await slots();
  const stimUnitsAfter = await bagUnits(HERB);
  ok(s[4] === null && stimUnitsAfter === stimUnitsBefore + stimBQty && (await ev('inventory:itemDropped')).length === droppedBefore,
    'cell dragged to the backdrop empties the slot and returns the stim to the bag',
    JSON.stringify({ s4: s[4], stimUnitsBefore, stimUnitsAfter, stimBQty }));
  // drag a non-usable item (ammo) onto cell 0 → red target, refused (the 수류탄 keeps the slot)
  const [ammoB] = await bagDef('ammo_light');
  await dragMouse(await centre(`.inv-grid-bag .inv-tile[data-uid="${ammoB.uid}"]`), cell0);
  s = await slots();
  ok(s[0]?.uid === nadeB.uid && (await bagDef('ammo_light')).some((x) => x.uid === ammoB.uid), 'ammo onto a cell refused', JSON.stringify(s));
  // the stack that came back off the wheel (no same-def stack in the grid to merge with, so it kept its uid)
  const [stimC] = await bagDef(HERB);
  ok(!!stimC && stimC.uid === stimB.uid && stimC.qty === stimUnitsAfter, 'the 약초 붕대 waits in the bag', JSON.stringify(stimC));
  // right-click a stim in the bag → menu has 빠른 슬롯에 등록; click it → first free usable slot (S, cell 0 is taken)
  const stimTile2 = await centre(`.inv-grid-bag .inv-tile[data-uid="${stimC.uid}"]`);
  await page.mouse.click(stimTile2.x, stimTile2.y, { button: 'right' });
  await sleep(150);
  let items = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent));
  ok(items.some((t) => t.includes('빠른 슬롯에 등록')), 'bag stim context menu offers 빠른 슬롯에 등록', JSON.stringify(items));
  await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((b) => b.textContent.includes('빠른 슬롯에 등록')).click());
  await sleep(150);
  s = await slots();
  ok(s[4]?.uid === stimC.uid && !(await hasBagTile(stimC.uid)),
    '빠른 슬롯에 등록 → first free usable slot (S) and the stack leaves the grid', JSON.stringify(s));
  // right-click the cell → 빠른 슬롯 해제
  const c0tile2 = await centre('.inv-quick-cell[data-index="4"] .inv-tile');
  await page.mouse.click(c0tile2.x, c0tile2.y, { button: 'right' });
  await sleep(150);
  items = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent));
  ok(items[0]?.includes('빠른 슬롯 해제'), 'cell context menu: 빠른 슬롯 해제', JSON.stringify(items));
  await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((b) => b.textContent.includes('빠른 슬롯 해제')).click());
  await sleep(150);
  s = await slots();
  ok(s[4] === null && (await bagUnits(HERB)) === stimC.qty,
    '해제 empties the cell and puts the stack back in the bag', JSON.stringify({ s4: s[4], bag: await bagDef(HERB) }));
  // 2026-09-09: a bag tile can never read "already registered" — registering moves the stack out of the grid, so the
  // grid menu only ever offers 등록 (해제 lives on the wheel cell, checked above)
  const [stimD] = await bagDef(HERB);
  const stimTile3 = await centre(`.inv-grid-bag .inv-tile[data-uid="${stimD.uid}"]`);
  await page.mouse.click(stimTile3.x, stimTile3.y, { button: 'right' });
  await sleep(150);
  items = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent));
  ok(items.some((t) => t.includes('빠른 슬롯에 등록')) && !items.some((t) => t.includes('빠른 슬롯 해제')),
    'a bag stim only ever offers 등록 — a registered stack has no bag tile', JSON.stringify(items));
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
