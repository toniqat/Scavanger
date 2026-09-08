// Single-player smoke test for the meta folder (Phase 5-c, 2026-09-06): credits / reputation / corp shop (filter, prices,
// buy, refuse) / sale / contracts (accept gating, kill progress from a real enemy, squad share, death + success settlement)
// / quests (deliver, rewards, chain unlock) / reload persistence / the 기업 네트워크 screen (DOM, blocker, tabs, Esc).
// Phase 7 (2026-09-06): `canFit` pre-check (공간 없음 before the click), server credits through a fake `ctx.net.profile`
// (optimistic debit → `credits:tx` → `meta:purchase` on the answer, refusal reverts, sell / addCredits go through the
// transaction, `profile.set('meta')` on save, `net:profileLoaded` replace + migrate), settlement `outcome`, training.
// Phase 12 (2026-09-08): 세레스 바이오 임플란트 — common / uncommon stat implants + repair materials on the shelf (no other corp,
// no rare+, no broken ones), a broken implant sells for a quarter, the 임플란트 desk tab (ceres only): grid of broken implants,
// result + material chips + fee, 수리 swaps broken → working (materials + credits consumed, stash first), reasons 재료 부족 /
// 크레딧 부족 gate the button, the ci1 → ci3 implant quest chain with its reward chip.
// Usage: node scripts/smoke-meta.mjs [http://localhost:5273/]   (needs a vite dev server; no relay required)
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); scripts fake `pointerLockElement`.
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket (another agent's save would otherwise full-reload the page mid-run, same trick as smoke-console)
    // AND the relay socket (`/ws?t=`): a relay that happens to run on 8787 would hand the page a real server profile and make
    // credits server-owned mid-run — this script drives that path itself with a fake `ctx.net.profile`.
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr') || /\/ws(\?|$)/.test(String(args[0]))) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
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

  console.log('reputation → shop');
  await P(() => window.__game.ctx.meta.addRep('helix', 100, 'smoke'));
  let rc = await lastEv('meta:repChanged');
  ok(rc && rc.corp === 'helix' && rc.rep === 100 && rc.level === 1 && rc.levelUp === true && rc.delta === 100, 'meta:repChanged {helix, 100, Lv.1, levelUp}', JSON.stringify(rc));
  r = await rep('helix');
  ok(r.level === 1 && r.next === 300, 'getRep → Lv.1, next 300', JSON.stringify(r));
  const shop1 = await P(() => {
    const m = window.__game.ctx.meta, loot = window.__game.ctx.loot;
    return m.getShop('helix').map((s) => {
      const w = s.def.weaponId ? loot.getWeaponDef(s.def.weaponId) : null;
      return { id: s.def.id, cat: s.def.category, rarity: s.def.rarity, value: s.def.value, price: s.price, blocked: s.blocked, cls: w ? w.weaponClass : null, unique: w ? !!w.unique : false, ammo: s.def.ammoType ?? null };
    });
  });
  const ids1 = shop1.map((s) => s.id);
  ok(shop1.length > 0 && ['wpn_ar', 'wpn_smg', 'wpn_hg', 'ammo_light', 'ammo_medium'].every((id) => ids1.includes(id)), 'Lv.1 shop lists AR I / SMG I / P-2 / 경량탄 / 준중량탄', ids1.join(','));
  ok(shop1.every((s) => s.rarity === 'common' || s.rarity === 'uncommon'), 'no rarity above the Lv.1 cap (uncommon)', shop1.filter((s) => s.rarity !== 'common' && s.rarity !== 'uncommon').map((s) => s.id).join(','));
  ok(shop1.every((s) => !s.unique), 'no unique weapons on the shelf');
  ok(shop1.every((s) => (s.cat === 'primary' && (s.cls === 'AR' || s.cls === 'SMG')) || (s.cat === 'secondary' && s.cls === 'PISTOL') || (s.cat === 'ammo' && (s.ammo === 'light' || s.ammo === 'medium'))), 'only helix stock rules match (AR/SMG, PISTOL, light/medium ammo)', JSON.stringify(shop1.filter((s) => !((s.cat === 'primary' && (s.cls === 'AR' || s.cls === 'SMG')) || (s.cat === 'secondary' && s.cls === 'PISTOL') || (s.cat === 'ammo' && (s.ammo === 'light' || s.ammo === 'medium')))).map((s) => s.id)));
  ok(shop1.every((s) => s.price === Math.max(1, Math.round(s.value * 1.45))), 'price = round(value × (1.6 − 0.15)) at Lv.1', JSON.stringify(shop1.slice(0, 3)));
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
  ok(setsS.sets.includes('meta') && setsS.doc && setsS.doc.v === 1 && setsS.doc.credits === tx.credits, "save → profile.set('meta', save)", JSON.stringify({ sets: setsS.sets, credits: setsS.doc?.credits }));
  // net:profileLoaded: the server document replaces the save, the balance is the server's
  const snapS = await P(() => JSON.parse(localStorage.getItem('scav.meta')));
  const loadedBefore = (await ev('meta:loaded')).length;
  await P((snap) => {
    const fake = window.__fakeProfile;
    fake.docs.meta = { ...snap, credits: 5, corps: { ...snap.corps, helix: { rep: 1000, quests: {} } } };
    fake.credits = 4321;
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 4321, docs: fake.docs, updatedAt: 0 }, migrated: false });
  }, snapS);
  const pl = await P(() => ({ credits: window.__game.ctx.meta.credits, helix: window.__game.ctx.meta.getRep('helix'), loaded: window.__ev['meta:loaded'].length, rc: window.__ev['meta:repChanged'][window.__ev['meta:repChanged'].length - 1], local: JSON.parse(localStorage.getItem('scav.meta')).credits }));
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
  const sp = await P((uid) => window.__game.ctx.meta.sellPriceOf(uid), gem);
  ok(sp === 130, 'sellPriceOf(gem_amber) = 260 × 0.5 = 130', `${sp}`);
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
      skipped('sell(gem_amber) → +130 credits', '(inventory.takeItem is still the stub returning 0)');
      skipped('meta:sale {gem_amber, 1, 130}');
      skipped('sold item removed from the bag');
    } else {
      ok(false, 'sell(gem_amber) → true', 'takeItem works but sell returned false');
    }
  } else {
    ok(await credits() === creditsBeforeSell + 130, 'sell(gem_amber) → +130 credits', `${creditsBeforeSell} → ${await credits()}`);
    const sale = await lastEv('meta:sale');
    ok(sale && sale.defId === 'gem_amber' && sale.qty === 1 && sale.credits === 130, 'meta:sale {gem_amber, 1, 130}', JSON.stringify(sale));
    ok(await P((uid) => !window.__game.ctx.inventory.findItem(uid), gem) === true, 'sold item removed from the bag');
  }

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

  console.log('squad share');
  await enterHub();
  ok(await P(() => window.__game.ctx.meta.acceptContract('helix_1')) === true, 're-accept helix_1 in the ship');
  await P(() => window.__game.ctx.meta.reportContractHit('kill_bugs', 4, false));
  cp = await lastEv('meta:contractProgress');
  ok(cp && cp.progress === 1 && cp.delta === 1, 'reportContractHit(kill_bugs, 4, remote) → +1 (× CONTRACT_SQUAD_SHARE 0.25)', JSON.stringify(cp));
  ok(await P(() => window.__game.ctx.meta.abandonContract()) === true, 'abandonContract → true');
  const cab = await lastEv('meta:contractAbandoned');
  ok(cab && cab.id === 'helix_1' && (await P(() => window.__game.ctx.meta.activeContract)) === null, 'meta:contractAbandoned + no active contract', JSON.stringify(cab));

  console.log('quests: h1 → h2');
  const q0 = await P(() => window.__game.ctx.meta.getQuests('helix').map((q) => ({ id: q.def.id, state: q.state, blocked: q.blocked, have: q.deliver.map((d) => d.have) })));
  ok(q0.find((q) => q.id === 'h1')?.state === 'available' && q0.find((q) => q.id === 'h2')?.state === 'locked', 'h1 available, h2 locked (requires h1)', JSON.stringify(q0));
  ok(await P(() => window.__game.ctx.meta.completeQuest('h1')) === false, 'completeQuest before accepting → false');
  ok(await P(() => window.__game.ctx.meta.acceptQuest('h2')) === false, 'acceptQuest(h2) locked → false');
  const scrapAdded = await P(() => { const c = window.__game.ctx; return c.inventory.tryAddItem(c.loot.createItem('mat_scrap', 10)); });
  ok(scrapAdded, 'mat_scrap ×10 added to the bag');
  ok(await P(() => window.__game.ctx.meta.acceptQuest('h1')) === true, 'acceptQuest(h1) → true');
  let qc = await lastEv('meta:questChanged');
  ok(qc && qc.id === 'h1' && qc.state === 'accepted', 'meta:questChanged {h1, accepted}', JSON.stringify(qc));
  const q1 = await P(() => window.__game.ctx.meta.getQuests('helix').find((q) => q.def.id === 'h1'));
  ok(q1.state === 'accepted' && q1.blocked === null && q1.deliver[0].have >= 10, 'h1 accepted, deliverable (have ≥ 10)', JSON.stringify({ state: q1.state, blocked: q1.blocked, have: q1.deliver[0].have }));
  const scrapBefore = await P(() => window.__game.ctx.inventory.countDefAll('mat_scrap'));
  const credBeforeQ = await credits();
  const repBeforeQ = (await rep('helix')).rep;
  const xpBefore = await P(() => window.__game.ctx.progression ? window.__game.ctx.progression.xp + window.__game.ctx.progression.level * 1e6 : null);
  ok(await P(() => window.__game.ctx.meta.completeQuest('h1')) === true, 'completeQuest(h1) → true');
  const scrapAfter = await P(() => window.__game.ctx.inventory.countDefAll('mat_scrap'));
  ok(scrapAfter === scrapBefore - 10, 'mat_scrap −10 consumed', `${scrapBefore} → ${scrapAfter}`);
  ok(await credits() === credBeforeQ + 150, 'credits +150', `${await credits()}`);
  ok((await rep('helix')).rep === repBeforeQ + 150, 'helix rep +150', `${(await rep('helix')).rep}`);
  const xpAfter = await P(() => window.__game.ctx.progression ? window.__game.ctx.progression.xp + window.__game.ctx.progression.level * 1e6 : null);
  ok(xpBefore === null || xpAfter > xpBefore, 'character XP +200 via progression.addXp', `${xpBefore} → ${xpAfter}`);
  qc = await lastEv('meta:questChanged');
  ok(qc && qc.id === 'h1' && qc.state === 'complete', 'meta:questChanged {h1, complete}', JSON.stringify(qc));
  const q2 = await P(() => window.__game.ctx.meta.getQuests('helix').map((q) => ({ id: q.def.id, state: q.state })));
  ok(q2.find((q) => q.id === 'h1')?.state === 'complete' && q2.find((q) => q.id === 'h2')?.state === 'available', 'h1 complete → h2 available', JSON.stringify(q2));
  ok(await P(() => window.__game.ctx.meta.acceptQuest('h1')) === false, 'completed quest cannot be re-accepted');

  console.log('persistence: reload');
  const snap = { credits: await credits(), rep: (await rep('helix')).rep, level: (await rep('helix')).level };
  await P(() => window.__game.ctx.meta.save());
  const saved = await P(() => { try { return JSON.parse(localStorage.getItem('scav.meta')); } catch { return null; } });
  ok(saved && saved.v === 1 && saved.credits === snap.credits && saved.corps.helix.rep === snap.rep && saved.corps.helix.quests.h1 === 'complete' && saved.activeContract === null, 'localStorage scav.meta v1 holds credits / rep / h1 complete', JSON.stringify(saved));
  await page.reload({ waitUntil: 'load' });
  await boot();
  ok(await credits() === snap.credits, `credits persisted (${snap.credits})`, `${await credits()}`);
  const rr = await rep('helix');
  ok(rr.rep === snap.rep && rr.level === snap.level, `helix rep persisted (${snap.rep} / Lv.${snap.level})`, JSON.stringify(rr));
  ok(await P(() => window.__game.ctx.meta.getQuestState('h1')) === 'complete' && await P(() => window.__game.ctx.meta.getQuestState('h2')) === 'available', 'quest states persisted (h1 complete, h2 available)');
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
      // 2026-09-08: 신뢰도가 모자란 페이지는 탭 자체가 잠긴다 (사유는 title)
      locked: b.classList.contains('is-locked'), disabled: b.disabled, why: b.title,
    }));
    const ctx = window.__game.ctx;
    return {
      hidden: root.hidden, oldOverlay: !!document.querySelector('.menu.corp-menu'),
      corpBlocker: ctx.uiBlockers.has('corp'), blocker: ctx.uiBlockers.has('inventory'),
      isOpen: ctx.meta.isMenuOpen, tab: ctx.inventory.screenTab, invOpen: ctx.inventory.isOpen,
      cursor: ctx.input.isCursorMode,
      // 상단은 창의 화면 탭, 좌측은 기업 목록 rail, 우측이 메인 패널
      railTabs: root.querySelectorAll('.corp-shell > .corp-rail .corp-tabs .corp-tab').length,
      sideOrder: [...root.querySelectorAll('.corp-main > .corp-side > *')].map((e) => e.className.split(' ')[0]),
      credits: root.querySelector('.corp-credits .v')?.textContent,
      panel: root.querySelector('.corp-side .corp-panel .name')?.textContent,
      motto: !!root.querySelector('.corp-banner'), foot: !!root.querySelector('.hub-foot'),
      tabs, subs, rows: root.querySelectorAll('.corp-page .corp-row, .corp-page .ct-cell, .corp-page .corp-empty').length,
    };
  });
  // 2026-09-07: the screen is a tab of the Tab window, so the blocker + in-game cursor are the window's
  ok(dom && !dom.hidden && !dom.oldOverlay && !dom.corpBlocker && dom.blocker && dom.isOpen && dom.invOpen && dom.tab === 'corp' && dom.cursor,
    'openCorpMenu(ceres) → Tab 창의 기업 탭 (전용 오버레이 · corp 블로커 없음, inventory 블로커 + 인게임 커서)',
    JSON.stringify(dom && { oldOverlay: dom.oldOverlay, corpBlocker: dom.corpBlocker, blocker: dom.blocker, tab: dom.tab, cursor: dom.cursor }));
  // Phase 10: every credit readout is `formatCredits` → `1,200 C` (ko-KR grouping + the `C` unit, never `₩` / `cr`)
  ok(dom && dom.railTabs === 4 && dom.credits === `${snap.credits.toLocaleString('ko-KR')} C` && !dom.foot,
    '좌측 rail 에 기업 목록 4개 + 크레딧 (100 C 표기), 푸터 없음', JSON.stringify(dom && { railTabs: dom.railTabs, credits: dom.credits, foot: dom.foot }));
  ok(dom && dom.sideOrder[0] === 'corp-panel' && dom.sideOrder[1] === 'corp-subtabs',
    '메인 패널 좌열: 기업 패널 위 · 거래/계약/퀘스트 아래', JSON.stringify(dom && dom.sideOrder));
  ok(dom && dom.tabs.length === 4 && dom.tabs.find((t) => t.corp === 'ceres')?.on && dom.panel === '세레스 바이오' && !dom.motto,
    '4 corp tabs, ceres selected, 기업 패널 세레스 바이오 (no motto banner)', JSON.stringify(dom && dom.tabs));
  ok(dom && dom.subs.map((s) => s.page).join(',') === 'trade,contracts,quests,implants', 'sub-tabs 거래 / 계약 / 퀘스트 / 임플란트 at ceres', JSON.stringify(dom && dom.subs));
  // 2026-09-08 UI/UX: 신뢰도 Lv.0 → 거래 탭은 잠기고, 화면은 잠기지 않는 퀘스트 탭으로 열린다.
  // 계약은 세레스에 minRepLevel 0 짜리가 있으므로 잠기지 않는다 (요구사항: Lv.0 에서도 계약은 가능).
  const subTrade = dom && dom.subs.find((s) => s.page === 'trade');
  const subContracts = dom && dom.subs.find((s) => s.page === 'contracts');
  const subQuests = dom && dom.subs.find((s) => s.page === 'quests');
  ok(subQuests && subQuests.on && !subQuests.locked, '신뢰도가 모자라면 퀘스트 탭으로 열린다', JSON.stringify(subQuests));
  ok(subTrade && subTrade.locked && subTrade.disabled && /신뢰도 Lv\.1 부터 거래 가능/.test(subTrade.why), '거래 탭이 잠긴다 (사유가 title 에)', JSON.stringify(subTrade));
  ok(subContracts && !subContracts.locked && !subContracts.disabled, 'Lv.0 에서도 계약 탭은 열려 있다 (minRepLevel 0 계약이 있다)', JSON.stringify(subContracts));
  // 잠긴 탭은 눌러도 넘어가지 않고 사유만 뜬다
  const clickLocked = await P(() => {
    document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]').click();
    const on = document.querySelector('.corp-subtabs .scr-tab.is-on');
    return { on: on?.dataset.page, msg: document.querySelector('.corp-view .form-msg')?.textContent ?? '' };
  });
  ok(clickLocked.on === 'quests', '잠긴 거래 탭을 눌러도 퀘스트 탭에 머문다', JSON.stringify(clickLocked));
  // 신뢰도를 Lv.1 로 올리면 거래 탭이 풀린다
  const unlocked = await P(() => {
    window.__game.ctx.meta.addRep('ceres', 100, 'smoke');
    const b = document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]');
    return { locked: b.classList.contains('is-locked'), disabled: b.disabled, lv: window.__game.ctx.meta.getRep('ceres').level };
  });
  ok(unlocked.lv === 1 && !unlocked.locked && !unlocked.disabled, '신뢰도 Lv.1 이 되면 거래 탭이 풀린다', JSON.stringify(unlocked));
  await P(() => { document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]').click(); });
  await sleep(60);
  ok(await P(() => document.querySelector('.corp-subtabs .scr-tab.is-on')?.dataset.page === 'trade'), '풀린 거래 탭으로 전환된다');
  let tg = await lastEv('ui:corpToggled');
  ok(tg && tg.open === true && tg.corp === 'ceres', 'ui:corpToggled {open:true, ceres}', JSON.stringify(tg));
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="contracts"]').click());
  const contractsDom = await P(() => ({
    rows: [...document.querySelectorAll('.cc-list .corp-row.contract')].map((r) => ({ id: r.dataset.id, btn: r.querySelector('.ui-btn')?.textContent, disabled: r.querySelector('.ui-btn')?.disabled })),
    active: document.querySelectorAll('.cc-active .corp-row.contract, .cc-active .corp-empty').length,
    on: document.querySelector('.corp-subtabs .scr-tab.is-on')?.dataset.page,
  }));
  ok(contractsDom.on === 'contracts' && contractsDom.rows.length === 4 && contractsDom.rows[0].id === 'ceres_1' && contractsDom.rows[0].btn === '수락' && contractsDom.rows[0].disabled === false, '계약 tab: 4 ceres rows, ceres_1 수락 enabled', JSON.stringify(contractsDom));
  await P(() => document.querySelector('.corp-tab[data-corp="helix"]').click());
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="quests"]').click());
  const questsDom = await P(() => ({
    rows: [...document.querySelectorAll('.cq-list .corp-row.quest')].map((r) => ({ id: r.dataset.id, badge: r.querySelector('.badge')?.textContent })),
    // the middle column shows the selected quest's delivery table; the right column is the embedded grids
    deliver: document.querySelectorAll('.cq-deliver .cq-line').length,
    grids: document.querySelectorAll('.cq-col.inv .trade-grids .tg-block').length,
  }));
  ok(questsDom.rows.length === 4 && questsDom.rows[0].id === 'h1' && questsDom.rows[0].badge === '완료' && questsDom.rows[1].badge === '가능', 'helix 퀘스트 tab: h1 완료, h2 가능', JSON.stringify(questsDom.rows));
  ok(questsDom.deliver >= 1 && questsDom.grids === 2, `퀘스트 tab: 납품 table in the middle, 가방 + 함선 창고 grids on the right (${questsDom.deliver} lines, ${questsDom.grids} grids)`);
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="trade"]').click());
  // helix is Lv.2 by now (310 rep): the shelf grew past the Lv.1 list, so compare with the live shop
  const shopDom = await P(() => ({
    // Phase 9 UI pass: the stock list is an **item grid** of `.ct-cell` thumbnails, not wide rows
    rows: document.querySelectorAll('.ct-shop-list .ct-cell.shop').length,
    tips: document.querySelectorAll('.ct-shop-list .ct-cell.shop .item-chip[data-def-id]').length,
    prices: [...document.querySelectorAll('.ct-shop-list .ct-cell.shop .ct-cell-price')].map((e) => e.textContent),
    live: window.__game.ctx.meta.getShop('helix').length,
    buyBtn: !!document.querySelector('.ct-shop-list .ct-cell.shop .ui-btn'),   // 즉시 구매 buttons are gone (장바구니)
    grids: document.querySelectorAll('.ct-col.inv .trade-grids .tg-block').length,
    trays: document.querySelectorAll('.ct-trays .ct-tray').length,
    confirm: document.querySelector('.ct-confirm')?.textContent,
    confirmOff: document.querySelector('.ct-confirm')?.disabled,
    // 귀중품 전부 담기 moved into the 판매 tray (the screen footer is gone)
    stage: !!document.querySelector('.ct-tray.sell .ct-stage'),
    // 구매 / 판매 트레이는 5칸 그리드, 그리드 칸 크기는 가방 / 창고와 같다
    trayCols: getComputedStyle(document.querySelector('.ct-tray.buy .ct-slots')).gridTemplateColumns.split(' ').length,
    cellPx: getComputedStyle(document.querySelector('.corp-view')).getPropertyValue('--ct-cell').trim(),
    bagCell: getComputedStyle(document.querySelector('.ct-col.inv .trade-grids')).getPropertyValue('--inv-cell').trim(),
    // 재고 칸은 아이템 발자국만큼 자리를 차지한다
    spans: [...document.querySelectorAll('.ct-shop-list .ct-cell.shop')].map((c) => c.style.gridColumn),
  }));
  ok(shopDom.rows === shopDom.live && shopDom.rows > shop1.length && !shopDom.buyBtn,
    `거래 tab: one stock cell per shop line (${shopDom.live}, more than the ${shop1.length} at Lv.1), no per-cell 구매 button`, JSON.stringify(shopDom));
  ok(shopDom.tips === shopDom.rows, `모든 재고 칸이 item-chip 썸네일 (호버 툴팁 대상, ${shopDom.tips}/${shopDom.rows})`);
  // the price badge sits in the cell corner now, so it is the grouped number without the unit
  ok(shopDom.prices.length === shopDom.rows && shopDom.prices.every((t) => /^[\d,]+$/.test(t ?? '')),
    `재고 칸 가격 배지 (${shopDom.prices[0]})`, JSON.stringify(shopDom.prices.slice(0, 3)));
  ok(shopDom.trayCols === 5 && shopDom.cellPx === '40px' && shopDom.bagCell === '40px',
    `구매/판매 트레이가 5칸, 재고·가방·창고가 같은 칸 크기 (${shopDom.trayCols}칸 / ${shopDom.cellPx} / ${shopDom.bagCell})`);
  ok(shopDom.spans.every((v) => /^span \d$/.test(v ?? '')), `재고 칸이 아이템 발자국만큼 차지한다 (${shopDom.spans.slice(0, 3).join(', ')})`);
  ok(shopDom.trays === 2 && shopDom.grids === 2 && shopDom.confirm === '거래 성사' && shopDom.confirmOff,
    '거래 tab: 구매 / 판매 trays, 가방 + 함선 창고 grids, 거래 성사 disabled on an empty basket', JSON.stringify(shopDom));
  // stage one purchase from the stock list and one sale from the bag, then settle the basket
  const staged = await P(() => {
    document.querySelector('.ct-shop-list .ct-cell.shop.is-draggable')?.click();
    const inst = window.__game.ctx.meta.getSellable()[0];
    const view = window.__game.getSystem('meta');
    return { inst: !!inst, buy: document.querySelectorAll('.ct-tray.buy .ct-chip').length, hasView: !!view };
  });
  ok(staged.buy === 1, `clicking a stock cell stages it in the 구매 tray (${staged.buy})`);
  const settled = await P(() => {
    const before = window.__game.ctx.meta.credits;
    document.querySelector('.ct-confirm').click();
    return { before, after: window.__game.ctx.meta.credits, buy: document.querySelectorAll('.ct-tray.buy .ct-chip').length };
  });
  ok(settled.after < settled.before && settled.buy === 0, `거래 성사 settles the basket and empties the trays (${settled.before} → ${settled.after})`, JSON.stringify(settled));
  ok(shopDom.stage, '귀중품 전부 담기 button sits under the 판매 tray');
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
  ok(tabsCeres.length === 4 && tabsCeres.find((t) => t.page === 'implants')?.hidden === false, '임플란트 tab visible at ceres', JSON.stringify(tabsCeres));
  await P(() => document.querySelector('.corp-tab[data-corp="helix"]').click());
  const tabsHelix = await P(() => ({ hidden: document.querySelector('.corp-subtabs .scr-tab[data-page="implants"]')?.hidden, page: document.querySelector('.corp-page')?.dataset.page }));
  ok(tabsHelix.hidden === true && tabsHelix.page === 'trade', '임플란트 tab hidden at helix (page stays 거래)', JSON.stringify(tabsHelix));
  await P(() => { document.querySelector('.corp-tab[data-corp="ceres"]').click(); document.querySelector('.corp-subtabs .scr-tab[data-page="implants"]').click(); });
  const deskEmpty = await P(() => ({
    page: document.querySelector('.corp-page')?.dataset.page, root: !!document.querySelector('.corp-page .ci'),
    cells: document.querySelectorAll('.ci-list .ct-cell.broken').length, empty: document.querySelector('.ci-list .corp-empty')?.textContent ?? null,
    grid: document.querySelector('.ci-list') ? getComputedStyle(document.querySelector('.ci-list')).display : null,
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
    const cell = document.querySelector(`.ci-list .ct-cell.broken[data-uid="${uid}"]`);
    const btn = document.querySelector('.ci-repair-btn');
    return {
      cell: !!cell, sel: cell?.classList.contains('is-sel'), chip: !!cell?.querySelector('.item-chip[data-def-id="imp_broken_strength_1"]'), badge: cell?.querySelector('.ct-cell-price')?.textContent,
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
      cells: document.querySelectorAll('.ci-list .ct-cell.broken').length, msg: document.querySelector('.corp-msg-slot .form-msg')?.textContent ?? '',
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
    const cell = document.querySelector(`.ci-list .ct-cell.broken[data-uid="${uid}"]`);
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

  console.log('implants (Phase 12): ceres quest chain');
  const chain = await P(() => window.__game.ctx.meta.getQuests('ceres').filter((q) => /^ci\d$/.test(q.def.id)).map((q) => ({ id: q.def.id, state: q.state, rep: q.def.requires.repLevel ?? 0, after: q.def.requires.quests ?? [], items: (q.def.rewards.items ?? []).map((i) => i.defId), deliver: q.def.deliver.map((d) => d.defId) })));
  ok(chain.length === 3 && chain[0].id === 'ci1' && chain[0].state === 'available' && chain[0].rep === 1 && chain[0].items[0] === 'imp_perception_3',
    'ci1 available at ceres Lv.2 (needs Lv.1), rewards imp_perception_3', JSON.stringify(chain[0]));
  ok(chain[1].state === 'locked' && chain[1].after[0] === 'ci1' && chain[1].deliver.includes('imp_broken_intelligence_1') && chain[1].items[0] === 'imp_intelligence_3',
    'ci2 locked behind ci1, delivers a broken implant + materials, rewards imp_intelligence_3', JSON.stringify(chain[1]));
  ok(chain[2].state === 'locked' && chain[2].rep === 3 && chain[2].after[0] === 'ci2' && chain[2].items[0] === 'imp_perk_quick_heal', 'ci3 locked (ci2 + Lv.3), rewards imp_perk_quick_heal', JSON.stringify(chain[2]));
  ok(await P((ids) => ids.every((id) => !!window.__game.ctx.loot.getItemDef(id)), chain.flatMap((q) => [...q.items, ...q.deliver])), 'every ci delivery / reward id resolves to an item def');
  await P(() => document.querySelector('.corp-subtabs .scr-tab[data-page="quests"]').click());
  await P(() => document.querySelector('.cq-list .corp-row.quest[data-id="ci1"]').click());
  const questDom = await P(() => ({
    badge: document.querySelector('.cq-list .corp-row.quest[data-id="ci1"] .badge')?.textContent, sel: document.querySelector('.cq-list .corp-row.quest[data-id="ci1"]')?.classList.contains('is-sel'),
    name: document.querySelector('.cq-deliver .cq-name')?.textContent, lines: document.querySelectorAll('.cq-deliver .cq-line').length,
    reward: !!document.querySelector('.cq-deliver .rw-items .item-chip[data-def-id="imp_perception_3"]'), accept: document.querySelector('.cq-acts .ui-btn')?.textContent,
  }));
  ok(questDom.badge === '가능' && questDom.sel && questDom.name === '신경 접합제' && questDom.lines === 3 && questDom.reward && questDom.accept === '수락',
    '퀘스트 tab: ci1 가능 · 3 delivery lines · reward chip imp_perception_3 · 수락', JSON.stringify(questDom));
  // 2026-09-08 (ESC = 항상 일시정지): the 기업 desk is a tab of the inventory window, so **Tab** closes it —
  // Escape now only opens the 일시정지 메뉴 on top of it.
  await tap('Tab');
  await sleep(60);
  ok(await P(() => !document.querySelector('.inv-screen.corp-view') && !window.__game.ctx.meta.isMenuOpen), 'Tab closes the desk window');

  console.log('persistence: corrupt save is sanitised');
  // the 거래 성사 above left a debounced save pending — let it land first, or the pagehide flush would
  // overwrite the corrupt payload we are about to plant (SAVE_DELAY_MS = 350 ms)
  await sleep(600);
  await P(() => localStorage.setItem('scav.meta', JSON.stringify({
    v: 1, credits: -50, corps: { helix: { rep: 'x', quests: { h1: 'locked', zzz: 'complete', b1: 'complete' } }, ceres: { rep: 250.7, quests: { c1: 'accepted' } } },
    activeContract: { id: 'nope', progress: 3 }, stats: null,
  })));
  await page.reload({ waitUntil: 'load' });
  await boot();
  const san = await P(() => {
    const m = window.__game.ctx.meta;
    return { credits: m.credits, helix: m.getRep('helix').rep, ceres: m.getRep('ceres').rep, h1: m.getQuestState('h1'), b1: m.getQuestState('b1'), c1: m.getQuestState('c1'), ac: m.activeContract };
  });
  ok(san.credits === 0 && san.helix === 0 && san.ceres === 250 && san.h1 === 'available' && san.b1 === 'available' && san.c1 === 'accepted' && san.ac === null,
    'corrupt fields clamped / dropped (credits 0, rep 0 / 250, bogus quest states dropped, unknown contract cleared)', JSON.stringify(san));

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
