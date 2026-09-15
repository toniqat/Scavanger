// Single-player smoke for the **raid hooks the android squadmates hang on** (2026-09-15, agent A6):
// `InventoryRef.createAllyBag` / `weightInfoFor` / `takeContainerItemFor`, `inventory:itemRequested` ·
// `inventory:containerViewed` · `inventory:allyDeposit` → `ally:deposited`, `PickupsRef.takeBy`,
// `ExtractionRef.getPads` / `requestActivate` / `boardingPoint`, `WorldRef.getLootContainers`,
// `HazardRef.nearestSafePoint` for every zone shape.
// Nothing here needs `ctx.allies` — every hook is called straight through `window.__game.ctx`, so this script
// stands on its own while allies/ is being written.
// Usage: node scripts/smoke-ally-hooks.mjs [http://localhost:5273/]   (needs a vite dev server)
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['inventory:itemRequested', 'inventory:containerViewed', 'ally:deposited', 'pickup:taken',
    'container:itemTaken', 'chat:post', 'extraction:activated'];
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
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const lastEv = async (n) => page.evaluate((k) => window.__ev[k][window.__ev[k].length - 1] ?? null, n);

  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);

  /* ── 1. ally bag (`createAllyBag`) ─────────────────────────────────── */
  console.log('ally bag');
  const bagR = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    if (typeof inv.createAllyBag !== 'function') return { missing: true };
    const bag = inv.createAllyBag(5, 6);
    const ar = ctx.loot.createItem('wpn_ar');
    const ammo1 = ctx.loot.createItem('ammo_medium', 10);
    const ammo2 = ctx.loot.createItem('ammo_medium', 5);
    const placedAr = bag.autoPlace(ar);
    const placedA1 = bag.autoPlace(ammo1);
    const placedA2 = bag.autoPlace(ammo2);
    const merged = bag.items().filter((i) => i.defId === 'ammo_medium').reduce((s, i) => s + i.qty, 0);
    const value = bag.totalValue();
    const used = bag.usedCells();
    const removed = bag.remove(ar.uid);
    const afterRemove = bag.items().length;
    // 5×6 → 2×2: the rifle no longer fits, so `resize` hands it back
    bag.autoPlace(removed);
    const overflow = bag.resize(2, 2).map((i) => i.defId);
    const size = { cols: bag.cols, rows: bag.rows };
    bag.clear();
    return { placedAr, placedA1, placedA2, merged, value, used, removedId: removed?.defId ?? null, afterRemove, overflow, size, empty: bag.items().length };
  });
  ok(!bagR.missing, 'InventoryRef.createAllyBag exists');
  ok(bagR.placedAr && bagR.placedA1 && bagR.placedA2, 'autoPlace puts a rifle and two ammo stacks in', JSON.stringify(bagR));
  ok(bagR.merged === 15, 'the second ammo stack merged into the first (same stack rules as the player bag)', String(bagR.merged));
  ok(bagR.used > 0 && bagR.value > 0, 'usedCells / totalValue read the grid', JSON.stringify({ used: bagR.used, value: bagR.value }));
  ok(bagR.removedId === 'wpn_ar' && bagR.afterRemove === 1, 'remove(uid) hands the instance back', JSON.stringify(bagR));
  ok(bagR.size.cols === 2 && bagR.size.rows === 2 && bagR.overflow.includes('wpn_ar'), 'resize returns what no longer fits', JSON.stringify(bagR));
  ok(bagR.empty === 0, 'clear() empties the grid');

  /* ── 2. weight (`weightInfoFor`) ───────────────────────────────────── */
  console.log('ally weight');
  const wR = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    if (typeof inv.weightInfoFor !== 'function') return { missing: true };
    const bag = ctx.loot.createItem('bag_common');
    const light = inv.weightInfoFor([], null);
    const withBag = inv.weightInfoFor([], bag);
    const load = [];
    for (let i = 0; i < 40; i++) load.push(ctx.loot.createItem('mat_scrap', 20));
    const heavy = inv.weightInfoFor(load, bag);
    return {
      missing: false,
      zero: light.weight, cap: light.capacity, capBag: withBag.capacity,
      state0: light.state, heavyW: heavy.weight, heavyState: heavy.state, moveMul: heavy.moveMul,
      ratio: heavy.ratio,
    };
  });
  ok(!wR.missing, 'InventoryRef.weightInfoFor exists');
  ok(wR.zero === 0 && wR.state0 === 'normal' && wR.cap > 0, 'empty → 0 kg, 가벼움, a positive capacity', JSON.stringify(wR));
  ok(wR.capBag >= wR.cap, 'the equipped bag never lowers the capacity (bagCapacityBonus)', JSON.stringify(wR));
  ok(wR.heavyW > 0 && (wR.heavyState === 'heavy' || wR.heavyState === 'over') && wR.ratio > 1 === (wR.heavyState === 'over'),
    'a big load reports 무거움 / 과적 with the player formula', JSON.stringify(wR));

  /* ── 3. raid: loot containers · peek == take · taken state ─────────── */
  console.log('raid: loot containers');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 4242 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 60000);
  await waitFor(page, () => window.__game.ctx.player && !window.__game.ctx.player.isDropping, 'hellpod exit', 40000);
  await waitSim(0.5);

  const lootR = await page.evaluate(() => {
    const w = window.__game.ctx.world;
    if (typeof w.getLootContainers !== 'function') return { missing: true };
    const list = w.getLootContainers();
    const crateIds = new Set(w.getCrates().map((c) => c.id));
    const again = w.getLootContainers();
    return {
      missing: false,
      n: list.length,
      reused: again === list,
      kinds: [...new Set(list.map((c) => c.kind))].sort(),
      allCratesListed: [...crateIds].every((id) => list.some((c) => c.id === id && c.kind === 'crate')),
      anyStructure: list.some((c) => c.kind === 'structure'),
      shape: list[0] ? { id: typeof list[0].id, tier: typeof list[0].tier, opened: typeof list[0].opened, pos: !!list[0].position && typeof list[0].position.x === 'number' } : null,
      openedNone: list.filter((c) => c.opened).length,
    };
  });
  ok(!lootR.missing, 'WorldRef.getLootContainers exists');
  ok(lootR.n > 0 && lootR.allCratesListed, 'every world crate is listed with kind crate', JSON.stringify(lootR));
  ok(lootR.reused, 'the array is reused between calls (no per-call allocation)');
  ok(lootR.shape && lootR.shape.id === 'string' && lootR.shape.tier === 'number' && lootR.shape.opened === 'boolean' && lootR.shape.pos,
    'entries carry id / position / tier / opened / kind', JSON.stringify(lootR.shape));
  ok(lootR.openedNone === 0, 'nothing is opened at the start of the raid', String(lootR.openedNone));

  console.log('container peek == take');
  const takeR = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, w = ctx.world;
    if (typeof inv.takeContainerItemFor !== 'function') return { missing: true };
    const target = w.getLootContainers().find((c) => c.kind === 'crate' && !c.opened);
    if (!target) return { noCrate: true };
    const id = target.id, tier = target.tier;
    const peek = (inv.peekContainerItems(id, tier) ?? []).map((i) => ({ defId: i.defId, qty: i.qty }));
    if (peek.length === 0) return { empty: true, id };
    const defId = peek[0].defId;
    const before = peek.filter((p) => p.defId === defId).length;
    const took = inv.takeContainerItemFor(id, tier, defId, 'android:local:0');
    const after = (inv.peekContainerItems(id, tier) ?? []).map((i) => ({ defId: i.defId, qty: i.qty }));
    const afterN = after.filter((p) => p.defId === defId).length;
    const listed = w.getLootContainers().find((c) => c.id === id);
    const missing = inv.takeContainerItemFor(id, tier, 'no_such_def', 'android:local:0');
    return {
      missing: false, id, peekN: peek.length, took: took ? { defId: took.defId, qty: took.qty, raidFound: took.raidFound ?? null } : null,
      firstDef: defId, before, afterN, afterTotal: after.length, opened: listed ? listed.opened : null, unknownDef: missing,
    };
  });
  ok(!takeR.missing, 'InventoryRef.takeContainerItemFor exists');
  ok(!takeR.noCrate && !takeR.empty, 'a rolled crate with contents was found', JSON.stringify(takeR));
  ok(takeR.took && takeR.took.defId === takeR.firstDef, 'the take returns the first stack the peek showed', JSON.stringify(takeR));
  ok(takeR.afterN === takeR.before - 1 && takeR.afterTotal === takeR.peekN - 1, 'the peek after the take is the same list minus that stack', JSON.stringify(takeR));
  ok(takeR.opened === true, 'the container is marked opened in getLootContainers (crate opened sync)', String(takeR.opened));
  ok(takeR.unknownDef === null, 'an unknown defId takes nothing');
  const takenEv = await lastEv('container:itemTaken');
  ok(takenEv && takenEv.containerId === takeR.id && takenEv.by === 'android:local:0' && takenEv.byLocal === false && takenEv.live === true,
    'container:itemTaken names the android (byLocal false, live)', JSON.stringify(takenEv));

  /* ── 4. item requests ──────────────────────────────────────────────── */
  console.log('item requests');
  const reqR = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const out = {};
    const l = inv.getLoadout();
    if (l.primary) { inv.requestItem(l.primary.uid, { kind: 'slot', slot: 'primary' }); out.ammo = window.__ev['inventory:itemRequested'].slice(-1)[0]; }
    if (l.armor) {
      const p = ctx.player;
      if (p && p.maxShield > 0) p.takeDamage(1);
      inv.requestItem(l.armor.uid, { kind: 'slot', slot: 'armor' });
      out.armor = window.__ev['inventory:itemRequested'].slice(-1)[0];
      out.shieldFull = p ? p.shield >= p.maxShield : true;
    }
    // straight into the bag grid: `tryAddItem` would auto-seat a consumable on the wheel (parts/AutoQuick)
    const stim = ctx.loot.createItem('heal_bandage');
    if (inv.getGrid('bag').autoPlace(stim)) { inv.requestItem(stim.uid, { kind: 'grid', grid: 'bag' }); out.heal = window.__ev['inventory:itemRequested'].slice(-1)[0]; }
    const scrap = ctx.loot.createItem('mat_scrap', 2);
    if (inv.getGrid('bag').autoPlace(scrap)) { inv.requestItem(scrap.uid, { kind: 'grid', grid: 'bag' }); out.item = window.__ev['inventory:itemRequested'].slice(-1)[0]; }
    out.chat = window.__ev['chat:post'].slice(-1)[0];
    return out;
  });
  ok(reqR.ammo && reqR.ammo.kind === 'ammo' && typeof reqR.ammo.ammoType === 'string' && reqR.ammo.ammoType.length > 0,
    'the equipped primary → kind ammo with the calibre', JSON.stringify(reqR.ammo));
  ok(reqR.ammo && Array.isArray(reqR.ammo.position) && reqR.ammo.position.length === 3, 'the request carries the requester position', JSON.stringify(reqR.ammo && reqR.ammo.position));
  ok(!reqR.armor || reqR.shieldFull || reqR.armor.kind === 'shield', 'the equipped armor with a dented shield → kind shield', JSON.stringify(reqR.armor));
  ok(reqR.heal && reqR.heal.kind === 'heal' && reqR.heal.defId === 'heal_bandage', 'a stim → kind heal', JSON.stringify(reqR.heal));
  ok(reqR.item && reqR.item.kind === 'item' && reqR.item.defId === 'mat_scrap' && reqR.item.ammoType === null, 'anything else → kind item', JSON.stringify(reqR.item));
  ok(reqR.chat && typeof reqR.chat.text === 'string', 'the old chat line is still posted', JSON.stringify(reqR.chat));

  /* ── 5. container window → inventory:containerViewed ───────────────── */
  console.log('container viewed');
  const viewR = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const target = ctx.world.getLootContainers().find((c) => c.kind === 'crate');
    if (!target) return { noCrate: true };
    const before = window.__ev['inventory:containerViewed'].length;
    ctx.bus.emit('crate:open', { crateId: target.id, tier: target.tier, position: target.position });
    const ev = window.__ev['inventory:containerViewed'].slice(before);
    inv.closeAll();
    return { id: target.id, n: ev.length, last: ev[ev.length - 1] ?? null };
  });
  ok(!viewR.noCrate && viewR.n === 1 && viewR.last && viewR.last.containerId === viewR.id,
    'opening a container window emits inventory:containerViewed once', JSON.stringify(viewR));

  /* ── 6. pickups.takeBy ─────────────────────────────────────────────── */
  console.log('pickups.takeBy');
  const pickR = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    if (typeof ctx.pickups.takeBy !== 'function') return { missing: true };
    const item = ctx.loot.createItem('mat_scrap', 3);
    const p = ctx.player.position.clone();
    const id = ctx.pickups.spawn(item, p);
    const before = ctx.pickups.getPickups().length;
    const took = ctx.pickups.takeBy(id, 'android:local:0');
    const after = ctx.pickups.getPickups().length;
    const again = ctx.pickups.takeBy(id, 'android:local:0');
    return { missing: false, id, before, after, took: took ? { defId: took.defId, qty: took.qty } : null, again };
  });
  ok(!pickR.missing, 'PickupsRef.takeBy exists');
  ok(pickR.took && pickR.took.defId === 'mat_scrap' && pickR.after === pickR.before - 1, 'takeBy removes the pickup and returns the item', JSON.stringify(pickR));
  ok(pickR.again === null, 'a second takeBy of the same id takes nothing');
  const takenPk = await lastEv('pickup:taken');
  ok(takenPk && takenPk.id === pickR.id && takenPk.byLocal === false, 'pickup:taken reports it as somebody else\'s take', JSON.stringify(takenPk));

  /* ── 7. extraction pads ────────────────────────────────────────────── */
  console.log('extraction hooks');
  const padR = await page.evaluate(() => {
    const ex = window.__game.ctx.extraction;
    if (typeof ex.getPads !== 'function' || typeof ex.requestActivate !== 'function' || typeof ex.boardingPoint !== 'function') return { missing: true };
    const V = window.__game.ctx.player.position.constructor;
    const pads = ex.getPads();
    const reused = ex.getPads() === pads;
    const shape = pads[0] ? { id: typeof pads[0].id, pos: typeof pads[0].position.x === 'number' } : null;
    const beforeLanded = ex.boardingPoint(new V());
    const unknown = ex.requestActivate('no_such_pad');
    const first = pads[0] ? ex.requestActivate(pads[0].id) : false;
    const second = pads[0] ? ex.requestActivate(pads[0].id) : false;
    return { missing: false, n: pads.length, reused, shape, beforeLanded, unknown, first, second, stage: ex.stage };
  });
  ok(!padR.missing, 'ExtractionRef.getPads / requestActivate / boardingPoint exist');
  ok(padR.n > 0 && padR.shape && padR.shape.id === 'string' && padR.shape.pos, 'getPads lists the pads with a standing point', JSON.stringify(padR));
  ok(padR.reused, 'the pad array is reused between calls');
  ok(padR.beforeLanded === null, 'boardingPoint is null while no ship is on the pad');
  ok(padR.unknown === false, 'an unknown pad id is refused');
  ok(padR.first === true && padR.second === false && padR.stage === 'countdown',
    'the first requestActivate starts the countdown, a second one is refused', JSON.stringify(padR));
  const actEv = await lastEv('extraction:activated');
  ok(!!actEv, 'the android press runs the same flow as a console press (extraction:activated)', JSON.stringify(actEv));

  /* ── 8. hazard: nearestSafePoint for every zone shape ──────────────── */
  console.log('hazard nearestSafePoint');
  const hzR = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const w = window.__game.getSystem('world');
    const hz = w.hazardSys;
    if (!hz || typeof hz.nearestSafePoint !== 'function') return { missing: true };
    const V = ctx.player.position.constructor;
    const saved = hz.debugPlan ? JSON.parse(JSON.stringify(hz.debugPlan)) : null;
    const t = ctx.missionTime;
    const out = new V();
    const base = { kind: 'sandstorm', startsAt: 0, dirX: 1, dirZ: 0, eyeX: 0, eyeZ: 0, sources: [], sourceRadius: 0 };
    const set = (plan) => { hz.plan = plan; hz.zonesAt = -1; };
    const run = (plan, x, z, margin) => {
      set(plan);
      const r = hz.nearestSafePoint(x, z, margin, out);
      return r ? { x: r.x, z: r.z, inside: hz.isInside(r.x, r.z), moved: Math.hypot(r.x - x, r.z - z) } : null;
    };
    const res = {};
    /* ① front (모래 폭풍) — the danger side is behind the line. `HAZARD_FULL_S` is not exposed, so the sweep speed is
     * measured from two samples and the plan is then aimed at progress 0.5 (the line crosses the map centre). */
    const lineAt = (startsAt) => { set({ ...base, startsAt, dirX: 1, dirZ: 0 }); const z0 = hz.getZones()[0]; return z0 ? z0.center.x : NaN; };
    const c0 = lineAt(t);
    const c60 = lineAt(t - 60);
    const span = -c0;
    const per60 = (c60 - c0) / (2 * span);
    const front = { ...base, startsAt: t - 60 * (0.5 / per60), dirX: 1, dirZ: 0 };
    res.lineX = lineAt(front.startsAt);
    res.front = run(front, res.lineX - 60, 0, 3);
    res.frontSafeAlready = run(front, res.lineX + 60, 0, 3);
    // ② circle, safe inside (폭풍의 눈) — fully shrunk (progress 1), so a point outside is pulled INTO the circle
    // progress 0.75: the eye has shrunk well inside the map but has not closed (`STORM_EYE_RADIUS_END` may be 0)
    const eye = { ...base, kind: 'storm_eye', startsAt: t - 60 * (0.75 / per60), dirX: 0, dirZ: 0, eyeX: 0, eyeZ: 0 };
    res.eye = run(eye, 0, 0, 3);       // the eye centre is safe already
    set(eye);
    const eyeZone = hz.getZones()[0];
    res.eyeRadius = eyeZone ? eyeZone.radius : -1;
    res.eyeOutside = eyeZone ? run(eye, eyeZone.radius + 50, 0, 3) : null;
    // ③ circles, danger inside (독성 포자) — two overlapping blooms
    const spores = {
      ...base, kind: 'spores', startsAt: t - 1,
      sources: [{ x: 0, z: 0, eruptAt: t - 100, growthMps: 5 }, { x: 40, z: 0, eruptAt: t - 100, growthMps: 5 }],
      sourceRadius: 60,
    };
    res.spores = run(spores, 20, 0, 4);
    // ④ nothing is safe any more (the front has swept the whole map)
    res.covered = run({ ...base, startsAt: t - 100000, dirX: 1, dirZ: 0 }, 0, 0, 3);
    hz.plan = saved;
    hz.zonesAt = -1;
    return { missing: false, res, restored: !!hz.debugPlan === !!saved };
  });
  ok(!hzR.missing, 'HazardRef.nearestSafePoint exists');
  const H = hzR.res ?? {};
  ok(H.front && H.front.inside === false && H.front.x > H.lineX, 'front: the answer is past the line and outside the danger', JSON.stringify(H.front));
  ok(H.frontSafeAlready && H.frontSafeAlready.moved < 0.001, 'a point that is already safe answers itself', JSON.stringify(H.frontSafeAlready));
  ok(H.eye && H.eye.moved < 0.001 && H.eye.inside === false, 'storm eye: the centre is safe already', JSON.stringify(H.eye));
  ok(H.eyeOutside && H.eyeOutside.inside === false && Math.hypot(H.eyeOutside.x, H.eyeOutside.z) < H.eyeRadius,
    'storm eye: a point outside is pulled INTO the circle', JSON.stringify({ r: H.eyeRadius, p: H.eyeOutside }));
  ok(H.spores && H.spores.inside === false && H.spores.moved > 0, 'spores: the answer leaves both overlapping blooms', JSON.stringify(H.spores));
  ok(H.covered === null, 'a fully covered map answers null', JSON.stringify(H.covered));
  ok(hzR.restored !== false, 'the original hazard plan is put back');

  /* ── 9. stash deposit (`inventory:allyDeposit`) ────────────────────── */
  console.log('ally deposit');
  const depR = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const before = inv.getStashItems().length;
    const items = [ctx.loot.createItem('mat_scrap', 4), ctx.loot.createItem('gem_amber', 1)];
    ctx.bus.emit('inventory:allyDeposit', { id: 'android:local:0', name: '안드로이드 알파', items });
    const ev = window.__ev['ally:deposited'].slice(-1)[0] ?? null;
    const after = inv.getStashItems();
    return { before, after: after.length, ev, hasGem: after.some((i) => i.defId === 'gem_amber') };
  });
  ok(depR.ev && depR.ev.id === 'android:local:0' && depR.ev.count === 2 && depR.ev.lost === 0,
    'inventory:allyDeposit stores both items and reports ally:deposited {count 2, lost 0}', JSON.stringify(depR.ev));
  ok(depR.hasGem && depR.after >= depR.before + 1, 'the loot really landed in the 함선 창고', JSON.stringify(depR));

  const hard = errors.filter((e) => !/favicon|WebGL|GroupMarker|Automatic fallback/i.test(e));
  ok(hard.length === 0, 'no page errors', hard.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e && e.message ? e.message : e}`);
  for (const err of errors.slice(0, 8)) console.log(`       page error: ${err}`);
} finally {
  await browser.close();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
