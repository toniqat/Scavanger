// Single-player smoke test for the inventory folder's Phase 7 work (2026-09-06): Tarkov-style container search
// (items hidden until searched, bottom-to-top gauge, grid-order reveal, 감정 speed multiplier, progress kept across a
// close / reopen, `모두 가져가기` takes searched items only), `canFit`, `captureRaidState` / `applyRaidState`, the profile
// document hooks (`ctx.net.profile.set` after every stash / loadout save, `net:profileLoaded` replaces the local state)
// and — synthetically, through the real `NetSystem` message handlers — the host-authoritative container take
// (client `contq take` → `cont taken` / `cont denied`, host validation + broadcast, `cont sync`).
// Usage: node scripts/smoke-search.mjs [http://localhost:5273/]   (needs a vite dev server)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default; SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
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

  const EVENTS = ['container:searchProgress', 'container:itemRevealed', 'container:searchDone', 'inventory:itemAdded', 'inventory:full',
    'inventory:stashChanged', 'loadout:changed', 'inventory:bagChanged', 'inventory:quickSlotsChanged', 'inventory:loadoutSaved', 'crate:looted',
    'ui:notify', 'audio:play'];
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
        bus.on(n, (p) => { window.__ev[n].push({ t: window.__game.ctx.time, ...JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v)) }); });
      }
    }, EVENTS);
  };
  // headless rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const evCount = (n) => page.evaluate((k) => window.__ev[k].length, n);
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
  /** Open a crate at the player's feet and return its contents in grid (search) order. */
  const openCrate = (id, tier) => page.evaluate(([cid, t]) => {
    const ctx = window.__game.ctx;
    const pos = ctx.player.position.clone();
    ctx.bus.emit('crate:open', { crateId: cid, tier: t, position: pos });
    const c = window.__game.getSystem('inventory').getActiveContainer();
    return c.grid.items().sort((a, b) => a.y - b.y || a.x - b.x).map((p) => ({ uid: p.item.uid, defId: p.item.defId, qty: p.item.qty, searched: p.item.searched, x: p.x, y: p.y }));
  }, [id, tier]);
  const containerState = () => page.evaluate(() => {
    const c = window.__game.getSystem('inventory').getActiveContainer();
    if (!c) return null;
    return { id: c.id, items: c.grid.items().sort((a, b) => a.y - b.y || a.x - b.x).map((p) => ({ uid: p.item.uid, defId: p.item.defId, qty: p.item.qty, searched: p.item.searched })), unsearched: c.unsearchedCount };
  });
  const closeWindow = async () => { await tap('Escape'); await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'closed'); };
  const snapshot = () => page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const l = sys.getLoadout();
    const slot = (it) => it ? { defId: it.defId, durability: it.durability ?? null, ammoInMag: it.ammoInMag ?? null, sockets: Object.keys(it.sockets ?? {}).sort() } : null;
    const bag = sys.getGrid('bag').items().map((p) => ({ defId: p.item.defId, qty: p.item.qty, x: p.x, y: p.y, rotated: p.item.rotated, durability: p.item.durability ?? null, searched: p.item.searched ?? null }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      slots: { primary: slot(l.primary), primary2: slot(l.primary2), secondary: slot(l.secondary), bag: slot(l.bag), armor: slot(l.armor) },
      bag, quick: sys.getQuickSlots().map((i) => i ? i.defId : null), size: sys.getBagSize(),
    };
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.removeItem('scav.loadout'); localStorage.removeItem('scav.stash'); localStorage.removeItem('scav.profile'); });
  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  await enterHub();

  /* ── 0. pure helpers through vite's module server ───────────────────── */
  console.log('helpers');
  const helpers = await page.evaluate(async () => {
    const m = await import('/src/inventory/index.ts');
    const sh = await import('/src/shared/index.ts');
    const defs = window.__game.ctx.loot;
    const common = defs.getItemDef('mat_scrap');
    const rare = defs.getAllItemDefs().find((d) => d.rarity === 'rare' && d.width * d.height >= 2) ?? defs.getItemDef('mat_scrap');
    const ser = m.serializeExtras({ uid: 'x', defId: 'mat_scrap', qty: 3, rotated: false, searched: false });
    return {
      common: m.searchTimeFor(common, 1), commonFast: m.searchTimeFor(common, 2), commonBad: m.searchTimeFor(common, 0),
      rare: m.searchTimeFor(rare, 1), rareArea: rare.width * rare.height, table: sh.SEARCH_TIME_BY_RARITY, maxDist: sh.SEARCH_MAX_DISTANCE,
      serHasSearched: 'searched' in ser,
    };
  });
  ok(Math.abs(helpers.common - helpers.table.common) < 1e-9 && Math.abs(helpers.commonFast - helpers.table.common / 2) < 1e-9 && Math.abs(helpers.commonBad - helpers.table.common) < 1e-9,
    'searchTimeFor: 1×1 common = table value, ÷ speed multiplier, invalid multiplier → 1', JSON.stringify(helpers));
  ok(Math.abs(helpers.rare - helpers.table.rare * (1 + (helpers.rareArea - 1) * 0.05)) < 1e-9, 'searchTimeFor: bulk factor 1 + (w·h − 1) × 0.05 on a multi-cell rare item');
  ok(helpers.serHasSearched === false, 'Serialize.serializeExtras never carries `searched`');

  /* ── 1. canFit (hub: bag then stash) ────────────────────────────────── */
  console.log('canFit');
  const fit = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const bag = sys.getGrid('bag');
    const free = bag.cols * bag.rows - bag.usedCells();
    const cap = bag.mergeCapacity('mat_scrap');
    const v0 = bag.version, n0 = bag.count;
    const exact = sys.canFit('mat_scrap', free * 10 + cap);
    const over = sys.canFit('mat_scrap', free * 10 + cap + 1);
    return { free, cap, exact, over, one: sys.canFit('stim', 1), zero: sys.canFit('stim', 0), unknown: sys.canFit('nope_def', 1), unchanged: bag.version === v0 && bag.count === n0, stashCount: sys.getStash().count };
  });
  ok(fit.exact === 'bag' && fit.over === 'stash' && fit.one === 'bag', 'canFit: exact bag capacity → bag, one unit more → stash (hub), unit → bag', JSON.stringify(fit));
  ok(fit.zero === null && fit.unknown === null && fit.unchanged && fit.stashCount === 0, 'canFit: qty 0 / unknown def → null; non-mutating (bag + stash untouched)', JSON.stringify(fit));

  /* ── 2. profile document hooks (spy on ctx.net.profile) ─────────────── */
  console.log('profile docs');
  await page.evaluate(() => {
    const net = window.__game.ctx.net;
    window.__profileCalls = [];
    // `profile` is a getter on NetSystem: shadow it with an own property (configurable, restored at the end of the section)
    const spy = { available: true, credits: null, get: () => undefined, set: (k, d) => window.__profileCalls.push([k, JSON.parse(JSON.stringify(d))]), flush() {}, addCredits: async () => ({ ok: false, credits: 0 }) };
    Object.defineProperty(net, 'profile', { get: () => spy, configurable: true });
  });
  await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    sys.tryAddToStash(ctx.loot.createItem('mat_scrap', 4));
    sys.tryAddItem(ctx.loot.createItem('mat_alloy', 2)); // hub change → loadout save (debounced)
  });
  await waitFor(page, () => window.__profileCalls.some((c) => c[0] === 'stash') && window.__profileCalls.some((c) => c[0] === 'loadout'), 'profile.set stash + loadout', 10000);
  const calls = await page.evaluate(() => window.__profileCalls);
  const stashCall = calls.find((c) => c[0] === 'stash'), loadoutCall = calls.find((c) => c[0] === 'loadout');
  ok(stashCall && stashCall[1].v === 2 && stashCall[1].items.some((i) => i.defId === 'mat_scrap' && i.qty === 4), 'stash save → profile.set("stash", file v2)', JSON.stringify(stashCall && stashCall[1]));
  ok(loadoutCall && loadoutCall[1].v === 1 && loadoutCall[1].bag.some((i) => i.defId === 'mat_alloy'), 'loadout save → profile.set("loadout", file v1)', JSON.stringify(loadoutCall && { v: loadoutCall[1].v, bag: loadoutCall[1].bag.length }));
  // a server record replaces the local state
  const loaded = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const sys = window.__game.getSystem('inventory');
    const before = { stashChanged: window.__ev['inventory:stashChanged'].length, loadout: window.__ev['loadout:changed'].length, saved: window.__ev['inventory:loadoutSaved'].length, calls: window.__profileCalls.length };
    const stashDoc = { v: 2, cols: 10, rows: 24, items: [{ defId: 'mat_gunpowder', qty: 7, rotated: false, x: 2, y: 3 }, { defId: 'wpn_smg37', qty: 1, rotated: false, x: 0, y: 0, durability: 55, ammoInMag: 9 }] };
    const loadoutDoc = { v: 1, slots: { primary: { defId: 'wpn_sg8', qty: 1, durability: 210, ammoInMag: 4 }, bag: { defId: 'bag_common', qty: 1 } }, bag: [{ defId: 'stim', qty: 2, rotated: false, x: 1, y: 1 }], quick: [null, null, null, null, 0, null, null, null] };
    ctx.bus.emit('net:profileLoaded', { profile: { credits: 120, docs: { stash: stashDoc, loadout: loadoutDoc }, updatedAt: Date.now() }, migrated: false });
    const stash = sys.getStash().items().map((p) => ({ defId: p.item.defId, qty: p.item.qty, x: p.x, y: p.y, durability: p.item.durability ?? null, ammoInMag: p.item.ammoInMag ?? null })).sort((a, b) => a.y - b.y || a.x - b.x);
    const l = sys.getLoadout();
    const quick = sys.getQuickSlots().map((i) => i ? i.defId : null);
    const file = JSON.parse(localStorage.getItem('scav.loadout'));
    const stashFile = JSON.parse(localStorage.getItem('scav.stash'));
    return {
      stash, primary: l.primary && { defId: l.primary.defId, durability: l.primary.durability, ammoInMag: l.primary.ammoInMag }, secondary: l.secondary, bag: sys.getGrid('bag').items().map((p) => p.item.defId), quick,
      stashChanged: window.__ev['inventory:stashChanged'].length - before.stashChanged, loadoutEv: window.__ev['loadout:changed'].length - before.loadout,
      savedProfile: window.__ev['inventory:loadoutSaved'].slice(before.saved).map((e) => e.reason), echoed: window.__profileCalls.slice(before.calls).map((c) => c[0]),
      fileSlots: Object.keys(file.slots).sort(), stashFile: stashFile.items.map((i) => i.defId).sort(),
    };
  });
  ok(loaded.stash.length === 2 && loaded.stash[0].defId === 'wpn_smg37' && loaded.stash[0].durability === 55 && loaded.stash[0].ammoInMag === 9 && loaded.stash[1].defId === 'mat_gunpowder' && loaded.stash[1].x === 2 && loaded.stash[1].y === 3,
    'net:profileLoaded: the stash document replaces the local stash (placements + durability / rounds)', JSON.stringify(loaded.stash));
  ok(loaded.stashChanged >= 1 && loaded.stashFile.join() === ['mat_gunpowder', 'wpn_smg37'].join(), 'stash replaced → inventory:stashChanged + localStorage mirror', JSON.stringify([loaded.stashChanged, loaded.stashFile]));
  ok(loaded.primary?.defId === 'wpn_sg8' && loaded.primary.durability === 210 && loaded.primary.ammoInMag === 4 && loaded.secondary === null && loaded.bag.join() === 'stim' && loaded.quick[4] === 'stim',
    'net:profileLoaded: the loadout document replaces slots / bag / quick slots', JSON.stringify({ p: loaded.primary, bag: loaded.bag, quick: loaded.quick }));
  ok(loaded.loadoutEv >= 1 && loaded.savedProfile.includes('profile') && !loaded.echoed.includes('loadout') && loaded.fileSlots.join() === 'bag,primary',
    'loadout replaced → loadout:changed, local file rewritten (reason profile) without echoing the doc back', JSON.stringify({ ev: loaded.loadoutEv, saved: loaded.savedProfile, echoed: loaded.echoed, fileSlots: loaded.fileSlots }));
  // offline edits are newer than the server copy: kept + uploaded instead of being replaced; a key the server lacks gets the local state
  const offline = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    const sys = window.__game.getSystem('inventory');
    const spy = ctx.net.profile;
    spy.available = false;
    const nb = window.__ev['inventory:loadoutSaved'].length;
    sys.tryAddItem(ctx.loot.createItem('gem_amber', 1));
    await new Promise((r) => { const t0 = performance.now(); (function poll() { if (window.__ev['inventory:loadoutSaved'].length > nb || performance.now() - t0 > 5000) r(); else setTimeout(poll, 50); })(); });
    const savedOffline = window.__ev['inventory:loadoutSaved'].length > nb;
    const callsBefore = window.__profileCalls.length;
    spy.available = true;
    const stale = { v: 1, slots: { primary: { defId: 'wpn_ar23', qty: 1 } }, bag: [], quick: [null, null, null, null, null, null, null, null] };
    ctx.bus.emit('net:profileLoaded', { profile: { credits: 1, docs: { loadout: stale }, updatedAt: Date.now() }, migrated: false });
    const calls = window.__profileCalls.slice(callsBefore);
    const up = calls.find((c) => c[0] === 'loadout');
    const gemKept = sys.getAllItems().some((i) => i.defId === 'gem_amber');
    const stashUp = calls.find((c) => c[0] === 'stash');
    return { savedOffline, gemKept, uploadedLocal: !!up && up[1].bag.some((e) => e.defId === 'gem_amber'), stashUploaded: !!stashUp, keys: calls.map((c) => c[0]) };
  });
  ok(offline.savedOffline && offline.gemKept && offline.uploadedLocal && offline.stashUploaded, 'a save made while the server was unreachable wins over the stale server doc on the next profileLoaded (uploaded, not replaced); a missing server key gets the local state', JSON.stringify(offline));
  await page.evaluate(() => { delete window.__game.ctx.net.profile; window.__game.getSystem('inventory').reset(); }); // starter kit again for the mission tests

  /* ── 3. container search on a mission ───────────────────────────────── */
  console.log('container search');
  await startMission(21);
  const c1 = await openCrate('crate:smoke-1', 3);
  ok(c1.length >= 3 && c1.every((i) => i.searched === false), `crate opens with every item unsearched (${c1.length} items)`, JSON.stringify(c1.map((i) => i.defId)));
  const tiles0 = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.inv-grid-container .inv-tile')];
    return {
      count: tiles.length, hidden: tiles.filter((t) => t.classList.contains('is-hidden-item')).length,
      leak: tiles.filter((t) => [...t.classList].some((c) => /^rarity-(common|uncommon|rare|epic|legendary)$/.test(c)) || t.querySelector('.inv-tile-sockets, .inv-tile-dur')).length,
      icons: [...new Set(tiles.map((t) => t.querySelector('.inv-tile-icon')?.textContent))], names: [...new Set(tiles.map((t) => t.querySelector('.inv-tile-name')?.textContent).filter(Boolean))],
      status: document.querySelector('.inv-search-status')?.textContent, statusHidden: document.querySelector('.inv-search-status')?.hidden,
    };
  });
  ok(tiles0.count === c1.length && tiles0.hidden === c1.length && tiles0.leak === 0 && tiles0.icons.join() === '?' && tiles0.names.every((n) => n === '???'),
    'unsearched tiles show only the footprint (`.is-hidden-item`, `?` / `???`, no rarity class / pips / bar)', JSON.stringify(tiles0));
  ok(!tiles0.statusHidden && /감정 중/.test(tiles0.status ?? ''), 'container header shows 감정 중 · n개 남음', JSON.stringify(tiles0.status));
  // unsearched items refuse every operation
  const refused = await page.evaluate((uid) => {
    const sys = window.__game.getSystem('inventory');
    const from = { kind: 'grid', grid: 'container' };
    const nb = window.__ev['inventory:itemAdded'].length;
    const r = {
      locked: sys.isItemLocked(uid, from), preview: sys.previewDrop(uid, from, { kind: 'grid', grid: 'bag', x: 0, y: 0, rotated: false }),
      drop: sys.drop(uid, from, { kind: 'grid', grid: 'bag', x: 0, y: 0, rotated: false }), quick: sys.quickMove(uid, from), activate: sys.activate(uid, from),
      rotate: sys.rotateItem(uid, 'container'), request: sys.requestItem(uid, from), dropItem: sys.dropItem(uid), equip: sys.equip(uid, 'primary'),
      added: window.__ev['inventory:itemAdded'].length - nb, still: !!sys.getActiveContainer().grid.get(uid),
    };
    // hover / context / dblclick on the tile: no tooltip, no menu
    const tile = document.querySelector(`.inv-grid-container .inv-tile[data-uid="${uid}"]`);
    const rect = tile.getBoundingClientRect();
    tile.dispatchEvent(new PointerEvent('pointerenter', { clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true }));
    r.tooltipHidden = document.querySelector('.inv-tooltip').hidden;
    tile.dispatchEvent(new MouseEvent('contextmenu', { clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true }));
    r.menu = !!document.querySelector('.inv-menu:not([hidden])');
    tile.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 40, clientY: rect.top + 40, bubbles: true }));
    r.dragging = document.querySelector('.inv-root').classList.contains('is-dragging');
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: rect.left + 40, clientY: rect.top + 40, bubbles: true }));
    tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    r.stillAfterDbl = !!sys.getActiveContainer().grid.get(uid);
    return r;
  }, c1[0].uid);
  ok(refused.locked && refused.preview === 'bad' && refused.drop === 'fail' && refused.quick === 'fail' && refused.activate === 'fail' && refused.rotate === 'fail' && !refused.request && !refused.dropItem && !refused.equip && refused.added === 0 && refused.still,
    'unsearched item: previewDrop bad, drop / quickMove / activate / rotate / equip / dropItem / requestItem refused, still in the crate', JSON.stringify(refused));
  ok(refused.tooltipHidden && !refused.menu && !refused.dragging && refused.stillAfterDbl, 'unsearched tile: no tooltip, no context menu, no drag, double-click ignored', JSON.stringify(refused));

  // the gauge fills bottom-to-top on the first item in grid order
  await waitFor(page, () => window.__ev['container:searchProgress'].length >= 2, 'searchProgress events');
  const gauge = await page.evaluate((uid) => {
    const tile = document.querySelector(`.inv-grid-container .inv-tile[data-uid="${uid}"]`);
    const scan = tile?.querySelector('.inv-tile-scan');
    const p = scan ? parseFloat(scan.style.getPropertyValue('--p')) : -1;
    const others = [...document.querySelectorAll('.inv-grid-container .inv-tile-scan')].length;
    const ev = window.__ev['container:searchProgress'];
    return { uid: ev[0].uid, containerId: ev[0].containerId, p, others, scanning: tile?.classList.contains('is-scanning'), last: ev[ev.length - 1].progress };
  }, c1[0].uid);
  ok(gauge.uid === c1[0].uid && gauge.containerId === 'crate:smoke-1' && gauge.p >= 0 && gauge.others === 1 && gauge.scanning, 'search runs on the top-left item first: one `.inv-tile-scan` gauge with --p', JSON.stringify(gauge));

  // reveal order + timing (first item = common 1×1 → 0.35 s at ×1) and the 20 Hz cap
  await waitFor(page, (n) => window.__ev['container:itemRevealed'].length >= n, 'all revealed', 60000, c1.length);
  await waitFor(page, () => window.__ev['container:searchDone'].length >= 1, 'searchDone');
  const revealed = await page.evaluate((ids) => {
    const r = window.__ev['container:itemRevealed'];
    const prog = window.__ev['container:searchProgress'];
    const span = prog[prog.length - 1].t - prog[0].t;
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    const need = (i) => { const def = window.__game.ctx.loot.getItemDef(i.defId); return (({ common: 0.35, uncommon: 0.7, rare: 1.3, epic: 2.0, legendary: 3.0 })[def.rarity]) * (1 + (def.width * def.height - 1) * 0.05); };
    let expect = 0; for (const i of ids) expect += need(i);
    return {
      order: r.map((e) => e.uid), rarities: r.map((e) => e.rarity), defs: r.map((e) => e.defId), done: window.__ev['container:searchDone'],
      firstAt: r[0].t - prog[0].t, firstNeed: need(ids[0]), total: r[r.length - 1].t - prog[0].t, expect,
      rate: prog.length / Math.max(0.001, span), allSearched: c.grid.items().every((p) => p.item.searched === true), unsearched: c.unsearchedCount,
      tilesHidden: document.querySelectorAll('.inv-grid-container .is-hidden-item').length, gauges: document.querySelectorAll('.inv-grid-container .inv-tile-scan').length,
      status: document.querySelector('.inv-search-status')?.textContent, doneTwice: window.__ev['container:searchDone'].length,
    };
  }, c1);
  ok(revealed.order.join() === c1.map((i) => i.uid).join(), 'items revealed one at a time in grid order (top-left → bottom-right)', JSON.stringify([revealed.order, c1.map((i) => i.uid)]));
  ok(revealed.defs.join() === c1.map((i) => i.defId).join() && revealed.rarities.every((r) => typeof r === 'string'), 'container:itemRevealed carries uid / defId / rarity');
  ok(Math.abs(revealed.firstAt - revealed.firstNeed) < 0.16 && Math.abs(revealed.total - revealed.expect) < 0.16 * c1.length, 'reveal timing ≈ SEARCH_TIME_BY_RARITY × bulk (per item and in total)', JSON.stringify({ firstAt: revealed.firstAt, firstNeed: revealed.firstNeed, total: revealed.total, expect: revealed.expect }));
  ok(revealed.rate <= 21, `container:searchProgress ≤ 20 Hz (${revealed.rate.toFixed(1)} Hz)`);
  ok(revealed.done.length === 1 && revealed.done[0].containerId === 'crate:smoke-1' && revealed.allSearched && revealed.unsearched === 0 && revealed.tilesHidden === 0 && revealed.gauges === 0 && revealed.status === '감정 완료',
    'container:searchDone once, every tile revealed, gauge gone, header 감정 완료', JSON.stringify({ done: revealed.done, hidden: revealed.tilesHidden, status: revealed.status }));
  await waitSim(0.3);
  const doneOnce = await evCount('container:searchDone');
  ok(doneOnce === 1, 'searchDone is not re-emitted while the window stays open');
  // a searched item can be taken and is searched in the bag
  const taken = await page.evaluate((uid) => {
    const sys = window.__game.getSystem('inventory');
    const r = sys.quickMove(uid, { kind: 'grid', grid: 'container' });
    const inBag = sys.getGrid('bag').get(uid);
    return { r, inBag: !!inBag, searched: inBag?.item.searched };
  }, c1[0].uid);
  ok(taken.r === 'ok' && taken.inBag && taken.searched === true, 'a revealed item moves to the bag (searched: true)', JSON.stringify(taken));
  await closeWindow();

  /* ── 4. take-all only takes searched items; close / reopen keeps progress ── */
  console.log('take-all gating + progress kept');
  const c2 = await openCrate('crate:smoke-2', 4);
  await waitFor(page, () => window.__ev['container:itemRevealed'].some((e) => e.containerId === 'crate:smoke-2'), 'first reveal of crate 2');
  const takeAll = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    const before = c.grid.items().map((p) => p.item);
    const bag = sys.getGrid('bag');
    const searched = before.filter((i) => i.searched === true);
    const fits = searched.filter((i) => bag.canAbsorb(i)).length;
    const unsearched = before.filter((i) => i.searched === false).map((i) => i.uid);
    const moved = sys.takeAll();
    const after = c.grid.items().map((p) => p.item.uid);
    return { searched: searched.length, fits, unsearched: unsearched.length, moved, left: after.length, unsearchedKept: unsearched.every((u) => after.includes(u)), stillUnsearched: c.unsearchedCount };
  });
  ok(takeAll.unsearched > 0 && takeAll.searched >= 1 && takeAll.moved === takeAll.fits && takeAll.left === takeAll.unsearched + (takeAll.searched - takeAll.fits) && takeAll.unsearchedKept && takeAll.stillUnsearched === takeAll.unsearched,
    '모두 가져가기 takes only the searched items; the unsearched ones stay hidden in the crate', JSON.stringify(takeAll));
  // distance rule: 5 m away (> SEARCH_MAX_DISTANCE 4, < auto-close 6) the window stays open but the search pauses
  const away = (dx) => page.evaluate((d) => {
    const ctx = window.__game.ctx;
    const c = window.__game.getSystem('inventory').containers.get('crate:smoke-2');
    const p = c.position.clone(); p.x += d;
    ctx.player.teleport(p);
    const next = c.nextToSearch();
    return { dist: ctx.player.position.distanceTo(c.position), uid: next?.item.uid, progress: next ? (c.searchProgress.get(next.item.uid) ?? 0) : -1 };
  }, dx);
  const left0 = await away(5);
  await waitSim(0.15);
  const paused0 = await page.evaluate(() => {
    const c = window.__game.getSystem('inventory').getActiveContainer();
    const next = c.nextToSearch();
    return { open: window.__game.ctx.inventory.isOpen, uid: next.item.uid, progress: c.searchProgress.get(next.item.uid) ?? 0, paused: document.querySelector('.inv-search-status')?.classList.contains('is-paused') };
  });
  await away(0);
  await waitSim(0.08);
  await away(5);
  const kept = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    const next = c.nextToSearch();
    const progress = c.searchProgress.get(next.item.uid) ?? 0;
    return { id: c.id, uid: next.item.uid, progress, unsearched: c.unsearchedCount };
  });
  const evBefore = await evCount('container:searchProgress');
  await waitSim(0.5);
  const evAfter = await evCount('container:searchProgress');
  const stillPaused = await page.evaluate((k) => { const c = window.__game.getSystem('inventory').getActiveContainer(); return { open: window.__game.ctx.inventory.isOpen, progress: c.searchProgress.get(k.uid) ?? 0, unsearched: c.unsearchedCount, paused: document.querySelector('.inv-search-status')?.classList.contains('is-paused') }; }, kept);
  ok(left0.dist > 4 && left0.dist < 6 && paused0.open && paused0.paused && paused0.uid === left0.uid && paused0.progress === left0.progress, 'out of SEARCH_MAX_DISTANCE: window stays open, readout dims, nothing accumulates', JSON.stringify({ left0, paused0 }));
  ok(kept.progress > 0 && kept.progress < 0.35 && stillPaused.paused && stillPaused.open && stillPaused.progress === kept.progress && stillPaused.unsearched === kept.unsearched && evAfter === evBefore,
    'back in range the gauge fills; stepping out again freezes the progress (no progress events)', JSON.stringify({ kept, stillPaused, evBefore, evAfter }));
  // close the window: progress + flags are kept on the container
  await closeWindow();
  await waitSim(0.4);
  const afterClose = await page.evaluate((k) => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.containers.get(k.id);
    return { progress: c.searchProgress.get(k.uid) ?? 0, unsearched: c.unsearchedCount, searchedFlags: c.grid.items().filter((p) => p.item.searched === true).length };
  }, kept);
  ok(Math.abs(afterClose.progress - kept.progress) < 1e-6 && afterClose.unsearched === kept.unsearched, 'closing the window keeps the partial progress and the unsearched count', JSON.stringify({ kept, afterClose }));
  await away(0);
  const c2b = await openCrate('crate:smoke-2', 4);
  const reopened = await page.evaluate((k) => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    return { next: c.nextToSearch()?.item.uid, progress: c.searchProgress.get(k.uid) ?? 0, unsearched: c.unsearchedCount, items: c.grid.count };
  }, kept);
  ok(c2b.length === takeAll.left && reopened.next === kept.uid && reopened.progress >= kept.progress && reopened.unsearched === kept.unsearched,
    'reopening resumes on the same item with the kept progress; nothing was re-hidden', JSON.stringify({ reopened, kept }));
  await waitFor(page, (id) => window.__ev['container:searchDone'].some((e) => e.containerId === id), 'crate 2 fully searched', 60000, 'crate:smoke-2');
  await closeWindow();
  // corpse contents (openContainerItems) are searched too
  const corpse = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    sys.openContainerItems('corpse:smoke-1', [ctx.loot.createItem('mat_scrap', 3), ctx.loot.createItem('ammo_light', 30)], ctx.player.position.clone(), '시체');
    const c = sys.getActiveContainer();
    return { id: c.id, unsearched: c.unsearchedCount, count: c.grid.count, hidden: document.querySelectorAll('.inv-grid-container .is-hidden-item').length };
  });
  ok(corpse.id === 'corpse:smoke-1' && corpse.unsearched === 2 && corpse.hidden === 2, 'openContainerItems (corpse) contents start unsearched too', JSON.stringify(corpse));
  await closeWindow();

  /* ── 5. 감정 speed multiplier ────────────────────────────────────────── */
  console.log('searchSpeedMul');
  const mul = await page.evaluate(() => { const p = window.__game.ctx.progression; p.addSkillXpRaw('appraisal', 1e9); return p.derived.searchSpeedMul; });
  ok(mul > 1.9, `maxed 감정 → derived.searchSpeedMul ${mul}`);
  const c3 = await openCrate('crate:smoke-3', 3);
  await waitFor(page, (id) => window.__ev['container:itemRevealed'].some((e) => e.containerId === id), 'crate 3 first reveal', 60000, 'crate:smoke-3');
  const fast = await page.evaluate(([id, first]) => {
    const r = window.__ev['container:itemRevealed'].find((e) => e.containerId === id);
    const p0 = window.__ev['container:searchProgress'].find((e) => e.containerId === id);
    const def = window.__game.ctx.loot.getItemDef(first.defId);
    const need = (({ common: 0.35, uncommon: 0.7, rare: 1.3, epic: 2.0, legendary: 3.0 })[def.rarity]) * (1 + (def.width * def.height - 1) * 0.05);
    return { took: r.t - p0.t, need, half: need / 2 };
  }, ['crate:smoke-3', c3[0]]);
  ok(fast.took < fast.need - 0.05 && Math.abs(fast.took - fast.half) < 0.16, 'first reveal takes ≈ half the base time with searchSpeedMul 2', JSON.stringify(fast));
  await closeWindow();
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('appraisal', -1e9));

  /* ── 6. captureRaidState / applyRaidState ───────────────────────────── */
  console.log('raid state');
  const raid = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    const l = sys.getLoadout();
    sys.updateItem(l.primary.uid, { durability: 123, ammoInMag: 5 });
    const att = ctx.loot.createItem('att_brake', 1);
    sys.tryAddItem(att);
    sys.attachToWeapon(l.primary.uid, att.uid);
    const worn = ctx.loot.createItem('wpn_smg37', 1); worn.durability = 77; worn.ammoInMag = 3;
    sys.tryAddItem(worn);
    const flagged = ctx.loot.createItem('mat_alloy', 2); flagged.searched = false; // contract: `searched` travels with the raid state
    sys.tryAddItem(flagged);
    const stims = sys.getAllItems().filter((i) => i.defId === 'stim');
    sys.setQuickSlot(2, null);
    const state = sys.captureRaidState();
    return { state, flaggedUid: flagged.uid, stimCount: stims.length, json: JSON.stringify(state).length };
  });
  const before = await snapshot();
  ok(raid.state && raid.state.v === 1 && raid.state.raid === 1 && Array.isArray(raid.state.bag) && raid.state.slots.primary?.durability === 123 && raid.state.slots.primary?.ammoInMag === 5 && raid.state.slots.primary?.sockets?.muzzle?.defId === 'att_brake',
    'captureRaidState: loadout-save shape with durability / rounds / sockets', JSON.stringify(raid.state.slots.primary));
  ok(raid.state.bag.some((e) => e.defId === 'mat_alloy' && e.searched === false) && raid.state.bag.filter((e) => e.searched === false).length === 1 && raid.state.bag.every((e) => e.searched === undefined || typeof e.searched === 'boolean'),
    'captureRaidState: `searched` mirrors the instances (false only on the flagged bag entry)', JSON.stringify(raid.state.bag.map((e) => [e.defId, e.searched])));
  const applied = await page.evaluate((state) => {
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    // wreck the inventory, then restore
    sys.reset();
    sys.tryAddItem(ctx.loot.createItem('mat_scrap', 9));
    const nb = { loadout: window.__ev['loadout:changed'].length, bag: window.__ev['inventory:bagChanged'].length, quick: window.__ev['inventory:quickSlotsChanged'].length };
    const bad1 = sys.applyRaidState(null), bad2 = sys.applyRaidState({ v: 99 }), bad3 = sys.applyRaidState('x');
    const okApply = sys.applyRaidState(state);
    return {
      bad: [bad1, bad2, bad3], okApply,
      events: { loadout: window.__ev['loadout:changed'].length - nb.loadout, bag: window.__ev['inventory:bagChanged'].length - nb.bag, quick: window.__ev['inventory:quickSlotsChanged'].length - nb.quick },
      flagged: sys.getAllItems().find((i) => i.defId === 'mat_alloy')?.searched,
    };
  }, raid.state);
  const after = await snapshot();
  ok(applied.bad.every((b) => b === false) && applied.okApply === true, 'applyRaidState: null / wrong version / string → false, a captured state → true', JSON.stringify(applied.bad));
  const diffKeys = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  ok(diffKeys.length === 0, 'applyRaidState round-trip: slots (durability / rounds / sockets), bag placements, quick slots identical', JSON.stringify(diffKeys.map((k) => [k, before[k], after[k]])));
  ok(applied.events.loadout >= 1 && applied.events.bag >= 1 && applied.events.quick >= 1 && applied.flagged === false, 'applyRaidState emits loadout:changed / inventory:bagChanged / quickSlotsChanged and restores `searched: false`', JSON.stringify(applied));

  /* ── 7. host-authoritative takes (synthetic multiplayer through the real NetSystem handlers) ── */
  console.log('container authority (synthetic)');
  await page.evaluate(() => {
    const net = window.__game.ctx.net;
    window.__sent = [];
    window.__mp = { session: true, authority: false, host: 'HOST' };
    Object.defineProperty(net, 'inSession', { get: () => window.__mp.session, configurable: true });
    Object.defineProperty(net, 'isAuthority', { get: () => window.__mp.authority, configurable: true });
    Object.defineProperty(net, 'localId', { get: () => 'ME', configurable: true });
    Object.defineProperty(net, 'lobby', { get: () => ({ hostId: window.__mp.host, code: 'SMOKE', players: [] }), configurable: true });
    net.send = (msg, to) => window.__sent.push({ msg: JSON.parse(JSON.stringify(msg)), to });
    window.__recv = (msg, from) => { for (const h of net.handlers.get(msg.t) ?? []) h(msg, from); };
  });
  const c4 = await openCrate('crate:smoke-4', 4);
  await waitFor(page, (id) => window.__ev['container:searchDone'].some((e) => e.containerId === id), 'crate 4 fully searched', 60000, 'crate:smoke-4');
  const client = await page.evaluate((first) => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    const from = { kind: 'grid', grid: 'container' };
    const idx = c.indexOf(first.uid);
    const r = sys.quickMove(first.uid, from);
    const again = sys.quickMove(first.uid, from);
    const sent = window.__sent.filter((s) => s.msg.t === 'contq');
    const pendingTile = document.querySelector(`.inv-grid-container .inv-tile[data-uid="${first.uid}"]`)?.classList.contains('is-pending');
    const intoContainer = sys.previewDrop(sys.getAllItems()[0].uid, { kind: 'grid', grid: 'bag' }, { kind: 'grid', grid: 'container', x: 5, y: 3, rotated: false });
    const split = sys.splitItem(c.grid.items().find((p) => p.item.qty >= 2)?.item.uid ?? first.uid, 1);
    return { r, again, idx, sent, pendingTile, stillThere: !!c.grid.get(first.uid), pending: [...sys.pendingTakeUids()], intoContainer, split };
  }, c4[0]);
  ok(client.r === 'pending' && client.again === 'noop' && client.sent.length === 1 && client.sent[0].to === 'host' && client.sent[0].msg.ev === 'take' && client.sent[0].msg.id === 'crate:smoke-4' && client.sent[0].msg.idx === client.idx && client.sent[0].msg.qty === c4[0].qty,
    'client: container → bag becomes `contq take {id, idx, qty}` to the host (pending, no double request)', JSON.stringify(client.sent));
  ok(client.stillThere && client.pendingTile && client.pending.includes(c4[0].uid) && client.intoContainer === 'bad' && client.split === false,
    'client: item stays until the answer (tile pulses); nothing may go into a shared container; no local splits', JSON.stringify({ still: client.stillThere, tile: client.pendingTile, into: client.intoContainer, split: client.split }));
  const denied = await page.evaluate((first) => {
    const sys = window.__game.getSystem('inventory');
    const nb = window.__ev['ui:notify'].length;
    window.__recv({ t: 'cont', ev: 'denied', id: 'crate:smoke-4', idx: sys.getActiveContainer().indexOf(first.uid) }, 'HOST');
    return { pending: [...sys.pendingTakeUids()], still: !!sys.getActiveContainer().grid.get(first.uid), shake: document.querySelector(`.inv-grid-container .inv-tile[data-uid="${first.uid}"]`)?.classList.contains('is-shake'), notify: window.__ev['ui:notify'].slice(nb).map((n) => n.text) };
  }, c4[0]);
  ok(denied.pending.length === 0 && denied.still && denied.shake && denied.notify.some((t) => /먼저 가져갔/.test(t)), 'cont denied → pending dropped, tile shakes, warning toast', JSON.stringify(denied));
  const confirmed = await page.evaluate((first) => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    const from = { kind: 'grid', grid: 'container' };
    const idx = c.indexOf(first.uid);
    const nb = window.__ev['inventory:itemAdded'].length;
    const r = sys.quickMove(first.uid, from);
    // an impostor's `cont taken` is ignored; the host's applies my take
    window.__recv({ t: 'cont', ev: 'taken', id: 'crate:smoke-4', idx, qty: first.qty, by: 'ME' }, 'IMPOSTOR');
    const ignored = !!c.grid.get(first.uid) && !sys.getGrid('bag').get(first.uid);
    window.__recv({ t: 'cont', ev: 'taken', id: 'crate:smoke-4', idx, qty: first.qty, by: 'ME' }, 'HOST');
    return { r, ignored, inBag: !!sys.getGrid('bag').get(first.uid), gone: !c.grid.get(first.uid), added: window.__ev['inventory:itemAdded'].length - nb, taken: c.taken.get(idx), pending: [...sys.pendingTakeUids()].length };
  }, c4[0]);
  ok(confirmed.r === 'pending' && confirmed.ignored && confirmed.inBag && confirmed.gone && confirmed.added === 1 && confirmed.taken === c4[0].qty && confirmed.pending === 0,
    'cont taken {by: me} from the host → the item lands in the bag (inventory:itemAdded), impostor ignored, taken map updated', JSON.stringify(confirmed));
  const remote = await page.evaluate((second) => {
    const sys = window.__game.getSystem('inventory');
    const c = sys.getActiveContainer();
    const idx = c.indexOf(second.uid);
    const nb = window.__ev['inventory:itemAdded'].length;
    window.__recv({ t: 'cont', ev: 'taken', id: 'crate:smoke-4', idx, qty: second.qty, by: 'PEER' }, 'HOST');
    // a take for a container never opened here is remembered and applied on the first open
    window.__recv({ t: 'cont', ev: 'taken', id: 'crate:smoke-5', idx: 0, qty: 1, by: 'PEER' }, 'HOST');
    const ctx = window.__game.ctx;
    const pos = ctx.player.position.clone();
    ctx.bus.emit('crate:open', { crateId: 'crate:smoke-5', tier: 2, position: pos });
    const c5 = sys.getActiveContainer();
    const first5 = c5.uidAt(0);
    return { gone: !c.grid.get(second.uid), added: window.__ev['inventory:itemAdded'].length - nb, tile: !!document.querySelector(`.inv-grid-container .inv-tile[data-uid="${second.uid}"]`), c5id: c5.id, c5order: c5.order.length, c5firstGone: !c5.grid.get(first5) || c5.grid.get(first5).item.qty === 0 || c5.taken.get(0) === 1, c5taken: c5.taken.get(0) };
  }, c4[1]);
  ok(remote.gone && remote.added === 0 && !remote.tile, 'cont taken {by: someone else} removes the item from my copy (no itemAdded)', JSON.stringify(remote));
  ok(remote.c5id === 'crate:smoke-5' && remote.c5order > 0 && remote.c5taken === 1 && remote.c5firstGone, 'a take recorded before the first open is applied when the crate is opened', JSON.stringify(remote));
  const synced = await page.evaluate(() => {
    const sys = window.__game.getSystem('inventory');
    const c5 = sys.getActiveContainer();
    let idx1 = 1;
    while (idx1 < c5.order.length && c5.remainingAt(idx1) === 0) idx1++;
    const uid1 = c5.uidAt(idx1);
    const qty1 = c5.remainingAt(idx1);
    window.__sent.length = 0;
    window.__game.ctx.bus.emit('net:hostChanged', { hostId: 'HOST2', prev: 'HOST', isLocalHost: false });
    const syncReq = window.__sent.find((s) => s.msg.t === 'contq' && s.msg.ev === 'sync');
    window.__mp.host = 'HOST2';
    window.__recv({ t: 'cont', ev: 'sync', items: [{ id: 'crate:smoke-5', t: [[0, 1], [idx1, qty1]] }, { id: 'crate:smoke-6', t: [[2, 1]] }] }, 'HOST2');
    return { syncReq: syncReq && syncReq.to, idx1, uid1Gone: !c5.grid.get(uid1), taken1: c5.taken.get(idx1), qty1, pending6: sys.containers.pendingTakenOf('crate:smoke-6', 2) };
  });
  ok(synced.syncReq === 'host' && synced.qty1 > 0 && synced.uid1Gone && synced.taken1 === synced.qty1 && synced.pending6 === 1, 'net:hostChanged (not me) → `contq sync`; `cont sync` catches up opened + unopened containers', JSON.stringify(synced));
  await closeWindow();
  // host side: own takes broadcast, peer requests validated
  const host = await page.evaluate(() => {
    window.__mp.authority = true; window.__mp.host = 'ME';
    const sys = window.__game.getSystem('inventory');
    const ctx = window.__game.ctx;
    ctx.bus.emit('crate:open', { crateId: 'crate:smoke-7', tier: 3, position: ctx.player.position.clone() });
    const c = sys.getActiveContainer();
    for (const p of c.grid.items()) p.item.searched = true; // skip the search for the authority test
    const bag = sys.getGrid('bag');
    const items = c.grid.items().sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.item).sort((a, b) => (bag.canAbsorb(b) ? 1 : 0) - (bag.canAbsorb(a) ? 1 : 0));
    window.__sent.length = 0;
    const r = sys.quickMove(items[0].uid, { kind: 'grid', grid: 'container' });
    const own = window.__sent.find((s) => s.msg.t === 'cont');
    const idx1 = c.indexOf(items[1].uid), q1 = items[1].qty;
    window.__sent.length = 0;
    window.__recv({ t: 'contq', ev: 'take', id: 'crate:smoke-7', idx: idx1, qty: q1, from: 'PEER' }, 'PEER');
    const granted = window.__sent[0];
    window.__sent.length = 0;
    window.__recv({ t: 'contq', ev: 'take', id: 'crate:smoke-7', idx: idx1, qty: 1 }, 'PEER2');
    const refused = window.__sent[0];
    window.__sent.length = 0;
    window.__recv({ t: 'contq', ev: 'sync' }, 'PEER2');
    const sync = window.__sent[0];
    window.__sent.length = 0;
    window.__recv({ t: 'contq', ev: 'take', id: 'crate:never-opened', idx: 3, qty: 1 }, 'PEER');
    const unknownFirst = window.__sent[0];
    window.__recv({ t: 'contq', ev: 'take', id: 'crate:never-opened', idx: 3, qty: 1 }, 'PEER2');
    const unknownSecond = window.__sent[1];
    window.__sent.length = 0;
    window.__recv({ t: 'flow', ev: 'rejoined' }, 'PEER3');
    const rejoinSync = window.__sent[0];
    return {
      r, own: own && { to: own.to, ev: own.msg.ev, id: own.msg.id, by: own.msg.by, qty: own.msg.qty, idx: own.msg.idx }, idx0: c.indexOf(items[0].uid), qty0: items[0].qty,
      granted: granted && { to: granted.to, ev: granted.msg.ev, by: granted.msg.by, qty: granted.msg.qty }, item1Gone: !c.grid.get(items[1].uid),
      refused: refused && { to: refused.to, ev: refused.msg.ev, idx: refused.msg.idx },
      sync: sync && { to: sync.to, ev: sync.msg.ev, entry: sync.msg.items.find((i) => i.id === 'crate:smoke-7')?.t },
      unknownFirst: unknownFirst && unknownFirst.msg.ev, unknownSecond: unknownSecond && unknownSecond.msg.ev,
      rejoinSync: rejoinSync && { to: rejoinSync.to, ev: rejoinSync.msg.ev },
    };
  });
  ok(host.r === 'ok' && host.own && host.own.to === 'others' && host.own.ev === 'taken' && host.own.id === 'crate:smoke-7' && host.own.by === 'ME' && host.own.idx === host.idx0 && host.own.qty === host.qty0,
    'host: its own take applies immediately and broadcasts `cont taken` to others', JSON.stringify({ r: host.r, own: host.own }));
  ok(host.granted && host.granted.to === 'others' && host.granted.ev === 'taken' && host.granted.by === 'PEER' && host.item1Gone && host.refused && host.refused.to === 'PEER2' && host.refused.ev === 'denied',
    'host: a valid `contq take` is applied to its copy + broadcast; a second take of the same item is denied to the requester', JSON.stringify({ granted: host.granted, refused: host.refused }));
  ok(host.sync && host.sync.to === 'PEER2' && host.sync.ev === 'sync' && Array.isArray(host.sync.entry) && host.sync.entry.length === 2, '`contq sync` → `cont sync` with the taken map to the requester', JSON.stringify(host.sync));
  ok(host.unknownFirst === 'taken' && host.unknownSecond === 'denied' && host.rejoinSync && host.rejoinSync.to === 'PEER3' && host.rejoinSync.ev === 'sync',
    'host: a container it never rolled grants the first take of an idx only; `flow rejoined` → `cont sync` to that peer', JSON.stringify({ first: host.unknownFirst, second: host.unknownSecond, rejoin: host.rejoinSync }));
  await closeWindow();
  await page.evaluate(() => { const net = window.__game.ctx.net; for (const k of ['inSession', 'isAuthority', 'localId', 'lobby']) delete net[k]; });
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
