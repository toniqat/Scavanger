// Single-player smoke test for ship housing (src/housing): state load, room purposes, furniture placement rules,
// facility upgrades + generator gating, stash size, furniture craft / upgrade, presets, persistence across a reload,
// and the three DOM panels (blocker + Esc). Drives `ctx.housing` from page.evaluate.
// Phase 7 (2026-09-06): `furn_sim_hub` (15th def, 사격장 only) crafted / placed / listed in the room menu; server profile
// document `ship` (save → `profile.set`, `net:profileLoaded` replace + `housing:loaded` re-emit, stash size follows).
// Phase 9: v3 fresh state (`books` / `bookDex`), `furn_bookshelf` in the 서재 catalogue, offline `profile.set`. The 서재
// mechanics themselves are covered by scripts/smoke-library.mjs.
// Usage: node scripts/smoke-housing.mjs [http://localhost:5273]   (needs `npm run dev`)
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
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket (another agent's save would full-reload the page) AND the relay socket (`/ws?t=`): this is a
    // single-player script — a relay that happens to run on 8787 would otherwise hand the page a server profile and
    // make credits / documents server-owned mid-run. `ctx.net.profile.available` stays false, as documented.
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
  // The hub's `ensureConnected` dials the relay through the vite proxy; without `npm run server` Chrome logs one
  // "WebSocket connection … failed" line. That is the relay's absence, not a housing signal — ignore only that line.
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

  // Runs after every navigation: frame pump for a hidden tab, fake pointer lock, event recorder.
  const setup = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing, 'boot');
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['housing:loaded', 'housing:changed', 'housing:modeChanged', 'housing:selectionChanged', 'housing:roomPurposeChanged',
        'housing:furniturePlaced', 'housing:furnitureMoved', 'housing:furnitureRecovered', 'housing:furnitureUpgraded', 'housing:facilityUpgraded',
        'housing:stashSizeChanged', 'housing:presetApplied', 'ui:housingToggled', 'housing:shipManageChanged']) {
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
  const count = (defId) => H((d) => (typeof window.__game.ctx.inventory.countDefAll === 'function' ? window.__game.ctx.inventory.countDefAll(d) : -1), defId);

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  // fresh ship + stash so the run is deterministic, then reload so the housing system boots from the fresh state
  await page.evaluate(() => { localStorage.removeItem('scav.ship'); localStorage.removeItem('scav.stash'); });
  await page.reload({ waitUntil: 'load' });
  await setup();
  // 2026-09-07: a fresh stash is granted the 기본 지급품 — empty it again so the material counts below are exact
  await page.evaluate(() => { const st = window.__game.getSystem('inventory').getStash(); for (const p of st.items()) st.remove(p.item.uid); });

  console.log('fresh state');
  const st0 = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  // Phase 8 UI pass: room 1 is the ship's permanent 작업실 and ships with its two benches already placed
  ok(st0.rooms.length === 10 && st0.rooms[0].purpose === 'workshop' && st0.rooms[0].level === 1
    && st0.rooms.slice(1).every((r) => r.purpose === 'empty' && r.level === 0), 'fresh state: room 1 = 작업실, the other nine empty');
  ok(st0.generatorLevel === 0 && st0.storageLevel === 0 && st0.presets.length === 0 && st0.furnitureStorage.length === 0, 'fresh state: gen 0 / storage 0 / no presets / empty furniture storage');
  const startIds = st0.furniture.map((e) => e.defId).sort().join(',');
  ok(st0.furniture.length === 2 && startIds === 'furn_bench_gun,furn_repair_bench' && st0.furniture.every((e) => e.room === 0), `first run: 총기 작업대 + 정비 벤치 placed in 방 1 (${startIds})`);
  const stash0 = await H(() => window.__game.ctx.housing.getStashSize());
  ok(stash0.cols === 10 && stash0.rows === 24, `getStashSize() 10×24 at storage 0 (${stash0.cols}×${stash0.rows})`);
  // Phase 8 added furn_repair_bench (작업실) and furn_grow_rack (온실); Phase 9 furn_bookshelf (서재)
  ok(await H(() => window.__game.ctx.housing.getAllFurnitureDefs().length === 18), 'FURNITURE_DEFS exposed (18, incl. furn_sim_hub / repair_bench / grow_rack / bookshelf)');
  ok(st0.version === 3 && Array.isArray(st0.books) && st0.books.length === 0 && Array.isArray(st0.bookDex) && st0.bookDex.length === 0, `fresh state is v3 with empty books / bookDex (v${st0.version})`);
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('library').some((d) => d.id === 'furn_bookshelf' && d.interaction === 'bookshelf') && !window.__game.ctx.housing.getFurnitureFor('workshop').some((d) => d.id === 'furn_bookshelf')), 'furn_bookshelf in the 서재 catalogue only');
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('range').some((d) => d.id === 'furn_sim_hub' && d.interaction === 'sim_hub' && d.model === 'sim_hub') && !window.__game.ctx.housing.getFurnitureFor('workshop').some((d) => d.id === 'furn_sim_hub')), 'furn_sim_hub in the 사격장 catalogue only (interaction / model sim_hub)');
  // Phase 8: workshop also accepts the 정비 벤치, and 온실 accepts the 재배층
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').length === 13 && window.__game.ctx.housing.getFurnitureFor('empty').length === 8 && window.__game.ctx.housing.getFurnitureFor('greenhouse').length === 9), 'getFurnitureFor: workshop 13 (4 benches + 정비 벤치 + 8 any), empty 8, greenhouse 9');
  ok(await H(() => window.__game.ctx.housing.getPresetCount() === 0 && window.__game.ctx.housing.getCraftCostMul() === 1 && window.__game.ctx.housing.getSkillGainMul('gun_AR') === 1), 'no rooms: 0 presets, cost ×1, skill ×1');
  // `housing:loaded` fired inside init() before the recorder existed; the saved file proves the fresh state was written
  await sleep(500);
  ok(await H(() => !!localStorage.getItem('scav.ship')), 'fresh state saved to localStorage (scav.ship)');

  console.log('hub');
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.5);

  console.log('room purposes');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'lab') === false), 'lab refused without a greenhouse');
  // Phase 8 UI pass: room 1 is locked to 작업실 and no other room may become one
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'workshop') === false && /방 1에만/.test(window.__game.ctx.housing.purposeBlock(3, 'workshop') ?? '')), '작업실 refused outside room 1');
  ok(await H(() => /기본 작업실/.test(window.__game.ctx.housing.purposeBlock(0, 'empty') ?? '') && window.__game.ctx.housing.setRoomPurpose(0, 'empty') === false), 'room 1 cannot be re-purposed');
  const r0 = await H(() => window.__game.ctx.housing.getRoom(0));
  ok(r0.purpose === 'workshop' && r0.level === 1, 'workshop room is level 1');
  // Phase 9 UI pass: a 시설 증축 costs materials (`purposeCost`) and sits behind the 발전기 Lv.1 gate — a fresh save has neither.
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'gym') === false && /발전기/.test(window.__game.ctx.housing.purposeBlock(3, 'gym') ?? '')), '시설 증축 refused at 발전기 Lv0');
  const gymCost = await H(() => window.__game.ctx.housing.purposeCost('gym'));
  ok(gymCost.length === 1 && gymCost[0].defId === 'mat_scrap' && gymCost[0].qty === 8, `purposeCost('gym') = 폐금속 8 (${JSON.stringify(gymCost)})`);
  ok(await H(() => window.__game.ctx.housing.purposeCost('empty').length === 0 && window.__game.ctx.housing.purposeCost('range').some((c) => c.defId === 'mat_cable')), '빈 방 is free; 사격장 needs 케이블');
  ok(await H(() => window.__game.ctx.housing.findRoom('workshop') === 0 && window.__game.ctx.housing.findRoom('range') === -1), 'findRoom');
  ok(await H(() => window.__game.ctx.housing.getFacility('workshop').level === 1 && window.__game.ctx.housing.getCraftCostMul() === 1), 'workshop facility level 1, cost ×1');

  console.log('placement');
  // start the placement checks from an empty 작업실: the two built-in benches go back to furniture storage
  await H(() => { const h = window.__game.ctx.housing; for (const f of [...h.getPlaced(0)]) h.recover(f.uid); });
  ok(await H(() => window.__game.ctx.housing.getPlaced(0).length === 0 && window.__game.ctx.housing.getStored().length === 2), 'built-in benches recovered into furniture storage');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 0, 0, 0) === true), 'canPlace 4×2 bench at (0,0) yaw 0');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 5, 0, 0) === false), 'canPlace refuses x=5 (4 wide in an 8-col grid)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 5, 0, 1) === true), 'canPlace yaw 1 (2×4) at x=5 fits');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 6, 5, 1) === false), 'canPlace yaw 1 at y=5 overflows rows');
  ok(await H(() => window.__game.ctx.housing.canPlace(1, 'furn_bench_gun', 0, 0, 0) === false), 'canPlace refuses a bench in an empty room (purpose)');
  ok(await H(() => window.__game.ctx.housing.canPlace(1, 'furn_locker', 0, 0, 0) === true), "canPlace allows 'any' furniture in an empty room");
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_range_console', 0, 0, 0) === false), 'canPlace refuses range furniture in the workshop');
  ok(await H(() => window.__game.ctx.housing.place(0, 'furn_locker', 0, 0, 0) === null), 'place refuses a def not in furniture storage');
  const placed = await H(() => window.__game.ctx.housing.place(0, 'furn_bench_gun', 1, 1, 0));
  ok(placed && placed.uid === 'f-3' && placed.level === 1 && placed.room === 0, `place → f-3 (${JSON.stringify(placed)})`);
  ok((await lastEv('housing:furniturePlaced'))?.item?.uid === 'f-3', 'housing:furniturePlaced');
  ok(await H(() => !window.__game.ctx.housing.getStored().some((e) => e.defId === 'furn_bench_gun' && e.qty > 0)), 'storage entry consumed (the 정비 벤치 stays)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 3, 2, 0) === false), 'canPlace overlap refused (3,2 vs 1..4,1..2)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 0, 3, 0) === true), 'canPlace free row below');
  ok(await H(() => window.__game.ctx.housing.move('f-3', 2, 3, 1) === true), 'move f-3 → (2,3) yaw 1');
  const moved = await lastEv('housing:furnitureMoved');
  ok(moved && moved.item.x === 2 && moved.item.y === 3 && moved.item.yaw === 1, 'housing:furnitureMoved carries the new cell + yaw');
  ok(await H(() => window.__game.ctx.housing.move('f-3', 7, 3, 1) === false), 'move refuses out of grid');
  ok(await H(() => window.__game.ctx.housing.move('f-3', 2, 3, 1) === true), 'move onto its own cells (ignoreUid) ok');
  ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 1 && window.__game.ctx.housing.getBenchLevel('gear') === 0), 'getBenchLevel gun 1 / gear 0');
  ok(await H(() => window.__game.ctx.housing.recover('f-3') === true), 'recover f-3');
  const rec = await lastEv('housing:furnitureRecovered');
  ok(rec && rec.uid === 'f-3' && rec.defId === 'furn_bench_gun' && rec.room === 0, 'housing:furnitureRecovered');
  ok(await H(() => { const e = window.__game.ctx.housing.getStored().find((x) => x.defId === 'furn_bench_gun'); return !!e && e.qty === 1 && e.level === 1; }), 'recovered piece back in storage');
  ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 0), 'bench level 0 after recover');
  const re = await H(() => window.__game.ctx.housing.place(0, 'furn_bench_gun', 0, 0, 0));
  ok(re && re.uid === 'f-4', 're-place → new uid f-4');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(0, 'range') === false), 'purpose change refused while a workshop bench is placed');
  ok(await H(() => /기본 작업실/.test(window.__game.ctx.housing.purposeBlock(0, 'range') ?? '')), 'room 1 keeps its 작업실 whatever is placed in it');

  console.log('materials / facilities');
  const hasCountAll = (await count('mat_scrap')) >= 0;
  if (!hasCountAll) console.log('  TODO(lead): inventory.countDefAll is not a function yet — material checks will report 0');
  const scrap = await give('mat_scrap', 40);
  ok(scrap === 40, `40 폐금속 into the bag (${scrap})`);
  ok((await count('mat_scrap')) === 40, `countDefAll(mat_scrap) 40 (${await count('mat_scrap')})`);
  const gen0 = await H(() => window.__game.ctx.housing.getFacility('generator'));
  ok(gen0.level === 0 && gen0.maxLevel === 5 && gen0.nextCost?.[0]?.defId === 'mat_scrap' && gen0.nextCost[0].qty === 4 && gen0.blocked === null, `generator: Lv0/5, next 폐금속 4, unblocked (${JSON.stringify(gen0)})`);
  const ws0 = await H(() => window.__game.ctx.housing.getFacility('workshop'));
  ok(ws0.level === 1 && ws0.blocked && ws0.blocked.includes('발전기'), `workshop Lv2 blocked by the generator gate (${ws0.blocked})`);
  ok(await H(() => window.__game.ctx.housing.upgrade('workshop') === false), 'upgrade(workshop) refused (generator 0)');
  const rg0 = await H(() => window.__game.ctx.housing.getFacility('range'));
  ok(rg0.level === 0 && rg0.blocked && rg0.blocked.includes('방'), `range blocked: no room (${rg0.blocked})`);
  ok(await H(() => window.__game.ctx.housing.upgrade('generator') === true), 'generator → 1');
  ok((await lastEv('housing:facilityUpgraded'))?.id === 'generator', 'housing:facilityUpgraded generator');
  ok((await count('mat_scrap')) === 36, `4 폐금속 consumed (${await count('mat_scrap')})`);
  // 시설 증축 with the gate open: it goes through and pays its materials
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'gym') === true), 'room 4 → 헬스장 (발전기 1 + 폐금속 8)');
  const pc = await lastEv('housing:roomPurposeChanged');
  ok(pc && pc.room === 3 && pc.purpose === 'gym', 'housing:roomPurposeChanged emitted');
  ok((await lastEv('housing:changed'))?.reason === 'purpose', 'housing:changed {reason: purpose}');
  ok((await count('mat_scrap')) === 28, `시설 증축 consumed 폐금속 8 (${await count('mat_scrap')})`);
  await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'empty'));
  await give('mat_scrap', 8);                    // put the 헬스장 price back so the facility maths below is unchanged
  ok(await H(() => window.__game.ctx.housing.upgrade('storage') === true), 'storage → 1 (6 폐금속)');
  ok((await count('mat_scrap')) === 30, `6 폐금속 consumed (${await count('mat_scrap')})`);
  const stash1 = await H(() => window.__game.ctx.housing.getStashSize());
  ok(stash1.rows === 30 && stash1.cols === 10, `getStashSize().rows === 30 (${stash1.rows})`);
  const ssc = await lastEv('housing:stashSizeChanged');
  ok(ssc && ssc.rows === 30, 'housing:stashSizeChanged {rows: 30}');
  const invStash = await H(() => (typeof window.__game.ctx.inventory.getStashSize === 'function' ? window.__game.ctx.inventory.getStashSize() : null));
  if (invStash) ok(invStash.rows === 30, `inventory.getStashSize() mirrors 30 rows (${invStash.rows})`);
  else console.log('  TODO(lead): inventory.getStashSize missing — stash resize not verified');
  ok(await H(() => window.__game.ctx.housing.getFacility('storage').blocked?.includes('발전기')), 'storage Lv2 gated by generator 1');
  const ws1 = await H(() => window.__game.ctx.housing.getFacility('workshop'));
  ok(ws1.blocked && ws1.blocked.includes('발전기'), 'workshop Lv2 still gated (generator 1 < 2)');
  // generator 2 needs 폐금속 8 + 전력 케이블 2 (mat_cable is a new items/ def)
  const cable = await give('mat_cable', 10);
  if (cable < 0) console.log('  TODO(lead): items/ has no mat_cable yet — generator 2 / workshop 2 skipped');
  else {
    ok(await H(() => window.__game.ctx.housing.upgrade('generator') === true), 'generator → 2 (8 폐금속 + 2 케이블)');
    ok(await H(() => window.__game.ctx.housing.getFacility('workshop').blocked === null), 'workshop Lv2 unblocked (generator 2, 10 폐금속 + 2 케이블)');
    ok(await H(() => window.__game.ctx.housing.upgrade('workshop') === true), 'workshop → 2');
    ok(await H(() => window.__game.ctx.housing.getRoom(0).level === 2 && Math.abs(window.__game.ctx.housing.getCraftCostMul() - 0.9) < 1e-9), 'workshop room level 2 → craft cost ×0.9');
  }
  const scrapNow = await count('mat_scrap');
  const missingScrap = await H(() => window.__game.ctx.housing.getFacility('storage'));
  ok(missingScrap.nextCost && missingScrap.nextCost.some((c) => c.defId === 'mat_alloy'), 'storage Lv2 cost lists 합금 판');
  await give('mat_scrap', 20);
  ok((await count('mat_scrap')) === scrapNow + 20, 'top-up');
  const st2blocked = await H(() => window.__game.ctx.housing.getFacility('storage').blocked);
  ok(st2blocked && (st2blocked.includes('합금 판') || st2blocked.includes('발전기')), `storage Lv2 blocked with a 한국어 reason (${st2blocked})`);

  console.log('furniture craft / upgrade');
  const locker = await H(() => window.__game.ctx.housing.canCraftFurniture('furn_locker'));
  ok(locker.ok === true && locker.missing.length === 0, 'canCraftFurniture(furn_locker) with 폐금속');
  ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_locker') === true), 'craftFurniture(furn_locker)');
  ok(await H(() => window.__game.ctx.housing.getStored().some((s) => s.defId === 'furn_locker' && s.qty === 1)), 'locker in furniture storage');
  ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_locker') && window.__game.ctx.housing.getStored().find((s) => s.defId === 'furn_locker').qty === 2), 'second locker stacks (qty 2)');
  const bunkMissing = await H(() => window.__game.ctx.housing.canCraftFurniture('furn_bunk'));
  ok(bunkMissing.ok === false && bunkMissing.missing.some((m) => m.defId === 'mat_alloy'), 'canCraftFurniture(furn_bunk) reports missing 합금 판');
  ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_bunk') === false), 'craftFurniture refused when short');
  ok(await H(() => window.__game.ctx.housing.place(1, 'furn_locker', 0, 0, 0) !== null), 'locker placed in an empty room (any)');
  const upReason = await H(() => window.__game.ctx.housing.furnitureUpgradeBlock('f-4'));
  const circuit = await give('mat_circuit', 5);
  const alloy = await give('mat_alloy', 20);
  if (circuit < 0) {
    console.log('  TODO(lead): items/ has no mat_circuit yet — bench upgrade only checked for refusal');
    ok(typeof upReason === 'string', `bench upgrade blocked with a reason (${upReason})`);
    ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-4') === false), 'upgradeFurniture refused');
  } else {
    ok(alloy === 20 && circuit === 5, 'alloy + circuit in the bag');
    const gen = await H(() => window.__game.ctx.housing.state.generatorLevel);
    if (gen >= 2) {
      ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-4') === true), 'bench f-4 → Lv2');
      ok((await lastEv('housing:furnitureUpgraded'))?.item?.level === 2, 'housing:furnitureUpgraded level 2');
      ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 2), 'getBenchLevel(gun) 2');
      ok(await H(() => window.__game.ctx.housing.furnitureUpgradeBlock('f-4')?.includes('발전기')), 'Lv3 gated by generator 2');
      ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-4') === false), 'upgradeFurniture refused at the gate');
    } else {
      ok(typeof upReason === 'string' && upReason.includes('발전기'), `bench upgrade gated by the generator (${upReason})`);
    }
  }

  console.log('range / presets');
  // Phase 9 UI pass: every 시설 증축 below costs materials — keep the bag stocked
  await give('mat_scrap', 60); await give('mat_alloy', 20); await give('mat_cable', 20); await give('mat_circuit', 10);
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(5, 'range') === true), 'room 5 → range');
  ok(await H(() => window.__game.ctx.housing.getPresetCount() === 3), 'range level 1 → 3 preset slots');
  ok(await H(() => Math.abs(window.__game.ctx.housing.getSkillGainMul('gun_SR') - 1.1) < 1e-9 && window.__game.ctx.housing.getSkillGainMul('melee') === 1), 'skill gain ×1.1 for gun_*, ×1 otherwise');
  ok(await H(() => window.__game.ctx.housing.getPresets().length === 3 && window.__game.ctx.housing.getPresets().every((p) => p === null)), 'getPresets → 3 empty slots');
  const cap = await H(() => (typeof window.__game.ctx.inventory.captureLoadout === 'function' ? window.__game.ctx.inventory.captureLoadout() : null));
  if (!cap) console.log('  TODO(lead): inventory.captureLoadout missing — saving a synthetic preset instead');
  const saved = await H((c) => window.__game.ctx.housing.savePreset(1, c ?? { name: '테스트', primary: 'wpn_ar', primary2: null, secondary: 'wpn_hg', bag: null, armor: null, implant: 'dash' }), cap ? { ...cap, name: '테스트' } : null);
  ok(saved === true, 'savePreset(1)');
  ok(await H(() => window.__game.ctx.housing.savePreset(3, { name: 'x', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: null }) === false), 'savePreset(3) refused (only 3 slots)');
  ok(await H(() => window.__game.ctx.housing.getPresets()[1]?.name === '테스트'), 'preset 1 stored with its name');
  const applied = await H(() => window.__game.ctx.housing.applyPreset(1));
  const canApply = await H(() => typeof window.__game.ctx.inventory.applyLoadout === 'function');
  if (canApply) {
    ok(applied && typeof applied.equipped === 'number' && Array.isArray(applied.missing), `applyPreset → ${JSON.stringify(applied)}`);
    const pa = await lastEv('housing:presetApplied');
    ok(pa && pa.index === 1 && pa.equipped === applied.equipped, 'housing:presetApplied');
  } else {
    console.log('  TODO(lead): inventory.applyLoadout missing — applyPreset returns null');
    ok(applied === null, 'applyPreset → null without applyLoadout');
  }
  ok(await H(() => window.__game.ctx.housing.applyPreset(0) === null), 'applyPreset(0) → null (empty slot)');
  // range furniture: the console needs mat_cable + mat_circuit; target lane needs scrap + alloy
  const lane = await H(() => window.__game.ctx.housing.canCraftFurniture('furn_target_lane'));
  if (lane.ok) {
    ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_target_lane') && window.__game.ctx.housing.place(5, 'furn_target_lane', 0, 0, 0) !== null), 'target lane crafted + placed in the range');
    ok(await H(() => window.__game.ctx.housing.place(5, 'furn_target_lane', 0, 0, 0) === null), 'second lane refused (none in storage)');
    ok(await H(() => window.__game.ctx.housing.setRoomPurpose(5, 'gym') === false && /회수/.test(window.__game.ctx.housing.purposeBlock(5, 'gym') ?? '')), 'purpose change refused while range furniture is placed (reason names 회수)');
  } else console.log(`  TODO(lead): target lane needs 합금 판 (${JSON.stringify(lane.missing)})`);
  // 시뮬레이션 허브 (Phase 7): 폐금속 8 + 케이블 2 + 회로 2, 2×2, range only — crafted and placed like every other piece
  const simDef = await H(() => { const d = window.__game.ctx.housing.getFurnitureDef('furn_sim_hub'); return d ? { room: d.room, craft: d.craft } : null; });
  ok(simDef && simDef.room === 'range' && simDef.craft.some((c) => c.defId === 'mat_circuit' && c.qty === 2) && simDef.craft.some((c) => c.defId === 'mat_cable' && c.qty === 2) && simDef.craft.some((c) => c.defId === 'mat_scrap' && c.qty === 8), 'furn_sim_hub def: range, 폐금속 8 + 케이블 2 + 회로 2', JSON.stringify(simDef));
  await give('mat_scrap', 10); await give('mat_cable', 2); await give('mat_circuit', 2);
  ok((await H(() => window.__game.ctx.housing.canCraftFurniture('furn_sim_hub'))).ok === true, 'canCraftFurniture(furn_sim_hub) with the materials in the bag');
  const circuitBefore = await count('mat_circuit');
  const simStoredBefore = await H(() => window.__game.ctx.housing.getStored().find((e) => e.defId === 'furn_sim_hub')?.qty ?? 0);
  ok(await H(() => window.__game.ctx.housing.craftFurniture('furn_sim_hub') === true), 'craftFurniture(furn_sim_hub) → furniture storage');
  ok((await count('mat_circuit')) === circuitBefore - 2 && await H((n) => (window.__game.ctx.housing.getStored().find((e) => e.defId === 'furn_sim_hub')?.qty ?? 0) === n + 1, simStoredBefore), 'sim hub consumed 회로 2 and sits in storage');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_sim_hub', 4, 4, 0) === false && window.__game.ctx.housing.canPlace(5, 'furn_sim_hub', 4, 4, 0) === true), 'canPlace: sim hub refused in the workshop, allowed in the range');
  const simPlaced = await H(() => window.__game.ctx.housing.place(5, 'furn_sim_hub', 4, 4, 0));
  ok(simPlaced && simPlaced.defId === 'furn_sim_hub' && simPlaced.room === 5 && simPlaced.level === 1, `sim hub placed in the range (${simPlaced?.uid})`);
  ok((await lastEv('housing:furniturePlaced'))?.item?.defId === 'furn_sim_hub', 'housing:furniturePlaced {furn_sim_hub}');
  ok(await H(() => window.__game.ctx.housing.getPlaced(5).some((f) => f.defId === 'furn_sim_hub') && window.__game.ctx.housing.getFurnitureDef('furn_sim_hub').interaction === 'sim_hub'), "placed sim hub carries interaction 'sim_hub' for hub/");
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(1, 'lounge') === true && window.__game.ctx.housing.getPlaced(1).length === 1), "room 1 → lounge keeps its 'any' locker");
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(1, 'empty') === true && window.__game.ctx.housing.getPlaced(1).length === 0 && window.__game.ctx.housing.getStored().find((s) => s.defId === 'furn_locker')?.qty === 2), 'room 1 → empty recovers the locker');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(2, 'gym') === true && window.__game.ctx.housing.getRoom(2).level === 1), 'inactive purpose (gym) can still be assigned');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'greenhouse') && window.__game.ctx.housing.setRoomPurpose(4, 'lab')), 'lab allowed once a greenhouse exists');

  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'workshop') === false && /방 1에만/.test(window.__game.ctx.housing.purposeBlock(7, 'workshop') ?? '')), 'second 작업실 refused (room 1 owns it)');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'range') === false), 'second 사격장 refused');

  console.log('housing mode');
  ok(await H(() => window.__game.ctx.housing.enterHousingMode(0) === false && /안에서만/.test(window.__game.ctx.housing.housingModeBlock(0) ?? '')), 'enterHousingMode(0) refused from the cockpit (currentRoom null)');
  await H(() => { const p = window.__game.ctx.player; const v = p.position.clone(); v.set(-3.8, 0, 2.5); p.spawnStanding(v, 0); });
  await waitSim(0.3);
  ok(await H(() => window.__game.ctx.hub.currentRoom === 0), 'player teleported into room 0 (hub.currentRoom 0)');
  ok(await H(() => window.__game.ctx.housing.enterHousingMode(0) === true), 'enterHousingMode(0)');
  const hm = await lastEv('housing:modeChanged');
  ok(hm && hm.active === true && hm.room === 0, 'housing:modeChanged {active, room 0}');
  ok(await H(() => window.__game.ctx.housing.housingMode && window.__game.ctx.housing.housingRoom === 0 && !window.__game.ctx.uiBlockers.has('housing')), 'housing mode set, no ui blocker');
  await H(() => window.__game.ctx.housing.selectFurniture('furn_locker'));
  ok((await lastEv('housing:selectionChanged'))?.defId === 'furn_locker', 'selectFurniture → housing:selectionChanged');
  await H(() => window.__game.ctx.housing.rotateSelection());
  const sel = await lastEv('housing:selectionChanged');
  ok(sel && sel.defId === 'furn_locker' && sel.yaw === 1, 'rotateSelection → yaw 1');
  await H(() => window.__game.ctx.housing.selectFurniture('furn_bench_gear'));
  ok(await H(() => window.__game.ctx.housing.selectedFurniture === 'furn_locker'), 'selecting a def not in storage is ignored');
  await H(() => window.__game.ctx.housing.exitHousingMode());
  ok((await lastEv('housing:modeChanged'))?.active === false && await H(() => !window.__game.ctx.housing.housingMode), 'exitHousingMode');
  ok(await H(() => window.__game.ctx.housing.selectedYaw === 0), 'yaw reset on exit');

  console.log('DOM panels');
  // Phase 8 UI pass: the standalone 방 메뉴 / 시설 메뉴 are gone — both entries redirect to 시설 관리.
  await H(() => window.__game.ctx.housing.openRoomMenu(0));
  await sleep(120);
  const mng = await lastEv('housing:shipManageChanged');
  ok(mng && mng.active === true && mng.room === 0, 'openRoomMenu(0) redirects to 시설 관리 on room 1');
  ok(await H(() => window.__game.ctx.housing.shipManageMode === true && !window.__game.ctx.housing.isMenuOpen && !window.__game.ctx.uiBlockers.has('housing')), 'shipManageMode on, no housing panel / blocker');
  ok(await H(() => !!document.querySelector('.ship-manage')?.classList.contains('show')), '시설 관리 screen shown');
  const smDom = await H(() => {
    const root = document.querySelector('.ship-manage');
    return { rooms: root.querySelectorAll('.sm-room').length, on: root.querySelector('.sm-room.is-on')?.textContent ?? '',
      cards: root.querySelectorAll('.sm-cards .fcard').length, purposes: root.querySelectorAll('.sm-purposes .sm-purpose').length,
      head: root.querySelector('.sm-bar-head').textContent };
  });
  ok(smDom.rooms === 10 && /방 1/.test(smDom.on), `방 목록: 10 rows, room 1 active (${smDom.on})`);
  ok(smDom.cards === 13 && smDom.purposes === 0 && /작업실/.test(smDom.head), `가구 목록 for the 작업실 (${smDom.cards} cards, '${smDom.head}')`);
  /* Phase 9 UI pass: 가구 제작 / 가구 창고 tabs on the side panel */
  const smTabs = await H(() => {
    const root = document.querySelector('.ship-manage');
    return {
      tabs: [...root.querySelectorAll('.sm-tabs .sm-tab')].map((b) => `${b.textContent}${b.classList.contains('is-on') ? '*' : ''}`).join(' '),
      tabsHidden: root.querySelector('.sm-tabs').hidden,
      craftBtns: root.querySelectorAll('.sm-cards .fcard .fcard-craft').length,
      storeHidden: root.querySelector('.sm-store').hidden,
    };
  });
  ok(smTabs.tabs === '가구 제작* 가구 창고' && !smTabs.tabsHidden && smTabs.craftBtns === 13 && smTabs.storeHidden,
    `side panel tabs 가구 제작 / 가구 창고, every craft row has a 제작 button (${smTabs.craftBtns})`, JSON.stringify(smTabs));
  await H(() => [...document.querySelectorAll('.ship-manage .sm-tabs .sm-tab')].find((b) => b.textContent === '가구 창고').click());
  await sleep(120);
  const smStore = await H(() => {
    const root = document.querySelector('.ship-manage');
    const stored = new Set(window.__game.ctx.housing.getStored().map((s) => s.defId));
    return {
      cardsHidden: root.querySelector('.sm-cards').hidden, storeHidden: root.querySelector('.sm-store').hidden,
      rows: root.querySelectorAll('.sm-store .fcard').length, stored: stored.size,
      blocked: root.querySelectorAll('.sm-store .fcard.is-blocked').length,
      firstFits: !root.querySelector('.sm-store .fcard')?.classList.contains('is-blocked'),
    };
  });
  ok(smStore.storeHidden === false && smStore.cardsHidden && smStore.rows === smStore.stored,
    `가구 창고 tab lists every stored def (${smStore.rows} / ${smStore.stored})`, JSON.stringify(smStore));
  ok(smStore.rows === 0 || smStore.firstFits, '이 방에 놓을 수 있는 가구가 목록 맨 위에 온다', JSON.stringify(smStore));
  await H(() => [...document.querySelectorAll('.ship-manage .sm-tabs .sm-tab')].find((b) => b.textContent === '가구 제작').click());
  await sleep(120);
  await H(() => window.__game.ctx.housing.setManageRoom(9));
  await sleep(120);
  const smEmpty = await H(() => {
    const root = document.querySelector('.ship-manage');
    return { purposes: root.querySelectorAll('.sm-purposes .sm-purpose').length,
      blocked: root.querySelectorAll('.sm-purposes .sm-purpose.is-blocked').length,
      // Phase 9 UI pass: the prose description is replaced by the 시설 증축 cost chips
      costs: root.querySelectorAll('.sm-purposes .sm-purpose .sm-cost .item-chip').length,
      descs: root.querySelectorAll('.sm-purposes .sm-purpose .ds').length,
      tabsHidden: root.querySelector('.sm-tabs').hidden,
      cardsHidden: root.querySelector('.sm-cards').hidden, head: root.querySelector('.sm-bar-head').textContent };
  });
  ok(smEmpty.purposes === 9 && smEmpty.cardsHidden && /용도 지정/.test(smEmpty.head), `an empty room shows the 용도 지정 picker instead of the furniture list (${smEmpty.purposes})`);
  ok(smEmpty.blocked >= 2, `작업실 / 사격장 are disabled there with a reason (${smEmpty.blocked})`);
  ok(smEmpty.costs > 0 && smEmpty.descs === 0 && smEmpty.tabsHidden,
    `용도 지정 rows carry 시설 증축 cost chips instead of a description (${smEmpty.costs} chips), 가구 탭 숨김`, JSON.stringify(smEmpty));
  await H(() => window.__game.ctx.housing.openFacilityMenu());
  await sleep(120);
  ok(await H(() => window.__game.ctx.housing.shipManageMode === true), 'openFacilityMenu() also redirects to 시설 관리');
  await H(() => window.__game.ctx.housing.closeShipManage());
  await sleep(120);
  ok(await H(() => !window.__game.ctx.housing.shipManageMode && !window.__game.ctx.uiBlockers.has('shipmanage')
    && !document.querySelector('.ship-manage').classList.contains('show')), 'closeShipManage → screen hidden, shipmanage blocker released');
  ok(await H(() => window.__game.ctx.player.controlsEnabled !== false), 'player controls restored after 시설 관리');

  await H(() => window.__game.ctx.housing.openPresetMenu());
  await sleep(100);
  const preDom = await H(() => {
    const root = document.querySelector('.menu.housing-menu.preset-menu');
    return { hidden: root.hidden, cards: root.querySelectorAll('.hs-preset').length, name: root.querySelector('.hs-preset[data-preset="1"] input').value,
      applyDisabled: root.querySelector('.hs-preset[data-preset="0"] .ui-btn.primary').disabled,
      blocker: window.__game.ctx.uiBlockers.has('housing'), cursor: window.__game.ctx.input.isCursorMode };
  });
  ok(!preDom.hidden && preDom.cards === 3 && preDom.name === '테스트' && preDom.applyDisabled, `preset menu: 3 cards, slot 2 named 테스트, empty slot cannot apply`);
  // Phase 10: a housing panel keeps the pointer lock and turns on the in-game cursor instead of exiting the lock
  ok(preDom.blocker && preDom.cursor, 'housing panel: blocker housing + in-game cursor (no exitPointerLock)', JSON.stringify({ blocker: preDom.blocker, cursor: preDom.cursor }));
  ok((await lastEv('ui:housingToggled'))?.page === 'presets', 'ui:housingToggled {presets}');
  await H(() => document.querySelector('.hs-preset[data-preset="1"] .actions .ui-btn.danger').click());
  await sleep(50);
  ok(await H(() => window.__game.ctx.housing.getPresets()[1] === null), '삭제 button clears the preset');
  await H(() => window.__game.ctx.housing.closeMenus());
  await sleep(60);
  ok(await H(() => !window.__game.ctx.housing.isMenuOpen && !window.__game.ctx.uiBlockers.has('housing')
    && !window.__game.ctx.input.isCursorMode), 'closing the panel releases the blocker and the in-game cursor');
  await H(() => window.__game.ctx.housing.openPresetMenu());   // re-open it: the next check is that 시설 관리 closes it
  await sleep(80);
  await H(() => window.__game.ctx.housing.openRoomMenu(5));
  await sleep(120);
  ok(await H(() => document.querySelector('.preset-menu').hidden && window.__game.ctx.housing.shipManageMode && !window.__game.ctx.uiBlockers.has('housing')), '시설 관리 closes the preset panel (single owner of the screen)');
  const rangeDom = await H(() => {
    const root = document.querySelector('.ship-manage');
    return { head: root.querySelector('.sm-bar-head').textContent, names: [...root.querySelectorAll('.sm-cards .fcard-name')].map((n) => n.textContent) };
  });
  ok(/사격장/.test(rangeDom.head) && rangeDom.names.includes('시뮬레이션 허브') && rangeDom.names.includes('관물대'), `사격장 furniture list has 시뮬레이션 허브 + 관물대 (${rangeDom.names.join(', ')})`);
  await H(() => window.__game.ctx.housing.closeShipManage());
  await sleep(80);
  await H(() => window.__game.ctx.housing.closeMenus());
  ok(await H(() => !window.__game.ctx.housing.isMenuOpen && !window.__game.ctx.uiBlockers.has('housing')), 'closeMenus');

  console.log('server profile document (Phase 7)');
  await H(() => {
    const net = window.__game.ctx.net;
    // starts **offline** (available false): Phase 9 — the save must still call `profile.set` (ProfileSync queues it)
    const fake = { available: false, credits: 0, docs: {}, sets: [], get(k) { return this.docs[k]; }, set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); }, flush() {}, addCredits: async () => ({ ok: true, credits: 0 }) };
    window.__fakeProfile = fake;
    window.__realProfileDesc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
  });
  await H(() => { window.__game.ctx.housing.setRoomPurpose(8, 'kitchen'); window.__game.ctx.housing.save(); });
  ok(await H(() => window.__fakeProfile.sets.includes('ship') && window.__fakeProfile.docs.ship.rooms[8].purpose === 'kitchen'), "offline profile (available false): save still calls profile.set('ship') — ProfileSync queues it (Phase 9)");
  await H(() => { window.__fakeProfile.available = true; window.__fakeProfile.docs = {}; window.__fakeProfile.sets.length = 0; });
  await H(() => { window.__game.ctx.housing.setRoomPurpose(8, 'lounge'); window.__game.ctx.housing.save(); });
  ok(await H(() => window.__fakeProfile.sets.includes('ship') && window.__fakeProfile.docs.ship.rooms[8].purpose === 'lounge'), "save → profile.set('ship', state)");
  const shipSnap = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  await H(() => { window.__fakeProfile.docs = {}; window.__fakeProfile.sets.length = 0; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: {}, updatedAt: 0 }, migrated: true }); });
  ok(await H(() => window.__fakeProfile.sets.includes('ship') && window.__game.ctx.housing.getRoom(8).purpose === 'lounge'), 'no server document → local state uploaded, nothing replaced');
  const loadedN = (await ev('housing:loaded')).length;
  await H((snap) => {
    const doc = JSON.parse(JSON.stringify(snap));
    doc.rooms[8] = { purpose: 'kitchen', level: 1 };
    doc.storageLevel = 2;
    doc.furniture.push({ uid: 'f-90', defId: 'furn_crate', room: 8, x: 0, y: 0, yaw: 0, level: 1 });
    window.__fakeProfile.docs = { ship: doc };
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false });
  }, shipSnap);
  const srv = await H(() => ({ room8: window.__game.ctx.housing.getRoom(8).purpose, storage: window.__game.ctx.housing.state.storageLevel, crate: window.__game.ctx.housing.getPlaced(8).map((f) => f.uid + ':' + f.defId), rows: window.__game.ctx.housing.getStashSize().rows,
    loaded: window.__ev['housing:loaded'].length, changed: window.__ev['housing:changed'][window.__ev['housing:changed'].length - 1], stash: window.__ev['housing:stashSizeChanged'][window.__ev['housing:stashSizeChanged'].length - 1], local: JSON.parse(localStorage.getItem('scav.ship')).rooms[8].purpose, sets: window.__fakeProfile.sets.filter((k) => k === 'ship').length }));
  ok(srv.room8 === 'kitchen' && srv.storage === 2 && srv.crate.join() === 'f-90:furn_crate', 'net:profileLoaded → server ship document replaces the state (room 8 kitchen, storage 2, crate f-90)', JSON.stringify(srv));
  ok(srv.loaded === loadedN + 1 && srv.changed?.reason === 'profile', 'housing:loaded re-emitted + housing:changed {profile}', JSON.stringify({ loaded: srv.loaded, changed: srv.changed }));
  ok(srv.rows === 36 && srv.stash && srv.stash.rows === 36, 'stash size follows the server storage level (36 rows) + housing:stashSizeChanged', JSON.stringify({ rows: srv.rows, ev: srv.stash }));
  ok(srv.local === 'kitchen' && srv.sets === 1, 'localStorage cache updated, server copy not echoed back', JSON.stringify({ local: srv.local, sets: srv.sets }));
  const nextUid = await H(() => { const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); const p = h.place(8, 'furn_crate', 5, 5, 0); const uid = p?.uid; if (p) h.recover(p.uid); return uid; });
  ok(nextUid === 'f-91', `uid counter continues after the server copy's highest uid (${nextUid})`);
  // put the local state back through the same path, then restore the offline profile
  await H((snap) => { window.__fakeProfile.docs = { ship: snap }; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false }); }, shipSnap);
  ok(await H(() => window.__game.ctx.housing.getRoom(8).purpose === 'lounge' && window.__game.ctx.housing.getPlaced(8).length === 0 && window.__game.ctx.housing.getStashSize().rows === 30), 'local state restored through net:profileLoaded');
  await H(() => { const net = window.__game.ctx.net; if (window.__realProfileDesc) Object.defineProperty(net, 'profile', window.__realProfileDesc); else delete net.profile; });
  ok(await H(() => window.__game.ctx.net.profile !== window.__fakeProfile && window.__game.ctx.net.profile.available === false), 'real (offline) profile restored');
  await H(() => window.__game.ctx.housing.setRoomPurpose(8, 'empty'));

  console.log('persistence');
  await H(() => window.__game.ctx.housing.savePreset(0, { name: '리로드', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: 'scan' }));
  await H(() => window.__game.ctx.housing.save());
  const before = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const after = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  ok(after.rooms[0].purpose === 'workshop' && after.rooms[5].purpose === 'range' && after.rooms[2].purpose === 'gym', 'room purposes persisted');
  ok(after.generatorLevel === before.generatorLevel && after.storageLevel === 1 && after.rooms[0].level === before.rooms[0].level, `facility levels persisted (gen ${after.generatorLevel}, storage ${after.storageLevel})`);
  ok(after.furniture.length === before.furniture.length && after.furniture.some((f) => f.uid === 'f-4' && f.defId === 'furn_bench_gun') && after.furniture.some((f) => f.defId === 'furn_sim_hub' && f.room === 5), `furniture persisted incl. the sim hub (${after.furniture.length})`);
  ok(JSON.stringify(after.furnitureStorage) === JSON.stringify(before.furnitureStorage), 'furniture storage persisted');
  ok(after.presets[0]?.name === '리로드' && after.presets[0].implant === 'scan', 'preset persisted');
  ok(await H(() => window.__game.ctx.housing.getStashSize().rows === 30), 'stash size 30 rows after reload');
  await give('mat_scrap', 20); await give('mat_cable', 4);   // the bag is not persisted — only the stash is
  const next = await H(() => { window.__game.ctx.housing.setRoomPurpose(6, 'lounge'); const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); return h.place(6, 'furn_crate', 7, 7, 0); });
  ok(next && next.uid === 'f-8', `uid counter continues after the highest persisted uid (${next?.uid})`);
  // corrupt save → sanitised, not a crash (flush first so the unload flush does not overwrite the corrupt file)
  await H(() => window.__game.ctx.housing.save());
  await H(() => localStorage.setItem('scav.ship', JSON.stringify({ version: 1, rooms: [{ purpose: 'lab', level: 9 }], generatorLevel: 99, furniture: [{ uid: 'x', defId: 'nope', room: 0 }, { uid: 'f-3', defId: 'furn_crate', room: 30, x: 99, y: -1, yaw: 7, level: 5 }, { uid: 'f-3', defId: 'furn_bench_gun', room: 1, x: 0, y: 0, yaw: 0, level: 1 }, { uid: 'f-3', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }, { uid: 'bad', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }], furnitureStorage: [{ defId: 'furn_locker', qty: 'a' }], presets: [{ name: 1, implant: 'bogus' }] })));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const san = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  const sanStore = san.furnitureStorage.map((e) => e.defId).sort().join(',');
  ok(san.rooms.length === 10 && san.rooms[0].purpose === 'workshop' && san.generatorLevel === 5 && san.furniture.length === 1 && san.furniture[0].uid === 'f-3' && san.furniture[0].defId === 'furn_crate' && san.presets[0].name === '프리셋' && san.presets[0].implant === null, `corrupt save sanitised: lab→작업실 (room 1 invariant), gen clamped, bad rooms / purpose / overlap dropped (${JSON.stringify({ r0: san.rooms[0], g: san.generatorLevel, f: san.furniture, p: san.presets[0] })})`);
  ok(sanStore === 'furn_bench_gun,furn_repair_bench', `furniture that no longer fits its room went to storage, not the bin (${sanStore})`);

  /* ── 시설 제거 (Phase 9 UI pass): refund every upgrade material into the stash and empty the room ── */
  console.log('시설 제거 (facilityRefund / removeRoomFacility)');
  await give('mat_scrap', 40);
  await give('mat_alloy', 5);
  await give('mat_cable', 8);
  // room 1 is the ship's built-in 작업실 — it can never be handed back
  ok(await H(() => /기본 작업실/.test(window.__game.ctx.housing.removeRoomFacility(0) ?? '')), 'removeRoomFacility(0) refuses the built-in 작업실');
  ok(await H(() => window.__game.ctx.housing.facilityRefund(2).length === 0), 'a room with no facility refunds nothing');
  const rangeSetup = await H(() => {
    const h = window.__game.ctx.housing;
    const purpose = h.setRoomPurpose(5, 'range');
    const atLv1 = h.facilityRefund(5).length;
    const up = h.upgrade('range');
    h.craftFurniture('furn_target_lane');
    const placed = h.place(5, 'furn_target_lane', 0, 0, 0);
    return { purpose, atLv1, up, level: h.getFacility('range').level, refund: h.facilityRefund(5), placed: !!placed };
  });
  // Phase 9 UI pass: level 1 is paid by the 시설 증축, so even a Lv.1 room refunds that price
  ok(rangeSetup.purpose && rangeSetup.atLv1 === 2, `a Lv.1 사격장 refunds its 시설 증축 price (${rangeSetup.atLv1} lines)`);
  ok(rangeSetup.up && rangeSetup.level === 2 && rangeSetup.refund.some((c) => c.defId === 'mat_scrap' && c.qty === 18) && rangeSetup.refund.some((c) => c.defId === 'mat_cable' && c.qty === 2),
    `사격장 Lv.2 refund = 증축 (폐금속 10 · 케이블 2) + 업그레이드 (폐금속 8) (${JSON.stringify(rangeSetup.refund)})`);
  const removed = await H(() => {
    const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
    const stashOf = (id) => inv.getStashItems().filter((i) => i.defId === id).reduce((n, i) => n + i.qty, 0);
    const refund = h.facilityRefund(5);
    const stashBefore = Object.fromEntries(refund.map((c) => [c.defId, stashOf(c.defId)]));
    const placed = h.getPlaced(5).length;
    const storedBefore = h.getStored().reduce((n, s) => n + s.qty, 0);
    const reason = h.removeRoomFacility(5);
    return { reason, refund, stashBefore, placed, storedBefore,
      stashAfter: Object.fromEntries(refund.map((c) => [c.defId, stashOf(c.defId)])),
      purpose: h.getRoom(5).purpose, level: h.getRoom(5).level, stillPlaced: h.getPlaced(5).length,
      stored: h.getStored().reduce((n, s) => n + s.qty, 0), rangeLevel: h.getFacility('range').level };
  });
  ok(removed.reason === null && removed.purpose === 'empty' && removed.level === 0, `removeRoomFacility(5) emptied the room (${removed.reason ?? 'ok'})`);
  ok(removed.stillPlaced === 0 && removed.placed > 0 && removed.stored === removed.storedBefore + removed.placed,
    `every placed piece went to furniture storage (${removed.placed} → 0, storage ${removed.storedBefore} → ${removed.stored})`);
  ok(removed.refund.every((c) => removed.stashAfter[c.defId] === removed.stashBefore[c.defId] + c.qty),
    `upgrade materials refunded into the 함선 창고 (${JSON.stringify(removed.stashBefore)} → ${JSON.stringify(removed.stashAfter)})`);
  ok(removed.rangeLevel === 0, '사격장 facility is gone with its room');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
