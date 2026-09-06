// Single-player smoke test for ship housing (src/housing): state load, room purposes, furniture placement rules,
// facility upgrades + generator gating, stash size, furniture craft / upgrade, presets, persistence across a reload,
// and the three DOM panels (blocker + Esc). Drives `ctx.housing` from page.evaluate.
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
        'housing:stashSizeChanged', 'housing:presetApplied', 'ui:housingToggled']) {
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

  console.log('fresh state');
  const st0 = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  ok(st0.rooms.length === 10 && st0.rooms.every((r) => r.purpose === 'empty' && r.level === 0), 'fresh state: 10 empty rooms');
  ok(st0.generatorLevel === 0 && st0.storageLevel === 0 && st0.furniture.length === 0 && st0.presets.length === 0, 'fresh state: gen 0 / storage 0 / no furniture / no presets');
  ok(st0.furnitureStorage.length === 1 && st0.furnitureStorage[0].defId === 'furn_bench_gun' && st0.furnitureStorage[0].qty === 1, 'first run: one 총기 작업대 in furniture storage');
  const stash0 = await H(() => window.__game.ctx.housing.getStashSize());
  ok(stash0.cols === 10 && stash0.rows === 24, `getStashSize() 10×24 at storage 0 (${stash0.cols}×${stash0.rows})`);
  ok(await H(() => window.__game.ctx.housing.getAllFurnitureDefs().length === 14), 'FURNITURE_DEFS exposed (14)');
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').length === 12 && window.__game.ctx.housing.getFurnitureFor('empty').length === 8), 'getFurnitureFor: workshop 12 (4 benches + 8 any), empty 8');
  ok(await H(() => window.__game.ctx.housing.getPresetCount() === 0 && window.__game.ctx.housing.getCraftCostMul() === 1 && window.__game.ctx.housing.getSkillGainMul('gun_AR') === 1), 'no rooms: 0 presets, cost ×1, skill ×1');
  // `housing:loaded` fired inside init() before the recorder existed; the saved file proves the fresh state was written
  await sleep(500);
  ok(await H(() => !!localStorage.getItem('scav.ship')), 'fresh state saved to localStorage (scav.ship)');

  console.log('hub');
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.5);

  console.log('room purposes');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(0, 'lab') === false), 'lab refused without a greenhouse');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(0, 'workshop') === true), 'room 0 → workshop');
  const r0 = await H(() => window.__game.ctx.housing.getRoom(0));
  ok(r0.purpose === 'workshop' && r0.level === 1, 'workshop room is level 1');
  const pc = await lastEv('housing:roomPurposeChanged');
  ok(pc && pc.room === 0 && pc.purpose === 'workshop', 'housing:roomPurposeChanged emitted');
  ok((await lastEv('housing:changed'))?.reason === 'purpose', 'housing:changed {reason: purpose}');
  ok(await H(() => window.__game.ctx.housing.findRoom('workshop') === 0 && window.__game.ctx.housing.findRoom('range') === -1), 'findRoom');
  ok(await H(() => window.__game.ctx.housing.getFacility('workshop').level === 1 && window.__game.ctx.housing.getCraftCostMul() === 1), 'workshop facility level 1, cost ×1');

  console.log('placement');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 0, 0, 0) === true), 'canPlace 4×2 bench at (0,0) yaw 0');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 5, 0, 0) === false), 'canPlace refuses x=5 (4 wide in an 8-col grid)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 5, 0, 1) === true), 'canPlace yaw 1 (2×4) at x=5 fits');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 6, 5, 1) === false), 'canPlace yaw 1 at y=5 overflows rows');
  ok(await H(() => window.__game.ctx.housing.canPlace(1, 'furn_bench_gun', 0, 0, 0) === false), 'canPlace refuses a bench in an empty room (purpose)');
  ok(await H(() => window.__game.ctx.housing.canPlace(1, 'furn_locker', 0, 0, 0) === true), "canPlace allows 'any' furniture in an empty room");
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_range_console', 0, 0, 0) === false), 'canPlace refuses range furniture in the workshop');
  ok(await H(() => window.__game.ctx.housing.place(0, 'furn_locker', 0, 0, 0) === null), 'place refuses a def not in furniture storage');
  const placed = await H(() => window.__game.ctx.housing.place(0, 'furn_bench_gun', 1, 1, 0));
  ok(placed && placed.uid === 'f-1' && placed.level === 1 && placed.room === 0, `place → f-1 (${JSON.stringify(placed)})`);
  ok((await lastEv('housing:furniturePlaced'))?.item?.uid === 'f-1', 'housing:furniturePlaced');
  ok(await H(() => window.__game.ctx.housing.getStored().length === 0), 'storage entry consumed');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 3, 2, 0) === false), 'canPlace overlap refused (3,2 vs 1..4,1..2)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 0, 3, 0) === true), 'canPlace free row below');
  ok(await H(() => window.__game.ctx.housing.move('f-1', 2, 3, 1) === true), 'move f-1 → (2,3) yaw 1');
  const moved = await lastEv('housing:furnitureMoved');
  ok(moved && moved.item.x === 2 && moved.item.y === 3 && moved.item.yaw === 1, 'housing:furnitureMoved carries the new cell + yaw');
  ok(await H(() => window.__game.ctx.housing.move('f-1', 7, 3, 1) === false), 'move refuses out of grid');
  ok(await H(() => window.__game.ctx.housing.move('f-1', 2, 3, 1) === true), 'move onto its own cells (ignoreUid) ok');
  ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 1 && window.__game.ctx.housing.getBenchLevel('gear') === 0), 'getBenchLevel gun 1 / gear 0');
  ok(await H(() => window.__game.ctx.housing.recover('f-1') === true), 'recover f-1');
  const rec = await lastEv('housing:furnitureRecovered');
  ok(rec && rec.uid === 'f-1' && rec.defId === 'furn_bench_gun' && rec.room === 0, 'housing:furnitureRecovered');
  ok(await H(() => { const s = window.__game.ctx.housing.getStored(); return s.length === 1 && s[0].qty === 1 && s[0].level === 1; }), 'recovered piece back in storage');
  ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 0), 'bench level 0 after recover');
  const re = await H(() => window.__game.ctx.housing.place(0, 'furn_bench_gun', 0, 0, 0));
  ok(re && re.uid === 'f-2', 're-place → new uid f-2');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(0, 'range') === false), 'purpose change refused while a workshop bench is placed');
  ok(await H(() => window.__game.ctx.housing.purposeBlock(0, 'range')?.includes('회수')), 'refusal reason names 회수');

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
  const upReason = await H(() => window.__game.ctx.housing.furnitureUpgradeBlock('f-2'));
  const circuit = await give('mat_circuit', 5);
  const alloy = await give('mat_alloy', 20);
  if (circuit < 0) {
    console.log('  TODO(lead): items/ has no mat_circuit yet — bench upgrade only checked for refusal');
    ok(typeof upReason === 'string', `bench upgrade blocked with a reason (${upReason})`);
    ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-2') === false), 'upgradeFurniture refused');
  } else {
    ok(alloy === 20 && circuit === 5, 'alloy + circuit in the bag');
    const gen = await H(() => window.__game.ctx.housing.state.generatorLevel);
    if (gen >= 2) {
      ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-2') === true), 'bench f-2 → Lv2');
      ok((await lastEv('housing:furnitureUpgraded'))?.item?.level === 2, 'housing:furnitureUpgraded level 2');
      ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 2), 'getBenchLevel(gun) 2');
      ok(await H(() => window.__game.ctx.housing.furnitureUpgradeBlock('f-2')?.includes('발전기')), 'Lv3 gated by generator 2');
      ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-2') === false), 'upgradeFurniture refused at the gate');
    } else {
      ok(typeof upReason === 'string' && upReason.includes('발전기'), `bench upgrade gated by the generator (${upReason})`);
    }
  }

  console.log('range / presets');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(5, 'range') === true), 'room 5 → range');
  ok(await H(() => window.__game.ctx.housing.getPresetCount() === 3), 'range level 1 → 3 preset slots');
  ok(await H(() => Math.abs(window.__game.ctx.housing.getSkillGainMul('gun_SR') - 1.1) < 1e-9 && window.__game.ctx.housing.getSkillGainMul('melee') === 1), 'skill gain ×1.1 for gun_*, ×1 otherwise');
  ok(await H(() => window.__game.ctx.housing.getPresets().length === 3 && window.__game.ctx.housing.getPresets().every((p) => p === null)), 'getPresets → 3 empty slots');
  const cap = await H(() => (typeof window.__game.ctx.inventory.captureLoadout === 'function' ? window.__game.ctx.inventory.captureLoadout() : null));
  if (!cap) console.log('  TODO(lead): inventory.captureLoadout missing — saving a synthetic preset instead');
  const saved = await H((c) => window.__game.ctx.housing.savePreset(1, c ?? { name: '테스트', primary: 'wpn_ar23', primary2: null, secondary: 'wpn_p2', bag: null, armor: null, implant: 'dash' }), cap ? { ...cap, name: '테스트' } : null);
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
  } else console.log(`  TODO(lead): target lane needs 합금 판 (${JSON.stringify(lane.missing)})`);
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(1, 'lounge') === true && window.__game.ctx.housing.getPlaced(1).length === 1), "room 1 → lounge keeps its 'any' locker");
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(1, 'empty') === true && window.__game.ctx.housing.getPlaced(1).length === 0 && window.__game.ctx.housing.getStored().find((s) => s.defId === 'furn_locker')?.qty === 2), 'room 1 → empty recovers the locker');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(2, 'gym') === true && window.__game.ctx.housing.getRoom(2).level === 1), 'inactive purpose (gym) can still be assigned');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'greenhouse') && window.__game.ctx.housing.setRoomPurpose(4, 'lab')), 'lab allowed once a greenhouse exists');

  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'workshop') === false && /하나만/.test(window.__game.ctx.housing.purposeBlock(7, 'workshop') ?? '')), 'second 작업실 refused (facility rooms are unique per ship)');
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
  await H(() => window.__game.ctx.housing.openRoomMenu(0));
  await sleep(100);
  let tg = await lastEv('ui:housingToggled');
  ok(tg && tg.open === true && tg.page === 'room', 'openRoomMenu → ui:housingToggled {room}');
  ok(await H(() => window.__game.ctx.uiBlockers.has('housing') && window.__game.ctx.housing.isMenuOpen), "blocker 'housing' + isMenuOpen");
  const roomDom = await H(() => {
    const root = document.querySelector('.menu.housing-menu.room-menu');
    return {
      hidden: root.hidden, title: root.querySelector('.hs-head .title').textContent,
      purposes: root.querySelectorAll('.hs-purpose').length, badges: root.querySelectorAll('.hs-purpose .badge').length,
      current: root.querySelector('.hs-purpose.current')?.dataset.purpose,
      placed: root.querySelectorAll('.hs-row[data-uid]').length, craft: root.querySelectorAll('.hs-row[data-craft]').length,
      short: root.querySelectorAll('.hs-row[data-craft] .mat.short').length,
      housingBtn: !!root.querySelector('.hs-foot .ui-btn.primary'),
    };
  });
  ok(!roomDom.hidden && roomDom.title.startsWith('방 1'), `room menu visible, title '${roomDom.title}'`);
  ok(roomDom.purposes === 10 && roomDom.badges === 7 && roomDom.current === 'workshop', `10 purposes, 7 '다음 업데이트' badges, current workshop (${roomDom.badges})`);
  ok(roomDom.placed === 1 && roomDom.craft === 12 && roomDom.short > 0 && roomDom.housingBtn, `placed 1 · craft 12 · red missing materials ${roomDom.short} · 하우징 모드 button`);
  // clicking a blocked purpose (range while the bench is placed) shows the reason instead of switching
  await H(() => document.querySelector('.hs-purpose[data-purpose="range"]').click());
  ok(await H(() => window.__game.ctx.housing.getRoom(0).purpose === 'workshop' && !document.querySelector('.room-menu .hs-msg').hidden), 'blocked purpose click → message, purpose unchanged');
  await tap('Escape');
  await sleep(100);
  tg = await lastEv('ui:housingToggled');
  ok(tg && tg.open === false && await H(() => !window.__game.ctx.uiBlockers.has('housing') && document.querySelector('.room-menu').hidden), 'Esc closes the room menu + drops the blocker');

  await H(() => window.__game.ctx.housing.openFacilityMenu());
  await sleep(100);
  const facDom = await H(() => {
    const root = document.querySelector('.menu.housing-menu.facility-menu');
    const rows = [...root.querySelectorAll('.hs-row[data-facility]')].map((r) => ({ id: r.dataset.facility, lv: r.querySelector('.tag').textContent, disabled: r.querySelector('.ui-btn').disabled, blocked: r.querySelector('.blocked').textContent }));
    return { hidden: root.hidden, rows, summary: root.querySelector('.hs-summary').textContent };
  });
  ok(!facDom.hidden && facDom.rows.length === 4, 'facility menu: 4 rows');
  ok((await lastEv('ui:housingToggled'))?.page === 'facility', 'ui:housingToggled {facility}');
  ok(facDom.rows.find((r) => r.id === 'generator').lv.startsWith('Lv.') && facDom.rows.find((r) => r.id === 'range').lv === 'Lv.1 / 5', `range row Lv.1 / 5 (${facDom.rows.map((r) => r.lv).join(', ')})`);
  ok(facDom.rows.some((r) => r.disabled && r.blocked.length > 0), 'blocked upgrade buttons are disabled with a reason');
  ok(facDom.summary.includes('10 × 30'), `summary shows the stash size (${facDom.summary.slice(0, 40)})`);
  await H(() => document.querySelector('.facility-menu .hs-foot .right .ui-btn').click());
  await sleep(50);
  ok(await H(() => document.querySelector('.facility-menu').hidden && !window.__game.ctx.uiBlockers.has('housing')), '닫기 closes the facility menu');

  await H(() => window.__game.ctx.housing.openPresetMenu());
  await sleep(100);
  const preDom = await H(() => {
    const root = document.querySelector('.menu.housing-menu.preset-menu');
    return { hidden: root.hidden, cards: root.querySelectorAll('.hs-preset').length, name: root.querySelector('.hs-preset[data-preset="1"] input').value,
      applyDisabled: root.querySelector('.hs-preset[data-preset="0"] .ui-btn.primary').disabled };
  });
  ok(!preDom.hidden && preDom.cards === 3 && preDom.name === '테스트' && preDom.applyDisabled, `preset menu: 3 cards, slot 2 named 테스트, empty slot cannot apply`);
  ok((await lastEv('ui:housingToggled'))?.page === 'presets', 'ui:housingToggled {presets}');
  await H(() => document.querySelector('.hs-preset[data-preset="1"] .actions .ui-btn.danger').click());
  await sleep(50);
  ok(await H(() => window.__game.ctx.housing.getPresets()[1] === null), '삭제 button clears the preset');
  await H(() => window.__game.ctx.housing.openRoomMenu(5));
  await sleep(50);
  ok(await H(() => document.querySelector('.preset-menu').hidden && !document.querySelector('.room-menu').hidden && window.__game.ctx.uiBlockers.has('housing')), 'opening another panel closes the previous one (single blocker)');
  await H(() => window.__game.ctx.housing.closeMenus());
  ok(await H(() => !window.__game.ctx.housing.isMenuOpen && !window.__game.ctx.uiBlockers.has('housing')), 'closeMenus');

  console.log('persistence');
  await H(() => window.__game.ctx.housing.savePreset(0, { name: '리로드', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: 'scan' }));
  await H(() => window.__game.ctx.housing.save());
  const before = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const after = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  ok(after.rooms[0].purpose === 'workshop' && after.rooms[5].purpose === 'range' && after.rooms[2].purpose === 'gym', 'room purposes persisted');
  ok(after.generatorLevel === before.generatorLevel && after.storageLevel === 1 && after.rooms[0].level === before.rooms[0].level, `facility levels persisted (gen ${after.generatorLevel}, storage ${after.storageLevel})`);
  ok(after.furniture.length === before.furniture.length && after.furniture.some((f) => f.uid === 'f-2' && f.defId === 'furn_bench_gun'), `furniture persisted (${after.furniture.length})`);
  ok(JSON.stringify(after.furnitureStorage) === JSON.stringify(before.furnitureStorage), 'furniture storage persisted');
  ok(after.presets[0]?.name === '리로드' && after.presets[0].implant === 'scan', 'preset persisted');
  ok(await H(() => window.__game.ctx.housing.getStashSize().rows === 30), 'stash size 30 rows after reload');
  await give('mat_scrap', 10);                   // the bag is not persisted — only the stash is
  const next = await H(() => { window.__game.ctx.housing.setRoomPurpose(6, 'lounge'); const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); return h.place(6, 'furn_crate', 7, 7, 0); });
  ok(next && next.uid === 'f-5', `uid counter continues after the highest persisted uid f-4 (${next?.uid})`);
  // corrupt save → sanitised, not a crash (flush first so the unload flush does not overwrite the corrupt file)
  await H(() => window.__game.ctx.housing.save());
  await H(() => localStorage.setItem('scav.ship', JSON.stringify({ version: 1, rooms: [{ purpose: 'lab', level: 9 }], generatorLevel: 99, furniture: [{ uid: 'x', defId: 'nope', room: 0 }, { uid: 'f-3', defId: 'furn_crate', room: 30, x: 99, y: -1, yaw: 7, level: 5 }, { uid: 'f-3', defId: 'furn_bench_gun', room: 1, x: 0, y: 0, yaw: 0, level: 1 }, { uid: 'f-3', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }, { uid: 'bad', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }], furnitureStorage: [{ defId: 'furn_locker', qty: 'a' }], presets: [{ name: 1, implant: 'bogus' }] })));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const san = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  ok(san.rooms.length === 10 && san.rooms[0].purpose === 'empty' && san.generatorLevel === 5 && san.furniture.length === 1 && san.furniture[0].uid === 'f-3' && san.furniture[0].defId === 'furn_crate' && san.furnitureStorage.length === 0 && san.presets[0].name === '프리셋' && san.presets[0].implant === null, `corrupt save sanitised: lab→empty, gen clamped, bad rooms / purpose / overlap dropped (${JSON.stringify({ r0: san.rooms[0], g: san.generatorLevel, f: san.furniture, s: san.furnitureStorage.length, p: san.presets[0] })})`);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
