// Single-player smoke test for **item favourites** (E1, 2026-09-12 — docs/plans/consumables-keys-favorites.md §5):
// `InventoryRef.isFavorite / toggleFavorite / favoriteDefIds` + `inventory:favoritesChanged`, the right-click menu on
// **every** item (「빠른 이동 (…)」 + 「즐겨찾기 켜기 / 끄기」, also equipment slot cards and wheel cells), double-click =
// quick move, the blue corner ribbon (bag · 창고 · equipment slot · TradeGrids · `buildItemTile`; a needed-ammo favourite
// shows the blue ribbon AND the yellow one pushed inward), favourites first in 자동 정렬, the 「즐겨찾기」 filter chip,
// the extra hold-confirm before 분해 of a favourite, the container-window glow, and persistence (loadout file `fav`,
// reload, server document replace + the pending-local-edit guard, crew card / raid blob stay without `fav`).
// Usage: node scripts/smoke-favorites.mjs [http://localhost:5273/]   (needs a vite dev server)
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
/** Like `waitFor` but reports instead of throwing (a missed repaint is one FAIL, not the end of the run). */
async function waitOk(page, fn, label, timeout, arg) {
  try { await waitFor(page, fn, label, timeout, arg); ok(true, label); } catch { ok(false, label, '(timeout)'); }
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
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['inventory:favoritesChanged', 'inventory:loadoutSaved', 'net:profileLoaded'];
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
    await page.evaluate((names) => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of names) {
        window.__ev[n] = [];
        bus.on(n, (p) => { try { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); } catch { window.__ev[n].push({}); } });
      }
    }, EVENTS);
  };
  const reload = async () => { await page.goto(BASE, { waitUntil: 'load' }); await boot(); };
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const enterHub = async () => {
    await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await waitSim(0.3);
  };
  const openInv = async () => {
    await page.evaluate(() => { const s = window.__game.getSystem('inventory'); if (!s._open) s.toggleBag(); });
    await waitFor(page, () => { const s = window.__game.getSystem('inventory'); const r = document.querySelector('.inv-root'); return s._open && r && !r.hidden; }, 'inventory window open', 10000);
    await sleep(200);
  };
  /** uid of the first stack of `defId` in grid `grid` ('bag' | 'stash'). */
  const tileSel = (grid, uid) => `.inv-grid-${grid} .inv-tile[data-uid="${uid}"]`;

  /* ── 0. fresh character: no loadout / stash / grant / server token ──────────────────────────────────────── */
  console.log('fresh profile');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { for (const k of ['scav.s1.loadout', 'scav.s1.stash', 'scav.s1.grant', 'scav.s1.sessionToken']) localStorage.removeItem(k); });
  await reload();
  await enterHub();
  await sleep(1200);   // a relay welcome (if any) lands before we start editing
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; for (const id of [...inv.favoriteDefIds]) inv.toggleFavorite(id, false); });

  /* ── 1. API + event ─────────────────────────────────────────────────────────────────────────────────────── */
  console.log('API');
  const api = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const l = inv.getLoadout();
    const stats = l.primary ? inv.getStats(l.primary) : null;
    const ammoDef = stats && ctx.loot.getAllItemDefs().find((d) => d.category === 'ammo' && d.ammoType === stats.ammoType);
    const n0 = window.__ev['inventory:favoritesChanged'].length;
    const before = inv.isFavorite('gem_amber');
    const on = inv.toggleFavorite('gem_amber');
    const again = inv.toggleFavorite('gem_amber', true);
    const unknown = inv.toggleFavorite('no_such_item');
    return {
      ammo: ammoDef?.id ?? null, before, on, again, unknown, isFav: inv.isFavorite('gem_amber'),
      ids: [...inv.favoriteDefIds], evs: window.__ev['inventory:favoritesChanged'].slice(n0),
    };
  });
  ok(!api.before && api.on === true && api.again === true && api.unknown === false && api.isFav,
    'toggleFavorite flips (returns the new state), on=true on a favourite is a no-op, an unknown def is refused', JSON.stringify(api));
  ok(api.ids.includes('gem_amber') && !api.ids.includes('no_such_item'), 'favoriteDefIds lists the kind', JSON.stringify(api.ids));
  ok(api.evs.length === 1 && api.evs[0].defId === 'gem_amber' && api.evs[0].favorite === true,
    'inventory:favoritesChanged fires once, only on a real change', JSON.stringify(api.evs));
  const AMMO = api.ammo;
  ok(!!AMMO, 'found the ammo the equipped primary needs', String(AMMO));

  /* ── 2. ribbons ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log('ribbons');
  await page.evaluate((ammo) => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    inv.tryAddToStash(ctx.loot.createItem('gem_amber', 1));
    inv.tryAddToStash(ctx.loot.createItem('mat_scrap', 1));
    inv.tryAddItem(ctx.loot.createItem(ammo, 30));
    inv.toggleFavorite(ammo, true);
    inv.toggleFavorite('wpn_smg', true);   // the starter primary — its equipment slot card gets the ribbon too
  }, AMMO);
  await openInv();
  await waitOk(page, (ammo) => {
    const inv = window.__game.ctx.inventory;
    const p = inv.getGrid('bag').items().find((x) => x.item.defId === ammo);
    return p && document.querySelector(`.inv-grid-bag .inv-tile[data-uid="${p.item.uid}"]`)?.classList.contains('is-favorite');
  }, 'bag tile of a favourite kind carries .is-favorite', 10000, AMMO);
  const rib = await page.evaluate((ammo) => {
    const inv = window.__game.ctx.inventory;
    const uidOf = (grid, def) => (grid === 'stash' ? inv.getStash() : inv.getGrid(grid)).items().find((x) => x.item.defId === def)?.item.uid;
    const tile = (grid, uid) => uid && document.querySelector(`.inv-grid-${grid} .inv-tile[data-uid="${uid}"]`);
    const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo) : null);
    const at = tile('bag', uidOf('bag', ammo)), gt = tile('stash', uidOf('stash', 'gem_amber')), st = tile('stash', uidOf('stash', 'mat_scrap'));
    const b = cs(at, '::before'), a = cs(at, '::after');
    const slotCard = document.querySelector('.inv-slot-primary .inv-tile');
    return {
      ammoFav: !!at?.classList.contains('is-favorite'), ammoNeeded: !!at?.classList.contains('is-ammo-needed'),
      beforeContent: b?.content, beforeBg: b?.backgroundImage, beforeEvents: b?.pointerEvents,
      afterContent: a?.content, afterW: a?.width, afterEvents: a?.pointerEvents,
      gemFav: !!gt?.classList.contains('is-favorite'), gemBefore: cs(gt, '::before')?.content,
      scrapFav: !!st?.classList.contains('is-favorite'), scrapBefore: cs(st, '::before')?.content,
      slotFav: !!slotCard?.classList.contains('is-favorite'),
    };
  }, AMMO);
  ok(rib.ammoFav && rib.ammoNeeded, 'a needed-ammo favourite carries both .is-favorite and .is-ammo-needed', JSON.stringify(rib));
  ok(rib.beforeContent && rib.beforeContent !== 'none' && /gradient/.test(rib.beforeBg ?? '') && rib.afterContent !== 'none' && rib.afterW === '34px'
    && rib.beforeEvents === 'none' && rib.afterEvents === 'none',
    'both ribbons are drawn: blue ::before in the corner, yellow ::after pushed inward (34 px box), neither takes the pointer', JSON.stringify(rib));
  ok(rib.gemFav && rib.gemBefore !== 'none' && !rib.scrapFav && rib.scrapBefore === 'none', '창고: the favourite has the ribbon, the other stack none', JSON.stringify(rib));
  ok(rib.slotFav, 'equipment slot card of a favourite kind carries the ribbon', JSON.stringify(rib));

  /* ── 3. right-click = menu for every item ──────────────────────────────────────────────────────────────── */
  console.log('context menu');
  const rightClick = (sel) => page.evaluate((s) => {
    const t = document.querySelector(s);
    if (!t) return null;
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 6, clientY: r.top + 6, bubbles: true, cancelable: true }));
    const menu = document.querySelector('.inv-menu');
    return { open: !!menu && !menu.hidden, items: [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((b) => b.textContent) };
  }, sel);
  const clickMenu = (prefix) => page.evaluate((p) => {
    const b = [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((x) => x.textContent.startsWith(p));
    if (b) b.click();
    return !!b;
  }, prefix);
  const closeMenu = () => page.evaluate(() => window.__game.getSystem('inventory').ui.menu.close());
  const gemStashUid = await page.evaluate(() => window.__game.ctx.inventory.getStash().items().find((x) => x.item.defId === 'gem_amber')?.item.uid);
  const m1 = await rightClick(tileSel('stash', gemStashUid));
  const stillInStash = await page.evaluate((uid) => !!window.__game.ctx.inventory.getStash().get(uid), gemStashUid);
  ok(!!m1?.open && stillInStash, 'right-click on a plain single item opens the menu (it used to move the item at once)', JSON.stringify({ m1, stillInStash }));
  ok(!!m1?.items.some((t) => t.startsWith('빠른 이동 (가방)')) && !!m1?.items.some((t) => t.startsWith('즐겨찾기 끄기')),
    'menu offers 「빠른 이동 (가방)」 and 「즐겨찾기 끄기」', JSON.stringify(m1?.items));
  let n0 = await page.evaluate(() => window.__ev['inventory:favoritesChanged'].length);
  ok(await clickMenu('즐겨찾기 끄기'), 'click 즐겨찾기 끄기');
  const off = await page.evaluate((n) => ({
    fav: window.__game.ctx.inventory.isFavorite('gem_amber'), evs: window.__ev['inventory:favoritesChanged'].slice(n),
    menuClosed: document.querySelector('.inv-menu').hidden,
  }), n0);
  ok(!off.fav && off.evs.length === 1 && off.evs[0].defId === 'gem_amber' && off.evs[0].favorite === false && off.menuClosed,
    'menu toggle turns the kind off (event favorite:false) and closes the menu', JSON.stringify(off));
  await waitOk(page, (s) => { const t = document.querySelector(s); return t && !t.classList.contains('is-favorite'); },
    'the tile ribbon follows the menu toggle (repaint without a grid change)', 5000, tileSel('stash', gemStashUid));
  const m2 = await rightClick(tileSel('stash', gemStashUid));
  ok(!!m2?.items.some((t) => t.startsWith('즐겨찾기 켜기')), 'the next menu offers 즐겨찾기 켜기', JSON.stringify(m2?.items));
  await clickMenu('즐겨찾기 켜기');
  ok(await page.evaluate(() => window.__game.ctx.inventory.isFavorite('gem_amber')), '즐겨찾기 켜기 through the menu');

  const slotMenu = await rightClick('.inv-slot-primary');
  await closeMenu();
  ok(!!slotMenu?.open && slotMenu.items.some((t) => t.startsWith('즐겨찾기 끄기')) && slotMenu.items.some((t) => t.startsWith('빠른 이동 (가방)')),
    'equipment slot card menu: 빠른 이동 (가방) + 즐겨찾기', JSON.stringify(slotMenu?.items));
  const wheelIdx = await page.evaluate(() => window.__game.ctx.inventory.getQuickSlots().findIndex((s) => !!s));
  const wheelMenu = wheelIdx >= 0 ? await rightClick(`.inv-quick-cell[data-index="${wheelIdx}"]`) : null;
  await closeMenu();
  ok(!!wheelMenu?.open && wheelMenu.items[0]?.includes('빠른 슬롯 해제') && wheelMenu.items.some((t) => t.startsWith('즐겨찾기 켜기')),
    'wheel cell menu: 빠른 슬롯 해제 stays first, 즐겨찾기 켜기 is offered', JSON.stringify({ wheelIdx, items: wheelMenu?.items }));

  /* ── 4. double-click = quick move ──────────────────────────────────────────────────────────────────────── */
  console.log('double-click');
  const dbl = (sel) => page.evaluate((s) => { const t = document.querySelector(s); if (t) t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return !!t; }, sel);
  await dbl(tileSel('stash', gemStashUid));
  const d1 = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory;
    return { inBag: inv.getGrid('bag').items().find((x) => x.item.defId === 'gem_amber')?.item.uid ?? null, inStash: inv.getStash().items().some((x) => x.item.defId === 'gem_amber') };
  });
  ok(!!d1.inBag && !d1.inStash, 'double-click on a 창고 item moves it into the bag', JSON.stringify(d1));
  await dbl(tileSel('bag', d1.inBag));
  const d2 = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory;
    return { inBag: inv.getGrid('bag').items().some((x) => x.item.defId === 'gem_amber'), inStash: inv.getStash().items().find((x) => x.item.defId === 'gem_amber')?.item.uid ?? null };
  });
  ok(!d2.inBag && !!d2.inStash, 'double-click on the bag item sends it back to the 창고 (ship, no crate open)', JSON.stringify(d2));

  /* ── 5. 자동 정렬: favourites first ─────────────────────────────────────────────────────────────────────── */
  console.log('sort');
  const sorted = await page.evaluate((ammo) => {
    const inv = window.__game.ctx.inventory;
    const gemUid = inv.getStash().items().find((x) => x.item.defId === 'gem_amber').item.uid;
    inv.quickMove(gemUid, { kind: 'grid', grid: 'stash' });
    const topLeft = () => inv.getGrid('bag').items().find((p) => p.x === 0 && p.y === 0)?.item.defId ?? null;
    inv.toggleFavorite(ammo, false);
    inv.toggleFavorite('gem_amber', false);
    const r0 = inv.sortGrid('bag');
    const plain = topLeft();
    inv.toggleFavorite('gem_amber', true);
    const r1 = inv.sortGrid('bag');
    const fav = topLeft();
    return { r0, r1, plain, fav, bagDefs: inv.getGrid('bag').items().map((p) => p.item.defId) };
  }, AMMO);
  ok(sorted.plain !== 'gem_amber' && sorted.fav === 'gem_amber' && sorted.r1 === 'ok',
    '자동 정렬 puts the favourite kind first (without the favourite it is not first)', JSON.stringify(sorted));

  /* ── 6. 「즐겨찾기」 filter chip ─────────────────────────────────────────────────────────────────────────── */
  console.log('filter chip');
  const flt = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory;
    document.querySelector('.inv-panel-bag .inv-filter-chip[data-filter="favorite"]').click();
    const favs = new Set(inv.favoriteDefIds);
    const tiles = [...document.querySelectorAll('.inv-grid-bag .inv-tile')].map((t) => {
      const p = inv.getGrid('bag').get(t.dataset.uid);
      return { def: p?.item.defId, fav: favs.has(p?.item.defId), dim: t.classList.contains('is-filtered-out') };
    });
    return {
      tiles, chipOn: document.querySelector('.inv-panel-bag .inv-filter-chip[data-filter="favorite"]').classList.contains('is-on'),
      stashChipOn: document.querySelector('.inv-panel-stash .inv-filter-chip[data-filter="favorite"]').classList.contains('is-on'),
    };
  });
  ok(flt.chipOn && flt.stashChipOn, 'the 즐겨찾기 chip lights on 가방 and 창고 alike', JSON.stringify(flt));
  ok(flt.tiles.length > 1 && flt.tiles.some((t) => t.fav) && flt.tiles.every((t) => t.dim === !t.fav),
    'the chip dims every non-favourite tile and only those', JSON.stringify(flt.tiles));
  await page.evaluate((ammo) => window.__game.ctx.inventory.toggleFavorite(ammo, true), AMMO);
  await waitOk(page, (ammo) => {
    const inv = window.__game.ctx.inventory;
    const p = inv.getGrid('bag').items().find((x) => x.item.defId === ammo);
    const t = p && document.querySelector(`.inv-grid-bag .inv-tile[data-uid="${p.item.uid}"]`);
    return t && !t.classList.contains('is-filtered-out') && t.classList.contains('is-favorite');
  }, 'toggling a favourite under the lit chip repaints the dimming', 5000, AMMO);
  await page.evaluate(() => document.querySelector('.inv-panel-bag .inv-filter-chip[data-filter="all"]').click());

  /* ── 7. TradeGrids + buildItemTile ─────────────────────────────────────────────────────────────────────── */
  console.log('TradeGrids / buildItemTile');
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'fav-tg';
    host.style.cssText = 'position:fixed;left:0;top:0;width:1500px;height:820px;z-index:9999;overflow:auto';
    document.body.appendChild(host);
    window.__favTg = window.__game.ctx.inventory.createTradeGrids(host, {});
  });
  const tgSel = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory;
    const p = inv.getGrid('bag').items().find((x) => x.item.defId === 'gem_amber');
    return p ? `#fav-tg .inv-tile[data-uid="${p.item.uid}"]` : null;
  });
  await waitOk(page, (s) => !!s && !!document.querySelector(s)?.classList.contains('is-favorite'), 'TradeGrids tile of a favourite has the ribbon', 5000, tgSel);
  await page.evaluate(() => window.__game.ctx.inventory.toggleFavorite('gem_amber', false));
  await waitOk(page, (s) => !!s && !!document.querySelector(s) && !document.querySelector(s).classList.contains('is-favorite'), 'TradeGrids repaints on inventory:favoritesChanged', 5000, tgSel);
  await page.evaluate(() => window.__game.ctx.inventory.toggleFavorite('gem_amber', true));
  const tgf = await page.evaluate(async () => {
    const inv = window.__game.ctx.inventory;
    document.querySelector('#fav-tg .inv-filter-chip[data-filter="favorite"]').click();
    await new Promise((r) => setTimeout(r, 120));
    const favs = new Set(inv.favoriteDefIds);
    const tiles = [...document.querySelectorAll('#fav-tg .tg-bag .inv-tile')].map((t) => ({ fav: favs.has(inv.getGrid('bag').get(t.dataset.uid)?.item.defId), dim: t.classList.contains('is-filtered-out') }));
    window.__favTg.dispose();
    document.getElementById('fav-tg')?.remove();
    const a = inv.buildItemTile('gem_amber', 1), b = inv.buildItemTile('mat_scrap', 1);
    return { tiles, standaloneFav: a.classList.contains('is-favorite'), standaloneOther: b.classList.contains('is-favorite') };
  });
  ok(tgf.tiles.length > 1 && tgf.tiles.every((t) => t.dim === !t.fav), 'TradeGrids 즐겨찾기 chip dims non-favourites', JSON.stringify(tgf.tiles));
  ok(tgf.standaloneFav && !tgf.standaloneOther, 'InventoryRef.buildItemTile (기업 상점 tiles) carries the ribbon for a favourite only', JSON.stringify(tgf));

  /* ── 8. container / corpse window: favourite glow + menu ───────────────────────────────────────────────── */
  console.log('container window');
  const cont = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const pos = ctx.player.position.clone();
    inv.openContainerItems('corpse:fav-smoke', [ctx.loot.createItem('gem_amber', 1), ctx.loot.createItem('mat_scrap', 2)], pos, '시체');
    const c = inv.getActiveContainer();
    if (!c) return null;
    for (const p of c.grid.items()) p.item.searched = true;
    inv.ui.containerView.refresh(true);
    const tiles = [...document.querySelectorAll('.inv-panel-container .inv-tile')];
    const favT = tiles.find((t) => c.grid.get(t.dataset.uid)?.item.defId === 'gem_amber');
    const other = tiles.find((t) => c.grid.get(t.dataset.uid)?.item.defId === 'mat_scrap');
    return {
      favClass: !!favT?.classList.contains('is-favorite'), favOutline: favT ? getComputedStyle(favT).outlineStyle : null,
      otherOutline: other ? getComputedStyle(other).outlineStyle : null, favUid: favT?.dataset.uid ?? null,
    };
  });
  ok(!!cont && cont.favClass && cont.favOutline === 'solid' && cont.otherOutline === 'none',
    'corpse window: a favourite tile glows (outline), the other does not', JSON.stringify(cont));
  if (cont?.favUid) {
    const cm = await rightClick(`.inv-grid-container .inv-tile[data-uid="${cont.favUid}"]`);
    await closeMenu();
    ok(!!cm?.items.some((t) => t.startsWith('빠른 이동 (가방)')) && !!cm?.items.some((t) => t.startsWith('즐겨찾기 끄기')),
      'container tile menu: 빠른 이동 (가방) + 즐겨찾기', JSON.stringify(cm?.items));
  }
  await page.evaluate(() => { const inv = window.__game.getSystem('inventory'); if (inv._open) inv.toggleBag(); });
  await waitFor(page, () => !window.__game.getSystem('inventory')._open, 'window closed', 5000);

  /* ── 9. 분해 of a favourite asks once more (1 s hold) ───────────────────────────────────────────────────── */
  console.log('disassemble confirm');
  await openInv();
  const dis = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, ui = inv.ui;
    const w = ctx.loot.createItem('wpn_smg');
    const added = inv.tryAddItem(w);
    const recipe = !!inv.disassembleRecipeFor(w.uid);
    const opened = ui.openDisassemble(w.uid);
    const panel = ui.disassemblePanel;
    panel.barEl.click();
    const s1 = { confirming: panel.isConfirming, job: !!inv.craftProgress() };
    const esc = ui.closePopups();
    const s2 = { confirming: panel.isConfirming, open: panel.isOpen };
    panel.barEl.click();
    const btn = panel.confirmButton;
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
    const s3 = { confirming: panel.isConfirming, job: !!inv.craftProgress() };
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    return { uid: w.uid, added, recipe, opened, s1, esc, s2, s3 };
  });
  ok(dis.added && dis.recipe && dis.opened, '분해 dialog opens for a favourite weapon in the bag', JSON.stringify(dis));
  ok(dis.s1.confirming && !dis.s1.job, 'the 분해 button on a favourite shows the confirm card and starts nothing', JSON.stringify(dis.s1));
  ok(dis.esc && !dis.s2.confirming && dis.s2.open, 'Escape (closePopups) cancels only the card — the dialog stays', JSON.stringify(dis.s2));
  ok(dis.s3.confirming && !dis.s3.job, 'a short press on the red button does not confirm', JSON.stringify(dis.s3));
  await waitOk(page, () => { const inv = window.__game.ctx.inventory; return !inv.ui.disassemblePanel.isConfirming && !!inv.craftProgress(); },
    'holding 분해 for UI_HOLD_CONFIRM_S confirms and starts the 분해', 8000);
  const disEnd = await page.evaluate((uid) => {
    const inv = window.__game.ctx.inventory;
    inv.cancelCraft();
    inv.ui.disassemblePanel.close();
    return { still: !!inv.findItem(uid) };
  }, dis.uid);
  ok(disEnd.still, 'cancelled 분해 leaves the weapon (cleanup)', JSON.stringify(disEnd));

  /* ── 10. persistence ───────────────────────────────────────────────────────────────────────────────────── */
  console.log('persistence');
  await page.evaluate(() => { const inv = window.__game.getSystem('inventory'); if (inv._open) inv.toggleBag(); });
  await sleep(800);
  n0 = await page.evaluate(() => window.__ev['inventory:loadoutSaved'].length);
  await page.evaluate(() => window.__game.ctx.inventory.toggleFavorite('mat_scrap', true));
  await waitOk(page, (n) => window.__ev['inventory:loadoutSaved'].slice(n).some((e) => e.reason === 'favorite'),
    'a ship toggle schedules a loadout save (reason favorite)', 8000, n0);
  const file = await page.evaluate(() => ({
    fav: JSON.parse(localStorage.getItem('scav.s1.loadout') ?? 'null')?.fav ?? null, ids: [...window.__game.ctx.inventory.favoriteDefIds],
  }));
  ok(Array.isArray(file.fav) && JSON.stringify(file.fav) === JSON.stringify(file.ids) && JSON.stringify(file.fav) === JSON.stringify([...file.fav].sort()),
    'scav.s1.loadout carries `fav` = the sorted favourite list', JSON.stringify(file));
  const docs = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    return { crew: 'fav' in inv.captureCrewLoadout(), raid: 'fav' in inv.captureRaidState(), save: Array.isArray(inv.captureLoadoutSave().fav) };
  });
  ok(docs.save && !docs.crew && !docs.raid, 'crew card and raid blob carry no `fav` (favourites are not the kit)', JSON.stringify(docs));
  const san = await page.evaluate(async () => {
    const m = await import('/src/inventory/Loadout.ts');
    const a = m.sanitizeLoadoutSave({ v: 3, slots: {}, bag: [], quick: [], pouch: [], fav: ['b_def', 'a_def', 'a_def', 5, ''] });
    const b = m.sanitizeLoadoutSave({ v: 2, slots: {}, bag: [], quick: [] });
    const c = m.sanitizeLoadoutSave({ v: 3, slots: {}, bag: [], quick: [], pouch: [], fav: [] });
    return { a: a?.fav ?? null, b: b ? 'fav' in b : null, c: c ? 'fav' in c : null };
  });
  ok(JSON.stringify(san.a) === '["a_def","b_def"]' && san.b === false && san.c === false,
    'sanitizeLoadoutSave: fav deduped + sorted + strings only; old / empty documents get no fav field', JSON.stringify(san));

  const savedIds = file.ids;
  await reload();
  const restored = await page.evaluate(() => [...window.__game.ctx.inventory.favoriteDefIds]);
  ok(JSON.stringify(restored) === JSON.stringify(savedIds), 'reload: favourites come back at init from the loadout file', `${JSON.stringify(restored)} vs ${JSON.stringify(savedIds)}`);
  await sleep(1200);   // let the relay welcome settle before feeding documents by hand

  const srv = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    const n = window.__ev['inventory:loadoutSaved'].length;
    const idle = inv.saveTimer === null && !inv.favoritesDirty;
    const doc = { ...inv.captureLoadoutSave(), fav: ['gem_amber'] };
    inv.onProfileLoaded({ docs: { stash: inv.stash.saveFile(), loadout: doc } });
    return { idle, ids: [...inv.favoriteDefIds], reasons: window.__ev['inventory:loadoutSaved'].slice(n).map((e) => e.reason) };
  });
  ok(srv.idle && JSON.stringify(srv.ids) === '["gem_amber"]' && !srv.reasons.includes('profile'),
    'a server document that differs only in `fav` replaces the favourites and does not rebuild / re-save the kit', JSON.stringify(srv));
  const guard = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    inv.toggleFavorite('mat_scrap', true);   // outside the ship (not entered yet): deferred, dirty
    const dirty = inv.favoritesDirty;
    inv.onProfileLoaded({ docs: { stash: inv.stash.saveFile(), loadout: { ...inv.captureLoadoutSave(), fav: [] } } });
    return { dirty, ids: [...inv.favoriteDefIds] };
  });
  ok(guard.dirty && guard.ids.includes('mat_scrap') && guard.ids.includes('gem_amber'),
    'an arriving document never overwrites a favourite toggle that has not gone up yet', JSON.stringify(guard));
  n0 = await page.evaluate(() => window.__ev['inventory:loadoutSaved'].length);
  await enterHub();
  await waitOk(page, (n) => {
    const f = JSON.parse(localStorage.getItem('scav.s1.loadout') ?? 'null');
    return window.__ev['inventory:loadoutSaved'].slice(n).length > 0 && Array.isArray(f?.fav) && f.fav.includes('mat_scrap') && !window.__game.ctx.inventory.favoritesDirty;
  }, 'hub:entered writes the deferred toggle with the next loadout save', 8000, n0);

  const fatal = errors.filter((e) => !/WebSocket|ws:\/\/|net::ERR|Failed to load resource|favicon/i.test(e));
  ok(fatal.length === 0, 'no page errors', JSON.stringify(fatal.slice(0, 5)));
} catch (e) {
  fail++;
  console.log(`  FAIL crashed: ${e?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\nsmoke-favorites: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
