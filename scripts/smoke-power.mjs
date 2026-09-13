// Single-player smoke test for **발전기 전력** (2026-09-13, docs/plans/power-crypto.md §전력 — housing `PowerRules` · `parts/Power` ·
// `ShipState` v12 · `ui/StationShell` 전력 줄 · ui `hud/ShipManage` 전력 패널 · 인스펙터).
//   0. 계약 API · 새 함선 v12 · 발전기 최대 Lv.10 · 공급표 Lv.0–10 = `GENERATOR_POWER_BY_LEVEL`.
//   1. 요구 = `ROOM_PURPOSE_POWER` + 활성 가구 `power` (+ 클러스터 코어 × `COMPUTE_CLUSTER_POWER_PER_CORE`) · 새 시설은 남는 전력에서 기본 요구 ·
//      배치하면 남는 전력에서 보충(`POWER_AUTO_TOPUP`) · 할당 한도(공급 초과 거절) · 할당 0 → 작업대 막힘(사유 · 작동 레벨 0 · 가방 제작 목록) ·
//      남는 전력이 없을 때 배치 → 보충 없음 + 토스트 · 비활성화 = 요구에서 빠짐 + 그 가구만 막힘 · 전력 0 가구는 비활성화 불가 ·
//      메인 컴퓨터가 멈추면 클러스터 막힘 · 헬스장 막힘.
//   2. 재배 시계 — 시각을 흉내 내(`housing.nowMs` 대체) 심고 → 1/4 진행 → 전력을 끊으면 `pausedAt` · 이벤트 → 시간이 흘러도 진행도 고정 · 수확 거절 →
//      전력을 되돌리면 `pausedMs` = 멈춘 시간 · `readyAt` 이 그만큼 밀린다 → 남은 시간 뒤 여문다.
//   3. 서재 보너스 — 전력이 있으면 > 1, 할당 0 이면 1.
//   4. v12 이관 — 할당 없는 v11 세이브 = 방 순서대로 요구량 통째로(모자란 시설은 건너뛴다) · `migratedPower` · v12 세이브의 공급 초과 = 높은 방부터 절삭 ·
//      배치되지 않은 uid 의 비활성 · 멈춤 기록은 버린다.
//   5. 화면 — 재배 스테이션 화면의 `.hpw-toggle` · `.hpw-banner` · 시설 관리 `.sm-pw` 행 · 요구량 맞추기 · 인스펙터 `.sm-pw-ins` · `.sm-pw-toggle`.
// Usage: node scripts/smoke-power.mjs [http://localhost:5273/]   (needs `npm run dev`)
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

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const note = (label) => { skip++; console.log(`  SKIP ${label}`); };
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
    '--window-size=1440,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });
  const H = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    window.__ev = {};
    for (const n of ['housing:powerChanged', 'housing:operationalChanged', 'ui:notify']) {
      window.__ev[n] = [];
      window.__game.ctx.bus.on(n, (p) => window.__ev[n].push(JSON.parse(JSON.stringify(p))));
    }
  });
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await H(() => { const st = window.__game.getSystem('inventory').getStash(); for (const p of st.items()) st.remove(p.item.uid); });
  const ev = (n) => H((k) => window.__ev[k].slice(), n);
  const clearEv = () => H(() => { for (const k of Object.keys(window.__ev)) window.__ev[k].length = 0; });
  const giveStash = (defId, qty) => H(({ defId, qty }) => {
    const ctx = window.__game.ctx;
    const def = ctx.loot.getItemDef(defId);
    if (!def) return -1;
    let added = 0;
    while (added < qty) {
      const n = Math.min(def.stackMax ?? 1, qty - added);
      if (!ctx.inventory.tryAddToStash(ctx.loot.createItem(defId, n))) break;
      added += n;
    }
    return added;
  }, { defId, qty });
  /** 가구 창고에 한 점 넣고 그 방의 자동 배치 자리에 놓는다 (재료 없이 — 제작 규칙은 smoke-housing 의 몫). */
  const placeFurn = (room, defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    if (!h.getFurnitureDef(defId)) return { err: `no def ${defId}` };
    h.addToStorage(defId, 1);
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return { err: 'no spot' };
    const p = h.place(room, defId, spot.x, spot.y, spot.yaw);
    return p ? { uid: p.uid } : { err: 'place refused' };
  }, { room, defId });
  const fac = (room) => H((room) => JSON.parse(JSON.stringify(window.__game.ctx.housing.getFacilityPower(room))), room);
  const overview = () => H(() => JSON.parse(JSON.stringify(window.__game.ctx.housing.getPowerOverview())));

  /* ══ 0. 계약 · 공급표 ══════════════════════════════════════════════════════ */
  console.log('계약 · 공급표');
  const api = await H(() => ['getPowerOverview', 'getFacilityPower', 'setPowerAllocation', 'isFurnitureDisabled', 'setFurnitureDisabled',
    'furnitureOperationalBlock', 'stationNow', 'getOperationalBenchLevel', 'benchOperationalBlock']
    .filter((k) => typeof window.__game.ctx.housing[k] !== 'function'));
  ok(api.length === 0, 'HousingRef 전력 API 9종', `missing: ${api.join(', ')}`);
  const st0 = await H(() => { const s = window.__game.ctx.housing.state; return { v: s.version, alloc: s.powerAlloc, dis: s.disabledFurniture, paused: s.pausedAt }; });
  ok(st0.v === 12 && st0.alloc && Object.keys(st0.alloc).length === 0 && Array.isArray(st0.dis) && st0.dis.length === 0 && st0.paused && Object.keys(st0.paused).length === 0,
    `새 함선 = v12 · powerAlloc {} · disabledFurniture [] · pausedAt {} (${JSON.stringify(st0)})`);
  const table = await H(async () => {
    const S = await import('/src/shared/index.ts');
    const h = window.__game.ctx.housing;
    const out = { max: h.getFacility('generator').maxLevel, want: S.GENERATOR_MAX_LEVEL, rows: [] };
    for (let lv = 0; lv <= 10; lv++) {
      h.state.generatorLevel = lv;
      out.rows.push([lv, h.getPowerOverview().supply, S.GENERATOR_POWER_BY_LEVEL[lv]]);
    }
    h.state.generatorLevel = 0;
    out.costs = [6, 7, 8, 9, 10].map((lv) => (S.GENERATOR_UPGRADE_COST[lv - 1] ?? []).length);
    return out;
  });
  ok(table.max === 10 && table.want === 10, `발전기 최대 Lv.10 (${table.max})`);
  ok(table.rows.every(([, got, want]) => typeof want === 'number' && got === want) && table.rows[10][1] > table.rows[5][1],
    `공급 = GENERATOR_POWER_BY_LEVEL[Lv] (Lv.0–10: ${table.rows.map((r) => r[1]).join(' ')})`);
  ok(table.costs.every((n) => n > 0), `발전기 Lv.6–10 강화 비용이 있다 (${table.costs.join(' ')})`);

  /* ══ 1. 요구 · 할당 · 막힘 ═════════════════════════════════════════════════ */
  console.log('요구 · 할당 · 막힘');
  const K = await H(async () => {
    const S = await import('/src/shared/index.ts');
    const d = (id) => window.__game.ctx.housing.getFurnitureDef(id);
    return {
      base: { ...S.ROOM_PURPOSE_POWER }, perCore: S.COMPUTE_CLUSTER_POWER_PER_CORE, topup: S.POWER_AUTO_TOPUP,
      short: S.POWER_SHORT_REASON_KO, disabled: S.FURNITURE_DISABLED_REASON_KO, computer: S.MINING_COMPUTER_REQUIRED_REASON_KO,
      pw: Object.fromEntries(['furn_bench_gun', 'furn_bench_gear', 'furn_grow_station', 'furn_bookshelf', 'furn_compute_cluster', 'furn_mining_computer',
        'furn_treadmill', 'furn_plant'].map((id) => [id, d(id)?.power ?? null])),
    };
  });
  // 방: 0 작업실 · 1 온실 · 2 서재 · 3 채굴 · 4 헬스장 (용도는 state 에 직접 — 증축 규칙은 smoke-housing 의 몫)
  const ROOMS = { workshop: 0, greenhouse: 1, library: 2, mining: 3, gym: 4 };
  await H((ROOMS) => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = 10;
    for (const [p, i] of Object.entries(ROOMS)) { h.state.rooms[i].purpose = p; h.state.rooms[i].level = 1; }
    h.changed('smoke');
  }, ROOMS);
  const ov0 = await overview();
  ok(ov0.facilities.length === 5 && ov0.facilities.every((f) => f.base === (K.base[f.purpose] ?? 0) && f.required === f.base && f.powered),
    `새 시설 5곳 = 기본 요구만큼 ${K.topup ? '남는 전력에서 자동으로 받는다' : '요구'} (${ov0.facilities.map((f) => `${f.purpose}:${f.allocated}/${f.required}`).join(' ')})`);
  ok(ov0.supply > 0 && ov0.free === ov0.supply - ov0.allocated && ov0.required === ov0.facilities.reduce((s, f) => s + f.required, 0), `개요: 공급 ${ov0.supply} · 할당 ${ov0.allocated} · 남음 ${ov0.free} · 요구 합 ${ov0.required}`);

  const gun = await placeFurn(ROOMS.workshop, 'furn_bench_gun');
  ok(!!gun.uid, `총기 작업대 배치 (${JSON.stringify(gun)})`);
  const w1 = await fac(ROOMS.workshop);
  ok(w1.required === K.base.workshop + K.pw.furn_bench_gun && w1.furniture.length === 1 && w1.furniture[0].demand === K.pw.furn_bench_gun,
    `요구 = 기본 ${K.base.workshop} + 작업대 ${K.pw.furn_bench_gun} (${w1.required})`, JSON.stringify(w1));
  if (K.topup) ok(w1.powered && w1.allocated === w1.required, `배치 → 남는 전력에서 보충 (할당 ${w1.allocated})`);
  else note('POWER_AUTO_TOPUP 0 — 보충 검사 건너뜀');

  const gate = await H(({ uid }) => {
    const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
    const shipGun = () => inv.getRecipes('ship').filter((r) => r.bench === 'gun' && r.station === 'ship').length;
    const r = { lvOn: h.getOperationalBenchLevel('gun'), blockOn: h.furnitureOperationalBlock(uid), listOn: shipGun() };
    r.over = h.setPowerAllocation(0, 99999);
    r.neg = h.setPowerAllocation(0, -1);
    r.cut = h.setPowerAllocation(0, 0);
    r.block = h.furnitureOperationalBlock(uid);
    r.lv = h.getOperationalBenchLevel('gun');
    r.raw = h.getBenchLevel('gun');
    r.benchBlock = h.benchOperationalBlock('gun');
    r.listOff = shipGun();
    r.alloc = h.getFacilityPower(0).allocated;
    return r;
  }, gun);
  ok(gate.lvOn === 1 && gate.blockOn === null && gate.listOn > 0, `전력이 있으면 작동 (레벨 ${gate.lvOn} · 가방 목록의 총기 작업대 레시피 ${gate.listOn})`);
  ok(typeof gate.over === 'string' && typeof gate.neg === 'string' && gate.cut === null, `공급 초과 · 음수 할당 거절 (${gate.over} / ${gate.neg})`);
  ok(gate.block === K.short && gate.lv === 0 && gate.raw === 1 && gate.benchBlock === K.short && gate.listOff === 0 && gate.alloc === 0,
    `할당 0 → 「${gate.block}」 · 작동 레벨 0 (배치 레벨 ${gate.raw}) · benchOperationalBlock · 가방 제작 목록에서 빠진다`, JSON.stringify(gate));

  // 남는 전력을 전부 서재에 몰아 두고(0 이 남게) 작업실에 전력을 되돌린 뒤 두 번째 작업대를 놓는다 → 보충 없음 + 토스트
  await clearEv();
  const soak = await H(({ ROOMS }) => {
    const h = window.__game.ctx.housing;
    const wReq = h.getFacilityPower(ROOMS.workshop).required;
    const e1 = h.setPowerAllocation(ROOMS.workshop, wReq);
    const o = h.getPowerOverview();
    const lib = h.getFacilityPower(ROOMS.library).allocated;
    const e2 = h.setPowerAllocation(ROOMS.library, lib + o.free);
    return { e1, e2, free: h.getPowerOverview().free, powered: h.getFacilityPower(ROOMS.workshop).powered };
  }, { ROOMS });
  ok(soak.e1 === null && soak.e2 === null && soak.free === 0 && soak.powered, `할당을 되돌리고 남는 전력을 0 으로 (free ${soak.free})`, JSON.stringify(soak));
  const plus = await H(() => window.__game.ctx.housing.setPowerAllocation(0, window.__game.ctx.housing.getFacilityPower(0).allocated + 1));
  ok(typeof plus === 'string', `남는 전력이 없으면 할당을 늘릴 수 없다 (${plus})`);
  const gear = await placeFurn(ROOMS.workshop, 'furn_bench_gear');
  const w2 = await fac(ROOMS.workshop);
  const toasts = (await ev('ui:notify')).map((n) => n.text);
  ok(!!gear.uid && !w2.powered && w2.required === K.base.workshop + K.pw.furn_bench_gun + K.pw.furn_bench_gear && w2.allocated < w2.required,
    `남는 전력이 없을 때 배치 → 보충 없이 시설이 멈춘다 (${w2.allocated}/${w2.required})`, JSON.stringify(w2));
  ok(toasts.some((t) => /작업실 전력 부족 — 발전기에서 전력을 할당하세요/.test(t)), `토스트 「작업실 전력 부족 — 발전기에서 전력을 할당하세요」 (${toasts.join(' | ')})`);
  const opEv = (await ev('housing:operationalChanged')).filter((e) => e.uid === gun.uid);
  ok(opEv.length >= 1 && opEv[opEv.length - 1].operational === false && opEv[opEv.length - 1].pausedMs === 0, `housing:operationalChanged {operational:false} (${JSON.stringify(opEv)})`);
  ok((await ev('housing:powerChanged')).length > 0, 'housing:powerChanged');

  const dis = await H(({ gun, gear, ROOMS }) => {
    const h = window.__game.ctx.housing;
    const r = { e: h.setFurnitureDisabled(gear, true) };
    const f = h.getFacilityPower(ROOMS.workshop);
    r.req = f.required; r.powered = f.powered;
    r.gearBlock = h.furnitureOperationalBlock(gear); r.gunBlock = h.furnitureOperationalBlock(gun);
    r.isDis = h.isFurnitureDisabled(gear);
    r.info = f.furniture.find((x) => x.uid === gear);
    r.save = h.state.disabledFurniture.includes(gear);
    r.lvGear = h.getOperationalBenchLevel('gear'); r.benchGear = h.benchOperationalBlock('gear');
    return r;
  }, { gun: gun.uid, gear: gear.uid, ROOMS });
  ok(dis.e === null && dis.isDis && dis.save && dis.req === K.base.workshop + K.pw.furn_bench_gun && dis.powered,
    `비활성화 → 요구에서 빠지고 시설이 다시 돈다 (요구 ${dis.req})`, JSON.stringify(dis));
  ok(dis.gearBlock === K.disabled && dis.gunBlock === null && dis.info?.disabled && dis.info.demand === K.pw.furn_bench_gear && dis.lvGear === 0 && dis.benchGear === K.disabled,
    `비활성화된 가구만 「${dis.gearBlock}」 · demand 는 그대로 보인다`);
  const plant = await placeFurn(ROOMS.workshop, 'furn_plant');
  const decor = await H((uid) => ({ e: window.__game.ctx.housing.setFurnitureDisabled(uid, true), b: window.__game.ctx.housing.furnitureOperationalBlock(uid) }), plant.uid);
  ok(!!plant.uid && typeof decor.e === 'string' && decor.b === null, `전력을 안 쓰는 가구는 비활성화할 수 없고 늘 작동한다 (${decor.e})`);

  // 채굴: 클러스터 코어 요구 · 메인 컴퓨터 조건
  const comp = await placeFurn(ROOMS.mining, 'furn_mining_computer');
  const clus = await placeFurn(ROOMS.mining, 'furn_compute_cluster');
  if (comp.uid && clus.uid) {
    const mine = await H(({ comp, clus, ROOMS }) => {
      const h = window.__game.ctx.housing;
      // 코어 3개 — 채굴 규칙(에이전트 ③)의 필드를 흉내 낸다; 요구 계산은 `state.clusters[].cores` 만 본다
      const list = Array.isArray(h.state.clusters) ? h.state.clusters : (h.state.clusters = []);
      const slot = list.find((c) => c.uid === clus);
      if (slot) slot.cores = 3; else list.push({ uid: clus, cores: 3, progress: 0, segmentAt: h.nowMs() });
      // 전력을 넉넉히: 서재에 몰아 둔 것을 풀어 채굴에 준다
      h.setPowerAllocation(ROOMS.library, h.getFacilityPower(ROOMS.library).required);
      h.changed('smoke');
      const f = h.getFacilityPower(ROOMS.mining);
      const e = h.setPowerAllocation(ROOMS.mining, f.required);
      const r = { e, info: JSON.parse(JSON.stringify(h.getFacilityPower(ROOMS.mining))) };
      r.clusBlock = h.furnitureOperationalBlock(clus);
      r.e2 = h.setFurnitureDisabled(comp, true);
      r.clusOff = h.furnitureOperationalBlock(clus);
      r.e3 = h.setFurnitureDisabled(comp, false);
      r.clusBack = h.furnitureOperationalBlock(clus);
      return r;
    }, { comp: comp.uid, clus: clus.uid, ROOMS });
    const cInfo = mine.info.furniture.find((x) => x.uid === clus.uid);
    ok(mine.e === null && cInfo?.demand === K.pw.furn_compute_cluster + 3 * K.perCore && mine.info.required === K.base.mining + K.pw.furn_mining_computer + cInfo.demand,
      `클러스터 demand = power ${K.pw.furn_compute_cluster} + 코어 3 × ${K.perCore} · 채굴 요구 ${mine.info.required}`, JSON.stringify(mine.info));
    ok(mine.clusBlock === null && mine.e2 === null && mine.clusOff === K.computer && mine.e3 === null && mine.clusBack === null,
      `메인 컴퓨터를 끄면 클러스터 「${mine.clusOff}」, 켜면 다시 돈다`, JSON.stringify(mine));
  } else {
    note(`채굴 가구를 놓지 못했다 — ${JSON.stringify({ comp, clus })}`);
  }

  const tread = await placeFurn(ROOMS.gym, 'furn_treadmill');
  if (tread.uid) {
    const gym = await H(({ uid, ROOMS }) => {
      const h = window.__game.ctx.housing;
      h.setPowerAllocation(ROOMS.gym, h.getFacilityPower(ROOMS.gym).required);
      const on = h.gymBlock(uid);
      h.setPowerAllocation(ROOMS.gym, 0);
      const off = h.gymBlock(uid);
      h.setPowerAllocation(ROOMS.gym, h.getFacilityPower(ROOMS.gym).required);
      return { on, off };
    }, { uid: tread.uid, ROOMS });
    ok(gym.on !== K.short && gym.off === K.short, `헬스장 할당 0 → gymBlock 「${gym.off}」 (켜져 있으면 「${gym.on}」)`);
  } else note(`트레드밀을 놓지 못했다 — ${JSON.stringify(tread)}`);

  /* ══ 2. 재배 시계 멈춤 ═════════════════════════════════════════════════════ */
  console.log('재배 시계 — 멈춤 · 다시 돌기');
  const gs = await placeFurn(ROOMS.greenhouse, 'furn_grow_station');
  const haveItems = (await giveStash('soil_humus', 2)) > 0 && (await giveStash('seed_beanpod', 2)) > 0;
  if (gs.uid && haveItems) {
    await clearEv();
    const g0 = await H(({ uid, ROOMS }) => {
      const h = window.__game.ctx.housing;
      window.__t = Math.floor(Date.now() / 1000) * 1000;
      h.nowMs = () => window.__t;                      // 시각 흉내 — `stationNow` · 멈춤 기록 · 파종이 전부 이것을 읽는다
      h.setPowerAllocation(ROOMS.greenhouse, h.getFacilityPower(ROOMS.greenhouse).required);
      const e1 = h.fillSoil(uid, 0, 0, 'soil_humus');
      const e2 = h.plantSeedAt(uid, 0, 0, 'seed_beanpod');
      const g = h.state.grows.find((x) => x.uid === uid && x.tier === 0 && x.slot === 0);
      return { e1, e2, powered: h.getFacilityPower(ROOMS.greenhouse).powered, plantedAt: g?.plantedAt, readyAt: g?.readyAt };
    }, { uid: gs.uid, ROOMS });
    const D = g0.readyAt - g0.plantedAt;
    ok(g0.e1 === null && g0.e2 === null && g0.powered && g0.plantedAt === await H(() => window.__t) && D > 0, `전력이 있는 스테이션에 파종 (성장 ${D} ms)`, JSON.stringify(g0));
    const p1 = await H(({ uid, D, ROOMS }) => {
      const h = window.__game.ctx.housing;
      const slot = () => h.getGrowSlots(uid).find((x) => x.tier === 0 && x.slot === 0);
      window.__t += Math.round(D / 4);
      const before = slot().progress;
      const cutAt = window.__t;
      const e = h.setPowerAllocation(ROOMS.greenhouse, 0);
      const pausedAt = h.state.pausedAt[uid];
      window.__t += D * 2;
      const s = slot();
      return { before, e, cutAt, pausedAt, after: s.progress, ready: s.ready, now: h.stationNow(uid), harvest: h.harvestAt(uid, 0, 0, 'stash-first'),
        block: h.furnitureOperationalBlock(uid), readyCount: h.readyCount(uid) };
    }, { uid: gs.uid, D, ROOMS });
    const offEv = (await ev('housing:operationalChanged')).filter((e) => e.uid === gs.uid);
    ok(Math.abs(p1.before - 0.25) < 0.01 && p1.e === null && p1.pausedAt === p1.cutAt && p1.block === K.short, `1/4 진행 → 전력 끊김 → pausedAt = 끊긴 시각 (${p1.before.toFixed(3)})`, JSON.stringify(p1));
    ok(Math.abs(p1.after - p1.before) < 1e-9 && !p1.ready && p1.readyCount === 0 && p1.now === p1.cutAt && typeof p1.harvest === 'string',
      `시간이 흘러도 진행도 고정 · 여물지 않음 · stationNow = 멈춘 시각 · 수확 거절 (${p1.harvest})`);
    ok(offEv.length === 1 && offEv[0].operational === false && offEv[0].pausedMs === 0, `housing:operationalChanged {operational:false, pausedMs:0} (${JSON.stringify(offEv)})`);
    await clearEv();
    const p2 = await H(({ uid, D, ROOMS }) => {
      const h = window.__game.ctx.housing;
      const slot = () => h.getGrowSlots(uid).find((x) => x.tier === 0 && x.slot === 0);
      const g = () => h.state.grows.find((x) => x.uid === uid && x.tier === 0 && x.slot === 0);
      const readyBefore = g().readyAt;
      const e = h.setPowerAllocation(ROOMS.greenhouse, h.getFacilityPower(ROOMS.greenhouse).required);
      const r = { e, shift: g().readyAt - readyBefore, paused: uid in h.state.pausedAt, progress: slot().progress, now: h.stationNow(uid), t: window.__t };
      window.__t += Math.round(D * 3 / 4) - 1000;
      r.almost = slot().ready;
      window.__t += 2000;
      r.ripe = slot().ready;
      r.harvest = h.harvestAt(uid, 0, 0, 'stash-first');
      return r;
    }, { uid: gs.uid, D, ROOMS });
    const onEv = (await ev('housing:operationalChanged')).filter((e) => e.uid === gs.uid);
    ok(p2.e === null && !p2.paused && p2.now === p2.t && onEv.length === 1 && onEv[0].operational === true && onEv[0].pausedMs === D * 2,
      `전력 복구 → pausedMs = 멈춘 시간 ${D * 2} ms · 멈춤 기록 삭제 (${JSON.stringify(onEv)})`);
    ok(p2.shift === D * 2 && Math.abs(p2.progress - 0.25) < 0.01, `readyAt 이 멈춘 시간만큼 밀리고 진행도는 이어진다 (${p2.progress.toFixed(3)})`);
    ok(!p2.almost && p2.ripe && p2.harvest === null, '남은 3/4 이 흐른 뒤에야 여물고 수확된다', JSON.stringify(p2));
    await H(() => { delete window.__game.ctx.housing.nowMs; });
  } else {
    note(`재배 스테이션 · 토양 · 씨앗이 없다 — ${JSON.stringify({ gs, haveItems })}`);
  }

  /* ══ 3. 서재 보너스 ════════════════════════════════════════════════════════ */
  console.log('서재 보너스');
  const shelf = await placeFurn(ROOMS.library, 'furn_bookshelf');
  const bookId = await H(() => window.__game.ctx.loot.getAllItemDefs().find((d) => d.book && !d.retired)?.id ?? null);
  if (shelf.uid && bookId && (await giveStash(bookId, 1)) === 1) {
    const lib = await H(({ uid, bookId, ROOMS }) => {
      const h = window.__game.ctx.housing;
      const skill = window.__game.ctx.loot.getItemDef(bookId).book.skill;
      h.setPowerAllocation(ROOMS.library, 0);
      h.setPowerAllocation(ROOMS.library, Math.min(h.getFacilityPower(ROOMS.library).required, h.getPowerOverview().free));
      const e = h.placeBook(uid, 0, bookId);
      const on = h.getSkillGainMul(skill);
      h.setPowerAllocation(ROOMS.library, 0);
      const off = h.getSkillGainMul(skill);
      const offParts = h.getShelfBonus(skill).total;
      h.setFurnitureDisabled(uid, true);
      h.setPowerAllocation(ROOMS.library, h.getFacilityPower(ROOMS.library).required);
      const disabled = h.getSkillGainMul(skill);
      h.setFurnitureDisabled(uid, false);
      h.setPowerAllocation(ROOMS.library, h.getFacilityPower(ROOMS.library).required);
      const back = h.getSkillGainMul(skill);
      return { e, skill, on, off, offParts, disabled, back };
    }, { uid: shelf.uid, bookId, ROOMS });
    ok(lib.e === null && lib.on > 1 && lib.off === 1 && lib.offParts === 1 && lib.disabled === 1 && lib.back === lib.on,
      `서재 보너스: 전력 ${lib.on.toFixed(3)} → 할당 0 = 1 · 비활성 책장 = 1 · 복구 = ${lib.back.toFixed(3)} (${lib.skill})`, JSON.stringify(lib));
  } else note(`책장 · 책을 준비하지 못했다 — ${JSON.stringify({ shelf, bookId })}`);

  /* ══ 4. v12 이관 ══════════════════════════════════════════════════════════ */
  console.log('ShipState v12 — 이관 · 정리');
  const mig = await H(async () => {
    const SS = await import('/src/housing/ShipState.ts');
    const S = await import('/src/shared/index.ts');
    const h = window.__game.ctx.housing;
    // 지금 함선의 배치(규칙을 통과한 좌표)를 그대로 쓰되 할당을 지운 v11 문서로 만든다
    const cur = JSON.parse(JSON.stringify(h.state));
    const old = { ...cur, version: 11, generatorLevel: 1 };
    delete old.powerAlloc; delete old.disabledFurniture; delete old.pausedAt;
    const out = { refund: [] };
    const a = SS.sanitize(old, out);
    const supply = S.generatorPowerSupply(1);
    const rows = [];
    let left = supply;
    const R = await import('/src/housing/PowerRules.ts');
    for (const f of R.computePower({ ...a, powerAlloc: {} }).facilities) {
      const want = f.required > 0 && f.required <= left ? f.required : 0;
      if (want) left -= want;
      rows.push([f.room, f.required, a.powerAlloc[String(f.room)] ?? 0, want]);
    }
    // v12 문서: 공급 초과 · 배치되지 않은 uid
    const v12 = { ...cur, version: 12, generatorLevel: 1, powerAlloc: { '0': supply, '4': 5, '99': 3 }, disabledFurniture: ['f-9999', cur.furniture[0]?.uid], pausedAt: { 'f-9999': 5, [cur.furniture[0]?.uid]: 12345 } };
    const out2 = { refund: [] };
    const b = SS.sanitize(v12, out2);
    return { v: a.version, migrated: out.migratedPower, rows, supply, b: { alloc: b.powerAlloc, dis: b.disabledFurniture, paused: b.pausedAt, first: cur.furniture[0]?.uid }, migrated2: out2.migratedPower };
  });
  ok(mig.v === 12 && mig.migrated === true && mig.rows.length >= 3 && mig.rows.every(([, , got, want]) => got === want),
    `v11 세이브 → 방 순서대로 요구량 통째로, 모자라면 건너뛴다 (공급 ${mig.supply}: ${mig.rows.map((r) => `${r[0]}:${r[2]}/${r[1]}`).join(' ')})`, JSON.stringify(mig.rows));
  ok(mig.migrated2 === false && mig.b.alloc['0'] === mig.supply && !('4' in mig.b.alloc) && !('99' in mig.b.alloc),
    `v12 세이브 = 이관 없음 · 공급 초과는 높은 방 번호부터 깎는다 · 시설이 아닌 방 번호는 버린다 (${JSON.stringify(mig.b.alloc)})`);
  ok(JSON.stringify(mig.b.dis) === JSON.stringify([mig.b.first]) && Object.keys(mig.b.paused).join() === mig.b.first && mig.b.paused[mig.b.first] === 12345,
    `배치되지 않은 uid 의 비활성 · 멈춤 기록은 버린다 (${JSON.stringify(mig.b)})`);

  /* ══ 5. 화면 ══════════════════════════════════════════════════════════════ */
  console.log('화면 — 스테이션 전력 줄 · 시설 관리 전력 패널 · 인스펙터');
  if (gs.uid) {
    const ui1 = await H(async ({ uid, ROOMS }) => {
      const h = window.__game.ctx.housing;
      const wait = () => new Promise((r) => setTimeout(r, 30));
      h.setPowerAllocation(ROOMS.greenhouse, h.getFacilityPower(ROOMS.greenhouse).required);
      h.openGrowStation(uid);
      await wait();
      const root = h.growStation.root;
      const btn = root.querySelector('.hpw-toggle'), banner = root.querySelector('.hpw-banner');
      const r = { open: h.growStation.isOpen, btn: !!btn && !btn.hidden, btnText: btn?.textContent, bannerOn: !!banner && !banner.hidden };
      h.setPowerAllocation(ROOMS.greenhouse, 0);
      await wait();
      r.shortBanner = banner && !banner.hidden ? banner.textContent : null;
      h.setPowerAllocation(ROOMS.greenhouse, h.getFacilityPower(ROOMS.greenhouse).required);
      btn?.click();
      await wait();
      r.disabled = h.isFurnitureDisabled(uid);
      r.disText = banner && !banner.hidden ? banner.textContent : null;
      r.btnText2 = btn?.textContent;
      btn?.click();
      await wait();
      r.enabled = !h.isFurnitureDisabled(uid);
      h.closeMenus();
      return r;
    }, { uid: gs.uid, ROOMS });
    ok(ui1.open && ui1.btn && ui1.btnText === '비활성화' && !ui1.bannerOn, `재배 스테이션 화면: 업그레이드 옆 「비활성화」 · 작동 중엔 배너 없음`, JSON.stringify(ui1));
    ok(/전력 부족 — 시계가 멈췄습니다/.test(ui1.shortBanner ?? ''), `할당 0 → 배너 「${ui1.shortBanner}」`);
    ok(ui1.disabled && /비활성화됨/.test(ui1.disText ?? '') && ui1.btnText2 === '활성화' && ui1.enabled, `버튼 → 비활성화 · 배너 「${ui1.disText}」 · 「활성화」 → 다시 켜진다`);
  }

  const ui2 = await H(async ({ ROOMS, gun, gear }) => {
    const h = window.__game.ctx.housing, bus = window.__game.ctx.bus;
    const wait = () => new Promise((r) => setTimeout(r, 40));
    const r = { manage: h.openShipManage(ROOMS.workshop) };
    await wait();
    const panel = document.querySelector('.ship-manage .sm-pw');
    r.panel = !!panel && !panel.hidden;
    r.rows = panel ? panel.querySelectorAll('.sm-pw-row').length : 0;
    r.facilities = h.getPowerOverview().facilities.length;
    // 작업실: 비활성 작업대를 켜서 멈추게 한 뒤 「요구량 맞추기」
    h.setFurnitureDisabled(gear, false);
    h.setPowerAllocation(ROOMS.workshop, 0);
    await wait();
    const row = () => panel?.querySelector(`.sm-pw-row[data-room="${ROOMS.workshop}"]`);
    r.short = !!row()?.classList.contains('is-short');
    const f0 = h.getFacilityPower(ROOMS.workshop), free0 = h.getPowerOverview().free;
    row()?.querySelector('.sm-pw-fit')?.click();
    await wait();
    r.fit = [h.getFacilityPower(ROOMS.workshop).allocated, Math.min(f0.required, f0.allocated + free0)];
    row()?.querySelector('.sm-pw-minus')?.click();
    await wait();
    r.minus = h.getFacilityPower(ROOMS.workshop).allocated === r.fit[0] - 1;
    row()?.querySelector('.sm-pw-plus')?.click();
    await wait();
    r.plus = h.getFacilityPower(ROOMS.workshop).allocated === r.fit[0];
    row()?.querySelector('.sm-pw-name')?.click();
    await wait();
    r.furnLines = row()?.querySelectorAll('.sm-pw-f').length ?? 0;
    // 인스펙터
    bus.emit('housing:furnitureSelected', { uid: gun });
    await wait();
    const ins = document.querySelector('.ship-manage .sm-inspect');
    const line = ins?.querySelector('.sm-pw-ins'), tgl = ins?.querySelector('.sm-pw-toggle');
    r.line = line && !line.hidden ? line.textContent : null;
    r.tgl = tgl && !tgl.hidden ? tgl.textContent : null;
    tgl?.click();
    await wait();
    r.tglDisabled = h.isFurnitureDisabled(gun);
    r.tgl2 = tgl?.textContent;
    tgl?.click();
    await wait();
    r.tglBack = !h.isFurnitureDisabled(gun);
    h.closeShipManage();
    return r;
  }, { ROOMS, gun: gun.uid, gear: gear.uid });
  ok(ui2.manage && ui2.panel && ui2.rows === ui2.facilities && ui2.rows >= 5, `시설 관리: 전력 패널 · 시설 행 ${ui2.rows}개`, JSON.stringify(ui2));
  ok(ui2.short && ui2.fit[0] === ui2.fit[1] && ui2.minus && ui2.plus, `멈춘 시설 강조 · 요구량 맞추기 = min(요구, 할당 + 남음) (${ui2.fit.join(' = ')}) · − / +`);
  ok(ui2.furnLines >= 2, `시설 이름을 누르면 가구별 요구가 펼쳐진다 (${ui2.furnLines}줄)`);
  ok(/요구 전력 \d+/.test(ui2.line ?? '') && ui2.tgl === '비활성화' && ui2.tglDisabled && ui2.tgl2 === '활성화' && ui2.tglBack,
    `인스펙터: 「${ui2.line}」 · 업그레이드 옆 비활성화 / 활성화`);

  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
