// Single-player smoke test for ship housing (src/housing): state load, room purposes, furniture placement rules,
// facility upgrades + generator gating, stash size, furniture craft / upgrade, presets, persistence across a reload,
// and the three DOM panels (blocker + Esc). Drives `ctx.housing` from page.evaluate.
// Phase 7 (2026-09-06): `furn_sim_hub` (15th def, 사격장 only) crafted / placed / listed in the room menu; server profile
// document `ship` (save → `profile.set`, `net:profileLoaded` replace + `housing:loaded` re-emit, stash size follows).
// Phase 9: v3 fresh state (`books` / `bookDex`), `furn_bookshelf` in the 서재 catalogue, offline `profile.set`. The 서재
// mechanics themselves are covered by scripts/smoke-library.mjs.
// Usage: node scripts/smoke-housing.mjs [http://localhost:5273]   (needs `npm run dev`)
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket (another agent's save would full-reload the page) AND the relay socket (`/ws?t=`): this is a
  // single-player script — a relay that happens to run on 8787 would otherwise hand the page a server profile and
  // make credits / documents server-owned mid-run. `ctx.net.profile.available` stays false, as documented.
  await quietViteHmr(page, { parkRelay: true });
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
        'housing:stashSizeChanged', 'housing:presetApplied', 'ui:housingToggled', 'housing:shipManageChanged',
        'game:paused']) {
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
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await setup();
  // 2026-09-07: a fresh stash is granted the 기본 지급품 — empty it again so the material counts below are exact
  await page.evaluate(() => { const st = window.__game.getSystem('inventory').getStash(); for (const p of st.items()) st.remove(p.item.uid); });

  console.log('fresh state');
  const st0 = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  // 2026-09-07: a new ship is ten **empty** rooms with no furniture — the built-in 작업실 + its two benches are gone
  ok(st0.rooms.length === 10 && st0.rooms.every((r) => r.purpose === 'empty' && r.level === 0), 'fresh state: all ten rooms empty');
  ok(st0.generatorLevel === 0 && st0.storageLevel === 0 && st0.presets.length === 0 && st0.furnitureStorage.length === 0, 'fresh state: gen 0 / storage 0 / no presets / empty furniture storage');
  ok(st0.furniture.length === 0, `first run: no 총기 작업대 / 정비 벤치 placed (${st0.furniture.length})`);
  ok(await H(() => window.__game.ctx.housing.findRoom('workshop') === -1 && window.__game.ctx.housing.getFacility('workshop').level === 0
    && window.__game.ctx.housing.getBenchLevel('gun') === 0), 'no 작업실 facility and no bench on a fresh ship');
  const stash0 = await H(() => window.__game.ctx.housing.getStashSize());
  ok(stash0.cols === 10 && stash0.rows === 24, `getStashSize() 10×24 at storage 0 (${stash0.cols}×${stash0.rows})`);
  /* Phase 8 added furn_repair_bench (작업실) and furn_grow_rack (온실); Phase 9 furn_bookshelf (서재); 2026-09-10
     furn_bench_refine (정제). **2026-09-11 (온실 개편)**: the count is no longer asserted — `furn_grow_rack` is
     `retired` and whether `getAllFurnitureDefs` still carries a retired def is housing/'s business (only
     `getFurnitureFor` is contractually filtered). Presence of the defs that matter is what this line guards now. */
  const furnDefIds = await H(() => window.__game.ctx.housing.getAllFurnitureDefs().map((d) => d.id));
  ok(['furn_bench_gun', 'furn_bench_refine', 'furn_sim_hub', 'furn_repair_bench', 'furn_bookshelf', 'furn_grow_station']
    .every((id) => furnDefIds.includes(id)) && furnDefIds.length >= 19,
  `FURNITURE_DEFS exposed (${furnDefIds.length}, incl. furn_sim_hub / repair_bench / bookshelf / bench_refine / grow_station)`, furnDefIds.join(','));
  // SHIP_STATE_VERSION (src/shared/constants.ts): 4 = 온실 개편의 `grows`, 5 = 연구실의 `analyses`/`sampleDex`, 6 = 배양조의 `cultures`
  ok(st0.version === 6 && Array.isArray(st0.books) && st0.books.length === 0 && Array.isArray(st0.bookDex) && st0.bookDex.length === 0, `fresh state is v6 with empty books / bookDex (v${st0.version})`);
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('library').some((d) => d.id === 'furn_bookshelf' && d.interaction === 'bookshelf') && !window.__game.ctx.housing.getFurnitureFor('workshop').some((d) => d.id === 'furn_bookshelf')), 'furn_bookshelf in the 서재 catalogue only');
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('range').some((d) => d.id === 'furn_sim_hub' && d.interaction === 'sim_hub' && d.model === 'sim_hub') && !window.__game.ctx.housing.getFurnitureFor('workshop').some((d) => d.id === 'furn_sim_hub')), 'furn_sim_hub in the 사격장 catalogue only (interaction / model sim_hub)');
  // Phase 8: workshop also accepts the 정비 벤치, and 온실 accepts the 재배 스테이션 (2026-09-11: 옛 재배층 자리를 그대로 이어받았다)
  // 2026-09-11 (A-14 · A-3c): 온실에 배양조가 늘어 9 → 10, 새로 열린 주방은 조리대 + 식탁 + 8 any = 10
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').length === 14 && window.__game.ctx.housing.getFurnitureFor('empty').length === 8 && window.__game.ctx.housing.getFurnitureFor('greenhouse').length === 10 && window.__game.ctx.housing.getFurnitureFor('kitchen').length === 10), 'getFurnitureFor: workshop 14 (5 benches + 정비 벤치 + 8 any), empty 8, greenhouse 10 (+배양조), kitchen 10 (조리대 + 식탁 + 8 any)');
  /* 아래 화면 검사들은 이 수를 **그때그때 물어서** 쓴다 — 작업대가 하나 늘 때마다 세 자리를 손으로 고치던 것이
     2026-09-10 정제 작업대에서 실제로 red 를 냈다. 위 한 줄만 카나리아로 남긴다. */
  const workshopFurniture = await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').length);
  ok(await H(() => window.__game.ctx.housing.getPresetCount() === 0 && window.__game.ctx.housing.getCraftCostMul() === 1 && window.__game.ctx.housing.getSkillGainMul('gun_AR') === 1), 'no rooms: 0 presets, cost ×1, skill ×1');
  // `housing:loaded` fired inside init() before the recorder existed; the saved file proves the fresh state was written
  await sleep(500);
  ok(await H(() => !!localStorage.getItem('scav.s1.ship')), 'fresh state saved to localStorage (scav.s1.ship)');

  console.log('hub');
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.5);

  console.log('room purposes');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'lab') === false), 'lab refused without a greenhouse');
  // 2026-09-07: the 작업실 is an ordinary purpose — it may go in any room, and the ship starts without one.
  // The placement / facility checks below want one, so seed room 1 the way a player would build it.
  ok(await H(() => /발전기/.test(window.__game.ctx.housing.purposeBlock(3, 'workshop') ?? '')), '작업실 is buildable in any room (only the 발전기 gate refuses it here)');
  await H(() => {
    const h = window.__game.ctx.housing;
    h.state.rooms[0] = { purpose: 'workshop', level: 1 };
    h.state.furnitureStorage.push({ defId: 'furn_bench_gun', level: 1, qty: 1 }, { defId: 'furn_repair_bench', level: 1, qty: 1 });
    h.place(0, 'furn_bench_gun', 0, 0, 0);
    h.place(0, 'furn_repair_bench', 0, 3, 0);
  });
  ok(await H(() => window.__game.ctx.housing.getPlaced(0).length === 2 && window.__game.ctx.housing.getStored().length === 0), 'seeded 방 1 = 작업실 with both benches placed');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'workshop') === false && /하나만/.test(window.__game.ctx.housing.purposeBlock(3, 'workshop') ?? '')), 'a second 작업실 is refused (one facility room per ship)');
  ok(await H(() => window.__game.ctx.housing.purposeBlock(0, 'empty') === null), '빈 방 is always allowed (the 작업실 is no longer locked)');
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
  // start the placement checks from an empty 작업실: the two seeded benches go back to furniture storage
  await H(() => { const h = window.__game.ctx.housing; for (const f of [...h.getPlaced(0)]) h.recover(f.uid); });
  ok(await H(() => window.__game.ctx.housing.getPlaced(0).length === 0 && window.__game.ctx.housing.getStored().length === 2), 'benches recovered into furniture storage');
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
  ok(await H(() => /회수/.test(window.__game.ctx.housing.purposeBlock(0, 'range') ?? '')), 'the block names the furniture to recover first');

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
  // 2026-09-08: 임플란트 아이템도 로드아웃의 일부 — captureLoadout 이 def id 배열을 함께 들고 온다
  ok(cap === null || Array.isArray(cap.implantItems), 'captureLoadout carries implantItems (임플란트 아이템 def ids)', JSON.stringify(cap && cap.implantItems));
  const impPreset = await H(() => {
    const h = window.__game.ctx.housing;
    h.savePreset(2, { name: '임플란트', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: null, implantItems: ['imp_strength_1', 5, '', 'imp_endurance_1'] });
    return h.getPresets()[2];
  });
  ok(Array.isArray(impPreset?.implantItems) && impPreset.implantItems.join(',') === 'imp_strength_1,imp_endurance_1',
    'savePreset keeps implantItems and drops non-string entries', JSON.stringify(impPreset?.implantItems));
  ok(await H(() => window.__game.ctx.housing.getPresets()[1]?.implantItems === undefined || Array.isArray(window.__game.ctx.housing.getPresets()[1].implantItems)),
    'a preset saved without implantItems keeps the field absent (older saves are left alone)');
  await H(() => window.__game.ctx.housing.deletePreset(2));
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

  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'workshop') === false && /하나만/.test(window.__game.ctx.housing.purposeBlock(7, 'workshop') ?? '')), 'second 작업실 refused (방 1 already has it)');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'range') === false), 'second 사격장 refused');

  /* ══ 온실 개편 — 재배 스테이션 (2026-09-11, 사용자 결정) ═══════════════════════════════════════════════════
     옛 재배층(`furn_grow_rack`, 스택 4층 × 4칸 · `getPlots` / `plantSeed`)은 **은퇴**했고, 한 대의 재배 스테이션
     (`furn_grow_station`, maxLevel 3)의 **레벨이 재배층을 연다**: Lv.1 중앙 · Lv.2 아래 · Lv.3 위, 층당
     `GROW_SLOTS_PER_TIER`(3)칸. 칸은 **토양을 먼저 붓고**(`fillSoil`) 그 위에 심는다(`plantSeedAt`) — 궁합이 맞으면
     `SOIL_MATCH_SPEEDUP` 만큼 빨리, 아니면 `SOIL_MISMATCH_PENALTY` 만큼 늦게 여물고, 토양은 수확마다 1회 닳는다.
     방 4(index 3)가 위에서 온실이 됐으므로 거기에 세운다. */
  console.log('온실 재배 스테이션 (2026-09-11)');
  const growCat = await H(() => {
    const h = window.__game.ctx.housing;
    const gh = h.getFurnitureFor('greenhouse');
    const rack = h.getFurnitureDef('furn_grow_rack');
    const st = h.getFurnitureDef('furn_grow_station');
    return {
      rackRetired: rack ? rack.retired === true : null,
      rackListed: gh.some((d) => d.id === 'furn_grow_rack'),
      rackAnywhere: ['greenhouse', 'workshop', 'empty', 'lab', 'range', 'library', 'lounge', 'gym', 'kitchen', 'mining']
        .some((p) => h.getFurnitureFor(p).some((d) => d.id === 'furn_grow_rack')),
      station: st ? { room: st.room, model: st.model, interaction: st.interaction, maxLevel: st.maxLevel, upgrades: st.upgradeCost.length, stack: st.stackLimit ?? 1 } : null,
      stationListed: gh.some((d) => d.id === 'furn_grow_station'),
    };
  });
  ok(growCat.rackRetired === true && !growCat.rackAnywhere,
    '옛 재배층은 retired — 어떤 방 용도의 가구 목록에도 나오지 않는다', JSON.stringify(growCat));
  ok(growCat.stationListed && growCat.station?.room === 'greenhouse' && growCat.station?.model === 'grow_station'
    && growCat.station?.interaction === 'grow_station' && growCat.station?.maxLevel === 3 && growCat.station?.upgrades === 2 && growCat.station?.stack === 1,
  `재배 스테이션: 온실 전용 · model/interaction grow_station · maxLevel 3 (강화 2단계) · 스택 없음 (${JSON.stringify(growCat.station)})`);

  const growApi = await H(() => {
    const h = window.__game.ctx.housing;
    return ['getGrowSlots', 'fillSoil', 'clearSoil', 'plantSeedAt', 'harvestAt', 'harvestAllStation', 'getOwnedSoils', 'openGrowStation']
      .filter((k) => typeof h[k] !== 'function');
  });
  ok(growApi.length === 0, 'HousingRef 재배 스테이션 API 8종', `missing: ${growApi.join(', ')}`);
  if (growApi.length === 0) {
    // 제작(폐금속 8 · 케이블 2 · 생체 조직 3) + 검사들이 쓰는 토양 · 씨앗. 강화 재료는 강화 직전에 따로 준다.
    await give('mat_scrap', 16); await give('mat_cable', 6);
    const bio = await give('mat_bio_sample', 8);
    const soilM = await give('soil_mineral', 4);           // 광물 · 수확 5회 (rare) — 4번 붓는다
    const soilH = await give('soil_humus', 2);             // 부엽토 · 수확 2회 (common) — 닳아 없어지는 것을 짧게 본다
    const seedM = await give('seed_tuber', 2);             // soilTag mineral, 1 h → crop_tuber
    const seedH = await give('seed_beanpod', 4);           // soilTag humus,   1 h → crop_beanpod
    ok(bio >= 3 && soilM === 4 && soilH >= 1 && seedM >= 2 && seedH >= 3,
      `토양 · 씨앗 아이템 준비 (광물 ${soilM} · 부엽토 ${soilH} · 덩이줄기 ${seedM} · 콩깍지 ${seedH})`, JSON.stringify({ bio, soilM, soilH, seedM, seedH }));
    const owned = await H(() => window.__game.ctx.housing.getOwnedSoils());
    ok(owned.some((s) => s.defId === 'soil_mineral' && s.qty === 4) && owned.some((s) => s.defId === 'soil_humus' && s.qty >= 1)
      && !owned.some((s) => s.defId.startsWith('seed_')), `getOwnedSoils: 토양만 (${JSON.stringify(owned)})`);

    const gs = await H(() => {
      const h = window.__game.ctx.housing;
      const made = h.craftFurniture('furn_grow_station');
      const p = made ? h.place(3, 'furn_grow_station', 0, 0, 0) : null;
      return { made, uid: p?.uid ?? null, level: p?.level ?? 0, room: p?.room ?? -1 };
    });
    ok(gs.made && gs.uid && gs.level === 1 && gs.room === 3, `재배 스테이션 제작 → 온실(방 4) 배치 (${gs.uid})`, JSON.stringify(gs));
    const GS = gs.uid;
    ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_grow_station', 0, 0, 0) === false), '작업실에는 놓을 수 없다 (온실 전용)');

    /* ── 층 잠금: Lv.1 이면 9칸 중 중앙 3칸만 열려 있다 ── */
    const slots1 = await H((uid) => window.__game.ctx.housing.getGrowSlots(uid), GS);
    ok(slots1.length === 9, `getGrowSlots → 3층 × 3칸 = 9칸을 늘 돌려준다 (${slots1.length})`);
    ok(slots1.filter((s) => !s.locked).length === 3 && slots1.filter((s) => !s.locked).every((s) => s.tier === 0),
      'Lv.1 = 중앙 재배층(tier 0) 3칸만 열림', JSON.stringify(slots1.map((s) => `${s.tier}/${s.slot}${s.locked ? 'L' : ''}`)));
    ok(slots1.filter((s) => s.tier === 1).every((s) => s.locked && s.unlockLevel === 2)
      && slots1.filter((s) => s.tier === 2).every((s) => s.locked && s.unlockLevel === 3),
    '잠긴 층은 자기를 여는 레벨을 적는다 (아래 2 · 위 3)');
    ok(slots1.slice(0, 3).every((s) => s.tier === 2) && slots1.slice(3, 6).every((s) => s.tier === 0) && slots1.slice(6, 9).every((s) => s.tier === 1),
      'GROW_TIER_DRAW_ORDER 순서로 온다 (위 → 중앙 → 아래)');
    ok(slots1.filter((s) => !s.locked).every((s) => s.soilDefId === null && s.soilTag === null && s.seedDefId === null && s.progress === -1 && !s.ready),
      '새 칸은 흙도 씨앗도 없다', JSON.stringify(slots1[3]));
    ok(await H((uid) => window.__game.ctx.housing.getGrowSlots(`${uid}-nope`).length === 0, GS), '재배 스테이션이 아닌 uid → 빈 배열');

    /* ── 토양이 먼저다 ── */
    ok(typeof await H((uid) => window.__game.ctx.housing.plantSeedAt(uid, 0, 0, 'seed_tuber'), GS) === 'string',
      '토양 없이 심으면 거부된다 (한국어 사유)');
    ok(await H(() => window.__game.ctx.inventory.countDefAll('seed_tuber')) === seedM, `거부된 파종은 씨앗을 먹지 않는다 (${seedM}개 그대로)`);
    ok(typeof await H((uid) => window.__game.ctx.housing.fillSoil(uid, 1, 0, 'soil_mineral'), GS) === 'string',
      '잠긴 층(아래)에는 흙을 부을 수 없다');
    ok(typeof await H((uid) => window.__game.ctx.housing.fillSoil(uid, 0, 0, 'seed_tuber'), GS) === 'string', '토양이 아닌 아이템은 부을 수 없다');
    ok(await H((uid) => window.__game.ctx.housing.fillSoil(uid, 0, 0, 'soil_mineral'), GS) === null, 'fillSoil(중앙 0, 광물토)');
    ok(await H(() => window.__game.ctx.inventory.countDefAll('soil_mineral')) === soilM - 1, `부은 토양 1개가 소모된다 (${soilM} → ${soilM - 1})`);
    const filled = await H((uid) => window.__game.ctx.housing.getGrowSlots(uid).find((s) => s.tier === 0 && s.slot === 0), GS);
    ok(filled.soilDefId === 'soil_mineral' && filled.soilTag === 'mineral' && filled.soilUsesLeft === 5 && filled.seedDefId === null,
      `흙만 채워진 칸 = 심을 준비 (수확 5회 남음) (${JSON.stringify(filled)})`);
    ok(typeof await H((uid) => window.__game.ctx.housing.fillSoil(uid, 0, 0, 'soil_humus'), GS) === 'string', '이미 흙이 있는 칸에는 다시 못 붓는다');
    ok(await H((uid) => window.__game.ctx.housing.clearSoil(uid, 0, 0), GS) === null, 'clearSoil 로 칸을 비운다');
    ok(await H((uid) => window.__game.ctx.housing.getGrowSlots(uid).find((s) => s.tier === 0 && s.slot === 0).soilDefId === null, GS), '비운 칸은 흙 없음');
    ok(await H(() => window.__game.ctx.inventory.countDefAll('soil_mineral')) === soilM - 1, '긁어낸 흙은 돌려주지 않는다 — 남은 횟수가 있어도 버려진다 (사용자 결정)');

    /* ── 궁합: 맞는 토양이 안 맞는 토양보다 빨리 여문다 ── */
    const soilConst = await H(async () => { const S = await import('/src/shared/index.ts'); return { match: S.SOIL_MATCH_SPEEDUP, miss: S.SOIL_MISMATCH_PENALTY }; });
    const grew = await H((uid) => {
      const h = window.__game.ctx.housing;
      const r = { fill: [], plant: [] };
      r.fill.push(h.fillSoil(uid, 0, 0, 'soil_mineral'), h.fillSoil(uid, 0, 1, 'soil_mineral'));
      r.plant.push(h.plantSeedAt(uid, 0, 0, 'seed_tuber'));      // mineral × mineral = 궁합
      r.plant.push(h.plantSeedAt(uid, 0, 1, 'seed_beanpod'));    // humus  × mineral = 불일치 (둘 다 growHours 1)
      const raw = (h.state.grows ?? []).filter((g) => g.uid === uid);
      r.dur = raw.map((g) => ({ tier: g.tier, slot: g.slot, seed: g.seedDefId, ms: g.readyAt - g.plantedAt }));
      r.info = h.getGrowSlots(uid).filter((s) => !s.locked).map((s) => ({ slot: s.slot, seed: s.seedDefId, seedTag: s.seedTag, matched: s.matched, ready: s.ready, progress: s.progress }));
      return r;
    }, GS);
    ok(grew.fill.every((v) => v === null) && grew.plant.every((v) => v === null), `흙 2칸 + 파종 2칸 (${JSON.stringify(grew.plant)})`);
    const dMatch = grew.dur.find((d) => d.seed === 'seed_tuber')?.ms ?? 0;
    const dMiss = grew.dur.find((d) => d.seed === 'seed_beanpod')?.ms ?? 0;
    ok(dMatch > 0 && dMiss > 0 && dMatch < dMiss, `궁합이 맞는 칸의 readyAt 이 더 빠르다 (${Math.round(dMatch / 1000)}s < ${Math.round(dMiss / 1000)}s)`);
    ok(Math.abs(dMatch / dMiss - (1 - soilConst.match) / (1 + soilConst.miss)) < 0.01,
      `비율이 SOIL_MATCH_SPEEDUP / SOIL_MISMATCH_PENALTY 그대로 (${(dMatch / dMiss).toFixed(3)} ≈ ${((1 - soilConst.match) / (1 + soilConst.miss)).toFixed(3)})`);
    const info0 = grew.info.find((s) => s.slot === 0), info1 = grew.info.find((s) => s.slot === 1);
    ok(info0?.matched === true && info0?.seedTag === 'mineral' && info1?.matched === false && info1?.seedTag === 'humus',
      `GrowSlotInfo.matched / seedTag (${JSON.stringify([info0, info1])})`);
    ok(info0 && info0.progress >= 0 && info0.progress < 1 && !info0.ready, '심은 칸은 progress 0…1 이고 아직 여물지 않았다');
    ok(typeof await H((uid) => window.__game.ctx.housing.plantSeedAt(uid, 0, 0, 'seed_tuber'), GS) === 'string', '이미 심긴 칸에는 못 심는다');
    ok(typeof await H((uid) => window.__game.ctx.housing.clearSoil(uid, 0, 0), GS) === 'string', '심긴 칸의 흙은 긁어낼 수 없다');
    ok(typeof await H((uid) => window.__game.ctx.housing.harvestAt(uid, 0, 0), GS) === 'string', '덜 자란 칸은 수확되지 않는다');

    /* ── 시계를 앞당겨 수확: 토양이 1회 닳는다 ── */
    const ripen = (uid) => H((u) => { for (const g of (window.__game.ctx.housing.state.grows ?? [])) if (g.uid === u && g.readyAt) g.readyAt = Date.now() - 1000; }, uid);
    await ripen(GS);
    const cropBefore = await count('crop_tuber');
    ok(await H((uid) => window.__game.ctx.housing.harvestAt(uid, 0, 0), GS) === null, 'harvestAt(중앙 0)');
    const afterHarvest = await H((uid) => window.__game.ctx.housing.getGrowSlots(uid).find((s) => s.tier === 0 && s.slot === 0), GS);
    ok((await count('crop_tuber')) > cropBefore, `수확물 crop_tuber 가 가방으로 (${cropBefore} → ${await count('crop_tuber')})`);
    ok(afterHarvest.seedDefId === null && afterHarvest.soilDefId === 'soil_mineral' && afterHarvest.soilUsesLeft === 4,
      `수확 뒤 씨앗만 빠지고 soilUsesLeft 가 1 줄어든다 (5 → ${afterHarvest.soilUsesLeft})`, JSON.stringify(afterHarvest));
    ok(await H((uid) => window.__game.ctx.housing.harvestAllStation(uid), GS) === 1, 'harvestAllStation → 여문 나머지 한 칸(불일치)도 거둔다');
    ok(await H((uid) => window.__game.ctx.housing.getGrowSlots(uid).filter((s) => !s.locked && s.seedDefId !== null).length === 0, GS), '여문 칸이 남지 않았다');

    /* ── 다 닳으면 칸이 빈다: 부엽토(수확 2회)를 두 번 쓴다 ── */
    const drain = await H(async (uid) => {
      const h = window.__game.ctx.housing;
      const seq = [];
      seq.push(h.fillSoil(uid, 0, 2, 'soil_humus'));
      for (let i = 0; i < 2; i++) {
        seq.push(h.plantSeedAt(uid, 0, 2, 'seed_beanpod'));
        for (const g of (h.state.grows ?? [])) if (g.uid === uid && g.tier === 0 && g.slot === 2 && g.readyAt) g.readyAt = Date.now() - 1000;
        seq.push(h.harvestAt(uid, 0, 2));
        seq.push(h.getGrowSlots(uid).find((s) => s.tier === 0 && s.slot === 2).soilUsesLeft);
      }
      const end = h.getGrowSlots(uid).find((s) => s.tier === 0 && s.slot === 2);
      return { seq, end, rows: (h.state.grows ?? []).filter((g) => g.uid === uid && g.tier === 0 && g.slot === 2).length };
    }, GS);
    ok(drain.seq[0] === null && drain.seq[1] === null && drain.seq[2] === null && drain.seq[3] === 1,
      `부엽토 수확 1회 → 남은 횟수 2 → 1 (${JSON.stringify(drain.seq.slice(0, 4))})`);
    ok(drain.end.soilDefId === null && drain.end.soilUsesLeft === 0 && drain.end.seedDefId === null && drain.rows === 0,
      '마지막 수확에서 흙이 다 닳으면 칸이 통째로 빈다 (state.grows 에서도 사라진다)', JSON.stringify(drain));

    /* ── 강화가 층을 연다 (발전기 게이트는 이 검사의 대상이 아니므로 직접 올린다) ── */
    await H(() => { window.__game.ctx.housing.state.generatorLevel = 5; });
    await give('mat_scrap', 12); await give('mat_cable', 8); await give('mat_circuit', 4); await give('mat_alloy', 8); await give('mat_bio_sample', 14);
    ok(await H((uid) => window.__game.ctx.housing.upgradeFurniture(uid), GS) === true, '재배 스테이션 → Lv.2');
    const lv2 = await H((uid) => window.__game.ctx.housing.getGrowSlots(uid), GS);
    ok(lv2.filter((s) => !s.locked).length === 6 && lv2.filter((s) => s.tier === 1).every((s) => !s.locked) && lv2.filter((s) => s.tier === 2).every((s) => s.locked),
      'Lv.2 → 아래 재배층이 열린다 (6칸, 윗층은 그대로 잠김)');
    ok(await H((uid) => window.__game.ctx.housing.fillSoil(uid, 1, 0, 'soil_mineral'), GS) === null, '열린 아래층에는 흙을 부을 수 있다');
    ok(await H((uid) => window.__game.ctx.housing.upgradeFurniture(uid), GS) === true, '재배 스테이션 → Lv.3');
    const lv3 = await H((uid) => window.__game.ctx.housing.getGrowSlots(uid), GS);
    ok(lv3.filter((s) => !s.locked).length === 9 && lv3.every((s) => !s.locked), 'Lv.3 → 윗 재배층까지 9칸 전부 열린다');
    ok(lv3.find((s) => s.tier === 1 && s.slot === 0)?.soilDefId === 'soil_mineral',
      '강화는 tier 번호를 바꾸지 않는다 — 아래층에 부어 둔 흙이 그 자리에 그대로 있다');
    ok(await H((uid) => window.__game.ctx.housing.upgradeFurniture(uid), GS) === false, 'Lv.3 이 최대');
    /* 2026-09-11: 옛 API 는 계약에 남아 있지만 "없는 재배층" 만 답한다 */
    ok(await H((uid) => window.__game.ctx.housing.getPlots(uid).length === 0 && window.__game.ctx.housing.harvestAll(uid) === 0
      && typeof window.__game.ctx.housing.plantSeed(uid, 0, 'seed_tuber') === 'string', GS),
    '@deprecated 재배층 API 는 재배 스테이션에 대해 "없는 재배층" 으로 답한다 (getPlots [] · plantSeed 사유 · harvestAll 0)');
  } else {
    console.log('  TODO(lead): housing/ 의 재배 스테이션 구현이 아직 없다 — 재배 검사 전부 건너뜀');
  }

  /* ── 아이템 툴팁의 토양 · 씨앗 줄 (`src/ui/hud/ItemTip`, 2026-09-11) ──
     `.item-chip[data-def-id]` 하나를 `ctx.uiRoot` 에 잠깐 붙여 delegated pointerover 를 태운다 — 재배 화면이
     아니라 툴팁 자체를 보는 검사라 어느 화면에서 열든 같다. 속성 값은 `SOIL_TAG_COLOR` 로 **인라인**으로만 칠한다. */
  console.log('아이템 툴팁 — 토양 · 씨앗');
  const tip = await H((ids) => {
    const ctx = window.__game.ctx;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:8px;top:8px;';
    ctx.uiRoot.appendChild(host);
    const read = (id) => {
      host.replaceChildren();
      const chip = document.createElement('span');
      chip.className = 'item-chip';
      chip.dataset.defId = id;
      host.appendChild(chip);
      chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 20, clientY: 20 }));
      const card = document.querySelector('.item-tip');
      const ks = [...card.querySelectorAll('.it-stats .k')].map((e) => e.textContent);
      const vs = [...card.querySelectorAll('.it-stats .v')].map((e) => ({ t: e.textContent, c: e.style.color }));
      const row = (k) => vs[ks.indexOf(k)] ?? null;
      return {
        hidden: card.hidden, ks,
        tag: row('속성'), uses: row('수확')?.t ?? null, seedSoil: row('맞는 토양'), grow: row('재배 시간')?.t ?? null,
        weight: card.querySelector('.it-value .wt .v')?.textContent ?? '', value: card.querySelector('.it-value .val .v')?.textContent ?? '',
        valueHidden: card.querySelector('.it-value').hidden,
      };
    };
    const out = {};
    for (const id of ids) out[id] = read(id);
    host.remove();
    return out;
  }, ['soil_mineral', 'seed_tuber', 'mat_scrap']);
  const soilTip = tip.soil_mineral, seedTip = tip.seed_tuber, matTip = tip.mat_scrap;
  ok(!soilTip.hidden && soilTip.tag?.t === '광물' && !!soilTip.tag?.c && soilTip.uses === '5 회',
    `토양 툴팁: 속성 ${soilTip.tag?.t} (색 ${soilTip.tag?.c}) · 수확 ${soilTip.uses}`, JSON.stringify(soilTip));
  ok(!seedTip.hidden && seedTip.grow === '1 시간' && seedTip.seedSoil?.t === '광물' && seedTip.seedSoil?.c === soilTip.tag?.c,
    `씨앗 툴팁: 재배 시간 + 맞는 토양 ${seedTip.seedSoil?.t} (토양 아이템과 같은 색)`, JSON.stringify(seedTip));
  ok(![soilTip, seedTip, matTip].some((t) => t.ks.includes('크기')) && !soilTip.valueHidden && /kg$/.test(soilTip.weight) && /C$/.test(soilTip.value),
    '툴팁 규약은 그대로 — 크기 줄 없음 · 무게 좌하단 · 가치 우하단', JSON.stringify({ w: soilTip.weight, v: soilTip.value }));
  ok(!matTip.ks.includes('속성') && !matTip.ks.includes('맞는 토양'), '토양 · 씨앗이 아닌 아이템에는 새 줄이 붙지 않는다', JSON.stringify(matTip.ks));

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
  ok(smDom.cards === workshopFurniture && smDom.purposes === 0 && /작업실/.test(smDom.head), `가구 목록 for the 작업실 (${smDom.cards} cards, '${smDom.head}')`);
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
  ok(smTabs.tabs === '가구 제작* 가구 창고' && !smTabs.tabsHidden && smTabs.craftBtns === workshopFurniture && smTabs.storeHidden,
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
  /* 2026-09-09: 창고 카드 클릭은 선택만, 배치는 카드 오른쪽 `배치` 버튼(.fcard-place)이 첫 빈 칸에 곧바로 놓는다.
     맞지 않는 카드(`is-blocked`)와 자리가 없는 카드는 버튼이 꺼지고 `.fcard-note` 가 사유(`<용도> 전용` / `자리 없음`)를 적는다. */
  const smPlace = await H(() => {
    const root = document.querySelector('.ship-manage');
    const cards = [...root.querySelectorAll('.sm-store .fcard')];
    const notes = cards.map((c) => c.querySelector('.fcard-note')?.textContent ?? '');
    return {
      rows: cards.length, btns: cards.filter((c) => c.querySelector('.fcard-place')).length,
      notesOk: notes.every((n) => n === '배치 가능' || n === '자리 없음' || / 전용$/.test(n)),
      blockedOff: cards.filter((c) => c.classList.contains('is-blocked')).every((c) => c.querySelector('.fcard-place').disabled),
      fullOff: cards.filter((c) => (c.querySelector('.fcard-note')?.textContent ?? '') === '자리 없음').every((c) => c.querySelector('.fcard-place').disabled),
      first: cards.find((c) => !c.classList.contains('is-blocked') && !c.querySelector('.fcard-place').disabled)?.dataset.defId ?? null,
    };
  });
  ok(smPlace.btns === smPlace.rows && smPlace.notesOk && smPlace.blockedOff && smPlace.fullOff,
    `every store row has a 배치 button; blocked / full rows have it disabled with a reason (${smPlace.rows})`, JSON.stringify(smPlace));
  if (smPlace.first) {
    const before = await H((id) => {
      const h = window.__game.ctx.housing;
      return { placed: h.getPlaced(0).length, stored: h.getStored().filter((s) => s.defId === id).reduce((n, s) => n + s.qty, 0) };
    }, smPlace.first);
    await H((id) => document.querySelector(`.ship-manage .sm-store .fcard[data-def-id="${id}"]`).click(), smPlace.first);
    await sleep(120);
    const sel = await H((id) => ({
      ghost: window.__game.ctx.housing.selectedFurniture,
      hl: document.querySelector(`.ship-manage .sm-store .fcard[data-def-id="${id}"]`)?.classList.contains('is-sel') ?? null,
    }), smPlace.first);
    ok(sel.ghost === null && sel.hl === true, `clicking a store card only highlights it — no ghost on the cursor (${smPlace.first})`, JSON.stringify(sel));
    await H(() => { window.__ev['housing:furniturePlaced'].length = 0; });
    await H((id) => document.querySelector(`.ship-manage .sm-store .fcard[data-def-id="${id}"] .fcard-place`).click(), smPlace.first);
    await sleep(160);
    const after = await H((id) => {
      const h = window.__game.ctx.housing;
      return { placed: h.getPlaced(0).length, stored: h.getStored().filter((s) => s.defId === id).reduce((n, s) => n + s.qty, 0) };
    }, smPlace.first);
    const placedEv = await lastEv('housing:furniturePlaced');
    ok(after.placed === before.placed + 1 && after.stored === before.stored - 1 && placedEv?.item?.defId === smPlace.first && placedEv?.item?.room === 0,
      `배치 → the piece lands in 방 1 on the first free cell, storage −1, housing:furniturePlaced (${smPlace.first} @ ${placedEv?.item?.x},${placedEv?.item?.y} yaw ${placedEv?.item?.yaw})`,
      JSON.stringify({ before, after, placedEv }));
    // put the piece back so the rest of the run sees the storage it expects
    await H((uid) => window.__game.ctx.housing.recover(uid), placedEv?.item?.uid ?? '');
    await sleep(120);
  } else {
    ok(true, 'no placeable store row in 방 1 right now — 배치 click-through skipped', JSON.stringify(smPlace));
  }
  /* 2026-09-11 (C-27): 자동 배치 2차 패스 — 문 앞 여유 구역을 피해서는 자리가 없을 때만 구역 안을 쓰되, 문 폭 4칸 중
     인접 2칸은 깊이 전부 비워 둔다. 규칙은 순수 함수라 실제 함선을 건드리지 않고 합성 상태로 검사한다 (우현 방 5 = 문이 x 0 쪽). */
  const autoPlace2 = await H(async () => {
    const R = await import('/src/housing/Rules.ts');
    const S = await import('/src/shared/index.ts');
    const COLS = S.ROOM_GRID_COLS, ROWS = S.ROOM_GRID_ROWS;
    const room = 5;
    const door = R.doorClearanceCell(room);
    const inZone = (x, y) => x >= door.x && x < door.x + R.DOOR_CLEAR_DEPTH && y >= door.y && y < door.y + R.DOOR_CLEAR_SPAN;
    const crate = S.FURNITURE_DEF_MAP.get('furn_crate');
    const mk = (furniture) => ({ rooms: Array.from({ length: S.SHIP_ROOM_COUNT }, () => ({ purpose: 'lounge', level: 1 })), furniture, storage: [] });
    let n = 0;
    const piece = (x, y) => ({ uid: `ap${n++}`, defId: 'furn_crate', room, x, y, yaw: 0, level: 1 });
    // ① 빈 방: 1차 패스 그대로 — 구역 밖
    const empty = R.autoPlaceSpot(mk([]), room, crate);
    // ② 구역 밖을 전부 채운다 → 2차 패스가 구역 안을 하나씩 내주다가 통로 두 줄이 남으면 멈춘다
    const full = [];
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (!inZone(x, y)) full.push(piece(x, y));
    const st = mk(full);
    const taken = [];
    for (let i = 0; i < 16; i++) {
      const spot = R.autoPlaceSpot(st, room, crate);
      if (!spot) break;
      taken.push([spot.x, spot.y]);
      st.furniture.push(piece(spot.x, spot.y));
    }
    const allInZone = taken.every(([x, y]) => inZone(x, y));
    const passageLeft = R.doorPassageOpen(st, room);
    // ③ 손으로 이미 통로를 막아 둔 방(인접 두 줄이 없다): 2차 패스는 아무것도 주지 않지만 `canPlaceAt` 은 그대로 허용한다
    const blocked = mk([...full, piece(door.x, door.y), piece(door.x, door.y + 2)]);
    const blockedSpot = R.autoPlaceSpot(blocked, room, crate);
    const manualStillOk = R.canPlaceAt(blocked, room, crate, door.x, door.y + 1, 0);
    return { empty, emptyOutside: !!empty && !inZone(empty.x, empty.y), taken, allInZone, passageLeft, blockedSpot, manualStillOk, span: R.DOOR_CLEAR_SPAN, depth: R.DOOR_CLEAR_DEPTH };
  });
  ok(autoPlace2.emptyOutside, `자동 배치 1차 패스: 빈 방에서는 문 앞 여유 구역 밖 (${JSON.stringify(autoPlace2.empty)})`);
  ok(autoPlace2.taken.length === (autoPlace2.span - 2) * autoPlace2.depth && autoPlace2.allInZone && autoPlace2.passageLeft,
    `자동 배치 2차 패스: 구역 밖이 꽉 차면 구역 안에 ${autoPlace2.taken.length}개를 놓고 문 폭 인접 2칸은 남긴다`, JSON.stringify(autoPlace2));
  ok(autoPlace2.blockedSpot === null && autoPlace2.manualStillOk,
    '자동 배치 2차 패스: 통로가 이미 막힌 방에서는 자리 없음 — canPlaceAt(손 배치)은 그대로', JSON.stringify(autoPlace2));
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
  /* 빈 방으로 — 2026-09-08: the header button used to call the **free** `setRoomPurpose(i, 'empty')` path, which
     housing only takes *after* `removeRoomFacility` has worked out a refund, so tearing a room down by mistake
     burned the 시설 증축 price and the player could not rebuild it. It goes through `removeRoomFacility` now (with a
     confirm popup showing the chips), and every material comes back. */
  const MATS = ['mat_scrap', 'mat_cable', 'mat_alloy', 'mat_circuit'];
  const spare = await H(() => {
    const h = window.__game.ctx.housing;
    for (let i = 0; i < 10; i++) if ((h.getRoom(i)?.purpose ?? 'empty') === 'empty') return i;
    return -1;
  });
  const spareP = spare < 0 ? null : await H((i) => {
    const h = window.__game.ctx.housing;
    for (const p of ['gym', 'lounge', 'kitchen', 'library', 'greenhouse']) if (!h.purposeBlock(i, p)) return p;
    return null;
  }, spare);
  const matsBefore = {};
  for (const d of MATS) matsBefore[d] = await count(d);
  const clrBuilt = spareP ? await H((a) => window.__game.ctx.housing.setRoomPurpose(a.i, a.p), { i: spare, p: spareP }) : false;
  ok(clrBuilt, `빈 방으로 준비: 방 ${spare + 1} → ${spareP} 증축`, JSON.stringify({ spare, spareP }));
  await H((i) => window.__game.ctx.housing.setManageRoom(i), spare);
  await sleep(140);
  await H(() => document.querySelector('.ship-manage .sm-clear').click());
  await sleep(140);
  const clrConf = await H(() => {
    const c = document.querySelector('.ship-manage .sm-confirm');
    return { open: !c.hidden, title: c.querySelector('.title').textContent, chips: c.querySelectorAll('.cost .item-chip').length };
  });
  ok(clrConf.open && /제거/.test(clrConf.title) && clrConf.chips > 0,
    '빈 방으로 asks first and shows the materials it hands back', JSON.stringify(clrConf));
  await H(() => document.querySelector('.ship-manage .sm-confirm .ui-btn.primary').click());
  await sleep(180);
  const matsAfter = {};
  for (const d of MATS) matsAfter[d] = await count(d);
  const clrPurpose = await H((i) => window.__game.ctx.housing.getRoom(i)?.purpose ?? null, spare);
  ok(clrPurpose === 'empty' && JSON.stringify(matsAfter) === JSON.stringify(matsBefore),
    '확인 → 방은 빈 방, 재료는 100% 함선 창고로 환급', JSON.stringify({ clrPurpose, matsBefore, matsAfter }));

  await H(() => window.__game.ctx.housing.openFacilityMenu());
  await sleep(120);
  ok(await H(() => window.__game.ctx.housing.shipManageMode === true), 'openFacilityMenu() also redirects to 시설 관리');
  await H(() => window.__game.ctx.housing.closeShipManage());
  await sleep(120);
  ok(await H(() => !window.__game.ctx.housing.shipManageMode && !window.__game.ctx.uiBlockers.has('shipmanage')
    && !document.querySelector('.ship-manage').classList.contains('show')), 'closeShipManage → screen hidden, shipmanage blocker released');
  ok(await H(() => window.__game.ctx.player.controlsEnabled !== false), 'player controls restored after 시설 관리');

  /* ── 2026-09-09: Tab · M · C leave 시설 관리 **without** opening the ESC 일시정지 메뉴 ──
     In the ship the only two routes into that menu are a real `Keys.MENU` press and `input:pointerLockLost`
     (`Input.onUserUnlock` → `game/parts/Phases.escapePause`). Leaving the mode releases the cursor owner and asks
     for the pointer lock back, which walks straight past that second route — so each exit key is checked here. */
  for (const [code, label] of [['Tab', 'Tab'], ['KeyM', 'M'], ['KeyC', 'C']]) {
    await H(() => { window.__game.ctx.housing.openShipManage(); window.__ev['game:paused'].length = 0; });
    await sleep(140);
    const opened = await H(() => window.__game.ctx.housing.shipManageMode);
    await tap(code);
    await sleep(220);
    const left = await H(() => ({
      manage: window.__game.ctx.housing.shipManageMode,
      blockers: [...window.__game.ctx.uiBlockers],
      paused: window.__ev['game:paused'].length,
      pause: !document.querySelector('.menu.pause')?.classList.contains('hidden'),
    }));
    ok(opened && !left.manage && !left.pause && left.paused === 0 && !left.blockers.includes('shipmanage'),
      `${label} 로 시설 관리를 닫아도 일시정지 메뉴가 뜨지 않는다`, JSON.stringify(left));
  }

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
  // 2026-09-11 (C-7): `openRoomMenu` 은 @deprecated — 리다이렉트는 위 두 단언이 확인하고, 나머지는 새 이름으로 연다
  await H(() => window.__game.ctx.housing.openShipManage(5));
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
    loaded: window.__ev['housing:loaded'].length, changed: window.__ev['housing:changed'][window.__ev['housing:changed'].length - 1], stash: window.__ev['housing:stashSizeChanged'][window.__ev['housing:stashSizeChanged'].length - 1], local: JSON.parse(localStorage.getItem('scav.s1.ship')).rooms[8].purpose, sets: window.__fakeProfile.sets.filter((k) => k === 'ship').length }));
  ok(srv.room8 === 'kitchen' && srv.storage === 2 && srv.crate.join() === 'f-90:furn_crate', 'net:profileLoaded → server ship document replaces the state (room 8 kitchen, storage 2, crate f-90)', JSON.stringify(srv));
  ok(srv.loaded === loadedN + 1 && srv.changed?.reason === 'profile', 'housing:loaded re-emitted + housing:changed {profile}', JSON.stringify({ loaded: srv.loaded, changed: srv.changed }));
  ok(srv.rows === 36 && srv.stash && srv.stash.rows === 36, 'stash size follows the server storage level (36 rows) + housing:stashSizeChanged', JSON.stringify({ rows: srv.rows, ev: srv.stash }));
  ok(srv.local === 'kitchen' && srv.sets === 1, 'localStorage cache updated, server copy not echoed back', JSON.stringify({ local: srv.local, sets: srv.sets }));
  const nextUid = await H(() => { const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); const p = h.place(8, 'furn_crate', 5, 5, 0); const uid = p?.uid; if (p) h.recover(p.uid); return uid; });
  ok(nextUid === 'f-91', `uid counter continues after the server copy's highest uid (${nextUid})`);
  /* 2026-09-11: an edit still inside the 350 ms save debounce is newer than any profile copy — a welcome landing in
     that window used to replace the state with the (older) document and cancel the write, silently undoing the edit
     (smoke-training's sim hub vanished under load). Now the edit is written (profile.set) and the state is kept. */
  const race = await H((snap) => {
    const h = window.__game.ctx.housing;
    h.save();                                                    // settle the place / recover above
    window.__fakeProfile.sets.length = 0;
    const setOk = h.setRoomPurpose(7, 'lounge');                  // dirty, not yet written
    const stale = JSON.parse(JSON.stringify(snap));              // the profile's copy predates the edit
    window.__fakeProfile.docs = { ship: stale };
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false });
    const r = { setOk, room7: h.getRoom(7).purpose, room8: h.getRoom(8).purpose, sets: window.__fakeProfile.sets.filter((k) => k === 'ship').length, uploaded: window.__fakeProfile.docs.ship?.rooms?.[7]?.purpose ?? null };
    h.setRoomPurpose(7, 'empty'); h.save();
    return r;
  }, shipSnap);
  ok(race.setOk && race.room7 === 'lounge' && race.room8 === 'kitchen' && race.sets === 1 && race.uploaded === 'lounge',
    'net:profileLoaded inside the save debounce keeps the unsaved edit and uploads it instead of reverting', JSON.stringify(race));
  // put the local state back through the same path (no edit pending), then restore the offline profile
  await H((snap) => { window.__game.ctx.housing.save(); window.__fakeProfile.docs = { ship: snap }; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false }); }, shipSnap);
  ok(await H(() => window.__game.ctx.housing.getRoom(8).purpose === 'lounge' && window.__game.ctx.housing.getPlaced(8).length === 0 && window.__game.ctx.housing.getStashSize().rows === 30), 'local state restored through net:profileLoaded');
  await H(() => { const net = window.__game.ctx.net; if (window.__realProfileDesc) Object.defineProperty(net, 'profile', window.__realProfileDesc); else delete net.profile; });
  ok(await H(() => window.__game.ctx.net.profile !== window.__fakeProfile && window.__game.ctx.net.profile.available === false), 'real (offline) profile restored');
  await H(() => window.__game.ctx.housing.setRoomPurpose(8, 'empty'));

  console.log('persistence');
  await H(() => window.__game.ctx.housing.savePreset(0, { name: '리로드', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: 'scan', implantItems: ['imp_strength_1'] }));
  await H(() => window.__game.ctx.housing.save());
  const before = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const after = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  ok(after.rooms[0].purpose === 'workshop' && after.rooms[5].purpose === 'range' && after.rooms[2].purpose === 'gym', 'room purposes persisted');
  ok(after.generatorLevel === before.generatorLevel && after.storageLevel === 1 && after.rooms[0].level === before.rooms[0].level, `facility levels persisted (gen ${after.generatorLevel}, storage ${after.storageLevel})`);
  ok(after.furniture.length === before.furniture.length && after.furniture.some((f) => f.uid === 'f-4' && f.defId === 'furn_bench_gun') && after.furniture.some((f) => f.defId === 'furn_sim_hub' && f.room === 5), `furniture persisted incl. the sim hub (${after.furniture.length})`);
  ok(JSON.stringify(after.furnitureStorage) === JSON.stringify(before.furnitureStorage), 'furniture storage persisted');
  ok(after.presets[0]?.name === '리로드' && after.presets[0].implant === 'scan' && (after.presets[0].implantItems ?? []).join(',') === 'imp_strength_1',
    'preset persisted (전술 임플란트 + 임플란트 아이템 목록)', JSON.stringify(after.presets[0]));
  ok(await H(() => window.__game.ctx.housing.getStashSize().rows === 30), 'stash size 30 rows after reload');
  await give('mat_scrap', 20); await give('mat_cable', 4);   // the bag is not persisted — only the stash is
  /* 2026-09-11: the expected uid is **derived** from the state, not written out — it used to be the literal `f-8`,
     which every new placement earlier in the run (the 재배 스테이션 was the first) silently shifted. */
  const topUid = await H(() => window.__game.ctx.housing.state.furniture
    .reduce((m, f) => Math.max(m, Number(String(f.uid).split('-')[1]) || 0), 0));
  const next = await H(() => { window.__game.ctx.housing.setRoomPurpose(6, 'lounge'); const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); return h.place(6, 'furn_crate', 7, 7, 0); });
  ok(next && next.uid === `f-${topUid + 1}`, `uid counter continues after the highest persisted uid (${next?.uid}, 최고 f-${topUid})`);
  // corrupt save → sanitised, not a crash (flush first so the unload flush does not overwrite the corrupt file)
  await H(() => window.__game.ctx.housing.save());
  await H(() => localStorage.setItem('scav.s1.ship', JSON.stringify({ version: 1, rooms: [{ purpose: 'lab', level: 9 }], generatorLevel: 99, furniture: [{ uid: 'x', defId: 'nope', room: 0 }, { uid: 'f-3', defId: 'furn_crate', room: 30, x: 99, y: -1, yaw: 7, level: 5 }, { uid: 'f-3', defId: 'furn_bench_gun', room: 1, x: 0, y: 0, yaw: 0, level: 1 }, { uid: 'f-3', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }, { uid: 'bad', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }], furnitureStorage: [{ defId: 'furn_locker', qty: 'a' }], presets: [{ name: 1, implant: 'bogus', implantItems: ['imp_strength_1', 7, null] }] })));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const san = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  const sanStore = san.furnitureStorage.map((e) => e.defId).sort().join(',');
  // 2026-09-07: no room-1 invariant any more — the corrupt save's room 1 = 연구실 falls back to 빈 방 (no 온실)
  ok(san.rooms.length === 10 && san.rooms[0].purpose === 'empty' && san.generatorLevel === 5 && san.furniture.length === 1 && san.furniture[0].uid === 'f-3' && san.furniture[0].defId === 'furn_crate' && san.presets[0].name === '프리셋' && san.presets[0].implant === null && (san.presets[0].implantItems ?? []).join(',') === 'imp_strength_1', `corrupt save sanitised: lab→빈 방 (온실 없음), gen clamped, bad rooms / purpose / overlap dropped (${JSON.stringify({ r0: san.rooms[0], g: san.generatorLevel, f: san.furniture, p: san.presets[0] })})`);
  ok(sanStore === 'furn_bench_gun,furn_repair_bench', `furniture that no longer fits its room went to storage, not the bin (${sanStore})`);

  /* ── 온실 개편 (2026-09-11): v3 세이브의 옛 재배층은 **사라지고 재료가 함선 창고로 돌아온다** ──
     `FurnitureDef.retired` 의 계약: 배치돼 있든 가구 창고에 있든 `ShipState.sanitize` 가 그 가구를 걷어내고
     `craft` 재료를 창고로 환불한다. 함께 남아 있던 v3 `plots` 도 같이 사라진다 (사용자 결정: 옛 것 폐기).
     세이브를 심기 전에 `save()` 로 디바운스를 비운다 — pagehide flush 가 심어 둔 파일을 덮어쓰면 검사가 무의미해진다. */
  console.log('세이브 마이그레이션 (v3 옛 재배층 → 은퇴 + 환불)');
  const rackCraft = await H(() => (window.__game.ctx.housing.getFurnitureDef('furn_grow_rack')?.craft ?? []).map((c) => ({ defId: c.defId, qty: c.qty })));
  ok(rackCraft.length > 0, `옛 재배층의 제작 재료가 def 에 남아 있다 (환불의 근거) — ${JSON.stringify(rackCraft)}`);
  const stashOf = (ids) => H((list) => {
    const inv = window.__game.ctx.inventory;
    const items = typeof inv.getStashItems === 'function' ? inv.getStashItems() : [];
    return Object.fromEntries(list.map((id) => [id, items.filter((i) => i.defId === id).reduce((n, i) => n + i.qty, 0)]));
  }, ids);
  const refundIds = rackCraft.map((c) => c.defId);
  const stashBeforeMig = await stashOf(refundIds);
  await H(() => window.__game.ctx.housing.save());
  await H(() => {
    const st = JSON.parse(localStorage.getItem('scav.s1.ship'));
    st.version = 3;                                   // v3 = 온실 개편 이전
    st.rooms[6] = { purpose: 'greenhouse', level: 1 };
    st.furniture = st.furniture.filter((f) => f.room !== 6);
    st.furniture.push({ uid: 'f-700', defId: 'furn_grow_rack', room: 6, x: 0, y: 0, yaw: 0, level: 1, layer: 0 });
    st.furnitureStorage = [...(st.furnitureStorage ?? []), { defId: 'furn_grow_rack', level: 1, qty: 1 }];
    st.plots = [{ uid: 'f-700', slot: 0, seedDefId: 'seed_bloodroot', plantedAt: Date.now() - 1000, readyAt: Date.now() + 3600e3 }];
    delete st.grows;
    localStorage.setItem('scav.s1.ship', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'load' });
  await setup();
  const mig = await H(() => {
    const h = window.__game.ctx.housing;
    return {
      version: h.state.version,
      placed: h.getPlaced(6).map((f) => f.defId),
      anyRack: h.state.furniture.some((f) => f.defId === 'furn_grow_rack') || h.getStored().some((s) => s.defId === 'furn_grow_rack'),
      plots: Array.isArray(h.state.plots) ? h.state.plots.length : 0,
      room6: h.getRoom(6).purpose,
    };
  });
  // 환불은 `ctx.inventory` 가 생긴 **첫 프레임**(HousingSystem.update → flushRetiredRefund)에 들어간다 — 한 프레임 기다린다
  await waitFor(page, (want) => {
    const inv = window.__game.ctx.inventory;
    const items = typeof inv?.getStashItems === 'function' ? inv.getStashItems() : [];
    const n = items.filter((i) => i.defId === want.id).reduce((a, i) => a + i.qty, 0);
    return n >= want.n;
  }, '은퇴 가구 환불', 15000, { id: refundIds[0], n: (stashBeforeMig[refundIds[0]] ?? 0) + rackCraft[0].qty * 2 }).catch(() => null);
  const stashAfterMig = await stashOf(refundIds);
  ok(mig.version === 6, `로드하면 세이브가 v6 으로 올라온다 (v${mig.version})`);
  ok(!mig.anyRack && !mig.placed.includes('furn_grow_rack') && mig.room6 === 'greenhouse',
    '배치된 · 창고의 옛 재배층이 모두 사라진다 (온실 방 자체는 남는다)', JSON.stringify(mig));
  ok(mig.plots === 0, `v3 의 plots 도 함께 사라진다 (${mig.plots})`);
  ok(rackCraft.every((c) => stashAfterMig[c.defId] === stashBeforeMig[c.defId] + c.qty * 2),
    `재료가 함선 창고로 환불된다 — 배치 1 + 창고 1 = 제작 재료 ×2 (${JSON.stringify(stashBeforeMig)} → ${JSON.stringify(stashAfterMig)})`);

  /* ── 시설 제거 (Phase 9 UI pass): refund every upgrade material into the stash and empty the room ── */
  console.log('시설 제거 (facilityRefund / removeRoomFacility)');
  await give('mat_scrap', 40);
  await give('mat_alloy', 5);
  await give('mat_cable', 8);
  // 2026-09-07: there is no built-in 작업실 any more — an empty room simply has nothing to hand back
  const emptyRoomSay = await H(() => { const h = window.__game.ctx.housing; const i = h.state.rooms.findIndex((r) => r.purpose === 'empty'); return { i, say: i < 0 ? null : h.removeRoomFacility(i), rooms: h.state.rooms.map((r) => r.purpose).join(',') }; });
  ok(/빈 방/.test(emptyRoomSay.say ?? ''), `removeRoomFacility on a 빈 방 refuses with a reason (방 ${emptyRoomSay.i}: ${emptyRoomSay.say} — ${emptyRoomSay.rooms})`);
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

  /* ── Phase 12: a FRESH ship builds its first facility from 시설 관리 with the 기본 지급품 ──
     The reported bug ("재료가 충분해 보이는데 제작이 안 됨"): a new ship's generator is Lv.0 and every 시설 증축 sits
     behind `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` 1, but the picker only said so in a tooltip on a disabled button and
     the generator could not be raised from that screen. Now the picker leads with a 발전기 row, prints every block
     reason inline, and confirms each build in a centred popup. */
  console.log('fresh ship → 발전기 → 작업실 from 시설 관리 (Phase 12)');
  // the run above left dirty ship / stash state that the debounced stores flush on pagehide — reload once so that
  // flush lands, THEN clear the saves on the quiet page and reload again into a genuinely fresh profile
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.housing, 'boot (flush)');
  // `scav.s1.loadout` too: the `give()` calls above put materials in the **bag**, and `countDefAll` counts bag + stash
  await page.evaluate(() => { for (const k of ['scav.s1.ship', 'scav.s1.stash', 'scav.s1.grant', 'scav.s1.loadout']) localStorage.removeItem(k); });
  await page.reload({ waitUntil: 'load' });
  await setup();
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (fresh)');
  await waitSim(0.5);
  const grant = await H(() => ({ scrap: window.__game.ctx.inventory.countDefAll('mat_scrap'), cable: window.__game.ctx.inventory.countDefAll('mat_cable'), alloy: window.__game.ctx.inventory.countDefAll('mat_alloy'),
    gen: window.__game.ctx.housing.getFacility('generator').level, rooms: window.__game.ctx.housing.state.rooms.every((r) => r.purpose === 'empty') }));
  ok(grant.scrap === 24 && grant.cable === 4 && grant.alloy === 3, `기본 지급품 in the 함선 창고: 폐금속 ${grant.scrap} · 케이블 ${grant.cable} · 합금 ${grant.alloy}`);
  ok(grant.gen === 0 && grant.rooms, 'fresh ship: 발전기 Lv.0, ten empty rooms');
  await H(() => window.__game.ctx.housing.openShipManage(3));
  await sleep(150);
  const hud = () => H(() => { const h = window.__game.getSystem('hud'); return { confirm: h.isShipManageConfirmOn, purpose: h.shipManageConfirmPurpose, manage: window.__game.ctx.housing.shipManageMode, pause: !document.querySelector('.menu.pause')?.classList.contains('hidden') }; });
  const pick0 = await H(() => {
    const root = document.querySelector('.ship-manage');
    const gen = root.querySelector('.sm-purposes .sm-gen');
    return { gen: !!gen, hint: gen?.classList.contains('is-hint'), first: root.querySelector('.sm-purposes').firstElementChild === gen,
      genBtn: gen?.querySelector('.sm-gen-btn')?.textContent, genDisabled: gen?.querySelector('.sm-gen-btn')?.disabled, genChips: gen?.querySelectorAll('.sm-cost .item-chip').length,
      genNote: gen?.querySelector('.sm-block')?.textContent ?? '',
      purposes: root.querySelectorAll('.sm-purposes .sm-purpose').length, blocked: root.querySelectorAll('.sm-purposes .sm-purpose.is-blocked').length,
      disabled: root.querySelectorAll('.sm-purposes .sm-purpose:disabled').length,
      reasons: [...root.querySelectorAll('.sm-purposes .sm-purpose .sm-block')].map((e) => e.textContent),
      workshopReason: root.querySelector('.sm-purpose[data-purpose="workshop"] .sm-block')?.textContent ?? '' };
  });
  ok(pick0.gen && pick0.first && pick0.hint, '용도 지정 picker leads with a highlighted 발전기 row (the gate is what blocks everything)');
  ok(pick0.genBtn === '가동' && pick0.genDisabled === false && pick0.genChips === 1 && /발전기 Lv.1/.test(pick0.genNote), `발전기 row: 가동 button enabled, 1 cost chip, guidance text (${pick0.genNote})`);
  ok(pick0.purposes === 9 && pick0.blocked === 9 && pick0.disabled === 0, `all 9 purposes blocked but none is a disabled button (${pick0.blocked} blocked, ${pick0.disabled} disabled)`);
  ok(pick0.reasons.length === 9 && /발전기 레벨 1 필요 \(현재 0\)/.test(pick0.workshopReason), `each row prints its reason inline (${pick0.workshopReason})`);
  // clicking a blocked purpose: no popup, the reason toasts
  await H(() => document.querySelector('.ship-manage .sm-purpose[data-purpose="workshop"]').click());
  await sleep(80);
  const denied = await hud();
  const deniedToast = await H(() => [...document.querySelectorAll('.notifs .notif')].some((n) => /발전기 레벨 1 필요/.test(n.textContent)));
  ok(!denied.confirm && denied.manage && deniedToast, 'clicking a blocked purpose → no popup, the reason as a toast');
  // 발전기 가동: confirm popup, Esc closes only the popup, 확인 raises the generator
  await H(() => document.querySelector('.ship-manage .sm-gen-btn').click());
  await sleep(80);
  const genPop = await H(() => { const c = document.querySelector('.ship-manage .sm-confirm'); return { hidden: c.hidden, title: c.querySelector('.title').textContent, chips: c.querySelectorAll('.cost .item-chip').length, ok: c.querySelector('.ui-btn.primary')?.textContent }; });
  ok(!genPop.hidden && /발전기 Lv\.0 → Lv\.1/.test(genPop.title) && genPop.chips === 1 && genPop.ok === '확인', `발전기 confirm popup (${genPop.title})`);
  await tap('Escape');
  await sleep(80);
  const escd = await hud();
  ok(!escd.confirm && escd.manage && !escd.pause, 'Esc closes the popup only — still in 시설 관리, no pause menu');
  await H(() => document.querySelector('.ship-manage .sm-gen-btn').click());
  await sleep(60);
  await H(() => document.querySelector('.ship-manage .sm-confirm .ui-btn.primary').click());
  await sleep(150);
  const gen1 = await H(() => ({ level: window.__game.ctx.housing.getFacility('generator').level, scrap: window.__game.ctx.inventory.countDefAll('mat_scrap'),
    hint: document.querySelector('.ship-manage .sm-gen')?.classList.contains('is-hint'), lv: document.querySelector('.ship-manage .sm-gen .lv')?.textContent,
    workshopBlocked: document.querySelector('.ship-manage .sm-purpose[data-purpose="workshop"]')?.classList.contains('is-blocked'),
    labReason: document.querySelector('.ship-manage .sm-purpose[data-purpose="lab"] .sm-block')?.textContent ?? '' }));
  ok(gen1.level === 1 && gen1.scrap === 20, `확인 → 발전기 Lv.1, 폐금속 24 → ${gen1.scrap}`);
  ok(gen1.hint === false && gen1.lv === 'Lv.1 / 5' && gen1.workshopBlocked === false, `picker refreshed: generator row plain (${gen1.lv}), 작업실 now buildable`);
  ok(/온실/.test(gen1.labReason), `other reasons still print (연구실: ${gen1.labReason})`);
  // 작업실: confirm text + chips, Esc, then 확인
  await H(() => document.querySelector('.ship-manage .sm-purpose[data-purpose="workshop"]').click());
  await sleep(80);
  const wsPop = await H(() => { const c = document.querySelector('.ship-manage .sm-confirm'); return { hidden: c.hidden, title: c.querySelector('.title').textContent, body: c.querySelector('.body').textContent, chips: c.querySelectorAll('.cost .item-chip').length, purpose: window.__game.getSystem('hud').shipManageConfirmPurpose }; });
  ok(!wsPop.hidden && wsPop.purpose === 'workshop' && /정말로 4번 방을 작업실 시설로 만들겠습니까\?/.test(wsPop.body) && wsPop.chips === 2, `작업실 confirm popup: "${wsPop.body.slice(0, 30)}…", 2 chips`);
  await tap('Escape');
  await sleep(80);
  ok((await hud()).confirm === false && (await hud()).manage, 'Esc → popup closed, 시설 관리 kept');
  await H(() => document.querySelector('.ship-manage .sm-purpose[data-purpose="workshop"]').click());
  await sleep(60);
  await H(() => document.querySelector('.ship-manage .sm-confirm .ui-btn.primary').click());
  await sleep(150);
  const built = await H(() => ({ purpose: window.__game.ctx.housing.getRoom(3).purpose, level: window.__game.ctx.housing.getRoom(3).level,
    scrap: window.__game.ctx.inventory.countDefAll('mat_scrap'), cable: window.__game.ctx.inventory.countDefAll('mat_cable'),
    head: document.querySelector('.ship-manage .sm-bar-head').textContent, cards: document.querySelectorAll('.ship-manage .sm-cards .fcard').length,
    confirm: window.__game.getSystem('hud').isShipManageConfirmOn }));
  ok(built.purpose === 'workshop' && built.level === 1 && !built.confirm, `확인 → 방 4 is a 작업실 Lv.1 (${built.purpose})`);
  ok(built.scrap === 12 && built.cable === 2, `증축 consumed 폐금속 8 · 케이블 2 from the 창고 (left ${built.scrap} · ${built.cable})`);
  ok(/작업실/.test(built.head) && built.cards === workshopFurniture, `side panel switched to the 작업실 furniture list (${built.cards} cards)`);
  ok((await lastEv('housing:roomPurposeChanged'))?.room === 3, 'housing:roomPurposeChanged {room:3}');
  await H(() => window.__game.ctx.housing.closeShipManage());
  await sleep(80);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
