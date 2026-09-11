// Single-player smoke test for the quick-use wheel slots (inventory side of Phase 2).
// Usage: node scripts/smoke-quickslots.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs, C-65)
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

  /* ── 2026-09-12: 같은 아이템 퀵슬롯 합치기 · 넘친 수량은 커서에 남는다 (real mouse) ─────────────────────────── */
  console.log('quick merge + held remainder');
  /** Park `bagQty` 약초 붕대 in one bag stack and `wheelQty` on wheel cell S (index 4) — placed directly, so no auto-merge. */
  const setupMerge = (bagQty, wheelQty) => page.evaluate(([herb, bq, wq]) => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('inventory'), g = sys.getGrid('bag');
    for (const p of g.items()) if (p.item.defId === herb) g.remove(p.item.uid);
    sys.quickSlots[4] = null;
    const it = ctx.loot.createItem(herb, bq);
    const slot = g.findFreeSlot(it, false);
    g.place(it, slot.x, slot.y, slot.rotated);
    sys.quickSlots[4] = ctx.loot.createItem(herb, wq);
    sys.afterChange();
    return { uid: it.uid, wheelUid: sys.quickSlots[4].uid, max: ctx.loot.getItemDef(herb).stackMax };
  }, [HERB, bagQty, wheelQty]);
  const herbUnits = () => page.evaluate((herb) => {
    const inv = window.__game.ctx.inventory;
    return [...inv.getAllItems(), ...inv.getQuickSlots()].filter((i) => i && i.defId === herb).reduce((a, i) => a + i.qty, 0);
  }, HERB);
  const dragState = () => page.evaluate(() => { const d = window.__game.getSystem('inventory').ui?.drag; return d ? { held: !!d.held, qty: d.qty, uid: d.uid, from: d.from.kind, ghost: !!document.querySelector('.inv-ghost') } : null; });
  const freeBagCell = () => page.evaluate(() => {
    const g = window.__game.getSystem('inventory').getGrid('bag');
    const r = document.querySelector('.inv-grid-bag').getBoundingClientRect();
    for (let y = g.rows - 1; y >= 0; y--) for (let x = g.cols - 1; x >= 0; x--) if (!g.cellUid(x, y)) return { x: r.left + x * 56 + 27, y: r.top + y * 56 + 27, cx: x, cy: y };
    return null;
  });
  const probe = await setupMerge(1, 1);
  if (probe.max < 3) {
    ok(true, `skip merge checks: ${HERB} stackMax ${probe.max} < 3`);
  } else {
    const M = probe.max;
    // ① bag 2 + wheel M−1 → wheel M, one unit stays on the cursor (the bag stack is simply smaller)
    const m1 = await setupMerge(2, M - 1);
    await sleep(150);
    const units1 = await herbUnits();
    await dragMouse(await centre(`.inv-grid-bag .inv-tile[data-uid="${m1.uid}"]`), await centre('.inv-quick-cell[data-index="4"]'));
    s = await slots();
    let held = await dragState();
    const srcQty = (await bagDef(HERB)).find((x) => x.uid === m1.uid)?.qty;
    ok(s[4]?.uid === m1.wheelUid && s[4]?.qty === M && srcQty === 1,
      `bag 2 onto a wheel stack of ${M - 1} merges to ${M} (not a swap) and 1 is left in the source stack`, JSON.stringify({ s4: s[4], srcQty }));
    ok(held && held.held && held.uid === m1.uid && held.ghost, 'the remainder stays on the cursor (held drag + ghost) after the release', JSON.stringify(held));
    // the next click on a free bag cell drops it there
    const cellA = await freeBagCell();
    await page.mouse.move(cellA.x, cellA.y, { steps: 4 });
    await sleep(60);
    await page.mouse.down(); await sleep(40); await page.mouse.up();
    await sleep(150);
    held = await dragState();
    const at = await page.evaluate((c) => { const p = window.__game.getSystem('inventory').getGrid('bag').at(c.cx, c.cy); return p ? { uid: p.item.uid, qty: p.item.qty } : null; }, cellA);
    ok(held === null && at?.uid === m1.uid && at.qty === 1 && (await herbUnits()) === units1,
      'the next click drops the held unit on the cell under the cursor — no unit created or lost', JSON.stringify({ held, at, units: await herbUnits(), units1 }));

    // ② the same merge, then Escape: the remainder just stays where it was and the window stays open
    const m2 = await setupMerge(2, M - 1);
    await sleep(150);
    await dragMouse(await centre(`.inv-grid-bag .inv-tile[data-uid="${m2.uid}"]`), await centre('.inv-quick-cell[data-index="4"]'));
    ok((await dragState())?.held === true, 'held again for the Escape check');
    await page.keyboard.press('Escape');
    await sleep(150);
    const esc = { held: await dragState(), open: await page.evaluate(() => window.__game.ctx.inventory.isOpen), src: (await bagDef(HERB)).find((x) => x.uid === m2.uid)?.qty, ghost: await page.evaluate(() => !!document.querySelector('.inv-ghost')) };
    ok(esc.held === null && esc.open && esc.src === 1 && !esc.ghost, 'Escape lets go of the held remainder (it stays in its stack) without closing the window', JSON.stringify(esc));

    // ③ reverse: wheel 3 onto a bag stack of M−1 → bag M, the wheel keeps 2 and they ride the cursor; a click on the
    //    backdrop lets go (the wheel slot is **not** cleared, unlike a plain wheel drag onto nothing)
    const m3 = await page.evaluate(([herb, M]) => {
      const ctx = window.__game.ctx, sys = window.__game.getSystem('inventory'), g = sys.getGrid('bag');
      for (const p of g.items()) if (p.item.defId === herb) g.remove(p.item.uid);
      const it = ctx.loot.createItem(herb, M - 1);
      const slot = g.findFreeSlot(it, false);
      g.place(it, slot.x, slot.y, slot.rotated);
      sys.quickSlots[4] = ctx.loot.createItem(herb, 3);
      sys.afterChange();
      return { uid: it.uid, wheelUid: sys.quickSlots[4].uid };
    }, [HERB, M]);
    await sleep(150);
    await dragMouse(await centre('.inv-quick-cell[data-index="4"] .inv-tile'), await centre(`.inv-grid-bag .inv-tile[data-uid="${m3.uid}"]`));
    s = await slots();
    held = await dragState();
    const bagStack = (await bagDef(HERB)).find((x) => x.uid === m3.uid)?.qty;
    ok(bagStack === M && s[4]?.uid === m3.wheelUid && s[4]?.qty === 2 && held?.held && held.from === 'quick',
      `wheel 3 onto a bag stack of ${M - 1} merges to ${M}; the wheel keeps 2 on the cursor`, JSON.stringify({ bagStack, s4: s[4], held }));
    await page.mouse.move(40, 40, { steps: 4 });
    await page.mouse.down(); await sleep(40); await page.mouse.up();
    await sleep(150);
    s = await slots();
    ok((await dragState()) === null && s[4]?.qty === 2, 'a click on nothing lets go — the 2 stay on the wheel', JSON.stringify(s[4]));
  }

  await page.evaluate(() => window.__game.ctx.inventory.closeAll());
  await sleep(250);
  ok(!(await page.evaluate(() => window.__game.ctx.inventory.isOpen)), 'bag closed');

  /* ── 2026-09-11 C 배치 (inventory · items) ─────────────────────────────────────────────────────────── */
  console.log('C-5 · C-36 · C-16 · C-12');
  // C-5: 전설 전술 가방은 퀵슬롯 8 (휠은 8방향 — 9 는 로더가 `max: QUICK_SLOTS` 로 거절한다)
  ok(await page.evaluate(() => window.__game.ctx.loot.getItemDef('bag_legendary_tac')?.bag?.quickSlots === 8), 'bag_legendary_tac defines 8 quick slots (C-5)');
  // C-36: 가방 내구도 — 새 가방은 가득, 레이드당 한 번만 닳고, 0 이어도 격자 · 퀵슬롯은 그대로, 수리비는 재료
  const wear = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, loot = ctx.loot;
    const def = loot.getItemDef('bag_rare');
    const b = loot.createItem('bag_rare');
    inv.tryAddItem(b); inv.equip(b.uid, 'bag');
    const fresh = b.durability;
    const changed = [];
    const off = ctx.bus.on('durability:changed', (e) => changed.push(e.durability));
    let broken = 0;
    const offB = ctx.bus.on('durability:broken', () => broken++);
    inv.bagWornThisRaid = false;
    const first = inv.wearBagForRaid();
    const afterFirst = b.durability;
    const second = inv.wearBagForRaid();
    // 레이드 중 교체해도 한 번 — 다른 가방으로 바꿔 한 번 더 불러도 깎이지 않는다
    const b2 = loot.createItem('bag_common');
    inv.tryAddItem(b2); inv.equip(b2.uid, 'bag');
    const swapped = inv.wearBagForRaid();
    const b2dur = b2.durability;
    // 0 까지 깎아도 격자 크기 · 퀵슬롯 수는 def 그대로 (효과 없음), 수리비는 재료
    inv.equip(b.uid, 'bag');
    b.durability = 0;
    const size = inv.getBagSize();
    const repair = loot.getRepairCost(b);
    const info = inv.repairInfo(b.uid);
    b.durability = afterFirst;
    off(); offB();
    return { max: def.durabilityMax, fresh, first, afterFirst, second, swapped, b2dur, b2max: loot.getItemDef('bag_common').durabilityMax,
      size, defCols: def.bag.cols, defRows: def.bag.rows, defQuick: def.bag.quickSlots, repair, info: info ? info.cost.length : null, changed, broken };
  });
  ok(wear.max > 0 && wear.fresh === wear.max, `new bag starts at full durability ${wear.fresh} / ${wear.max} (C-36)`, JSON.stringify(wear));
  ok(wear.first === true && wear.afterFirst < wear.fresh && wear.second === false && wear.swapped === false && wear.b2dur === wear.b2max,
    `bag wears once per raid (${wear.fresh} → ${wear.afterFirst}); a second call or a swapped bag is not charged again`, JSON.stringify(wear));
  ok(wear.changed.length === 1 && wear.broken === 0, 'wear emits durability:changed once and never durability:broken (0 = no effect)', JSON.stringify(wear));
  ok(wear.size.cols === wear.defCols && wear.size.rows === wear.defRows && wear.size.quickSlots === wear.defQuick,
    'a bag at 0 durability keeps its grid and quick slots', JSON.stringify(wear.size));
  ok(wear.repair.length > 0 && wear.info > 0, `a worn bag's repair costs materials, never free (${JSON.stringify(wear.repair)})`, JSON.stringify(wear));

  // C-16: 이미 떠 있는 같은 컨테이너를 다시 열면 아무 일도 없다 (재표시 · 이벤트 없음)
  const reopen = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const pos = ctx.player.position.clone();
    const opened = [], shown = [];
    const offA = ctx.bus.on('inventory:containerOpened', (e) => opened.push(e));
    const offB = ctx.bus.on('inventory:opened', (e) => shown.push(e.containerId));
    inv.openContainerItems('crate:c16', [ctx.loot.createItem('mat_scrap', 2)], pos, '컨테이너');
    ctx.bus.emit('crate:open', { crateId: 'crate:c16', tier: 1, position: pos });   // structure containers do exactly this
    inv.openContainerItems('crate:c16', [], pos);
    const whileOpen = { opened: opened.length, shown: shown.length };
    inv.closeAll();
    ctx.bus.emit('crate:open', { crateId: 'crate:c16', tier: 1, position: pos });
    const reopened = { opened: opened.length, first: opened[opened.length - 1]?.first ?? null, shown: shown.length };
    inv.closeAll();
    offA(); offB();
    return { whileOpen, reopened };
  });
  ok(reopen.whileOpen.opened === 1 && reopen.whileOpen.shown === 1, 'C-16: re-opening the container already on screen is ignored (1 containerOpened, 1 inventory:opened)', JSON.stringify(reopen));
  ok(reopen.reopened.opened === 2 && reopen.reopened.first === false && reopen.reopened.shown === 2, 'C-16: after closing, the same id opens again with first: false', JSON.stringify(reopen));

  // C-12: 시체 격자는 모자라면 행을 늘려 전부 담는다 (예전에는 넘치는 것이 사라졌다)
  const overflow = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const items = Array.from({ length: 96 }, () => ctx.loot.createItem('imp_broken_strength_1'));
    inv.openContainerItemsSized('pcorpse:c12:overflow', items, ctx.player.position.clone(), 10, 8, '유해');
    const g = inv.getActiveContainer()?.grid;
    const r = { placed: g?.count ?? -1, cols: g?.cols ?? -1, rows: g?.rows ?? -1 };
    inv.closeAll();
    return r;
  });
  ok(overflow.placed === 96 && overflow.cols === 10 && overflow.rows >= 10, `C-12: an overfull corpse grows rows instead of dropping items (${overflow.placed} in ${overflow.cols}×${overflow.rows})`, JSON.stringify(overflow));

  // C-12 + C-36: 사망 — 장착 가방이 먼저 닳고, 임플란트의 망가진 짝이 시체 목록에 합쳐진다. progression 쪽 구현이
  // 아직 없어도 동작해야 하므로 여기서는 `stripImplantsForCorpse` 를 잠시 대신 세운다 (구현 자체는 progression 스모크 몫).
  const strip = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, prog = ctx.progression;
    const bag = inv.getLoadout().bag;
    const before = bag?.durability ?? null;
    inv.bagWornThisRaid = false;
    const hadOwn = !!prog && Object.prototype.hasOwnProperty.call(prog, 'stripImplantsForCorpse');
    const orig = prog?.stripImplantsForCorpse;
    let calls = 0;
    if (prog) prog.stripImplantsForCorpse = () => { calls++; return [ctx.loot.createItem('imp_broken_strength_1')]; };
    let out = [];
    try { out = inv.stripForCorpse(); } finally {
      if (prog) { if (hadOwn) prog.stripImplantsForCorpse = orig; else delete prog.stripImplantsForCorpse; }
    }
    const bagOut = out.find((i) => bag && i.uid === bag.uid);
    return { before, after: bagOut?.durability ?? null, calls, twins: out.filter((i) => i.defId === 'imp_broken_strength_1').length,
      total: out.length, emptied: !inv.getLoadout().bag && inv.getAllItems().length === 0 && inv.getQuickSlots().every((x) => x === null),
      worn: inv.bagWornThisRaid };
  });
  ok(strip.calls === 1 && strip.twins === 1 && strip.emptied, `C-12: stripForCorpse merges progression's broken implant twins (${strip.total} items) and empties the kit`, JSON.stringify(strip));
  ok(strip.before !== null && strip.after !== null && strip.after < strip.before && strip.worn === true, `C-36: death wears the equipped bag before it goes on the corpse (${strip.before} → ${strip.after})`, JSON.stringify(strip));

  /* ── 2026-09-11 C-60 · C-61 (inventory) ────────────────────────────────────────────────────────────── */
  console.log('C-60 · C-61');
  // C-60: 행이 늘어난 시체 창은 패널 안에서 세로로 스크롤한다. 보통 상자는 모양이 그대로다.
  const c60plain = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    inv.openContainerItems('crate:c60:plain', [ctx.loot.createItem('mat_scrap', 2)], ctx.player.position.clone(), '상자');
    return true;
  });
  await sleep(300);
  const plain = await page.evaluate(() => {
    const s = document.querySelector('.inv-cont-scroll'), g = document.querySelector('.inv-grid-container');
    const sr = s.getBoundingClientRect(), gr = g.getBoundingClientRect();
    const r = { overflow: s.scrollHeight > s.clientHeight + 1, gutter: s.classList.contains('is-scroll'), sw: sr.width, sh: sr.height, gw: gr.width, gh: gr.height };
    window.__game.ctx.inventory.closeAll();
    return r;
  });
  ok(c60plain && !plain.overflow && !plain.gutter && Math.abs(plain.sw - plain.gw) < 0.5 && Math.abs(plain.sh - plain.gh) < 0.5,
    'C-60: a plain crate does not scroll — its viewport is exactly the grid box', JSON.stringify(plain));
  const c60 = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    for (const it of [...inv.getAllItems()]) inv.takeItem(it.uid, it.qty);
    const a = ctx.loot.createItem('mat_alloy', 1); inv.tryAddItem(a);
    const items = Array.from({ length: 96 }, () => ctx.loot.createItem('imp_broken_strength_1'));
    inv.openContainerItemsSized('pcorpse:c60:tall', items, ctx.player.position.clone(), 10, 8, '유해');
    const g = inv.getActiveContainer()?.grid;
    return { a: a.uid, cols: g?.cols ?? 0, rows: g?.rows ?? 0 };
  });
  await sleep(400);
  const scroller = () => page.evaluate(() => {
    const s = document.querySelector('.inv-cont-scroll'), g = document.querySelector('.inv-grid-container');
    const r = s.getBoundingClientRect(), gr = g.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, st: s.scrollTop, max: s.scrollHeight - s.clientHeight,
      gutter: s.classList.contains('is-scroll'), gridRight: gr.right, visRight: r.left + s.clientLeft + s.clientWidth, vh: window.innerHeight };
  });
  const sc0 = await scroller();
  ok(c60.rows >= 10 && sc0.max > 0 && sc0.gutter && sc0.bottom <= sc0.vh && sc0.gridRight <= sc0.visRight + 0.5,
    `C-60: a ${c60.cols}×${c60.rows} corpse scrolls inside the panel (max scroll ${sc0.max}px), stays on screen and no column is clipped`, JSON.stringify(sc0));
  const clip = await page.evaluate((sc) => {
    const v = window.__game.getSystem('inventory').ui.containerView, x = sc.left + 100;
    return { inside: v.hitTest(x, sc.bottom - 4, 0), hidden: v.hitTest(x, sc.bottom + 12, 0), hiddenPad: v.cellForGhost(x - 27, sc.bottom - 15, 1, 1, x, sc.bottom + 12) };
  }, sc0);
  ok(clip.inside === true && clip.hidden === false && clip.hiddenPad === null, 'C-60: rows scrolled out of view are not a drop target (hitTest clips to the viewport, no edge tolerance there)', JSON.stringify(clip));
  const aPos = await page.evaluate((uid) => { const e = document.querySelector(`.inv-grid-bag .inv-tile[data-uid="${uid}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, c60.a);
  if (!aPos || aPos[0] > 1275 || aPos[1] > 755) {
    console.log(`  skip C-60 drag checks — the bag tile is off screen (${JSON.stringify(aPos)})`);
  } else {
    const x = sc0.left + 300;
    await page.mouse.move(aPos[0], aPos[1]);
    await page.mouse.down();
    await page.mouse.move(aPos[0] - 20, aPos[1] + 6, { steps: 4 });
    await page.mouse.move(x, sc0.bottom - 3, { steps: 10 });
    await sleep(700);
    const down = await scroller();
    await page.mouse.move(x, sc0.top - 20, { steps: 4 });
    await sleep(1000);
    const up = await scroller();
    ok(down.st > 0 && up.st === 0, `C-60: dragging to the bottom edge auto-scrolls down (${down.st}px), above the top edge back up (${up.st}px)`, JSON.stringify({ down: down.st, up: up.st, max: down.max }));
    await page.mouse.move(x, sc0.bottom + 10, { steps: 4 });
    await sleep(1000);
    const bottom = await scroller();
    const cell = await page.evaluate(() => { const g = document.querySelector('.inv-grid-container').getBoundingClientRect(); return [g.left + 8 * 56 + 27, g.top + 9 * 56 + 27]; });
    await page.mouse.move(cell[0], cell[1], { steps: 8 });
    await sleep(120);
    await page.mouse.up();
    await sleep(250);
    const landed = await page.evaluate((uid) => { const p = window.__game.ctx.inventory.getActiveContainer()?.grid.items().find((q) => q.item.uid === uid); return p ? [p.x, p.y] : null; }, c60.a);
    ok(bottom.st === bottom.max && landed && landed[0] === 8 && landed[1] === 9,
      `C-60: after scrolling to the bottom, bag → corpse lands on the cell under the pointer (${JSON.stringify(landed)})`, JSON.stringify({ st: bottom.st, max: bottom.max, landed }));
    await page.mouse.move(cell[0] - 200, cell[1] - 150, { steps: 3 });
    await sleep(100);
    await page.mouse.move(cell[0], cell[1], { steps: 3 });
    await sleep(300);
    const tip = await page.evaluate(([px, py]) => { const t = document.querySelector('.inv-tooltip'); const r = t.getBoundingClientRect(); return { shown: !t.hidden && r.width > 0, near: Math.abs(r.left - px) < 400 && Math.abs(r.top - py) < 400 && r.bottom <= window.innerHeight + 1 }; }, cell);
    ok(tip.shown && tip.near, 'C-60: the tooltip of a scrolled container tile opens at the pointer', JSON.stringify(tip));
  }
  await page.evaluate(() => window.__game.ctx.inventory.closeAll());

  // C-61: 가방 레이드 1회 소모 표시가 레이드 세션 상태에 실린다 (시드 도장). 순서: world:ready → applyRaidState 가 실제 순서이고,
  // 반대 순서(blob 이 먼저)도 같은 레이드의 복귀(`rejoinPending`)면 표시가 산다. 옛 blob · 다른 시드 blob 은 false.
  const c61 = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const saved = { seed: inv.missionSeed, pending: ctx.rejoinPending };
    const S = 770061;
    const b = ctx.loot.createItem('bag_rare'); inv.tryAddItem(b); inv.equip(b.uid, 'bag');
    const bag = () => inv.getLoadout().bag;
    const r = {};
    try {
      inv.missionSeed = S; inv.bagWornThisRaid = false; inv.bagWornRestoreSeed = null;
      r.unwornKey = 'bagWorn' in inv.captureRaidState();
      inv.wearBagForRaid();
      const d1 = bag().durability;
      const state = inv.captureRaidState();
      r.stamp = state.bagWorn;
      r.sameTab = inv.wearBagForRaid();
      // reload → rejoin, the real order: world:ready (flag down) → game/ applies the blob
      inv.bagWornThisRaid = false; inv.bagWornRestoreSeed = null; ctx.rejoinPending = true;
      inv.onWorldReady(S);
      r.afterReady = inv.bagWornThisRaid;
      r.applied = inv.applyRaidState(state);
      r.restored = inv.bagWornThisRaid;
      r.rewear = inv.wearBagForRaid();
      r.durKept = bag()?.durability === d1;
      // the reverse order: blob first (missionSeed still the old raid's), then world:ready of this raid
      inv.bagWornThisRaid = false; inv.bagWornRestoreSeed = null; inv.missionSeed = S - 1;
      inv.applyRaidState(state);
      r.earlyApply = inv.bagWornThisRaid;
      inv.onWorldReady(S);
      r.reverse = inv.bagWornThisRaid;
      // a new raid on the same seed (no rejoin) starts unworn
      ctx.rejoinPending = false;
      inv.onWorldReady(S);
      r.newRaid = inv.bagWornThisRaid;
      // an old blob (no field) and another raid's stamp → false
      const old = { ...state }; delete old.bagWorn;
      inv.bagWornThisRaid = true; inv.applyRaidState(old); r.oldBlob = inv.bagWornThisRaid;
      inv.applyRaidState({ ...state, bagWorn: S + 5 }); r.otherSeed = inv.bagWornThisRaid;
    } finally {
      inv.missionSeed = saved.seed; ctx.rejoinPending = saved.pending;
      inv.bagWornThisRaid = false; inv.bagWornRestoreSeed = null;
      inv.loadoutStore?.clearRaid?.();
      inv.closeAll();
    }
    return r;
  });
  ok(c61.unwornKey === false && c61.stamp === 770061 && c61.sameTab === false, 'C-61: captureRaidState stamps bagWorn = this raid\'s seed only once worn; a second wear in the same tab is refused', JSON.stringify(c61));
  ok(c61.afterReady === false && c61.applied === true && c61.restored === true && c61.rewear === false && c61.durKept === true,
    'C-61: reload → rejoin (world:ready, then the blob) restores the mark — extracting with the recovered bag does not wear it again', JSON.stringify(c61));
  ok(c61.earlyApply === false && c61.reverse === true && c61.newRaid === false, 'C-61: blob before world:ready keeps the mark for the rejoin; a fresh raid on the same seed starts unworn', JSON.stringify(c61));
  ok(c61.oldBlob === false && c61.otherSeed === false, 'C-61: an old blob (no bagWorn) or another raid\'s stamp restores false', JSON.stringify(c61));
} catch (e) {
  fail++;
  console.log('  FAIL exception', e && e.stack || e);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors`);
for (const e of errors.slice(0, 10)) console.log('  console:', e.slice(0, 300));
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
