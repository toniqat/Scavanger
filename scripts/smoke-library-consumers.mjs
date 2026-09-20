// Single-player smoke test for the **서재 시리즈 consumers** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」 — agent C):
//   1. the 「아직 꽂지 않은」 band on item tiles (`.is-shelf-wanted`, same blue ribbon as favourites; favourite + wanted = one band;
//      favourites' own behaviour untouched) — `ctx.housing.isShelfItemWanted` is stubbed so this runs before / without housing's query,
//   2. legacy item id conversion (`resolveItemAlias`) in `reviveItem`, the stash document (a converted stack re-merges), the loadout bag
//      and the favourite list — a temporary alias `smoke_old_scrap → mat_scrap` is added to the live alias map,
//   3. research refund + research XP at a lab bench (추출기 `extract_min`, `derived.researchRefundChance` forced to 1 / 0),
//      with the 제작 숙련 refund (2026-09-16, `shared/craftRefund.ts`) held at skill 0 so those two cases see the research roll
//      alone, plus one deterministic `refundAfterCraft(…, rng)` run where both rolls fire and still deliver ONE toast,
//   4. item tooltip lines for a series book and a game disc (skipped with a note when those defs are not in the data yet),
//   5. contract trust × `libraryTrustMul` and raid-end XP × `1 + raidXp` with a stubbed `getLibraryEffects`,
//   6. the dev console `library` command.
// Usage: node scripts/smoke-library-consumers.mjs [http://localhost:5273/]   (needs a vite dev server)
// ⚠ Every `/src/…` module this file pulls in goes through `window.__imp` (installed in `boot`) — never through a
//   bare `import('/src/…')`. On a dev server that has seen an edit, vite stamps the app's own imports and a bare
//   specifier evaluates a *second* copy of the module; stubbing / mutating that copy changes nothing the app sees.
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
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
const skip = (label) => console.log(`  skip ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
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
  page.setDefaultTimeout(120000);
  await page.evaluateOnNewDocument(() => {
    // `window.__imp` (below) picks the module URL this document actually fetched — it needs every entry.
    try { performance.setResourceTimingBufferSize(20000); } catch { /* old browser */ }
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['ui:notify', 'console:executed', 'meta:contractSettled'];
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
    await page.evaluate((names) => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      // ⚠ `import('/src/shared/library.ts')` is NOT the app's module (2026-09-14). Once any file has been
      // edited while the vite dev server was up, vite's importAnalysis rewrites the imports it owns with an
      // invalidation stamp (`/src/shared/library.ts?t=1789354142878`) and that stamp survives a full page
      // reload — it lives in the server's module graph, not in the page. A literal, unstamped specifier typed
      // here is fetched as-is and evaluates a **second instance**: its `ITEM_ALIASES` is a different Map, so
      // `ITEM_ALIASES.set(…)` below would be invisible to `ctx.loot` / `reviveItem`. (That is exactly what made
      // the four alias rows red on a 4-day-old dev server while a freshly started one was green.)
      // So always import the URL this document really fetched for that path; bare path only as a fallback.
      window.__impUrl = {};
      window.__imp = (path) => {
        const hit = performance.getEntriesByType('resource').map((e) => e.name)
          .find((n) => { try { return new URL(n).pathname === path; } catch { return false; } });
        window.__impUrl[path] = hit ?? path;
        return import(hit ?? path);
      };
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of names) {
        window.__ev[n] = [];
        bus.on(n, (p) => { try { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : (v && v.uid && v.defId) ? { defId: v.defId, qty: v.qty } : v))); } catch { window.__ev[n].push({}); } });
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
  const closeInv = async () => {
    await page.evaluate(() => { const s = window.__game.getSystem('inventory'); if (s._open) s.toggleBag(); });
    await waitFor(page, () => !window.__game.getSystem('inventory')._open, 'window closed', 5000);
  };

  /* ── 0. fresh character ─────────────────────────────────────────────────────────────────────────────────── */
  console.log('fresh profile');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { for (const k of ['scav.s1.loadout', 'scav.s1.stash', 'scav.s1.grant', 'scav.s1.sessionToken']) localStorage.removeItem(k); });
  await reload();
  await enterHub();
  await sleep(1200);   // a relay welcome (if any) lands before we start editing
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; for (const id of [...inv.favoriteDefIds]) inv.toggleFavorite(id, false); });

  /* ── 1. 「아직 꽂지 않은」 band ──────────────────────────────────────────────────────────────────────────── */
  console.log('shelf band');
  const b0 = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, h = ctx.housing;
    const defs = ctx.loot.getAllItemDefs();
    const book = defs.find((d) => d.book && !d.retired) ?? defs.find((d) => d.book);
    if (!book) return null;
    const native = typeof h.isShelfItemWanted === 'function' ? h.isShelfItemWanted.bind(h) : null;
    let nativeFresh = null;
    try { nativeFresh = native ? native(book.id) : null; } catch { nativeFresh = 'threw'; }
    window.__wanted = new Set([book.id]);
    h.isShelfItemWanted = (id) => window.__wanted.has(id);
    const item = ctx.loot.createItem(book.id, 1);
    const added = inv.tryAddToStash(item);
    ctx.bus.emit('housing:libraryChanged', { revision: 9001 });
    return { book: book.id, added, uid: item.uid, native: !!native, nativeFresh, holder: (h.state?.furniture ?? []).some((p) => /shelf|stand|rack/.test(p.defId)) };
  });
  if (!b0) {
    ok(false, 'a book item def exists');
  } else {
    if (b0.native && !b0.holder) ok(b0.nativeFresh === false, 'native isShelfItemWanted: fresh ship without a 보관함 → no band', JSON.stringify(b0));
    else skip(`native isShelfItemWanted check (native ${b0.native}, holder ${b0.holder})`);
    const BOOK = b0.book;
    const stashTile = await page.evaluate((def) => {
      const p = window.__game.ctx.inventory.getStash().items().find((x) => x.item.defId === def);
      return p ? `.inv-grid-stash .inv-tile[data-uid="${p.item.uid}"]` : null;
    }, BOOK);
    await openInv();
    await waitOk(page, (s) => !!s && !!document.querySelector(s)?.classList.contains('is-shelf-wanted'), 'an unshelved book (holder owned) carries .is-shelf-wanted', 10000, stashTile);
    const r1 = await page.evaluate((s) => {
      const t = document.querySelector(s);
      const b = t ? getComputedStyle(t, '::before') : null;
      return { fav: !!t?.classList.contains('is-favorite'), before: b?.content, bg: b?.backgroundImage };
    }, stashTile);
    ok(!r1.fav && r1.before && r1.before !== 'none' && /gradient/.test(r1.bg ?? ''), 'the band is the blue ::before ribbon — without being a favourite', JSON.stringify(r1));
    const semantics = await page.evaluate((def) => {
      const inv = window.__game.ctx.inventory;
      const tile = inv.buildItemTile(def, 1);
      return { isFav: inv.isFavorite(def), ids: [...inv.favoriteDefIds], standalone: tile.classList.contains('is-shelf-wanted') };
    }, BOOK);
    ok(!semantics.isFav && !semantics.ids.includes(BOOK), 'wanted does not make the kind a favourite (sort · filter · confirm stay on real favourites)', JSON.stringify(semantics));
    ok(semantics.standalone, 'buildItemTile (기업 상점 tiles) carries the band too', JSON.stringify(semantics));
    // favourite AND wanted → still one band
    await page.evaluate((def) => window.__game.ctx.inventory.toggleFavorite(def, true), BOOK);
    await waitOk(page, (s) => !!document.querySelector(s)?.classList.contains('is-favorite'), 'favourite toggle repaints', 5000, stashTile);
    const r2 = await page.evaluate((s) => {
      const t = document.querySelector(s);
      return { fav: t.classList.contains('is-favorite'), wanted: t.classList.contains('is-shelf-wanted'), before: getComputedStyle(t, '::before').content, after: getComputedStyle(t, '::after').content };
    }, stashTile);
    ok(r2.fav && r2.wanted && r2.before !== 'none' && (r2.after === 'none' || r2.after === 'normal'), 'favourite + wanted = one band (one ::before, no second ribbon)', JSON.stringify(r2));
    await page.evaluate((def) => window.__game.ctx.inventory.toggleFavorite(def, false), BOOK);
    // shelved (or no holder): the query answers false → band gone after housing:libraryChanged
    await page.evaluate(() => { window.__wanted.clear(); window.__game.ctx.bus.emit('housing:libraryChanged', { revision: 9002 }); });
    await waitOk(page, (s) => { const t = document.querySelector(s); return !!t && !t.classList.contains('is-shelf-wanted') && !t.classList.contains('is-favorite') && getComputedStyle(t, '::before').content === 'none'; },
      'shelved / no holder → the band disappears on housing:libraryChanged (no grid change needed)', 5000, stashTile);
    await page.evaluate(() => { window.__wanted.add('__none__'); window.__wanted.clear(); });
    await closeInv();
    await page.evaluate(() => { delete window.__game.ctx.housing.isShelfItemWanted; window.__game.ctx.bus.emit('housing:libraryChanged', { revision: 9003 }); });
  }

  /* ── 2. legacy id conversion ────────────────────────────────────────────────────────────────────────────── */
  console.log('alias conversion');
  const al = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    const lib = await window.__imp('/src/shared/library.ts');
    const ser = await window.__imp('/src/inventory/Serialize.ts');
    const lo = await window.__imp('/src/inventory/Loadout.ts');
    const inv = window.__game.getSystem('inventory');
    const real = [...lib.ITEM_ALIASES.entries()].find(([, to]) => !!ctx.loot.getItemDef(to)) ?? null;
    lib.ITEM_ALIASES.set('smoke_old_scrap', 'mat_scrap');
    const out = { real };
    try {
      // the map we just wrote to must be the one the app reads — if this is false every row below is red for
      // the same reason and it is a module-instance problem, not an alias problem (see `window.__imp`).
      out.live = { url: window.__impUrl['/src/shared/library.ts'], seen: !!ctx.loot.getItemDef('smoke_old_scrap') };
      out.stackMax = ctx.loot.getItemDef('mat_scrap')?.stackMax ?? 0;
      out.revived = ser.reviveItem({ defId: 'smoke_old_scrap', qty: 2 }, (id) => ctx.loot.getItemDef(id), ctx.loot, 'smoke')?.defId ?? null;
      // stash document
      const backup = inv.stash.saveFile();
      const items = [
        { defId: 'mat_scrap', qty: 3, rotated: false, x: 0, y: 0 },
        { defId: 'smoke_old_scrap', qty: 2, rotated: false, x: 6, y: 6 },
      ];
      if (real) items.push({ defId: real[0], qty: 1, rotated: false, x: 0, y: 12 });
      inv.stash.loadFrom({ ...backup, items });
      out.stash = inv.stash.grid.items().map((p) => ({ def: p.item.defId, qty: p.item.qty, x: p.x, y: p.y }));
      inv.stash.loadFrom(backup);
      // loadout bag + favourites
      const kit = inv.captureLoadoutSave();
      const doc = lo.sanitizeLoadoutSave({ ...kit, bag: [
        { defId: 'mat_scrap', qty: 3, rotated: false, x: 0, y: 0 },
        { defId: 'smoke_old_scrap', qty: 2, rotated: false, x: 2, y: 3 },
      ], fav: ['smoke_old_scrap', 'gem_amber'] });
      out.fav = doc.fav;
      inv.applyLoadoutSave(doc);
      out.bag = inv.bag.items().map((p) => ({ def: p.item.defId, qty: p.item.qty, x: p.x, y: p.y }));
      inv.applyLoadoutSave(lo.sanitizeLoadoutSave(kit));
      inv.afterChange?.();
    } finally {
      lib.ITEM_ALIASES.delete('smoke_old_scrap');
    }
    return out;
  });
  ok(al.live?.seen, 'the alias map the smoke writes to is the one the app reads (one live module instance)', JSON.stringify(al.live));
  ok(al.revived === 'mat_scrap', 'reviveItem runs a saved id through the alias table', JSON.stringify(al.revived));
  const scrapStash = (al.stash ?? []).filter((e) => e.def === 'mat_scrap');
  ok(al.stackMax >= 5 && scrapStash.length === 1 && scrapStash[0].qty === 5 && !(al.stash ?? []).some((e) => e.def === 'smoke_old_scrap'),
    'stash document: the converted stack re-merges into the stack of its new id', JSON.stringify(al.stash));
  if (al.real) ok((al.stash ?? []).some((e) => e.def === al.real[1]), `stash document: real alias ${al.real[0]} → ${al.real[1]}`, JSON.stringify(al.stash));
  else skip('real alias rows (data/item_aliases.csv is still empty)');
  const scrapBag = (al.bag ?? []).filter((e) => e.def === 'mat_scrap');
  ok(scrapBag.length === 1 && scrapBag[0].qty === 5, 'loadout bag: converted stack re-merges', JSON.stringify(al.bag));
  ok(JSON.stringify(al.fav) === '["gem_amber","mat_scrap"]', 'favourite list: old ids become new ids (deduped, sorted)', JSON.stringify(al.fav));

  /* ── 3. research refund + XP ────────────────────────────────────────────────────────────────────────────── */
  console.log('research refund');
  const units = await page.evaluate(async () => {
    const C = await window.__imp('/src/inventory/parts/Crafting.ts');
    return [C.researchRefundQty(1, 0.5), C.researchRefundQty(4, 0.5), C.researchRefundQty(3, 0.1), C.researchRefundQty(2, 1), C.researchRefundQty(6, 0), C.researchRefundQty(0, 0.5)];
  });
  ok(JSON.stringify(units) === '[1,2,1,2,1,0]', 'refund qty per ingredient = min(qty, max(1, round(qty × frac)))', JSON.stringify(units));
  const setup = await page.evaluate(async () => {
    const ctx = window.__game.ctx, inv = ctx.inventory, prog = ctx.progression;
    const K = await window.__imp('/src/shared/constants.ts');
    const CR = await window.__imp('/src/shared/craftRefund.ts');
    /*
     * 2026-09-16 (user's decision 「숙련은 재료 환급에만 관여」): when a craft finishes there are **two** refund rolls —
     * the crafting skill (one per material unit) + the research skill (one per run), and the grant and the toast
     * happen once (`Crafting.refundAfterCraft`). What this section watches is the **research side**, so the crafting
     * skill is dropped to 0 to switch ① off (`craftRefundChance(0) === 0`). Raising the crafting skill to 12 here in
     * the past was for the old `skillRequired` gate, and that column in `data/recipes.csv` is all 0 now, so there is
     * no reason to raise it. Whether the two fold into one line when they overlap is what `refundAfterCraft` below
     * checks.
     */
    prog.addSkillXpRaw('crafting', -1e6);
    const r = ctx.loot.getAllRecipes().find((x) => x.id === 'extract_min');
    if (!r) return { error: 'no extract_min recipe' };
    window.__derivedDesc = Object.getOwnPropertyDescriptor(prog, 'derived') ?? null;
    window.__realDerived = prog.derived;
    window.__refundStub = { chance: 1, frac: 0.5 };
    Object.defineProperty(prog, 'derived', {
      configurable: true, enumerable: true,
      get: () => ({ ...window.__realDerived, researchRefundChance: window.__refundStub.chance, researchRefundFrac: window.__refundStub.frac }),
      set: (v) => { window.__realDerived = v; },
    });
    window.__xpCalls = [];
    window.__origAddSkillXp = Object.getOwnPropertyDescriptor(prog, 'addSkillXp') ?? null;
    const orig = prog.addSkillXp.bind(prog);
    prog.addSkillXp = (id, n) => { window.__xpCalls.push([id, n]); try { return orig(id, n); } catch { return undefined; } };
    inv.openBenchCraft('extract', 3);
    const cost = inv.craftCost(r);
    for (const c of cost) {
      let left = c.qty * 3;
      const max = ctx.loot.getItemDef(c.defId)?.stackMax ?? 1;
      while (left > 0) { const n = Math.min(max, left); inv.tryAddItem(ctx.loot.createItem(c.defId, n)); left -= n; }
    }
    return { cost, skill: prog.getSkill('crafting'), xpConst: K.RESEARCH_XP_CRAFT, can: inv.canCraft('extract_min', 2),
      chance0: CR.craftRefundChance(0), chanceMax: CR.craftRefundChance(K.SKILL_LEVEL_MAX), refundable: (await window.__imp('/src/items/index.ts')).isCraftRefundable(r) };
  });
  if (setup.error) ok(false, 'research refund setup', setup.error);
  else {
    ok(setup.can, 'extract_min is craftable at 추출기 Lv.3 with 2 runs of materials', JSON.stringify(setup));
    // 2026-09-16: crafting skill 0 = no refund. This section can only watch the research side while that property
    // holds (`shared/craftRefund.ts`)
    ok(setup.skill === 0 && setup.chance0 === 0 && setup.chanceMax > 0 && setup.refundable === true,
      'craftRefundChance(0) === 0 (skill 0 → 제작 숙련 환급 없음), > 0 at SKILL_LEVEL_MAX; extract_min is refundable gear-free', JSON.stringify(setup));
    const runCraft = (count) => page.evaluate(async (n) => {
      const ctx = window.__game.ctx, inv = ctx.inventory;
      const r = ctx.loot.getAllRecipes().find((x) => x.id === 'extract_min');
      const cost = inv.craftCost(r);
      const before = Object.fromEntries(cost.map((c) => [c.defId, inv.countDef(c.defId)]));
      const n0 = window.__ev['ui:notify'].length, x0 = window.__xpCalls.length;
      const made = await inv.craft('extract_min', undefined, n);
      const after = Object.fromEntries(cost.map((c) => [c.defId, inv.countDef(c.defId)]));
      return {
        made: !!made, cost, before, after,
        notes: window.__ev['ui:notify'].slice(n0).map((e) => e.text).filter((t) => /재료 회수/.test(t ?? '')),
        xp: window.__xpCalls.slice(x0).filter((c) => c[0] === 'research'),
        craftXp: window.__xpCalls.slice(x0).filter((c) => c[0] === 'crafting'),
      };
    }, count);
    const a = await runCraft(2);
    const exp = Object.fromEntries(a.cost.map((c) => [c.defId, a.before[c.defId] - c.qty * 2 + 2 * Math.min(c.qty, Math.max(1, Math.round(c.qty * 0.5)))]));
    ok(a.made && JSON.stringify(a.after) === JSON.stringify(exp), 'chance 1 · frac 0.5, 2 runs: each run returns per-ingredient refund to the bag', JSON.stringify({ a, exp }));
    ok(a.notes.length === 1 && a.notes[0].startsWith('재료 회수: '), 'one 「재료 회수: …」 toast', JSON.stringify(a.notes));
    ok(a.xp.length === 1 && a.xp[0][1] === setup.xpConst * 2, 'research XP = RESEARCH_XP_CRAFT × runs', JSON.stringify(a.xp));
    ok(a.craftXp.length === 0, '연구실 작업대 제작은 제작 경험치를 주지 않는다 (사용자 결정 2026-09-13)', JSON.stringify(a.craftXp));
    await page.evaluate(() => { window.__refundStub.chance = 0; });
    const b = await runCraft(1);
    const expB = Object.fromEntries(b.cost.map((c) => [c.defId, b.before[c.defId] - c.qty]));
    ok(b.made && JSON.stringify(b.after) === JSON.stringify(expB) && b.notes.length === 0, 'chance 0: nothing comes back, no toast', JSON.stringify({ b, expB }));
    ok(b.xp.length === 1 && b.xp[0][1] === setup.xpConst, 'research XP still paid on a failed roll', JSON.stringify(b.xp));
    /*
     * 2026-09-16 — **even when the two rolls overlap, the grant and the toast happen once.** The two cases above
     * switched the crafting skill off at 0 and watched only the research side. Here both are on and
     * `refundAfterCraft` is called directly with `rng: () => 0` (the game path uses `Math.random`, so the outcome
     * differs on every roll): 0 is below any chance, so **not one material unit is left behind** and the expected
     * value is pinned to a single line.
     */
    const merged = await page.evaluate(async () => {
      const ctx = window.__game.ctx, inv = ctx.inventory, prog = ctx.progression;
      const C = await window.__imp('/src/inventory/parts/Crafting.ts');
      const CR = await window.__imp('/src/shared/craftRefund.ts');
      const K = await window.__imp('/src/shared/constants.ts');
      const r = ctx.loot.getAllRecipes().find((x) => x.id === 'extract_min');
      prog.addSkillXpRaw('crafting', 1e9);                     // the crafting skill at maximum → ① switches on
      window.__refundStub.chance = 1; window.__refundStub.frac = 0.5;   // research ② switches on too
      const cost = inv.craftCost(r);
      const before = Object.fromEntries(cost.map((c) => [c.defId, inv.countDefAll(c.defId)]));
      const n0 = window.__ev['ui:notify'].length;
      const out = C.refundAfterCraft(inv, r, cost, 1, () => 0);
      const after = Object.fromEntries(cost.map((c) => [c.defId, inv.countDefAll(c.defId)]));
      return {
        skill: prog.getSkill('crafting'), max: K.SKILL_LEVEL_MAX, chance: CR.craftRefundChance(prog.getSkill('crafting')),
        out, before, after,
        exp: Object.fromEntries(cost.map((c) => [c.defId, c.qty + C.researchRefundQty(c.qty, 0.5)])),
        notes: window.__ev['ui:notify'].slice(n0).map((e) => e.text).filter((t) => /재료 회수/.test(t ?? '')),
      };
    });
    const mergedGain = Object.fromEntries(Object.keys(merged.exp).map((k) => [k, merged.after[k] - merged.before[k]]));
    ok(merged.skill === merged.max && merged.chance > 0 && JSON.stringify(mergedGain) === JSON.stringify(merged.exp)
      && JSON.stringify(Object.fromEntries(merged.out.map((o) => [o.defId, o.qty]))) === JSON.stringify(merged.exp),
      '제작 숙련 + 연구 숙련이 겹치면 재료가 한 번에 합쳐져 돌아온다 (per-unit + per-run)', JSON.stringify({ merged, mergedGain }));
    ok(merged.notes.length === 1 && /^재료 회수: .+ · .+$/.test(merged.notes[0]),
      '합쳐진 환급도 「재료 회수: …」 토스트 한 줄', JSON.stringify(merged.notes));
    await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('crafting', -1e9));
  }
  await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, prog = ctx.progression;
    if (window.__derivedDesc) Object.defineProperty(prog, 'derived', { ...window.__derivedDesc, value: window.__realDerived });
    else { delete prog.derived; }
    if (window.__origAddSkillXp) Object.defineProperty(prog, 'addSkillXp', window.__origAddSkillXp); else delete prog.addSkillXp;
    inv.closeBench?.();
  });
  await closeInv().catch(() => {});

  /* ── 4. tooltip ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log('item tooltip');
  const tip = await page.evaluate(async () => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const lib = await window.__imp('/src/shared/library.ts');
    const defs = ctx.loot.getAllItemDefs();
    const read = (defId) => {
      const chip = document.createElement('span');
      chip.className = 'item-chip';
      chip.dataset.defId = defId;
      chip.style.cssText = 'position:fixed;left:10px;top:10px;width:20px;height:20px;z-index:99999';
      ctx.uiRoot.appendChild(chip);
      chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 15, clientY: 15 }));
      // the HUD item card — housing's station tooltip (`ui/StationTip`, `.item-tip.hs-tip`) shares the base class
      const el = document.querySelector('.item-tip:not(.hs-tip)');
      const rows = [...el.querySelectorAll('.itip-stats .k')].map((k) => [k.textContent, k.nextElementSibling?.textContent ?? '']);
      const shown = !el.hidden;
      chip.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
      chip.remove();
      return { shown, rows };
    };
    const out = {};
    const book = defs.find((d) => (d.book ?? d.disc ?? d.record)?.series && lib.LIBRARY_SERIES_MAP.has((d.book ?? d.disc ?? d.record).series));
    if (book) {
      const m = book.book ?? book.disc ?? book.record;
      const s = lib.LIBRARY_SERIES_MAP.get(m.series);
      h.getSeriesProgress = () => ({ have: 2, total: 5, fraction: 0.2 });
      const hadWanted = Object.prototype.hasOwnProperty.call(h, 'isShelfItemWanted');
      if (typeof h.isShelfItemWanted !== 'function') h.isShelfItemWanted = () => true;
      out.book = { id: book.id, series: s.name, volumes: s.volumes, effects: s.effects.length, ...read(book.id) };
      delete h.getSeriesProgress;
      if (!hadWanted) delete h.isShelfItemWanted;
    }
    const plainBook = defs.find((d) => d.book && !d.book.series);
    if (plainBook) out.plain = read(plainBook.id);
    const disc = defs.find((d) => d.gameDisc);
    if (disc) out.disc = { id: disc.id, ...read(disc.id) };
    const cons = defs.find((d) => d.gameConsole);
    if (cons) out.cons = { id: cons.id, ...read(cons.id) };
    return out;
  });
  const has = (rows, k, re) => (rows ?? []).some(([kk, v]) => kk === k && (!re || re.test(v)));
  if (tip.book) {
    const r = tip.book.rows;
    ok(tip.book.shown && has(r, '시리즈', new RegExp(tip.book.series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), 'series book: 시리즈 row', JSON.stringify(tip.book));
    ok(has(r, '권', tip.book.volumes > 1 ? /\/ [IV]+권/ : /단편/), 'series book: 권 row (roman / 단편)', JSON.stringify(r));
    ok(has(r, '진행', /^2\/5권 · 적용 20 %$/), 'series book: 진행 n/N권 · 적용 n % from getSeriesProgress', JSON.stringify(r));
    ok(has(r, '보관', /보관함 없음|아직 꽂지 않음|서재에 꽂혀 있음/), 'series book: 보관 row', JSON.stringify(r));
    ok(has(r, '등장 행성') && has(r, '꽂는 곳', /서재/) && !has(r, '숙련'), 'series book: 등장 행성 + 꽂는 곳, the old 숙련 row is gone', JSON.stringify(r));
    ok(r.length >= 6 + tip.book.effects - 1, 'series book: one row per effect line', JSON.stringify({ n: r.length, effects: tip.book.effects }));
  } else skip('series book tooltip (no series book def in the data yet)');
  if (tip.plain) ok(!has(tip.plain.rows, '숙련') && has(tip.plain.rows, '꽂는 곳'), 'a book without a series: no 숙련 row, 꽂는 곳 stays', JSON.stringify(tip.plain.rows));
  if (tip.disc) {
    const r = tip.disc.rows;
    ok(tip.disc.shown && has(r, '게임기') && has(r, '능력치', /지능|인지력/) && has(r, '방식') && has(r, '사용', /TV 로 플레이/), 'game disc: 게임기 · 능력치 · 방식 · 사용', JSON.stringify(r));
  } else skip('game disc tooltip (no game disc def yet)');
  if (tip.cons) ok(has(tip.cons.rows, '사용', /TV 에 장착/), 'console: 사용 — TV 에 장착', JSON.stringify(tip.cons.rows));
  else skip('console tooltip (no console def yet)');

  /* ── 5. trust + raid XP multipliers ─────────────────────────────────────────────────────────────────────── */
  console.log('trust · raid XP');
  const tr = await page.evaluate(async () => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const lib = await window.__imp('/src/shared/library.ts');
    const Cm = await window.__imp('/src/meta/parts/Contracts.ts');
    const D = await window.__imp('/src/game/parts/Death.ts');
    const meta = window.__game.getSystem('meta');
    const gf = window.__game.getSystem('gameflow');
    const out = {};
    h.getLibraryEffects = () => ({ ...lib.EMPTY_LIBRARY_EFFECTS, trustXp: { all: 0.5, helix: 0.5 }, raidXp: 1, revision: 77 });
    out.mulHelix = Cm.libraryTrustMulOf(meta, 'helix');
    out.mulBastion = Cm.libraryTrustMulOf(meta, 'bastion');
    out.raidMul = D.libraryRaidXpMul(ctx);
    // a real settlement
    if (ctx.meta.activeContract) ctx.meta.abandonContract();
    // 2026-09-17: every contract starts at 신뢰도 Lv.1 (contracts.csv minRepLevel +1)
    if (ctx.meta.getRep('helix').level < 1) ctx.meta.addRep('helix', 100, 'smoke');
    out.accepted = ctx.meta.acceptContract('helix_1');
    const def = meta.activeDef?.();
    if (out.accepted && def) {
      meta.store.data.activeContract.progress = def.target;
      const repBefore = ctx.meta.getRep ? null : null;
      const s = ctx.meta.settleMission({ ...ctx.stats, mode: 'raid', extracted: true });
      out.settle = { success: s?.success, rep: s?.rep, base: def.repReward };
    }
    // raid-end XP (no active contract now → settleMission returns null inside)
    if (ctx.meta.activeContract) ctx.meta.abandonContract();
    const st = ctx.stats;
    const keep = { kills: st.kills, killXp: st.killXp, timeSeconds: st.timeSeconds, extracted: st.extracted, lootValue: st.lootValue, rewards: st.rewards };
    // 2026-09-16: raid XP = `stats.killXp` only (× XP_DEATH_MUL when not extracted) — kill count, time and loot pay nothing
    Object.assign(st, { kills: 10, killXp: 100, timeSeconds: 0, extracted: false, lootValue: 0 });
    gf.rewarded = false; D.awardMissionXp(gf); out.xpWith = st.rewards?.xpEarned ?? null;
    delete h.getLibraryEffects;
    out.raidMulPlain = D.libraryRaidXpMul(ctx);
    out.mulPlain = Cm.libraryTrustMulOf(meta, 'helix');
    gf.rewarded = false; D.awardMissionXp(gf); out.xpPlain = st.rewards?.xpEarned ?? null;
    out.deathMul = (await window.__imp('/src/shared/constants.ts')).XP_DEATH_MUL;
    // extracted after an hour with a valuable bag: still exactly the kill XP (no extraction / loot / survival-time terms)
    Object.assign(st, { kills: 3, killXp: 100, timeSeconds: 3600, extracted: true, lootValue: 50000 });
    gf.rewarded = false; D.awardMissionXp(gf); out.xpExtract = st.rewards?.xpEarned ?? null;
    Object.assign(st, { kills: 3, killXp: 0, timeSeconds: 3600, extracted: true, lootValue: 50000 });
    gf.rewarded = false; D.awardMissionXp(gf); out.xpNoKillXp = st.rewards?.xpEarned ?? null;
    Object.assign(st, keep);
    gf.rewarded = false;
    return out;
  });
  ok(tr.mulHelix === 2 && tr.mulBastion === 1.5 && tr.raidMul === 2, 'libraryTrustMulOf (all + corp) and libraryRaidXpMul read the summary', JSON.stringify(tr));
  ok(tr.mulPlain === 1 && tr.raidMulPlain === 1, 'without getLibraryEffects both multipliers are 1', JSON.stringify(tr));
  if (tr.settle) ok(tr.settle.success && tr.settle.rep === Math.round(tr.settle.base * 2), 'contract settlement rep × trust multiplier (helix: all 0.5 + helix 0.5)', JSON.stringify(tr.settle));
  else ok(false, 'contract helix_1 accepted for the settlement check', JSON.stringify(tr));
  ok(tr.xpPlain > 0 && tr.xpWith === tr.xpPlain * 2, 'raid-end XP × (1 + raidXp)', JSON.stringify({ with: tr.xpWith, plain: tr.xpPlain }));
  ok(tr.deathMul > 0 && tr.xpPlain === Math.round(100 * tr.deathMul), 'not extracted: raid-end XP = killXp × XP_DEATH_MUL', JSON.stringify({ plain: tr.xpPlain, deathMul: tr.deathMul }));
  ok(tr.xpExtract === 100 && tr.xpNoKillXp === 0, 'extracted: raid-end XP = killXp only (no loot / extraction / survival-time XP)', JSON.stringify({ extract: tr.xpExtract, noKillXp: tr.xpNoKillXp }));

  /* ── 6. console ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log('console library');
  const con = await page.evaluate(async () => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const lib = await window.__imp('/src/shared/library.ts');
    if (!ctx.console?.enabled) return null;
    const run = async (line) => {
      const n = window.__ev['console:executed'].length;
      ctx.console.run(line);
      for (let i = 0; i < 20 && window.__ev['console:executed'].length === n; i++) await new Promise((r) => setTimeout(r, 50));
      return window.__ev['console:executed'][n] ?? null;
    };
    h.getLibraryEffects = () => ({ ...lib.EMPTY_LIBRARY_EFFECTS, raidXp: 0.1, trustXp: { all: 0.08 }, revision: 5 });
    const summary = await run('library');
    delete h.getLibraryEffects;
    const bad = await run('library give no_such_series');
    const defs = ctx.loot.getAllItemDefs();
    const series = lib.LIBRARY_SERIES_DEFS.find((s) => defs.some((d) => (d.book ?? d.disc ?? d.record)?.series === s.id));
    let give = null;
    if (series) {
      const count = () => ctx.inventory.getStash().items().filter((p) => { const d = ctx.loot.getItemDef(p.item.defId); return (d?.book ?? d?.disc ?? d?.record)?.series === series.id; }).length;
      const before = count();
      const res = await run(`library give ${series.id} 1`);
      give = { res, added: count() - before };
    }
    return { summary, bad, give };
  });
  if (!con) skip('console (not a dev host)');
  else {
    ok(!!con.summary?.ok && /레이드 경험치 \+10 %/.test(con.summary.output) && /모든 기업 \+8 %/.test(con.summary.output), '/library prints the effect summary', JSON.stringify(con.summary));
    ok(!!con.bad && con.bad.ok === false && /알 수 없는 시리즈/.test(con.bad.output), '/library give <unknown> → red line', JSON.stringify(con.bad));
    if (con.give) ok(con.give.res?.ok && con.give.added === 1, '/library give <series> 1 puts vol. 1 into the stash', JSON.stringify(con.give));
    else skip('/library give (no series item defs yet)');
  }

  const fatal = errors.filter((e) => !/WebSocket|ws:\/\/|net::ERR|Failed to load resource|favicon/i.test(e));
  ok(fatal.length === 0, 'no page errors', JSON.stringify(fatal.slice(0, 5)));
} catch (e) {
  fail++;
  console.log(`  FAIL crashed: ${e?.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke-library-consumers: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
