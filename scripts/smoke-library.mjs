// Single-player smoke test for the Phase 9 서재 책장 (src/housing + src/items + src/hub): the 14 book item defs and
// where they drop, the 서재 room purpose and the `furn_bookshelf` craft / place, `placeBook` / `takeBook` (bag → stash
// order, refusals, `housing:booksChanged`), the 도감 (`bookDex`), the bonus maths (`getBookBonus`, cap, folded into
// `getSkillGainMul`), recovering a shelf that still holds books, the v3 save round-trip + corrupt-save sanitising and
// the 책장 panel / 함선 tab 도감 DOM.
// Usage: node scripts/smoke-library.mjs [http://localhost:5273]   (needs `npm run dev`)
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

/* Phase 9 constants (src/shared/constants.ts) — asserted as literals so a silent retune is caught here. */
const BOOKS_PER_SHELF = 6;
const BOOK_XP_PER_BOOK = 0.05;
/* src/shared/constants.ts 의 SHIP_STATE_VERSION — 세이브 스키마가 바뀔 때마다 올라간다
   (4 = 온실 개편의 `grows`, 5 = 연구실의 `analyses` · `sampleDex`). */
const SHIP_STATE_VERSION = 5;
const BOOK_RARITY_MUL = { common: 1, uncommon: 1.5, rare: 2.5, epic: 4, legendary: 6 };
const BOOK_GAIN_MAX = 2.0;
const near = (a, b) => Math.abs(a - b) < 1e-9;

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
  });
  // Park vite's HMR socket (another agent's save would full-reload the page) AND the relay socket (`/ws?t=`): this is a
  // single-player script — a relay that happens to run on 8787 would otherwise hand the page a server profile and
  // replace the ship / stash documents mid-run.
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  // The hub's `ensureConnected` dials the relay through the vite proxy; without `npm run server` Chrome logs one
  // "WebSocket connection … failed" line. That is the relay's absence, not a 서재 signal — ignore only that line.
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

  // Runs after every navigation: frame pump for a hidden tab, fake pointer lock, event recorder.
  const setup = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot');
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['housing:loaded', 'housing:changed', 'housing:booksChanged', 'housing:furniturePlaced', 'housing:furnitureRecovered',
        'housing:roomPurposeChanged', 'ui:bookshelfToggled', 'ui:housingToggled', 'ui:notify']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
      }
    });
  };
  // Key taps: keydown + keyup in one evaluate on document.body (dt is clamped to 50 ms — any wait reads as a hold).
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  // headless rendering may run at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const H = (fn, arg) => page.evaluate(fn, arg);
  // Put `qty` units of a material into the bag in def-sized stacks (mat_* stackMax is 10). Returns units actually added.
  const give = (defId, qty) => H(({ defId, qty }) => {
    const ctx = window.__game.ctx;
    if (!ctx.loot.getItemDef(defId)) return -1;
    const max = ctx.loot.getItemDef(defId).stackMax ?? 1;
    let added = 0;
    while (added < qty) {
      const n = Math.min(max, qty - added);
      if (!ctx.inventory.tryAddItem(ctx.loot.createItem(defId, n))) break;
      added += n;
    }
    return added;
  }, { defId, qty });
  /** Drop `n` copies of a book straight into the stash (10×24, always roomy) — the picker reads bag + stash. */
  const giveStash = (defId, n) => H(({ defId, n }) => {
    const ctx = window.__game.ctx;
    let added = 0;
    for (let i = 0; i < n; i++) if (ctx.inventory.tryAddToStash(ctx.loot.createItem(defId, 1))) added++;
    return added;
  }, { defId, n });
  const countAll = (defId) => H((d) => window.__game.ctx.inventory.countDefAll(d), defId);
  const countBag = (defId) => H((d) => window.__game.ctx.inventory.getAllItems().filter((i) => i.defId === d).length, defId);
  const countStash = (defId) => H((d) => window.__game.ctx.inventory.getStashItems().filter((i) => i.defId === d).length, defId);
  const bonus = (skill) => H((s) => window.__game.ctx.housing.getBookBonus(s), skill);

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  // fresh ship + stash so the run is deterministic, then reload so the housing system boots from the fresh state
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await setup();

  /* ══ 1. book item data (items/) ═════════════════════════════════════════ */
  console.log('book defs');
  const books = await H(() => window.__game.ctx.loot.getAllItemDefs().filter((d) => d.category === 'book')
    .map((d) => ({ id: d.id, name: d.name, rarity: d.rarity, skill: d.book?.skill ?? null, stackMax: d.stackMax, w: d.width, h: d.height, weight: d.weight, value: d.value, icon: d.icon, color: d.color })));
  const skillIds = await H(() => window.__game.ctx.progression.getAllSkillDefs().map((d) => d.id));
  ok(books.length === 14, `14 서적 defs with category 'book' (${books.length})`);
  ok(books.every((b) => /^book_/.test(b.id)), 'every book id is `book_<skill>`', books.map((b) => b.id).join(','));
  ok(books.every((b) => b.skill && skillIds.includes(b.skill)), 'every book teaches a real skill id', JSON.stringify(books.filter((b) => !skillIds.includes(b.skill))));
  ok(new Set(books.map((b) => b.skill)).size === 14 && skillIds.every((s) => books.some((b) => b.skill === s)), 'one book per skill, all 14 skills covered');
  ok(books.every((b) => b.id === `book_${b.skill}`), 'id matches the skill it teaches');
  ok(books.every((b) => /[가-힣]/.test(b.name) && b.name.includes('『')), '한국어 book names in 『』', books.map((b) => b.name).join(' '));
  ok(books.every((b) => b.stackMax === 1), 'stackMax 1 (books never stack)');
  ok(books.every((b) => b.w === 1 && b.h === 2 && b.weight === 0.6), 'every book is 1×2 and weighs 0.6 kg');
  ok(books.every((b) => BOOK_RARITY_MUL[b.rarity] > 0), 'every rarity has a BOOK_RARITY_MUL weight', books.map((b) => b.rarity).join(','));
  const byRarity = books.reduce((m, b) => (m[b.rarity] = (m[b.rarity] ?? 0) + 1, m), {});
  ok(byRarity.common === 4 && byRarity.uncommon === 5 && byRarity.rare === 3 && byRarity.epic === 2 && !byRarity.legendary,
    `rarity spread common 4 / uncommon 5 / rare 3 / epic 2 (${JSON.stringify(byRarity)})`);
  ok(books.every((b) => b.value > 0), 'every book has a sale value for the 세레스 상점', JSON.stringify(books.map((b) => b.value)));
  const labels = await H(() => {
    const chip = window.__game.ctx.loot.getAllItemDefs().find((d) => d.category === 'book');
    return { icon: chip.icon, color: chip.color };
  });
  ok(labels.icon === '▤' && labels.color.toLowerCase() === '#c9a77a', `'book' category icon / colour resolve (${labels.icon} ${labels.color})`);
  const recipeBooks = await H(() => window.__game.ctx.loot.getAllRecipes().filter((r) => String(r.output?.defId ?? r.outputDefId ?? '').startsWith('book_')).length);
  ok(recipeBooks === 0, `no craft recipe produces a book (${recipeBooks})`);

  console.log('books in the loot tables');
  const crates = await H(() => {
    const out = {};
    for (const tier of [1, 2, 3, 4]) {
      let n = 0;
      for (let i = 0; i < 300; i++) n += window.__game.ctx.loot.rollCrate(tier).filter((it) => window.__game.ctx.loot.getItemDef(it.defId)?.category === 'book').length;
      out[tier] = n;
    }
    return out;
  });
  ok(crates[2] > 0 && crates[3] > 0 && crates[4] > 0, `tier 2 / 3 / 4 containers roll books (${JSON.stringify(crates)})`);
  ok(crates[1] === 0, `tier 1 보급 상자 never rolls a book (${crates[1]})`);
  const corpses = await H(() => {
    const out = {};
    for (const type of ['rogue', 'rogue_boss', 'warrior']) {
      let n = 0;
      for (let i = 0; i < 400; i++) n += window.__game.ctx.loot.rollCorpse(type).filter((it) => window.__game.ctx.loot.getItemDef(it.defId)?.category === 'book').length;
      out[type] = n;
    }
    return out;
  });
  ok(corpses.rogue > 0 && corpses.rogue_boss > 0, `로그 시체 drop books (rogue ${corpses.rogue} / boss ${corpses.rogue_boss} of 400)`);
  ok(corpses.rogue_boss > corpses.rogue, `보스 시체 carry books far more often (${corpses.rogue_boss} vs ${corpses.rogue})`);
  ok(corpses.warrior === 0, `bug corpses never carry a book (${corpses.warrior})`);

  /* ══ 2. 서재 room + 책장 furniture ═══════════════════════════════════════ */
  console.log('hub / 서재');
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.5);
  const shelfDef = await H(() => window.__game.ctx.housing.getFurnitureDef('furn_bookshelf'));
  ok(shelfDef && shelfDef.room === 'library' && shelfDef.interaction === 'bookshelf' && shelfDef.model === 'bookshelf' && shelfDef.cols === 2 && shelfDef.rows === 1,
    `furn_bookshelf def: 서재 only, 2×1, interaction / model 'bookshelf' (${JSON.stringify(shelfDef && { room: shelfDef.room, i: shelfDef.interaction, m: shelfDef.model })})`);
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('library').some((d) => d.id === 'furn_bookshelf')
    && !window.__game.ctx.housing.getFurnitureFor('gym').some((d) => d.id === 'furn_bookshelf')), '책장 only in the 서재 catalogue');
  // Phase 9 UI pass: a 시설 증축 costs materials and needs 발전기 Lv.1 — pay for the 서재 before assigning it.
  const scrap = await give('mat_scrap', 40);
  const alloy = await give('mat_alloy', 10);
  const cable = await give('mat_cable', 6);
  ok(scrap === 40 && alloy === 10 && cable === 6, `materials in the bag (폐금속 ${scrap}, 합금 ${alloy}, 케이블 ${cable})`);
  ok(await H(() => window.__game.ctx.housing.upgrade('generator') === true), '발전기 → 1 (시설 증축의 전제)');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'library') === true), '방 4 → 서재 (폐금속 10 + 합금 2)');
  ok((await lastEv('housing:roomPurposeChanged'))?.purpose === 'library', 'housing:roomPurposeChanged {library}');
  const craftInfo = await H(() => window.__game.ctx.housing.canCraftFurniture('furn_bookshelf'));
  ok(craftInfo.ok === true && craftInfo.missing.length === 0, 'canCraftFurniture(furn_bookshelf) with 폐금속 6 + 합금 1');
  ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_bookshelf') && window.__game.ctx.housing.craftFurniture('furn_bookshelf')), 'craftFurniture(furn_bookshelf) ×2');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bookshelf', 0, 0, 0) === false && window.__game.ctx.housing.canPlace(3, 'furn_bookshelf', 0, 0, 0) === true),
    'canPlace: 책장 refused in a 빈 방, allowed in the 서재');
  const shelfA = await H(() => window.__game.ctx.housing.place(3, 'furn_bookshelf', 0, 0, 0)?.uid ?? null);
  const shelfB = await H(() => window.__game.ctx.housing.place(3, 'furn_bookshelf', 0, 2, 0)?.uid ?? null);
  ok(!!shelfA && !!shelfB && shelfA !== shelfB, `two 책장 placed in the 서재 (${shelfA}, ${shelfB})`);
  ok((await lastEv('housing:furniturePlaced'))?.item?.defId === 'furn_bookshelf', 'housing:furniturePlaced {furn_bookshelf}');
  const slots0 = await H((u) => window.__game.ctx.housing.getBooks(u), shelfA);
  ok(slots0.length === BOOKS_PER_SHELF && slots0.every((s, i) => s.slot === i && s.defId === null && s.skill === null && s.rarity === null && s.weight === 0),
    `getBooks → ${BOOKS_PER_SHELF} empty slots (${slots0.length})`);
  ok((await H(() => window.__game.ctx.housing.getBooks('f-999'))).length === 0, 'getBooks on a uid that is not a 책장 → []');
  ok((await H(() => window.__game.ctx.housing.getBooks(window.__game.ctx.housing.getPlaced(0)[0]?.uid ?? 'x'))).length === 0, 'getBooks on a non-책장 piece → []');

  /* ══ 3. shelving ═══════════════════════════════════════════════════════ */
  console.log('placeBook');
  ok((await H(() => window.__game.ctx.housing.getOwnedBooks())).length === 0, 'getOwnedBooks empty before any book is owned');
  ok(await give('book_gun_AR', 2) === 2, '2× 『사격 교본: 돌격소총』 into the bag');
  const owned0 = await H(() => window.__game.ctx.housing.getOwnedBooks());
  ok(owned0.length === 1 && owned0[0].defId === 'book_gun_AR' && owned0[0].qty === 2, `getOwnedBooks → book_gun_AR ×2 (${JSON.stringify(owned0)})`);
  const bagBefore = await countBag('book_gun_AR');
  const putA = await H((u) => window.__game.ctx.housing.placeBook(u, 0, 'book_gun_AR'), shelfA);
  ok(putA === null, `placeBook slot 0 → null (${putA})`);
  ok((await countBag('book_gun_AR')) === bagBefore - 1, `the book left the bag (${bagBefore} → ${await countBag('book_gun_AR')})`);
  const bc = await lastEv('housing:booksChanged');
  ok(bc && bc.uid === shelfA && bc.count === 1, `housing:booksChanged {uid, count 1} (${JSON.stringify(bc)})`);
  ok((await lastEv('housing:changed'))?.reason === 'bookPlace', "housing:changed {reason: 'bookPlace'}");
  const s0 = (await H((u) => window.__game.ctx.housing.getBooks(u), shelfA))[0];
  ok(s0.defId === 'book_gun_AR' && s0.skill === 'gun_AR' && s0.rarity === 'common' && s0.weight === BOOK_RARITY_MUL.common,
    `slot 0 filled with skill / rarity / weight (${JSON.stringify(s0)})`);
  ok((await H(() => window.__game.ctx.housing.getBookDex())).includes('book_gun_AR'), '도감 records the shelved book');
  // refusals
  ok(await H((u) => window.__game.ctx.housing.placeBook(u, 0, 'book_gun_AR') === '이미 책이 꽂혀 있습니다', shelfA), 'duplicate slot refused (이미 책이 꽂혀 있습니다)');
  const nonBook = await H((u) => window.__game.ctx.housing.placeBook(u, 1, 'mat_scrap'), shelfA);
  ok(nonBook === '서적이 아닙니다', `a non-book def is refused (${nonBook})`);
  const noStock = await H((u) => window.__game.ctx.housing.placeBook(u, 1, 'book_medicine'), shelfA);
  ok(typeof noStock === 'string' && /없습니다/.test(noStock), `a book the player does not own is refused (${noStock})`);
  const badSlot = await H((u) => window.__game.ctx.housing.placeBook(u, 6, 'book_gun_AR'), shelfA);
  ok(badSlot === '없는 책장 칸입니다', `slot ${BOOKS_PER_SHELF} is out of range (${badSlot})`);
  const notShelf = await H(() => window.__game.ctx.housing.placeBook('f-999', 0, 'book_gun_AR'));
  ok(notShelf === '책장이 아닙니다', `placeBook on a missing uid refused (${notShelf})`);
  const evBefore = (await ev('housing:booksChanged')).length;
  ok(evBefore === 1, 'no housing:booksChanged from any refusal');
  // stash fallback: the only copy of the next book lives in the stash
  ok(await giveStash('book_medicine', 1) === 1, '『전장 의학』 placed in the 창고 only');
  ok((await countBag('book_medicine')) === 0 && (await countStash('book_medicine')) === 1, 'the medicine book is in the stash, not the bag');
  ok(await H((u) => window.__game.ctx.housing.placeBook(u, 2, 'book_medicine') === null, shelfA), 'placeBook falls back to the 창고 when the bag has none');
  ok((await countStash('book_medicine')) === 0 && (await countAll('book_medicine')) === 0, 'the stash copy was consumed');
  const dex2 = await H(() => window.__game.ctx.housing.getBookDex());
  ok(dex2.length === 2 && dex2.includes('book_medicine'), `도감 has both books (${dex2.join(',')})`);

  /* ══ 4. bonus maths ════════════════════════════════════════════════════ */
  console.log('getBookBonus / getSkillGainMul');
  ok(near(await bonus('gun_AR'), 1 + BOOK_XP_PER_BOOK * BOOK_RARITY_MUL.common), `gun_AR ×${1 + BOOK_XP_PER_BOOK} from one common book (${await bonus('gun_AR')})`);
  ok(near(await bonus('medicine'), 1 + BOOK_XP_PER_BOOK * BOOK_RARITY_MUL.rare), `medicine ×1.125 from one rare book (${await bonus('medicine')})`);
  ok((await bonus('carry')) === 1, 'an unrelated skill stays ×1');
  ok(await H((u) => window.__game.ctx.housing.placeBook(u, 1, 'book_gun_AR') === null, shelfA), 'second 돌격소총 book shelved');
  ok(near(await bonus('gun_AR'), 1 + BOOK_XP_PER_BOOK * 2 * BOOK_RARITY_MUL.common), `two common books stack additively (${await bonus('gun_AR')})`);
  // 사격장 × 서재
  await give('mat_scrap', 20); await give('mat_cable', 6);
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(5, 'range') === true), '방 6 → 사격장 (skill gain ×1.1 for gun_*)');
  const gm = await H(() => ({ ar: window.__game.ctx.housing.getSkillGainMul('gun_AR'), med: window.__game.ctx.housing.getSkillGainMul('medicine'), carry: window.__game.ctx.housing.getSkillGainMul('carry') }));
  ok(near(gm.ar, 1.1 * (1 + BOOK_XP_PER_BOOK * 2)), `getSkillGainMul(gun_AR) = 사격장 1.1 × 서재 1.10 (${gm.ar})`);
  ok(near(gm.med, 1 + BOOK_XP_PER_BOOK * BOOK_RARITY_MUL.rare), `getSkillGainMul(medicine) is the book bonus alone (${gm.med})`);
  ok(gm.carry === 1, 'getSkillGainMul(carry) = 1 (no range bonus, no book)');
  // cap: 6 epic books (Σ 24 → 1 + 1.2 = 2.2) is clamped to BOOK_GAIN_MAX
  ok(await giveStash('book_cryptography', 6) === 6, '6× 『암호 해독 원론』 (epic) into the 창고');
  const capSteps = [];
  for (let slot = 0; slot < BOOKS_PER_SHELF; slot++) {
    const r = await H(({ u, slot }) => window.__game.ctx.housing.placeBook(u, slot, 'book_cryptography'), { u: shelfB, slot });
    capSteps.push(r ?? (await bonus('cryptography')));
  }
  ok(capSteps.every((v) => typeof v === 'number'), `all ${BOOKS_PER_SHELF} epic books shelved (${capSteps.filter((v) => typeof v === 'string').join(',')})`);
  ok(near(capSteps[0], 1 + BOOK_XP_PER_BOOK * BOOK_RARITY_MUL.epic) && near(capSteps[3], 1 + BOOK_XP_PER_BOOK * 4 * BOOK_RARITY_MUL.epic),
    `1 epic → ×1.20, 4 epic → ×1.80 (${capSteps[0]}, ${capSteps[3]})`);
  ok(near(capSteps[4], BOOK_GAIN_MAX) && near(capSteps[5], BOOK_GAIN_MAX), `capped at BOOK_GAIN_MAX ${BOOK_GAIN_MAX} (${capSteps[4]}, ${capSteps[5]})`);
  ok(near(await H(() => window.__game.ctx.housing.getSkillGainMul('cryptography')), BOOK_GAIN_MAX), 'getSkillGainMul honours the cap');
  ok(near(await bonus('gun_AR'), 1.1) && (await bonus('carry')) === 1, 'the cap does not leak into other skills');
  ok((await H((u) => window.__game.ctx.housing.getBooks(u), shelfB)).filter((s) => s.defId).length === BOOKS_PER_SHELF, `책장 B is full (${BOOKS_PER_SHELF}/${BOOKS_PER_SHELF})`);
  const full = await H((u) => window.__game.ctx.housing.placeBook(u, 0, 'book_gun_AR'), shelfB);
  ok(full === '이미 책이 꽂혀 있습니다', `a full shelf refuses another book (${full})`);

  /* ══ 5. removal ════════════════════════════════════════════════════════ */
  console.log('takeBook / recover');
  const takeBag = await countBag('book_gun_AR');
  ok(await H((u) => window.__game.ctx.housing.takeBook(u, 1) === null, shelfA), 'takeBook slot 1 → null');
  ok((await countBag('book_gun_AR')) === takeBag + 1, `the book came back to the bag (${takeBag} → ${await countBag('book_gun_AR')})`);
  ok(near(await bonus('gun_AR'), 1 + BOOK_XP_PER_BOOK), 'the bonus dropped back to one book');
  ok((await lastEv('housing:booksChanged'))?.count === 2, 'housing:booksChanged after 빼기 (3권 → 2권)');
  ok((await lastEv('housing:changed'))?.reason === 'bookTake', "housing:changed {reason: 'bookTake'}");
  ok((await H(() => window.__game.ctx.housing.getBookDex())).includes('book_gun_AR'), '도감 keeps a book that was taken back out');
  ok(await H((u) => window.__game.ctx.housing.takeBook(u, 1) === '꽂힌 책이 없습니다', shelfA), 'takeBook on an empty slot refused');
  ok(await H(() => window.__game.ctx.housing.takeBook('f-999', 0) === '책장이 아닙니다'), 'takeBook on a missing uid refused');
  // no space anywhere: stub `tryAddItemAnywhere` (a genuinely full 10×24 stash would take minutes to build)
  const noSpace = await H((u) => {
    const inv = window.__game.ctx.inventory;
    const real = inv.tryAddItemAnywhere;
    inv.tryAddItemAnywhere = () => null;
    const reason = window.__game.ctx.housing.takeBook(u, 0);
    inv.tryAddItemAnywhere = real;
    return { reason, still: window.__game.ctx.housing.getBooks(u)[0].defId };
  }, shelfA);
  ok(typeof noSpace.reason === 'string' && /공간 없음/.test(noSpace.reason), `takeBook with nowhere to put it → 한국어 공간 없음 (${noSpace.reason})`);
  ok(noSpace.still === 'book_gun_AR', 'the refused book stays on the shelf');
  // recovering a shelf hands its books to the 창고
  const before = { stash: await countStash('book_cryptography'), dex: (await H(() => window.__game.ctx.housing.getBookDex())).length };
  ok(await H((u) => window.__game.ctx.housing.recover(u) === true, shelfB), 'recover the full 책장 B');
  ok((await countStash('book_cryptography')) === before.stash + BOOKS_PER_SHELF, `its ${BOOKS_PER_SHELF} books moved to the 창고 (${await countStash('book_cryptography')})`);
  ok((await lastEv('housing:booksChanged'))?.count === 0, 'housing:booksChanged {count 0} for the recovered shelf');
  ok((await bonus('cryptography')) === 1, 'the recovered shelf no longer boosts 암호학');
  ok((await H(() => window.__game.ctx.housing.getBookDex())).length === before.dex && (await H(() => window.__game.ctx.housing.getBookDex())).includes('book_cryptography'),
    '도감 keeps the def after the shelf was recovered');
  // recover refused while the books have nowhere to go (a genuinely full 10×24 stash would take minutes to build:
  // `recoverBlock` estimates free cells from `getStashSize` − `getStashItems`, `recover` itself uses `tryAddToStash`)
  const blocked = await H((u) => {
    const inv = window.__game.ctx.inventory;
    const realAdd = inv.tryAddToStash, realSize = inv.getStashSize, realItems = inv.getStashItems;
    inv.tryAddToStash = () => false;
    inv.getStashSize = () => ({ cols: 1, rows: 1 });      // 1 free cell < the 2×(1×2) the two books need
    inv.getStashItems = () => [];
    const h = window.__game.ctx.housing;
    const out = { reason: h.recoverBlock(u), empty: h.purposeBlock(3, 'empty'), recovered: h.recover(u), books: h.getBooks(u).filter((s) => s.defId).length };
    inv.tryAddToStash = realAdd; inv.getStashSize = realSize; inv.getStashItems = realItems;
    return out;
  }, shelfA);
  ok(typeof blocked.reason === 'string' && /책을 먼저 빼세요/.test(blocked.reason), `recoverBlock names the books (${blocked.reason})`);
  ok(blocked.recovered === false && blocked.books === 2, 'recover refused, nothing moved (책 2권 still on the shelf)');
  ok(typeof blocked.empty === 'string' && /책을 먼저 빼세요/.test(blocked.empty), `purposeBlock(방 4, 빈 방) reports the same reason (${blocked.empty})`);
  const warn = await lastEv('ui:notify');
  ok(warn && /책을 먼저 빼세요/.test(warn.text) && warn.kind === 'warning', `a 한국어 warning toast is shown (${warn?.text})`);
  ok(await H(() => window.__game.ctx.housing.recoverBlock('f-999') === '설치되지 않은 가구입니다'), 'recoverBlock on a missing uid');

  /* ══ 6. persistence ════════════════════════════════════════════════════ */
  console.log('persistence');
  await H(() => window.__game.ctx.housing.save());
  const saved = await H(() => JSON.parse(localStorage.getItem('scav.s1.ship')));
  ok(saved.version === SHIP_STATE_VERSION, `scav.s1.ship is v${SHIP_STATE_VERSION} (${saved.version})`);
  ok(Array.isArray(saved.books) && saved.books.length === 2 && saved.books.every((b) => b.uid && typeof b.slot === 'number' && b.defId.startsWith('book_')),
    `books written to the save (${JSON.stringify(saved.books)})`);
  ok(Array.isArray(saved.bookDex) && saved.bookDex.length === 3, `bookDex written to the save (${saved.bookDex?.join(',')})`);
  await page.reload({ waitUntil: 'load' });
  await setup();
  const after = await H((u) => ({ slots: window.__game.ctx.housing.getBooks(u), dex: window.__game.ctx.housing.getBookDex(), v: window.__game.ctx.housing.state.version }), shelfA);
  ok(after.v === SHIP_STATE_VERSION && after.slots.filter((s) => s.defId).length === 2, `shelved books survive a reload (${after.slots.filter((s) => s.defId).map((s) => s.defId).join(',')})`);
  ok(after.slots[0].defId === 'book_gun_AR' && after.slots[2].defId === 'book_medicine', 'each book kept its slot');
  ok(after.dex.length === 3 && after.dex.includes('book_cryptography'), `도감 survives a reload (${after.dex.join(',')})`);
  ok(near(await bonus('medicine'), 1 + BOOK_XP_PER_BOOK * BOOK_RARITY_MUL.rare), 'the bonus is recomputed from the reloaded shelf');
  // hand-corrupted save → sanitised, never a throw
  await H(() => window.__game.ctx.housing.save());
  await H((u) => {
    const raw = JSON.parse(localStorage.getItem('scav.s1.ship'));
    raw.books = [
      { uid: u, slot: 0, defId: 'book_gun_AR' },              // valid
      { uid: u, slot: 0, defId: 'book_medicine' },            // duplicate slot → dropped
      { uid: u, slot: 99, defId: 'book_grit' },               // slot out of range → dropped
      { uid: 'f-nope', slot: 1, defId: 'book_grit' },         // unknown shelf uid → dropped
      { uid: u, slot: 2, defId: 'mat_scrap' },                // not a book id shape → dropped
      { uid: u, slot: 3, defId: 'book_ghost' },               // book-shaped but no such def → pruned at runtime
      { uid: u, slot: 'x', defId: 'book_grit' },              // bad slot type → dropped
    ];
    raw.bookDex = ['book_gun_AR', 'book_gun_AR', 'mat_scrap', 7, 'book_ghost'];
    localStorage.setItem('scav.s1.ship', JSON.stringify(raw));
  }, shelfA);
  await page.reload({ waitUntil: 'load' });
  await setup();
  const san = await H((u) => ({ slots: window.__game.ctx.housing.getBooks(u).map((s) => s.defId), dex: window.__game.ctx.housing.getBookDex(), raw: window.__game.ctx.housing.state.books.length }), shelfA);
  ok(san.slots[0] === 'book_gun_AR', 'the valid book survived the corrupt save');
  ok(san.slots.filter((d) => d).length === 1, `every bad entry dropped, including the unknown def (${JSON.stringify(san.slots)})`);
  ok(san.dex.filter((d) => d === 'book_gun_AR').length === 1 && !san.dex.includes('mat_scrap') && !san.dex.includes(7),
    `bookDex de-duplicated and shape-checked (${san.dex.join(',')})`);
  ok(near(await bonus('gun_AR'), 1 + BOOK_XP_PER_BOOK), 'the bonus after sanitising counts only the surviving book');
  ok(errors.length === 0, 'corrupt save sanitised without a page error', errors.slice(0, 3).join(' | '));

  /* ══ 7. UI ═════════════════════════════════════════════════════════════ */
  console.log('책장 panel + 도감');
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.4);
  await giveStash('book_grit', 2);
  await H((u) => window.__game.ctx.housing.openBookshelfMenu(u), shelfA);
  await sleep(140);
  ok(await H(() => window.__game.ctx.uiBlockers.has('housing')), "openBookshelfMenu adds the 'housing' blocker");
  const tog = await lastEv('ui:bookshelfToggled');
  ok(tog && tog.open === true && tog.uid === shelfA, `ui:bookshelfToggled {open, uid} (${JSON.stringify(tog)})`);
  ok((await lastEv('ui:housingToggled'))?.page === null, 'ui:housingToggled reports page null for the 책장 panel');
  const dom = await H(() => {
    const root = document.querySelector('.menu.housing-menu.bookshelf-menu');
    if (!root) return null;
    return {
      hidden: root.hidden,
      title: root.querySelector('.hs-head .title')?.textContent ?? '',
      subtitle: root.querySelector('.hs-head .subtitle')?.textContent ?? '',
      cards: root.querySelectorAll('.hs-book').length,
      empty: root.querySelectorAll('.hs-book.empty').length,
      filledState: [...root.querySelectorAll('.hs-book:not(.empty) .state')].map((n) => n.textContent),
      lines: [...root.querySelectorAll('.hs-book:not(.empty) .line')].map((n) => n.textContent),
      picks: [...root.querySelectorAll('.hs-bookpick')].length,
      dexRows: root.querySelectorAll('.hs-dex-row').length,
      dexOwned: root.querySelectorAll('.hs-dex-row.owned').length,
      dexBoosted: [...root.querySelectorAll('.hs-dex-row.boosted')].map((r) => r.dataset.skill),
      dexMuls: Object.fromEntries([...root.querySelectorAll('.hs-dex-row')].map((r) => [r.dataset.skill, r.querySelector('.mul').textContent])),
      dexSummary: root.querySelector('.hs-dex-sum')?.textContent ?? '',
    };
  });
  ok(dom && !dom.hidden, '.bookshelf-menu is shown');
  ok(/책장/.test(dom.title) && /방 4/.test(dom.title), `title names the room (${dom.title})`);
  ok(/1 \/ 6권/.test(dom.subtitle), `subtitle counts the shelved books (${dom.subtitle})`);
  ok(dom.cards === BOOKS_PER_SHELF && dom.empty === BOOKS_PER_SHELF - 1, `${BOOKS_PER_SHELF} slot cards, 5 empty (${dom.cards}/${dom.empty})`);
  ok(dom.filledState[0] === '사격' || /[가-힣]/.test(dom.filledState[0] ?? ''), `the filled card names its 숙련 in 한국어 (${dom.filledState[0]})`);
  ok(/가중치 ×1/.test(dom.lines[0] ?? '') && /×1\.05/.test(dom.lines[0] ?? ''), `the filled card shows weight and multiplier (${dom.lines[0]})`);
  // owned right now: 돌격소총 1 (bag) + 암호 해독 6 + 버티는 법 2 (stash) → three defs, grouped
  ok(dom.picks === 3, `보유 서적 picker lists the owned book defs, bag + stash (${dom.picks})`);
  ok(dom.dexRows === 14, `도감 renders one row per skill (${dom.dexRows})`);
  // the corrupt-save round trip above left `book_gun_AR` as the only 도감 entry that still resolves to a real def
  ok(dom.dexOwned === 1, `도감 marks only the books that were really shelved 보유 (${dom.dexOwned})`);
  ok(dom.dexBoosted.length === 1 && dom.dexBoosted[0] === 'gun_AR', `only gun_AR is boosted right now (${dom.dexBoosted.join(',')})`);
  ok(dom.dexMuls.gun_AR === '×1.05' && dom.dexMuls.carry === '×1.00', `도감 rows carry the current multiplier (${dom.dexMuls.gun_AR} / ${dom.dexMuls.carry})`);
  ok(/1 \/ 14/.test(dom.dexSummary), `도감 summary counts the collection (${dom.dexSummary})`);
  // pick a book in the panel and shelve it through the DOM
  await H(() => document.querySelector('.menu.bookshelf-menu .hs-bookpick').click());
  await sleep(80);
  await H(() => document.querySelector('.menu.bookshelf-menu .hs-book.empty .actions .ui-btn.primary').click());
  await sleep(120);
  const afterClick = await H((u) => ({ filled: window.__game.ctx.housing.getBooks(u).filter((s) => s.defId).length, msg: document.querySelector('.menu.bookshelf-menu .hs-msg')?.textContent ?? '' }), shelfA);
  ok(afterClick.filled === 2, `꽂기 button shelves the picked book (${afterClick.filled})`);
  ok(/꽂기 완료/.test(afterClick.msg), `the panel confirms in 한국어 (${afterClick.msg})`);
  // 2026-09-08: a housing panel closes on E, the key that opened it from the furniture
  await tap('KeyE');
  await sleep(140);
  ok(await H(() => document.querySelector('.menu.bookshelf-menu').hidden && !window.__game.ctx.uiBlockers.has('housing')), 'E closes the panel and releases the blocker');
  ok((await lastEv('ui:bookshelfToggled'))?.open === false, 'ui:bookshelfToggled {open:false} on close');
  const notShelfMenu = await H(() => { const n = window.__ev['ui:notify'].length; window.__game.ctx.housing.openBookshelfMenu('f-999'); return { opened: !document.querySelector('.menu.bookshelf-menu').hidden, notified: window.__ev['ui:notify'].length > n }; });
  ok(!notShelfMenu.opened && notShelfMenu.notified, 'openBookshelfMenu on a missing 책장 warns instead of opening');
  // Phase 9 UI pass: the 도감 was **removed** from the 함선 tab — it is read on a 책장 in the 서재 instead
  const shipView = await H(() => {
    const host = document.createElement('div');
    host.id = 'smoke-shipview';
    document.body.appendChild(host);
    window.__view = window.__game.ctx.housing.createShipView(host);
    return {
      dex: host.querySelectorAll('.hs-dex').length,
      rows: host.querySelectorAll('.hs-dex-row').length,
      heads: [...host.querySelectorAll('.hs-section > .ui-label')].map((n) => n.textContent).join('|'),
      roomRows: host.querySelectorAll('.hs-row.room').length,
    };
  });
  ok(shipView.dex === 0 && shipView.rows === 0, `함선 tab carries no 도감 any more (${shipView.dex}/${shipView.rows})`);
  ok(!/도감/.test(shipView.heads), `no 도감 section heading in the 함선 tab (${shipView.heads.slice(0, 120)})`);
  ok(shipView.roomRows === 10, `함선 tab still lists the ten rooms (${shipView.roomRows})`);
  ok(await H(() => { window.__view.dispose(); const n = document.getElementById('smoke-shipview').querySelectorAll('.hs-ship').length; document.getElementById('smoke-shipview').remove(); return n === 0; }), 'createShipView().dispose() removes the view');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
