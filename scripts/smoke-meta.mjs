// Single-player smoke test for the meta folder (Phase 5-c, 2026-09-06): credits / reputation / corp shop (filter, prices,
// buy, refuse) / sale / contracts (accept gating, kill progress from a real enemy, squad share, death + success settlement)
// / quests (deliver, rewards, chain unlock) / reload persistence / the 기업 네트워크 screen (DOM, blocker, tabs, Esc).
// Phase 7 (2026-09-06): `canFit` pre-check (공간 없음 before the click), server credits through a fake `ctx.net.profile`
// (optimistic debit → `credits:tx` → `meta:purchase` on the answer, refusal reverts, sell / addCredits go through the
// transaction, `profile.set('meta')` on save, `net:profileLoaded` replace + migrate), settlement `outcome`, training.
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
    'meta:contractSettled', 'meta:questChanged', 'meta:purchase', 'meta:sale', 'ui:corpToggled', 'enemy:killed'];
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
  ok(await P(() => window.__game.ctx.meta.priceOf('helix', 'wpn_ar23')) === null, 'priceOf null while the shop is closed');
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
  ok(shop1.length > 0 && ['wpn_ar23', 'wpn_smg37', 'wpn_p2', 'ammo_light', 'ammo_medium'].every((id) => ids1.includes(id)), 'Lv.1 shop lists AR I / SMG I / P-2 / 경량탄 / 준중량탄', ids1.join(','));
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
    const root = document.querySelector('.menu.corp-menu');
    if (!root) return null;
    const tabs = [...root.querySelectorAll('.corp-tab')].map((b) => ({ corp: b.dataset.corp, on: b.classList.contains('is-on') }));
    const subs = [...root.querySelectorAll('.corp-subtabs .scr-tab')].map((b) => ({ page: b.dataset.page, on: b.classList.contains('is-on') }));
    return {
      hidden: root.hidden, blocker: window.__game.ctx.uiBlockers.has('corp'), isOpen: window.__game.ctx.meta.isMenuOpen,
      cursor: window.__game.ctx.input.isCursorMode,
      // Phase 9 UI pass: the `기업 네트워크` title + subtitle are gone — the corp list occupies the header's left slot
      title: root.querySelector('.hub-head .title')?.textContent ?? null,
      headTabs: root.querySelectorAll('.hub-head .corp-tabs .corp-tab').length,
      credits: root.querySelector('.corp-credits .v')?.textContent,
      // Phase 9 UI pass: the banner (motto + description) became a compact 기업 패널 — name + 신뢰도 only
      panel: root.querySelector('.corp-panel .name')?.textContent,
      motto: !!root.querySelector('.corp-banner'),
      tabs, subs, rows: root.querySelectorAll('.corp-page .corp-row, .corp-page .ct-cell, .corp-page .corp-empty').length,
    };
  });
  // Phase 10: the corp screen keeps the pointer lock and turns on the in-game cursor instead of exiting the lock
  ok(dom && !dom.hidden && dom.blocker && dom.isOpen && dom.cursor, 'openCorpMenu(ceres) → visible, blocker corp, isMenuOpen, in-game cursor on', JSON.stringify(dom && { hidden: dom.hidden, blocker: dom.blocker, cursor: dom.cursor }));
  // Phase 10: every credit readout is `formatCredits` → `1,200 C` (ko-KR grouping + the `C` unit, never `₩` / `cr`)
  ok(dom && dom.title === null && dom.headTabs === 4 && dom.credits === `${snap.credits.toLocaleString('ko-KR')} C`,
    '헤더: 제목 없이 기업 목록 + 크레딧 (100 C 표기)', JSON.stringify(dom && { title: dom.title, headTabs: dom.headTabs, credits: dom.credits }));
  ok(dom && dom.tabs.length === 4 && dom.tabs.find((t) => t.corp === 'ceres')?.on && dom.panel === '세레스 바이오' && !dom.motto,
    '4 corp tabs, ceres selected, 기업 패널 세레스 바이오 (no motto banner)', JSON.stringify(dom && dom.tabs));
  ok(dom && dom.subs.map((s) => s.page).join(',') === 'trade,contracts,quests' && dom.subs[0].on, 'sub-tabs 거래 / 계약 / 퀘스트 (거래 on)', JSON.stringify(dom && dom.subs));
  ok(dom && dom.rows >= 1, '거래 page shows the locked-shop notice (ceres Lv.0)', `${dom && dom.rows}`);
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
    stage: !document.querySelector('.corp-menu .hub-foot .right .ui-btn').hidden,
  }));
  ok(shopDom.rows === shopDom.live && shopDom.rows > shop1.length && !shopDom.buyBtn,
    `거래 tab: one stock cell per shop line (${shopDom.live}, more than the ${shop1.length} at Lv.1), no per-cell 구매 button`, JSON.stringify(shopDom));
  ok(shopDom.tips === shopDom.rows, `모든 재고 칸이 item-chip 썸네일 (호버 툴팁 대상, ${shopDom.tips}/${shopDom.rows})`);
  // Phase 10: the old `123 cr` suffix is gone — every price is `formatCredits` (`1,200 C`)
  ok(shopDom.prices.length === shopDom.rows && shopDom.prices.every((t) => /^[\d,]+ C$/.test(t ?? '')),
    `재고 칸 가격이 100 C 표기 (${shopDom.prices[0]})`, JSON.stringify(shopDom.prices.slice(0, 3)));
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
  ok(shopDom.stage, '귀중품 전부 담기 button visible on the 거래 tab');
  await tap('Escape');
  await sleep(30);
  const closed = await P(() => ({ hidden: document.querySelector('.menu.corp-menu').hidden, blocker: window.__game.ctx.uiBlockers.has('corp'), isOpen: window.__game.ctx.meta.isMenuOpen, cursor: window.__game.ctx.input.isCursorMode }));
  ok(closed.hidden && !closed.blocker && !closed.isOpen && !closed.cursor, 'Esc closes: hidden, blocker + in-game cursor removed', JSON.stringify(closed));
  tg = await lastEv('ui:corpToggled');
  ok(tg && tg.open === false, 'ui:corpToggled {open:false}', JSON.stringify(tg));

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
