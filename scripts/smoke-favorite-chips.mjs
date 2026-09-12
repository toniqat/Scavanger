// 2026-09-12 (E2): 즐겨찾기 칩 · 기업 화면 · 특정 아이템 회수 계약.
//   ① 칩 우클릭 메뉴 (`ui/hud/ItemFavoriteMenu` — `.item-chip[data-def-id]` 위임): 켜기 → 같은 def 의 칩 전부 `.is-favorite`,
//      끄기 라벨, Escape · 바깥 클릭으로 닫힘, 새로 만든 칩은 공급자에게 물어 띠를 달고 나온다, 띠 ::after 가 그려진다.
//   ② 기업 상점 타일(`[data-fav-menu]` 옵트인)에 같은 메뉴 → 가지고 있지 않은 상점 물품을 켠다.
//   ③ 판매칸의 즐겨찾기: 거래 성사 1초 홀드 뒤 한 번 더 확인(`.cv-ask`) — Escape 취소(아이템 · 크레딧 그대로), 짧게 누르면 안 됨,
//      1초 홀드면 판매. 즐겨찾기가 아닌 판매는 묻지 않는다. `귀중품 전부 담기` 는 즐겨찾기를 건너뛴다.
//   ④ 계약: 기업마다 아이템 회수 2줄, 계약 행에 아이템 칩(보유/필요) + 우클릭 메뉴, 정산 — 없음 = incomplete, 탈출 실패 = failed,
//      몸에 2개 = success(신뢰도 · 크레딧), hit 는 무시.
// E1(inventory 즐겨찾기 코어)이 아직 없으면 `ctx.inventory` 인스턴스에 같은 모양의 스텁을 심는다 (`stub` 로그).
// Usage: node scripts/smoke-favorite-chips.mjs [http://localhost:5273/]   (vite dev server; the relay socket is parked)
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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1600,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const P = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.meta && !!window.__game.ctx.inventory && !!window.__game.ctx.loot, 'boot');
  await P(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 60000, t0 + sec); };
  const tap = (code) => P((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  /** Right-click the first element matching `sel` (bubbling `contextmenu` at its centre). */
  const rightClick = (sel) => P((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return true;
  }, sel);
  const menu = () => P(() => {
    const m = document.querySelector('.icm');
    return { open: !!m && !m.hidden, head: m?.querySelector('.icm-head')?.textContent ?? '', label: m?.querySelector('.icm-label')?.textContent ?? '' };
  });
  const isFav = (id) => P((d) => window.__game.ctx.inventory.isFavorite?.(d) === true, id);
  const view = 'window.__game.getSystem("meta").views.values().next().value';

  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitSim(0.3);

  /* ── E1 API (or a stub with the same shape) ───────────────────────────── */
  const stubbed = await P(() => {
    const inv = window.__game.ctx.inventory;
    if (typeof inv.toggleFavorite === 'function' && typeof inv.isFavorite === 'function') return false;
    const set = new Set();
    inv.isFavorite = (id) => set.has(id);
    inv.toggleFavorite = (id, on) => {
      const want = on === undefined ? !set.has(id) : !!on;
      if (want === set.has(id)) return want;
      if (want) set.add(id); else set.delete(id);
      window.__game.ctx.bus.emit('inventory:favoritesChanged', { defId: id, favorite: want });
      return want;
    };
    return true;
  });
  console.log(stubbed ? 'favorites: stub (E1 API not on ctx.inventory yet)' : 'favorites: real InventoryRef API');
  // start from a clean slate for the defs this script flips
  const FAV_IDS = ['mat_scrap', 'gem_quartz', 'gem_amber', 'sample_canister'];
  await P((ids) => { const inv = window.__game.ctx.inventory; for (const id of ids) inv.toggleFavorite(id, false); }, FAV_IDS);

  /* ── ① chip menu ──────────────────────────────────────────────────────── */
  console.log('chip right-click menu');
  await P(() => {
    const host = document.createElement('div');
    host.id = 'smoke-fav-host';
    host.style.cssText = 'position:fixed;left:40px;top:40px;display:flex;gap:10px;z-index:50';
    // two chips of the same def + one other, marked up exactly like `shared/itemChip.buildItemChip`
    for (const id of ['mat_scrap', 'mat_scrap', 'mat_cable']) {
      const c = document.createElement('div');
      c.className = 'item-chip'; c.dataset.defId = id; c.style.setProperty('--chip-size', '34px');
      const t = document.createElement('div'); t.className = 'item-chip-thumb'; c.appendChild(t);
      host.appendChild(c);
    }
    window.__game.ctx.uiRoot.appendChild(host);
  });
  ok(await rightClick('#smoke-fav-host .item-chip[data-def-id="mat_scrap"]'), 'synthetic chip right-clicked');
  let m = await menu();
  ok(m.open && m.label === '즐겨찾기 켜기' && m.head.length > 0 && m.head !== 'mat_scrap', 'menu opens: 즐겨찾기 켜기 + item name', JSON.stringify(m));
  await P(() => document.querySelector('.icm .icm-item').click());
  m = await menu();
  const chipsOn = await P(() => [...document.querySelectorAll('#smoke-fav-host .item-chip')].map((c) => c.classList.contains('is-favorite')));
  ok(!m.open, 'menu closes after the pick');
  ok(await isFav('mat_scrap'), 'toggleFavorite(mat_scrap) → favorite');
  ok(chipsOn[0] && chipsOn[1] && !chipsOn[2], 'both mat_scrap chips get .is-favorite, mat_cable does not', JSON.stringify(chipsOn));
  const ribbon = await P(() => getComputedStyle(document.querySelector('#smoke-fav-host .item-chip.is-favorite .item-chip-thumb'), '::after').backgroundImage);
  ok(typeof ribbon === 'string' && ribbon.includes('gradient'), 'favorite chip draws the diagonal ribbon (::after gradient)', ribbon);
  await rightClick('#smoke-fav-host .item-chip[data-def-id="mat_scrap"]');
  m = await menu();
  ok(m.open && m.label === '즐겨찾기 끄기', 'second right-click reads 즐겨찾기 끄기', JSON.stringify(m));
  await P(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 900, clientY: 700 })));
  ok(!(await menu()).open, 'pointerdown outside closes the menu');
  // an event from elsewhere (inventory's own menu, another client state) repaints chips already on screen
  await P(() => window.__game.ctx.inventory.toggleFavorite('mat_cable', true));
  ok(await P(() => document.querySelector('#smoke-fav-host .item-chip[data-def-id="mat_cable"]').classList.contains('is-favorite')), 'inventory:favoritesChanged repaints an existing chip');
  await P(() => window.__game.ctx.inventory.toggleFavorite('mat_cable', false));
  ok(await P(() => !document.querySelector('#smoke-fav-host .item-chip[data-def-id="mat_cable"]').classList.contains('is-favorite')), '… and clears it again');

  /* ── corp screen ──────────────────────────────────────────────────────── */
  console.log('corp screen');
  await P(() => { const m = window.__game.ctx.meta; m.resetMeta(); m.addRep('ceres', 100, 'smoke'); m.addCredits(5000, 'smoke'); });
  await P(() => window.__game.ctx.meta.openCorpMenu('ceres'));
  await waitFor(page, () => window.__game.ctx.meta.isMenuOpen && !!document.querySelector('.corp-view'), 'corp tab');
  await waitSim(0.2);

  // Escape closes the menu before the Tab window (topmost first)
  await rightClick('#smoke-fav-host .item-chip[data-def-id="mat_scrap"]');
  ok((await menu()).open, 'menu opens over the Tab window');
  await tap('Escape');
  await waitSim(0.25);
  ok(!(await menu()).open && await P(() => window.__game.ctx.meta.isMenuOpen), 'Escape closes the menu, the 기업 window stays open');

  // a chip built after the flip asks the source: quest reward / delivery chips of a favorite def
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="quests"]').click());
  await waitSim(0.1);
  const questChip = await P(() => {
    const chips = [...document.querySelectorAll('.cq-deliver .item-chip[data-def-id], .cq-rewards .item-chip[data-def-id]')];
    return chips.map((c) => c.dataset.defId)[0] ?? null;
  });
  if (questChip) {
    await P((id) => window.__game.ctx.inventory.toggleFavorite(id, true), questChip);
    await P((v) => eval(v).refresh(), view);
    ok(await P((id) => document.querySelector(`.cq-col.detail .item-chip[data-def-id="${id}"]`)?.classList.contains('is-favorite') === true, questChip),
      `rebuilt quest chip (${questChip}) comes out with .is-favorite`);
    await rightClick(`.cq-col.detail .item-chip[data-def-id="${questChip}"]`);
    m = await menu();
    ok(m.open && m.label === '즐겨찾기 끄기', 'quest chip takes the menu (끄기)', JSON.stringify(m));
    await P(() => document.querySelector('.icm .icm-item').click());
    ok(!(await isFav(questChip)), 'quest chip menu turned it off');
  } else ok(false, 'ceres quest page has an item chip');

  /* ── ② shop tile ──────────────────────────────────────────────────────── */
  console.log('shop tiles');
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]').click());
  await waitSim(0.15);
  const shopId = await P(() => document.querySelector('.cv-tile.shop[data-fav-menu][data-def-id]')?.dataset.defId ?? null);
  ok(!!shopId, 'shop tiles opt into the menu ([data-fav-menu])', String(shopId));
  if (shopId) {
    const owned = await P((id) => window.__game.ctx.inventory.countDefAll(id), shopId);
    await rightClick(`.cv-tile.shop[data-def-id="${shopId}"]`);
    m = await menu();
    ok(m.open && m.label === '즐겨찾기 켜기', `shop tile right-click → menu (owned ${owned})`, JSON.stringify(m));
    await P(() => document.querySelector('.icm .icm-item').click());
    ok(await isFav(shopId), 'shop stock toggled on');
    ok(await P((id) => !!document.querySelector(`.cv-tile.shop[data-def-id="${id}"][data-fav-menu]`), shopId), 'shop grid rebuilt after the flip, tile keeps the opt-in');
    await P((id) => window.__game.ctx.inventory.toggleFavorite(id, false), shopId);
  }
  const ghostOpt = await P(() => document.querySelectorAll('.cv-ghost[data-fav-menu]').length);
  ok(ghostOpt === 0, 'drag ghost does not opt in');

  /* ── ③ favorite sale confirmation ─────────────────────────────────────── */
  console.log('favorite sale');
  const put = (id) => P((d) => {
    const c = window.__game.ctx;
    const it = c.loot.createItem(d, 1);
    const where = c.inventory.tryAddItemAnywhere(it);
    return where ? it.uid : null;
  }, id);
  const quartz = await put('gem_quartz');
  const amber = await put('gem_amber');
  ok(!!quartz && !!amber, 'gem_quartz + gem_amber placed', `${quartz} ${amber}`);
  await P(() => window.__game.ctx.inventory.toggleFavorite('gem_quartz', true));

  // 귀중품 전부 담기 skips the favorite
  await P(() => document.querySelector('.cv-stage').click());
  await waitSim(0.1);
  let staged = await P((v) => eval(v).staged.sell.map((s) => s.uid), view);
  ok(staged.includes(amber) && !staged.includes(quartz), '귀중품 전부 담기 stages amber, skips the favorite quartz', JSON.stringify(staged));
  ok(await P(() => /즐겨찾기 \d+점 제외/.test(document.querySelector('.corp-view .form-msg')?.textContent ?? '')), 'the message says how many favorites were left out');

  // a non-favorite basket settles without asking (real 거래 성사 hold)
  const creditsA = await P(() => window.__game.ctx.meta.credits);
  const holdConfirm = async (sel, ms) => {
    await P((s) => { const b = document.querySelector(s); const r = b.getBoundingClientRect(); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r.left + 4, clientY: r.top + 4 })); }, sel);
    await sleep(ms);
    await P((s) => { const b = document.querySelector(s); b?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 })); }, sel);
  };
  await holdConfirm('.cv-confirm', 1350);
  await sleep(100);
  ok(!(await P((v) => eval(v).isFavoriteAskOpen, view)), 'non-favorite sale: no confirmation');
  ok(await P((u) => !window.__game.ctx.inventory.findItemAnywhere(u), amber) && (await P(() => window.__game.ctx.meta.credits)) > creditsA, 'amber sold, credits up');

  // stage the favorite by hand → the hold opens the confirmation
  await P((a) => { const v = eval(a.view); v.stageSell(window.__game.ctx.inventory.findItemAnywhere(a.uid)); }, { view, uid: quartz });
  const creditsB = await P(() => window.__game.ctx.meta.credits);
  await holdConfirm('.cv-confirm', 1350);
  await sleep(100);
  let ask = await P(() => { const a = document.querySelector('.cv-ask'); return { open: !!a && !a.hidden, title: a?.querySelector('.cv-ask-title')?.textContent, body: a?.querySelector('.cv-ask-body')?.textContent }; });
  ok(ask.open && ask.title === '즐겨찾기 아이템 판매' && /석영/.test(ask.body ?? ''), 'favorite in the 판매칸 → 즐겨찾기 아이템 판매 confirmation naming it', JSON.stringify(ask));
  await P(() => document.querySelector('.cv-ask-ok').click());
  await tap('Enter');
  await sleep(150);
  ok(await P((v) => eval(v).isFavoriteAskOpen, view), 'click / Enter do not confirm');
  await holdConfirm('.cv-ask-ok', 200);
  await sleep(150);
  ok(await P((v) => eval(v).isFavoriteAskOpen, view) && await P((u) => !!window.__game.ctx.inventory.findItemAnywhere(u), quartz), 'a short press does not confirm');
  await tap('Escape');
  await waitSim(0.25);
  ok(!(await P((v) => eval(v).isFavoriteAskOpen, view)), 'Escape cancels the confirmation');
  ok(await P((u) => !!window.__game.ctx.inventory.findItemAnywhere(u), quartz) && (await P(() => window.__game.ctx.meta.credits)) === creditsB, '… nothing sold, credits unchanged');
  ok(await P(() => window.__game.ctx.meta.isMenuOpen) && (await P((v) => eval(v).staged.sell.length, view)) === 1, '… the 기업 window and the staged basket survive');
  await holdConfirm('.cv-confirm', 1350);
  await sleep(100);
  ok(await P((v) => eval(v).isFavoriteAskOpen, view), 'confirmation again');
  await holdConfirm('.cv-ask-ok', 1350);
  await sleep(150);
  ok(!(await P((v) => eval(v).isFavoriteAskOpen, view)), 'held 그래도 판매 closes the popup');
  ok(await P((u) => !window.__game.ctx.inventory.findItemAnywhere(u), quartz) && (await P(() => window.__game.ctx.meta.credits)) > creditsB, 'favorite quartz sold after the 1 s hold');

  /* ── ④ item contracts ─────────────────────────────────────────────────── */
  console.log('item contracts');
  const perCorp = await P(() => {
    const c = window.__game.ctx;
    const out = {};
    for (const corp of ['helix', 'bastion', 'nomad', 'ceres']) {
      const list = c.meta.getContracts(corp).filter((x) => x.def.goal === 'extract_with_items');
      out[corp] = list.map((x) => ({ id: x.def.id, item: x.def.itemDefId, known: !!c.loot.getItemDef(x.def.itemDefId), target: x.def.target, lv: x.def.minRepLevel }));
    }
    return out;
  });
  ok(Object.values(perCorp).every((l) => l.length >= 1 && l.length <= 2 && l.every((x) => x.known && x.target >= 1)), 'every corp has 1–2 extract_with_items contracts with a known item', JSON.stringify(perCorp));
  ok(await P(() => window.__game.ctx.meta.getContracts('helix').filter((x) => x.def.goal !== 'extract_with_items').every((x) => x.def.itemDefId === undefined)), 'other goals carry no itemDefId');

  // clear any leftover sample canisters from the body so the count starts at 0
  await P(() => { const c = window.__game.ctx; for (const it of [...c.inventory.getAllItems()]) if (it.defId === 'sample_canister') c.inventory.takeItem(it.uid); });
  ok(await P(() => window.__game.ctx.meta.acceptContract('ceres_samples')), 'acceptContract(ceres_samples)');
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="contracts"]').click());
  await waitSim(0.15);
  let row = await P(() => {
    const chip = document.querySelector('.cc-list .corp-row.contract[data-id="ceres_samples"] .cc-item .item-chip[data-def-id="sample_canister"]');
    return chip ? { have: chip.querySelector('.item-chip-have')?.textContent, need: chip.querySelector('.item-chip-need')?.textContent, short: chip.classList.contains('is-short'),
      name: chip.parentElement.querySelector('.nm')?.textContent, activeChip: !!document.querySelector('.cc-active .cc-item .item-chip[data-def-id="sample_canister"]') } : null;
  });
  ok(row && row.have === '0' && row.need === '2' && row.short && row.name === '샘플 캐니스터' && row.activeChip, 'contract row (list + 진행 중) shows the item chip 0/2 + name', JSON.stringify(row));
  await rightClick('.cc-list .corp-row.contract[data-id="ceres_samples"] .cc-item .item-chip');
  m = await menu();
  ok(m.open && m.label === '즐겨찾기 켜기', 'contract item chip takes the favorite menu', JSON.stringify(m));
  await P(() => document.querySelector('.icm .icm-item').click());
  ok(await isFav('sample_canister'), 'contract item favorited without owning it');
  await P(() => window.__game.ctx.inventory.toggleFavorite('sample_canister', false));

  const stats = (extracted) => ({ seed: 7, kills: 0, cratesOpened: 0, damageTaken: 0, timeSeconds: 90, lootValue: 0, extracted, mode: 'raid' });
  await P(() => window.__game.ctx.meta.reportContractHit('extract_with_items', 5, true));
  ok(await P(() => window.__game.ctx.meta.activeContract.progress) === 0, 'hits never move an item contract');
  let st = await P((s) => window.__game.ctx.meta.settleMission(s), stats(true));
  ok(st && st.outcome === 'incomplete' && st.progress === 0 && !st.success && st.credits === 0, 'extracted without the items → incomplete', JSON.stringify(st));
  ok(await P(() => window.__game.ctx.meta.activeContract?.def.id) === 'ceres_samples', 'contract kept');

  // 2026-09-12 (§5-2): only units **found in the raid** count (`ItemInstance.raidFound` = the mission seed). This script settles
  // in the ship, so it stamps the seed of `stats()` (7) by hand — the real raid flow is `smoke-recovery-contract`.
  const bagPlaced = await P(() => {
    const c = window.__game.ctx;
    const a = c.loot.createItem('sample_canister', 1), b = c.loot.createItem('sample_canister', 1);
    a.raidFound = 7;
    window.__smokeCanisterB = b;
    return [c.inventory.tryAddItem(a), c.inventory.tryAddItem(b)];
  });
  ok(bagPlaced[0] && bagPlaced[1], 'two sample canisters in the bag grid', JSON.stringify(bagPlaced));
  ok(await P(() => window.__game.getSystem('meta').carriedCount('sample_canister', 7)) === 1, 'carriedCount(seed 7) = 1 — the unmarked (brought) canister does not count');
  ok(await P(() => window.__game.getSystem('meta').carriedCount('sample_canister')) === 0, 'carriedCount() in the ship = 0 (no raid running)');
  await P(() => { window.__smokeCanisterB.raidFound = 7; delete window.__smokeCanisterB; });
  // one more in the 함선 창고 must not count (the body only)
  await P(() => { const c = window.__game.ctx; const s = c.loot.createItem('sample_canister', 1); s.raidFound = 7; c.inventory.tryAddToStash(s); });
  ok(await P(() => window.__game.getSystem('meta').carriedCount('sample_canister', 7)) === 2, 'carriedCount = 2 (stash copy ignored)');
  await P((v) => eval(v).refresh(), view);
  row = await P(() => {
    const chip = document.querySelector('.cc-list .corp-row.contract[data-id="ceres_samples"] .cc-item .item-chip');
    return { have: chip?.querySelector('.item-chip-have')?.textContent, short: chip?.classList.contains('is-short'), text: chip?.closest('.mid')?.querySelector('.goal-text')?.textContent };
  });
  // 2026-09-12 (§5-2): the row shows `carriedCount` of the **running raid** — in the ship nothing counts (brought units never do),
  // so it reads 0 / 2 even with two canisters on the body
  ok(row.have === '0' && row.short && /아이템 회수 0 \/ 2/.test(row.text ?? ''), 'ship: row chip 0/2 and goal text 아이템 회수 0 / 2 (no raid → nothing counts)', JSON.stringify(row));

  st = await P((s) => window.__game.ctx.meta.settleMission(s), stats(false));
  ok(st && st.outcome === 'failed' && !st.success, 'raid failed with the items → failed (no reward)', JSON.stringify(st));
  const before = await P(() => ({ credits: window.__game.ctx.meta.credits, rep: window.__game.ctx.meta.getRep('ceres').rep }));
  st = await P((s) => window.__game.ctx.meta.settleMission(s), stats(true));
  const after = await P(() => ({ credits: window.__game.ctx.meta.credits, rep: window.__game.ctx.meta.getRep('ceres').rep, active: window.__game.ctx.meta.activeContract }));
  ok(st && st.outcome === 'success' && st.success && st.progress === 2 && st.rep === 130 && st.credits === 260 && st.xp === 330, 'extracted with 2 on the body → success (130 rep · 330 xp · 260 C)', JSON.stringify(st));
  ok(after.credits - before.credits === 260 && after.rep - before.rep === 130 && after.active === null, 'rewards paid, contract cleared', JSON.stringify({ before, after }));

  // clean up what this script added
  await P((ids) => {
    const c = window.__game.ctx;
    for (const it of [...c.inventory.getAllItems(), ...c.inventory.getStashItems()]) if (it.defId === 'sample_canister') c.inventory.takeItem(it.uid);
    for (const id of ids) c.inventory.toggleFavorite(id, false);
    document.getElementById('smoke-fav-host')?.remove();
    c.meta.closeCorpMenu();
  }, FAV_IDS);

  const relevant = errors.filter((e) => !/WebSocket|ERR_CONNECTION|favicon|net::/i.test(e));
  ok(relevant.length === 0, 'no console errors', relevant.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\nsmoke-favorite-chips: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
