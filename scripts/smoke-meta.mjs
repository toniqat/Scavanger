// Single-player smoke test for the meta folder (Phase 5-c, 2026-09-06): credits / reputation / corp shop (filter, prices,
// buy, refuse) / sale / contracts (accept gating, kill progress from a real enemy, squad share, death + success settlement)
// / quests (deliver, rewards, chain unlock) / reload persistence / the corp network screen (DOM, blocker, tabs, Esc).
// Phase 7 (2026-09-06): `canFit` pre-check (공간 없음 before the click), server credits through a fake `ctx.net.profile`
// (optimistic debit → `credits:tx` → `meta:purchase` on the answer, refusal reverts, sell / addCredits go through the
// transaction, `profile.set('meta')` on save, `net:profileLoaded` replace + migrate), settlement `outcome`, training.
// Phase 12 (2026-09-08): 세레스 바이오 implants — common / uncommon stat implants + repair materials on the shelf (no other corp,
// no rare+, no broken ones), a broken implant sells for a quarter, the 임플란트 desk tab (ceres only): grid of broken implants,
// result + material chips + fee, 수리 swaps broken → working (materials + credits consumed, stash first), reasons 재료 부족 /
// 크레딧 부족 gate the button, the ci1 → ci3 implant quest chain with its reward chip.
// 2026-09-11 (C-16 · X-1): the same crate id opened twice in a raid → `open_crates` +1 and `감정` appraisal XP once; a new mission counts it again.
// 2026-09-11 (E-9): the sale price is a `floor` — the bundle = floor(value × 0.5 × qty), no split ever pays more than
// the bundle, one unit of a value-1 item is 0 C and **that sale is allowed** (credits unchanged · only the sold
// quantity leaves · no `credits:tx` is sent · it stages in the trade desk's sell tray with a price badge of `0`).
// Usage: node scripts/smoke-meta.mjs [http://localhost:5273/]   (needs a vite dev server; no relay required)
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
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const skipped = (label, why = '') => { skip++; console.log(`  skip ${label} ${why}`); };
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
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. The tutorial starts on its own for a new profile and
    // locks room purposes · crafting · the terminal · boarding in order, so it is marked here as "already done"
    // (the tutorial itself is what scripts/smoke-tutorial.mjs looks at).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); scripts fake `pointerLockElement`.
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket (another agent's save would otherwise full-reload the page mid-run)
  // AND the relay socket (`/ws?t=`): a relay that happens to run on 8787 would hand the page a real server profile and make
  // credits server-owned mid-run — this script drives that path itself with a fake `ctx.net.profile`.
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['meta:loaded', 'meta:creditsChanged', 'meta:repChanged', 'meta:contractAccepted', 'meta:contractAbandoned', 'meta:contractProgress',
    'meta:contractSettled', 'meta:questChanged', 'meta:purchase', 'meta:sale', 'ui:corpToggled', 'enemy:killed', 'ui:notify'];
  // Boot (or re-boot after a reload): frame driver for a hidden tab, fake pointer lock, bus recorder.
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.meta && !!window.__game.ctx.inventory && !!window.__game.ctx.loot, 'boot');
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
        bus.on(n, (p) => { try { window.__ev[n].push(JSON.parse(JSON.stringify(p))); } catch { window.__ev[n].push({}); } });
      }
    }, EVENTS);
  };
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const P = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const credits = () => P(() => window.__game.ctx.meta.credits);
  const rep = (c) => P((c) => window.__game.ctx.meta.getRep(c), c);
  const enterHub = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
    await waitSim(0.2);
  };

  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  await enterHub();

  console.log('fresh save');
  await P(() => window.__game.ctx.meta.resetMeta());
  ok(await credits() === 500, 'resetMeta → credits 500', `${await credits()}`);
  let r = await rep('helix');
  ok(r.rep === 0 && r.level === 0 && r.next === 100, 'helix rep 0 / Lv.0 / next 100', JSON.stringify(r));
  const shop0 = await P(() => window.__game.ctx.meta.getShop('helix'));
  ok(Array.isArray(shop0) && shop0.length === 0, 'getShop(helix) empty below SHOP_UNLOCK_REP_LEVEL', `${shop0.length}`);
  ok(await P(() => window.__game.ctx.meta.priceOf('helix', 'wpn_ar')) === null, 'priceOf null while the shop is closed');
  ok(await P(() => window.__game.ctx.meta.activeContract) === null, 'no active contract');
  const loaded = await lastEv('meta:loaded');
  ok(loaded && loaded.credits === 500, 'meta:loaded {credits 500} emitted by resetMeta (the boot-time one fires before any listener)', JSON.stringify(loaded));

  // 2026-09-17 (user's decision): with every corporation at reputation Lv.0 the Tab window's 기업 tab hides and
  // the ship computer (openCorpMenu) does not open either
  console.log('corp tab gate (all Lv.0)');
  const gate0 = await P(() => {
    const c = window.__game.ctx;
    c.meta.openCorpMenu('helix');
    const refused = !c.inventory.isOpen;
    const opened = c.inventory.openScreen('corp');
    const ui = window.__game.getSystem('inventory').ui;
    return { refused, opened, tab: c.inventory.screenTab, hidden: ui.tabButtons.get('corp').hidden, invOpen: c.inventory.isOpen };
  });
  ok(gate0.refused && gate0.opened === false && gate0.tab === 'inventory' && gate0.hidden === true,
    '신뢰도 Lv.0 뿐이면 기업 탭은 숨고 openCorpMenu / openScreen(corp) 는 인벤토리에 머문다', JSON.stringify(gate0));

  console.log('reputation → shop');
  await P(() => window.__game.ctx.meta.addRep('helix', 100, 'smoke'));
  // the Tab window is still open from the gate check — the tab appears live on meta:repChanged
  const gate1 = await P(() => ({ hidden: window.__game.getSystem('inventory').ui.tabButtons.get('corp').hidden }));
  ok(gate1.hidden === false, '헬릭스가 Lv.1 이 되자 열린 Tab 창에 기업 탭이 바로 나타난다', JSON.stringify(gate1));
  await P(() => window.__game.ctx.inventory.closeAll());
  let rc = await lastEv('meta:repChanged');
  ok(rc && rc.corp === 'helix' && rc.rep === 100 && rc.level === 1 && rc.levelUp === true && rc.delta === 100, 'meta:repChanged {helix, 100, Lv.1, levelUp}', JSON.stringify(rc));
  r = await rep('helix');
  ok(r.level === 1 && r.next === 300, 'getRep → Lv.1, next 300', JSON.stringify(r));
  const shop1 = await P(() => {
    const m = window.__game.ctx.meta, loot = window.__game.ctx.loot;
    return m.getShop('helix').map((s) => {
      const w = s.def.weaponId ? loot.getWeaponDef(s.def.weaponId) : null;
      return { id: s.def.id, cat: s.def.category, rarity: s.def.rarity, value: s.def.value, stack: s.def.stackMax, price: s.price, blocked: s.blocked, cls: w ? w.weaponClass : null, unique: w ? !!w.unique : false, ammo: s.def.ammoType ?? null };
    });
  });
  const ids1 = shop1.map((s) => s.id);
  ok(shop1.length > 0 && ['wpn_ar', 'wpn_smg', 'ammo_light', 'ammo_medium'].every((id) => ids1.includes(id)), 'Lv.1 shop lists AR I / SMG I / 경량탄 / 준중량탄', ids1.join(','));
  ok(shop1.every((s) => s.rarity === 'common' || s.rarity === 'uncommon'), 'no rarity above the Lv.1 cap (uncommon)', shop1.filter((s) => s.rarity !== 'common' && s.rarity !== 'uncommon').map((s) => s.id).join(','));
  ok(shop1.every((s) => !s.unique), 'no unique weapons on the shelf');
  const helixRule = (s) => (s.cat === 'primary' && (s.cls === 'AR' || s.cls === 'SMG')) || (s.cat === 'ammo' && (s.ammo === 'light' || s.ammo === 'medium'));
  ok(shop1.every(helixRule), 'only helix stock rules match (AR/SMG, light/medium ammo)', JSON.stringify(shop1.filter((s) => !helixRule(s)).map((s) => s.id)));
  /* 2026-09-16: SHOP_PRICE_BASE_MUL 3 − SHOP_PRICE_DISCOUNT_PER_REP 0.15 × Lv.1 (data/tuning.csv), and one ammo
     shelf slot is a full stack, so the price is `× stackMax` too (meta/Rules.shopQtyOf — user's decision
     「탄약은 풀 스택으로 판매」). */
  const shopQty = (s) => (s.cat === 'ammo' ? Math.max(1, Math.floor(s.stack || 1)) : 1);
  ok(shop1.every((s) => s.price === Math.max(1, Math.round(s.value * 2.85)) * shopQty(s)),
    'price = round(value × (3 − 0.15)) × 매대 묶음 수 at Lv.1', JSON.stringify(shop1.slice(0, 3)));
  ok(shop1.filter((s) => s.cat === 'ammo').every((s) => shopQty(s) > 1), '탄약 매대 칸은 풀 스택이다', JSON.stringify(shop1.filter((s) => s.cat === 'ammo').map((s) => [s.id, s.stack])));
  ok(shop1.every((s) => s.blocked === null || s.blocked === '크레딧 부족'), 'blocked reasons are null or 크레딧 부족 in the ship', JSON.stringify(shop1.map((s) => s.blocked)));

  console.log('buy');
  const cheap = shop1.filter((s) => s.blocked === null).sort((a, b) => a.price - b.price)[0];
  ok(!!cheap, 'an affordable line exists', JSON.stringify(shop1.map((s) => s.price)));
  const before = await P((id) => ({ credits: window.__game.ctx.meta.credits, n: window.__game.ctx.inventory.countWhere((d) => d.id === id), items: window.__game.ctx.inventory.getAllItems().length }), cheap.id);
  const bought = await P((id) => window.__game.ctx.meta.buy('helix', id), cheap.id);
  const after = await P((id) => ({ credits: window.__game.ctx.meta.credits, n: window.__game.ctx.inventory.countWhere((d) => d.id === id), items: window.__game.ctx.inventory.getAllItems().length }), cheap.id);
  ok(bought === true, `buy(helix, ${cheap.id}) → true`);
  ok(after.credits === before.credits - cheap.price, `credits −${cheap.price}`, `${before.credits} → ${after.credits}`);
  ok(after.n > before.n || after.items > before.items, 'instance landed in the bag', JSON.stringify({ before, after }));
  const pu = await lastEv('meta:purchase');
  ok(pu && pu.corp === 'helix' && pu.defId === cheap.id && pu.price === cheap.price && pu.placed === 'bag', 'meta:purchase {helix, def, price, bag}', JSON.stringify(pu));
  const cc = await lastEv('meta:creditsChanged');
  ok(cc && cc.delta === -cheap.price && cc.credits === after.credits, 'meta:creditsChanged delta −price', JSON.stringify(cc));

  console.log('buy: canFit pre-check (Phase 7)');
  await P(() => { const inv = window.__game.ctx.inventory; window.__origCanFit = inv.canFit; inv.canFit = () => null; });
  const spaceBlocked = await P((id) => window.__game.ctx.meta.getShop('helix').find((s) => s.def.id === id)?.blocked ?? null, cheap.id);
  ok(spaceBlocked === '공간 없음', 'shop line blocked = 공간 없음 while inventory.canFit → null (before the click)', `${spaceBlocked}`);
  const purchasesA = (await ev('meta:purchase')).length;
  const credA = await credits();
  ok(await P((id) => window.__game.ctx.meta.buy('helix', id), cheap.id) === false, 'buy refused by canFit → false');
  ok(await P(() => window.__game.ctx.meta.lastPurchaseFailure?.reason ?? null) === '공간 없음', 'lastPurchaseFailure.reason = 공간 없음');
  ok(await credits() === credA && (await ev('meta:purchase')).length === purchasesA, 'no credits moved, no purchase event');
  await P(() => { const inv = window.__game.ctx.inventory; if (window.__origCanFit) inv.canFit = window.__origCanFit; else delete inv.canFit; });
  ok(await P((id) => window.__game.ctx.meta.getShop('helix').find((s) => s.def.id === id)?.blocked ?? null, cheap.id) === null, 'line unblocked again once canFit answers');

  console.log('refuse: no credits');
  const purchases = (await ev('meta:purchase')).length;
  await P(() => { const m = window.__game.ctx.meta; m.addCredits(-m.credits, 'smoke:drain'); });
  ok(await credits() === 0, 'drained to 0');
  ok(await P(() => window.__game.ctx.meta.addCredits(-1, 'smoke')) === false, 'addCredits(−1) at 0 → false');
  ok(await P((id) => window.__game.ctx.meta.buy('helix', id), cheap.id) === false, 'buy with 0 credits → false');
  ok((await ev('meta:purchase')).length === purchases, 'no purchase event on refusal');
  const blockedNow = await P((id) => window.__game.ctx.meta.getShop('helix').find((s) => s.def.id === id)?.blocked ?? null, cheap.id);
  ok(blockedNow === '크레딧 부족', 'shop line blocked = 크레딧 부족', `${blockedNow}`);
  await P((c) => window.__game.ctx.meta.addCredits(c, 'smoke:restore'), after.credits);
  ok(await credits() === after.credits, 'credits restored', `${await credits()}`);

  console.log('server credits: fake ctx.net.profile (Phase 7)');
  await P(() => {
    const net = window.__game.ctx.net;
    const fake = {
      available: true, credits: window.__game.ctx.meta.credits, docs: {}, log: [], sets: [], refuseNext: false, delayMs: 30,
      get(k) { return this.docs[k]; },
      set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); },
      flush() {},
      addCredits(delta, reason) {
        this.log.push({ delta, reason });
        return new Promise((resolve) => setTimeout(() => {
          if (this.refuseNext) { this.refuseNext = false; resolve({ ok: false, credits: this.credits ?? 0, reason: '크레딧 부족' }); return; }
          if (this.credits === null) { this.credits = reason === 'migrate' ? delta : 0; resolve({ ok: true, credits: this.credits }); return; }
          if (this.credits + delta < 0) { resolve({ ok: false, credits: this.credits, reason: '크레딧 부족' }); return; }
          this.credits += delta;
          resolve({ ok: true, credits: this.credits });
        }, this.delayMs));
      },
    };
    window.__fakeProfile = fake;
    window.__realProfileDesc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
  });
  const fp = (fn) => P(fn);
  const credS0 = await credits();
  const purchasesS = (await ev('meta:purchase')).length;
  const okS = await P((id) => window.__game.ctx.meta.buy('helix', id), cheap.id);
  const sync = await P(() => ({ credits: window.__game.ctx.meta.credits, purchases: window.__ev['meta:purchase'].length, pending: window.__game.ctx.meta.hasPendingTx, last: window.__fakeProfile.log[window.__fakeProfile.log.length - 1] }));
  ok(okS === true && sync.credits === credS0 - cheap.price && sync.purchases === purchasesS && sync.pending, 'buy() → true, optimistic debit, no meta:purchase yet, tx pending', JSON.stringify(sync));
  ok(sync.last && sync.last.delta === -cheap.price && sync.last.reason === `buy:${cheap.id}`, `profile.addCredits(−${cheap.price}, buy:${cheap.id}) sent`, JSON.stringify(sync.last));
  await waitFor(page, (n) => window.__ev['meta:purchase'].length > n, 'meta:purchase after the server answer', 10000, purchasesS);
  const afterS = await P(() => ({ credits: window.__game.ctx.meta.credits, server: window.__fakeProfile.credits, pending: window.__game.ctx.meta.hasPendingTx, pu: window.__ev['meta:purchase'][window.__ev['meta:purchase'].length - 1] }));
  ok(afterS.pu && afterS.pu.defId === cheap.id && afterS.pu.price === cheap.price && (afterS.pu.placed === 'bag' || afterS.pu.placed === 'stash'), 'meta:purchase emitted once the transaction answered', JSON.stringify(afterS.pu));
  ok(afterS.credits === afterS.server && afterS.credits === credS0 - cheap.price && !afterS.pending, 'credits = server balance after the answer', JSON.stringify(afterS));
  // refused transaction: the optimistic debit is reverted, no item, failure reported
  /* 2026-09-16: a shelf slot is a **full stack** (`meta/Rules.shopQtyOf`), so one purchase drops the balance a long
     way. A refusal only shows once it reaches the server, but with a balance under the price `Trade.buy` refuses
     locally first (크레딧 부족) — so just enough for one more purchase is topped up here (the price is read off the
     shelf, so it follows another price change). */
  await P((p) => { const m = window.__game.ctx.meta; if (m.credits < p) m.addCredits(p - m.credits, 'smoke:fund'); }, cheap.price);
  await waitFor(page, () => !window.__game.ctx.meta.hasPendingTx, 'fund answered', 10000);
  ok(await credits() >= cheap.price, `refusal test funded to ≥ ${cheap.price} C`, `${await credits()}`);
  await fp(() => { window.__fakeProfile.refuseNext = true; window.__game.ctx.meta.lastPurchaseFailure = null; });
  const credR0 = await credits();
  const purchasesR = (await ev('meta:purchase')).length;
  ok(await P((id) => window.__game.ctx.meta.buy('helix', id), cheap.id) === true, 'buy() accepted before the server refuses');
  await waitFor(page, () => !window.__game.ctx.meta.hasPendingTx, 'refusal answered', 10000);
  const refused = await P(() => ({ credits: window.__game.ctx.meta.credits, fail: window.__game.ctx.meta.lastPurchaseFailure, purchases: window.__ev['meta:purchase'].length, cc: window.__ev['meta:creditsChanged'][window.__ev['meta:creditsChanged'].length - 1] }));
  ok(refused.credits === credR0 && refused.purchases === purchasesR, 'server refusal → credits reverted, no meta:purchase', JSON.stringify(refused));
  ok(refused.fail && refused.fail.reason === '크레딧 부족' && refused.fail.defId === cheap.id, 'lastPurchaseFailure {크레딧 부족} after the refusal', JSON.stringify(refused.fail));
  ok(refused.cc && /^revert:buy:/.test(refused.cc.reason), 'meta:creditsChanged revert:buy:… on the refusal', JSON.stringify(refused.cc));
  // every other credit move is a transaction too (optimistic apply, then the server balance)
  const credT0 = await credits();
  ok(await P(() => window.__game.ctx.meta.addCredits(75, 'smoke:srv')) === true && await credits() === credT0 + 75, 'addCredits(+75) applies locally at once');
  await waitFor(page, () => !window.__game.ctx.meta.hasPendingTx, 'tx answered', 10000);
  const tx = await P(() => ({ credits: window.__game.ctx.meta.credits, server: window.__fakeProfile.credits, last: window.__fakeProfile.log[window.__fakeProfile.log.length - 1] }));
  ok(tx.last && tx.last.delta === 75 && tx.last.reason === 'smoke:srv' && tx.credits === tx.server, 'addCredits went through credits:tx and matches the server', JSON.stringify(tx));
  // save mirrors the document
  await P(() => window.__game.ctx.meta.save());
  const setsS = await P(() => ({ sets: window.__fakeProfile.sets.slice(), doc: window.__fakeProfile.docs.meta }));
  // 2026-09-14: MetaSave v2 (the NPC quests' `npc`)
  ok(setsS.sets.includes('meta') && setsS.doc && setsS.doc.v === 2 && setsS.doc.credits === tx.credits, "save → profile.set('meta', save)", JSON.stringify({ sets: setsS.sets, credits: setsS.doc?.credits, v: setsS.doc?.v }));
  // net:profileLoaded: the server document replaces the save, the balance is the server's
  const snapS = await P(() => JSON.parse(localStorage.getItem('scav.s1.meta')));
  const loadedBefore = (await ev('meta:loaded')).length;
  await P((snap) => {
    const fake = window.__fakeProfile;
    fake.docs.meta = { ...snap, credits: 5, corps: { ...snap.corps, helix: { rep: 1000, quests: {} } } };
    fake.credits = 4321;
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 4321, docs: fake.docs, updatedAt: 0 }, migrated: false });
  }, snapS);
  const pl = await P(() => ({ credits: window.__game.ctx.meta.credits, helix: window.__game.ctx.meta.getRep('helix'), loaded: window.__ev['meta:loaded'].length, rc: window.__ev['meta:repChanged'][window.__ev['meta:repChanged'].length - 1], local: JSON.parse(localStorage.getItem('scav.s1.meta')).credits }));
  ok(pl.credits === 4321 && pl.local === 4321, "net:profileLoaded → credits = server balance (4321, not the document's 5), cached locally", JSON.stringify({ credits: pl.credits, local: pl.local }));
  ok(pl.helix.rep === 1000 && pl.helix.level === 3 && pl.loaded === loadedBefore + 1 && pl.rc && pl.rc.corp === 'helix' && pl.rc.rep === 1000 && pl.rc.levelUp === true, 'server document replaced rep (helix 1000 / Lv.3) + meta:loaded + meta:repChanged {levelUp}', JSON.stringify({ helix: pl.helix, loaded: pl.loaded, rc: pl.rc }));
  // migrate: server has no balance and no document → local balance uploaded with reason 'migrate', local save uploaded
  await P((snap) => {
    const fake = window.__fakeProfile;
    // put the pre-test save back first (through the same path) so the rest of the run sees helix Lv.1 again
    fake.docs = { meta: snap }; fake.credits = snap.credits;
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: snap.credits, docs: fake.docs, updatedAt: 0 }, migrated: false });
    fake.docs = {}; fake.credits = null; fake.sets.length = 0; fake.log.length = 0;
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: null, docs: {}, updatedAt: 0 }, migrated: true });
  }, snapS);
  const mig = await P(() => ({ credits: window.__game.ctx.meta.credits, helix: window.__game.ctx.meta.getRep('helix').rep, log: window.__fakeProfile.log.slice(), sets: window.__fakeProfile.sets.slice() }));
  ok(mig.credits === snapS.credits && mig.helix === snapS.corps.helix.rep, 'restored save through net:profileLoaded (helix rep back)', JSON.stringify({ credits: mig.credits, helix: mig.helix }));
  ok(mig.log.length === 1 && mig.log[0].reason === 'migrate' && mig.log[0].delta === snapS.credits, `migrated:true → addCredits(${snapS.credits}, 'migrate')`, JSON.stringify(mig.log));
  ok(mig.sets.includes('meta'), 'no server document → local save uploaded', JSON.stringify(mig.sets));
  await waitFor(page, () => !window.__game.ctx.meta.hasPendingTx, 'migrate answered', 10000);
  ok(await P(() => window.__fakeProfile.credits === window.__game.ctx.meta.credits), 'server balance = local balance after the migration');
  await P(() => {
    const net = window.__game.ctx.net;
    if (window.__realProfileDesc) Object.defineProperty(net, 'profile', window.__realProfileDesc); else delete net.profile;
  });
  ok(await P(() => window.__game.ctx.net.profile.available === false), 'real (offline) profile restored');

  console.log('sell');
  const gem = await P(() => { const c = window.__game.ctx; const it = c.loot.createItem('gem_amber', 1); return c.inventory.tryAddItem(it) ? it.uid : null; });
  ok(!!gem, 'gem_amber added to the bag');
  /* 2026-09-16: the expected sale price is not written down — it is pulled straight from `data/items.csv`'s value and
     `shared/meta.sellPriceOf` (= floor(value × SELL_PRICE_MUL)). Only constants are read, so a second evaluation is
     harmless (scripts/README 「import('/src/…')」). So the next value rebalance does not break this assertion again. */
  const gemPrice = await P(async () => {
    const m = await import('/src/shared/meta.ts');
    const def = window.__game.ctx.loot.getItemDef('gem_amber');
    return { value: def.value, mul: m.SELL_PRICE_MUL, expect: m.sellPriceOf(def.value, 1) };
  });
  const sp = await P((uid) => window.__game.ctx.meta.sellPriceOf(uid), gem);
  ok(sp === gemPrice.expect, `sellPriceOf(gem_amber) = ${gemPrice.value} × ${gemPrice.mul} = ${gemPrice.expect}`, `${sp}`);
  const sellable = await P((uid) => window.__game.ctx.meta.getSellable().some((i) => i.uid === uid), gem);
  ok(sellable, 'getSellable() includes the gem');
  const equippedRefused = await P(() => { const lo = window.__game.ctx.inventory.getLoadout(); return lo.primary ? window.__game.ctx.meta.sellPriceOf(lo.primary.uid) : 'no-primary'; });
  ok(equippedRefused === null || equippedRefused === 'no-primary', 'sellPriceOf(equipped primary) → null', `${equippedRefused}`);
  const creditsBeforeSell = await credits();
  const sold = await P((uid) => window.__game.ctx.meta.sell(uid), gem);
  if (!sold) {
    // inventory.takeItem may still be the Phase 5 stub (returns 0, item untouched) while inventory/ is implemented concurrently
    const stub = await P((uid) => { const inv = window.__game.ctx.inventory; return typeof inv.takeItem !== 'function' || (inv.takeItem(uid, 1) === 0 && !!inv.findItem(uid)); }, gem);
    if (stub) {
      skipped(`sell(gem_amber) → +${gemPrice.expect} credits`, '(inventory.takeItem is still the stub returning 0)');
      skipped(`meta:sale {gem_amber, 1, ${gemPrice.expect}}`);
      skipped('sold item removed from the bag');
    } else {
      ok(false, 'sell(gem_amber) → true', 'takeItem works but sell returned false');
    }
  } else {
    ok(await credits() === creditsBeforeSell + gemPrice.expect, `sell(gem_amber) → +${gemPrice.expect} credits`, `${creditsBeforeSell} → ${await credits()}`);
    const sale = await lastEv('meta:sale');
    ok(sale && sale.defId === 'gem_amber' && sale.qty === 1 && sale.credits === gemPrice.expect, `meta:sale {gem_amber, 1, ${gemPrice.expect}}`, JSON.stringify(sale));
    ok(await P((uid) => !window.__game.ctx.inventory.findItem(uid), gem) === true, 'sold item removed from the bag');
  }

  // ── E-9 (2026-09-11): the sale price is a `floor` (`shared/credits.sellPriceFrom`) ──────────────────────
  // Rounding **after** the multiplication by qty pays more than the bundle when an odd-value item is split into
  // single units (경량탄 value 1 · 80 rounds: the bundle round(40)=40 C against singles round(0.5)=1 C × 80 = 80 C).
  // With a floor, splitting always loses.
  // The price of that is one unit of a value-1 item being 0 C, and **that sale stays allowed** (user's decision).
  console.log('sell: floor 반올림 + 0 C 판매 (E-9)');
  const AMMO = ['ammo_light', 'ammo_heavy', 'ammo_medium'];
  const round = await P((ids) => {
    const c = window.__game.ctx;
    const out = {};
    for (const id of ids) {
      const def = c.loot.getItemDef(id);
      if (!def) { out[id] = null; continue; }
      const want = Math.max(2, Math.min(Math.floor(def.stackMax || 1), 80));
      const it = c.loot.createItem(id, want);
      if (!c.inventory.tryAddItem(it)) { out[id] = { noRoom: true }; continue; }
      // `tryAddItem` **fills an existing stack of the same item in the bag first**, so only the remainder is left on
      // `it` (경량탄 is in the starting loadout). `sellPriceOf(uid, q)` clamps with `min(inst.qty, q)`, so the expected
      // value has to be counted from **what really stayed on this instance**, not from the quantity meant to go in,
      // for a like-for-like comparison.
      const stack = Math.max(1, Math.floor(it.qty));
      if (stack < 2) { out[id] = { tooSmall: stack }; continue; }
      const bundle = c.meta.sellPriceOf(it.uid);
      // every two-way split: however it is cut, it must never pay more than the bundle
      let worstSplit = 0;
      for (let q = 1; q < stack; q++) {
        worstSplit = Math.max(worstSplit, (c.meta.sellPriceOf(it.uid, q) ?? 0) + (c.meta.sellPriceOf(it.uid, stack - q) ?? 0));
      }
      out[id] = {
        uid: it.uid, value: def.value, stack, bundle, single: c.meta.sellPriceOf(it.uid, 1),
        expect: Math.floor(def.value * 0.5 * stack), worstSplit,
      };
    }
    return out;
  }, AMMO);
  const rounded = AMMO.map((id) => round[id]).filter((r) => r && !r.noRoom && !r.tooSmall);
  if (rounded.length === 0) skipped('판매 반올림 단언', '(가방에 탄약 스택을 넣을 자리가 없다)');
  else {
    // ① the bundle price = floor(value × SELL_PRICE_MUL × qty)
    ok(rounded.every((r) => r.bundle === r.expect),
      `묶음 판매가 = floor(value × 0.5 × qty) (${rounded.map((r) => `v${r.value}×${r.stack}=${r.bundle}`).join(' · ')})`,
      JSON.stringify(round));
    // ② the total from selling singles is not above the bundle — the proof the exploit is closed
    ok(rounded.every((r) => r.single * r.stack <= r.bundle),
      `낱개 × qty ≤ 묶음 (${rounded.map((r) => `${r.single}×${r.stack}=${r.single * r.stack} ≤ ${r.bundle}`).join(' · ')})`,
      JSON.stringify(round));
    ok(rounded.every((r) => r.worstSplit <= r.bundle),
      '어떤 2분할도 묶음보다 많이 받지 못한다', JSON.stringify(rounded.map((r) => ({ v: r.value, split: r.worstSplit, bundle: r.bundle }))));
    // the documented case: one unit of value 1 = 0 C (it used to be 1 C, twice the bundle)
    if (round.ammo_light && !round.ammo_light.noRoom && !round.ammo_light.tooSmall) {
      ok(round.ammo_light.single === 0, '가치 1 아이템 1개의 판매가 = 0 C', `${round.ammo_light.single}`);
    }
  }

  // ③ a 0 C sale is not refused — the credits stay, only the sold quantity leaves (the rest of the stack stays)
  const zeroUid = round.ammo_light && !round.ammo_light.noRoom ? round.ammo_light.uid : null;
  if (!zeroUid) skipped('0 C 판매', '(경량탄 스택이 가방에 없다)');
  else {
    const z0 = await P((uid) => ({ credits: window.__game.ctx.meta.credits, qty: window.__game.ctx.inventory.findItemAnywhere(uid)?.qty ?? 0 }), zeroUid);
    const zSold = await P((uid) => window.__game.ctx.meta.sell(uid, 1), zeroUid);
    const z1 = await P((uid) => ({ credits: window.__game.ctx.meta.credits, qty: window.__game.ctx.inventory.findItemAnywhere(uid)?.qty ?? 0 }), zeroUid);
    const zSale = await lastEv('meta:sale');
    ok(zSold === true, 'sell() of a 0 C unit → true (막지 않는다)');
    ok(z1.credits === z0.credits, '0 C 판매로 크레딧이 줄지 않는다', `${z0.credits} → ${z1.credits}`);
    ok(z1.qty === z0.qty - 1, '판 1발만 빠지고 나머지 스택은 그대로 남는다', `${z0.qty} → ${z1.qty}`);
    ok(zSale && zSale.defId === 'ammo_light' && zSale.qty === 1 && zSale.credits === 0, 'meta:sale {ammo_light, 1, 0}', JSON.stringify(zSale));

    // with server credits too: 0 C sends no `credits:tx` at all (`server/Economy.ts`'s sell demands `0 < delta`, so
    // sending it would be refused → `restoreSold` puts the item back and a "판매가 취소되었습니다" toast comes up)
    const refake = await P(() => {
      const net = window.__game.ctx.net;
      const fake = window.__fakeProfile;
      if (!fake) return false;
      fake.available = true; fake.refuseNext = false; fake.credits = window.__game.ctx.meta.credits;
      fake.log.length = 0;
      Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
      return window.__game.ctx.meta.serverCredits === true;
    });
    if (!refake) skipped('서버 크레딧에서의 0 C 판매', '(fake profile unavailable)');
    else {
      const zs0 = await P((uid) => ({ credits: window.__game.ctx.meta.credits, qty: window.__game.ctx.inventory.findItemAnywhere(uid)?.qty ?? 0 }), zeroUid);
      const zsSold = await P((uid) => window.__game.ctx.meta.sell(uid, 1), zeroUid);
      await waitFor(page, () => !window.__game.ctx.meta.hasPendingTx, '0 C sale settled', 10000).catch(() => null);
      await sleep(120);
      const zs1 = await P((uid) => ({
        credits: window.__game.ctx.meta.credits, qty: window.__game.ctx.inventory.findItemAnywhere(uid)?.qty ?? 0,
        sellTx: window.__fakeProfile.log.filter((l) => String(l.reason).startsWith('sell:')),
      }), zeroUid);
      ok(zsSold === true && zs1.sellTx.length === 0, '서버 크레딧이어도 0 C 판매는 credits:tx 를 보내지 않는다', JSON.stringify(zs1.sellTx));
      ok(zs1.credits === zs0.credits && zs1.qty === zs0.qty - 1, '0 C 서버 판매: 크레딧 그대로, 되돌려지지 않는다', JSON.stringify({ zs0, zs1 }));
      await P(() => {
        const net = window.__game.ctx.net;
        if (window.__realProfileDesc) Object.defineProperty(net, 'profile', window.__realProfileDesc); else delete net.profile;
      });
      ok(await P(() => window.__game.ctx.net.profile.available === false), 'offline profile restored after the 0 C sale');
    }
  }
  // the leftover ammo stacks are cleared away (freeing the bag cells the contract · quest steps below use)
  await P((ids) => {
    const c = window.__game.ctx;
    for (const id of ids) for (const it of [...c.inventory.getAllItems()]) if (it.defId === id) c.inventory.takeItem(it.uid);
  }, AMMO);

  console.log('contracts: accept gating');
  const cl = await P(() => window.__game.ctx.meta.getContracts('helix').map((c) => ({ id: c.def.id, blocked: c.blocked, active: c.active })));
  ok(cl.find((c) => c.id === 'helix_1')?.blocked === null && cl.find((c) => c.id === 'helix_3')?.blocked === '신뢰도 부족', 'helix_1 acceptable, helix_3 신뢰도 부족 at Lv.1', JSON.stringify(cl));
  ok(await P(() => window.__game.ctx.meta.acceptContract('helix_3')) === false, 'acceptContract(helix_3) refused (rep)');
  ok(await P(() => window.__game.ctx.meta.acceptContract('helix_1')) === true, 'acceptContract(helix_1) → true');
  const ca = await lastEv('meta:contractAccepted');
  ok(ca && ca.id === 'helix_1' && ca.corp === 'helix', 'meta:contractAccepted {helix_1}', JSON.stringify(ca));
  ok(await P(() => window.__game.ctx.meta.acceptContract('helix_2')) === false, 'second contract refused (one at a time)');
  const ac = await P(() => { const a = window.__game.ctx.meta.activeContract; return a ? { id: a.def.id, progress: a.progress, active: a.active } : null; });
  ok(ac && ac.id === 'helix_1' && ac.progress === 0 && ac.active, 'activeContract = helix_1 / 0', JSON.stringify(ac));
  const cl2 = await P(() => window.__game.ctx.meta.getContracts('helix').map((c) => ({ id: c.def.id, blocked: c.blocked })));
  ok(cl2.find((c) => c.id === 'helix_2')?.blocked === '이미 진행 중인 계약', 'other lines blocked = 이미 진행 중인 계약', JSON.stringify(cl2));

  console.log('mission (seed 21): kill progress');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await waitSim(0.3);
  const killed = await P(() => {
    const sys = window.__game.getSystem('enemies'); const p = window.__game.ctx.player.position;
    const s = sys.debugSpawn('scavenger', { x: p.x + 3, z: p.z + 3 }, false);
    if (!s) return { spawned: false };
    s.takeDamage(1000);
    return { spawned: true };
  });
  ok(killed.spawned, 'scavenger spawned via debugSpawn');
  await waitFor(page, () => window.__ev['meta:contractProgress'].length >= 1, 'meta:contractProgress', 20000);
  let cp = await lastEv('meta:contractProgress');
  ok(cp && cp.id === 'helix_1' && cp.goal === 'kill_bugs' && cp.progress === 1 && cp.target === 25 && cp.delta === 1, 'enemy:killed (bug) → meta:contractProgress 1 / 25', JSON.stringify(cp));
  await P(() => window.__game.ctx.meta.reportContractHit('kill_bugs', 30, true));
  cp = await lastEv('meta:contractProgress');
  ok(cp && cp.progress === 31 && cp.delta === 30, 'reportContractHit(kill_bugs, 30, local) → 31', JSON.stringify(cp));
  await P(() => window.__game.ctx.meta.reportContractHit('open_crates', 5, true));
  ok((await lastEv('meta:contractProgress')).progress === 31, 'a non-matching goal does not move the contract');

  console.log('settlement: death keeps only the start progress');
  const credBeforeSettle = await credits();
  const dead = await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, extracted: false }));
  ok(dead && dead.success === false && dead.progress === 31 && dead.rep === 0 && dead.credits === 0 && dead.xp === 0, 'settleMission(extracted:false) → not success, no rewards', JSON.stringify(dead));
  ok(dead.outcome === 'failed', "settlement.outcome = 'failed' on a failed raid", `${dead.outcome}`);
  let acNow = await P(() => window.__game.ctx.meta.activeContract);
  ok(acNow && acNow.progress === 0, 'progress reverted to progressAtStart (0)', JSON.stringify(acNow && acNow.progress));
  ok(await credits() === credBeforeSettle, 'credits unchanged after death');
  let cs = await lastEv('meta:contractSettled');
  ok(cs && cs.id === 'helix_1' && cs.success === false, 'meta:contractSettled {helix_1, success:false}', JSON.stringify(cs));

  console.log('settlement: training + incomplete (Phase 7)');
  const settledN = (await ev('meta:contractSettled')).length;
  ok(await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, mode: 'training', extracted: true })) === null, 'settleMission(mode:training) → null');
  ok((await ev('meta:contractSettled')).length === settledN && (await P(() => window.__game.ctx.meta.activeContract?.def.id)) === 'helix_1', 'training settles nothing (no event, contract untouched)');
  await P(() => window.__game.ctx.meta.reportContractHit('kill_bugs', 3, true));
  const short = await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, mode: 'raid', extracted: true }));
  ok(short && short.success === false && short.outcome === 'incomplete' && short.progress === 3 && short.rep === 0, "extracted short of the goal → outcome 'incomplete', no rewards", JSON.stringify(short));
  ok((await P(() => window.__game.ctx.meta.activeContract?.progress)) === 3, 'incomplete keeps the progress (3)');
  // goal counters ignore events while ctx.isTraining()
  const progN = (await ev('meta:contractProgress')).length;
  await P(() => {
    const ctx = window.__game.ctx; const V = ctx.player.position.constructor;
    ctx.missionMode = 'training';
    ctx.bus.emit('enemy:killed', { id: 990001, type: 'scavenger', position: new V(0, 0, 0) });
    ctx.missionMode = 'raid';
  });
  ok((await ev('meta:contractProgress')).length === progN && (await P(() => window.__game.ctx.meta.activeContract?.progress)) === 3, 'enemy:killed while isTraining() → no contract progress');
  await P(() => { const ctx = window.__game.ctx; const V = ctx.player.position.constructor; ctx.bus.emit('enemy:killed', { id: 990002, type: 'scavenger', position: new V(0, 0, 0) }); });
  ok((await ev('meta:contractProgress')).length === progN + 1 && (await P(() => window.__game.ctx.meta.activeContract?.progress)) === 4, 'same event in a raid → +1 (4)');

  console.log('settlement: extraction success');
  await P(() => window.__game.ctx.meta.reportContractHit('kill_bugs', 26, true));
  const repBefore = (await rep('helix')).rep;
  const win = await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, extracted: true }));
  ok(win && win.success === true && win.outcome === 'success' && win.progress === 30 && win.target === 25 && win.rep === 60 && win.xp === 150 && win.credits === 120, "settleMission(extracted:true) → success {outcome 'success', rep 60, xp 150, credits 120}", JSON.stringify(win));
  ok(await credits() === credBeforeSettle + 120, 'credits +120', `${await credits()}`);
  ok((await rep('helix')).rep === repBefore + 60, 'helix rep +60', `${(await rep('helix')).rep}`);
  ok(await P(() => window.__game.ctx.meta.activeContract) === null, 'contract cleared after success');
  cs = await lastEv('meta:contractSettled');
  ok(cs && cs.success === true && cs.credits === 120, 'meta:contractSettled {success:true}', JSON.stringify(cs));

  /* 2026-09-11 (C-16 · X-1): every further E on an already opened crate emits `crate:open` → the contract's
     `open_crates` and `감정` appraisal XP both rose each time, so it could be farmed by mashing the key. It is now once
     per crate id for the raid, and counted again on a new mission. A contract can only be accepted in the ship, so it
     is planted straight into the store here (the accept rules were already checked above). */
  console.log('open_crates: one count per crate id per raid (X-1)');
  const X1_READ = () => P(() => {
    const m = window.__game.ctx.meta;
    return { progress: m.store.data.activeContract?.progress ?? null, appraisal: window.__x1Appraisal ?? 0 };
  });
  const X1_OPEN = (id) => P((cid) => {
    const ctx = window.__game.ctx;
    ctx.bus.emit('crate:open', { crateId: cid, tier: 1, position: ctx.player.position.clone() });
    ctx.inventory.closeAll();
  }, id);
  await P(() => {
    const ctx = window.__game.ctx, m = ctx.meta, prog = ctx.progression;
    m.store.data.activeContract = { id: 'nomad_crates', progress: 0 };
    m.progressAtStart = 0;
    window.__x1Appraisal = 0;
    // `감정` appraisal XP is given by progression through `this.addSkillXp('appraisal', …)` — a spy laid over the
    // instance intercepts it
    if (prog && !window.__x1Spy) {
      const orig = prog.addSkillXp.bind(prog);
      prog.addSkillXp = (id, amt) => { if (id === 'appraisal') window.__x1Appraisal++; return orig(id, amt); };
      window.__x1Spy = true;
    }
  });
  await X1_OPEN('crate:x1-a');
  await X1_OPEN('crate:x1-a');
  const x1a = await X1_READ();
  ok(x1a.progress === 1, `open_crates: the same crate opened twice → +1 (${x1a.progress})`, JSON.stringify(x1a));
  ok(x1a.appraisal === 1, `감정 XP: the same crate opened twice → paid once (${x1a.appraisal})`, JSON.stringify(x1a));
  await X1_OPEN('crate:x1-b');
  const x1b = await X1_READ();
  ok(x1b.progress === 2 && x1b.appraisal === 2, `a different crate id still counts (+1 → ${x1b.progress}, 감정 ${x1b.appraisal})`, JSON.stringify(x1b));
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 22 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing (x1 mission)', 25000);
  await waitSim(0.2);
  await P(() => { window.__x1Appraisal = 0; });
  await X1_OPEN('crate:x1-a');
  const x1c = await X1_READ();
  ok(x1c.progress === 3 && x1c.appraisal === 1, `after game:newMission the same id counts again (open_crates ${x1c.progress}, 감정 ${x1c.appraisal})`, JSON.stringify(x1c));
  await P(() => { const m = window.__game.ctx.meta; m.store.data.activeContract = null; m.progressAtStart = 0; m.store.markDirty(); });

  console.log('squad share');
  await enterHub();
  ok(await P(() => window.__game.ctx.meta.acceptContract('helix_1')) === true, 're-accept helix_1 in the ship');
  await P(() => window.__game.ctx.meta.reportContractHit('kill_bugs', 4, false));
  cp = await lastEv('meta:contractProgress');
  ok(cp && cp.progress === 1 && cp.delta === 1, 'reportContractHit(kill_bugs, 4, remote) → +1 (× CONTRACT_SQUAD_SHARE 0.25)', JSON.stringify(cp));
  ok(await P(() => window.__game.ctx.meta.abandonContract()) === true, 'abandonContract → true');
  const cab = await lastEv('meta:contractAbandoned');
  ok(cab && cab.id === 'helix_1' && (await P(() => window.__game.ctx.meta.activeContract)) === null, 'meta:contractAbandoned + no active contract', JSON.stringify(cab));

  /* 2026-09-14: corp quests dropped (src/meta/README.md Decisions) — the old API returns an
     empty list · false, and the NPC quests are what scripts/smoke-npc-quests.mjs looks at. The helix reputation the
     checks below expect (Lv.2 · 310) is made up by adding the old h1 reward of 150 directly. */
  console.log('corp quests are gone');
  ok(await P(() => window.__game.ctx.meta.getQuests('helix').length) === 0, 'getQuests(helix) → [] (기업 퀘스트 없음)');
  ok(await P(() => window.__game.ctx.meta.acceptQuest('h1')) === false && await P(() => window.__game.ctx.meta.completeQuest('h1')) === false, 'acceptQuest / completeQuest → false');
  ok(await P(() => window.__game.ctx.meta.getQuestState('h1')) === 'locked', 'getQuestState(unknown) → locked');
  await P(() => window.__game.ctx.meta.addRep('helix', 150, 'smoke'));

  console.log('persistence: reload');
  const snap = { credits: await credits(), rep: (await rep('helix')).rep, level: (await rep('helix')).level };
  await P(() => window.__game.ctx.meta.save());
  const saved = await P(() => { try { return JSON.parse(localStorage.getItem('scav.s1.meta')); } catch { return null; } });
  ok(saved && saved.v === 2 && saved.credits === snap.credits && saved.corps.helix.rep === snap.rep && saved.activeContract === null && saved.npc && typeof saved.npc.quests === 'object',
    'localStorage scav.s1.meta v2 holds credits / rep / npc', JSON.stringify(saved && { v: saved.v, credits: saved.credits, npc: !!saved.npc }));
  await page.reload({ waitUntil: 'load' });
  await boot();
  ok(await credits() === snap.credits, `credits persisted (${snap.credits})`, `${await credits()}`);
  const rr = await rep('helix');
  ok(rr.rep === snap.rep && rr.level === snap.level, `helix rep persisted (${snap.rep} / Lv.${snap.level})`, JSON.stringify(rr));
  console.log('corp screen');
  await enterHub();
  await P(() => window.__game.ctx.meta.openCorpMenu('ceres'));
  await sleep(50);
  const dom = await P(() => {
    // 2026-09-07: the standalone `.menu.corp-menu` overlay is gone — the 기업 screen is the Tab window's 기업 tab
    const root = document.querySelector('.inv-screen.corp-view');
    if (!root) return null;
    const tabs = [...root.querySelectorAll('.corp-tab')].map((b) => ({ corp: b.dataset.corp, on: b.classList.contains('is-on') }));
    // Phase 12: the 임플란트 tab exists in the DOM for every corp but is `hidden` unless the corp is 세레스 바이오
    const subs = [...root.querySelectorAll('.corp-subtabs .scr-tab:not([hidden])')].map((b) => ({
      page: b.dataset.page, on: b.classList.contains('is-on'),
      // 2026-09-08: a page short of reputation has its tab locked (the reason is the title)
      locked: b.classList.contains('is-locked'), disabled: b.disabled, why: b.title,
    }));
    const ctx = window.__game.ctx;
    return {
      hidden: root.hidden, oldOverlay: !!document.querySelector('.menu.corp-menu'),
      corpBlocker: ctx.uiBlockers.has('corp'), blocker: ctx.uiBlockers.has('inventory'),
      isOpen: ctx.meta.isMenuOpen, tab: ctx.inventory.screenTab, invOpen: ctx.inventory.isOpen,
      cursor: ctx.input.isCursorMode,
      // 2026-09-12: the left column is a tree — the corp buttons, with a branch (the reputation gauge + the page
      // tabs) right under the selected corp. No credits on it.
      // 2026-09-12 2nd pass (user's decision): that column is **a panel of its own, separate from the main one** —
      // `.corp-rail` comes out as a direct child of the screen host (`.corp-view`) rather than of `.corp-shell`, and
      // stands on its own left of the screen centre. The '기업' label top left was removed too.
      railTabs: root.querySelectorAll('.corp-view > .corp-rail .corp-tabs .corp-tab').length,
      railDetached: !root.querySelector('.corp-shell .corp-rail'),
      railOrder: [...root.querySelectorAll('.corp-view > .corp-rail > *')].map((e) => e.className.split(' ')[0]),
      tree: [...root.querySelectorAll('.corp-rail .corp-tabs > *')].map((e) => e.classList.contains('corp-branch') ? 'branch' : e.dataset.corp),
      branchParts: [...root.querySelectorAll('.corp-branch > *')].map((e) => e.className.split(' ')[0]),
      expanded: root.querySelector('.corp-tab[aria-expanded="true"]')?.dataset.corp ?? null,
      oldPanel: !!root.querySelector('.corp-panel'), oldTop: !!root.querySelector('.corp-top'),
      credits: !!root.querySelector('.corp-credits'),
      repLv: root.querySelector('.corp-branch .corp-rep .lv')?.textContent,
      panel: root.querySelector('.corp-tab.is-on .name')?.textContent,
      motto: !!root.querySelector('.corp-banner'), foot: !!root.querySelector('.hub-foot'),
      tabs, subs, rows: root.querySelectorAll('.corp-page .corp-row, .corp-page .cv-tile, .corp-page .corp-empty').length,
    };
  });
  // 2026-09-07: the screen is a tab of the Tab window, so the blocker + in-game cursor are the window's
  ok(dom && !dom.hidden && !dom.oldOverlay && !dom.corpBlocker && dom.blocker && dom.isOpen && dom.invOpen && dom.tab === 'corp' && dom.cursor,
    'openCorpMenu(ceres) → Tab 창의 기업 탭 (전용 오버레이 · corp 블로커 없음, inventory 블로커 + 인게임 커서)',
    JSON.stringify(dom && { oldOverlay: dom.oldOverlay, corpBlocker: dom.corpBlocker, blocker: dom.blocker, tab: dom.tab, cursor: dom.cursor }));
  // Phase 10: every credit readout is `formatCredits` → `1,200 C` (ko-KR grouping + the `C` unit, never `₩` / `cr`)
  // 2026-09-12: the credits bottom left were removed — the window's top-right CREDITS already prints them
  ok(dom && dom.railTabs === 4 && !dom.credits && !dom.foot,
    '기업 열에 기업 목록 4개, 크레딧 표시 없음, 푸터 없음', JSON.stringify(dom && { railTabs: dom.railTabs, credits: dom.credits, foot: dom.foot }));
  // 2026-09-17 (user's decision): 세레스 is still at reputation Lv.0 — it cannot be picked, so openCorpMenu(ceres)
  // opens on the first corp at Lv.1 (헬릭스) instead
  const helixAt = dom ? dom.tree.indexOf('helix') : -1;
  ok(dom && dom.railDetached && dom.railOrder.join(',') === 'corp-tabs' && dom.tree.filter((t) => t === 'branch').length === 1
    && dom.tree[helixAt + 1] === 'branch' && dom.branchParts.join(',') === 'corp-rep,corp-subtabs' && dom.expanded === 'helix' && !dom.oldPanel && !dom.oldTop,
    '기업 트리: 패널과 분리된 독립 열(라벨 없음), 선택한 헬릭스 바로 아래에 가지 하나(신뢰도 게이지 → 페이지 탭), aria-expanded',
    JSON.stringify(dom && { railDetached: dom.railDetached, railOrder: dom.railOrder, tree: dom.tree, branchParts: dom.branchParts, expanded: dom.expanded }));
  ok(dom && dom.tabs.length === 4 && dom.tabs.find((t) => t.corp === 'helix')?.on && dom.panel === '헬릭스 방산' && /^Lv\.\d+$/.test(dom.repLv ?? '') && !dom.motto,
    '4 corp tabs, Lv.0 ceres 대신 helix selected, 게이지가 그 기업의 Lv 를 읽는다 (no motto banner)', JSON.stringify(dom && { tabs: dom.tabs, panel: dom.panel, repLv: dom.repLv }));
  const corpLock0 = await P(() => {
    window.__ev['ui:notify'] = [];
    const b = document.querySelector('.corp-tab[data-corp="ceres"]');
    const before = { locked: b.classList.contains('is-locked'), disabled: b.disabled, why: b.title };
    b.click();
    return { ...before, notes: window.__ev['ui:notify'].map((n) => n.text), on: document.querySelector('.corp-tab.is-on')?.dataset.corp };
  });
  ok(corpLock0.locked && !corpLock0.disabled && /신뢰도 Lv\.1 필요/.test(corpLock0.why) && corpLock0.notes.some((t) => /신뢰도 Lv\.1 필요/.test(t)) && corpLock0.on === 'helix',
    'Lv.0 세레스 탭은 잠겨 있고(흐리게, 클릭은 받는다) 누르면 신뢰도 Lv.1 필요 토스트, 선택은 헬릭스에 머문다', JSON.stringify(corpLock0));
  // raising the reputation to Lv.1 unlocks 세레스 and it can be picked
  const unlocked = await P(() => {
    window.__game.ctx.meta.addRep('ceres', 100, 'smoke');
    const b = document.querySelector('.corp-tab[data-corp="ceres"]');
    const out = { locked: b.classList.contains('is-locked'), lv: window.__game.ctx.meta.getRep('ceres').level };
    b.click();
    return { ...out, on: document.querySelector('.corp-tab.is-on')?.dataset.corp };
  });
  ok(unlocked.lv === 1 && !unlocked.locked && unlocked.on === 'ceres', '신뢰도 Lv.1 이 되면 세레스 탭이 풀리고 선택된다', JSON.stringify(unlocked));
  const subsCeres = await P(() => [...document.querySelectorAll('.corp-subtabs .scr-tab:not([hidden])')].map((b) => ({ page: b.dataset.page, locked: b.classList.contains('is-locked') })));
  // 2026-09-14: the 퀘스트 tab deleted (corp quests dropped) — 거래 / 계약 / 임플란트
  ok(subsCeres.map((s) => s.page).join(',') === 'trade,contracts,implants' && subsCeres.every((s) => !s.locked),
    'sub-tabs 거래 / 계약 / 임플란트 at ceres, Lv.1 이면 잠긴 탭 없음 (계약도 Lv.1 부터)', JSON.stringify(subsCeres));
  await P(() => { document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]').click(); });
  await sleep(60);
  ok(await P(() => document.querySelector('.corp-subtabs .scr-tab.is-on')?.dataset.page === 'trade'), '풀린 거래 탭으로 전환된다');
  let tg = await lastEv('ui:corpToggled');
  // 2026-09-17: 세레스 was Lv.0 at opening time, so it opened on the first unlocked corp (헬릭스) — a tab click
  // does not emit this event again
  ok(tg && tg.open === true && tg.corp === 'helix', 'ui:corpToggled {open:true, helix}', JSON.stringify(tg));
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="contracts"]').click());
  const contractsDom = await P(() => ({
    rows: [...document.querySelectorAll('.ctr-list .corp-row.contract')].map((r) => ({ id: r.dataset.id, btn: r.querySelector('.ui-btn')?.textContent, disabled: r.querySelector('.ui-btn')?.disabled })),
    active: document.querySelectorAll('.ctr-active .corp-row.contract, .ctr-active .corp-empty').length,
    on: document.querySelector('.corp-subtabs .scr-tab.is-on')?.dataset.page,
  }));
  // 2026-09-12 (E2): ceres has 4 sample-collection + 2 specific-item recovery contracts (`ceres_samples` · `ceres_pure`) = 6 rows
  ok(contractsDom.on === 'contracts' && contractsDom.rows.length === 6 && contractsDom.rows[0].id === 'ceres_1' && contractsDom.rows[0].btn === '수락' && contractsDom.rows[0].disabled === false, '계약 tab: 6 ceres rows, ceres_1 수락 enabled', JSON.stringify(contractsDom));
  // 2026-09-12: the active contract panel carries the colour of the corp the contract was signed with (not the
  // selected corp tab's colour)
  const otherContract = await P(() => {
    const m = window.__game.ctx.meta;
    if (m.getContracts('helix').some((c) => c.active) || ['ceres', 'bastion', 'nomad'].some((k) => m.getContracts(k).some((c) => c.active))) return { skip: 'already active' };
    const pick = m.getContracts('helix').find((c) => c.blocked === null);
    if (!pick || !m.acceptContract(pick.def.id)) return { skip: 'no acceptable helix contract' };
    window.__game.getSystem('meta').views.values().next().value.refresh();
    const col = document.querySelector('.ctr-col.active');
    const row = document.querySelector('.ctr-active .corp-row.contract');
    const out = {
      id: pick.def.id,
      helix: document.querySelector('.corp-tab[data-corp="helix"]').style.getPropertyValue('--cc').trim(),
      ceres: document.querySelector('.corp-tab[data-corp="ceres"]').style.getPropertyValue('--cc').trim(),
      selected: document.querySelector('.corp-tab.is-on')?.dataset.corp,
      col: col?.style.getPropertyValue('--cc').trim(), row: row?.style.getPropertyValue('--cc').trim(),
      has: col?.classList.contains('has-contract'), rowCorp: row?.dataset.corp,
    };
    m.abandonContract();
    return out;
  });
  if (otherContract.skip) skipped('진행 중인 계약 패널 = 계약 기업 색', otherContract.skip);
  else ok(otherContract.selected === 'ceres' && otherContract.col === otherContract.helix && otherContract.row === otherContract.helix && otherContract.helix !== otherContract.ceres && otherContract.has && otherContract.rowCorp === 'helix',
    '세레스 탭에서 본 진행 중인 헬릭스 계약 — 패널과 행이 헬릭스 색', JSON.stringify(otherContract));
  await P(() => document.querySelector('.corp-tab[data-corp="helix"]').click());
  // the branch follows the selected corp — still exactly one, now under 헬릭스
  const treeHelix = await P(() => [...document.querySelectorAll('.corp-rail .corp-tabs > *')].map((e) => e.classList.contains('corp-branch') ? 'branch' : e.dataset.corp));
  ok(treeHelix[treeHelix.indexOf('helix') + 1] === 'branch' && treeHelix.filter((t) => t === 'branch').length === 1, '헬릭스를 누르면 가지가 헬릭스 아래로 옮겨 간다', JSON.stringify(treeHelix));
  ok(await P(() => !document.querySelector('.corp-subtabs .scr-tab[data-page="quests"]') && !document.querySelector('.cq, .cq-list')), '헬릭스에도 퀘스트 탭 · 퀘스트 페이지가 없다 (2026-09-14)');
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]').click());
  // helix is Lv.2 by now (310 rep): the shelf grew past the Lv.1 list, so compare with the live shop
  await sleep(80);   // the tile grids size themselves off the laid-out boxes (ResizeObserver)
  const shopDom = await P(() => {
    const tiles = [...document.querySelectorAll('.cv-shop .cv-tile.shop')];
    const cw = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : null; };
    const first = tiles[0];
    return {
      // 2026-09-12: the stock list is a grid of **inventory tiles** (`InventoryRef.buildItemTile`), not chips in cells
      rows: tiles.length,
      tips: tiles.filter((t) => t.matches('.inv-tile[data-item-tip][data-def-id]')).length,
      prices: tiles.map((t) => t.querySelector('.cv-price')?.textContent),
      live: window.__game.ctx.meta.getShop('helix').length,
      buyBtn: !!document.querySelector('.cv-shop .cv-tile .ui-btn'),   // the 즉시 구매 buttons are gone (the cart replaced them)
      grids: document.querySelectorAll('.cv-col.inv .trade-grids .tg-block').length,
      trays: document.querySelectorAll('.cv-trays .cv-tray').length,
      // 2026-09-15 2nd pass: the left-click hold keycap stands inside the button, so `.cv-confirm`'s `textContent`
      // is `LMB거래 성사` — the label span is what is read
      confirm: document.querySelector('.cv-confirm-label')?.textContent,
      confirmCap: !!document.querySelector('.cv-confirm .keycap.kc-btn'),
      confirmOff: document.querySelector('.cv-confirm')?.disabled,
      stage: !!document.querySelector('.cv-tray.sell .cv-stage'),
      // the buy / sell trays are a 5-cell grid with the same cell size as the bag / stash (the inventory's
      // `.inv-cells` used as is)
      trayCols: getComputedStyle(document.querySelector('.cv-tray.buy .inv-cells')).gridTemplateColumns.split(' ').length,
      // 2026-09-13: the cell size is fitted to the window width (40 px, down to 32 px when narrow — the host's
      // `data-cv-cell`), and the stock shelf · the trays · the stash · the bag all use that value
      fit: Number(document.querySelector('.inv-screen.corp-view')?.dataset.cvCell ?? 0),
      cellPx: cw('.cv-shop .inv-cell'), bagCell: getComputedStyle(document.querySelector('.cv-inv.bag .trade-grids')).getPropertyValue('--inv-cell').trim(),
      stashCell: getComputedStyle(document.querySelector('.cv-inv.stash .trade-grids')).getPropertyValue('--inv-cell').trim(),
      // the ship stash · the bag are separate cards with one grid each (left → right: 창고 · 가방)
      invCards: [...document.querySelectorAll('.cv > .cv-card.cv-inv')].map((c) => `${c.dataset.cvGrid}:${c.querySelectorAll('[data-tg-grid]').length}`).join(','),
      // a stock tile is the item's footprint size (w × (cell + 2) − 2)
      sizes: tiles.slice(0, 6).map((t) => { const d = window.__game.ctx.loot.getItemDef(t.dataset.defId); const c = Number(document.querySelector('.inv-screen.corp-view')?.dataset.cvCell ?? 0); return { w: Math.round(t.getBoundingClientRect().width), want: d.width * (c + 2) - 2 }; }),
      // not the culture tank tube shape (54×76 · rounded at the bottom) — the name no longer collides with housing.css's `.ct-cell`
      tube: !!document.querySelector('.corp-view .ct-cell'), radius: first ? getComputedStyle(first).borderBottomLeftRadius : null,
      // chevrons: the end of the buy tray head = three pointing right, the start of the sell tray head = three
      // pointing left. There is no credits-after-trade label
      buyChev: (() => { const h = document.querySelector('.cv-tray.buy .cv-tray-head'); const l = h?.lastElementChild; return l?.matches('.cv-chev.dir-right') ? l.querySelectorAll('polyline').length : 0; })(),
      sellChev: (() => { const h = document.querySelector('.cv-tray.sell .cv-tray-head'); const f = h?.firstElementChild; return f?.matches('.cv-chev.dir-left') ? f.querySelectorAll('polyline').length : 0; })(),
      totalLabel: document.querySelector('.cv-total')?.textContent ?? '', hints: document.body.innerText.includes('왼쪽 목록에서 담으세요') || document.body.innerText.includes('끌어 놓으세요'),
    };
  });
  ok(shopDom.rows === shopDom.live && shopDom.rows > shop1.length && !shopDom.buyBtn,
    `거래 tab: one stock tile per shop line (${shopDom.live}, more than the ${shop1.length} at Lv.1), no per-tile 구매 button`, JSON.stringify(shopDom));
  ok(shopDom.tips === shopDom.rows, `모든 재고 타일이 인벤토리 타일 + 호버 카드 갈고리 (${shopDom.tips}/${shopDom.rows})`);
  /* 2026-09-16: as the numbers grew (buy price ×3 · full ammo stacks) the badge shows `shared/numberFormat`'s
     abbreviated form (`10.0k` · `1.00m`) */
  ok(shopDom.prices.length === shopDom.rows && shopDom.prices.every((t) => /^[\d,]+(\.\d+)?[kmb]?$/.test(t ?? '')),
    `재고 타일 가격 배지 (${shopDom.prices[0]})`, JSON.stringify(shopDom.prices.slice(0, 3)));
  ok(shopDom.trayCols === 5 && shopDom.fit >= 32 && shopDom.fit <= 40 && shopDom.cellPx === shopDom.fit
    && shopDom.bagCell === `${shopDom.fit}px` && shopDom.stashCell === `${shopDom.fit}px` && shopDom.invCards === 'inv:2',
    `구매/판매 트레이가 5칸, 재고·창고·가방이 창 폭에 맞춘 같은 칸 크기, 창고 · 가방은 **한 카드 안의 두 격자** (${shopDom.trayCols}칸 / ${shopDom.fit} → ${shopDom.cellPx}px / ${shopDom.stashCell} / ${shopDom.bagCell} / ${shopDom.invCards})`);
  ok(shopDom.sizes.length > 0 && shopDom.sizes.every((s) => s.w === s.want) && !shopDom.tube && shopDom.radius === '3px',
    '재고 타일이 발자국 크기의 인벤토리 타일이다 (배양조 관 모양 아님)', JSON.stringify({ sizes: shopDom.sizes, tube: shopDom.tube, radius: shopDom.radius }));
  ok(shopDom.buyChev === 3 && shopDom.sellChev === 3 && !/거래 후 크레딧/.test(shopDom.totalLabel) && !shopDom.hints,
    '구매 트레이 우측 상단 › ×3 · 판매 트레이 좌측 상단 ‹ ×3 · 거래 후 크레딧 라벨 · 안내 문구 없음', JSON.stringify({ buyChev: shopDom.buyChev, sellChev: shopDom.sellChev, total: shopDom.totalLabel, hints: shopDom.hints }));
  ok(shopDom.trays === 2 && shopDom.grids >= 1 && shopDom.confirm === '거래 성사' && shopDom.confirmCap && shopDom.confirmOff,
    '거래 tab: 구매 / 판매 trays, 가방 + 함선 창고 grids, 좌클릭 홀드 키캡, 거래 성사 disabled on an empty basket', JSON.stringify(shopDom));
  // hovering a stock tile raises the shared item card (ui/hud/ItemTip)
  const tip = await P(() => {
    const t = document.querySelector('.cv-shop .cv-tile.shop');
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
    // ask the HUD which def its card is describing (a DOM query could land on another folder's `.item-tip`)
    const out = { def: t.dataset.defId, shown: window.__game.getSystem('hud').itemTipDefId };
    t.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    return out;
  });
  ok(!!tip.def && tip.shown === tip.def, `재고 타일 호버 → 아이템 카드 (${tip.shown})`, JSON.stringify(tip));
  // stage one purchase from the stock list, then settle the basket with the 1-second hold
  const staged = await P(() => {
    document.querySelector('.cv-shop .cv-tile.shop.is-draggable')?.click();
    const view = window.__game.getSystem('meta');
    const total = document.querySelector('.cv-total');
    return {
      buy: document.querySelectorAll('.cv-tray.buy .cv-tile.buy').length, hasView: !!view,
      net: total?.querySelector('.v')?.textContent, minus: total?.classList.contains('minus'),
      /* 2026-09-16 (user's decision): no chevrons are drawn on the total credit change — only the sign and the colour
         (`.plus`/`.minus`) are left. Anything but 0 means they came back (the tray head's `.cv-chev.flow` is a
         different thing and is not counted). */
      chevs: total?.querySelectorAll('.cv-chev').length ?? -1,
    };
  });
  ok(staged.buy === 1, `clicking a stock tile stages it in the 구매 tray (${staged.buy})`);
  ok(staged.minus && /^−[\d,]+ C$/.test(staged.net ?? '') && staged.chevs === 0,
    `거래 후 크레딧 −: 부호와 색만, 셰브런 없음 (${staged.net})`, JSON.stringify(staged));
  const clickOnly = await P(() => {
    const before = window.__game.ctx.meta.credits;
    document.querySelector('.cv-confirm').click();
    document.querySelector('.cv-confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { before, after: window.__game.ctx.meta.credits, buy: document.querySelectorAll('.cv-tray.buy .cv-tile.buy').length };
  });
  ok(clickOnly.after === clickOnly.before && clickOnly.buy === 1, '거래 성사는 클릭 · Enter 로 확정되지 않는다', JSON.stringify(clickOnly));
  const holdStart = await P(() => {
    const b = document.querySelector('.cv-confirm');
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r.left + 5, clientY: r.top + 5 };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    return { before: window.__game.ctx.meta.credits };
  });
  await sleep(450);
  const midHold = await P(() => ({ credits: window.__game.ctx.meta.credits, holding: document.querySelector('.cv-confirm').classList.contains('is-holding'), fill: document.querySelector('.cv-confirm-fill').style.transform }));
  // (the gauge rides rAF, which a hidden headless tab may not tick — so only the state is asserted, the fill is reported)
  ok(midHold.credits === holdStart.before && midHold.holding, `홀드 중간(0.45 s): 아직 거래 안 됨, 홀드 중 (게이지 ${midHold.fill})`, JSON.stringify(midHold));
  await sleep(900);
  const settled = await P(() => ({ after: window.__game.ctx.meta.credits, buy: document.querySelectorAll('.cv-tray.buy .cv-tile.buy').length, holding: document.querySelector('.cv-confirm').classList.contains('is-holding') }));
  await P(() => document.querySelector('.cv-confirm').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })));
  ok(settled.after < holdStart.before && settled.buy === 0 && !settled.holding, `거래 성사 1초 홀드가 바구니를 정산하고 트레이를 비운다 (${holdStart.before} → ${settled.after})`, JSON.stringify(settled));
  ok(shopDom.stage, '귀중품 전부 담기 button sits under the 판매 tray');
  // E-9 (2026-09-11, user's decision): a 0 C line stages in the sell tray too and prints its price as `0` — it is not blocked
  const zeroBag = await P(() => {
    const c = window.__game.ctx;
    const it = c.loot.createItem('ammo_light', 1);
    return c.inventory.tryAddItem(it) ? { uid: it.uid, price: c.meta.sellPriceOf(it.uid) } : null;
  });
  if (!zeroBag) skipped('0 C 줄이 판매칸에 담긴다', '(가방에 자리가 없다)');
  else {
    await sleep(120);
    const zeroStage = await P((uid) => {
      const tile = document.querySelector(`.cv-col.inv .inv-tile[data-uid="${uid}"]`);
      if (!tile) return { noTile: true };
      tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const chips = [...document.querySelectorAll('.cv-tray.sell .cv-tile.sell')];
      const total = document.querySelector('.cv-total');
      return {
        chips: chips.length, prices: chips.map((e) => e.querySelector('.cv-price')?.textContent ?? ''), msg: document.querySelector('.corp-view .form-msg')?.textContent ?? '',
        net: total?.querySelector('.v')?.textContent, plus: total?.classList.contains('plus'), minus: total?.classList.contains('minus'),
        arrows: [...total.querySelectorAll('.cv-chev')].filter((c) => getComputedStyle(c).display !== 'none').length,
      };
    }, zeroBag.uid);
    if (zeroStage.noTile) skipped('0 C 줄이 판매칸에 담긴다', '(거래 격자에 타일이 없다)');
    else {
      ok(zeroBag.price === 0 && zeroStage.chips === 1 && zeroStage.prices.includes('0') && !/팔 수 없습니다/.test(zeroStage.msg),
        '0 C 아이템이 판매칸에 담기고 가격 배지가 0 이다 (거절 메시지 없음)', JSON.stringify({ zeroBag, zeroStage }));
      ok(zeroStage.net === '0 C' && !zeroStage.plus && !zeroStage.minus && zeroStage.arrows === 0, '거래 후 크레딧 0 — 화살표 없음', JSON.stringify(zeroStage));
    }
    // the trays and the bag are emptied so nothing is left for the steps below
    await P((uid) => {
      document.querySelector('.cv-tray.sell .cv-tile.sell')?.click();
      window.__game.ctx.inventory.takeItem(uid);
    }, zeroBag.uid);
  }
  await tap('Tab');
  await sleep(60);
  const closed = await P(() => ({
    view: !!document.querySelector('.inv-screen.corp-view'),
    blocker: window.__game.ctx.uiBlockers.has('inventory'),
    isOpen: window.__game.ctx.meta.isMenuOpen, cursor: window.__game.ctx.input.isCursorMode,
  }));
  ok(!closed.view && !closed.blocker && !closed.isOpen && !closed.cursor, 'Esc closes the window: view gone, blocker + in-game cursor removed', JSON.stringify(closed));
  tg = await lastEv('ui:corpToggled');
  ok(tg && tg.open === false, 'ui:corpToggled {open:false}', JSON.stringify(tg));

  console.log('implants (Phase 12): 세레스 shop');
  const implantDefs = await P(() => window.__game.ctx.loot.getAllItemDefs().filter((d) => d.category === 'implant').map((d) => ({ id: d.id, rarity: d.rarity, broken: !!d.implant?.broken, value: d.value, to: d.implant?.repairsTo ?? null, cost: d.implant?.repairCost ?? [] })));
  ok(implantDefs.some((d) => d.id === 'imp_strength_1' && !d.broken) && implantDefs.some((d) => d.id === 'imp_broken_strength_1' && d.broken && d.to === 'imp_strength_1'),
    `items/ knows imp_strength_1 + its broken twin (${implantDefs.length} implant defs)`, JSON.stringify(implantDefs.slice(0, 2)));
  await P(() => { const m = window.__game.ctx.meta; for (const c of ['ceres', 'bastion', 'nomad']) if (m.getRep(c).level < 1) m.addRep(c, 100, 'smoke:implants'); });
  const shops = await P(() => {
    const m = window.__game.ctx.meta;
    const pick = (c) => m.getShop(c).map((s) => ({ id: s.def.id, cat: s.def.category, rarity: s.def.rarity, broken: !!s.def.implant?.broken, price: s.price }));
    return { ceres: pick('ceres'), helix: pick('helix'), bastion: pick('bastion'), nomad: pick('nomad'), lv: { ceres: m.getRep('ceres').level, helix: m.getRep('helix').level } };
  });
  const ceresImp = shops.ceres.filter((s) => s.cat === 'implant');
  ok(ceresImp.some((s) => s.id === 'imp_strength_1') && ceresImp.some((s) => s.id === 'imp_strength_2'), `ceres Lv.${shops.lv.ceres} shelf lists imp_strength_1 + imp_strength_2`, ceresImp.map((s) => s.id).join(','));
  ok(ceresImp.length > 0 && ceresImp.every((s) => (s.rarity === 'common' || s.rarity === 'uncommon') && !s.broken), 'only common / uncommon working implants on the shelf (no broken ones)', JSON.stringify(ceresImp.filter((s) => s.broken || (s.rarity !== 'common' && s.rarity !== 'uncommon'))));
  ok(['helix', 'bastion', 'nomad'].every((c) => shops[c].length > 0 && shops[c].every((s) => s.cat !== 'implant')), `no other corp sells implants (helix Lv.${shops.lv.helix} / bastion / nomad Lv.1)`, JSON.stringify({ helix: shops.helix.filter((s) => s.cat === 'implant').length, bastion: shops.bastion.length, nomad: shops.nomad.length }));
  const repairMats = [...new Set(implantDefs.flatMap((d) => d.cost.map((c) => c.defId)))];
  const ceresMats = shops.ceres.filter((s) => s.cat === 'material').map((s) => s.id);
  ok(repairMats.length > 0 && ceresMats.length > 0 && ceresMats.every((id) => repairMats.includes(id)) && ceresMats.includes('mat_cable'),
    `ceres sells repair materials only (${ceresMats.join(',')} ⊆ ${repairMats.join(',')})`);
  ok(!ceresMats.includes('mat_circuit') && !ceresMats.includes('mat_scrap'), 'rep rarity cap still applies to the materials (rare 회로 기판 hidden at Lv.1, 폐금속 never)', ceresMats.join(','));
  await P(() => window.__game.ctx.meta.addRep('ceres', 200, 'smoke:implants'));   // → 300 = Lv.2
  const ceresLv2 = await P(() => window.__game.ctx.meta.getShop('ceres').map((s) => s.def.id));
  ok(ceresLv2.includes('mat_circuit') && !ceresLv2.some((id) => /^imp_.*_3$/.test(id)) && !ceresLv2.some((id) => /^imp_broken_/.test(id)), 'ceres Lv.2: 회로 기판 appears, rare implants still never (maxRarity uncommon)', ceresLv2.filter((id) => /^imp_|^mat_/.test(id)).join(','));
  const impLine = ceresImp.find((s) => s.id === 'imp_strength_1');
  const impPrice = await P(() => window.__game.ctx.meta.priceOf('ceres', 'imp_strength_1'));
  ok(impPrice !== null && impPrice > 0, `priceOf(ceres, imp_strength_1) = ${impPrice} (Lv.1 price was ${impLine?.price})`);
  // the basket settled above may have left less than the implant costs — top the balance up first
  await P((price) => { const m = window.__game.ctx.meta; if (m.credits < price) m.addCredits(price - m.credits, 'smoke:topup'); }, impPrice);
  const bought0 = await P(() => ({ n: window.__game.ctx.inventory.countDefAll('imp_strength_1'), credits: window.__game.ctx.meta.credits }));
  ok(await P(() => window.__game.ctx.meta.buy('ceres', 'imp_strength_1')) === true, 'buy(ceres, imp_strength_1) → true');
  const bought1 = await P(() => ({ n: window.__game.ctx.inventory.countDefAll('imp_strength_1'), credits: window.__game.ctx.meta.credits, pu: window.__ev['meta:purchase'][window.__ev['meta:purchase'].length - 1] }));
  ok(bought1.n === bought0.n + 1 && bought1.credits === bought0.credits - impPrice && bought1.pu?.defId === 'imp_strength_1' && (bought1.pu.placed === 'bag' || bought1.pu.placed === 'stash'),
    `bought implant landed in the ${bought1.pu?.placed} (bag first, else stash) and cost ${impPrice}`, JSON.stringify(bought1));
  const sellCmp = await P(() => {
    const c = window.__game.ctx;
    const w = c.loot.createItem('imp_strength_1', 1), b = c.loot.createItem('imp_broken_strength_1', 1);
    if (!c.inventory.tryAddToStash(w) || !c.inventory.tryAddToStash(b)) return null;
    const out = { working: c.meta.sellPriceOf(w.uid), broken: c.meta.sellPriceOf(b.uid), sellable: c.meta.getSellable().some((i) => i.uid === b.uid) };
    c.inventory.takeItem(w.uid); c.inventory.takeItem(b.uid);
    return out;
  });
  ok(sellCmp && sellCmp.working > 0 && sellCmp.broken > 0 && sellCmp.broken * 3 < sellCmp.working && sellCmp.sellable,
    `implants sell at the usual rule, a broken one for little (${sellCmp?.broken} vs ${sellCmp?.working})`, JSON.stringify(sellCmp));

  console.log('implants (Phase 12): 수리 desk');
  await P(() => window.__game.ctx.meta.openCorpMenu('ceres'));
  await sleep(50);
  const tabsCeres = await P(() => [...document.querySelectorAll('.corp-subtabs .scr-tab')].map((b) => ({ page: b.dataset.page, hidden: b.hidden })));
  // 2026-09-14: the 퀘스트 tab deleted → the three 거래 / 계약 / 임플란트
  ok(tabsCeres.length === 3 && tabsCeres.find((t) => t.page === 'implants')?.hidden === false, '임플란트 tab visible at ceres', JSON.stringify(tabsCeres));
  await P(() => document.querySelector('.corp-tab[data-corp="helix"]').click());
  const tabsHelix = await P(() => ({ hidden: document.querySelector('.corp-subtabs .scr-tab[data-page="implants"]')?.hidden, page: document.querySelector('.corp-page')?.dataset.page }));
  ok(tabsHelix.hidden === true && tabsHelix.page === 'trade', '임플란트 tab hidden at helix (page stays 거래)', JSON.stringify(tabsHelix));
  await P(() => { document.querySelector('.corp-tab[data-corp="ceres"]').click(); document.querySelector('.corp-subtabs .scr-tab[data-page="implants"]').click(); });
  const deskEmpty = await P(() => ({
    page: document.querySelector('.corp-page')?.dataset.page, root: !!document.querySelector('.corp-page .ci'),
    cells: document.querySelectorAll('.ci-list .cv-tile.broken').length, empty: document.querySelector('.ci-list .corp-empty:not([hidden])')?.textContent ?? null,
    grid: document.querySelector('.ci-list .inv-cells') ? getComputedStyle(document.querySelector('.ci-list .inv-cells')).display : null,
    list: window.__game.getSystem('meta').getRepairableImplants().length,
  }));
  ok(deskEmpty.page === 'implants' && deskEmpty.root && deskEmpty.cells === 0 && deskEmpty.list === 0 && /망가진 임플란트가 없습니다/.test(deskEmpty.empty ?? '') && deskEmpty.grid === 'grid',
    '임플란트 desk: empty grid with the 없습니다 notice (no broken implants yet)', JSON.stringify(deskEmpty));
  // seed: one broken implant + exactly its materials + enough credits, all in the 함선 창고
  const seeded = await P(() => {
    const c = window.__game.ctx;
    const b = c.loot.createItem('imp_broken_strength_1', 1);
    if (!c.inventory.tryAddToStash(b)) return null;
    const cost = c.loot.getItemDef('imp_broken_strength_1').implant.repairCost;
    for (const line of cost) if (!c.inventory.tryAddToStash(c.loot.createItem(line.defId, line.qty))) return null;
    if (c.meta.credits < 150) c.meta.addCredits(150 - c.meta.credits, 'smoke:fee');
    return { uid: b.uid, cost, credits: c.meta.credits };
  });
  ok(!!seeded, 'imp_broken_strength_1 + repair materials seeded into the stash', JSON.stringify(seeded));
  const info0 = await P((uid) => { const r = window.__game.getSystem('meta').getImplantRepair(uid); return r && { target: r.target?.id, fee: r.fee, blocked: r.blocked, cost: r.cost }; }, seeded.uid);
  ok(info0 && info0.target === 'imp_strength_1' && info0.fee === 150 && info0.blocked === null && info0.cost.every((c) => c.have >= c.qty),
    'getImplantRepair → imp_strength_1, fee 150 (150 × grade 1), ready', JSON.stringify(info0));
  await P(() => window.__game.getSystem('meta').views.values().next().value.refresh());
  const desk = await P((uid) => {
    const cell = document.querySelector(`.ci-list .cv-tile.broken[data-uid="${uid}"]`);
    const btn = document.querySelector('.ci-repair-btn');
    return {
      cell: !!cell, sel: cell?.classList.contains('is-sel'), chip: cell?.matches('.inv-tile[data-item-tip][data-def-id="imp_broken_strength_1"]') ?? false, badge: cell?.querySelector('.cv-price')?.textContent,
      to: !!document.querySelector('.ci-head .to .item-chip[data-def-id="imp_strength_1"]'),
      costChips: document.querySelectorAll('.ci-cost .item-chip[data-def-id]').length, short: document.querySelectorAll('.ci-cost .item-chip.is-short').length,
      fee: document.querySelector('.ci-fee .v')?.textContent, feeShort: document.querySelector('.ci-fee .v')?.classList.contains('short'),
      btn: btn?.textContent, disabled: btn?.disabled, block: document.querySelector('.ci-block')?.textContent ?? null,
    };
  }, seeded.uid);
  ok(desk.cell && desk.sel && desk.chip && desk.badge === '150', 'desk lists the broken implant as a selected footprint cell with a 150 fee badge', JSON.stringify(desk));
  ok(desk.to && desk.costChips === seeded.cost.length && desk.short === 0 && desk.fee === '150 C' && !desk.feeShort, `detail: result chip imp_strength_1, ${seeded.cost.length} material chips none short, 수리비 150 C`, JSON.stringify(desk));
  ok(desk.btn === '수리' && desk.disabled === false && desk.block === null, '수리 button enabled, no reason line', JSON.stringify({ btn: desk.btn, disabled: desk.disabled, block: desk.block }));
  const beforeRepair = await P((cost) => { const c = window.__game.ctx; return { credits: c.meta.credits, working: c.inventory.countDefAll('imp_strength_1'), mats: cost.map((l) => c.inventory.countDefAll(l.defId)), notifies: window.__ev['ui:notify'].length }; }, seeded.cost);
  await P(() => document.querySelector('.ci-repair-btn').click());
  await sleep(30);
  const afterRepair = await P(({ uid, cost }) => {
    const c = window.__game.ctx;
    const stashHas = c.inventory.getStashItems().some((i) => i.defId === 'imp_strength_1');
    return {
      credits: c.meta.credits, working: c.inventory.countDefAll('imp_strength_1'), mats: cost.map((l) => c.inventory.countDefAll(l.defId)),
      broken: !!c.inventory.findItemAnywhere(uid), brokenCount: c.inventory.countDefAll('imp_broken_strength_1'), stashHas,
      list: window.__game.getSystem('meta').getRepairableImplants().length, notify: window.__ev['ui:notify'].slice(-1)[0] ?? null,
      cells: document.querySelectorAll('.ci-list .cv-tile.broken').length, msg: document.querySelector('.corp-msg-slot .form-msg')?.textContent ?? '',
    };
  }, seeded);
  ok(!afterRepair.broken && afterRepair.brokenCount === 0 && afterRepair.working === beforeRepair.working + 1 && afterRepair.stashHas, '수리: broken implant gone, imp_strength_1 in the 함선 창고', JSON.stringify({ broken: afterRepair.broken, working: [beforeRepair.working, afterRepair.working], stash: afterRepair.stashHas }));
  ok(afterRepair.mats.every((n, i) => n === beforeRepair.mats[i] - seeded.cost[i].qty), 'materials consumed exactly', JSON.stringify({ before: beforeRepair.mats, after: afterRepair.mats, cost: seeded.cost }));
  ok(afterRepair.credits === beforeRepair.credits - 150, 'credits −150', `${beforeRepair.credits} → ${afterRepair.credits}`);
  ok(afterRepair.notify && afterRepair.notify.kind === 'success' && afterRepair.notify.text === '임플란트 수리 완료 — 근력 임플란트 I', 'ui:notify 임플란트 수리 완료 — 근력 임플란트 I', JSON.stringify(afterRepair.notify));
  ok(afterRepair.list === 0 && afterRepair.cells === 0 && /수리 완료/.test(afterRepair.msg), 'desk refreshed: no rows left, success message line', JSON.stringify({ list: afterRepair.list, cells: afterRepair.cells, msg: afterRepair.msg }));
  // insufficient materials → disabled with the reason; credits are checked before materials
  // (fee 300 for the uncommon twin — top the balance up so 재료 부족 is the *only* reason left)
  const seeded2 = await P(() => { const c = window.__game.ctx; if (c.meta.credits < 300) c.meta.addCredits(300 - c.meta.credits, 'smoke:fee'); const b = c.loot.createItem('imp_broken_strength_2', 1); return c.inventory.tryAddToStash(b) ? { uid: b.uid, credits: c.meta.credits } : null; });
  ok(!!seeded2, 'imp_broken_strength_2 seeded without its materials');
  await P(() => window.__game.getSystem('meta').views.values().next().value.refresh());
  const desk2 = await P((uid) => {
    const r = window.__game.getSystem('meta').getImplantRepair(uid);
    const cell = document.querySelector(`.ci-list .cv-tile.broken[data-uid="${uid}"]`);
    return { fee: r?.fee, blocked: r?.blocked, sel: cell?.classList.contains('is-sel'), cellBlocked: cell?.classList.contains('blocked'), disabled: document.querySelector('.ci-repair-btn')?.disabled, block: document.querySelector('.ci-block')?.textContent ?? null, short: document.querySelectorAll('.ci-cost .item-chip.is-short').length, ret: window.__game.getSystem('meta').repairImplant(uid) };
  }, seeded2.uid);
  ok(desk2.fee === 300 && desk2.blocked === '재료 부족' && desk2.sel && desk2.cellBlocked && desk2.disabled === true && desk2.block === '재료 부족' && desk2.short > 0 && desk2.ret === false,
    'uncommon twin: fee 300 (× grade 2), 재료 부족 → cell blocked, short chips dimmed red, 수리 disabled, repairImplant → false', JSON.stringify(desk2));
  ok(await P((uid) => !!window.__game.ctx.inventory.findItemAnywhere(uid) && window.__game.ctx.meta.credits, seeded2.uid) === seeded2.credits, 'refused repair moved nothing (implant kept, credits unchanged)');
  await P(() => { const m = window.__game.ctx.meta; m.addCredits(-m.credits, 'smoke:drain'); });
  ok(await P((uid) => window.__game.getSystem('meta').getImplantRepair(uid)?.blocked, seeded2.uid) === '크레딧 부족', 'no credits → 크레딧 부족 wins over 재료 부족');
  await P((credits) => { const c = window.__game.ctx; c.meta.addCredits(credits, 'smoke:restore'); for (const l of c.loot.getItemDef('imp_broken_strength_2').implant.repairCost) c.inventory.tryAddToStash(c.loot.createItem(l.defId, l.qty)); }, seeded2.credits);
  ok(await P((uid) => window.__game.getSystem('meta').getImplantRepair(uid)?.blocked, seeded2.uid) === null, 'materials + credits back → ready again');
  ok(await P(() => { const c = window.__game.ctx; const w = c.inventory.getStashItems().find((i) => i.defId === 'imp_strength_1'); return w ? window.__game.getSystem('meta').getImplantRepair(w.uid) : 'none'; }) === null, 'a working implant is not a repair candidate (getImplantRepair → null)');
  await P((uid) => window.__game.ctx.inventory.takeItem(uid), seeded2.uid);   // leave the stash tidy for the quest checks

  /* 2026-09-14: the old ci1 → ci3 implant quest chain went with the corp quests. The currency-chip clipping check
     moved to the contracts tab's reward chip. */
  console.log('currency reward chip (contracts tab)');
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="contracts"]').click());
  await sleep(60);
  const chipClip = await P(() => {
    // 2026-09-12: the number bottom right of a currency chip is not clipped by the shape — the cut corner is on
    // the backdrop (::before), not on the thumbnail
    const th = document.querySelector('.ctr-list .reward .currency-chip .currency-thumb');
    const cnt = th?.querySelector('.item-chip-count');
    if (!th || !cnt) return null;
    const a = th.getBoundingClientRect(), b = cnt.getBoundingClientRect();
    return { thumb: getComputedStyle(th).clipPath, plate: getComputedStyle(th, '::before').clipPath !== 'none', overhang: b.right > a.right || b.bottom > a.bottom };
  });
  ok(chipClip && chipClip.thumb === 'none' && chipClip.plate && chipClip.overhang,
    '계약 보상 재화 칩: 썸네일에 clip-path 없음(뒤판에만) → 모서리 밖 수치 배지가 잘리지 않는다', JSON.stringify(chipClip));
  // The 기업 desk is a tab of the inventory window, so **Tab** closes it (2026-09-09: Esc closes it as well —
  // the top open screen — and the 일시정지 메뉴 is what an Esc with nothing open opens).
  await tap('Tab');
  await sleep(60);
  ok(await P(() => !document.querySelector('.inv-screen.corp-view') && !window.__game.ctx.meta.isMenuOpen), 'Tab closes the desk window');

  console.log('persistence: corrupt save is sanitised');
  // the 거래 성사 above left a debounced save pending — let it land first, or the pagehide flush would
  // overwrite the corrupt payload we are about to plant (SAVE_DELAY_MS = 350 ms)
  await sleep(600);
  await P(() => localStorage.setItem('scav.s1.meta', JSON.stringify({
    v: 1, credits: -50, corps: { helix: { rep: 'x', quests: { h1: 'locked', zzz: 'complete', b1: 'complete' } }, ceres: { rep: 250.7, quests: { c1: 'accepted' } } },
    activeContract: { id: 'nope', progress: 3 }, stats: null,
  })));
  await page.reload({ waitUntil: 'load' });
  await boot();
  const san = await P(() => {
    const m = window.__game.ctx.meta;
    const d = window.__game.getSystem('meta').store.data;
    return { credits: m.credits, helix: m.getRep('helix').rep, ceres: m.getRep('ceres').rep, h1: m.getQuestState('h1'), c1: m.getQuestState('c1'), ac: m.activeContract,
      oldQuests: Object.keys(d.corps.helix.quests).length + Object.keys(d.corps.ceres.quests).length, v: d.v, npc: !!d.npc };
  });
  // 2026-09-14: every old corp quest state is thrown away (the NPC quests' `npc` is filled in empty)
  ok(san.credits === 0 && san.helix === 0 && san.ceres === 250 && san.h1 === 'locked' && san.c1 === 'locked' && san.oldQuests === 0 && san.npc && san.ac === null,
    'corrupt fields clamped / dropped (credits 0, rep 0 / 250, old corp quest states dropped, npc save present, unknown contract cleared)', JSON.stringify(san));

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
