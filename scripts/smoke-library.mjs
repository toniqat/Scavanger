// Single-player smoke test for the 서재 (src/housing + src/items + src/hub).
// 2026-09-13 — 서재 시리즈 · 게임 디스크 전시대 (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」), rewritten from the Phase 9 / A-3e smoke:
//   · 시리즈 몫 = 권당 SHELF_SERIES_VOLUME_SHARE, 전권 = 100 % (서로 다른 권 · 여러 보관함에 걸쳐 · def 한 번만)
//   · 효과 합산 `getLibraryEffects` · `getLibrarySources` · `getSeriesProgress` · `getBookBonus` / `getSkillGainMul` / `getShelfBonus`
//   · 보조 가구 배율 · 놓인 보관함은 전부 센다 (2026-09-13 전력 할당 폐지 — 비활성 · 가동 사유 없음) · `housing:libraryChanged` 발행 규칙
//   · 띠 질의 `isShelfItemWanted` (보관함 보유 = 배치 또는 가구 창고) · 레시피 해금 `isRecipeUnlocked` (꽂혀 있는 동안만)
//   · 중복 꽂기 거절 (`이미 꽂혀 있는 책입니다`) · 게임 디스크 매체 꽂기 / 빼기 · 회수
//   · 옛 id 세이브 변환 (`resolveItemAlias` — 치환 · 중복 환불 · tvConsoles 정리 · 다시 쓰기 = 두 번 환불 없음)
//   · 보관함 화면 (그려진 선반 · 권 번호 배지 · 시리즈 진척 · 시리즈 도감 · 드래그 / 더블클릭 / 교체 / 중복 거절 · 게임 디스크 전시대)
// Expected numbers are derived from the loaded series table (data/library_series.csv) — a retune of a value does not break this script,
// the rules do. Usage: node scripts/smoke-library.mjs [http://localhost:5273]   (needs `npm run dev`)
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

