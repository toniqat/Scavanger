// Single-player smoke test for the inventory folder's Phase 5 work (2026-09-06): loadout persistence (`scav.loadout`:
// ship changes survive a reload, starter resets overwrite the save, game:complete saves), the corp-shop access methods
// (`tryAddToStash` / `tryAddItemAnywhere` / `takeItem` / `findItemAnywhere`), `inventory:containerOpened {first}` and
// the ship Tab screen's 크레딧 readout + active 기업 tab.
// Usage: node scripts/smoke-loadout.mjs [http://localhost:5273/]   (needs a vite dev server)
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
  await page.evaluateOnNewDocument(() => {
    // Never let headless Chrome take a real pointer lock (Windows ClipCursor traps the OS cursor in the hidden window).
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Keep vite's HMR socket from ever connecting: another agent's save would otherwise full-reload the page mid-run.
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['inventory:loadoutSaved', 'inventory:containerOpened', 'inventory:stashChanged', 'inventory:itemRemoved', 'inventory:itemAdded',
    'inventory:quickSlotsChanged', 'loadout:changed', 'ui:notify', 'ui:corpToggled', 'inventory:closed', 'inventory:opened'];
  // Boot (or re-boot after a reload): frame driver for a hidden tab, fake pointer lock, bus recorder.
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
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
      }
    }, EVENTS);
  };
  const reload = async () => { await page.goto(BASE, { waitUntil: 'load' }); await boot(); };
  // headless rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  // Key taps: keydown + keyup in the same evaluate (dt is clamped, any wait reads as a hold) on document.body, bubbling to window.
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const evCount = (n) => page.evaluate((k) => window.__ev[k].length, n);
  const waitSaved = async (reason, since) => waitFor(page, ([r, s]) => window.__ev['inventory:loadoutSaved'].slice(s).some((e) => e.reason === r), `loadoutSaved ${reason}`, 15000, [reason, since]);
  const enterHub = async () => {
    await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await waitSim(0.3);
  };
  const startMission = async (seed) => {
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.player && !window.__game.ctx.player.isDropping, 'hellpod exit', 30000);
    await waitSim(0.3);
  };
  /** Comparable snapshot of the whole loadout (slots + bag placements + quick slots) as def ids. */
  const snapshot = () => page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const l = sys.getLoadout();
    const slot = (it) => it ? { defId: it.defId, durability: it.durability ?? null, ammoInMag: it.ammoInMag ?? null } : null;
    const bag = sys.getGrid('bag').items().map((p) => ({ defId: p.item.defId, qty: p.item.qty, x: p.x, y: p.y, rotated: p.item.rotated }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      slots: { primary: slot(l.primary), primary2: slot(l.primary2), secondary: slot(l.secondary), bag: slot(l.bag), armor: slot(l.armor) },
      bag, quick: sys.getQuickSlots().map((i) => i ? i.defId : null), size: sys.getBagSize(),
    };
  });
  const saveFile = () => page.evaluate(() => JSON.parse(localStorage.getItem('scav.loadout') ?? 'null'));

  /* ── 0. fresh: no save → starter on the first hub entry ─────────────── */
  console.log('fresh save');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.removeItem('scav.loadout'); localStorage.removeItem('scav.stash'); });
  await reload();
  const beforeHub = await snapshot();
  ok(!beforeHub.slots.primary && beforeHub.bag.length === 0, 'no save: bag + slots empty before the first hub entry', JSON.stringify(beforeHub.slots));
  await enterHub();
  let snap = await snapshot();
  ok(snap.slots.primary?.defId === 'wpn_ar23' && snap.slots.secondary?.defId === 'wpn_p2' && snap.slots.bag?.defId === 'bag_common' && snap.slots.armor?.defId === 'armor_2' && snap.slots.primary2 === null,
    'first hub entry hands out the starter loadout', JSON.stringify(snap.slots));
  ok(snap.bag.some((i) => i.defId === 'grenade_frag') && snap.bag.some((i) => i.defId === 'stim') && snap.quick[0] === 'grenade_frag' && snap.quick[4] === 'stim',
    'starter bag items + quick slots N grenade / S stim', JSON.stringify(snap.quick));
  let saved = await lastEv('inventory:loadoutSaved');
  ok(saved && saved.reason === 'starter', 'applyStarter saved the starter (inventory:loadoutSaved {reason: starter})', JSON.stringify(saved));
  let file = await saveFile();
  ok(file && file.v === 1 && file.slots.primary?.defId === 'wpn_ar23' && Array.isArray(file.bag) && file.bag.length === snap.bag.length && Array.isArray(file.quick) && file.quick.length === 8,
    'scav.loadout v1: slots + bag placements + 8 quick indices', JSON.stringify(file && { v: file.v, slots: Object.keys(file.slots), bag: file.bag.length, quick: file.quick }));

  /* ── 1. ship changes persist across a reload ───────────────────────── */
  console.log('ship changes → reload');
  let since = await evCount('inventory:loadoutSaved');
  const changed = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const gem = ctx.loot.createItem('gem_amber');
    const smg = ctx.loot.createItem('wpn_smg37');
    const addedGem = inv.tryAddItem(gem);
    const addedSmg = inv.tryAddItem(smg);
    const equipped = inv.equip(smg.uid, 'primary2');
    inv.updateItem(smg.uid, { durability: 123, ammoInMag: 5 });
    return { addedGem, addedSmg, equipped, primary2: inv.getLoadout().primary2?.defId };
  });
  ok(changed.addedGem && changed.addedSmg && changed.equipped && changed.primary2 === 'wpn_smg37', 'gem_amber into the bag, SMG equipped as 주무기 II', JSON.stringify(changed));
  await waitSaved('hub', since);
  ok(true, 'debounced save after the ship change (reason hub)');
  file = await saveFile();
  const gemEntry = file?.bag.find((e) => e.defId === 'gem_amber');
  ok(file?.slots.primary2?.defId === 'wpn_smg37' && file.slots.primary2.durability === 123 && file.slots.primary2.ammoInMag === 5, 'save carries the SMG with durability 123 / 5 rounds', JSON.stringify(file?.slots.primary2));
  ok(gemEntry && Number.isInteger(gemEntry.x) && Number.isInteger(gemEntry.y) && typeof gemEntry.rotated === 'boolean', 'save carries the gem with its cell + rotation', JSON.stringify(gemEntry));
  const grenadeIdx = file?.bag.findIndex((e) => e.defId === 'grenade_frag');
  ok(file?.quick[0] === grenadeIdx && file.quick[4] === file.bag.findIndex((e) => e.defId === 'stim'), 'quick slots saved as bag indices (N grenade, S stim)', JSON.stringify(file?.quick));
  const before = await snapshot();
  await reload();
  const restored = await snapshot();
  ok(restored.slots.primary2?.defId === 'wpn_smg37' && restored.bag.some((i) => i.defId === 'gem_amber'), 'reload: the save is restored at init (before any hub entry)', JSON.stringify(restored.slots));
  await enterHub();
  const after = await snapshot();
  ok(JSON.stringify(after) === JSON.stringify(before), 'reload + hub entry: slots / bag placements / quick slots identical', `${JSON.stringify(after)} vs ${JSON.stringify(before)}`);
  ok(after.slots.primary2?.durability === 123 && after.slots.primary2.ammoInMag === 5, 'durability / rounds restored on the SMG');
  const announced = await ev('loadout:changed');
  ok(announced.length > 0 && announced[announced.length - 1].primary2?.defId === 'wpn_smg37', 'hub:entered announced the restored loadout (loadout:changed)', JSON.stringify(announced.length));
  const reasons = (await ev('inventory:loadoutSaved')).map((e) => e.reason);
  ok(!reasons.includes('starter'), 'no starter reset after the reload', JSON.stringify(reasons));
  const qs = await lastEv('inventory:quickSlotsChanged');
  ok(qs && qs.slots[0]?.defId === 'grenade_frag' && qs.slots[4]?.defId === 'stim', 'inventory:quickSlotsChanged re-emitted with the restored slots', JSON.stringify(qs && qs.slots.map((s) => s && s.defId)));

  /* ── 2. starter resets overwrite the save; game:complete saves ─────── */
  console.log('respawn / complete');
  await startMission(5);
  since = await evCount('inventory:loadoutSaved');
  await page.evaluate(() => window.__game.ctx.bus.emit('player:respawn', { position: window.__game.ctx.player.position.clone() }));
  await waitSaved('starter', since);
  snap = await snapshot();
  ok(snap.slots.primary2 === null && !snap.bag.some((i) => i.defId === 'gem_amber'), 'player:respawn → starter kit (SMG + gem gone)', JSON.stringify(snap.slots));
  file = await saveFile();
  ok(file && !file.slots.primary2 && !file.bag.some((e) => e.defId === 'gem_amber'), 'the starter overwrote the save immediately', JSON.stringify(file && Object.keys(file.slots)));
  await reload();
  snap = await snapshot();
  ok(snap.slots.primary?.defId === 'wpn_ar23' && snap.slots.primary2 === null && !snap.bag.some((i) => i.defId === 'gem_amber'), 'reload after the respawn: starter kept, lost bag not resurrected', JSON.stringify(snap.slots));
  // mission loot is saved on game:complete
  await startMission(6);
  since = await evCount('inventory:loadoutSaved');
  await page.evaluate(() => { const ctx = window.__game.ctx; ctx.inventory.tryAddItem(ctx.loot.createItem('gem_amber')); });
  const noSaveMidMission = (await evCount('inventory:loadoutSaved')) === since;
  await page.evaluate(() => { const ctx = window.__game.ctx; ctx.bus.emit('game:complete', { stats: { ...ctx.stats } }); });
  await waitSaved('complete', since);
  file = await saveFile();
  ok(noSaveMidMission && file?.bag.some((e) => e.defId === 'gem_amber'), 'mission loot is not saved until game:complete, then it is', JSON.stringify(file?.bag.map((e) => e.defId)));
  await enterHub();
  snap = await snapshot();
  ok(snap.bag.some((i) => i.defId === 'gem_amber'), 'back in the ship after a completed mission the loot is kept');

  /* ── 3. corp-shop access: tryAddToStash / tryAddItemAnywhere / takeItem / findItemAnywhere ── */
  console.log('stash access');
  const stashBefore = await page.evaluate(() => window.__game.ctx.inventory.getStashItems().length);
  const stashChangedBefore = await evCount('inventory:stashChanged');
  const toStash = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const scrap = ctx.loot.createItem('mat_scrap', 5);
    const r = inv.tryAddToStash(scrap);
    const bogus = inv.tryAddToStash({ uid: 'x', defId: 'nope_def', qty: 1, rotated: false });
    return { r, bogus, n: inv.getStashItems().length, uid: scrap.uid, found: inv.findItemAnywhere(scrap.uid)?.defId ?? null, inBag: inv.findItem(scrap.uid) };
  });
  ok(toStash.r && !toStash.bogus && toStash.n === stashBefore + 1, 'tryAddToStash places a fresh stack (unknown def refused)', JSON.stringify(toStash));
  ok((await evCount('inventory:stashChanged')) > stashChangedBefore, 'inventory:stashChanged emitted');
  ok(toStash.found === 'mat_scrap' && toStash.inBag === null, 'findItemAnywhere finds the stash item (findItem does not)');
  await sleep(600);
  const stashFile = await page.evaluate(() => JSON.parse(localStorage.getItem('scav.stash') ?? 'null'));
  ok(stashFile && stashFile.items.some((e) => e.defId === 'mat_scrap' && e.qty === 5), 'stash persisted (scav.stash) after tryAddToStash', JSON.stringify(stashFile?.items?.length));
  const anywhere = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const first = inv.tryAddItemAnywhere(ctx.loot.createItem('gem_amber'));
    const seen = [first];
    let stashHit = null;
    for (let i = 0; i < 60 && stashHit === null; i++) {
      const gem = ctx.loot.createItem('gem_amber');
      const r = inv.tryAddItemAnywhere(gem);
      seen.push(r);
      if (r === 'stash') stashHit = gem.uid;
    }
    const bagFull = !inv.getGrid('bag').canAbsorb(ctx.loot.createItem('gem_amber'));
    return { first, stashHit, bagFull, stashHas: stashHit ? inv.getStashItems().some((i) => i.uid === stashHit) : false, seen: seen.filter((r) => r === 'bag').length };
  });
  ok(anywhere.first === 'bag', 'tryAddItemAnywhere → bag while there is room');
  ok(anywhere.stashHit && anywhere.bagFull && anywhere.stashHas, `bag full → 'stash' (${anywhere.seen} gems in the bag first)`, JSON.stringify(anywhere));
  const bogusAnywhere = await page.evaluate(() => window.__game.ctx.inventory.tryAddItemAnywhere({ uid: 'y', defId: 'nope_def', qty: 1, rotated: false }));
  ok(bogusAnywhere === null, 'unknown def → null');

  console.log('takeItem');
  const removedBefore = await evCount('inventory:itemRemoved');
  const take = await page.evaluate((stashUid) => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const bagGem = inv.getAllItems().find((i) => i.defId === 'gem_amber');
    const ammo = inv.getAllItems().find((i) => i.defId === 'ammo_medium' && i.qty >= 20);
    const ammoBefore = ammo?.qty ?? 0;
    const partial = ammo ? inv.takeItem(ammo.uid, 10) : -1;
    const ammoAfter = ammo ? inv.findItem(ammo.uid)?.qty ?? 0 : 0;
    const whole = bagGem ? inv.takeItem(bagGem.uid) : -1;
    const gemGone = bagGem ? inv.findItemAnywhere(bagGem.uid) === null : false;
    const stashScrap = inv.getStashItems().find((i) => i.defId === 'mat_scrap');
    const fromStash = stashScrap ? inv.takeItem(stashScrap.uid, 2) : -1;
    const stashAfter = stashScrap ? inv.findItemAnywhere(stashScrap.uid)?.qty ?? 0 : 0;
    const equipped = inv.takeItem(inv.getLoadout().primary.uid);
    const unknown = inv.takeItem('no-such-uid');
    const zero = ammo ? inv.takeItem(ammo.uid, 0) : -1;
    const stashGem = inv.takeItem(stashUid);
    const stashGemGone = inv.findItemAnywhere(stashUid) === null;
    return { partial, ammoBefore, ammoAfter, whole, gemGone, fromStash, stashAfter, equipped, unknown, zero, stashGem, stashGemGone };
  }, anywhere.stashHit);
  ok(take.partial === 10 && take.ammoAfter === take.ammoBefore - 10, 'takeItem(bag ammo, 10) removes 10 rounds', JSON.stringify(take));
  ok(take.whole === 1 && take.gemGone, 'takeItem(bag gem) removes the whole item');
  ok((await evCount('inventory:itemRemoved')) > removedBefore, 'inventory:itemRemoved for the bag item');
  ok(take.fromStash === 2 && take.stashAfter === 3 && take.stashGem === 1 && take.stashGemGone, 'takeItem from the stash (partial 5 → 3, whole gem)');
  ok(take.equipped === 0 && take.unknown === 0 && take.zero === 0, 'equipped gear / unknown uid / qty 0 refused (0)');
  const quickTake = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory;
    const stim = inv.getQuickSlots()[4];
    const n = stim ? inv.takeItem(stim.uid) : -1;
    return { n, slot: inv.getQuickSlots()[4], stims: inv.countWhere((d) => d.id === 'stim') };
  });
  ok(quickTake.n === 2 && quickTake.slot === null && quickTake.stims === 0, 'taking the quick-slotted stim stack clears wheel slot S', JSON.stringify(quickTake));
  const foundAll = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory;
    const l = inv.getLoadout();
    return { eq: inv.findItemAnywhere(l.primary.uid)?.defId, bag: inv.findItemAnywhere(inv.getAllItems()[0].uid)?.defId, none: inv.findItemAnywhere('nope') };
  });
  ok(foundAll.eq === 'wpn_ar23' && !!foundAll.bag && foundAll.none === null, 'findItemAnywhere: equipped / bag / unknown', JSON.stringify(foundAll));

  /* ── 4. inventory:containerOpened {first} ──────────────────────────── */
  console.log('containerOpened');
  await startMission(9);
  const opened = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const pos = ctx.player.position.clone();
    const out = [];
    const rec = () => { const a = window.__ev['inventory:containerOpened']; out.push(a[a.length - 1]); };
    ctx.bus.emit('crate:open', { crateId: 'crate:smoke-1', tier: 2, position: pos }); rec();
    inv.closeAll();
    ctx.bus.emit('crate:open', { crateId: 'crate:smoke-1', tier: 2, position: pos }); rec();
    inv.closeAll();
    inv.openContainerItems('corpse:smoke-1', [ctx.loot.createItem('mat_scrap', 3)], pos, '시체'); rec();
    inv.closeAll();
    inv.openContainerItems('corpse:smoke-1', [], pos); rec();
    inv.closeAll();
    return out;
  });
  ok(opened[0]?.containerId === 'crate:smoke-1' && opened[0].first === true, 'crate:open → containerOpened {first: true}', JSON.stringify(opened[0]));
  ok(opened[1]?.containerId === 'crate:smoke-1' && opened[1].first === false, 'second open of the same crate → first: false', JSON.stringify(opened[1]));
  ok(opened[2]?.containerId === 'corpse:smoke-1' && opened[2].first === true && opened[3]?.first === false, 'openContainerItems: first true, then false', JSON.stringify([opened[2], opened[3]]));

  /* ── 5. ship Tab screen: 크레딧 readout + 기업 tab ──────────────────── */
  console.log('ship screen');
  await enterHub();
  await tap('Tab');
  await waitFor(page, () => window.__game.ctx.inventory.isOpen && document.querySelector('.inv-root.is-hub'), 'ship screen open');
  await sleep(150);
  const screen = await page.evaluate(() => {
    const root = document.querySelector('.inv-root');
    const cr = root.querySelector('.inv-credits');
    const corp = [...root.querySelectorAll('.scr-tab')].find((b) => b.textContent === '기업');
    const meta = window.__game.ctx.meta;
    return {
      hidden: cr?.hidden, text: cr?.querySelector('.inv-credits-value')?.textContent, visible: cr ? cr.getBoundingClientRect().width > 0 : false,
      credits: meta ? meta.credits : null, corpDisabled: corp ? corp.disabled : null, corpOff: corp ? corp.classList.contains('is-disabled') : null,
      tabs: [...root.querySelectorAll('.scr-tab')].map((b) => b.textContent).join(' '),
    };
  });
  // Phase 8: the eyebrow already says CREDITS, so the value is the bare number (no duplicated 크레딧 label)
  const expectCredits = screen.credits === null ? '—' : `${screen.credits.toLocaleString('ko-KR')}`;
  ok(screen.hidden === false && screen.visible && screen.text === expectCredits, `크레딧 readout shows ctx.meta.credits (${screen.text})`, JSON.stringify(screen));
  ok(screen.corpDisabled === false && screen.corpOff === false && screen.tabs === '인벤토리 캐릭터 기업 함선', '기업 tab is active', JSON.stringify(screen));
  await page.evaluate(() => window.__game.ctx.bus.emit('meta:creditsChanged', { credits: 1234, delta: 734, reason: 'smoke' }));
  await sleep(50);
  const creditsText = await page.evaluate(() => document.querySelector('.inv-credits-value')?.textContent);
  // the readout reads ctx.meta.credits (the event only triggers a refresh), so a stub meta keeps its own number
  const expectAfter = await page.evaluate(() => { const m = window.__game.ctx.meta; return m ? `${m.credits.toLocaleString('ko-KR')}` : '—'; });
  ok(creditsText === expectAfter, `meta:creditsChanged refreshes the readout (${creditsText})`);
  const notifyBefore = await evCount('ui:notify');
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '기업').click());
  await sleep(150);
  const corpClick = await page.evaluate((nb) => {
    const ctx = window.__game.ctx;
    const notes = window.__ev['ui:notify'].slice(nb);
    return { invOpen: ctx.inventory.isOpen, metaOpen: !!ctx.meta?.isMenuOpen, blockers: [...ctx.uiBlockers], warned: notes.some((n) => n.kind === 'warning'), embedded: !document.querySelector('.inv-root .inv-screen')?.hidden, notes };
  }, notifyBefore);
  // Phase 8: the 기업 tab renders INSIDE the Tab screen; the window stays open and keeps its single blocker
  ok(corpClick.invOpen, '기업 tab keeps the ship screen open (embedded view)', JSON.stringify(corpClick));
  ok(!corpClick.metaOpen && !corpClick.blockers.includes('corp'), 'the standalone corp overlay and its blocker stay out of it', JSON.stringify(corpClick.blockers));
  ok(corpClick.embedded, '기업 view mounted in the Tab screen host', JSON.stringify(corpClick));
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '인벤토리').click());
  await sleep(80);
  await tap('Escape');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed');
  // the ship-only guard: the corp tab on a mission warns instead of opening
  await startMission(12);
  await tap('Tab');
  await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'bag window (mission)');
  const nb2 = await evCount('ui:notify');
  // the tab may not exist at all outside the hub — clicking is best-effort
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '기업')?.click());
  await sleep(100);
  const missionCorp = await page.evaluate((nb) => ({ open: window.__game.ctx.inventory.isOpen, creditsHidden: document.querySelector('.inv-credits').hidden, tabsHidden: !!document.querySelector('.inv-root .scr-tabs')?.hidden }), nb2);
  // Phase 8: the screen tabs only exist in the ship, so on a mission there is nothing to click and no credits readout
  ok(missionCorp.open && missionCorp.creditsHidden && missionCorp.tabsHidden, 'on a mission the screen tabs and the credits readout are hidden', JSON.stringify(missionCorp));
  await tap('Escape');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed (mission)');

  /* ── 8. Phase 10: 분대원 장비 열람 (captureCrewLoadout / createCrewLoadoutView) ── */
  console.log('crew loadout view');
  const doc = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    // a container-fresh item still carries `searched: false`; a crew card must not leak it
    const hidden = ctx.loot.createItem('mat_alloy', 2);
    hidden.searched = false;
    sys.tryAddItem(hidden);
    const d = sys.captureCrewLoadout();
    const raid = sys.captureRaidState();
    return {
      doc: d, keys: Object.keys(d).sort().join(','),
      searchedInCrew: JSON.stringify(d).includes('"searched"'), searchedInRaid: JSON.stringify(raid).includes('"searched"'),
      slots: Object.keys(d.slots).sort().join(','), bag: d.bag.length, quick: d.quick.length,
    };
  });
  ok(doc.doc && doc.doc.v === 1 && doc.keys === 'bag,quick,slots,v' && doc.bag >= 1 && doc.quick === 8,
    'captureCrewLoadout: the loadout-save shape (v / slots / bag / quick)', JSON.stringify({ keys: doc.keys, bag: doc.bag, quick: doc.quick }));
  ok(doc.searchedInCrew === false && doc.searchedInRaid === true,
    'captureCrewLoadout drops the `searched` flags (captureRaidState still keeps them)', JSON.stringify({ crew: doc.searchedInCrew, raid: doc.searchedInRaid }));

  const view = await page.evaluate((d) => {
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    const host = document.createElement('div');
    host.id = 'crew-host';
    document.body.appendChild(host);
    const blockersBefore = [...ctx.uiBlockers];
    const bad = [sys.createCrewLoadoutView(host, null), sys.createCrewLoadoutView(host, { v: 99 }), sys.createCrewLoadoutView(host, 'x')];
    // an unknown def id is skipped instead of throwing
    const withGhost = JSON.parse(JSON.stringify(d));
    withGhost.bag = [...withGhost.bag, { defId: 'no_such_item', qty: 1, rotated: false, x: 4, y: 4 }];
    const v = sys.createCrewLoadoutView(host, withGhost, { name: '대원 A', slot: 1 });
    const root = host.querySelector('.crew-loadout');
    const bagTiles = root ? root.querySelectorAll('.inv-grid-bag .inv-tile').length : -1;
    const before = JSON.stringify(sys.getGrid('bag').items().map((p) => [p.item.defId, p.item.qty, p.x, p.y]));
    // read-only: a press / context menu / double-click on a tile does nothing at all
    const tile = root?.querySelector('.inv-grid-bag .inv-tile');
    const r = tile?.getBoundingClientRect();
    if (tile && r) {
      tile.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: r.left + 4, clientY: r.top + 4, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 60, clientY: r.top + 60, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: r.left + 60, clientY: r.top + 60, bubbles: true }));
      tile.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 4, clientY: r.top + 4, bubbles: true }));
      tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
    const out = {
      bad: bad.map((b) => b === null), ok: !!v, root: !!root, name: root?.querySelector('.crew-name')?.textContent,
      slots: root ? root.querySelectorAll('.inv-slot').length : -1, bagTiles, quickCells: root ? root.querySelectorAll('.inv-quick-cell').length : -1,
      stash: root ? root.querySelectorAll('.inv-grid-stash, .inv-stash-scroll').length : -1, credits: root ? root.querySelectorAll('.inv-credits').length : -1,
      unchanged: JSON.stringify(sys.getGrid('bag').items().map((p) => [p.item.defId, p.item.qty, p.x, p.y])) === before,
      dragging: !!document.querySelector('.inv-ghost, .inv-root.is-dragging'), menu: !!document.querySelector('.inv-menu:not([hidden])'),
      blockersSame: [...ctx.uiBlockers].join() === blockersBefore.join(), locked: ctx.input.isPointerLocked,
    };
    v.refresh();
    v.dispose();
    out.afterDispose = host.childElementCount;
    host.remove();
    return out;
  }, doc.doc);
  ok(view.bad.every(Boolean) && view.ok && view.root, 'createCrewLoadoutView: a non-loadout document → null, a captured one → a `.crew-loadout` view', JSON.stringify(view.bad));
  ok(view.slots === 5 && view.bagTiles === doc.bag && view.quickCells === 8 && view.name === '대원 A',
    'the view draws 장비 (5 slots) · 가방 (the document\'s stacks, unknown defs skipped) · 빠른 사용 (8 cells)', JSON.stringify({ slots: view.slots, tiles: view.bagTiles, expect: doc.bag, cells: view.quickCells }));
  ok(view.stash === 0 && view.credits === 0, 'no 함선 창고 column and no 크레딧 pill in a crew view', JSON.stringify(view));
  ok(view.unchanged && !view.dragging && !view.menu, 'read-only: press / drag / context menu / double-click change nothing', JSON.stringify(view));
  ok(view.blockersSame && view.locked, 'EmbeddedView contract: no ui blocker, the pointer lock is untouched', JSON.stringify({ blockers: view.blockersSame, locked: view.locked }));
  ok(view.afterDispose === 0, 'dispose() empties the host');
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
