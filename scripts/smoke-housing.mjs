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
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
/* 2026-09-12: the room floor grid went 8 × 8 → 16 × 16 cells (4 × 4 → 8 × 8 m rooms). The grid-boundary checks below
   read the size from `data/constants.csv` instead of writing 8 down, so the next resize does not need this file. */
const CONSTANTS_CSV = readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8');
const konst = (name) => {
  const m = CONSTANTS_CSV.match(new RegExp(`^${name},([^,\\r\\n]+)`, 'm'));
  if (!m) throw new Error(`constant ${name} missing from data/constants.csv`);
  return Number(m[1]);
};
const GRID_COLS = konst('ROOM_GRID_COLS'), GRID_ROWS = konst('ROOM_GRID_ROWS');
/* 2026-09-12 (사용자 결정 — 시설관리 정리): 기본 개인 함선은 방 8 개 · 조종석은 방 번호 `COCKPIT_ROOM_INDEX`(100) 의 고정 공간이고
   공용 시설 가구(전술 임플란트 시술대 · 기업 네트워크 컴퓨터)가 처음부터 거기 놓여 있다 (uid f-1 · f-2). 시뮬레이션실 · 휴식 공간은
   지을 수 없고 관물대 · 표적 레인 · 시뮬레이션 허브는 은퇴, 로드아웃 프리셋 기능은 없어졌다. */