/* src/shared/constants.ts — asserted as literals so a silent retune is caught here. */
const BOOKS_PER_SHELF = 18;  // 2026-09-15 2차 (사용자 결정): 3 층 × 6칸 (한 층이 한 줄, 가운데 구분막 왼쪽 3 · 오른쪽 3)
const GAME_SLOTS = 12;       // GAME_DISC_SLOTS_PER_STAND (2026-09-14: 6 → 12)
/* shared/housing 의 `SHELF_TIERS` · `SHELF_TIER_COLS` (2026-09-14 층당 여러 줄) */
const BOOK_TIERS = 3, BOOK_COLS = 6, GAME_TIERS = 3;
const VOLUME_SHARE = 0.1;    // SHELF_SERIES_VOLUME_SHARE (사용자 결정: 권당 10 %)
/* src/shared/constants.ts 의 SHIP_STATE_VERSION — 서재 시리즈는 버전을 올리지 않았다 (ShipState.ts 머리 주석). 13 = 전력 할당 폐지 (2026-09-13). */
const SHIP_STATE_VERSION = 13;
const near = (a, b) => Math.abs(a - b) < 1e-6;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const skip = (label) => console.log(`  skip ${label}`);
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
    '--window-size=1440,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  // the 보관함 screen is a station card + 함선 창고 card + 가방 card and is dragged with a real pointer
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    // 이 스크립트는 튜토리얼을 검사하지 않는다 (scripts/smoke-tutorial.mjs 가 본다) — 끝난 것으로 표시해 둔다.
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    // Never let headless Chrome take a real pointer lock (ClipCursor traps the OS cursor on Windows).
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket AND the relay socket: single-player script — a relay on 8787 would replace the ship / stash documents mid-run.
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

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
      for (const n of ['housing:changed', 'housing:booksChanged', 'housing:shelfChanged', 'housing:libraryChanged', 'ui:bookshelfToggled', 'ui:shelfToggled', 'ui:notify']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p))); });
      }
    });
  };
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const H = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => H((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const give = (defId, qty) => H(({ defId, qty }) => {
    const ctx = window.__game.ctx;
    const def = ctx.loot.getItemDef(defId);
    if (!def) return -1;
    let added = 0;
    while (added < qty) {
      const n = Math.min(def.stackMax ?? 1, qty - added);
      if (!ctx.inventory.tryAddItem(ctx.loot.createItem(defId, n))) break;
      added += n;
    }
    return added;
  }, { defId, qty });
  const giveStash = (defId, n) => H(({ defId, n }) => {
    const ctx = window.__game.ctx;
    let added = 0;
    for (let i = 0; i < n; i++) if (ctx.inventory.tryAddToStash(ctx.loot.createItem(defId, 1))) added++;
    return added;
  }, { defId, n });
  const countAll = (defId) => H((d) => window.__game.ctx.inventory.countDefAll(d), defId);
  const countStash = (defId) => H((d) => window.__game.ctx.inventory.getStashItems().filter((i) => i.defId === d).reduce((a, i) => a + (i.qty ?? 1), 0), defId);
  const effects = () => H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.getLibraryEffects())));
  const place = (uid, slot, defId) => H(({ uid, slot, defId }) => window.__game.ctx.housing.placeShelfItem(uid, slot, defId), { uid, slot, defId });
  const take = (uid, slot) => H(({ uid, slot }) => window.__game.ctx.housing.takeShelfItem(uid, slot), { uid, slot });
  const placeDef = (defId) => H((d) => {
    const h = window.__game.ctx.housing;
    h.addToStorage(d, 1);
    const s = h.findFreeSpot(3, d);
    return s ? h.place(3, d, s.x, s.y, s.yaw)?.uid ?? null : null;
  }, defId);
  const nLib = async () => (await ev('housing:libraryChanged')).length;

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await setup();

  /* ══ 0. data from the tables ═══════════════════════════════════════════════ */
  console.log('series data');
  const D = await H(async () => {
    const S = await import('/src/shared/index.ts');
    const loot = window.__game.ctx.loot;
    const defs = loot.getAllItemDefs();
    const shelfOf = (d) => d.book ?? d.disc ?? d.record;
    const itemsOf = (sid) => defs.filter((d) => shelfOf(d)?.series === sid).sort((a, b) => shelfOf(a).volume - shelfOf(b).volume).map((d) => d.id);
    const series = (s) => s && { id: s.id, medium: s.medium, name: s.name, volumes: s.volumes, effects: s.effects, items: itemsOf(s.id) };
    const pick = (pred) => series(S.LIBRARY_SERIES_DEFS.find((s) => pred(s) && itemsOf(s.id).length === s.volumes));
    const multi = pick((s) => s.medium === 'book' && s.volumes >= 3 && s.effects.length === 1 && s.effects[0].kind === 'skillGain');
    const skillT = multi?.effects[0].target;
    const short = pick((s) => s.medium === 'book' && s.volumes === 1 && s.effects.length === 1 && s.effects[0].kind === 'skillGain' && s.effects[0].target !== skillT);
    const recipe = pick((s) => s.medium === 'book' && s.volumes === 1 && s.effects.some((e) => e.kind === 'recipe'));
    const disc = pick((s) => s.medium === 'disc' && s.volumes >= 2);
    const record = pick((s) => s.medium === 'record');
    const games = defs.filter((d) => d.gameDisc).map((d) => d.id);
    const consoleId = defs.find((d) => d.gameConsole)?.id ?? null;
    const aliases = [...S.ITEM_ALIASES];
    const aliasBook = aliases.find(([f, t]) => f.startsWith('book_') && t.startsWith('book_') && loot.getItemDef(t)) ?? null;
    const aliasDisc = aliases.find(([f, t]) => f.startsWith('disc_') && t.startsWith('disc_') && loot.getItemDef(t)) ?? null;
    const recipeTargets = new Set(S.LIBRARY_SERIES_DEFS.flatMap((s) => s.effects.filter((e) => e.kind === 'recipe').map((e) => e.target)));
    const freeRecipe = loot.getAllRecipes().find((r) => !r.unlockSeries && !recipeTargets.has(r.id))?.id ?? null;
    return {
      multi, short, recipe, disc, record, games, consoleId, aliasBook, aliasDisc, freeRecipe,
      share: S.SHELF_SERIES_VOLUME_SHARE, aux: S.SHELF_AUX_BONUS, slots: S.SHELF_SLOTS, seriesCount: S.LIBRARY_SERIES_DEFS.length,
      bookSeries: S.LIBRARY_SERIES_DEFS.filter((s) => s.medium === 'book').length,
      gameStand: !!window.__game.ctx.housing.getFurnitureDef('furn_game_stand'),
      frac: [0, 1, 2, 3, 4, 5].map((n) => S.librarySeriesFraction(n, 5)),
    };
  });
  ok(near(D.share, VOLUME_SHARE) && D.slots.book === BOOKS_PER_SHELF && D.slots.game === GAME_SLOTS, `constants: share ${D.share} · 책장 ${D.slots.book} · 게임 전시대 ${D.slots.game}`);
  ok(near(D.frac[1], 0.1) && near(D.frac[4], 0.4) && D.frac[5] === 1 && D.frac[0] === 0, `librarySeriesFraction: 1권 10 % · 4권 40 % · 전권 100 % (${D.frac.join(',')})`);
  ok(D.seriesCount > 0 && !!D.multi && !!D.short && !!D.recipe, `series table loaded (${D.seriesCount}) — multi ${D.multi?.id} · 단편 ${D.short?.id} · 레시피 ${D.recipe?.id}`);
  if (!D.multi || !D.short || !D.recipe) throw new Error('data/library_series.csv has no usable book series — agent D data missing');
  const M = D.multi, SH = D.short, RC = D.recipe;
  const mSkill = M.effects[0].target, mFull = M.effects[0].value, shSkill = SH.effects[0].target, shFull = SH.effects[0].value;
  const recipeId = RC.effects.find((e) => e.kind === 'recipe').target;

  /* ══ 1. ship · 서재 · 보관함 보유 = 띠 ═════════════════════════════════════ */
  console.log('hub / 서재 / wanted band');
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.5);
  // 서재 needs 발전기 Lv.4 (2026-09-13) — the gate is smoke-housing's business, so the state is raised to the maximum
  await give('mat_scrap', 40); await give('mat_alloy', 10);
  ok(await H(() => { const h = window.__game.ctx.housing; h.state.generatorLevel = 5; return h.setRoomPurpose(3, 'library'); }), '방 4 → 서재 (발전기 Lv.5)');
  ok(await H((id) => window.__game.ctx.housing.isShelfItemWanted(id), M.items[0]) === false, 'no 책장 owned → isShelfItemWanted false');
  ok(await giveStash(M.items[0], 2) === 2 && await giveStash(M.items[1], 1) === 1 && await giveStash(M.items[2], 1) === 1, `${M.name} I×2 · II · III into the 창고`);
  const libBefore = await nLib();
  // the real path: crafting puts the 책장 into furniture storage and emits housing:changed {craft} (raw `addToStorage` is a helper with no event)
  ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_bookshelf')) === true, 'craftFurniture(furn_bookshelf) → furniture storage');
  await sleep(30);
  ok(await H((id) => window.__game.ctx.housing.isShelfItemWanted(id), M.items[0]) === true, '책장 in furniture storage only → wanted true');
  ok((await nLib()) === libBefore + 1, `owning the first 책장 emits housing:libraryChanged (${libBefore} → ${await nLib()})`);
  ok(await H((d) => window.__game.ctx.housing.isShelfItemWanted(d), D.disc?.items[0] ?? 'x') === false, 'a disc is not wanted without a 디스크 전시대');
  ok(await H(() => window.__game.ctx.housing.isShelfItemWanted('mat_scrap')) === false, 'a non-shelf item is never wanted');
  const shelfA = await H(() => { const h = window.__game.ctx.housing; const s = h.findFreeSpot(3, 'furn_bookshelf'); return h.place(3, 'furn_bookshelf', s.x, s.y, s.yaw)?.uid ?? null; });
  const shelfB = await placeDef('furn_bookshelf');
  ok(!!shelfA && !!shelfB && shelfA !== shelfB, `two 책장 placed (multi) (${shelfA}, ${shelfB})`);
  const e0 = await effects();
  ok(Object.keys(e0.skillGain).length === 0 && e0.raidXp === 0 && e0.recipes.length === 0 && e0.revision >= 1, `empty shelves → empty summary (rev ${e0.revision})`);
  ok(await H((s) => window.__game.ctx.housing.getBookBonus(s), mSkill) === 1, 'getBookBonus = 1 with nothing shelved');

  /* ══ 2. 시리즈 몫 ══════════════════════════════════════════════════════════ */
  console.log('series fraction · sources · uniqueness');
  const rev0 = e0.revision;
  ok(await place(shelfA, 0, M.items[0]) === null, `${M.items[0]} → 책장 A slot 1`);
  await sleep(30);
  const e1 = await effects();
  ok(near(e1.skillGain[mSkill], mFull * VOLUME_SHARE), `1 / ${M.volumes}권 → skillGain.${mSkill} = ${mFull} × 10 % (${e1.skillGain[mSkill]})`);
  ok(e1.revision === rev0 + 1 && (await lastEv('housing:libraryChanged'))?.revision === e1.revision, `revision +1 and housing:libraryChanged carries it (${e1.revision})`);
  const g1 = await H((s) => ({ book: window.__game.ctx.housing.getBookBonus(s), gain: window.__game.ctx.housing.getSkillGainMul(s), shelf: window.__game.ctx.housing.getShelfBonus(s) }), mSkill);
  ok(near(g1.book, 1 + mFull * VOLUME_SHARE) && near(g1.gain, g1.book) && near(g1.shelf.total, g1.book) && near(g1.shelf.parts.book, mFull * VOLUME_SHARE) && g1.shelf.parts.game === 0,
    `getBookBonus = getSkillGainMul = getShelfBonus.total (${g1.book})`);
  const wanted1 = await H((ids) => ids.map((id) => window.__game.ctx.housing.isShelfItemWanted(id)), M.items);
  ok(wanted1[0] === false && wanted1[1] === true, `band: shelved vol I not wanted, vol II wanted (${wanted1.join(',')})`);
  ok(await place(shelfB, 0, M.items[1]) === null, `${M.items[1]} → 책장 B (another holder)`);
  const e2 = await effects();
  ok(near(e2.skillGain[mSkill], mFull * 2 * VOLUME_SHARE), `2 volumes across two holders → 20 % (${e2.skillGain[mSkill]})`);
  const src = await H(({ s }) => JSON.parse(JSON.stringify(window.__game.ctx.housing.getLibrarySources('skillGain', s))), { s: mSkill });
  const srcM = src.find((x) => x.seriesId === M.id);
  ok(srcM && srcM.have === 2 && srcM.total === M.volumes && near(srcM.fraction, 0.2) && near(srcM.value, mFull * 0.2) && near(srcM.fullValue, mFull) && srcM.auxApplied === false
    && srcM.defIds.length === 2 && srcM.name === M.name && srcM.medium === 'book', `getLibrarySources(skillGain, ${mSkill}) (${JSON.stringify(srcM)})`);
  ok((await H(() => window.__game.ctx.housing.getLibrarySources('raidXp', ''))).every((x) => x.value > 0), 'sources never list a zero value');
  const prog = await H((id) => ({ p: window.__game.ctx.housing.getSeriesProgress(id), none: window.__game.ctx.housing.getSeriesProgress('no_such_series') }), M.id);
  ok(prog.p.have === 2 && prog.p.total === M.volumes && near(prog.p.fraction, 0.2) && prog.none === null, `getSeriesProgress (${JSON.stringify(prog)})`);
  // uniqueness: the second copy of vol I is refused anywhere
  const nShelf = (await ev('housing:shelfChanged')).length, nL = await nLib();
  const dupA = await place(shelfA, 1, M.items[0]);
  const dupB = await place(shelfB, 1, M.items[0]);
  await sleep(30);
  ok(dupA === '이미 꽂혀 있는 책입니다' && dupB === '이미 꽂혀 있는 책입니다', `a def already shelved is refused on any 책장 (${dupA} / ${dupB})`);
  ok((await countAll(M.items[0])) === 1 && (await ev('housing:shelfChanged')).length === nShelf && (await nLib()) === nL, 'refusal: nothing consumed, no shelfChanged, no libraryChanged');
  // full set
  for (let v = 2; v < M.volumes; v++) {
    if ((await countAll(M.items[v])) < 1) await giveStash(M.items[v], 1);
    await place(shelfA, v, M.items[v]);
  }
  const eFull = await effects();
  ok(near(eFull.skillGain[mSkill], mFull), `all ${M.volumes} volumes → 100 % (${eFull.skillGain[mSkill]})`);
  // 단편
  await giveStash(SH.items[0], 1);
  ok(await place(shelfB, 1, SH.items[0]) === null && near((await effects()).skillGain[shSkill], shFull), `단편 ${SH.id} → 100 % at once (${shSkill} ${shFull})`);

  /* ══ 3. 보조 가구 · 빼기 (2026-09-13: 전력 할당 폐지 — 멈춘 보관함이 없어 놓인 보관함은 전부 센다) ══ */
  console.log('aux · take');
  const chair = await placeDef('furn_rocking_chair');
  const eAux = await effects();
  ok(!!chair && near(eAux.skillGain[mSkill], mFull * (1 + D.aux.book)) && near(eAux.skillGain[shSkill], shFull * (1 + D.aux.book)), `흔들의자 → book effects × ${1 + D.aux.book} (${eAux.skillGain[mSkill]})`);
  ok((await H((s) => window.__game.ctx.housing.getLibrarySources('skillGain', s).find((x) => x.seriesId === s) ?? window.__game.ctx.housing.getLibrarySources('skillGain', s)[0], mSkill)).auxApplied === true, 'sources report auxApplied');
  const noPower = await H((u) => {
    const h = window.__game.ctx.housing;
    return { op: h.furnitureOperationalBlock(u), api: ['setFurnitureDisabled', 'isFurnitureDisabled', 'setPowerAllocation', 'getFacilityPower'].filter((k) => typeof h[k] === 'function') };
  }, shelfB);
  ok(noPower.op === null && noPower.api.length === 0, '책장에는 가동 사유가 없고 전력 · 비활성 API 도 없다 — 놓인 보관함은 전부 센다', JSON.stringify(noPower));
  ok(await H((id) => window.__game.ctx.housing.isShelfItemWanted(id), M.items[1]) === false, 'band: vol II on 책장 B is shelved → not wanted');
  ok(await take(shelfA, 0) === null, 'take vol I back out');
  await sleep(30);
  const eTake = await effects();
  ok(near(eTake.skillGain[mSkill], mFull * (M.volumes - 1) * VOLUME_SHARE * (1 + D.aux.book)) && await H((id) => window.__game.ctx.housing.isShelfItemWanted(id), M.items[0]) === true,
    `taking one volume drops the set back to ${(M.volumes - 1) * 10} % and the band returns (${eTake.skillGain[mSkill]})`);
  const nL3 = await nLib();
  await H(() => window.__game.ctx.housing.changed('smoke-noop'));        // a real housing:changed that changes nothing the 서재 reads
  await sleep(30);
  await H(() => window.__game.ctx.housing.getLibraryEffects());
  await sleep(30);
  ok((await nLib()) === nL3, 'a no-op housing:changed does not emit housing:libraryChanged');

  /* ══ 4. 레시피 책 ═════════════════════════════════════════════════════════ */
  console.log('recipe unlock');
  ok(await H((r) => window.__game.ctx.housing.isRecipeUnlocked(r), recipeId) === false, `${recipeId} locked while ${RC.id} is not shelved`);
  if (D.freeRecipe) ok(await H((r) => window.__game.ctx.housing.isRecipeUnlocked(r), D.freeRecipe) === true, `a recipe without a book (${D.freeRecipe}) is always unlocked`);
  await giveStash(RC.items[0], 1);
  ok(await place(shelfB, 2, RC.items[0]) === null, `${RC.items[0]} shelved`);
  const eR = await effects();
  ok(eR.recipes.includes(recipeId) && await H((r) => window.__game.ctx.housing.isRecipeUnlocked(r), recipeId) === true, `recipe unlocked while shelved (${eR.recipes.join(',')})`);
  ok(await take(shelfB, 2) === null && await H((r) => window.__game.ctx.housing.isRecipeUnlocked(r), recipeId) === false && !(await effects()).recipes.includes(recipeId), 'taken out → locked again');

  /* ══ 5. 디스크 · 레코드 (여러 줄) ═══════════════════════════════════════════ */
  console.log('disc · record (multi-line)');
  let stand = null, rack = null;
  if (D.disc) {
    stand = await placeDef('furn_disc_stand');
    await giveStash(D.disc.items[0], 1);
    ok(!!stand && await place(stand, 0, D.disc.items[0]) === null, `${D.disc.items[0]} → 디스크 전시대`);
    const discLines = await H(({ sid, effects }) => effects.map((e) => {
      const s = window.__game.ctx.housing.getLibrarySources(e.kind, e.target).find((x) => x.seriesId === sid);
      return { want: e.kind === 'recipe' ? 0 : e.value, got: s ? s.value : 0, fraction: s?.fraction ?? 0 };
    }), { sid: D.disc.id, effects: D.disc.effects });
    ok(D.disc.effects.length === 2 && discLines.every((l) => near(l.got, l.want * VOLUME_SHARE) && near(l.fraction, VOLUME_SHARE)),
      `a disc (1 / ${D.disc.volumes}) gives both of its lines at 10 % (${JSON.stringify(discLines)})`);
    const firstSkill = D.disc.effects.find((e) => e.kind === 'skillGain')?.target;
    if (firstSkill) {
      const sb = await H((s) => window.__game.ctx.housing.getShelfBonus(s), firstSkill);
      ok(sb.parts.disc > 0 && near(sb.total, 1 + sb.parts.book + sb.parts.disc + sb.parts.record), `getShelfBonus splits the disc part (${JSON.stringify(sb.parts)})`);
    }
  } else skip('no disc series with ≥ 2 volumes in the table');
  if (D.record) {
    rack = await placeDef('furn_record_rack');
    await giveStash(D.record.items[0], 1);
    ok(!!rack && await place(rack, 0, D.record.items[0]) === null, `${D.record.items[0]} → 레코드랙`);
    const srcR = await H(({ e }) => window.__game.ctx.housing.getLibrarySources(e.kind, e.target), { e: D.record.effects[0] });
    ok(D.record.effects.length === 3 && srcR.some((x) => x.seriesId === D.record.id && x.fraction === 1), `a record (단편, 3 lines) counts 100 % (${D.record.effects.length} lines)`);
  } else skip('no record series in the table');

  /* ══ 6. 게임 디스크 매체 ══════════════════════════════════════════════════ */
  console.log('game disc medium');
  let gameStand = null;
  if (D.gameStand && D.games.length >= 1) {
    gameStand = await placeDef('furn_game_stand');
    const G = D.games[0];
    await giveStash(G, 2);
    const med = await H((u) => ({ m: window.__game.ctx.housing.getShelfMedium(u), slots: window.__game.ctx.housing.getShelfSlots(u).length }), gameStand);
    ok(!!gameStand && med.m === 'game' && med.slots === GAME_SLOTS, `게임 디스크 전시대: medium 'game', ${GAME_SLOTS} slots (${JSON.stringify(med)})`);
    const revG = (await effects()).revision, sigG = JSON.stringify({ ...(await effects()), revision: 0 });
    ok(await place(gameStand, 0, G) === null, `${G} shelved`);
    await sleep(30);
    const eG = await effects();
    ok(JSON.stringify({ ...eG, revision: 0 }) === sigG && eG.revision === revG + 1, 'a game disc changes no effect but bumps the revision (shelved set changed)');
    const gRef = await H(({ u, G, book, shelfA }) => {
      const h = window.__game.ctx.housing;
      return { dup: h.placeShelfItem(u, 1, G), book: h.placeShelfItem(u, 1, book), onShelf: h.placeShelfItem(shelfA, 7, G), dex: h.getShelfDex('game').includes(G),
        slot: h.getShelfSlots(u)[0].defId, owned: h.getOwnedShelfItems('game').some((e) => e.defId === G), wanted: h.isShelfItemWanted(G) };
    }, { u: gameStand, G, book: M.items[0], shelfA });
    ok(gRef.dup === '이미 꽂혀 있는 게임 디스크입니다' && gRef.book === '게임 디스크가 아닙니다' && gRef.onShelf === '서적이 아닙니다',
      `game refusals: duplicate · a book · a game disc on a 책장 (${JSON.stringify([gRef.dup, gRef.book, gRef.onShelf])})`);
    ok(gRef.slot === G && gRef.dex && gRef.owned && gRef.wanted === false, 'slot · 도감 · owned list · never a wanted band');
    ok(await take(gameStand, 0) === null && (await countAll(G)) === 2 && await place(gameStand, 0, G) === null, 'take the game disc out and back in');
  } else skip(`game stand / game discs missing (furn_game_stand ${D.gameStand}, discs ${D.games.length})`);

  /* ══ 7. 회수 ═══════════════════════════════════════════════════════════════ */
  console.log('recover');
  const stash0 = await countStash(SH.items[0]);
  ok(await H((u) => window.__game.ctx.housing.recover(u), shelfB) === true, 'recover 책장 B (holds vol II + 단편)');
  await sleep(30);
  const eRec = await effects();
  ok((await countStash(SH.items[0])) === stash0 + 1 && !eRec.skillGain[shSkill] && (await lastEv('housing:shelfChanged'))?.count === 0, 'its items went to the 창고, their effects are gone');
  ok(await H((id) => window.__game.ctx.housing.isShelfItemWanted(id), SH.items[0]) === true, 'the recovered 단편 is wanted again (책장 A still owned)');

  /* ══ 8. 보관함 화면 ═══════════════════════════════════════════════════════ */
  console.log('보관함 panel');
  // shelf A holds III…N; vol I is in the bag and vol II came back to the 창고 with 책장 B → put both back so the panel shows a complete set
  ok(await place(shelfA, 0, M.items[0]) === null && await place(shelfA, 1, M.items[1]) === null, 'vol I + II back on 책장 A (set complete)');
  await H((u) => window.__game.ctx.housing.openShelf(u), shelfA);
  await sleep(160);
  await waitFor(page, () => document.querySelectorAll('.menu.bookshelf-menu [data-tg-grid]').length >= 2, 'embedded 창고 / 가방 grids', 5000).catch(() => null);
  const dom = await H((mid) => {
    const root = document.querySelector('.menu.housing-menu.bookshelf-menu');
    const slots = [...root.querySelectorAll('.lib-case .lib-slot[data-slot]')];
    const filled = slots.filter((s) => s.classList.contains('is-filled'));
    const dexRow = root.querySelector(`.lib-dexrow[data-series="${mid}"]`);
    return {
      hidden: root.hidden, medium: root.dataset.medium, caseMedium: root.querySelector('.lib-case')?.dataset.medium,
      tiers: root.querySelectorAll('.lib-case .lib-tier').length, rows: root.querySelectorAll('.lib-case .lib-row').length,
      cols: [...root.querySelectorAll('.lib-case .lib-row')].map((r) => r.children.length).join(','),
      slots: slots.length, order: slots.map((s) => Number(s.dataset.slot)).join(','),
      filled: filled.length, vols: filled.map((s) => s.querySelector('.lib-vol')?.hidden ? '' : s.querySelector('.lib-vol')?.textContent),
      full: filled.filter((s) => s.classList.contains('is-full')).length, tip: filled.every((s) => s.querySelector('.lib-item').hasAttribute('data-item-tip')),
      line: filled[0]?.dataset.line ?? '', emptyLine: slots.find((s) => !s.classList.contains('is-filled'))?.dataset.line ?? null,
      info: root.querySelector('.lib-info').textContent, count: root.querySelector('.lib-count').textContent,
      aux: !!root.querySelector('.hs-shelf-aux'), series: !!root.querySelector('.lib-series-head'),
      dexRows: root.querySelectorAll('.lib-dexrow[data-series]').length, dexOwned: dexRow?.classList.contains('owned'),
      dexPips: dexRow?.querySelectorAll('.lib-pip').length ?? -1, dexThumb: !!dexRow?.querySelector('.lib-dex-thumb'),
      dexSub: dexRow?.querySelectorAll('.lib-dex-sub').length ?? -1, dexState: dexRow?.querySelector('.lib-dex-state')?.textContent ?? '',
      tabs: [...root.querySelectorAll('.hs-tabs .hs-tab')].map((n) => n.textContent).join('|'),
      railTabs: root.querySelectorAll('.hs-rail .hs-tab').length,
      rail: [...root.querySelectorAll('.hs-rail .hs-rail-item')].map((n) => `${n.dataset.uid || 'lib'}:${n.querySelector('.hs-rail-name').textContent}`),
      railActive: root.querySelector('.hs-rail .hs-rail-item.is-active')?.dataset.uid ?? null,
      grids: [...root.querySelectorAll('[data-tg-grid]')].map((n) => n.dataset.tgGrid).join(','),
    };
  }, M.id);
  /* 2026-09-15 2차 (사용자 결정 「책장 3층 × 6칸」): 층당 줄 수를 **상수에서 유도**한다 — 하드코딩 2 였던 자리다.
     BOOKS_PER_SHELF 18 · BOOK_TIERS 3 · BOOK_COLS 6 이면 층당 1 줄이고, 셋 중 하나가 움직여도 이 단언이 따라간다. */
  const BOOK_ROWS_PER_TIER = Math.ceil(BOOKS_PER_SHELF / BOOK_TIERS / BOOK_COLS);
  const BOOK_ROWS = BOOK_TIERS * BOOK_ROWS_PER_TIER;
  ok(!dom.hidden && dom.medium === 'book' && dom.caseMedium === 'book' && dom.tiers === BOOK_TIERS && dom.rows === BOOK_ROWS && dom.slots === BOOKS_PER_SHELF,
    `책장 panel: ${BOOK_TIERS} 층 × ${BOOK_ROWS_PER_TIER} 줄 = ${BOOKS_PER_SHELF} 칸 (${dom.tiers}/${dom.rows}/${dom.slots})`);
  ok(dom.cols === Array(BOOK_ROWS).fill(BOOK_COLS).join(',') && dom.order === [...Array(BOOKS_PER_SHELF).keys()].join(','),
    `한 줄 ${BOOK_COLS} 칸 · 칸 번호는 0 부터 이어진다 (${dom.cols})`);
  ok(dom.filled === M.volumes && dom.vols.includes('I') && dom.vols.includes('II') && dom.full === M.volumes && dom.tip, `volume badges + full-set outline + item tooltip hook on every volume (${dom.vols.join(',')} · full ${dom.full})`);
  ok(/몫 100 %/.test(dom.line) && dom.line.includes(M.name), `slot info line names the series and its share (${dom.line})`);
  // 2026-09-14 (사용자 결정): 빈 칸은 아무 말도 하지 않고, 정보 줄의 기본 문구 · 보조 가구 줄 · 시리즈 진척 패널은 사라졌다
  ok(dom.emptyLine === '' && dom.info === '' && !dom.aux && !dom.series, `빈 칸 · 기본 정보 줄 · 보조 가구 줄 · 시리즈 진척 제거 (empty '${dom.emptyLine}' · info '${dom.info}')`);
  ok(dom.tabs === '선반|도감' && dom.railTabs === 0 && dom.grids === 'stash,bag', `선반 / 도감 가 상단 가로 탭 · 창고 card left of 가방 (${dom.tabs} · ${dom.grids})`);
  ok(dom.rail[0]?.startsWith('lib:서재') && dom.rail.length >= 2 && dom.railActive === shelfA,
    `레일 = 서재 + 배치된 보관함 목록, 연 가구가 선택돼 있다 (${dom.rail.join(' | ')})`);
  ok(dom.dexRows === D.bookSeries && dom.dexOwned && dom.dexPips === M.volumes && dom.dexThumb && dom.dexSub === 0 && new RegExp(`${M.volumes} / ${M.volumes}권`).test(dom.dexState),
    `series 도감 = 썸네일 + 이름 + 모은 수뿐 (${dom.dexRows}/${D.bookSeries} · ${dom.dexState})`);

  // 레일의 「서재」 = 시설 전체 보너스 요약 (효과 이름과 값만)
  await H(() => document.querySelector('.menu.bookshelf-menu .hs-rail .hs-rail-item[data-uid=""]')?.click());
  await sleep(160);
  const libTab = await H(() => {
    const root = document.querySelector('.menu.bookshelf-menu');
    return { title: root.querySelector('.hs-station-head .title').textContent, tabsHidden: root.querySelector('.hs-tabs').hidden,
      shelfHidden: root.querySelector('.lib-page[data-page="shelf"]').hidden, effs: [...root.querySelectorAll('.lib-eff')].map((n) => n.textContent) };
  });
  ok(libTab.title === '서재' && libTab.tabsHidden && libTab.shelfHidden && libTab.effs.length > 0 && libTab.effs.some((t) => /상승량 \+/.test(t)),
    `「서재」 = 효과 요약 (탭 숨김 · ${libTab.effs.length} 줄: ${libTab.effs[0]})`);
  await H((u) => document.querySelector(`.menu.bookshelf-menu .hs-rail .hs-rail-item[data-uid="${u}"]`)?.click(), shelfA);
  await sleep(160);

  const shelfState = () => H((u) => ({ slots: window.__game.ctx.housing.getShelfSlots(u).map((s) => s.defId), msg: document.querySelector('.menu.bookshelf-menu .hs-msg')?.textContent ?? '' }), shelfA);
  /** The 창고 tile of `defId`, else its 가방 tile (a taken-out book goes to the bag first). */
  const stashTile = async (defId) => {
    const where = await H((d) => {
      const inv = window.__game.ctx.inventory;
      const s = inv.getStashItems().find((i) => i.defId === d);
      if (s) return { grid: 'stash', uid: s.uid };
      const b = inv.getAllItems().find((i) => i.defId === d);
      return b ? { grid: 'bag', uid: b.uid } : { grid: 'stash', uid: null };
    }, defId);
    const sel = `.menu.bookshelf-menu [data-tg-grid="${where.grid}"] .inv-tile[data-uid="${where.uid}"]`;
    await waitFor(page, (s) => !!document.querySelector(s), `${defId} tile in the ${where.grid} grid`, 5000, sel).catch(() => null);
    return sel;
  };
  const dragTo = async (fromSel, toSel) => {
    const geo = await H(({ fromSel, toSel }) => {
      const a0 = document.querySelector(fromSel), b0 = document.querySelector(toSel);
      if (!a0 || !b0) return null;
      a0.scrollIntoView({ block: 'center' });
      b0.scrollIntoView({ block: 'nearest' });
      const a = a0.getBoundingClientRect(), b = b0.getBoundingClientRect();
      return { x: a.left + Math.min(18, a.width / 2), y: a.top + Math.min(18, a.height / 2), tx: b.left + b.width / 2, ty: b.top + b.height * 0.6 };
    }, { fromSel, toSel });
    if (!geo) return { geo: null };
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x - 30, geo.y, { steps: 4 });
    await page.mouse.move(geo.tx, geo.ty, { steps: 12 });
    await sleep(60);
    await page.mouse.up();
    await sleep(180);
    return { geo };
  };
  // ① double-click the 단편 in the 창고 → first empty slot
  await H((s) => document.querySelector(s)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })), await stashTile(SH.items[0]));
  await sleep(160);
  const s1 = await shelfState();
  const firstEmpty = M.volumes;
  ok(s1.slots[firstEmpty] === SH.items[0] && /꽂기 완료/.test(s1.msg), `double-click a 창고 book → first empty slot (${JSON.stringify(s1)})`);
  // ② a non-book is refused
  await giveStash('mat_scrap', 1);
  await H((s) => document.querySelector(s)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })), await stashTile('mat_scrap'));
  await sleep(140);
  ok(/책장에는 서적만 꽂을 수 있습니다/.test((await shelfState()).msg), 'a non-book is refused');
  // ③ the spare copy of vol I dropped onto an occupied slot = duplicate → refused before anything moves
  const before3 = (await shelfState()).slots;
  await dragTo(await stashTile(M.items[0]), `.menu.bookshelf-menu .lib-slot[data-slot="${firstEmpty}"]`);
  const s3 = await shelfState();
  ok(JSON.stringify(s3.slots) === JSON.stringify(before3) && /이미 꽂혀 있는 책입니다/.test(s3.msg), `dropping a duplicate onto a filled slot is refused, nothing swapped (${s3.msg})`);
  // ④ swap: the recipe book onto the 단편's slot → the 단편 comes back
  const d4 = await dragTo(await stashTile(RC.items[0]), `.menu.bookshelf-menu .lib-slot[data-slot="${firstEmpty}"]`);
  const s4 = await shelfState();
  ok(s4.slots[firstEmpty] === RC.items[0] && /교체 완료/.test(s4.msg) && (await countAll(SH.items[0])) >= 1, `drop onto a filled slot swaps (${JSON.stringify(s4)})`, JSON.stringify(d4));
  ok(await H((r) => window.__game.ctx.housing.isRecipeUnlocked(r), recipeId) === true, 'the swapped-in recipe book unlocks its recipe');
  // ⑤ drag the recipe book out onto the 가방 → taken back
  await dragTo(`.menu.bookshelf-menu .lib-slot[data-slot="${firstEmpty}"] .lib-item`, '.menu.bookshelf-menu [data-tg-grid="bag"]');
  const s5 = await shelfState();
  ok(s5.slots[firstEmpty] === null && /책을 뺐습니다/.test(s5.msg) && await H((r) => window.__game.ctx.housing.isRecipeUnlocked(r), recipeId) === false, `drag a spine out → taken, recipe locked (${JSON.stringify(s5)})`);
  // ⑥ double-click a shelved volume → taken back; the series row + badges follow
  await H(() => document.querySelector('.menu.bookshelf-menu .lib-slot[data-slot="1"] .lib-item').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(200);
  const s6 = await H((mid) => {
    const root = document.querySelector('.menu.bookshelf-menu');
    const row = root.querySelector(`.lib-dexrow[data-series="${mid}"]`);
    return { full: root.querySelectorAll('.lib-slot.is-full').length, live: row?.querySelectorAll('.lib-pip.is-live').length ?? -1, boosted: row?.classList.contains('boosted') };
  }, M.id);
  ok((await shelfState()).slots[1] === null && s6.full === 0 && s6.live === M.volumes - 1 && s6.boosted === true, `double-click takes a volume; full outlines + 도감 권 칸 update (${JSON.stringify(s6)})`);
  await tap('KeyE');
  await sleep(140);
  ok(await H(() => document.querySelector('.menu.bookshelf-menu').hidden && !window.__game.ctx.uiBlockers.has('housing')) && (await lastEv('ui:bookshelfToggled'))?.open === false, 'E closes the 책장 panel');
  if (gameStand) {
    await H((u) => window.__game.ctx.housing.openShelf(u), gameStand);
    await sleep(160);
    const pG = await H(() => {
      const root = document.querySelector('.menu.bookshelf-menu');
      return { medium: root.dataset.medium, caseMedium: root.querySelector('.lib-case')?.dataset.medium, tiers: root.querySelectorAll('.lib-tier').length,
        slots: root.querySelectorAll('.lib-case .lib-slot[data-slot]').length, filled: root.querySelectorAll('.lib-slot.is-filled').length,
        dexRows: root.querySelectorAll('.lib-dexrow[data-def]').length, dexThumbs: root.querySelectorAll('.lib-dexrow[data-def] .lib-dex-thumb').length,
        count: root.querySelector('.lib-count').textContent };
    });
    const togG = await lastEv('ui:shelfToggled');
    ok(pG.medium === 'game' && pG.caseMedium === 'game' && pG.tiers === GAME_TIERS && pG.slots === GAME_SLOTS && pG.filled === 1,
      `게임 디스크 전시대 panel: ${GAME_TIERS} 층 × 4 칸 (${JSON.stringify(pG)})`);
    ok(pG.dexRows === D.games.length && pG.dexThumbs === D.games.length && togG?.medium === 'game' && togG.open === true && new RegExp(`1 / ${GAME_SLOTS}장`).test(pG.count),
      `game 도감 lists every game disc with a thumbnail (${pG.dexRows}) · ui:shelfToggled {game}`);
    await tap('KeyE');
    await sleep(140);
  }

  /* ══ 9. 세이브 · 옛 id 변환 ═══════════════════════════════════════════════ */
  console.log('save · legacy alias conversion');
  const tv = await placeDef('furn_tv');
  await H(() => window.__game.ctx.housing.save());
  const saved = await H(() => JSON.parse(localStorage.getItem('scav.s1.ship')));
  ok(saved.version === SHIP_STATE_VERSION && Array.isArray(saved.tvConsoles) && saved.books.every((b) => /^book_/.test(b.defId)), `v${saved.version} save carries tvConsoles + books`);
  if (D.aliasBook && D.consoleId && tv) {
    const [fromB, toB] = D.aliasBook;
    const before = { to: await countAll(toB), con: await countAll(D.consoleId) };
    await H(({ fromB, toB, shelfA, stand, aliasDisc, tv, consoleId }) => {
      const raw = JSON.parse(localStorage.getItem('scav.s1.ship'));
      raw.books = raw.books.filter((b) => b.uid !== shelfA || b.slot < 6);
      raw.books.push({ uid: shelfA, slot: 6, defId: fromB }, { uid: shelfA, slot: 7, defId: toB });   // old id + its new id = one duplicate
      raw.bookDex = [...(raw.bookDex ?? []), fromB, toB];
      if (stand && aliasDisc) { raw.media = (raw.media ?? []).filter((e) => e.uid !== stand); raw.media.push({ uid: stand, slot: 0, defId: aliasDisc[0] }); raw.mediaDex = [...(raw.mediaDex ?? []), aliasDisc[0]]; }
      raw.tvConsoles = [{ uid: tv, defId: consoleId }, { uid: tv, defId: consoleId }, { uid: 'f-nope', defId: consoleId }, { uid: tv, defId: 'bogus!' }];
      localStorage.setItem('scav.s1.ship', JSON.stringify(raw));
    }, { fromB, toB, shelfA, stand, aliasDisc: D.aliasDisc, tv, consoleId: D.consoleId });
    await page.reload({ waitUntil: 'load' });
    await setup();
    await waitFor(page, ({ toB, n }) => window.__game.ctx.inventory.countDefAll(toB) >= n, 'duplicate refund', 15000, { toB, n: before.to + 1 }).catch(() => null);
    const conv = await H(({ fromB, toB, shelfA, stand, aliasDisc, tv }) => {
      const h = window.__game.ctx.housing;
      return {
        slots: h.getShelfSlots(shelfA).map((s) => s.defId), dex: [...h.getBookDex()], mediaDisc: stand && aliasDisc ? h.getShelfSlots(stand)[0].defId : null,
        mdex: [...h.getShelfDex('disc')], tvc: JSON.parse(JSON.stringify(h.state.tvConsoles ?? [])), inv: window.__game.ctx.inventory.countDefAll(toB),
        wanted: h.isShelfItemWanted(fromB),
      };
    }, { fromB, toB, shelfA, stand, aliasDisc: D.aliasDisc, tv });
    ok(conv.slots.filter((d) => d === toB).length === 1 && !conv.slots.includes(fromB), `old '${fromB}' became '${toB}', only one copy stays shelved (${JSON.stringify(conv.slots)})`);
    ok(conv.inv >= before.to + 1, `the duplicate went back to the 함선 창고 (${before.to} → ${conv.inv})`);
    ok(conv.dex.includes(toB) && !conv.dex.includes(fromB) && conv.dex.filter((d) => d === toB).length === 1, 'bookDex aliased + de-duplicated');
    ok(conv.wanted === false, 'isShelfItemWanted resolves the old id too');
    if (stand && D.aliasDisc) ok(conv.mediaDisc === D.aliasDisc[1] && conv.mdex.includes(D.aliasDisc[1]) && !conv.mdex.includes(D.aliasDisc[0]), `media + mediaDex aliased (${conv.mediaDisc})`);
    ok(conv.tvc.length === 1 && conv.tvc[0].uid === tv && conv.tvc[0].defId === D.consoleId, `tvConsoles: one per placed TV, junk dropped (${JSON.stringify(conv.tvc)})`);
    await waitFor(page, ({ c, n }) => window.__game.ctx.inventory.countDefAll(c) >= n, 'console refund', 15000, { c: D.consoleId, n: before.con + 2 }).catch(() => null);
    ok((await countAll(D.consoleId)) >= before.con + 2, `the duplicate + orphan consoles went to the 함선 창고 (${before.con} → ${await countAll(D.consoleId)})`);
    await sleep(800);                                               // the migrated state is written back (debounced save)
    await H(() => { window.__game.ctx.housing.save(); window.__game.ctx.inventory.save?.(); });
    const rewritten = await H(() => JSON.parse(localStorage.getItem('scav.s1.ship')));
    ok(!rewritten.books.some((b) => b.defId === fromB) && rewritten.books.filter((b) => b.defId === toB).length === 1 && rewritten.tvConsoles.length === 1,
      'the converted ship is written back (no old id, no duplicate) — the next load refunds nothing');
    const afterFirst = { to: await countAll(toB), con: await countAll(D.consoleId) };
    await page.reload({ waitUntil: 'load' });
    await setup();
    await sleep(600);
    ok((await countAll(toB)) <= afterFirst.to && (await countAll(D.consoleId)) <= afterFirst.con, `a second reload does not refund again (${afterFirst.to} → ${await countAll(toB)})`);
  } else skip(`alias / console data missing (alias ${!!D.aliasBook}, console ${D.consoleId}, tv ${tv})`);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
