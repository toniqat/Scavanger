// Smoke test for the Phase 6 inventory work: 무한 상자 catalog (tabs / search / real-mouse drag into the bag /
// double-click), stash size (housing 창고: setStashSize + reload persistence, shrink refusal), bag + stash materials
// (countDefAll / consumeDefAll), loadout presets (captureLoadout / applyLoadout with a missing def), and the 작업실
// bench craft panel (openBenchCraft: title, locked rows, discount, repair list).
// Phase 12 (2026-09-08): the 분해 게이지 (bar under the button grows per frame, `inventory:disassembleProgress` ≤ 30 Hz →
// one done:true, {t:0} on cancel), ship 수리 of a 회복 스프레이 (캔 1 + 소독약 1, a can at gauge 0 stays an item — tooltip
// `게이지 0 / 200`, broken tile bar, `scav.s1.loadout` round trip), 임플란트 tooltips (장착칸 · stat lines · perk · 망가짐 +
// repair chips), the catalog's 임플란트 tab and the grid ops progression relies on (tryAddToStash / takeItem …).
// 2026-09-10 (제작 대개편 2단계): 분해 산출이 **남은 내구도**를 탄다 (미리보기 · 실제 산출이 같은 레시피를 본다),
// 방탄복 수리가 재료를 실제로 소비한다 (예전에는 공짜였다), 수리 · 분해 팝업에 내구도 구간 표시,
// 정제 작업대(다섯 번째 작업대) + 제작 패널의 작업대 탭 · 94줄에서의 정렬 · 홀드 중 재배치 금지.
// Usage: node scripts/smoke-inventory-p6.mjs [http://localhost:5273/]   (needs `npm run dev`)
//
// Timing: Engine clamps dt to 50 ms and the frame rate depends on the machine, so every wait is on simulation time
// (`waitSim`), never wall-clock. Key taps dispatch keydown+keyup in the same frame on document.body.
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
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
    '--window-size=1680,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // fresh stash so the size checks start from the default grid
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  const install = () => page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    // fake pointer lock so gameplay input is accepted in headless mode
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['ui:catalogToggled', 'inventory:itemAdded', 'inventory:stashChanged', 'inventory:opened', 'inventory:closed', 'ui:craftToggled', 'loadout:changed', 'inventory:changed']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  await install();
  /** keydown + keyup inside one frame on document.body (a wait between them would read as a hold). */
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  // scrolls the element into view first (catalog tiles live in a scrolling grid)
  const centre = async (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const dragMouse = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await sleep(60);
    await page.mouse.up();
    await sleep(120);
  };
  const inv = () => page.evaluate(() => {
    const i = window.__game.ctx.inventory;
    return { open: i.isOpen, catalog: i.isCatalogOpen, blockers: [...window.__game.ctx.uiBlockers], bag: i.getAllItems().map((x) => ({ id: x.defId, qty: x.qty })) };
  });

  /* ── 1. hub: catalog (무한 상자) ───────────────────────────────────── */
  console.log('catalog (hub)');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  const defCount = await page.evaluate(() => window.__game.ctx.loot.getAllItemDefs().length);
  await page.evaluate(() => window.__game.ctx.inventory.openCatalog());
  await sleep(250);
  let s = await inv();
  ok(s.open && s.catalog && s.blockers.includes('inventory'), 'openCatalog opens the window with the catalog + inventory blocker', JSON.stringify(s));
  ok((await lastEv('ui:catalogToggled'))?.open === true, 'ui:catalogToggled {open:true}');
  const cat = await page.evaluate(() => {
    const root = document.querySelector('.inv-root');
    const panel = root.querySelector('.inv-panel-catalog');
    const items = [...panel.querySelectorAll('.inv-cat-item')];
    const first = panel.getBoundingClientRect(), stash = root.querySelector('.inv-panel-stash').getBoundingClientRect();
    return {
      hidden: panel.hidden, tiles: items.length, tabs: [...panel.querySelectorAll('.inv-cat-tab')].map((b) => b.textContent),
      onTab: panel.querySelector('.inv-cat-tab.is-on')?.textContent, search: !!panel.querySelector('.inv-cat-search'),
      leftOfStash: first.right <= stash.left + 4, hub: root.classList.contains('is-hub'),
      weaponGrades: items.filter((n) => n.dataset.def.startsWith('wpn_ar')).length,
      count: panel.querySelector('.inv-cat-count').textContent,
    };
  });
  ok(!cat.hidden && cat.tiles === defCount, `one tile per item def (${cat.tiles} / ${defCount})`, JSON.stringify(cat));
  ok(cat.tabs[0] === '전체' && cat.tabs.includes('무기') && cat.tabs.includes('탄약') && cat.tabs.includes('부착물') && cat.tabs.includes('가방') && cat.tabs.includes('방탄복') && cat.tabs.includes('가젯') && cat.tabs.includes('소모품') && cat.tabs.includes('재료') && cat.tabs.includes('약초'), `category tabs: ${cat.tabs.join(' ')}`);
  ok(cat.onTab === '전체' && cat.search, '전체 tab active, search box present');
  ok(cat.weaponGrades >= 5, `every weapon grade is its own tile (돌격소총 ×${cat.weaponGrades})`);
  ok(cat.hub && cat.leftOfStash, 'catalog sits left of the stash in the ship screen');

  // tabs: 무기 shows only primary defs (2026-09-10: 보조무기 카테고리 제거)
  await page.evaluate(() => [...document.querySelectorAll('.inv-cat-tab')].find((b) => b.textContent === '무기').click());
  const weaponTab = await page.evaluate(() => {
    const loot = window.__game.ctx.loot;
    const shown = [...document.querySelectorAll('.inv-panel-catalog .inv-cat-item')].map((n) => n.dataset.def);
    const expected = loot.getAllItemDefs().filter((d) => d.category === 'primary').length;
    return { n: shown.length, expected, allWeapons: shown.every((id) => loot.getItemDef(id).category === 'primary') };
  });
  ok(weaponTab.n === weaponTab.expected && weaponTab.n > 0 && weaponTab.allWeapons, `무기 tab lists ${weaponTab.n} weapon defs only`);
  // Phase 12: 임플란트 tab (label from the shared category table) lists exactly the implant defs — working + broken twins
  ok(cat.tabs.includes('임플란트'), `catalog has an 임플란트 tab (${cat.tabs.join(' ')})`);
  await page.evaluate(() => [...document.querySelectorAll('.inv-cat-tab')].find((b) => b.textContent === '임플란트')?.click());
  const implantTab = await page.evaluate(() => {
    const loot = window.__game.ctx.loot;
    const shown = [...document.querySelectorAll('.inv-panel-catalog .inv-cat-item')].map((n) => n.dataset.def);
    const expected = loot.getAllItemDefs().filter((d) => d.category === 'implant').length;
    return { n: shown.length, expected, all: shown.every((id) => loot.getItemDef(id).category === 'implant'), broken: shown.filter((id) => loot.getItemDef(id).implant?.broken).length, on: document.querySelector('.inv-cat-tab.is-on')?.textContent };
  });
  ok(implantTab.on === '임플란트' && implantTab.n === implantTab.expected && implantTab.n > 0 && implantTab.all && implantTab.broken > 0, `임플란트 tab lists ${implantTab.n} implant defs (${implantTab.broken} broken)`, JSON.stringify(implantTab));
  // search: Korean substring on the name
  await page.evaluate(() => [...document.querySelectorAll('.inv-cat-tab')].find((b) => b.textContent === '전체').click());
  await page.focus('.inv-cat-search');
  await page.keyboard.type('붕대');
  await sleep(120);
  const search = await page.evaluate(() => ({
    shown: [...document.querySelectorAll('.inv-panel-catalog .inv-cat-item')].map((n) => n.dataset.def),
    names: [...document.querySelectorAll('.inv-panel-catalog .inv-cat-cap')].map((n) => n.textContent),
    open: window.__game.ctx.inventory.isOpen, value: document.querySelector('.inv-cat-search').value,
  }));
  ok(search.shown.length >= 2 && search.names.every((n) => n.includes('붕대')), `search '붕대' → ${search.shown.join(', ')}`, JSON.stringify(search));
  ok(search.open && search.value === '붕대', 'typing in the search box never reached the game (window still open)');
  await page.evaluate(() => { const i = document.querySelector('.inv-cat-search'); i.value = ''; i.dispatchEvent(new Event('input')); i.blur(); });
  await sleep(80);
  ok((await page.evaluate(() => document.querySelectorAll('.inv-panel-catalog .inv-cat-item').length)) === defCount, 'clearing the search shows every def again');

  // real-mouse drag: 폐금속 tile → a free bag cell creates a full stack; the tile stays
  await page.evaluate(() => [...document.querySelectorAll('.inv-cat-tab')].find((b) => b.textContent === '재료').click());
  const before = await inv();
  const scrapTile = await centre('.inv-cat-item[data-def="mat_scrap"] .inv-tile');
  const freeCell = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    const g = inv.getGrid('bag');
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) if (!g.cellUid(x, y)) {
      const r = document.querySelector('.inv-grid-bag').getBoundingClientRect();
      return { x: r.left + x * 56 + 27, y: r.top + y * 56 + 27, cx: x, cy: y };
    }
    return null;
  });
  ok(!!scrapTile && !!freeCell, 'catalog tile + free bag cell located', JSON.stringify({ scrapTile, freeCell }));
  const addedBefore = (await ev('inventory:itemAdded')).length;
  await dragMouse(scrapTile, freeCell);
  const afterDrag = await inv();
  const scrapStack = await page.evaluate((c) => { const g = window.__game.getSystem('inventory').getGrid('bag'); const p = g.at(c.cx, c.cy); return p ? { id: p.item.defId, qty: p.item.qty, x: p.x, y: p.y } : null; }, freeCell);
  const stackMax = await page.evaluate(() => window.__game.ctx.loot.getItemDef('mat_scrap').stackMax);
  ok(scrapStack && scrapStack.id === 'mat_scrap' && scrapStack.qty === stackMax, `mouse drag created a full 폐금속 stack (${scrapStack?.qty}/${stackMax}) at the target cell`, JSON.stringify(scrapStack));
  ok(afterDrag.bag.length === before.bag.length + 1, 'bag gained one stack');
  ok((await ev('inventory:itemAdded')).length === addedBefore + 1, 'inventory:itemAdded emitted for the catalog item');
  ok(await page.evaluate(() => !!document.querySelector('.inv-cat-item[data-def="mat_scrap"] .inv-tile')), 'catalog tile stays after the drag (infinite stock)');
  // drag into the stash creates the item there
  const stashBefore = await page.evaluate(() => window.__game.getSystem('inventory').getStashItems().length);
  const alloyBefore = await page.evaluate(() => window.__game.getSystem('inventory').getStashItems().filter((i) => i.defId === 'mat_alloy').reduce((n, i) => n + i.qty, 0));
  const alloyTile = await centre('.inv-cat-item[data-def="mat_alloy"] .inv-tile');
  // 2026-09-07: the 기본 지급품 fills the first stash cells — aim at the first free one instead of (0,0)
  const stashCell = await page.evaluate(() => {
    const g = window.__game.getSystem('inventory').getStash();
    const r = document.querySelector('.inv-grid-stash').getBoundingClientRect();
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) if (!g.cellUid(x, y)) return { x: r.left + x * 56 + 27, y: r.top + y * 56 + 27 };
    return { x: r.left + 27, y: r.top + 27 };
  });
  await dragMouse(alloyTile, stashCell);
  const stashAfter = await page.evaluate(() => { const s = window.__game.getSystem('inventory').getStashItems(); return { n: s.length, alloy: s.filter((i) => i.defId === 'mat_alloy').reduce((n, i) => n + i.qty, 0) }; });
  // 2026-09-07: the 기본 지급품 already put 합금 판 in the 창고, so the drag merges into that stack instead of adding a tile
  ok(stashAfter.n === stashBefore + 1 && stashAfter.alloy > alloyBefore, `mouse drag into the stash created a 합금 판 stack (${alloyBefore} → ${stashAfter.alloy})`);
  // drag a weapon onto the 주무기 II slot equips a fresh instance
  await page.evaluate(() => [...document.querySelectorAll('.inv-cat-tab')].find((b) => b.textContent === '무기').click());
  const gunTile = await centre('.inv-cat-item[data-def="wpn_ar_g3"] .inv-tile');
  const slot2 = await centre('.inv-slot-primary2 .inv-slot-body');
  await dragMouse(gunTile, slot2);
  const p2 = await page.evaluate(() => { const l = window.__game.ctx.inventory.getLoadout(); return l.primary2 ? { id: l.primary2.defId, dur: l.primary2.durability, mag: l.primary2.ammoInMag } : null; });
  ok(p2 && p2.id === 'wpn_ar_g3' && p2.dur > 0 && p2.mag > 0, `drag onto 주무기 II equipped a loaded AR III (${JSON.stringify(p2)})`);
  // double-click → into the bag
  await page.evaluate(() => [...document.querySelectorAll('.inv-cat-tab')].find((b) => b.textContent === '소모품').click());
  const stimTile = await centre('.inv-cat-item[data-def="heal_bandage"] .inv-tile');
  const stimBefore = await page.evaluate(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'heal_bandage'));
  await page.mouse.click(stimTile.x, stimTile.y);
  await sleep(80);
  await page.mouse.click(stimTile.x, stimTile.y);
  await sleep(150);
  const stimAfter = await page.evaluate(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'heal_bandage'));
  ok(stimAfter > stimBefore, `double-click put 붕대 into the bag (${stimBefore} → ${stimAfter})`);
  // 2026-09-08: Tab closes the whole window incl. the catalog (Esc is the 일시정지 메뉴)
  await tap('Tab');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'window closed');
  s = await inv();
  ok(!s.open && !s.catalog && !s.blockers.includes('inventory'), 'Esc closes the window and the catalog, blocker released');
  ok((await lastEv('ui:catalogToggled'))?.open === false, 'ui:catalogToggled {open:false}');

  /* ── 2. stash size ────────────────────────────────────────────────── */
  console.log('stash size');
  const size0 = await page.evaluate(() => window.__game.ctx.inventory.getStashSize());
  ok(size0.cols === 10 && size0.rows === 24, `default stash 10×24 (${size0.cols}×${size0.rows})`);
  const stashEvBefore = (await ev('inventory:stashChanged')).length;
  const grow = await page.evaluate(() => { const i = window.__game.ctx.inventory; return { r: i.setStashSize(10, 30), size: i.getStashSize() }; });
  ok(grow.r === true && grow.size.rows === 30, 'setStashSize(10, 30) grows the stash');
  ok((await ev('inventory:stashChanged')).length > stashEvBefore, 'inventory:stashChanged emitted on resize');
  // an item parked in the last row blocks a shrink below it
  const shrink = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const g = sys.getStash();
    const it = ctx.loot.createItem('mat_scrap', 3);
    g.place(it, 0, 29, false);
    const refused = i.setStashSize(10, 24);
    const still = i.getStashSize().rows;
    g.remove(it.uid);
    const okShrink = i.setStashSize(10, 26);
    return { refused, still, okShrink, rows: i.getStashSize().rows, before: g.count };
  });
  ok(shrink.refused === false && shrink.still === 30, 'shrink refused while an item sits outside the new bounds');
  ok(shrink.okShrink === true && shrink.rows === 26, 'shrink accepted once the row is free (26)');
  await page.evaluate(() => window.__game.ctx.inventory.setStashSize(10, 30));
  // Tab screen renders the new grid and scrolls
  await tap('Tab');
  await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'Tab opens the ship screen');
  const grid = await page.evaluate(() => {
    const cells = document.querySelectorAll('.inv-grid-stash .inv-cell').length;
    const sc = document.querySelector('.inv-stash-scroll');
    return { cells, scrolls: sc.scrollHeight > sc.clientHeight, count: document.querySelector('.inv-panel-stash .inv-capacity').textContent };
  });
  ok(grid.cells === 300, `stash grid re-rendered at 10×30 (${grid.cells} cells)`);
  ok(grid.scrolls && /\/ 300/.test(grid.count), `stash panel scrolls and shows / 300 (${grid.count})`);
  await tap('Tab');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed');
  await sleep(600); // debounced save
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scav.s1.stash') ?? 'null'));
  ok(saved && saved.v === 2 && saved.cols === 10 && saved.rows === 30, `save file carries cols/rows (v${saved?.v} ${saved?.cols}×${saved?.rows})`);

  /* ── 3. materials across bag + stash ─────────────────────────────── */
  console.log('countDefAll / consumeDefAll');
  const mats = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    // clean slate for mat_cable: 4 in the bag, 7 in the stash
    i.consumeWhere((d) => d.id === 'mat_cable', 999);
    for (const p of sys.getStash().items().filter((p) => p.item.defId === 'mat_cable')) sys.getStash().remove(p.item.uid);
    i.tryAddItem(ctx.loot.createItem('mat_cable', 4));
    sys.getStash().autoPlace(ctx.loot.createItem('mat_cable', 7));
    const total = i.countDefAll('mat_cable');
    const short = i.consumeDefAll('mat_cable', 12);
    const afterShort = i.countDefAll('mat_cable');
    const okConsume = i.consumeDefAll('mat_cable', 9);
    const bagLeft = i.countWhere((d) => d.id === 'mat_cable');
    const stashLeft = sys.getStashItems().filter((x) => x.defId === 'mat_cable').reduce((n, x) => n + x.qty, 0);
    const zero = i.consumeDefAll('mat_cable', 0);
    return { total, short, afterShort, okConsume, bagLeft, stashLeft, zero, all: i.countDefAll('mat_cable') };
  });
  ok(mats.total === 11, `countDefAll sums bag + stash (${mats.total})`);
  ok(mats.short === false && mats.afterShort === 11, 'consumeDefAll refuses when short and consumes nothing');
  ok(mats.okConsume === true && mats.bagLeft === 0 && mats.stashLeft === 2 && mats.all === 2, `consumeDefAll(9): bag first (0 left), then stash (2 left)`, JSON.stringify(mats));
  ok(mats.zero === true, 'consumeDefAll(0) is a no-op success');

  /* ── 4. loadout presets ─────────────────────────────────────────── */
  console.log('captureLoadout / applyLoadout');
  const preset = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    // put an SMG and armor II in the stash, then capture the current kit
    sys.getStash().autoPlace(ctx.loot.createItem('wpn_smg'));
    const armorDef = ctx.loot.getAllItemDefs().find((d) => d.category === 'armor');
    if (armorDef) sys.getStash().autoPlace(ctx.loot.createItem(armorDef.id));
    const cap = i.captureLoadout();
    return { cap, armor: armorDef?.id ?? null, smg: !!ctx.loot.getItemDef('wpn_smg') };
  });
  // 2026-09-10: 보조무기가 사라져 starter 는 주무기 I 에 기관단총을 준다; AR III 는 위에서 주무기 II 로 끌어다 놓았다
  ok(preset.cap && preset.cap.primary === 'wpn_smg' && preset.cap.primary2 === 'wpn_ar_g3' && preset.cap.secondary === null && preset.cap.bag === 'bag_common', `captureLoadout reflects the current kit (${JSON.stringify(preset.cap)})`);
  const applied = await page.evaluate((p) => {
    const ctx = window.__game.ctx, i = ctx.inventory;
    const r = i.applyLoadout({ name: 't', primary: 'wpn_smg', primary2: 'wpn_does_not_exist', secondary: null, bag: null, armor: p.armor, implant: 'dash' });
    const l = i.getLoadout();
    const stashHasAr3 = window.__game.getSystem('inventory').getStashItems().some((x) => x.defId === 'wpn_ar_g3');
    const bagHasAr3 = i.getAllItems().some((x) => x.defId === 'wpn_ar_g3');
    return { r, primary: l.primary?.defId, primary2: l.primary2?.defId ?? null, secondary: l.secondary?.defId, armor: l.armor?.defId ?? null, implant: ctx.implants?.equipped, stashHasAr3, bagHasAr3, arSomewhere: i.getAllItems().some((x) => x.defId === 'wpn_ar') || window.__game.getSystem('inventory').getStashItems().some((x) => x.defId === 'wpn_ar') };
  }, preset);
  ok(applied.primary === 'wpn_smg', `preset equipped the stash SMG as 주무기 I (${applied.primary})`);
  ok(applied.primary2 === null && applied.r.missing.includes('wpn_does_not_exist'), `missing def empties 주무기 II and is reported (${JSON.stringify(applied.r.missing)})`);
  ok(applied.secondary === undefined, '보조무기 칸은 더 이상 채워지지 않는다 (2026-09-10)');
  ok(!preset.armor || applied.armor === preset.armor, `armor equipped from the stash (${applied.armor})`);
  ok(applied.implant === 'dash', `implant applied through ctx.implants (${applied.implant})`);
  ok(applied.arSomewhere && (applied.bagHasAr3 || applied.stashHasAr3), 'displaced weapons landed in the bag / stash');
  ok(applied.r.equipped >= 3, `applyLoadout equipped ${applied.r.equipped}`);
  const onMission = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const was = ctx.phase; ctx.phase = 'playing';
    const r = ctx.inventory.applyLoadout({ name: 't', primary: 'wpn_ar', primary2: null, secondary: null, bag: null, armor: null, implant: null });
    const p = ctx.inventory.getLoadout().primary?.defId;
    ctx.phase = was;
    return { r, p };
  });
  ok(onMission.r.equipped === 0 && onMission.r.missing.length === 0 && onMission.p === 'wpn_smg', 'applyLoadout is a no-op outside the hub');

  /* ── 5. bench crafting ───────────────────────────────────────────── */
  console.log('openBenchCraft');
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.inventory.updateItem(ctx.inventory.getLoadout().primary.uid, { durability: 50 });
    // skill-gated recipes stay hidden (locked or not): max the crafting skill so the level-3 rows can show as locked
    const p = ctx.progression;
    if (p && typeof p.addSkillXpRaw === 'function') p.addSkillXpRaw('crafting', 1e6);
  });
  await page.evaluate(() => window.__game.ctx.inventory.openBenchCraft('gun', 2));
  await sleep(250);
  const bench = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory;
    const panel = document.querySelector('.inv-panel-craft');
    const rows = [...panel.querySelectorAll('.inv-craft-row')].map((r) => ({ id: r.dataset.recipe, locked: r.classList.contains('is-bench-locked') }));
    const all = ctx.loot.getAllRecipes();
    // Phase 8: 분해 (`break_*`) moved to the item right-click menu, so the bench panel no longer lists it
    const expectOpen = i.getRecipes('ship', 'gun', 2).filter((r) => !/^break_/.test(r.id)).map((r) => r.id);
    const skill = (id) => ctx.progression?.getSkill(id) ?? 0;
    const expectLocked = all.filter((r) => r.station === 'ship' && r.bench === 'gun' && (r.benchLevel ?? 1) > 2 && skill(r.skill) >= r.skillRequired).map((r) => r.id);
    return {
      open: i.isOpen, hidden: panel.hidden, blockers: [...ctx.uiBlockers], title: panel.querySelector('.inv-title').textContent,
      rows, expectOpen, expectLocked, lockTags: panel.querySelectorAll('.inv-craft-locktag').length,
      // 2026-09-08: 수리 목록은 패널 아래가 아니라 헤더의 `모두 수리` 가 여는 모달 팝업이다
      repairShown: !panel.querySelector('.inv-repair-open').hidden,
      timeChips: panel.querySelectorAll('.inv-craft-chip.is-time').length,
      hold: i.craftDuration(expectOpen[0] ?? 'make_wpn_ar'),
      anyGunRecipes: all.some((r) => r.bench === 'gun'),
    };
  });
  ok(bench.open && !bench.hidden && bench.blockers.includes('inventory'), 'openBenchCraft opens the window + craft panel with the inventory blocker');
  ok(bench.title === '총기 작업대 Lv.2', `title '${bench.title}'`);
  ok((await lastEv('ui:craftToggled'))?.open === true, 'ui:craftToggled {open:true}');
  const openIds = bench.rows.filter((r) => !r.locked).map((r) => r.id), lockedIds = bench.rows.filter((r) => r.locked).map((r) => r.id);
  ok(openIds.length === bench.expectOpen.length && bench.expectOpen.every((id) => openIds.includes(id)), `${openIds.length} craftable rows = getRecipes('ship','gun',2)`);
  ok(lockedIds.length === bench.expectLocked.length && bench.expectLocked.every((id) => lockedIds.includes(id)) && bench.lockTags === lockedIds.length, `${lockedIds.length} locked level-3 rows (${lockedIds.join(', ') || 'none defined yet'})`);
  ok(!openIds.some((id) => bench.expectLocked.includes(id)), 'no level-3 recipe is craftable at level 2');
  ok(bench.repairShown, '총기 작업대 헤더에 `모두 수리` 버튼이 있다 (하단 수리 목록은 사라졌다)');
  // 2026-09-08: 모든 레시피가 같은 1 초 홀드 — 시간 칩은 더 이상 그리지 않는다
  ok(bench.hold === 1 && bench.timeChips === 0, `제작 홀드는 레시피와 무관하게 1 s (${bench.hold} s, 시간 칩 ${bench.timeChips}개)`);
  // cost multiplier: stub a workshop discount and check the chips + consumption
  const discount = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory;
    const h = ctx.housing; const orig = h.getCraftCostMul;
    h.getCraftCostMul = () => 0.8;
    const r = ctx.loot.getAllRecipes().find((x) => x.inputs.some((in_) => in_.qty >= 5)) ?? ctx.loot.getAllRecipes()[0];
    const sys = window.__game.getSystem('inventory');
    const cost = sys.craftCost(r);
    const expect = r.inputs.map((in_) => Math.max(1, Math.ceil(in_.qty * 0.8)));
    window.__game.getSystem('inventory')['ui'].refreshCraft();
    const chip = document.querySelector('.inv-craft-discount');
    const out = { id: r.id, cost: cost.map((c) => c.qty), expect, chip: chip && !chip.hidden ? chip.textContent : null };
    h.getCraftCostMul = orig;
    return out;
  });
  ok(JSON.stringify(discount.cost) === JSON.stringify(discount.expect), `craft cost ×0.8 ceil (${discount.id}: ${discount.cost.join('/')})`);
  ok(discount.chip === '작업실 할인 −20 %', `discount chip '${discount.chip}'`);
  /* ── 5b. 수리 팝업 (2026-09-08) ───────────────────────────────── */
  // `모두 수리` → 모달 팝업: 닳은 것만 · 가로로 긴 줄(내구도 막대) · 아래에 합계 재료 · × 로 제외
  const dmg = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory;
    i.tryAddItem(ctx.loot.createItem('mat_scrap', 40));
    i.tryAddItem(ctx.loot.createItem('mat_alloy', 20));
    const l = i.getLoadout();
    if (l.primary2) i.updateItem(l.primary2.uid, { durability: 40 });
    document.querySelector('.inv-repair-open').click();
    return { p1: l.primary.uid, p2: l.primary2 ? l.primary2.uid : null };
  });
  void dmg;
  await sleep(220);
  const modal = await page.evaluate(() => {
    const open = !document.querySelector('.inv-modeless-repair').hidden;
    const rows = [...document.querySelectorAll('.inv-modeless-repair .inv-repair-row')].map((r) => ({
      uid: r.dataset.uid, slot: r.querySelector('.inv-repair-slot').textContent,
      dur: r.querySelector('.inv-repair-dur').textContent, bar: !!r.querySelector('.inv-repair-bar i'),
      x: !!r.querySelector('.inv-repair-drop'),
    }));
    const full = window.__game.getSystem('inventory').benchRepairRows().length;
    return {
      open, rows, full, scrim: !document.querySelector('.inv-rep-scrim').hidden,
      totals: document.querySelectorAll('.inv-rep-total-chips .item-chip').length,
      btn: document.querySelector('.inv-modeless-repair .inv-repair-all').textContent,
    };
  });
  ok(modal.open && modal.scrim, '`모두 수리` 가 모달 팝업을 연다 (뒤를 덮는 판 포함)');
  ok(modal.rows.length > 0 && modal.rows.length < modal.full && modal.rows.every((r) => r.bar && r.x),
    `닳은 장비만 줄로 뜬다 — 내구도 막대 + × (${modal.rows.length} / 보유 ${modal.full})`, JSON.stringify(modal.rows));
  ok(modal.totals > 0 && /\(\d+\)/.test(modal.btn), `아래에 합계 재료 ${modal.totals}종 · 버튼 "${modal.btn}"`);
  // 2026-09-10 (제작 대개편): 수리 재료 = 제작 재료 × 남은 내구도 구간의 배수 — 줄마다 그 구간이 보인다
  const repBucket = await page.evaluate(() => ({
    buckets: [...document.querySelectorAll('.inv-modeless-repair .inv-repair-bucket')].map((e) => e.textContent),
    hint: document.querySelector('.inv-modeless-repair .inv-rep-hint')?.textContent ?? '',
    rows: document.querySelectorAll('.inv-modeless-repair .inv-repair-row').length,
  }));
  ok(repBucket.buckets.length === repBucket.rows && repBucket.buckets.every((t) => /\d+~\d+ %/.test(t) && /제작 재료의 \d+ %/.test(t)),
    `수리 줄마다 내구도 구간 표시 (${repBucket.buckets.join(' / ')})`, JSON.stringify(repBucket));
  ok(/내구도가 낮을수록/.test(repBucket.hint), `수리 팝업이 "구간이 바뀌면 값이 바뀐다" 를 말한다 ("${repBucket.hint}")`);
  const excluded = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.inv-modeless-repair .inv-repair-row')];
    const before = document.querySelector('.inv-modeless-repair .inv-repair-all').textContent;
    rows[0].querySelector('.inv-repair-drop').click();
    const after = document.querySelector('.inv-modeless-repair .inv-repair-all').textContent;
    const marked = document.querySelector('.inv-modeless-repair .inv-repair-row').classList.contains('is-excluded');
    return { before, after, marked, uid: rows[0].dataset.uid };
  });
  ok(excluded.marked && excluded.before !== excluded.after,
    `× 가 그 줄을 제외한다 ("${excluded.before}" → "${excluded.after}")`);
  const ran = await page.evaluate((skipUid) => {
    const i = window.__game.ctx.inventory;
    document.querySelector('.inv-modeless-repair .inv-repair-all').click();
    const d = i.getDurability(skipUid);
    return { skipped: d ? d.durability / d.max : -1, msg: document.querySelector('.inv-modeless-repair .inv-repair-msg')?.textContent };
  }, excluded.uid);
  ok(ran.skipped < 1, `제외한 항목은 그대로 남는다 (${Math.round(ran.skipped * 100)} %, "${ran.msg}")`);
  const reopened = await page.evaluate(() => {
    const ui = window.__game.getSystem('inventory')['ui'];
    ui.repair.close();
    const closed = document.querySelector('.inv-modeless-repair').hidden && document.querySelector('.inv-rep-scrim').hidden;
    document.querySelector('.inv-repair-open').click();
    const excl = document.querySelectorAll('.inv-modeless-repair .inv-repair-row.is-excluded').length;
    ui.repair.close();
    return { closed, excl };
  });
  ok(reopened.closed && reopened.excl === 0, '닫으면 팝업 · 판 · 제외 표시가 모두 사라진다');
  // gear bench repairs armor + bags only, gadget bench has no 수리 button at all
  const gear = await page.evaluate(() => {
    const i = window.__game.ctx.inventory;
    i.openBenchCraft('gear', 1);
    window.__game.getSystem('inventory')['ui'].refreshCraft();
    const t1 = document.querySelector('.inv-panel-craft .inv-title').textContent;
    const rows = window.__game.getSystem('inventory').benchRepairRows().map((r) => r.def.name);
    const gearBtn = !document.querySelector('.inv-repair-open').hidden;
    i.openBenchCraft('gadget', 1);
    window.__game.getSystem('inventory')['ui'].refreshCraft();
    const t2 = document.querySelector('.inv-panel-craft .inv-title').textContent;
    return { t1, rows, t2, gearBtn, gadgetBtn: !document.querySelector('.inv-repair-open').hidden };
  });
  ok(gear.t1 === '장비 작업대 Lv.1' && gear.gearBtn && !gear.rows.some((n) => /AR|SMG|P-2/.test(n)), `gear bench repairs no weapons (${gear.rows.join(', ') || 'empty'})`);
  ok(gear.t2 === '가젯 작업대 Lv.1' && !gear.gadgetBtn, 'gadget bench has no 수리 button');

  /* ── 2026-09-10 (제작 대개편 2단계): 정제 작업대 · 작업대 탭 ─────────── */
  const refine = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    i.openBenchCraft('refine', 3);
    sys['ui'].refreshCraft();
    const title = document.querySelector('.inv-panel-craft .inv-title').textContent;
    const benchTabs = !!document.querySelector('.inv-craft-tabs') && !document.querySelector('.inv-craft-tabs').hidden;
    const refineRecipes = ctx.loot.getAllRecipes().filter((r) => r.bench === 'refine').map((r) => r.outputDefId);
    i.closeBench();
    // 함선에 작업대가 다 깔린 상태를 흉내내면 `제작` 패널 한 목록이 94 줄이 된다 → 탭이 뜬다
    const origBench = ctx.housing.getBenchLevel, origSkill = ctx.progression.getSkill;
    ctx.housing.getBenchLevel = () => 3;
    ctx.progression.getSkill = () => 99;
    sys['ui'].setCraftOpen(true);
    sys['ui'].craftPanel.refresh();
    const tabs = [...document.querySelectorAll('.inv-craft-tab')].map((b) => ({ id: b.dataset.tab, text: b.textContent, on: b.classList.contains('is-on') }));
    const rowsAll = document.querySelectorAll('.inv-craft-row').length;
    document.querySelector('.inv-craft-tab[data-tab="refine"]')?.click();
    const rowsRefine = [...document.querySelectorAll('.inv-craft-row')].map((r) => r.dataset.recipe);
    // 정렬 규약: 만들 수 있는 줄이 위로 (2026-09-10), 94 줄이 되어도 그대로
    document.querySelector('.inv-craft-tab[data-tab="all"]')?.click();
    const ready = [...document.querySelectorAll('.inv-craft-row')].map((r) => (r.classList.contains('is-locked') ? 0 : 1));
    // 홀드 중에는 줄을 옮기지 않는다 (누르는 버튼의 DOM 이 움직이면 pointerleave 로 제작이 취소된다)
    const first = [...document.querySelectorAll('.inv-craft-row:not(.is-locked)')][0]?.dataset.recipe ?? null;
    let orderKept = true;
    if (first) {
      const before = [...document.querySelectorAll('.inv-craft-row')].map((r) => r.dataset.recipe).join('|');
      void sys.craft(first);
      for (let n = 0; n < 5; n++) sys['ui'].refreshCraft();
      orderKept = [...document.querySelectorAll('.inv-craft-row')].map((r) => r.dataset.recipe).join('|') === before;
      sys.cancelCraft();
    }
    ctx.housing.getBenchLevel = origBench;
    ctx.progression.getSkill = origSkill;
    sys['ui'].setCraftOpen(false);
    return { title, benchTabs, refineRecipes, tabs, rowsAll, rowsRefine, ready, orderKept, holdRecipe: first };
  });
  ok(refine.title === '정제 작업대 Lv.3', `정제 작업대가 다섯 번째 작업대로 열린다 ('${refine.title}')`);
  ok(refine.refineRecipes.length === 7, `정제 레시피 7종 (${refine.refineRecipes.join(', ')})`);
  ok(!refine.benchTabs, '작업대를 열고 들어온 화면에는 탭이 없다 (이미 그 작업대 하나다)');
  ok(refine.tabs.length === 7 && refine.tabs[0].id === 'all' && refine.tabs.some((t) => t.id === 'refine' && /정제 작업대/.test(t.text)),
    `제작 패널 탭 ${refine.tabs.length}개 — 정제 작업대 포함 (${refine.tabs.map((t) => t.text).join(' · ')})`, JSON.stringify(refine.tabs));
  ok(refine.rowsAll > 80 && refine.rowsRefine.length === 7 && refine.rowsRefine.every((id) => /^refine_/.test(id)),
    `탭이 목록을 가른다 — 전체 ${refine.rowsAll}줄 → 정제 ${refine.rowsRefine.length}줄`, JSON.stringify(refine.rowsRefine));
  ok(refine.ready.length > 1 && /^1*0*$/.test(refine.ready.join('')),
    `만들 수 있는 줄이 위로 — 94줄에서도 성립 (준비 ${refine.ready.filter(Boolean).length} / ${refine.ready.length})`);
  ok(refine.orderKept, `홀드 중에는 줄이 움직이지 않는다 (${refine.holdRecipe})`);
  // 닫기 leaves bench mode, window stays; Tab (또는 Esc — 2026-09-09) closes the window
  await page.evaluate(() => document.querySelector('.inv-craft-close').click());
  await sleep(100);
  const closed = await page.evaluate(() => ({ bench: window.__game.getSystem('inventory').getBench(), panel: document.querySelector('.inv-panel-craft').hidden, open: window.__game.ctx.inventory.isOpen }));
  ok(closed.bench === null && closed.panel && closed.open, '닫기 leaves bench mode (panel hidden, window open)');
  ok((await lastEv('ui:craftToggled'))?.open === false, 'ui:craftToggled {open:false}');
  await tap('Tab');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed (bench)');
  // outside the hub the bench refuses
  const benchMission = await page.evaluate(() => { const ctx = window.__game.ctx; const was = ctx.phase; ctx.phase = 'playing'; ctx.inventory.openBenchCraft('gun', 1); const r = { open: ctx.inventory.isOpen, bench: window.__game.getSystem('inventory').getBench() }; ctx.phase = was; return r; });
  ok(!benchMission.open && benchMission.bench === null, 'openBenchCraft is refused outside the hub');

  /* ── 5b. Phase 12: 분해 게이지 ───────────────────────────────────── */
  console.log('분해 게이지');
  await page.evaluate(() => {
    window.__ev['inventory:disassembleProgress'] = [];
    window.__game.ctx.bus.on('inventory:disassembleProgress', (p) => window.__ev['inventory:disassembleProgress'].push({ ...p }));
  });
  await tap('Tab');
  await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'Tab opens the ship screen (분해)');
  const dis = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    i.consumeWhere((d) => d.id === 'ammo_light', 9999);
    i.consumeWhere((d) => d.id === 'mat_gunpowder', 9999);
    const ammo = ctx.loot.createItem('ammo_light', 60);
    i.tryAddItem(ammo);
    const opened = i.openDisassemble(ammo.uid);
    const panel = sys['ui'].disassemblePanel;
    const btn = document.querySelector('.inv-dis-btn');
    // 2026-09-08: the button *is* the gauge — no bar under it and no `1회 분해 · n s` hint line any more.
    const idle = panel.progress === 0 && (parseFloat(btn.querySelector('.inv-craft-fill').style.width) || 0) === 0;
    const stripped = !document.querySelector('.inv-dis-bar') && !document.querySelector('.inv-dis-hint');
    const isBtn = panel.barEl === btn;
    btn.click();
    return { opened, idle, stripped, isBtn, uid: ammo.uid, dur: sys.craftDuration('break_ammo_light'), running: !!sys.craftProgress(), label: btn.querySelector('span').textContent };
  });
  ok(dis.opened && dis.idle && dis.isBtn, 'openDisassemble: the 분해 button is the gauge and reads empty while idle', JSON.stringify(dis));
  ok(dis.stripped, 'no separate 분해 게이지 bar and no `1회 분해 · n s` hint line');
  ok(dis.running && dis.label === '분해 중…', `분해 button starts the hold (${dis.dur.toFixed(2)} s)`);
  const samples = [];
  for (let k = 0; k < 4; k++) {
    await waitSim(dis.dur * 0.15);
    samples.push(await page.evaluate(() => {
      const p = window.__game.getSystem('inventory')['ui'].disassemblePanel;
      const f = document.querySelector('.inv-dis-btn .inv-craft-fill');
      return { w: parseFloat(f.style.width) || 0, t: p.progress };
    }));
  }
  const widths = samples.map((s) => s.w);
  ok(widths.every((w, k) => k === 0 || w > widths[k - 1]) && widths[0] > 0 && widths[3] < 100, `button fill growing across the hold (${widths.map((w) => w.toFixed(1)).join(' → ')} %)`, JSON.stringify(samples));
  ok(samples.every((s) => Math.abs(s.w - s.t * 100) < 0.2), 'fill width = job progress', JSON.stringify(samples));
  await waitFor(page, () => window.__ev['inventory:disassembleProgress'].some((e) => e.done), 'disassembleProgress done', 60000);
  await sleep(120);
  const disEv = await page.evaluate((uid) => {
    const evs = window.__ev['inventory:disassembleProgress'];
    const i = window.__game.ctx.inventory, sys = window.__game.getSystem('inventory');
    const p = sys['ui'].disassemblePanel;
    const doneIdx = evs.findIndex((e) => e.done);
    const before = evs.slice(0, doneIdx);
    return {
      n: evs.length, doneCount: evs.filter((e) => e.done).length, doneLast: doneIdx === evs.length - 1, doneT: evs[doneIdx]?.t,
      sameUid: evs.every((e) => e.uid === uid), monotone: before.every((e, k) => k === 0 || e.t >= before[k - 1].t), maxT: Math.max(...before.map((e) => e.t)),
      rateOk: before.length <= Math.ceil(30 * 1.5) + 4,
      emptyAfter: (parseFloat(document.querySelector('.inv-dis-btn .inv-craft-fill').style.width) || 0) === 0, progressAfter: p.progress,
      ammo: i.countWhere((d) => d.id === 'ammo_light'), powder: i.countWhere((d) => d.id === 'mat_gunpowder'), msg: document.querySelector('.inv-dis-msg')?.textContent,
    };
  }, dis.uid);
  ok(disEv.doneCount === 1 && disEv.doneLast && disEv.doneT === 1 && disEv.sameUid, `inventory:disassembleProgress ends with exactly one {t:1, done:true} (${disEv.n} events)`, JSON.stringify(disEv));
  ok(disEv.n >= 3 && disEv.monotone && disEv.maxT > 0 && disEv.maxT < 1, `progress t rises monotonically before done (max ${disEv.maxT?.toFixed(2)})`);
  ok(disEv.rateOk, `emits throttled to ≤ 30 Hz (${disEv.n - 1} progress events for a ${dis.dur.toFixed(2)} s hold)`);
  ok(disEv.emptyAfter && disEv.progressAfter === 0 && disEv.ammo === 30 && disEv.powder === 4 && disEv.msg === '분해 완료', `gauge back to empty, 경량탄 60 → ${disEv.ammo}, 화약 ${disEv.powder} (${disEv.msg})`);
  // cancel: a second click during the hold resets the bar and reports {t:0, done:false}
  await page.evaluate(() => { window.__ev['inventory:disassembleProgress'].length = 0; document.querySelector('.inv-dis-btn').click(); });
  await waitSim(dis.dur * 0.3);
  const cancel = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory'); const p = sys['ui'].disassemblePanel;
    const w = () => parseFloat(document.querySelector('.inv-dis-btn .inv-craft-fill').style.width) || 0;
    const mid = { w: w(), t: p.progress, evs: window.__ev['inventory:disassembleProgress'].length };
    document.querySelector('.inv-dis-btn').click();
    const evs = window.__ev['inventory:disassembleProgress'];
    const last = evs[evs.length - 1];
    return { mid, w: w(), t: p.progress, job: sys.craftProgress(), last, anyDone: evs.some((e) => e.done), label: document.querySelector('.inv-dis-btn span').textContent, open: p.isOpen };
  });
  ok(cancel.mid.w > 0 && cancel.mid.t > 0 && cancel.mid.evs > 0, `second hold running (t ${cancel.mid.t.toFixed(2)})`, JSON.stringify(cancel.mid));
  ok(cancel.w === 0 && cancel.t === 0 && cancel.job === null && cancel.label === '분해' && cancel.open, 'clicking again cancels: fill emptied, job gone, dialog still open');
  ok(cancel.last && cancel.last.t === 0 && cancel.last.done === false && !cancel.anyDone, 'cancel reports {t:0, done:false} and never done', JSON.stringify(cancel.last));
  /* 넣을 자리를 먼저 본다 (2026-09-08; 2026-09-09 부터 함선에서는 **가방 → 창고**): no room refuses the 분해
     up front instead of after the hold. 함선 안이므로 가방만 채워서는 막히지 않는다 — 창고가 받는다. */
  const noRoom = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const p = sys['ui'].disassemblePanel;
    const btn = () => document.querySelector('.inv-dis-btn');
    const read = () => ({ room: i.craftHasRoom('break_ammo_light'), disabled: btn().disabled, label: btn().querySelector('span').textContent });
    const before = read();
    // the 화약 stack this run already made would absorb the output on its own — clear it, then fill every free cell
    i.consumeWhere((d) => d.id === 'mat_gunpowder', 9999);
    const junk = [];
    const stackMax = ctx.loot.getItemDef('mat_scrap')?.stackMax ?? 1;
    for (let k = 0; k < 400; k++) { const it = ctx.loot.createItem('mat_scrap', stackMax); if (!i.tryAddItem(it)) break; junk.push({ uid: it.uid, qty: stackMax }); }
    p.refresh();
    const bagOnly = read();                       // 2026-09-09: 가방만 꽉 차서는 아직 막히지 않는다
    // now close the stash too — that is the only state with nowhere left to put the output
    const stash = sys.getStash();
    const stashed = [];
    for (let k = 0; k < 4000; k++) { const it = ctx.loot.createItem('mat_scrap', stackMax); if (!stash.autoPlace(it)) break; stashed.push(it.uid); }
    sys.afterChange();
    p.refresh();
    const after = read();
    for (const uid of stashed) stash.remove(uid);
    sys.afterChange();
    for (const j of junk) i.consumeItem(j.uid, j.qty);
    p.refresh();
    return { before, bagOnly, after, restored: btn().disabled };
  });
  ok(noRoom.before.room && !noRoom.before.disabled, '분해 button enabled while there is room', JSON.stringify(noRoom.before));
  ok(noRoom.bagOnly.room && !noRoom.bagOnly.disabled,
    '함선에서는 가방만 꽉 차도 창고가 받으므로 분해가 계속 가능하다 (2026-09-09)', JSON.stringify(noRoom.bagOnly));
  ok(!noRoom.after.room && noRoom.after.disabled && noRoom.after.label === '가방과 함선 창고에 공간이 없습니다',
    'a full bag **and** stash disables the button up front with the reason on it', JSON.stringify(noRoom.after));
  ok(!noRoom.restored, 'and it comes back once the bag has room again');
  await page.evaluate(() => window.__game.getSystem('inventory')['ui'].disassemblePanel.close());

  /* ── 5b-2. 폐금속 공급 (2026-09-08): 고물 분해 ─────────────────────
   * 화약은 넘치는데 폐금속만 말라 탄약을 못 만들던 문제의 세 갈래 중 하나. 기계 부품은 `extraOutputs` 로 두
   * 재료를 한 번에 내고, 무기 / 방탄복 분해는 **클릭한 그 인스턴스**만 사라지며 부착물은 먼저 가방으로 돌아온다. */
  console.log('고물 분해');
  const partsSetup = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    for (const id of ['mat_scrap', 'mat_cable', 'mat_machine_parts']) i.consumeWhere((d) => d.id === id, 9999);
    const parts = ctx.loot.createItem('mat_machine_parts', 1);
    i.tryAddItem(parts);
    const opened = i.openDisassemble(parts.uid);
    const chips = document.querySelectorAll('.inv-dis-col:last-child .item-chip').length;
    void sys.craft('break_machine_parts', parts.uid);
    return { opened, chips, dur: sys.craftDuration('break_machine_parts'), uid: parts.uid };
  });
  ok(partsSetup.opened && partsSetup.chips === 2, `기계 부품 분해 dialog previews both products (${partsSetup.chips} chips)`);
  await waitSim(partsSetup.dur * 1.4);
  const partsOut = await page.evaluate((uid) => {
    const i = window.__game.ctx.inventory;
    return {
      scrap: i.countWhere((d) => d.id === 'mat_scrap'), cable: i.countWhere((d) => d.id === 'mat_cable'),
      parts: i.countWhere((d) => d.id === 'mat_machine_parts'), gone: !i.findItem(uid),
    };
  }, partsSetup.uid);
  ok(partsOut.scrap === 3 && partsOut.cable === 1 && partsOut.parts === 0 && partsOut.gone,
    `기계 부품 1 → 폐금속 ${partsOut.scrap} + 전력 케이블 ${partsOut.cable} (extraOutputs)`, JSON.stringify(partsOut));
  await page.evaluate(() => window.__game.getSystem('inventory')['ui'].disassemblePanel.close());

  // 무기 분해: 같은 돌격소총 두 정 중 클릭한 쪽만, 소켓의 부착물은 가방으로
  const gunSetup = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    for (const id of ['mat_scrap', 'wpn_dmr', 'att_brake']) i.consumeWhere((d) => d.id === id, 9999);
    // 2026-09-10: 권총(보조무기)이 사라져 지정사수소총 2정(4×1)으로 검사한다 — 시작 소지품을 건드리지 않고 가방에 들어간다
    const keep = ctx.loot.createItem('wpn_dmr', 1);
    const shred = ctx.loot.createItem('wpn_dmr', 1);
    const brake = ctx.loot.createItem('att_brake', 1);
    const placed = [i.tryAddItem(keep), i.tryAddItem(shred), i.tryAddItem(brake)].every(Boolean);
    const attached = i.attachToWeapon(shred.uid, brake.uid);
    const recipe = sys.disassembleRecipeFor(shred.uid);
    if (recipe) void sys.craft(recipe.id, shred.uid);
    return {
      placed, attached, recipeId: recipe?.id ?? null, out: recipe?.outputQty ?? 0,
      dur: recipe ? sys.craftDuration(recipe.id) : 0, keep: keep.uid, shred: shred.uid, brake: brake.uid,
    };
  });
  ok(gunSetup.placed, 'two 지정사수소총 + a 총구 제동기 fit in the bag');
  ok(gunSetup.recipeId === 'break_wpn_dmr' && gunSetup.out >= 1, `지정사수소총 I 의 분해 레시피는 폐금속 ${gunSetup.out} (${gunSetup.recipeId})`);
  await waitSim(gunSetup.dur * 1.4);
  const gunOut = await page.evaluate((s) => {
    const i = window.__game.ctx.inventory;
    return {
      scrap: i.countWhere((d) => d.id === 'mat_scrap'), guns: i.countWhere((d) => d.id === 'wpn_dmr'),
      keptSame: !!i.findItem(s.keep), shredGone: !i.findItem(s.shred), brakeBack: !!i.findItem(s.brake),
    };
  }, gunSetup);
  ok(gunOut.scrap === gunSetup.out && gunOut.guns === 1 && gunOut.keptSame && gunOut.shredGone,
    `무기 분해는 클릭한 그 한 정만 갈아 폐금속 ${gunOut.scrap} (남은 총 ${gunOut.guns})`, JSON.stringify(gunOut));
  ok(gunSetup.attached && gunOut.brakeBack, '소켓에 물려 있던 총구 제동기는 분해 전에 가방으로 돌아온다');

  // 방탄복 분해. 2026-09-10 (제작 대개편): 산출 = **제작 재료 × 남은 내구도 구간의 배수**(내림) 라서
  // 만피 방탄복 I(폐금속 10 + 천조각 6 + 구동 코어 2) 은 ×0.40 → 폐금속 4 + 천조각 2 다 (예전 상수 3 이 아니다).
  const armorOut = await page.evaluate(async () => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    i.consumeWhere((d) => d.id === 'mat_scrap', 9999);
    const plate = ctx.loot.createItem('armor_1', 1);
    i.tryAddItem(plate);
    const recipe = sys.disassembleRecipeFor(plate.uid);
    return {
      recipeId: recipe?.id ?? null, out: recipe?.outputQty ?? 0, station: recipe?.station ?? null,
      extras: (recipe?.extraOutputs ?? []).map((e) => `${e.defId}:${e.qty}`),
      craft: ctx.loot.getCraftCostOf('armor_1').map((c) => `${c.defId}:${c.qty}`),
    };
  });
  ok(armorOut.recipeId === 'break_armor_1' && armorOut.out === 4 && armorOut.station === 'field',
    `방탄복 I 도 현장에서 분해된다 → 폐금속 ${armorOut.out} (${armorOut.recipeId})`, JSON.stringify(armorOut));

  /* ── 2026-09-10: 분해 산출이 남은 내구도를 탄다 ────────────────────────
     예전에는 `getAllRecipes()` 의 정적 줄(구간 4 기준)을 그대로 썼기 때문에 5 % 남은 방탄복도 만피와 똑같이
     폐금속 4 + 천조각 2 를 뱉었다. 미리보기 · 자리 검사 · 실제 산출 셋이 같은 레시피를 봐야 한다. */
  const durSalvage = await page.evaluate(async () => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const mats = (d) => d.id === 'mat_scrap' || d.id === 'mat_cloth' || d.id === 'mat_core';
    const fmt = (r) => (r ? [`${r.outputDefId}:${r.outputQty}`, ...(r.extraOutputs ?? []).map((e) => `${e.defId}:${e.qty}`)].join('|') : 'null');
    const run = async (frac) => {
      i.consumeWhere(mats, 9999);
      const max = ctx.loot.getItemDef('armor_1').durabilityMax;
      const plate = ctx.loot.createItem('armor_1', 1, { durability: Math.max(1, Math.round(max * frac)) });
      i.tryAddItem(plate);
      const preview = sys.disassembleRecipeFor(plate.uid);
      const bucket = ctx.loot.durabilityBucketInfo(plate);
      await sys.craft(preview.id, plate.uid);
      return {
        preview: fmt(preview), bucket: bucket.label, mul: bucket.salvageMul, gone: !i.findItem(plate.uid),
        got: { scrap: i.countWhere((d) => d.id === 'mat_scrap'), cloth: i.countWhere((d) => d.id === 'mat_cloth'), core: i.countWhere((d) => d.id === 'mat_core') },
      };
    };
    const fresh = await run(1.0);
    const wrecked = await run(0.05);
    i.consumeWhere(mats, 9999);
    return { fresh, wrecked };
  });
  ok(durSalvage.fresh.preview === 'mat_scrap:4|mat_cloth:2' && durSalvage.fresh.bucket === '81~100 %',
    `만피 방탄복 I 분해 미리보기 = ${durSalvage.fresh.preview} (${durSalvage.fresh.bucket})`, JSON.stringify(durSalvage.fresh));
  ok(durSalvage.wrecked.preview === 'mat_scrap:1' && durSalvage.wrecked.bucket === '0~20 %',
    `5 % 방탄복 I 분해 미리보기 = ${durSalvage.wrecked.preview} (${durSalvage.wrecked.bucket})`, JSON.stringify(durSalvage.wrecked));
  ok(durSalvage.fresh.got.scrap === 4 && durSalvage.fresh.got.cloth === 2 && durSalvage.fresh.gone,
    `실제 산출도 미리보기와 같다 — 만피 폐금속 ${durSalvage.fresh.got.scrap} + 천조각 ${durSalvage.fresh.got.cloth}`, JSON.stringify(durSalvage.fresh.got));
  ok(durSalvage.wrecked.got.scrap === 1 && durSalvage.wrecked.got.cloth === 0 && durSalvage.wrecked.gone,
    `망가진 방탄복은 적게 나온다 — 폐금속 ${durSalvage.wrecked.got.scrap} + 천조각 ${durSalvage.wrecked.got.cloth}`, JSON.stringify(durSalvage.wrecked.got));

  /* ── 2026-09-10: 분해 팝업에 내구도 구간이 뜬다 (사양서 §4) ──────────── */
  const disNote = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const max = ctx.loot.getItemDef('armor_1').durabilityMax;
    const plate = ctx.loot.createItem('armor_1', 1, { durability: Math.round(max * 0.3) });
    i.tryAddItem(plate);
    const opened = sys['ui'].openDisassemble(plate.uid);
    const note = document.querySelector('.inv-modeless-disassemble .inv-dur-note');
    const out = { opened, hidden: note?.hidden ?? true, text: note?.textContent ?? '' };
    sys['ui'].disassemble.close();
    // 내구도가 없는 것(탄약)에는 구간 줄이 없다 — 있지도 않은 게이지를 설명하지 않는다
    i.tryAddItem(ctx.loot.createItem('ammo_light', 30));
    const ammo = i.getAllItems().find((x) => x.defId === 'ammo_light');
    out.ammoOpened = sys['ui'].openDisassemble(ammo.uid);
    out.ammoNote = !document.querySelector('.inv-modeless-disassemble .inv-dur-note')?.hidden;
    sys['ui'].disassemble.close();
    // 뒷정리: 다음 검사(회복 스프레이)가 쓸 가방 칸을 남겨 둔다
    i.consumeWhere((d) => d.id === 'armor_1' || d.id === 'ammo_light', 9999);
    return out;
  });
  ok(disNote.opened && !disNote.hidden && /21~40 %/.test(disNote.text) && /제작 재료의 16 %/.test(disNote.text),
    `분해 팝업이 구간과 배수를 말한다 ("${disNote.text}")`, JSON.stringify(disNote));
  ok(disNote.ammoOpened && !disNote.ammoNote, '내구도가 없는 탄약 분해에는 구간 줄이 없다');

  /* ── 5c. Phase 12: 회복 스프레이 수리 (ship) · gauge 0 stays an item ─ */
  console.log('회복 스프레이 수리');
  const spray = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const def = ctx.loot.getItemDef('heal_spray');
    const max = def.durabilityMax;
    i.consumeWhere((d) => d.id === 'mat_can' || d.id === 'mat_antiseptic', 9999);
    const half = ctx.loot.createItem('heal_spray', 1, { durability: max / 2 });
    i.tryAddItem(half);
    const info0 = sys.repairInfo(half.uid);
    const noMats = sys.repair(half.uid);
    const durAfterFail = i.findItem(half.uid).durability;
    i.tryAddItem(ctx.loot.createItem('mat_can', 3)); i.tryAddItem(ctx.loot.createItem('mat_antiseptic', 3));
    const info1 = sys.repairInfo(half.uid);
    const repaired = sys.repair(half.uid);
    const durAfter = i.findItem(half.uid).durability;
    const cans = i.countWhere((d) => d.id === 'mat_can'), anti = i.countWhere((d) => d.id === 'mat_antiseptic');
    const full = sys.repairInfo(half.uid);
    // an empty can stays a valid item everywhere: bag, tooltip (게이지 0 / max), tile (broken bar), repair readout
    const empty = ctx.loot.createItem('heal_spray', 1, { durability: 0 });
    i.tryAddItem(empty);
    sys['ui'].refresh();
    const still = i.findItem(empty.uid);
    const infoEmpty = sys.repairInfo(empty.uid);
    const tt = sys['ui']['tooltip'];
    tt.show(still, def, 10, 10);
    const rows = [...tt.el.querySelectorAll('.inv-tt-stats .k')].map((k) => `${k.textContent} ${k.nextElementSibling.textContent}`);
    tt.hide();
    const tile = document.querySelector(`.inv-grid-bag .inv-tile[data-uid="${empty.uid}"]`);
    return {
      max, info0: info0?.cost.map((c) => `${c.defId}×${c.qty}`), short0: info0?.short, noMats, durAfterFail, info1: info1?.cost.map((c) => `${c.defId}×${c.qty}/${c.have}`), short1: info1?.short,
      repaired, durAfter, cans, anti, full, stillDur: still?.durability, stillQty: still?.qty, infoEmpty: infoEmpty?.cost.map((c) => `${c.defId}×${c.qty}`),
      rows, tileBroken: !!tile?.classList.contains('is-broken'), tileBar: !!tile?.querySelector('.inv-tile-dur.is-broken'),
    };
  });
  ok(spray.max === 200, `HEAL_SPRAY_GAUGE is 200 (durabilityMax ${spray.max})`);
  ok(JSON.stringify(spray.info0) === JSON.stringify(['mat_can×1', 'mat_antiseptic×1']) && spray.short0 === true, `half-empty spray: 수리 cost 캔 1 + 소독약 1, short without materials (${spray.info0?.join(', ')})`, JSON.stringify(spray));
  ok(spray.noMats === false && spray.durAfterFail === 100, 'repair refused without materials (durability untouched)');
  ok(spray.short1 === false && spray.repaired === true && spray.durAfter === 200, `repair with materials → 200 (${spray.durAfter})`);
  ok(spray.cans === 2 && spray.anti === 2 && spray.full === null, `materials consumed (캔 3 → ${spray.cans}, 소독약 3 → ${spray.anti}); a full can is not repairable`);
  ok(spray.stillDur === 0 && spray.stillQty === 1 && JSON.stringify(spray.infoEmpty) === JSON.stringify(['mat_can×1', 'mat_antiseptic×1']), 'a spray at gauge 0 stays in the bag and is repairable (캔 1 + 소독약 1)', JSON.stringify(spray));
  ok(spray.rows.includes('게이지 0 / 200'), `tooltip shows 게이지 0 / 200 (${spray.rows.join(' · ')})`);
  ok(spray.tileBroken && spray.tileBar, 'tile carries the broken gauge bar');
  await sleep(700); // debounced loadout save
  const sprayFile = await page.evaluate(() => { const f = JSON.parse(localStorage.getItem('scav.s1.loadout') ?? 'null'); const e = (f?.bag ?? []).filter((x) => x.defId === 'heal_spray'); return { n: e.length, durs: e.map((x) => x.durability) }; });
  ok(sprayFile.n === 2 && sprayFile.durs.includes(0) && sprayFile.durs.includes(200), `scav.s1.loadout keeps durability 0 (${JSON.stringify(sprayFile.durs)})`);

  /* ── 5c-2. 2026-09-10 (제작 대개편): 방탄복 수리는 더 이상 공짜가 아니다 ──
     예전 `repair()` 는 `getEffectiveStats(item)` 이 null 이면(= 방탄복) 재료 없이 만피로 되돌렸다.
     이제 `getRepairCost` 가 방탄복에도 값을 주므로 (제작 재료 × 구간 배수, 올림) 그 재료를 실제로 소비한다. */
  console.log('방탄복 수리 (재료 소비)');
  const armorRepair = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const mats = (d) => d.id === 'mat_scrap' || d.id === 'mat_cloth' || d.id === 'mat_core';
    i.consumeWhere(mats, 9999);
    const max = ctx.loot.getItemDef('armor_1').durabilityMax;
    const plate = ctx.loot.createItem('armor_1', 1, { durability: Math.round(max * 0.1) });
    i.tryAddItem(plate);
    const info = sys.repairInfo(plate.uid);
    const noMats = sys.repair(plate.uid);
    const durAfterFail = i.findItem(plate.uid)?.durability;
    for (const [id, n] of [['mat_scrap', 10], ['mat_cloth', 10], ['mat_core', 5]]) i.tryAddItem(ctx.loot.createItem(id, n));
    const have0 = { scrap: i.countWhere((d) => d.id === 'mat_scrap'), cloth: i.countWhere((d) => d.id === 'mat_cloth'), core: i.countWhere((d) => d.id === 'mat_core') };
    const repaired = sys.repair(plate.uid);
    const have1 = { scrap: i.countWhere((d) => d.id === 'mat_scrap'), cloth: i.countWhere((d) => d.id === 'mat_cloth'), core: i.countWhere((d) => d.id === 'mat_core') };
    const out = {
      cost: info?.cost.map((c) => `${c.defId}×${c.qty}`), short: info?.short, bucket: info?.bucket?.label, mul: info?.bucket?.repairMul,
      noMats, durAfterFail, repaired, durAfter: i.findItem(plate.uid)?.durability, max,
      spent: { scrap: have0.scrap - have1.scrap, cloth: have0.cloth - have1.cloth, core: have0.core - have1.core },
      full: sys.repairInfo(plate.uid),
    };
    i.consumeWhere(mats, 9999);
    i.consumeWhere((d) => d.id === 'armor_1', 9999);
    return out;
  });
  ok(JSON.stringify(armorRepair.cost) === JSON.stringify(['mat_scrap×5', 'mat_cloth×3', 'mat_core×1']) && armorRepair.bucket === '0~20 %' && armorRepair.mul === 0.5,
    `방탄복 I @10 % 수리비 = 제작 재료 × 0.5 (${armorRepair.cost?.join(', ')}, ${armorRepair.bucket})`, JSON.stringify(armorRepair));
  ok(armorRepair.noMats === false && armorRepair.durAfterFail === 20, '재료가 없으면 방탄복 수리가 거절된다 (내구도 그대로)');
  ok(armorRepair.repaired === true && armorRepair.durAfter === armorRepair.max, `재료가 있으면 만피로 (${armorRepair.durAfter} / ${armorRepair.max})`);
  ok(armorRepair.spent.scrap === 5 && armorRepair.spent.cloth === 3 && armorRepair.spent.core === 1,
    `수리가 재료를 실제로 소비한다 (${JSON.stringify(armorRepair.spent)})`);
  ok(armorRepair.full === null, '만피 방탄복은 다시 수리되지 않는다');

  /* ── 5d. Phase 12: 임플란트 items — tooltip · grid ops · never quick / equip ── */
  console.log('임플란트 아이템');
  const imp = await page.evaluate(() => {
    const ctx = window.__game.ctx, i = ctx.inventory, sys = window.__game.getSystem('inventory');
    const tt = sys['ui']['tooltip'];
    const card = (id) => {
      const def = ctx.loot.getItemDef(id); if (!def) return null;
      const it = ctx.loot.createItem(id);
      tt.show(it, def, 10, 10);
      const rows = [...tt.el.querySelectorAll('.inv-tt-stats .k')].map((k) => `${k.textContent} ${k.nextElementSibling.textContent}`);
      const out = { rows, text: tt.el.textContent, chips: tt.el.querySelectorAll('.inv-tt-repair .item-chip').length, broken: tt.el.querySelector('.inv-tt-broken')?.textContent ?? null, perk: tt.el.querySelector('.inv-tt-perk')?.textContent ?? null, implant: def.implant, sub: tt.el.querySelector('.inv-tt-sub').textContent };
      tt.hide();
      return out;
    };
    const statName = (id) => ctx.progression.getStatDef(id).name;
    const s2 = card('imp_strength_2'), br = card('imp_broken_strength_2'), pk = card('imp_perk_quick_heal');
    const expectStats = (c) => Object.entries(c.implant.stats).map(([id, v]) => `${statName(id)} +${v}`);
    // grid ops the 캐릭터 tab relies on: stash in → find → take out → back anywhere
    const inst = ctx.loot.createItem('imp_strength_2');
    const toStash = i.tryAddToStash(inst);
    const found = i.findItemAnywhere(inst.uid)?.defId ?? null;
    const inBag = i.findItem(inst.uid);
    const taken = i.takeItem(inst.uid);
    const gone = i.findItemAnywhere(inst.uid);
    const back = ctx.loot.createItem('imp_strength_2');
    const where = i.tryAddItemAnywhere(back);
    const quick = i.setQuickSlot(0, back.uid);
    const quickSlots = i.getQuickSlots().filter((q) => q && q.uid === back.uid).length;
    const equipTarget = sys.equipTargetFor(ctx.loot.getItemDef('imp_strength_2'));
    const equipTry = ['primary', 'primary2', 'bag', 'armor'].map((s) => i.equip(back.uid, s));
    const stillInBag = !!i.findItem(back.uid);
    const takenBack = i.takeItem(back.uid);
    return { s2, br, pk, strength: statName('strength'), expectS2: expectStats(s2), expectPk: expectStats(pk), toStash, found, inBag, taken, gone, where, quick, quickSlots, equipTarget, equipTry, stillInBag, takenBack };
  });
  ok(imp.s2 && imp.s2.rows.includes('장착칸 2') && imp.s2.rows.includes(`${imp.strength} +2`) && imp.expectS2.every((r) => imp.s2.rows.includes(r)), `imp_strength_2 tooltip: 장착칸 2 · ${imp.expectS2.join(' · ')} (${imp.s2?.sub})`, JSON.stringify(imp.s2?.rows));
  ok(imp.s2 && !imp.s2.broken && imp.s2.chips === 0 && !imp.s2.perk, 'working implant shows no 망가짐 / repair chips / perk');
  ok(imp.br && imp.br.broken === '망가짐 — 세레스 바이오에서 수리' && imp.br.chips === imp.br.implant.repairCost.length && imp.br.chips > 0 && !imp.br.rows.some((r) => r.startsWith(imp.strength)), `broken implant tooltip: red 망가짐 line + ${imp.br?.chips} repair chips, no stat lines`, JSON.stringify(imp.br));
  ok(imp.pk && imp.pk.perk && imp.pk.perk.includes('가속 대사') && imp.pk.perk.includes('절반') && imp.expectPk.every((r) => imp.pk.rows.includes(r)), `legendary perk tooltip names 가속 대사 + description (${imp.pk?.perk})`);
  ok(imp.toStash === true && imp.found === 'imp_strength_2' && imp.inBag === null && imp.taken === 1 && imp.gone === null, 'tryAddToStash → findItemAnywhere → takeItem(1) → gone for an implant instance', JSON.stringify(imp));
  ok(imp.where === 'bag' && imp.stillInBag && imp.takenBack === 1, `tryAddItemAnywhere puts an implant in the ${imp.where}`);
  ok(imp.quick === false && imp.quickSlots === 0 && imp.equipTarget === null && imp.equipTry.every((r) => r === false), 'implants are never quick-slottable and fit no equipment slot');
  // 2026-09-08 (ESC = 항상 일시정지): the window closes on Tab, the key that opened it.
  await tap('Tab');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed (Tab)');

  /* ── 6. reload keeps the stash size; catalog on a mission ─────────── */
  console.log('reload / mission');
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot (reload)');
  await install();
  const sizeAfter = await page.evaluate(() => window.__game.ctx.inventory.getStashSize());
  ok(sizeAfter.cols === 10 && sizeAfter.rows === 30, `stash size survived the reload (${sizeAfter.cols}×${sizeAfter.rows})`);
  // Phase 12: the empty 회복 스프레이 (gauge 0) came back from `scav.s1.loadout` as an item at 0 — not fresh, not dropped
  const sprayKept = await page.evaluate(() => { const items = window.__game.ctx.inventory.getAllItems().filter((x) => x.defId === 'heal_spray'); return { n: items.length, durs: items.map((x) => x.durability).sort((a, b) => a - b) }; });
  ok(sprayKept.n === 2 && sprayKept.durs[0] === 0 && sprayKept.durs[1] === 200, `spray at gauge 0 survived the reload as 0 / 200 (${JSON.stringify(sprayKept.durs)})`);
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  await waitSim(0.3);
  await page.evaluate(() => window.__game.ctx.inventory.openCatalog());
  await sleep(250);
  const mission = await page.evaluate(() => {
    const root = document.querySelector('.inv-root');
    return { open: window.__game.ctx.inventory.isOpen, catalog: window.__game.ctx.inventory.isCatalogOpen, hub: root.classList.contains('is-hub'), stashHidden: root.querySelector('.inv-panel-stash').hidden, panel: !root.querySelector('.inv-panel-catalog').hidden, blockers: [...window.__game.ctx.uiBlockers] };
  });
  ok(mission.open && mission.catalog && mission.panel && !mission.hub && mission.stashHidden, 'catalog opens on a mission (bag window, no stash)');
  const take = await page.evaluate(() => { const r = window.__game.getSystem('inventory').takeFromCatalog('grenade_frag'); return { r, n: window.__game.ctx.inventory.countWhere((d) => d.id === 'grenade_frag') }; });
  ok(take.r === 'ok' && take.n >= 4, `takeFromCatalog on a mission (grenades ${take.n})`);
  await page.evaluate(() => window.__game.ctx.inventory.closeCatalog());
  const partial = await page.evaluate(() => ({ open: window.__game.ctx.inventory.isOpen, catalog: window.__game.ctx.inventory.isCatalogOpen, panel: !document.querySelector('.inv-panel-catalog').hidden }));
  ok(partial.open && !partial.catalog && !partial.panel, 'closeCatalog hides only the catalog panel');
  await tap('Tab');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed (mission)');

  /* ── 7. 제작 UI 2차 (2026-09-09): 썸네일 · `이름 ×n` · 설명 줄 없음 · 제작 수량 ──
     Last on purpose: it fills the bag with its own materials and really crafts, so nothing after it could be
     confused by the leftovers. A fresh page puts the profile's bag back, and 작업대 needs a hub phase. */
  console.log('제작 수량');
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot (제작 수량)');
  await install();
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 40000);
  await sleep(400);
  const RID = 'make_ammo_medium';
  // materials go in the **bag** — `canCraft` / `maxCraftCount` spend the bag, not the 함선 창고
  const stocked = await page.evaluate((id) => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('inventory');
    const recipe = ctx.loot.getAllRecipes().find((r) => r.id === id);
    const added = [];
    for (const c of sys.craftCost(recipe)) {
      for (let i = 0; i < 4; i++) added.push(ctx.inventory.tryAddItem(ctx.loot.createItem(c.defId, c.qty * 2)));
    }
    ctx.inventory.openBenchCraft('gun', 2);
    return { added, max: sys.maxCraftCount(id) };
  }, RID);
  await sleep(350);
  ok(stocked.max >= 3, `재료를 채우면 3회 이상 만들 수 있다 (max ${stocked.max})`, JSON.stringify(stocked));

  const rowLook = await page.evaluate((id) => {
    const row = document.querySelector(`.inv-craft-row[data-recipe="${id}"]`);
    if (!row) return { missing: true };
    const thumb = row.querySelector('.inv-craft-thumb');
    const tile = thumb?.querySelector('.inv-tile');
    const def = window.__game.ctx.loot.getItemDef(thumb?.dataset.defId ?? '');
    const recipe = window.__game.ctx.loot.getAllRecipes().find((r) => r.id === id);
    return {
      name: row.querySelector('.inv-craft-name')?.textContent ?? '',
      expect: def && recipe ? `${def.name} \u00d7${recipe.outputQty}` : null,
      hasTile: !!tile, tipHook: thumb?.dataset.itemTip !== undefined && !!thumb?.dataset.defId,
      w: tile ? parseInt(tile.style.width, 10) : -1, h: tile ? parseInt(tile.style.height, 10) : -1,
      defW: def?.width, defH: def?.height,
      desc: !!row.querySelector('.inv-craft-desc'),
      stepper: !!row.querySelector('.inv-craft-count') && row.querySelectorAll('.inv-craft-step').length === 2,
      count: row.querySelector('.inv-craft-count-v')?.textContent,
      outputQty: recipe?.outputQty,
    };
  }, RID);
  ok(!rowLook.missing && rowLook.hasTile && rowLook.tipHook,
    '제작 행이 산출물을 인벤토리 타일로 그리고 툴팁 훅(data-item-tip)을 단다', JSON.stringify(rowLook));
  ok(rowLook.w === rowLook.defW * 54 && rowLook.h === rowLook.defH * 54,
    `썸네일이 격자 칸 크기다 (${rowLook.defW}\u00d7${rowLook.defH} 칸 → ${rowLook.w}\u00d7${rowLook.h} px)`);
  ok(rowLook.name === rowLook.expect, `행 제목이 '산출물 \u00d7n' 이다 ("${rowLook.name}")`);
  ok(!rowLook.desc, '레시피 설명 줄이 사라졌다');
  ok(rowLook.stepper && rowLook.count === String(rowLook.outputQty),
    `제작 수량 스테퍼가 1회분(${rowLook.outputQty})에서 시작한다 — 횟수가 아니라 총 개수를 읽는다`);

  const stepped = await page.evaluate((id) => {
    const row = document.querySelector(`.inv-craft-row[data-recipe="${id}"]`);
    const before = [...row.querySelectorAll('.item-chip-need')].map((n) => Number(n.textContent));
    const more = row.querySelectorAll('.inv-craft-step')[1];
    more.click(); more.click();
    return { before };
  }, RID);
  await sleep(250);
  const after3 = await page.evaluate((id) => {
    const row = document.querySelector(`.inv-craft-row[data-recipe="${id}"]`);
    const recipe = window.__game.ctx.loot.getAllRecipes().find((r) => r.id === id);
    const def = window.__game.ctx.loot.getItemDef(recipe.outputDefId);
    return {
      count: row.querySelector('.inv-craft-count-v')?.textContent,
      need: [...row.querySelectorAll('.item-chip-need')].map((n) => Number(n.textContent)),
      name: row.querySelector('.inv-craft-name')?.textContent,
      expect: `${def.name} \u00d7${recipe.outputQty}`,
      outputQty: recipe.outputQty,
    };
  }, RID);
  ok(after3.count === String(after3.outputQty * 3) && after3.need.length === stepped.before.length
    && after3.need.every((n, i) => n === stepped.before[i] * 3),
    `\u25b6 두 번 → 총 ${after3.count}개, 재료 필요량도 3배 (${stepped.before.join('/')} → ${after3.need.join('/')})`);
  ok(after3.name === after3.expect, `제목은 1회분을 그대로 유지한다 ("${after3.name}")`);

  const batch = await page.evaluate(async (id) => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('inventory');
    const recipe = ctx.loot.getAllRecipes().find((r) => r.id === id);
    const cost = sys.craftCost(recipe);
    const before = cost.map((c) => sys.countDef(c.defId));
    const outBefore = sys.countDef(recipe.outputDefId);
    const started = [];
    const off = ctx.bus.on('craft:started', (p) => started.push(p));
    const done = new Promise((res) => { const o = ctx.bus.on('craft:completed', (p) => { o(); res(p); }); });
    void sys.craft(id, undefined, 3);
    const ev = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 5000))]);
    off();
    return {
      started: started[0] ?? null, completed: ev ? { recipeId: ev.recipeId, count: ev.count } : null,
      spent: cost.map((c, i) => before[i] - sys.countDef(c.defId)), need: cost.map((c) => c.qty * 3),
      made: sys.countDef(recipe.outputDefId) - outBefore, expectMade: recipe.outputQty * 3,
    };
  }, RID);
  ok(batch.started?.count === 3, `craft:started 가 수량을 싣는다 (${JSON.stringify(batch.started)})`);
  ok(batch.completed?.count === 3, `craft:completed 가 수량을 싣는다 (${JSON.stringify(batch.completed)})`);
  ok(batch.spent.every((v, i) => v === batch.need[i]), `재료가 3배로 빠진다 (${batch.spent.join('/')} = ${batch.need.join('/')})`);
  ok(batch.made === batch.expectMade, `한 번의 홀드로 산출물도 3배 (${batch.made} = ${batch.expectMade})`);
  await page.evaluate(() => window.__game.ctx.inventory.closeAll());
  await sleep(150);

  /* ── 8. 창고는 `hides('stashItem', defId)` 가 막는 아이템을 그리지 않는다 (2026-09-09) ── */
  const stashHide = await page.evaluate(async () => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('inventory');
    const first = [...sys.getStash().items()][0];
    if (!first) return { skip: true };
    const uid = first.item.uid, defId = first.item.defId;
    const real = ctx.tutorial;
    // only what the grid asks for; the real gate is covered by smoke-tutorial
    ctx.tutorial = { active: true, step: 'craftAmmo', stepIndex: 1, stepCount: 18,
      blockReason: () => null, hides: (gate, id) => gate === 'stashItem' && id === defId,
      start: () => false, skip: () => {}, goto: () => false };
    ctx.bus.emit('tutorial:changed', { active: true, step: 'craftAmmo', index: 1, count: 18 });
    ctx.inventory.openScreen('inventory');
    await new Promise((r) => setTimeout(r, 300));
    const hidden = !document.querySelector(`.inv-grid-stash [data-uid="${uid}"]`);
    const inGrid = [...sys.getStash().items()].some((p) => p.item.uid === uid);
    ctx.tutorial = real;
    ctx.bus.emit('tutorial:changed', { active: false, step: null, index: 0, count: 18 });
    await new Promise((r) => setTimeout(r, 300));
    const back = !!document.querySelector(`.inv-grid-stash [data-uid="${uid}"]`);
    ctx.inventory.closeAll();
    return { hidden, inGrid, back, defId };
  });
  if (stashHide.skip) ok(true, '창고가 비어 있어 stashItem 숨김은 건너뛴다');
  else {
    ok(stashHide.hidden && stashHide.inGrid,
      `튜토리얼이 막는 창고 아이템은 그려지지 않는다 — 격자 데이터는 그대로 (${stashHide.defId})`, JSON.stringify(stashHide));
    ok(stashHide.back, '튜토리얼이 끝나면 그 자리에 다시 나타난다');
  }
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
const errs = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|WebSocket/.test(e));
ok(errs.length === 0, `no console errors (${errs.length})`, errs.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