const ROOM_COUNT = konst('SHIP_ROOM_COUNT');
const COCKPIT = 100;
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
        'housing:furnitureSelected', 'housing:moveStateChanged', 'housing:placeRefused',
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
  // 2026-09-07: a new ship is **empty** rooms — the built-in 작업실 + its two benches are gone. 2026-09-12: 8 rooms, and the
  // only furniture is the cockpit's two 공용 시설 가구 (f-1 시술대 · f-2 컴퓨터, room COCKPIT_ROOM_INDEX)
  ok(st0.rooms.length === ROOM_COUNT && ROOM_COUNT === 8 && st0.rooms.every((r) => r.purpose === 'empty' && r.level === 0), `fresh state: all ${ROOM_COUNT} rooms empty`);
  ok(st0.generatorLevel === 0 && st0.storageLevel === 0 && st0.presets.length === 0 && st0.furnitureStorage.length === 0, 'fresh state: gen 0 / storage 0 / no presets / empty furniture storage');
  ok(st0.furniture.length === 2 && st0.furniture.every((f) => f.room === COCKPIT && f.level === 1)
    && st0.furniture.map((f) => `${f.uid}:${f.defId}`).sort().join(',') === 'f-1:furn_implant_bay,f-2:furn_corp_computer',
  `first run: only the cockpit's 공용 시설 가구 are placed (${JSON.stringify(st0.furniture)})`);
  ok(await H(() => window.__game.ctx.housing.findRoom('workshop') === -1 && window.__game.ctx.housing.getFacility('workshop').level === 0
    && window.__game.ctx.housing.getBenchLevel('gun') === 0), 'no 작업실 facility and no bench on a fresh ship');
  const stash0 = await H(() => window.__game.ctx.housing.getStashSize());
  ok(stash0.cols === 10 && stash0.rows === 24, `getStashSize() 10×24 at storage 0 (${stash0.cols}×${stash0.rows})`);
  /* Phase 8 added furn_repair_bench (작업실) and furn_grow_rack (온실); Phase 9 furn_bookshelf (서재); 2026-09-10
     furn_bench_refine (정제). **2026-09-11 (온실 개편)**: the count is no longer asserted — `furn_grow_rack` is
     `retired` and whether `getAllFurnitureDefs` still carries a retired def is housing/'s business (only
     `getFurnitureFor` is contractually filtered). Presence of the defs that matter is what this line guards now. */
  /* 2026-09-12 (사용자 결정): `furn_repair_bench` 도 은퇴했다 (함선에서는 인벤토리만으로 수리한다). `getAllFurnitureDefs`
     는 `ACTIVE_FURNITURE_DEFS` 라 은퇴 def 를 걸러 내므로, 여기서는 **없다는 것**을 검사해 되살아나는 것을 막는다. */
  const furnDefIds = await H(() => window.__game.ctx.housing.getAllFurnitureDefs().map((d) => d.id));
  // 2026-09-12: 관물대 · 표적 레인 · 시뮬레이션 허브도 은퇴했고, 조종석의 공용 시설 가구 두 점(시술대 · 컴퓨터)이 새로 들어왔다
  ok(['furn_bench_gun', 'furn_bench_refine', 'furn_implant_bay', 'furn_corp_computer', 'furn_bookshelf', 'furn_grow_station']
    .every((id) => furnDefIds.includes(id))
    && !['furn_repair_bench', 'furn_grow_rack', 'furn_range_console', 'furn_target_lane', 'furn_sim_hub'].some((id) => furnDefIds.includes(id))
    && furnDefIds.length >= 18,
  `FURNITURE_DEFS exposed (${furnDefIds.length}, incl. implant_bay / corp_computer / bookshelf / bench_refine / grow_station, 은퇴한 repair_bench · grow_rack · range_console · target_lane · sim_hub 제외)`, furnDefIds.join(','));
  // SHIP_STATE_VERSION (src/shared/constants.ts): 4 = 온실 개편의 `grows`, 5 = 연구실의 `analyses`/`sampleDex`, 6 = 배양조의 `cultures`,
  // 7 = 방 시설 레벨 제거 (2026-09-12 — 모양은 같고 옛 방 레벨을 한 번만 옮기려고 올렸다)
  // 8 = 조종석 · 방 8 개 · 시뮬레이션실 / 휴식 공간 제거 (2026-09-12 — 모양은 같고 옛 방 9 · 10 을 한 번만 환불하려고 올렸다)
  // 9 = 서재 매체 (A-3e, 2026-09-12 — `media` · `mediaDex` · `toggled`, 없던 필드가 생기는 것뿐)
  ok(st0.version === 9 && Array.isArray(st0.books) && st0.books.length === 0 && Array.isArray(st0.bookDex) && st0.bookDex.length === 0, `fresh state is v9 with empty books / bookDex (v${st0.version})`);
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('library').some((d) => d.id === 'furn_bookshelf' && d.interaction === 'bookshelf') && !window.__game.ctx.housing.getFurnitureFor('workshop').some((d) => d.id === 'furn_bookshelf')), 'furn_bookshelf in the 서재 catalogue only');
  ok(await H(() => { const h = window.__game.ctx.housing; const c = h.getFurnitureFor('cockpit'); return c.length > 0 && c.every((d) => d.room === 'any') && h.getFurnitureFor('range').every((d) => d.room === 'any'); }),
    "조종석 catalogue = 공용('any') 가구만 · 시뮬레이션실 전용 가구는 전부 은퇴해 목록에 없다");
  // Phase 8: workshop also accepts the 정비 벤치, and 온실 accepts the 재배 스테이션 (2026-09-11: 옛 재배층 자리를 그대로 이어받았다)
  // 2026-09-11 (A-14 · A-3c): 온실에 배양조가 늘어 9 → 10, 새로 열린 주방은 조리대 + 식탁 + 8 any = 10
  // 2026-09-12 (사용자 결정): 정비 벤치가 은퇴해 작업실이 14 → 13 (작업대 5 + 8 any). 나머지 방은 그대로.
  // 2026-09-12: 공용(any) 가구가 8 → 10 (전술 임플란트 시술대 · 기업 네트워크 컴퓨터) — 방마다 2 씩 늘었다
  ok(await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').length === 15 && window.__game.ctx.housing.getFurnitureFor('empty').length === 10 && window.__game.ctx.housing.getFurnitureFor('greenhouse').length === 12 && window.__game.ctx.housing.getFurnitureFor('kitchen').length === 12 && window.__game.ctx.housing.getFurnitureFor('cockpit').length === 10), 'getFurnitureFor: workshop 15 (5 benches + 10 any), empty 10, greenhouse 12 (재배 스테이션 + 배양조 + 10 any), kitchen 12 (조리대 + 식탁 + 10 any), cockpit 10 (any)');
  /* 아래 화면 검사들은 이 수를 **그때그때 물어서** 쓴다 — 작업대가 하나 늘 때마다 세 자리를 손으로 고치던 것이
     2026-09-10 정제 작업대에서 실제로 red 를 냈다. 위 한 줄만 카나리아로 남긴다. */
  const workshopFurniture = await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').length);
  // 2026-09-12: 가구 제작 목록은 시설 가구 / 꾸밈용 가구 하위 탭으로 갈린다 — 기본 탭(시설 가구)에 보이는 카드 수
  const workshopUtility = await H(() => window.__game.ctx.housing.getFurnitureFor('workshop').filter((d) => d.interaction !== 'none').length);
  ok(await H(() => window.__game.ctx.housing.getPresetCount() === 0 && window.__game.ctx.housing.getCraftCostMul() === 1 && window.__game.ctx.housing.getSkillGainMul('gun_AR') === 1), 'no rooms: 0 presets, cost ×1, skill ×1');
  // `housing:loaded` fired inside init() before the recorder existed; the saved file proves the fresh state was written
  await sleep(500);
  ok(await H(() => !!localStorage.getItem('scav.s1.ship')), 'fresh state saved to localStorage (scav.s1.ship)');

  console.log('조종석 · 공용 시설 가구 (2026-09-12)');
  const cockpit = await H(async (C) => {
    const S = await import('/src/shared/index.ts');
    const h = window.__game.ctx.housing;
    const r = S.COCKPIT_BLOCKED_RECTS[0];
    const spot = h.findFreeSpot(C, 'furn_locker');
    const bay = h.getPlaced(C).find((f) => f.defId === S.IMPLANT_BAY_DEF_ID);
    return {
      index: S.COCKPIT_ROOM_INDEX, room: h.getRoom(C), placed: h.getPlaced(C).length,
      defaultsAt: S.COCKPIT_DEFAULT_FURNITURE.every((d) => h.getPlaced(C).some((f) => f.defId === d.defId)),
      anyOnly: h.getFurnitureFor('cockpit').every((d) => d.room === 'any'),
      listsBoth: [S.IMPLANT_BAY_DEF_ID, S.CORP_COMPUTER_DEF_ID].every((id) => h.getFurnitureFor('cockpit').some((d) => d.id === id)),
      utility: [S.IMPLANT_BAY_DEF_ID, S.CORP_COMPUTER_DEF_ID].every((id) => h.getFurnitureDef(id).interaction !== 'none'),
      emptyWhy: h.purposeBlock(C, 'empty'), gymWhy: h.purposeBlock(C, 'gym'), remove: h.removeRoomFacility(C), refund: h.facilityRefund(C).length,
      setPurpose: h.setRoomPurpose(C, 'gym'),
      bench: h.canPlace(C, 'furn_bench_gun', 0, 0, 0),
      blockedCell: h.canPlace(C, 'furn_crate', r.x, r.y, 0),
      outOfGrid: h.canPlace(C, 'furn_crate', S.COCKPIT_GRID_COLS, 0, 0),
      spot, spotOk: !!spot && h.canPlace(C, 'furn_locker', spot.x, spot.y, spot.yaw),
      craftBay: h.furnitureCraftBlock(S.IMPLANT_BAY_DEF_ID), craftPc: h.furnitureCraftBlock(S.CORP_COMPUTER_DEF_ID),
      bayReq: bay ? h.furnitureUpgradeRequirements(bay.uid).length : -1,
      gymReq: h.purposeRequirements('gym'),
    };
  }, COCKPIT);
  ok(cockpit.index === COCKPIT && cockpit.room.purpose === 'cockpit' && cockpit.room.level === 1 && cockpit.placed === 2 && cockpit.defaultsAt,
    '조종석 = COCKPIT_ROOM_INDEX · getRoom → cockpit · 공용 시설 가구 두 점이 놓여 있다', JSON.stringify(cockpit));
  ok(cockpit.anyOnly && cockpit.listsBoth && cockpit.utility, "getFurnitureFor('cockpit') = 공용('any') 가구만, 시술대 · 컴퓨터는 시설 가구", JSON.stringify(cockpit));
  ok(/조종석/.test(cockpit.emptyWhy ?? '') && /조종석/.test(cockpit.gymWhy ?? '') && /조종석/.test(cockpit.remove ?? '') && cockpit.refund === 0 && cockpit.setPurpose === false,
    '조종석은 용도를 바꾸거나 제거할 수 없다 (purposeBlock · removeRoomFacility 사유, facilityRefund [])', JSON.stringify(cockpit));
  ok(cockpit.bench === false && cockpit.blockedCell === false && cockpit.outOfGrid === false && cockpit.spotOk,
    'canPlace(조종석): 방 전용 가구 · 고정 소품 자리 · 격자 밖은 거절, findFreeSpot 은 놓을 수 있는 자리', JSON.stringify(cockpit));
  ok(cockpit.craftBay === '이미 보유 중입니다' && cockpit.craftPc === '이미 보유 중입니다' && cockpit.bayReq === 0,
    '공용 시설 가구는 이미 보유 중 (제작 잠김) · 강화 요구 없음 (maxLevel 1)', JSON.stringify(cockpit));
  ok(cockpit.gymReq.length === 1 && cockpit.gymReq[0].facility === 'generator' && cockpit.gymReq[0].have === 0 && cockpit.gymReq[0].need === 1,
    'purposeRequirements(gym) at 발전기 Lv.0 → 발전기 0/1', JSON.stringify(cockpit.gymReq));
  // 회수하면 가구 창고로 (잃은 게 아니므로 다시 채우지 않는다) → 같은 자리에 다시 놓는다. 새 uid 는 f-3 이다.
  const bayRound = await H(async (C) => {
    const S = await import('/src/shared/index.ts');
    const h = window.__game.ctx.housing;
    const bay = h.getPlaced(C).find((f) => f.defId === S.IMPLANT_BAY_DEF_ID);
    const at = { x: bay.x, y: bay.y, yaw: bay.yaw };
    const rec = h.recover(bay.uid);
    const stored = h.getStored().find((s) => s.defId === S.IMPLANT_BAY_DEF_ID)?.qty ?? 0;
    const block = h.furnitureCraftBlock(S.IMPLANT_BAY_DEF_ID);
    const back = h.place(C, S.IMPLANT_BAY_DEF_ID, at.x, at.y, at.yaw);
    return { rec, stored, block, back: back ? { uid: back.uid, room: back.room, x: back.x, y: back.y } : null, at,
      left: h.getStored().filter((s) => s.defId === S.IMPLANT_BAY_DEF_ID).length };
  }, COCKPIT);
  ok(bayRound.rec && bayRound.stored === 1 && bayRound.block === '이미 보유 중입니다' && bayRound.back?.room === COCKPIT
    && bayRound.back.x === bayRound.at.x && bayRound.back.y === bayRound.at.y && bayRound.back.uid === 'f-3' && bayRound.left === 0,
  '시술대 회수 → 가구 창고 (여전히 보유 중) → 조종석 같은 자리에 다시 배치 (f-3)', JSON.stringify(bayRound));

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
    // 2026-09-12: 두 번째 벤치가 `furn_repair_bench` 였는데 그것은 은퇴했다 — 살아 있는 작업대로 바꿨다 (뜻은 같다: 한 방에 둘)
    h.state.furnitureStorage.push({ defId: 'furn_bench_gun', level: 1, qty: 1 }, { defId: 'furn_bench_gear', level: 1, qty: 1 });
    h.place(0, 'furn_bench_gun', 0, 0, 0);
    h.place(0, 'furn_bench_gear', 0, 3, 0);
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
  ok(await H(() => window.__game.ctx.housing.purposeCost('empty').length === 0 && window.__game.ctx.housing.purposeCost('range').some((c) => c.defId === 'mat_cable')), '빈 방 is free; 시뮬레이션실 needs 케이블');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'workshop') === false && window.__game.ctx.housing.purposeBlock(3, 'gym') !== null
    && !/하나만/.test(window.__game.ctx.housing.purposeBlock(3, 'gym') ?? '')), '2026-09-12: every purpose is one per ship — a purpose nobody has yet is not refused for that');
  ok(await H(() => window.__game.ctx.housing.findRoom('workshop') === 0 && window.__game.ctx.housing.findRoom('range') === -1), 'findRoom');
  ok(await H(() => window.__game.ctx.housing.getFacility('workshop').level === 1 && window.__game.ctx.housing.getCraftCostMul() === 1), 'workshop facility level 1, cost ×1');

  console.log('placement');
  // start the placement checks from an empty 작업실: the two seeded benches go back to furniture storage
  await H(() => { const h = window.__game.ctx.housing; for (const f of [...h.getPlaced(0)]) h.recover(f.uid); });
  ok(await H(() => window.__game.ctx.housing.getPlaced(0).length === 0 && window.__game.ctx.housing.getStored().length === 2), 'benches recovered into furniture storage');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 0, 0, 0) === true), 'canPlace 4×2 bench at (0,0) yaw 0');
  /* Grid boundaries, derived from ROOM_GRID_COLS/ROWS: the 총기 작업대 is 4 × 2 cells, so at yaw 0 the last column
     that fits is COLS−4 and COLS−3 overflows by one; rotated (2 × 4) the same column has room to spare, and the last
     row that fits is ROWS−4. */
  ok(await H((c) => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', c - 3, 0, 0) === false, GRID_COLS), `canPlace refuses x=${GRID_COLS - 3} (4 wide in a ${GRID_COLS}-col grid)`);
  ok(await H((c) => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', c - 3, 0, 1) === true, GRID_COLS), `canPlace yaw 1 (2×4) at x=${GRID_COLS - 3} fits`);
  ok(await H((g) => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', g.c - 2, g.r - 3, 1) === false, { c: GRID_COLS, r: GRID_ROWS }), `canPlace yaw 1 at y=${GRID_ROWS - 3} overflows rows`);
  ok(await H(() => window.__game.ctx.housing.canPlace(1, 'furn_bench_gun', 0, 0, 0) === false), 'canPlace refuses a bench in an empty room (purpose)');
  ok(await H(() => window.__game.ctx.housing.canPlace(1, 'furn_locker', 0, 0, 0) === true), "canPlace allows 'any' furniture in an empty room");
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_range_console', 0, 0, 0) === false), 'canPlace refuses range furniture in the workshop');
  ok(await H(() => window.__game.ctx.housing.place(0, 'furn_locker', 0, 0, 0) === null), 'place refuses a def not in furniture storage');
  const placed = await H(() => window.__game.ctx.housing.place(0, 'furn_bench_gun', 1, 1, 0));
  ok(placed && placed.uid === 'f-6' && placed.level === 1 && placed.room === 0, `place → f-6 (${JSON.stringify(placed)})`);
  ok((await lastEv('housing:furniturePlaced'))?.item?.uid === 'f-6', 'housing:furniturePlaced');
  ok(await H(() => !window.__game.ctx.housing.getStored().some((e) => e.defId === 'furn_bench_gun' && e.qty > 0)), 'storage entry consumed (the 정비 벤치 stays)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 3, 2, 0) === false), 'canPlace overlap refused (3,2 vs 1..4,1..2)');
  ok(await H(() => window.__game.ctx.housing.canPlace(0, 'furn_bench_gun', 0, 3, 0) === true), 'canPlace free row below');
  ok(await H(() => window.__game.ctx.housing.move('f-6', 2, 3, 1) === true), 'move f-6 → (2,3) yaw 1');
  const moved = await lastEv('housing:furnitureMoved');
  ok(moved && moved.item.x === 2 && moved.item.y === 3 && moved.item.yaw === 1, 'housing:furnitureMoved carries the new cell + yaw');
  // the rotated bench is 2 cells wide, so the last column (COLS−1) leaves it hanging one cell outside the room
  ok(await H((c) => window.__game.ctx.housing.move('f-6', c - 1, 3, 1) === false, GRID_COLS), 'move refuses out of grid');
  ok(await H(() => window.__game.ctx.housing.move('f-6', 2, 3, 1) === true), 'move onto its own cells (ignoreUid) ok');
  ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 1 && window.__game.ctx.housing.getBenchLevel('gear') === 0), 'getBenchLevel gun 1 / gear 0');
  ok(await H(() => window.__game.ctx.housing.recover('f-6') === true), 'recover f-6');
  const rec = await lastEv('housing:furnitureRecovered');
  ok(rec && rec.uid === 'f-6' && rec.defId === 'furn_bench_gun' && rec.room === 0, 'housing:furnitureRecovered');
  ok(await H(() => { const e = window.__game.ctx.housing.getStored().find((x) => x.defId === 'furn_bench_gun'); return !!e && e.qty === 1 && e.level === 1; }), 'recovered piece back in storage');
  ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 0), 'bench level 0 after recover');
  const re = await H(() => window.__game.ctx.housing.place(0, 'furn_bench_gun', 0, 0, 0));
  ok(re && re.uid === 'f-7', 're-place → new uid f-7');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(0, 'gym') === false), 'purpose change refused while a workshop bench is placed');
  ok(await H(() => /회수/.test(window.__game.ctx.housing.purposeBlock(0, 'gym') ?? '')), 'the block names the furniture to recover first');

  console.log('materials / facilities');
  const hasCountAll = (await count('mat_scrap')) >= 0;
  if (!hasCountAll) console.log('  TODO(lead): inventory.countDefAll is not a function yet — material checks will report 0');
  const scrap = await give('mat_scrap', 40);
  ok(scrap === 40, `40 폐금속 into the bag (${scrap})`);
  ok((await count('mat_scrap')) === 40, `countDefAll(mat_scrap) 40 (${await count('mat_scrap')})`);
  const gen0 = await H(() => window.__game.ctx.housing.getFacility('generator'));
  ok(gen0.level === 0 && gen0.maxLevel === 5 && gen0.nextCost?.[0]?.defId === 'mat_scrap' && gen0.nextCost[0].qty === 4 && gen0.blocked === null, `generator: Lv0/5, next 폐금속 4, unblocked (${JSON.stringify(gen0)})`);
  // 2026-09-12 (사용자 결정): 방 시설(작업실 · 시뮬레이션실)에는 레벨이 없다 — 강화는 방 안의 가구가 한다
  const ws0 = await H(() => window.__game.ctx.housing.getFacility('workshop'));
  ok(ws0.level === 1 && ws0.maxLevel === 1 && ws0.nextCost === null && /가구/.test(ws0.blocked ?? ''), `workshop has no level to buy (Lv.1/1, no cost, "${ws0.blocked}")`);
  ok(await H(() => window.__game.ctx.housing.upgrade('workshop') === false), 'upgrade(workshop) refused');
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
  // generator 2 needs 폐금속 8 + 전력 케이블 2 (mat_cable is a new items/ def)
  const cable = await give('mat_cable', 10);
  if (cable < 0) console.log('  TODO(lead): items/ has no mat_cable yet — generator 2 skipped');
  else {
    ok(await H(() => window.__game.ctx.housing.upgrade('generator') === true), 'generator → 2 (8 폐금속 + 2 케이블)');
    // 2026-09-12: 발전기가 올라가도 작업실 레벨은 열리지 않는다 — 제작 재료 할인도 없다
    ok(await H(() => window.__game.ctx.housing.upgrade('workshop') === false && window.__game.ctx.housing.getRoom(0).level === 1
      && window.__game.ctx.housing.getCraftCostMul() === 1), 'generator 2 still buys no 작업실 level; craft cost stays ×1 (discount abolished)');
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
  const upReason = await H(() => window.__game.ctx.housing.furnitureUpgradeBlock('f-7'));
  const circuit = await give('mat_circuit', 5);
  const alloy = await give('mat_alloy', 20);
  if (circuit < 0) {
    console.log('  TODO(lead): items/ has no mat_circuit yet — bench upgrade only checked for refusal');
    ok(typeof upReason === 'string', `bench upgrade blocked with a reason (${upReason})`);
    ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-7') === false), 'upgradeFurniture refused');
  } else {
    ok(alloy === 20 && circuit === 5, 'alloy + circuit in the bag');
    const gen = await H(() => window.__game.ctx.housing.state.generatorLevel);
    if (gen >= 2) {
      ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-7') === true), 'bench f-7 → Lv2');
      ok((await lastEv('housing:furnitureUpgraded'))?.item?.level === 2, 'housing:furnitureUpgraded level 2');
      ok(await H(() => window.__game.ctx.housing.getBenchLevel('gun') === 2), 'getBenchLevel(gun) 2');
      ok(await H(() => window.__game.ctx.housing.furnitureUpgradeBlock('f-7')?.includes('발전기')), 'Lv3 gated by generator 2');
      ok(await H(() => window.__game.ctx.housing.upgradeFurniture('f-7') === false), 'upgradeFurniture refused at the gate');
    } else {
      ok(typeof upReason === 'string' && upReason.includes('발전기'), `bench upgrade gated by the generator (${upReason})`);
    }
  }

  console.log('시뮬레이션실 · 휴식 공간 · 프리셋 제거 (2026-09-12)');
  // Phase 9 UI pass: every 시설 증축 below costs materials — keep the bag stocked
  await give('mat_scrap', 60); await give('mat_alloy', 20); await give('mat_cable', 20); await give('mat_circuit', 10);
  const gone = await H(() => {
    const h = window.__game.ctx.housing;
    return {
      range: h.setRoomPurpose(5, 'range'), rangeWhy: h.purposeBlock(5, 'range'),
      lounge: h.setRoomPurpose(5, 'lounge'), loungeWhy: h.purposeBlock(5, 'lounge'),
      cockpitWhy: h.purposeBlock(5, 'cockpit'), purpose5: h.getRoom(5).purpose,
      rangeReq: h.purposeRequirements('range').length, loungeReq: h.purposeRequirements('lounge').length,
    };
  });
  ok(gone.range === false && gone.lounge === false && gone.purpose5 === 'empty'
    && /더 이상 지을 수 없습니다/.test(gone.rangeWhy ?? '') && /더 이상 지을 수 없습니다/.test(gone.loungeWhy ?? '') && /더 이상/.test(gone.cockpitWhy ?? ''),
  '시뮬레이션실 · 휴식 공간 · 조종석은 빈 방이 될 수 없다 (한국어 사유)', JSON.stringify(gone));
  ok(gone.rangeReq === 0 && gone.loungeReq === 0, 'purposeRequirements: 지을 수 없는 용도에는 시설 레벨 요구가 없다', JSON.stringify(gone));
  const retired = await H(() => {
    const h = window.__game.ctx.housing;
    return ['furn_range_console', 'furn_target_lane', 'furn_sim_hub'].map((id) => ({ id, retired: h.getFurnitureDef(id)?.retired === true,
      listed: h.getAllFurnitureDefs().some((d) => d.id === id),
      anyRoom: ['range', 'workshop', 'empty', 'library', 'cockpit'].some((p) => h.getFurnitureFor(p).some((d) => d.id === id)),
      craft: h.canCraftFurniture(id).ok, block: h.furnitureCraftBlock(id), made: h.craftFurniture(id) }));
  });
  ok(retired.every((r) => r.retired && !r.listed && !r.anyRoom && !r.craft && r.block !== null && !r.made),
    '관물대 · 표적 레인 · 시뮬레이션 허브는 은퇴 — 어느 목록에도 없고 만들 수 없다', JSON.stringify(retired));
  const presets = await H(() => {
    const h = window.__game.ctx.housing;
    const before = JSON.stringify(h.state.presets);
    const blank = { name: 'x', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: null };
    return { count: h.getPresetCount(), list: h.getPresets().length, save: h.savePreset(0, blank), apply: h.applyPreset(0), del: h.deletePreset(0),
      untouched: JSON.stringify(h.state.presets) === before, skill: h.getSkillGainMul('gun_SR'), melee: h.getSkillGainMul('melee') };
  });
  ok(presets.count === 0 && presets.list === 0 && presets.save === false && presets.apply === null && presets.del === false && presets.untouched,
    '프리셋 기능 제거: 슬롯 0 · 저장 / 적용 / 삭제 모두 거절, 세이브의 presets 는 그대로', JSON.stringify(presets));
  ok(presets.skill === 1 && presets.melee === 1, 'getSkillGainMul = 서재 책뿐 (시뮬레이션 허브 항 없음) — 책이 없으면 ×1', JSON.stringify(presets));
  // 2026-09-08: 임플란트 아이템도 로드아웃의 일부 — captureLoadout 은 inventory 에 그대로 있다 (프리셋이 없어져도)
  const cap = await H(() => (typeof window.__game.ctx.inventory.captureLoadout === 'function' ? window.__game.ctx.inventory.captureLoadout() : null));
  ok(cap === null || Array.isArray(cap.implantItems), 'captureLoadout carries implantItems (임플란트 아이템 def ids)', JSON.stringify(cap && cap.implantItems));
  // 휴식 공간은 서재에 합쳐졌다 — 'any' 가구는 서재에 남고, 빈 방으로 되돌리면 가구 창고로 돌아온다
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(1, 'library') === true && window.__game.ctx.housing.getPlaced(1).length === 1), "room 1 → 서재 keeps its 'any' locker");
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(1, 'empty') === true && window.__game.ctx.housing.getPlaced(1).length === 0 && window.__game.ctx.housing.getStored().find((s) => s.defId === 'furn_locker')?.qty === 2), 'room 1 → empty recovers the locker');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(2, 'gym') === true && window.__game.ctx.housing.getRoom(2).level === 1), 'inactive purpose (gym) can still be assigned');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(3, 'greenhouse') && window.__game.ctx.housing.setRoomPurpose(4, 'lab')), 'lab allowed once a greenhouse exists');

  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'workshop') === false && /하나만/.test(window.__game.ctx.housing.purposeBlock(7, 'workshop') ?? '')), 'second 작업실 refused (방 1 already has it)');
  ok(await H(() => window.__game.ctx.housing.setRoomPurpose(7, 'greenhouse') === false && /하나만/.test(window.__game.ctx.housing.purposeBlock(7, 'greenhouse') ?? '')),
    '2026-09-12: a second 온실 is refused too (every purpose is one per ship)');

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
      // the HUD item card — housing's station tooltip (`ui/StationTip`, `.item-tip.hs-tip`) shares the base class
      const card = document.querySelector('.item-tip:not(.hs-tip)');
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
  /* 2026-09-12: this used to name `furn_bench_gear`, but the 작업실 seed above now stores that very bench (the second
     one used to be the retired 정비 벤치), so it *was* in storage and the selection stuck. Ask for a def that is
     genuinely absent instead of naming one — the seed may move again. */
  const absentDef = await H(() => {
    const h = window.__game.ctx.housing;
    const stored = new Set(h.getStored().filter((s) => s.qty > 0).map((s) => s.defId));
    return h.getAllFurnitureDefs().map((d) => d.id).find((id) => !stored.has(id)) ?? null;
  });
  await H((id) => window.__game.ctx.housing.selectFurniture(id), absentDef);
  ok(!!absentDef && await H(() => window.__game.ctx.housing.selectedFurniture === 'furn_locker'), `selecting a def not in storage is ignored (${absentDef})`);
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
  // 2026-09-12: 조종석 row 가 맨 위에 늘 있고 그 아래 방 8 개
  ok(smDom.rooms === ROOM_COUNT + 1 && /방 1/.test(smDom.on), `방 목록: 조종석 + ${ROOM_COUNT} rows, room 1 active (${smDom.on})`, JSON.stringify(smDom));
  ok(smDom.cards === workshopUtility && smDom.purposes === 0 && /작업실/.test(smDom.head), `가구 목록 for the 작업실 — 시설 가구 tab (${smDom.cards} cards, '${smDom.head}')`);
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
  ok(smTabs.tabs === '가구 제작* 가구 창고' && !smTabs.tabsHidden && smTabs.craftBtns === workshopUtility && smTabs.storeHidden,
    `side panel tabs 가구 제작 / 가구 창고, every craft row has a 제작 button (${smTabs.craftBtns})`, JSON.stringify(smTabs));
  await H(() => [...document.querySelectorAll('.ship-manage .sm-tabs .sm-tab')].find((b) => b.textContent === '가구 창고').click());
  await sleep(120);
  const smStore = await H(() => {
    const root = document.querySelector('.ship-manage');
    // 2026-09-12: 가구 창고도 시설 가구 / 꾸밈용 가구 하위 탭으로 갈린다 — 지금 켜진 탭의 종류만 센다
    const h = window.__game.ctx.housing;
    const kind = root.querySelector('.sm-subtab.is-on')?.dataset.kind ?? 'utility';
    const stored = new Set(h.getStored().map((s) => s.defId)
      .filter((id) => ((h.getFurnitureDef(id)?.interaction ?? 'none') !== 'none') === (kind === 'utility')));
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
  await H(() => window.__game.ctx.housing.setManageRoom(7));
  await sleep(120);
  const smEmpty = await H(async () => {
    const S = await import('/src/shared/index.ts');
    const root = document.querySelector('.ship-manage');
    const h = window.__game.ctx.housing;
    const built = new Set(h.state.rooms.map((r) => r.purpose).filter((p) => p !== 'empty'));
    const listed = [...root.querySelectorAll('.sm-purposes .sm-purpose')].map((b) => b.dataset.purpose);
    return { purposes: listed.length, expected: S.ROOM_PURPOSES_ASSIGNABLE.filter((p) => !built.has(p)).length, noneBuilt: listed.every((p) => !built.has(p)), built: [...built],
      blocked: root.querySelectorAll('.sm-purposes .sm-purpose.is-blocked').length,
      genInPicker: !!root.querySelector('.sm-purposes .sm-gen'), genInRooms: !!root.querySelector('.sm-rooms .sm-gen'),
      // Phase 9 UI pass: the prose description is replaced by the 시설 증축 cost chips
      costs: root.querySelectorAll('.sm-purposes .sm-purpose .sm-cost .item-chip').length,
      descs: root.querySelectorAll('.sm-purposes .sm-purpose .ds').length,
      tabsHidden: root.querySelector('.sm-tabs').hidden,
      cardsHidden: root.querySelector('.sm-cards').hidden, head: root.querySelector('.sm-bar-head').textContent };
  });
  ok(smEmpty.purposes > 0 && smEmpty.cardsHidden && /용도 지정/.test(smEmpty.head), `an empty room shows the 용도 지정 picker instead of the furniture list (${smEmpty.purposes})`);
  ok(smEmpty.purposes === smEmpty.expected && smEmpty.noneBuilt,
    `2026-09-12: only buildable purposes the ship does not have yet are listed (${smEmpty.purposes} = 증축 가능 − built ${smEmpty.built.join(',')})`, JSON.stringify(smEmpty));
  ok(!smEmpty.genInPicker && smEmpty.genInRooms, '2026-09-12: the 발전기 row left the 용도 지정 picker and sits under the 방 목록', JSON.stringify(smEmpty));
  ok(smEmpty.costs > 0 && smEmpty.descs === 0 && smEmpty.tabsHidden,
    `용도 지정 rows carry 시설 증축 cost chips instead of a description (${smEmpty.costs} chips), 가구 탭 숨김`, JSON.stringify(smEmpty));
  /* 빈 방으로 — 2026-09-08: the header button used to call the **free** `setRoomPurpose(i, 'empty')` path, which
     housing only takes *after* `removeRoomFacility` has worked out a refund, so tearing a room down by mistake
     burned the 시설 증축 price and the player could not rebuild it. It goes through `removeRoomFacility` now (with a
     confirm popup showing the chips), and every material comes back. */
  const MATS = ['mat_scrap', 'mat_cable', 'mat_alloy', 'mat_circuit'];
  const spare = await H(() => {
    const h = window.__game.ctx.housing;
    for (let i = 0; i < h.state.rooms.length; i++) if ((h.getRoom(i)?.purpose ?? 'empty') === 'empty') return i;
    return -1;
  });
  const spareP = spare < 0 ? null : await H((i) => {
    const h = window.__game.ctx.housing;
    for (const p of ['gym', 'mining', 'kitchen', 'library', 'greenhouse']) if (!h.purposeBlock(i, p)) return p;
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
    '시설 제거 asks first and shows the materials it hands back', JSON.stringify(clrConf));
  // 2026-09-12 (사용자 결정): 시설 제거 확정은 빨간 `시설 제거` 버튼을 1초 누르고 있어야 한다 — 클릭으로는 안 된다
  const clickOnly = await H((i) => { document.querySelector('.ship-manage .sm-confirm .sm-confirm-ok').click(); return window.__game.ctx.housing.getRoom(i)?.purpose ?? null; }, spare);
  ok(clickOnly !== 'empty', `a plain click on 시설 제거 does not confirm (${clickOnly})`);
  await H(() => document.querySelector('.ship-manage .sm-confirm .sm-confirm-ok').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
  await waitFor(page, (i) => window.__game.ctx.housing.getRoom(i)?.purpose === 'empty', '시설 제거 hold', 8000, spare).catch(() => null);
  await H(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));
  await sleep(120);
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

  // 2026-09-12 (프리셋 기능 제거): openPresetMenu 는 아무것도 열지 않는다 — 프리셋 메뉴 DOM 자체가 없다
  await H(() => window.__game.ctx.housing.openPresetMenu());
  await sleep(100);
  const preDom = await H(() => ({ el: !!document.querySelector('.preset-menu'), open: window.__game.ctx.housing.isMenuOpen, blocker: window.__game.ctx.uiBlockers.has('housing') }));
  ok(!preDom.el && !preDom.open && !preDom.blocker, 'openPresetMenu() is a no-op — no preset panel, no blocker', JSON.stringify(preDom));
  // 조종석은 시설 관리의 편집 대상이다 (방 목록 맨 위)
  await H((C) => window.__game.ctx.housing.openShipManage(C), COCKPIT);
  await sleep(120);
  const cockMng = await H((C) => {
    const h = window.__game.ctx.housing;
    const r = { manage: h.shipManageMode, room: h.housingRoom, ev: window.__ev['housing:shipManageChanged'].at(-1) };
    r.setBack = h.setManageRoom(0); r.room2 = h.housingRoom;
    r.setCock = h.setManageRoom(C); r.room3 = h.housingRoom;
    return r;
  }, COCKPIT);
  ok(cockMng.manage && cockMng.room === COCKPIT && cockMng.ev?.room === COCKPIT && cockMng.setBack && cockMng.room2 === 0 && cockMng.setCock && cockMng.room3 === COCKPIT,
    'openShipManage(COCKPIT) / setManageRoom 이 조종석을 받는다', JSON.stringify(cockMng));
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
  // 2026-09-12: 방 9 는 없다 (방 8 개) · 휴식 공간은 지을 수 없다 → 방 7(index 6) 과 서재로 같은 검사를 한다
  await give('mat_scrap', 40); await give('mat_alloy', 10); await give('mat_cable', 4);
  await H(() => { window.__game.ctx.housing.setRoomPurpose(6, 'kitchen'); window.__game.ctx.housing.save(); });
  ok(await H(() => window.__fakeProfile.sets.includes('ship') && window.__fakeProfile.docs.ship.rooms[6].purpose === 'kitchen'), "offline profile (available false): save still calls profile.set('ship') — ProfileSync queues it (Phase 9)");
  await H(() => { window.__fakeProfile.available = true; window.__fakeProfile.docs = {}; window.__fakeProfile.sets.length = 0; });
  await H(() => { window.__game.ctx.housing.setRoomPurpose(6, 'library'); window.__game.ctx.housing.save(); });
  ok(await H(() => window.__fakeProfile.sets.includes('ship') && window.__fakeProfile.docs.ship.rooms[6].purpose === 'library'), "save → profile.set('ship', state)");
  const shipSnap = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  await H(() => { window.__fakeProfile.docs = {}; window.__fakeProfile.sets.length = 0; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: {}, updatedAt: 0 }, migrated: true }); });
  ok(await H(() => window.__fakeProfile.sets.includes('ship') && window.__game.ctx.housing.getRoom(6).purpose === 'library'), 'no server document → local state uploaded, nothing replaced');
  const loadedN = (await ev('housing:loaded')).length;
  await H((snap) => {
    const doc = JSON.parse(JSON.stringify(snap));
    doc.rooms[6] = { purpose: 'kitchen', level: 1 };
    doc.storageLevel = 2;
    doc.furniture.push({ uid: 'f-90', defId: 'furn_crate', room: 6, x: 0, y: 0, yaw: 0, level: 1 });
    window.__fakeProfile.docs = { ship: doc };
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false });
  }, shipSnap);
  const srv = await H(() => ({ room6: window.__game.ctx.housing.getRoom(6).purpose, storage: window.__game.ctx.housing.state.storageLevel, crate: window.__game.ctx.housing.getPlaced(6).map((f) => f.uid + ':' + f.defId), rows: window.__game.ctx.housing.getStashSize().rows,
    loaded: window.__ev['housing:loaded'].length, changed: window.__ev['housing:changed'][window.__ev['housing:changed'].length - 1], stash: window.__ev['housing:stashSizeChanged'][window.__ev['housing:stashSizeChanged'].length - 1], local: JSON.parse(localStorage.getItem('scav.s1.ship')).rooms[6].purpose, sets: window.__fakeProfile.sets.filter((k) => k === 'ship').length }));
  ok(srv.room6 === 'kitchen' && srv.storage === 2 && srv.crate.join() === 'f-90:furn_crate', 'net:profileLoaded → server ship document replaces the state (room 6 kitchen, storage 2, crate f-90)', JSON.stringify(srv));
  ok(srv.loaded === loadedN + 1 && srv.changed?.reason === 'profile', 'housing:loaded re-emitted + housing:changed {profile}', JSON.stringify({ loaded: srv.loaded, changed: srv.changed }));
  ok(srv.rows === 36 && srv.stash && srv.stash.rows === 36, 'stash size follows the server storage level (36 rows) + housing:stashSizeChanged', JSON.stringify({ rows: srv.rows, ev: srv.stash }));
  ok(srv.local === 'kitchen' && srv.sets === 1, 'localStorage cache updated, server copy not echoed back', JSON.stringify({ local: srv.local, sets: srv.sets }));
  const nextUid = await H(() => { const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); const p = h.place(6, 'furn_crate', 5, 5, 0); const uid = p?.uid; if (p) h.recover(p.uid); return uid; });
  ok(nextUid === 'f-91', `uid counter continues after the server copy's highest uid (${nextUid})`);
  /* 2026-09-11: an edit still inside the 350 ms save debounce is newer than any profile copy — a welcome landing in
     that window used to replace the state with the (older) document and cancel the write, silently undoing the edit
     (smoke-training's sim hub vanished under load). Now the edit is written (profile.set) and the state is kept. */
  const race = await H((snap) => {
    const h = window.__game.ctx.housing;
    h.save();                                                    // settle the place / recover above
    window.__fakeProfile.sets.length = 0;
    const setOk = h.setRoomPurpose(7, 'library');                  // dirty, not yet written
    const stale = JSON.parse(JSON.stringify(snap));              // the profile's copy predates the edit
    window.__fakeProfile.docs = { ship: stale };
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false });
    const r = { setOk, room7: h.getRoom(7).purpose, room6: h.getRoom(6).purpose, sets: window.__fakeProfile.sets.filter((k) => k === 'ship').length, uploaded: window.__fakeProfile.docs.ship?.rooms?.[7]?.purpose ?? null };
    h.setRoomPurpose(7, 'empty'); h.save();
    return r;
  }, shipSnap);
  ok(race.setOk && race.room7 === 'library' && race.room6 === 'kitchen' && race.sets === 1 && race.uploaded === 'library',
    'net:profileLoaded inside the save debounce keeps the unsaved edit and uploads it instead of reverting', JSON.stringify(race));
  // put the local state back through the same path (no edit pending), then restore the offline profile
  await H((snap) => { window.__game.ctx.housing.save(); window.__fakeProfile.docs = { ship: snap }; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false }); }, shipSnap);
  ok(await H(() => window.__game.ctx.housing.getRoom(6).purpose === 'library' && window.__game.ctx.housing.getPlaced(6).length === 0 && window.__game.ctx.housing.getStashSize().rows === 30), 'local state restored through net:profileLoaded');
  await H(() => { const net = window.__game.ctx.net; if (window.__realProfileDesc) Object.defineProperty(net, 'profile', window.__realProfileDesc); else delete net.profile; });
  ok(await H(() => window.__game.ctx.net.profile !== window.__fakeProfile && window.__game.ctx.net.profile.available === false), 'real (offline) profile restored');
  await H(() => window.__game.ctx.housing.setRoomPurpose(6, 'empty'));

  console.log('persistence');
  await H(() => window.__game.ctx.housing.savePreset(0, { name: '리로드', primary: null, primary2: null, secondary: null, bag: null, armor: null, implant: 'scan', implantItems: ['imp_strength_1'] }));
  await H(() => window.__game.ctx.housing.save());
  const before = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const after = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  ok(after.rooms[0].purpose === 'workshop' && after.rooms[3].purpose === 'greenhouse' && after.rooms[2].purpose === 'gym', 'room purposes persisted');
  ok(after.generatorLevel === before.generatorLevel && after.storageLevel === 1 && after.rooms[0].level === before.rooms[0].level, `facility levels persisted (gen ${after.generatorLevel}, storage ${after.storageLevel})`);
  ok(after.furniture.length === before.furniture.length && after.furniture.some((f) => f.uid === 'f-7' && f.defId === 'furn_bench_gun') && after.furniture.filter((f) => f.room === COCKPIT).length === 2, `furniture persisted incl. the cockpit's two 공용 시설 가구 (${after.furniture.length})`);
  ok(JSON.stringify(after.furnitureStorage) === JSON.stringify(before.furnitureStorage), 'furniture storage persisted');
  // 2026-09-12 (프리셋 기능 제거): savePreset 은 거절되고 세이브의 presets 필드는 손대지 않은 채 그대로 오간다
  ok(JSON.stringify(after.presets) === JSON.stringify(before.presets), 'presets field persisted untouched (feature removed, save kept)', JSON.stringify(after.presets));
  ok(await H(() => window.__game.ctx.housing.getStashSize().rows === 30), 'stash size 30 rows after reload');
  await give('mat_scrap', 20); await give('mat_cable', 4);   // the bag is not persisted — only the stash is
  /* 2026-09-11: the expected uid is **derived** from the state, not written out — it used to be the literal `f-8`,
     which every new placement earlier in the run (the 재배 스테이션 was the first) silently shifted. */
  const topUid = await H(() => window.__game.ctx.housing.state.furniture
    .reduce((m, f) => Math.max(m, Number(String(f.uid).split('-')[1]) || 0), 0));
  const next = await H(() => { const h = window.__game.ctx.housing; h.craftFurniture('furn_crate'); return h.place(6, 'furn_crate', 7, 7, 0); });
  ok(next && next.uid === `f-${topUid + 1}`, `uid counter continues after the highest persisted uid (${next?.uid}, 최고 f-${topUid})`);
  // corrupt save → sanitised, not a crash (flush first so the unload flush does not overwrite the corrupt file)
  await H(() => window.__game.ctx.housing.save());
  await H(() => localStorage.setItem('scav.s1.ship', JSON.stringify({ version: 1, rooms: [{ purpose: 'lab', level: 9 }], generatorLevel: 99, furniture: [{ uid: 'x', defId: 'nope', room: 0 }, { uid: 'f-3', defId: 'furn_crate', room: 30, x: 99, y: -1, yaw: 7, level: 5 }, { uid: 'f-3', defId: 'furn_bench_gun', room: 1, x: 0, y: 0, yaw: 0, level: 1 }, { uid: 'f-3', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }, { uid: 'bad', defId: 'furn_crate', room: 1, x: 7, y: 7, yaw: 0, level: 1 }], furnitureStorage: [{ defId: 'furn_locker', qty: 'a' }], presets: [{ name: 1, implant: 'bogus', implantItems: ['imp_strength_1', 7, null] }] })));
  await page.reload({ waitUntil: 'load' });
  await setup();
  const san = await H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.state)));
  const sanStore = san.furnitureStorage.map((e) => e.defId).sort().join(',');
  // 2026-09-07: no room-1 invariant any more — the corrupt save's room 1 = 연구실 falls back to 빈 방 (no 온실)
  ok(san.rooms.length === ROOM_COUNT && san.rooms[0].purpose === 'empty' && san.generatorLevel === 5 && san.furniture.filter((f) => f.room !== COCKPIT).length === 1 && san.furniture.find((f) => f.room !== COCKPIT)?.uid === 'f-3' && san.furniture.find((f) => f.room !== COCKPIT)?.defId === 'furn_crate' && san.furniture.filter((f) => f.room === COCKPIT).map((f) => f.uid).sort().join(',') === 'f-4,f-5' && san.presets[0].name === '프리셋' && san.presets[0].implant === null && (san.presets[0].implantItems ?? []).join(',') === 'imp_strength_1', `corrupt save sanitised: lab→빈 방 (온실 없음), gen clamped, bad rooms / purpose / overlap dropped (${JSON.stringify({ r0: san.rooms[0], g: san.generatorLevel, f: san.furniture, p: san.presets[0] })})`);
  /* 2026-09-12: 예전에는 여기 `furn_repair_bench` 가 같이 나왔다 — v1→v2 마이그레이션이 옛 프로필에 정비 벤치를
     한 개 지급했기 때문이다. 정비 벤치가 은퇴하면서 그 지급도 걷어냈으므로(지급 줄이 은퇴 가구를 걸러 내는
     두 자리보다 **아래**에 있어, 남겨 두면 배치도 안 되는 가구가 가구 창고에 쌓였다) 이제 작업대 하나뿐이다. */
  ok(sanStore === 'furn_bench_gun', `furniture that no longer fits its room went to storage, not the bin (${sanStore})`);

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
  ok(mig.version === 9, `로드하면 세이브가 v9 로 올라온다 (v${mig.version})`);
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
  // 2026-09-12: 시뮬레이션실은 지을 수 없다 — 같은 검사를 채굴 시설로 한다 (증축 재료 = 환불 재료)
  await give('mat_circuit', 4); await give('mat_alloy', 6);
  const mineSetup = await H(() => {
    const h = window.__game.ctx.housing;
    const purpose = h.setRoomPurpose(5, 'mining');
    const refund = h.facilityRefund(5);
    h.craftFurniture('furn_crate');
    const placed = h.place(5, 'furn_crate', 0, 0, 0);
    return { purpose, refund, placed: !!placed, cost: h.purposeCost('mining').map((c) => ({ defId: c.defId, qty: c.qty })) };
  });
  // Phase 9 UI pass: level 1 is paid by the 시설 증축, so even a Lv.1 room refunds that price
  ok(mineSetup.purpose && mineSetup.placed && mineSetup.refund.length > 0 && JSON.stringify(mineSetup.refund) === JSON.stringify(mineSetup.cost),
    `a 채굴 시설 refunds exactly its 시설 증축 price (${JSON.stringify(mineSetup.refund)})`, JSON.stringify(mineSetup));
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
      stored: h.getStored().reduce((n, s) => n + s.qty, 0) };
  });
  ok(removed.reason === null && removed.purpose === 'empty' && removed.level === 0, `removeRoomFacility(5) emptied the room (${removed.reason ?? 'ok'})`);
  ok(removed.stillPlaced === 0 && removed.placed > 0 && removed.stored === removed.storedBefore + removed.placed,
    `every placed piece went to furniture storage (${removed.placed} → 0, storage ${removed.storedBefore} → ${removed.stored})`);
  ok(removed.refund.every((c) => removed.stashAfter[c.defId] === removed.stashBefore[c.defId] + c.qty),
    `build materials refunded into the 함선 창고 (${JSON.stringify(removed.stashBefore)} → ${JSON.stringify(removed.stashAfter)})`);

  /* ── 2026-09-12: 방 시설 레벨 제거 — v6 → v7 마이그레이션 (순수 함수, 실제 함선은 건드리지 않는다) ──
     사격장 Lv.n 은 관물대 · 시뮬레이션 허브 레벨로 옮겨지고(배치된 것은 max, 창고에만 있으면 한 점), 둘 다 없으면 쓴
     재료가 환불된다. 작업실 Lv.n 은 옮길 곳이 없어 늘 환불이다. 이미 v7 인 세이브는 다시 옮기지 않는다. */
  console.log('세이브 마이그레이션 — v7 방 시설 레벨 · v8 방 8 개 / 시뮬레이션실 · 휴식 공간 제거 / 조종석');
  const migRooms = await H(async () => {
    const S = await import('/src/housing/ShipState.ts');
    const R = await import('/src/housing/Rules.ts');
    const SH = await import('/src/shared/index.ts');
    const rooms10 = () => Array.from({ length: 10 }, () => ({ purpose: 'empty', level: 0 }));
    const base = { generatorLevel: 5, storageLevel: 0, presets: [] };
    const q = (list, id) => list.filter((x) => x.defId === id).reduce((n, x) => n + x.qty, 0);
    const bag = (list) => Object.fromEntries([...new Set(list.map((x) => x.defId))].sort().map((id) => [id, q(list, id)]));
    const def = (id) => SH.FURNITURE_DEF_MAP.get(id);
    const retiredLeft = (st) => st.furniture.concat(st.furnitureStorage).some((x) => def(x.defId)?.retired);
    // A: v6 — 작업실 Lv.3 (방 1) + 사격장 Lv.4 (방 6, 관물대 배치) + 창고의 시뮬레이션 허브 ×2
    const a = rooms10(); a[0] = { purpose: 'workshop', level: 3 }; a[5] = { purpose: 'range', level: 4 };
    const outA = { refund: [] };
    const sa = S.sanitize({ ...base, version: 6, rooms: a,
      furniture: [{ uid: 'f-1', defId: 'furn_range_console', room: 5, x: 0, y: 0, yaw: 0, level: 1 }],
      furnitureStorage: [{ defId: 'furn_sim_hub', level: 1, qty: 2 }] }, outA);
    const wantA = [];
    R.mergeCost(wantA, R.furnitureRefundCost(def('furn_range_console'), 1));
    R.mergeCost(wantA, R.furnitureRefundCost(def('furn_sim_hub'), 1), 2);
    R.mergeCost(wantA, R.roomRefundCost('range', 1));
    R.mergeCost(wantA, R.legacyRoomLevelCost('range', 4));
    R.mergeCost(wantA, R.legacyRoomLevelCost('workshop', 3));
    // B: v7 10-room save — 방 9 주방 (식탁) · 방 10 서재 (책장 + 책 1권) · 방 7 휴식 공간 (사물함) · 방 4 온실 · 가구 창고에 시술대
    const b = rooms10(); b[3] = { purpose: 'greenhouse', level: 1 }; b[6] = { purpose: 'lounge', level: 1 }; b[8] = { purpose: 'kitchen', level: 1 }; b[9] = { purpose: 'library', level: 1 };
    const outB = { refund: [] };
    const sb = S.sanitize({ ...base, version: 7, rooms: b,
      furniture: [
        { uid: 'f-10', defId: 'furn_dining_table', room: 8, x: 0, y: 0, yaw: 0, level: 1 },
        { uid: 'f-11', defId: 'furn_bookshelf', room: 9, x: 0, y: 0, yaw: 0, level: 1 },
        { uid: 'f-12', defId: 'furn_locker', room: 6, x: 0, y: 0, yaw: 0, level: 1 },
      ],
      furnitureStorage: [{ defId: SH.IMPLANT_BAY_DEF_ID, level: 1, qty: 1 }],
      books: [{ uid: 'f-11', slot: 0, defId: 'book_gun_AR' }] }, outB);
    const wantB = [];
    for (const p of ['lounge', 'kitchen', 'library']) R.mergeCost(wantB, R.roomRefundCost(p, 1));
    R.mergeCost(wantB, [{ defId: 'book_gun_AR', qty: 1 }]);
    // C: v7, 8 rooms, 작업실 Lv.3 — 다시 옮기지 않는다 (공용 시설 가구만 채워진다)
    const c = rooms10().slice(0, 8); c[0] = { purpose: 'workshop', level: 3 };
    const outC = { refund: [] };
    const sc = S.sanitize({ ...base, version: 7, rooms: c, furniture: [], furnitureStorage: [] }, outC);
    // D: 그 결과(v8, 두 점을 다 가진 세이브)를 다시 읽으면 아무것도 바뀌지 않는다
    const outD = { refund: [] };
    const sd = S.sanitize(JSON.parse(JSON.stringify(sc)), outD);
    const inCockpit = (st) => st.furniture.filter((f) => f.room === SH.COCKPIT_ROOM_INDEX);
    return {
      a: { version: sa.version, rooms: sa.rooms.length, lv0: sa.rooms[0].level, room5: sa.rooms[5].purpose, retired: retiredLeft(sa),
        refund: bag(outA.refund), want: bag(wantA), levels: outA.migratedRoomLevels, removed: outA.migratedRooms },
      b: { rooms: sb.rooms.length, room6: sb.rooms[6].purpose, stored: bag(sb.furnitureStorage), placed: sb.furniture.filter((f) => f.room !== SH.COCKPIT_ROOM_INDEX).length,
        cockpit: inCockpit(sb).map((f) => f.defId).sort(), books: (sb.books ?? []).length,
        refund: bag(outB.refund), want: bag(wantB), removed: outB.migratedRooms, granted: outB.grantedCockpit, levels: outB.migratedRoomLevels },
      c: { lines: outC.refund.length, levels: outC.migratedRoomLevels, removed: outC.migratedRooms, lv: sc.rooms[0].level, granted: outC.grantedCockpit, cockpit: inCockpit(sc).length },
      d: { granted: outD.grantedCockpit, removed: outD.migratedRooms, same: JSON.stringify(sd.furniture) === JSON.stringify(sc.furniture) },
    };
  });
  ok(migRooms.a.version === 9 && migRooms.a.rooms === ROOM_COUNT && migRooms.a.lv0 === 1 && migRooms.a.room5 === 'empty' && !migRooms.a.retired
    && migRooms.a.levels === true && migRooms.a.removed === true,
  'v6 → v8: 방 레벨 1 · 시뮬레이션실은 빈 방 · 은퇴 가구는 하나도 남지 않는다', JSON.stringify(migRooms.a));
  ok(JSON.stringify(migRooms.a.refund) === JSON.stringify(migRooms.a.want),
    'v6 → v8 환불 = 관물대 + 허브 ×2 (은퇴) + 시뮬레이션실 증축 + 사격장 Lv.4 강화 + 작업실 Lv.3 강화', JSON.stringify({ got: migRooms.a.refund, want: migRooms.a.want }));
  ok(migRooms.b.rooms === ROOM_COUNT && migRooms.b.room6 === 'empty' && migRooms.b.placed === 0 && migRooms.b.books === 0
    && migRooms.b.stored.furn_dining_table === 1 && migRooms.b.stored.furn_bookshelf === 1 && migRooms.b.stored.furn_locker === 1 && migRooms.b.stored.furn_implant_bay === 1,
  'v7 10-room → v8: 방 9 · 10 과 휴식 공간의 가구는 전부 가구 창고로 (창고의 시술대는 그대로)', JSON.stringify(migRooms.b));
  ok(JSON.stringify(migRooms.b.refund) === JSON.stringify(migRooms.b.want) && migRooms.b.removed === true && migRooms.b.levels === false,
    'v7 → v8 환불 = 휴식 공간 · 주방 · 서재 증축 재료 + 책장에 꽂혀 있던 책', JSON.stringify({ got: migRooms.b.refund, want: migRooms.b.want }));
  ok(migRooms.b.granted === true && migRooms.b.cockpit.join() === 'furn_corp_computer',
    '가구 창고에 시술대가 있으면 다시 채우지 않고, 어디에도 없는 컴퓨터만 조종석에 채운다', JSON.stringify(migRooms.b));
  ok(migRooms.c.levels === false && migRooms.c.removed === false && migRooms.c.lines === 0 && migRooms.c.lv === 1 && migRooms.c.granted === true && migRooms.c.cockpit === 2,
    'an already-v7 save is never migrated twice (level clamps to 1, no refund) — only the 공용 시설 가구 are put in', JSON.stringify(migRooms.c));
  ok(migRooms.d.granted === false && migRooms.d.removed === false && migRooms.d.same, 'a v8 save that has both pieces is left alone', JSON.stringify(migRooms.d));

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
  ok(grant.gen === 0 && grant.rooms, `fresh ship: 발전기 Lv.0, ${ROOM_COUNT} empty rooms`);
  const assignableN = await H(async () => (await import('/src/shared/index.ts')).ROOM_PURPOSES_ASSIGNABLE.length);
  await H(() => window.__game.ctx.housing.openShipManage(3));
  await sleep(150);
  const hud = () => H(() => { const h = window.__game.getSystem('hud'); return { confirm: h.isShipManageConfirmOn, purpose: h.shipManageConfirmPurpose, manage: window.__game.ctx.housing.shipManageMode, pause: !document.querySelector('.menu.pause')?.classList.contains('hidden') }; });
  const pick0 = await H(() => {
    const root = document.querySelector('.ship-manage');
    // 2026-09-12: the 발전기 row lives under the 방 목록 now, no longer at the head of the 용도 지정 picker
    const gen = root.querySelector('.sm-rooms .sm-gen');
    return { gen: !!gen, hint: gen?.classList.contains('is-hint'), first: !root.querySelector('.sm-purposes .sm-gen'),
      genBtn: gen?.querySelector('.sm-gen-btn')?.textContent, genDisabled: gen?.querySelector('.sm-gen-btn')?.disabled, genChips: gen?.querySelectorAll('.sm-cost .item-chip').length,
      genNote: gen?.querySelector('.sm-block')?.textContent ?? '',
      purposes: root.querySelectorAll('.sm-purposes .sm-purpose').length, blocked: root.querySelectorAll('.sm-purposes .sm-purpose.is-blocked').length,
      disabled: root.querySelectorAll('.sm-purposes .sm-purpose:disabled').length,
      reasons: [...root.querySelectorAll('.sm-purposes .sm-purpose .sm-block')].map((e) => e.textContent),
      workshopReason: root.querySelector('.sm-purpose[data-purpose="workshop"] .sm-block')?.textContent ?? '' };
  });
  ok(pick0.gen && pick0.first && pick0.hint, 'a highlighted 발전기 row under the 방 목록 (not in the picker) — the gate is what blocks everything');
  ok(pick0.genBtn === '가동' && pick0.genDisabled === false && pick0.genChips === 1 && /발전기 Lv.1/.test(pick0.genNote), `발전기 row: 가동 button enabled, 1 cost chip, guidance text (${pick0.genNote})`);
  ok(pick0.purposes === assignableN && pick0.blocked === assignableN && pick0.disabled === 0, `all ${assignableN} buildable purposes blocked but none is a disabled button (${pick0.blocked} blocked, ${pick0.disabled} disabled)`);
  ok(pick0.reasons.length === assignableN && /발전기 레벨 1 필요 \(현재 0\)/.test(pick0.workshopReason), `each row prints its reason inline (${pick0.workshopReason})`);
  // clicking a blocked purpose: no popup, the reason toasts
  await H(() => document.querySelector('.ship-manage .sm-purpose[data-purpose="workshop"]').click());
  await sleep(80);
  const denied = await hud();
  const deniedToast = await H(() => [...document.querySelectorAll('.notifs .notif')].some((n) => /발전기 레벨 1 필요/.test(n.textContent)));
  ok(!denied.confirm && denied.manage && deniedToast, 'clicking a blocked purpose → no popup, the reason as a toast');
  // 발전기 가동: confirm popup, Esc closes only the popup, 확인 raises the generator
  await H(() => document.querySelector('.ship-manage .sm-gen-btn').click());
  await sleep(80);
  const genPop = await H(() => { const c = document.querySelector('.ship-manage .sm-confirm'); return { hidden: c.hidden, title: c.querySelector('.title').textContent, chips: c.querySelectorAll('.cost .item-chip').length, ok: c.querySelector('.sm-confirm-ok')?.textContent }; });
  ok(!genPop.hidden && /발전기 Lv\.0 → Lv\.1/.test(genPop.title) && genPop.chips === 1 && genPop.ok === '확인', `발전기 confirm popup (${genPop.title})`);
  await tap('Escape');
  await sleep(80);
  const escd = await hud();
  ok(!escd.confirm && escd.manage && !escd.pause, 'Esc closes the popup only — still in 시설 관리, no pause menu');
  await H(() => document.querySelector('.ship-manage .sm-gen-btn').click());
  await sleep(60);
  await H(() => document.querySelector('.ship-manage .sm-confirm .sm-confirm-ok').click());
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
  await H(() => document.querySelector('.ship-manage .sm-confirm .sm-confirm-ok').click());
  await sleep(150);
  const built = await H(() => ({ purpose: window.__game.ctx.housing.getRoom(3).purpose, level: window.__game.ctx.housing.getRoom(3).level,
    scrap: window.__game.ctx.inventory.countDefAll('mat_scrap'), cable: window.__game.ctx.inventory.countDefAll('mat_cable'),
    head: document.querySelector('.ship-manage .sm-bar-head').textContent, cards: document.querySelectorAll('.ship-manage .sm-cards .fcard').length,
    confirm: window.__game.getSystem('hud').isShipManageConfirmOn }));
  ok(built.purpose === 'workshop' && built.level === 1 && !built.confirm, `확인 → 방 4 is a 작업실 Lv.1 (${built.purpose})`);
  ok(built.scrap === 12 && built.cable === 2, `증축 consumed 폐금속 8 · 케이블 2 from the 창고 (left ${built.scrap} · ${built.cable})`);
  ok(/작업실/.test(built.head) && built.cards === workshopUtility, `side panel switched to the 작업실 furniture list — 시설 가구 (${built.cards} cards)`);
  ok((await lastEv('housing:roomPurposeChanged'))?.room === 3, 'housing:roomPurposeChanged {room:3}');

  /* ── 2026-09-12: 가구 제작 하위 탭 · 이미 보유 중 · 선택 → 위치 이동 상태 · 놓을 수 없는 곳 토스트 ─────────── */
  console.log('시설 관리 — 하위 탭 · 위치 이동 상태 (2026-09-12)');
  const lockerUid = await H(() => {
    const h = window.__game.ctx.housing;
    h.state.furnitureStorage.push({ defId: 'furn_locker', level: 1, qty: 1 }, { defId: 'furn_bench_gun', level: 1, qty: 1 });
    return h.place(3, 'furn_locker', 0, 0, 0)?.uid ?? null;
  });
  await sleep(150);
  const sub = await H(() => {
    const root = document.querySelector('.ship-manage');
    const h = window.__game.ctx.housing;
    const cards = [...root.querySelectorAll('.sm-cards .fcard')];
    const bench = root.querySelector('.sm-cards .fcard[data-def-id="furn_bench_gun"]');
    return {
      hidden: root.querySelector('.sm-subtabs').hidden,
      labels: [...root.querySelectorAll('.sm-subtabs .sm-subtab')].map((b) => `${b.textContent}${b.classList.contains('is-on') ? '*' : ''}`).join(' '),
      allUtility: cards.every((c) => h.getFurnitureDef(c.dataset.defId).interaction !== 'none'),
      ownCounts: root.querySelectorAll('.sm-cards .fcard .fcard-own').length,
      benchBtn: bench?.querySelector('.fcard-craft')?.textContent ?? null, benchDisabled: bench?.querySelector('.fcard-craft')?.disabled ?? null,
      benchNote: bench?.querySelector('.fcard-note')?.textContent ?? '',
    };
  });
  ok(!sub.hidden && sub.labels === '시설 가구* 꾸밈용 가구' && sub.allUtility, `가구 제작 has 시설 가구 / 꾸밈용 가구 sub-tabs, 시설 가구 first (${sub.labels})`, JSON.stringify(sub));
  ok(sub.ownCounts === 0, '시설 가구 cards carry no 보유 count', JSON.stringify(sub));
  ok(sub.benchBtn === '이미 보유 중' && sub.benchDisabled === true && !/이미 보유 중입니다/.test(sub.benchNote),
    'an owned 총기 작업대: button reads 이미 보유 중 (disabled), no "이미 보유 중입니다" line under the card', JSON.stringify(sub));
  await H(() => document.querySelector('.ship-manage .sm-subtab[data-kind="decor"]').click());
  await sleep(120);
  const decor = await H(() => {
    const root = document.querySelector('.ship-manage');
    const h = window.__game.ctx.housing;
    const cards = [...root.querySelectorAll('.sm-cards .fcard')];
    return { n: cards.length, want: h.getFurnitureFor('workshop').filter((d) => d.interaction === 'none').length,
      allDecor: cards.every((c) => h.getFurnitureDef(c.dataset.defId).interaction === 'none'),
      own: cards.every((c) => !!c.querySelector('.fcard-own')), kind: window.__game.getSystem('hud').shipManage.craftKind };
  });
  ok(decor.n === decor.want && decor.allDecor && decor.own && decor.kind === 'decor', `꾸밈용 가구 tab: ${decor.n} decor cards, each with its 보유 count`, JSON.stringify(decor));
  await H(() => document.querySelector('.ship-manage .sm-subtab[data-kind="utility"]').click());

  // 선택만 한다: 시설 관리의 클릭 경로(`primary`)는 놓인 조각을 집지 않는다
  const guideLabels = () => H(() => window.__game.getSystem('hud').keyGuide.entries.map((e) => e.label).join(' · '));
  const pickNot = await H((uid) => {
    const m = window.__game.getSystem('hub').housing;
    const p = window.__game.ctx.housing.getPlacedByUid(uid);
    m.cursorInRoom = true; m.cell.x = p.x; m.cell.y = p.y; m.cell.valid = true;
    const put = m.primary();
    return { put, moving: m.moving };
  }, lockerUid);
  ok(!!lockerUid && pickNot.put === null && pickNot.moving === false, 'a click on a placed piece in 시설 관리 does not pick it up', JSON.stringify(pickNot));
  await H((uid) => window.__game.getSystem('hub').housing.select(uid), lockerUid);
  await waitSim(0.15);
  const sel1 = await H(() => ({ open: window.__game.getSystem('hud').shipManage.isInspectOpen, uid: window.__game.getSystem('hud').shipManage.inspectedUid,
    moveBtn: !!document.querySelector('.ship-manage .sm-ins-move') }));
  // 2026-09-12 (사용자 결정): 인스펙터의 위치 이동 버튼은 없어졌다 — E 또는 LMB 꾹 누르기로 든다
  ok(sel1.open && sel1.uid === lockerUid && !sel1.moveBtn, 'selected → 인스펙터 (no 위치 이동 button any more)', JSON.stringify(sel1));
  ok((await guideLabels()) === '위치 이동 · 닫기', `key guide while selected: E 위치 이동 only (${await guideLabels()})`);
  await H((uid) => window.__game.ctx.bus.emit('housing:moveRequested', { uid }), lockerUid);
  await waitSim(0.15);
  const mv1 = await H(() => { const m = window.__game.getSystem('hub').housing;
    return { moving: m.moving, uid: m.movingUid, ev: window.__ev['housing:moveStateChanged'].at(-1) }; });
  ok(mv1.moving && mv1.uid === lockerUid && mv1.ev?.active === true && mv1.ev?.uid === lockerUid,
    'housing:moveRequested → move state (housing:moveStateChanged)', JSON.stringify(mv1));
  ok((await guideLabels()) === '설치 · 회전 · 회수 · 닫기', `key guide in the move state: LMB 설치 · R 회전 · X 회수 (${await guideLabels()})`);
  // 놓을 수 없는 곳: 방 밖 · 겹침 → 거부 + 인스펙터 위 토스트, 상태는 그대로
  const refused = await H(() => {
    const m = window.__game.getSystem('hub').housing;
    m.cursorInRoom = false; m.placeMoving();
    const out = { r1: window.__ev['housing:placeRefused'].at(-1)?.reason, t1: window.__game.getSystem('hud').shipManage.toastText };
    m.cursorInRoom = true; m.cell.x = 0; m.cell.y = 0; m.cell.valid = false; m.placeMoving();
    out.r2 = window.__ev['housing:placeRefused'].at(-1)?.reason; out.moving = m.moving;
    out.dockOrder = [...document.querySelector('.ship-manage .sm-dock').children].map((c) => c.className.split(' ')[0]).join(',');
    return out;
  });
  ok(refused.r1 === '방 밖에는 설치할 수 없습니다' && refused.t1 === refused.r1 && refused.r2 === '설치할 수 없는 곳입니다' && refused.moving,
    'a refused spot says why in a toast and keeps the move state', JSON.stringify(refused));
  ok(refused.dockOrder === 'sm-toast,sm-inspect', 'the toast sits above the 인스펙터 in the bottom dock', refused.dockOrder);
  const placedOk = await H((uid) => {
    const m = window.__game.getSystem('hub').housing, h = window.__game.ctx.housing;
    const p = h.getPlacedByUid(uid);
    let spot = null;
    for (let x = 0; x < 8 && !spot; x++) for (let y = 7; y >= 0 && !spot; y--) if ((x !== p.x || y !== p.y) && h.canPlace(3, 'furn_locker', x, y, p.yaw, uid)) spot = { x, y };
    m.cursorInRoom = true; m.cell.x = spot.x; m.cell.y = spot.y; m.cell.valid = true; m.placeMoving();
    const q = h.getPlacedByUid(uid);
    return { spot, at: [q.x, q.y], moving: m.moving, inspected: window.__game.getSystem('hud').shipManage.inspectedUid };
  }, lockerUid);
  ok(placedOk.at[0] === placedOk.spot.x && placedOk.at[1] === placedOk.spot.y && !placedOk.moving && placedOk.inspected === lockerUid,
    'a valid click puts it down and ends the move state (인스펙터 stays on the piece)', JSON.stringify(placedOk));
  // E 로 들고 C 로 되돌린다 (제자리)
  await tap('KeyE');
  await waitSim(0.15);
  const byE = await H(() => ({ moving: window.__game.getSystem('hub').housing.moving }));
  await tap('KeyC');
  await waitSim(0.15);
  const byC = await H((uid) => { const p = window.__game.ctx.housing.getPlacedByUid(uid); return { moving: window.__game.getSystem('hub').housing.moving, at: [p.x, p.y], manage: window.__game.ctx.housing.shipManageMode }; }, lockerUid);
  ok(byE.moving && !byC.moving && byC.manage && byC.at[0] === placedOk.at[0] && byC.at[1] === placedOk.at[1],
    'E enters the move state, C cancels it (piece where it was, still in 시설 관리)', JSON.stringify({ byE, byC }));
  await tap('KeyE');
  await waitSim(0.15);
  await tap('KeyX');
  await waitSim(0.15);
  const byX = await H((uid) => ({ gone: !window.__game.ctx.housing.getPlacedByUid(uid), rec: window.__ev['housing:furnitureRecovered'].at(-1)?.uid,
    moving: window.__game.getSystem('hub').housing.moving, open: window.__game.getSystem('hud').shipManage.isInspectOpen }), lockerUid);
  ok(byX.gone && byX.rec === lockerUid && !byX.moving && !byX.open, 'X in the move state recovers the piece and closes the 인스펙터', JSON.stringify(byX));
  // 가구 창고에서 새로 놓는 것도 같은 상태다 — 놓으면(남은 수량이 있어도) 끝난다
  const fromStore = await H(async () => {
    const h = window.__game.ctx.housing, m = window.__game.getSystem('hub').housing;
    h.state.furnitureStorage.push({ defId: 'furn_crate', level: 1, qty: 2 });
    h.selectFurniture('furn_crate');
    return { moving: m.moving, uid: m.movingUid };
  });
  await waitSim(0.15);
  const fromStoreGuide = await guideLabels();
  const storePlaced = await H(() => {
    const h = window.__game.ctx.housing, m = window.__game.getSystem('hub').housing;
    let spot = null;
    for (let x = 0; x < 8 && !spot; x++) for (let y = 7; y >= 0 && !spot; y--) if (h.canPlace(3, 'furn_crate', x, y, h.selectedYaw)) spot = { x, y };
    const before = window.__ev['housing:furniturePlaced'].length;
    m.cursorInRoom = true; m.cell.x = spot.x; m.cell.y = spot.y; m.cell.valid = true; m.placeMoving();
    return { placed: window.__ev['housing:furniturePlaced'].length === before + 1, sel: h.selectedFurniture, moving: m.moving,
      left: h.getStored().find((s) => s.defId === 'furn_crate')?.qty ?? 0 };
  });
  ok(fromStore.moving && fromStore.uid === null && fromStoreGuide === '설치 · 회전 · 회수 · 닫기', 'a storage pick is the same move state (guide 설치 · 회전 · 회수)', JSON.stringify({ fromStore, fromStoreGuide }));
  ok(storePlaced.placed && storePlaced.sel === null && !storePlaced.moving && storePlaced.left === 1, 'placing it ends the state even with one more in storage', JSON.stringify(storePlaced));
  await H(() => window.__game.ctx.housing.closeShipManage());
  await sleep(80);

  /* ── 2026-09-12: 원격 가구 연출 (캐릭터 버프 · 가구 자세 동기화 §6-C) ─────────────────────────────────────────────
     같은 함선(`hubSite`)의 분대원 ref 가 `furniturePose.furnitureUid` 로 가리키는 조각을 그 사람의 위상으로 돌린다. 릴레이 없이
     `hub.debugRemoteFurniture` 로 가짜 ref 를 심는다 (HudSystem.debugRemotes 와 같은 모양). 조각의 움직이는 그룹은 이름으로 찾는다
     — `FurnitureLeisure` 의 rigGroup 이름: barbell · plates · belt · crank · flywheel. */
  console.log('원격 가구 연출 (2026-09-12)');
  const gymRoom = await H(() => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = Math.max(h.state.generatorLevel ?? 0, 5);
    for (let i = 0; i < h.state.rooms.length; i++) if (h.getRoom(i).purpose === 'gym') return i;
    for (let i = 0; i < h.state.rooms.length; i++) {
      if (h.getRoom(i).purpose === 'empty' && !h.getPlaced().some((p) => p.room === i)) { h.state.rooms[i].purpose = 'gym'; return i; }
    }
    return -1;
  });
  const placeGym = (defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    h.state.furnitureStorage.push({ defId, level: 1, qty: 1 });
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return null;
    return h.place(room, defId, spot.x, spot.y, spot.yaw)?.uid ?? null;
  }, { room: gymRoom, defId });
  const rackUid = gymRoom >= 0 ? await placeGym('furn_bench_rack') : null;
  const treadUid = gymRoom >= 0 ? await placeGym('furn_treadmill') : null;
  const bikeUid = gymRoom >= 0 ? await placeGym('furn_exercise_bike') : null;
  ok(!!rackUid, `a 벤치 랙 is placed in a 헬스장 (room ${gymRoom}) — treadmill ${treadUid} · bike ${bikeUid}`);
  await waitFor(page, (uid) => !!window.__game.getSystem('hub').furnitureLayer?.objectOf(uid), 'bench rack model', 10000, rackUid);
  // rig 읽기: 바 y · 원반 보임 · 벨트 z · 크랭크 x (모델이 재빌드되면 그룹이 바뀌므로 매번 uid 로 다시 찾는다)
  const rigState = (uids) => H((u) => {
    const layer = window.__game.getSystem('hub').furnitureLayer;
    const g = (uid) => (uid ? layer.objectOf(uid) : null);
    const bar = g(u.rack)?.getObjectByName('barbell'), plates = g(u.rack)?.getObjectByName('plates');
    return {
      barY: bar?.position.y ?? null, barZ: bar?.position.z ?? null, plates: plates?.visible ?? null,
      beltZ: g(u.tread)?.getObjectByName('belt')?.position.z ?? null,
      crankX: g(u.bike)?.getObjectByName('crank')?.rotation.x ?? null,
      staged: layer.remoteStage.map((s) => `${s.kind}:${s.uid}`).sort().join(','),
    };
  }, uids);
  const U = { rack: rackUid, tread: treadUid, bike: bikeUid };
  const rest0 = await rigState(U);
  const poseUid = await H((uid) => window.__game.getSystem('hub').furnitureLayer.poseFor(uid)?.furnitureUid ?? null, rackUid);
  ok(poseUid === rackUid, `poseFor(bench rack).furnitureUid names the piece (${poseUid})`);
  ok(rest0.plates === false && Math.abs(rest0.barY - (0.4 + 0.81 - 0.07)) < 1e-3 && rest0.staged === '', 'at rest: plates hidden, bar on its J hooks (y 1.14), nothing staged', JSON.stringify(rest0));
  // 가짜 원격 분대원: 우리와 같은 함선 · 벤치 랙 위상 0 (가슴)
  await H((u) => {
    const hub = window.__game.getSystem('hub');
    const mk = (id, slot, pose) => ({ id, name: `원격 ${slot}`, slot, connected: true, stale: false, suspended: false, hubSite: hub.hubSite, furniturePose: pose });
    window.__fpRemotes = [
      mk('debug-fp-1', 1, { kind: 'bench', anchorY: 0.4, yaw: 0, phase: 0, furnitureUid: u.rack }),
      mk('debug-fp-2', 2, u.tread ? { kind: 'run', anchorY: 0.19, yaw: 0, phase: 10, furnitureUid: u.tread } : null),
      mk('debug-fp-3', 3, u.bike ? { kind: 'cycle', anchorY: 0.93, yaw: 0, phase: 0.25, furnitureUid: u.bike } : null),
    ];
    hub.debugRemoteFurniture(window.__fpRemotes);
  }, U);
  await waitSim(0.8);   // UNRACK_S 0.6 초 — 바가 거치대에서 가슴 위로 다 옮겨 간다
  const low = await rigState(U);
  ok(low.plates === true && Math.abs(low.barY - (0.4 + 0.5)) < 0.01 && Math.abs(low.barZ - (0.6 - 0.03)) < 0.01,
    `remote bench phase 0 → plates on, bar on the chest (y ${low.barY?.toFixed(3)} ≈ 0.90, z ${low.barZ?.toFixed(3)} ≈ 0.57)`, JSON.stringify(low));
  ok(low.staged.includes(`bench:${rackUid}`), `layer.remoteStage lists the bench (${low.staged})`);
  if (bikeUid) ok(Math.abs(low.crankX - (-Math.PI / 2)) < 1e-3, `remote bike 0.25 revolutions → crank −π/2 (${low.crankX?.toFixed(3)})`);
  const belt0 = low.beltZ;
  // 위상을 옮긴다: 벤치 1 (팔 다 편 자리) · 트레드밀 +1 걸음 · 사이클 +2.5 바퀴
  await H(() => { const r = window.__fpRemotes; r[0].furniturePose.phase = 1; if (r[1].furniturePose) r[1].furniturePose.phase = 11; if (r[2].furniturePose) r[2].furniturePose.phase = 2.75; });
  await waitSim(0.1);
  const high = await rigState(U);
  ok(Math.abs(high.barY - (0.4 + 0.81)) < 0.01 && Math.abs(high.barZ - (0.6 + 0.06)) < 0.01, `remote bench phase 1 → bar at arms' length (y ${high.barY?.toFixed(3)} ≈ 1.21)`, JSON.stringify(high));
  // 한 걸음 = RUN_BELT_SPEED 2.4 / RUN_STRIDE_HZ 2.8 m, 줄무늬 간격 0.18 로 감긴다
  const stride = 2.4 / 2.8, spacing = 0.18, wrap = (x) => ((x % spacing) + spacing) % spacing;
  if (treadUid) ok(Math.abs(high.beltZ - wrap(belt0 + stride)) < 1e-3, `remote treadmill +1 step → belt +${stride.toFixed(3)} m wrapped (${belt0?.toFixed(3)} → ${high.beltZ?.toFixed(3)})`);
  if (bikeUid) ok(Math.abs(high.crankX - (-Math.PI * 2 * 0.75)) < 1e-3, `remote bike 2.75 revolutions → crank −1.5π (${high.crankX?.toFixed(3)})`);
  // 위상이 0 으로 되돌아가도 (자세 재시작) 벨트는 거꾸로 감기지 않는다 · 방을 다시 지어도 새 rig 가 곧바로 같은 자리를 받는다
  await H((room) => { const r = window.__fpRemotes; if (r[1].furniturePose) r[1].furniturePose.phase = 0; window.__game.getSystem('hub').furnitureLayer.rebuildRoom(room); }, gymRoom);
  await waitSim(0.1);
  const rebuilt = await rigState(U);
  ok(rebuilt.plates === true && Math.abs(rebuilt.barY - (0.4 + 0.81)) < 0.01, 'a rebuilt room: the new bench model is found by uid and staged again (plates on, bar up)', JSON.stringify(rebuilt));
  if (treadUid) ok(Math.abs(rebuilt.beltZ - high.beltZ) < 1e-3, `treadmill phase reset 11 → 0: belt does not spin back (${high.beltZ?.toFixed(3)} → ${rebuilt.beltZ?.toFixed(3)})`);
  // 다른 함선에 있는 분대원은 연출하지 않는다
  await H(() => { const r = window.__fpRemotes; for (const x of r) x.hubSite = 'someone-else'; });
  await waitSim(0.1);
  const otherSite = await rigState(U);
  ok(otherSite.staged === '' && otherSite.plates === false && Math.abs(otherSite.barY - (0.4 + 0.81 - 0.07)) < 1e-3, 'a remote in another hubSite stages nothing — rig restored', JSON.stringify(otherSite));
  // 같은 함선으로 돌아와 다시 올라간 뒤, 자세가 끝나면(furniturePose null) 원래대로
  await H(() => { const hub = window.__game.getSystem('hub'); for (const x of window.__fpRemotes) x.hubSite = hub.hubSite; });
  await waitSim(0.8);
  const again = await rigState(U);
  await H(() => { for (const x of window.__fpRemotes) x.furniturePose = null; });
  await waitSim(0.1);
  const ended = await rigState(U);
  ok(again.plates === true && ended.plates === false && Math.abs(ended.barY - (0.4 + 0.81 - 0.07)) < 1e-3 && ended.staged === '',
    `the pose ends → plates hidden, bar back on the hooks (y ${ended.barY?.toFixed(3)}), nothing staged`, JSON.stringify({ again, ended }));
  await H(() => { window.__game.getSystem('hub').debugRemoteFurniture(null); delete window.__fpRemotes; });

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
