// Single-player smoke test for **발전기 = 증축 조건** (2026-09-13, 사용자 결정 「전력 할당 시스템 제거」 — housing `Rules.purposeBuildBlockReason` ·
// `ShipState` v13 · ui `hud/ShipManage` 발전기 행). 옛 `smoke-power`(전력 할당 · 비활성화 · 멈춘 시계)를 대체한다.
//   0. 계약: 전력 API 7종(`getPowerOverview` · `getFacilityPower` · `setPowerAllocation` · `isFurnitureDisabled` · `setFurnitureDisabled` ·
//      `getOperationalBenchLevel` · `benchOperationalBlock`)이 `ctx.housing` 에 없다 · 남은 질의(`furnitureOperationalBlock` · `stationNow`) ·
//      새 함선 = v13 · 발전기 Lv.1 · 최대 Lv.5 (= constants.csv) · 전력 필드(`powerAlloc` · `pausedAt` · `disabledFurniture`) 없음.
//   1. 증축 게이트: 발전기 Lv.1–5 × 지을 수 있는 용도 — `purposeGeneratorLevel` = room_purposes.csv `generator` · `purposeBlock` 에
//      `발전기 레벨 N 필요 (현재 M)` 가 레벨이 모자랄 때만 · `purposeRequirements` 가 같은 답 · 온실 선행(연구실 · 주방) ·
//      레벨을 올려 가며 실제 `setRoomPurpose` — 열리기 전 거절 · 열린 뒤 성공 + csv 증축 재료 소모 · 함선당 하나.
//   2. 가구 · 창고 강화는 여전히 발전기 게이트: 총기 작업대 Lv.1 → 2 (발전기 1 막힘 · 2 풀림) · 창고 Lv.2 (발전기 1 막힘 · 2 에서 강화).
//   3. 발전기 강화 1 → 2 = facility_upgrades.csv `generator,2` 재료를 정확히 소모 · Lv.5 에서 nextCost null · 거절.
//   4. `sanitize` 이관: 발전기 0 → 1 · 8 → 5 (환불 없음) · v12 모양 세이브(발전기 2 · 온실 + 연구실 + 서재 · 책 꽂힌 책장 · 해석 중인 분석기 ·
//      전력 필드) → 온실 유지 · 연구실 · 서재 빈 방 · 가구는 가구 창고 · 환불 = 두 방 증축 재료 + 책 + 표본 · `removedByGenerator` 2 ·
//      전력 필드 없음 · 한 번 더 읽어도 아무것도 안 바뀐다.
//   5. `furnitureOperationalBlock`: 메인 컴퓨터 없는 연산 클러스터만 사유, 컴퓨터를 놓으면 null · 작업대는 늘 null · `stationNow` = `nowMs`.
//   6. 화면: 시설 관리 발전기 행 `.sm-gen-unlock[data-level=2..5]` (`is-open` · `is-next`) · 버튼 `업그레이드` / `최대` · `is-hint` 없음 ·
//      `.sm-pw*` · `.is-unpowered` 없음 · 재배 스테이션 화면에 `.hpw-toggle` · `.hpw-banner` 없음 · 전력 이벤트가 한 번도 나지 않는다.
//   7. 진짜 로드 경로: 4번의 v12 세이브를 localStorage 에 쓰고 새로고침 → 토스트 `발전기 레벨이 모자란 시설 2곳을 제거했습니다` ·
//      환불이 함선 창고에 들어온다 · 가구 창고 · 방 상태.
// Usage: node scripts/smoke-generator.mjs [http://localhost:5273/]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ── csv 원본 (게임 코드와 따로 읽어 기대값으로 쓴다) ─────────────────────────────── */
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const csvRows = (file) => {
  const lines = readFileSync(join(DATA, file), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines.shift().split(',');
  return lines.map((l) => { const c = l.split(','); return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()])); });
};
const parseCost = (s) => (s ? s.split('|').map((x) => { const [defId, qty] = x.split(':'); return { defId, qty: Number(qty) }; }) : []);
const CSV_PURPOSE = Object.fromEntries(csvRows('room_purposes.csv').map((r) => [r.purpose, { cost: parseCost(r.cost), gen: r.generator ? Number(r.generator) : null }]));
const CSV_GEN_COST = Object.fromEntries(csvRows('facility_upgrades.csv').filter((r) => r.facility === 'generator').map((r) => [Number(r.level), parseCost(r.cost)]));
const CSV_CONST = Object.fromEntries(readFileSync(join(DATA, 'constants.csv'), 'utf8').split(/\r?\n/).map((l) => l.split(',')).filter((c) => /^GENERATOR_(START|MAX)_LEVEL$/.test(c[0])).map((c) => [c[0], Number(c[1])]));
/** 재료 목록 → { defId: qty } (합산 · 정렬) — 비교용. */
const bagOf = (list) => {
  const m = {};
  for (const c of list) m[c.defId] = (m[c.defId] ?? 0) + c.qty;
  return Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const POWER_API = ['getPowerOverview', 'getFacilityPower', 'setPowerAllocation', 'isFurnitureDisabled', 'setFurnitureDisabled', 'getOperationalBenchLevel', 'benchOperationalBlock'];
const POWER_FIELDS = ['powerAlloc', 'pausedAt', 'disabledFurniture'];
const MATS = ['mat_scrap', 'mat_cable', 'mat_alloy', 'mat_circuit', 'mat_power_cell', 'mat_ingot', 'mat_capacitor', 'mat_control_module'];

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // 부팅 직후(첫 프레임 전)의 토스트를 잡는다: main.ts 는 `engine.start()`(init) 뒤 첫 rAF 전에 `window.__game` 을 건다
    window.__bootNotify = [];
    let game;
    Object.defineProperty(window, '__game', {
      configurable: true,
      get() { return game; },
      set(v) {
        game = v;
        try { v.ctx.bus.on('ui:notify', (p) => window.__bootNotify.push(String(p?.text ?? ''))); } catch { /* not an engine */ }
      },
    });
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });
  const H = (fn, arg) => page.evaluate(fn, arg);

  const pumpFrames = () => H(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot');
  await pumpFrames();
  await H(() => {
    window.__ev = {};
    for (const n of ['housing:powerChanged', 'housing:operationalChanged', 'ui:notify', 'housing:facilityUpgraded']) {
      window.__ev[n] = [];
      window.__game.ctx.bus.on(n, (p) => window.__ev[n].push(JSON.parse(JSON.stringify(p ?? null))));
    }
  });
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  const clearStash = () => H(() => { const st = window.__game.getSystem('inventory').getStash(); for (const p of st.items()) st.remove(p.item.uid); });
  await clearStash();
  const ev = (n) => H((k) => window.__ev[k].slice(), n);
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
  const counts = (ids) => H((ids) => Object.fromEntries(ids.map((id) => [id, window.__game.ctx.inventory.countDefAll(id)])), ids);
  const giveMats = async (want) => {
    const short = [];
    for (const [id, qty] of Object.entries(want)) {
      const got = await giveStash(id, qty);
      if (got !== qty) short.push(`${id} ${got}/${qty}`);
    }
    return short;
  };
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
  /** 두 counts 스냅샷의 차이 중 0 이 아닌 것 (before − after = 소모량). */
  const spent = (before, after) => bagOf(Object.keys(before).map((id) => ({ defId: id, qty: before[id] - after[id] })).filter((c) => c.qty !== 0));

  /* ══ 0. 계약 · 새 함선 ═════════════════════════════════════════════════════ */
  console.log('계약 · 새 함선');
  const c0 = await H(({ POWER_API, POWER_FIELDS }) => {
    const h = window.__game.ctx.housing, s = h.state;
    const g = h.getFacility('generator');
    return {
      present: POWER_API.filter((k) => typeof h[k] === 'function'),
      kept: ['furnitureOperationalBlock', 'stationNow'].filter((k) => typeof h[k] !== 'function'),
      version: s.version, gen: s.generatorLevel, facLevel: g.level, max: g.maxLevel,
      powerKeys: POWER_FIELDS.filter((k) => k in s),
    };
  }, { POWER_API, POWER_FIELDS });
  ok(c0.present.length === 0, `전력 API 7종이 ctx.housing 에 없다`, `still present: ${c0.present.join(', ')}`);
  ok(c0.kept.length === 0, 'furnitureOperationalBlock · stationNow 는 남아 있다', `missing: ${c0.kept.join(', ')}`);
  ok(CSV_CONST.GENERATOR_START_LEVEL === 1 && CSV_CONST.GENERATOR_MAX_LEVEL === 5, `constants.csv: 발전기 시작 Lv.${CSV_CONST.GENERATOR_START_LEVEL} · 최대 Lv.${CSV_CONST.GENERATOR_MAX_LEVEL}`);
  ok(c0.gen === CSV_CONST.GENERATOR_START_LEVEL && c0.facLevel === c0.gen && c0.max === CSV_CONST.GENERATOR_MAX_LEVEL,
    `새 함선: 발전기 Lv.${c0.gen} · getFacility maxLevel ${c0.max}`, JSON.stringify(c0));
  ok(c0.version === 13 && c0.powerKeys.length === 0, `새 함선 state v${c0.version} · 전력 필드 없음`, JSON.stringify(c0.powerKeys));

  /* ══ 1. 증축 게이트 ════════════════════════════════════════════════════════ */
  console.log('증축 게이트 — 발전기 Lv.1–5 × 용도');
  const short1 = await giveMats({ mat_scrap: 80, mat_cable: 12, mat_alloy: 30, mat_circuit: 12 });
  if (short1.length) note(`함선 창고에 재료를 다 넣지 못했다 — ${short1.join(', ')}`);
  const gate = await H(async () => {
    const SH = await import('/src/shared/index.ts');
    const R = await import('/src/housing/Rules.ts');
    const h = window.__game.ctx.housing;
    const TEST = 0, GH = 7;
    const reset = () => { for (const room of h.state.rooms) { room.purpose = 'empty'; room.level = 0; } };
    const rows = [];
    for (let L = 1; L <= 5; L++) {
      h.state.generatorLevel = L;
      for (const p of SH.ROOM_PURPOSES_ASSIGNABLE) {
        reset();
        if (R.NEEDS_GREENHOUSE.includes(p)) { h.state.rooms[GH].purpose = 'greenhouse'; h.state.rooms[GH].level = 1; }
        rows.push({ L, p, block: h.purposeBlock(TEST, p), req: JSON.parse(JSON.stringify(h.purposeRequirements(p))) });
      }
    }
    reset();
    h.state.generatorLevel = 5;
    const noGh = { lab: h.purposeBlock(TEST, 'lab'), kitchen: h.purposeBlock(TEST, 'kitchen') };
    h.state.generatorLevel = 1;
    h.changed('smoke');
    return {
      rows, noGh,
      assignable: [...SH.ROOM_PURPOSES_ASSIGNABLE],
      needGh: [...R.NEEDS_GREENHOUSE],
      level: Object.fromEntries(SH.ROOM_PURPOSES_ASSIGNABLE.map((p) => [p, SH.purposeGeneratorLevel(p)])),
      buildCost: Object.fromEntries(SH.ROOM_PURPOSES_ASSIGNABLE.map((p) => [p, SH.ROOM_PURPOSE_BUILD_COST[p]])),
    };
  });
  const lvMismatch = gate.assignable.filter((p) => gate.level[p] !== CSV_PURPOSE[p]?.gen);
  ok(lvMismatch.length === 0 && gate.assignable.length === 7,
    `purposeGeneratorLevel = room_purposes.csv generator (${gate.assignable.map((p) => `${p}:${gate.level[p]}`).join(' ')})`, JSON.stringify(lvMismatch));
  ok(gate.assignable.every((p) => same(bagOf(gate.buildCost[p]), bagOf(CSV_PURPOSE[p].cost))), 'ROOM_PURPOSE_BUILD_COST = room_purposes.csv cost');
  for (let L = 1; L <= 5; L++) {
    const bad = gate.rows.filter((r) => r.L === L).filter((r) => {
      const need = CSV_PURPOSE[r.p].gen;
      const text = `발전기 레벨 ${need} 필요 (현재 ${L})`;
      const wantReq = L < need ? [{ facility: 'generator', have: L, need }] : [];
      if (!same(r.req, wantReq)) return true;
      return L < need ? r.block !== text : r.block !== null;
    });
    const closed = gate.rows.filter((r) => r.L === L && L < CSV_PURPOSE[r.p].gen).map((r) => r.p);
    ok(bad.length === 0, `발전기 Lv.${L}: 막힘 = ${closed.length ? closed.join(' · ') : '없음'} (「발전기 레벨 N 필요 (현재 ${L})」 · purposeRequirements 일치 · 열린 용도는 사유 없음)`,
      JSON.stringify(bad));
  }
  ok(gate.needGh.every((p) => /온실이 먼저 필요합니다/.test(gate.noGh[p] ?? '')), `온실이 없으면 연구실 · 주방은 발전기 Lv.5 에서도 「${gate.noGh.lab}」`);

  // 레벨을 올려 가며 실제로 짓는다 — 열리기 전 거절 · 열린 뒤 성공 + csv 증축 재료 소모
  const build = await H(async ({ MATS }) => {
    const SH = await import('/src/shared/index.ts');
    const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
    const snap = () => Object.fromEntries(MATS.map((id) => [id, inv.countDefAll(id)]));
    const rows = [];
    const built = new Set();
    for (let L = 1; L <= 5; L++) {
      h.state.generatorLevel = L;
      for (const p of SH.ROOM_PURPOSES_ASSIGNABLE) {
        if (built.has(p)) continue;
        const idx = h.state.rooms.findIndex((r) => r.purpose === 'empty');
        const before = snap();
        const block = h.purposeBlock(idx, p);
        const res = h.setRoomPurpose(idx, p);
        const after = snap();
        if (res) built.add(p);
        rows.push({ L, p, idx, res, block, purpose: h.state.rooms[idx].purpose, before, after });
      }
    }
    const rooms = h.state.rooms.map((r) => r.purpose);
    const free = h.state.rooms.findIndex((r) => r.purpose === 'empty');
    const dup = { block: h.purposeBlock(free, 'workshop'), res: h.setRoomPurpose(free, 'workshop') };
    return { rows, rooms, dup };
  }, { MATS });
  const buildBad = build.rows.filter((r) => {
    const need = CSV_PURPOSE[r.p].gen;
    const want = r.L >= need;
    if (r.res !== want) return true;
    const used = spent(r.before, r.after);
    return want ? !same(used, bagOf(CSV_PURPOSE[r.p].cost)) || r.purpose !== r.p : Object.keys(used).length > 0;
  });
  const firstOk = Object.fromEntries(build.rows.filter((r) => r.res).map((r) => [r.p, r.L]));
  ok(buildBad.length === 0 && Object.keys(firstOk).length === 7 && Object.entries(firstOk).every(([p, L]) => L === CSV_PURPOSE[p].gen),
    `setRoomPurpose: 요구 레벨 전에는 거절(재료 그대로) · 그 레벨에서 성공 + 증축 재료 소모 (${Object.entries(firstOk).map(([p, L]) => `${p}@${L}`).join(' ')})`,
    JSON.stringify(buildBad.map(({ before, after, ...r }) => ({ ...r, used: spent(before, after) }))));
  ok(build.dup.res === false && /하나만 둘 수 있습니다/.test(build.dup.block ?? ''), `함선당 하나: 작업실 두 번째 → 「${build.dup.block}」`);
  const ROOM = Object.fromEntries(build.rooms.map((p, i) => [p, i]));

  /* ══ 2. 가구 · 창고 강화 게이트 ═══════════════════════════════════════════ */
  console.log('가구 · 창고 강화 — 발전기 게이트 유지');
  const bench = ROOM.workshop !== undefined ? await placeFurn(ROOM.workshop, 'furn_bench_gun') : { err: 'no workshop room' };
  if (bench.uid) {
    const fu = await H((uid) => {
      const h = window.__game.ctx.housing;
      h.state.generatorLevel = 1;
      const r = { lv: h.getPlacedByUid(uid).level, b1: h.furnitureUpgradeBlock(uid), q1: JSON.parse(JSON.stringify(h.furnitureUpgradeRequirements(uid))), u1: h.upgradeFurniture(uid) };
      r.lvAfter1 = h.getPlacedByUid(uid).level;
      h.state.generatorLevel = 2;
      r.b2 = h.furnitureUpgradeBlock(uid);
      r.q2 = JSON.parse(JSON.stringify(h.furnitureUpgradeRequirements(uid)));
      return r;
    }, bench.uid);
    ok(fu.lv === 1 && fu.b1 === '발전기 레벨 2 필요 (현재 1)' && same(fu.q1, [{ facility: 'generator', have: 1, need: 2 }]) && fu.u1 === false && fu.lvAfter1 === 1,
      `총기 작업대 Lv.1 · 발전기 1 → 「${fu.b1}」 · 강화 거절`, JSON.stringify(fu));
    ok(!/발전기/.test(fu.b2 ?? '') && same(fu.q2, []), `발전기 2 → 발전기 사유 없음 (${fu.b2 ?? 'null'})`, JSON.stringify(fu));
  } else note(`총기 작업대를 놓지 못했다 — ${JSON.stringify(bench)}`);

  const shortS = await giveMats({ mat_scrap: 20, mat_alloy: 4 });
  if (shortS.length) note(`창고 강화 재료 부족 — ${shortS.join(', ')}`);
  const st = await H(() => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = 1;
    const r = { start: h.state.storageLevel };
    r.u1 = h.upgrade('storage');
    r.lv1 = h.state.storageLevel;
    r.b2 = h.getFacility('storage').blocked;
    r.u2denied = h.upgrade('storage');
    r.lvDenied = h.state.storageLevel;
    h.state.generatorLevel = 2;
    r.b2open = h.getFacility('storage').blocked;
    r.u2 = h.upgrade('storage');
    r.lv2 = h.state.storageLevel;
    return r;
  });
  ok(st.start === 0 && st.u1 && st.lv1 === 1, `창고 Lv.0 → 1 은 발전기 1 로 된다`, JSON.stringify(st));
  ok(st.b2 === '발전기 레벨 2 필요 (현재 1)' && st.u2denied === false && st.lvDenied === 1, `창고 Lv.2 · 발전기 1 → 「${st.b2}」 · 거절`, JSON.stringify(st));
  ok(st.b2open === null && st.u2 && st.lv2 === 2, `발전기 2 → 창고 Lv.2 강화`, JSON.stringify(st));

  /* ══ 3. 발전기 강화 ════════════════════════════════════════════════════════ */
  console.log('발전기 강화 — csv 비용 · 최대 레벨');
  const want2 = bagOf(CSV_GEN_COST[2] ?? []);
  ok(Object.keys(want2).length > 0 && (CSV_GEN_COST[1] ?? []).length === 0 && [3, 4, 5].every((lv) => (CSV_GEN_COST[lv] ?? []).length > 0) && !CSV_GEN_COST[6],
    `facility_upgrades.csv: generator Lv.1 빈 줄 · Lv.2–5 비용 · Lv.6 없음 (Lv.2 = ${JSON.stringify(want2)})`);
  const shortG = await giveMats(want2);
  if (shortG.length) note(`발전기 강화 재료 부족 — ${shortG.join(', ')}`);
  const g3 = await H(async ({ ids }) => {
    const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
    const snap = () => Object.fromEntries(ids.map((id) => [id, inv.countDefAll(id)]));
    h.state.generatorLevel = 1;
    window.__ev['housing:facilityUpgraded'].length = 0;
    const info = h.getFacility('generator');
    const r = { next: JSON.parse(JSON.stringify(info.nextCost)), blocked: info.blocked, before: snap() };
    r.res = h.upgrade('generator');
    r.after = snap();
    r.lv = h.state.generatorLevel;
    r.evt = window.__ev['housing:facilityUpgraded'].slice();
    h.state.generatorLevel = 5;
    const top = h.getFacility('generator');
    r.top = { level: top.level, next: top.nextCost, blocked: top.blocked, res: h.upgrade('generator'), lv: h.state.generatorLevel };
    h.changed('smoke');
    return r;
  }, { ids: Object.keys(want2) });
  ok(g3.blocked === null && same(bagOf(g3.next ?? []), want2), `Lv.1 의 nextCost = csv Lv.2 비용`, JSON.stringify(g3.next));
  ok(g3.res === true && g3.lv === 2 && same(spent(g3.before, g3.after), want2) && g3.evt.some((e) => e?.id === 'generator' && e.level === 2),
    `upgrade('generator') 1 → 2: 소모 = csv Lv.2 · housing:facilityUpgraded {generator, 2}`, JSON.stringify({ used: spent(g3.before, g3.after), evt: g3.evt }));
  ok(g3.top.level === 5 && g3.top.next === null && g3.top.res === false && g3.top.lv === 5 && g3.top.blocked === '최대 레벨입니다',
    `Lv.5: nextCost null · 「${g3.top.blocked}」 · 강화 거절`, JSON.stringify(g3.top));

  /* ══ 4. sanitize 이관 ═════════════════════════════════════════════════════ */
  console.log('ShipState v13 — 발전기 레벨 · 모자란 시설 제거 + 환불');
  const bookId = await H(() => window.__game.ctx.loot.getAllItemDefs().find((d) => d.book && !d.retired && /^book_[A-Za-z0-9_]+$/.test(d.id))?.id ?? null);
  const mig = await H(async ({ bookId, POWER_FIELDS }) => {
    const S = await import('/src/housing/ShipState.ts');
    const R = await import('/src/housing/Rules.ts');
    const SH = await import('/src/shared/index.ts');
    const empty8 = () => Array.from({ length: SH.SHIP_ROOM_COUNT }, () => ({ purpose: 'empty', level: 0 }));
    const run = (doc) => { const out = { refund: [] }; const s = S.sanitize(JSON.parse(JSON.stringify(doc)), out); return { s, out }; };
    const base = S.freshState();
    const r = {};
    // gen 0 → 1 (작업실은 남는다 · 온실은 Lv.2 가 필요해 제거)
    {
      const rooms = empty8(); rooms[0] = { purpose: 'workshop', level: 1 };
      const a = run({ ...base, version: 12, generatorLevel: 0, rooms });
      const rooms2 = empty8(); rooms2[0] = { purpose: 'greenhouse', level: 1 };
      const b = run({ ...base, version: 12, generatorLevel: 0, rooms: rooms2 });
      r.gen0 = { gen: a.s.generatorLevel, room0: a.s.rooms[0].purpose, removed: a.out.removedByGenerator, refund: a.out.refund.length,
        ghGen: b.s.generatorLevel, ghRoom: b.s.rooms[0].purpose, ghRemoved: b.out.removedByGenerator, ghRefund: b.out.refund, ghWant: SH.ROOM_PURPOSE_BUILD_COST.greenhouse };
    }
    // gen 8 → 5 (채굴 시설은 남는다) · 환불은 gen 5 세이브와 똑같다
    {
      const rooms = empty8(); rooms[0] = { purpose: 'workshop', level: 1 }; rooms[1] = { purpose: 'mining', level: 1 };
      const a = run({ ...base, version: 12, generatorLevel: 8, rooms });
      const b = run({ ...base, version: 12, generatorLevel: 5, rooms });
      r.gen8 = { gen: a.s.generatorLevel, rooms: a.s.rooms.slice(0, 2).map((x) => x.purpose), removed: a.out.removedByGenerator,
        refund8: a.out.refund, refund5: b.out.refund, stored8: a.s.furnitureStorage.length, stored5: b.s.furnitureStorage.length };
    }
    // v12 모양: 발전기 2 · 방 2 온실(재배 스테이션) · 방 3 연구실(해석 중인 분석기) · 방 4 서재(책 꽂힌 책장) + 전력 필드
    {
      const ghDef = SH.FURNITURE_DEF_MAP.get('furn_grow_station');
      const probe = S.freshState();
      probe.rooms[1] = { purpose: 'greenhouse', level: 1 };
      const spot = R.autoPlaceSpot(probe, 1, ghDef);
      const rooms = empty8();
      rooms[1] = { purpose: 'greenhouse', level: 1 }; rooms[2] = { purpose: 'lab', level: 1 }; rooms[3] = { purpose: 'library', level: 1 };
      const doc = {
        ...JSON.parse(JSON.stringify(base)), version: 12, generatorLevel: 2, storageLevel: 1, rooms,
        furniture: [
          ...base.furniture,
          { uid: 'f-20', defId: 'furn_grow_station', room: 1, x: spot?.x ?? 0, y: spot?.y ?? 0, yaw: spot?.yaw ?? 0, level: 1 },
          { uid: 'f-21', defId: 'furn_analyzer', room: 2, x: 0, y: 1, yaw: 0, level: 1 },
          { uid: 'f-22', defId: 'furn_bookshelf', room: 3, x: 0, y: 1, yaw: 0, level: 1 },
        ],
        books: bookId ? [{ uid: 'f-22', slot: 0, defId: bookId }] : [],
        bookDex: bookId ? [bookId] : [],
        analyses: [{ uid: 'f-21', slot: 0, sampleDefId: 'spec_cell', startedAt: 1000, readyAt: 5000 }],
        powerAlloc: { 1: 4, 2: 6, 3: 3 }, disabledFurniture: ['f-21'], pausedAt: { 'f-20': 123456 },
      };
      window.__v12Doc = doc;                         // 7번(진짜 로드 경로)이 같은 문서를 쓴다
      const a = run(doc);
      const want = [];
      R.mergeCost(want, SH.ROOM_PURPOSE_BUILD_COST.lab);
      R.mergeCost(want, SH.ROOM_PURPOSE_BUILD_COST.library);
      if (bookId) R.mergeCost(want, [{ defId: bookId, qty: 1 }]);
      R.mergeCost(want, [{ defId: 'spec_cell', qty: 1 }]);
      window.__v12Want = want;
      const again = run(JSON.parse(JSON.stringify(a.s)));
      const stored = Object.fromEntries(a.s.furnitureStorage.map((x) => [x.defId, x.qty]));
      r.v12 = {
        spot: !!spot, version: a.s.version, gen: a.s.generatorLevel,
        rooms: a.s.rooms.slice(0, 4).map((x) => x.purpose),
        station: a.s.furniture.filter((f) => f.defId === 'furn_grow_station').map((f) => `${f.uid}@${f.room}`),
        placedGone: a.s.furniture.filter((f) => f.defId === 'furn_analyzer' || f.defId === 'furn_bookshelf').length,
        stored, books: a.s.books.length, analyses: a.s.analyses.length, bookDex: a.s.bookDex.slice(),
        refund: a.out.refund, want, removed: a.out.removedByGenerator, migratedRooms: a.out.migratedRooms,
        powerKeys: POWER_FIELDS.filter((k) => k in a.s),
        again: { removed: again.out.removedByGenerator, refund: again.out.refund.length, rooms: again.s.rooms.slice(0, 4).map((x) => x.purpose), migratedRooms: again.out.migratedRooms },
      };
    }
    return r;
  }, { bookId, POWER_FIELDS });
  ok(!!bookId, `서적 def 하나 (${bookId})`);
  ok(mig.gen0.gen === 1 && mig.gen0.room0 === 'workshop' && mig.gen0.removed === 0 && mig.gen0.refund === 0,
    `발전기 0 → 1 · 작업실(Lv.1) 유지 · 환불 없음`, JSON.stringify(mig.gen0));
  ok(mig.gen0.ghGen === 1 && mig.gen0.ghRoom === 'empty' && mig.gen0.ghRemoved === 1 && same(bagOf(mig.gen0.ghRefund), bagOf(CSV_PURPOSE.greenhouse.cost)),
    `발전기 0 의 온실(Lv.2 필요) → 제거 · 증축 재료 환불 · removedByGenerator 1`, JSON.stringify(mig.gen0));
  ok(mig.gen8.gen === 5 && same(mig.gen8.rooms, ['workshop', 'mining']) && mig.gen8.removed === 0
    && mig.gen8.refund8.length === 0 && same(mig.gen8.refund8, mig.gen8.refund5) && mig.gen8.stored8 === mig.gen8.stored5,
    `발전기 8 → 5 · 채굴 시설 유지 · 환불은 발전기 5 세이브와 같다 (옛 Lv.6–8 환불 없음)`, JSON.stringify(mig.gen8));
  const v = mig.v12;
  ok(v.spot && v.version === 13 && v.gen === 2 && same(v.rooms, ['empty', 'greenhouse', 'empty', 'empty']) && same(v.station, ['f-20@1']),
    `v12 세이브(발전기 2): 온실 · 재배 스테이션 유지 · 연구실(Lv.3) · 서재(Lv.4) → 빈 방 (${v.rooms.join(' ')})`, JSON.stringify(v));
  ok(v.placedGone === 0 && v.stored.furn_analyzer === 1 && v.stored.furn_bookshelf === 1 && v.books === 0 && v.analyses === 0 && (!bookId || v.bookDex.includes(bookId)),
    `제거된 방의 분석기 · 책장 → 가구 창고 · 칸은 비고 도감은 남는다`, JSON.stringify({ stored: v.stored, books: v.books, analyses: v.analyses, dex: v.bookDex }));
  ok(same(bagOf(v.refund), bagOf(v.want)) && same(bagOf([...CSV_PURPOSE.lab.cost, ...CSV_PURPOSE.library.cost, { defId: 'spec_cell', qty: 1 }, ...(bookId ? [{ defId: bookId, qty: 1 }] : [])]), bagOf(v.want)),
    `환불 = 연구실 + 서재 증축 재료(csv) + 꽂힌 책 + 해석 중이던 표본`, JSON.stringify({ got: bagOf(v.refund), want: bagOf(v.want) }));
  ok(v.removed === 2 && v.migratedRooms === true && v.powerKeys.length === 0, `removedByGenerator ${v.removed} · migratedRooms · 전력 필드 없음 (${v.powerKeys.join(',') || '-'})`);
  ok(v.again.removed === 0 && v.again.refund === 0 && v.again.migratedRooms === false && same(v.again.rooms, v.rooms), '정리된 세이브를 다시 읽으면 아무것도 바뀌지 않는다', JSON.stringify(v.again));

  /* ══ 5. 가동 질의 ══════════════════════════════════════════════════════════ */
  console.log('furnitureOperationalBlock · stationNow');
  if (ROOM.mining !== undefined) {
    const clus = await placeFurn(ROOM.mining, 'furn_compute_cluster');
    if (clus.uid) {
      const k = await H(async (uid) => {
        const SH = await import('/src/shared/index.ts');
        const h = window.__game.ctx.housing;
        return { reason: SH.MINING_COMPUTER_REQUIRED_REASON_KO, computers: h.getPlaced().filter((f) => f.defId === 'furn_mining_computer').length, block: h.furnitureOperationalBlock(uid) };
      }, clus.uid);
      ok(k.computers === 0 && k.block === k.reason && k.reason === '채굴 시설에 메인 컴퓨터가 있어야 합니다', `메인 컴퓨터 없는 연산 클러스터 → 「${k.block}」`, JSON.stringify(k));
      const comp = await placeFurn(ROOM.mining, 'furn_mining_computer');
      const k2 = await H(({ clus, comp, bench }) => {
        const h = window.__game.ctx.housing;
        const t0 = h.nowMs();
        const now = h.stationNow(clus);
        return { block: h.furnitureOperationalBlock(clus), comp: h.furnitureOperationalBlock(comp), bench: bench ? h.furnitureOperationalBlock(bench) : null, dt: now - t0, dt2: h.nowMs() - now };
      }, { clus: clus.uid, comp: comp.uid, bench: bench.uid ?? null });
      ok(!!comp.uid && k2.block === null && k2.comp === null, `메인 컴퓨터를 놓으면 클러스터 null (${JSON.stringify(comp)})`, JSON.stringify(k2));
      ok(k2.bench === null && k2.dt >= 0 && k2.dt2 >= 0 && k2.dt < 50, `작업대는 null · stationNow = nowMs (Δ ${k2.dt} ms)`, JSON.stringify(k2));
    } else note(`연산 클러스터를 놓지 못했다 — ${JSON.stringify(clus)}`);
  } else note('채굴 시설 방이 없다 (1번 증축 실패)');

  /* ══ 6. 화면 ══════════════════════════════════════════════════════════════ */
  console.log('화면 — 시설 관리 발전기 행 · 재배 스테이션');
  const ui = await H(async ({ room }) => {
    const h = window.__game.ctx.housing;
    const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
    const read = () => {
      const g = document.querySelector('.ship-manage .sm-gen');
      return {
        gen: !!g, hint: !!g?.classList.contains('is-hint'),
        btn: g?.querySelector('.sm-gen-btn')?.textContent ?? null,
        rows: [...(g?.querySelectorAll('.sm-gen-unlocks .sm-gen-unlock') ?? [])].map((x) => ({
          lv: x.dataset.level, open: x.classList.contains('is-open'), next: x.classList.contains('is-next'), text: x.textContent,
        })),
      };
    };
    h.state.generatorLevel = 3;
    h.changed('smoke');
    const r = { manage: h.openShipManage(room) };
    await wait();
    r.at3 = read();
    r.pw = document.querySelectorAll('[class*="sm-pw"]').length;
    r.unpowered = document.querySelectorAll('.is-unpowered').length;
    h.state.generatorLevel = 5;
    h.changed('smoke');
    await wait();
    r.at5 = read();
    h.state.generatorLevel = 1;
    h.changed('smoke');
    await wait();
    r.at1 = read();
    h.closeShipManage();
    h.state.generatorLevel = 5;
    h.changed('smoke');
    return r;
  }, { room: ROOM.workshop ?? 0 });
  const rowsOk = (rows, level) => same(rows.map((x) => x.lv), ['2', '3', '4', '5'])
    && rows.every((x) => x.open === (Number(x.lv) <= level) && x.next === (Number(x.lv) === level + 1));
  ok(ui.manage && ui.at3.gen && !ui.at3.hint && ui.at3.btn === '업그레이드', `시설 관리 발전기 행 (Lv.3): 버튼 「${ui.at3.btn}」 · is-hint 없음`, JSON.stringify(ui.at3));
  ok(rowsOk(ui.at3.rows, 3), `Lv.3: .sm-gen-unlock 2·3 = is-open · 4 = is-next · 5 = 잠김 (${ui.at3.rows.map((x) => `${x.lv}:${x.text}`).join(' / ')})`, JSON.stringify(ui.at3.rows));
  const purposeNames = await H(async () => { const SH = await import('/src/shared/index.ts'); return SH.ROOM_PURPOSE_LABEL_KO; });
  const namesOk = ui.at3.rows.every((x) => Object.entries(CSV_PURPOSE).filter(([p, d]) => d.gen === Number(x.lv) && gate.assignable.includes(p)).every(([p]) => x.text.includes(purposeNames[p])));
  ok(namesOk, '각 레벨 줄이 그 레벨에서 열리는 용도 이름을 적는다 (room_purposes.csv generator)');
  ok(ui.at5.btn === '최대' && rowsOk(ui.at5.rows, 5), `Lv.5: 버튼 「${ui.at5.btn}」 · 네 줄 모두 is-open · is-next 없음`, JSON.stringify(ui.at5));
  ok(ui.at1.btn === '업그레이드' && rowsOk(ui.at1.rows, 1), `Lv.1: 2 = is-next · 나머지 잠김`, JSON.stringify(ui.at1.rows));
  ok(ui.pw === 0 && ui.unpowered === 0, `전력 패널 흔적 없음 (.sm-pw* ${ui.pw} · .is-unpowered ${ui.unpowered})`);

  const gs = ROOM.greenhouse !== undefined ? await placeFurn(ROOM.greenhouse, 'furn_grow_station') : { err: 'no greenhouse room' };
  if (gs.uid) {
    const ui2 = await H(async (uid) => {
      const h = window.__game.ctx.housing;
      h.openGrowStation(uid);
      await new Promise((r) => setTimeout(r, 80));
      const r = { open: !!h.growStation?.isOpen, toggle: document.querySelectorAll('.hpw-toggle').length, banner: document.querySelectorAll('.hpw-banner').length,
        anyHpw: document.querySelectorAll('[class*="hpw-"]').length, block: h.furnitureOperationalBlock(uid) };
      h.closeMenus();
      return r;
    }, gs.uid);
    ok(ui2.open && ui2.toggle === 0 && ui2.banner === 0 && ui2.anyHpw === 0 && ui2.block === null,
      `재배 스테이션 화면: .hpw-toggle · .hpw-banner 없음 · 가동 사유 null`, JSON.stringify(ui2));
  } else note(`재배 스테이션을 놓지 못했다 — ${JSON.stringify(gs)}`);

  const pwEv = (await ev('housing:powerChanged')).length + (await ev('housing:operationalChanged')).length;
  ok(pwEv === 0, `housing:powerChanged · housing:operationalChanged 가 한 번도 나지 않았다 (${pwEv})`);

  /* ══ 7. 진짜 로드 경로 ════════════════════════════════════════════════════ */
  console.log('로드 경로 — v12 세이브 → 새로고침');
  await clearStash();
  const want7 = await H(() => JSON.parse(JSON.stringify(window.__v12Want)));
  const ids7 = Object.keys(bagOf(want7));
  await sleep(600);                                      // 창고 저장 debounce 가 빈 창고를 쓰게
  const pre = await counts(ids7);
  await H(() => {
    const h = window.__game.ctx.housing;
    h.save();
    const text = JSON.stringify(window.__v12Doc);
    const put = () => { try { localStorage.setItem('scav.s1.ship', text); } catch { /* storage off */ } };
    put();
    // ShipStore 의 pagehide / beforeunload flush 가 먼저 등록돼 있으므로, 그 뒤에 다시 쓴다
    window.addEventListener('beforeunload', put);
    window.addEventListener('pagehide', put);
  });
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot after reload');
  await pumpFrames();
  const toastOk = await waitFor(page, () => window.__bootNotify.some((t) => /발전기 레벨이 모자란 시설 2곳을 제거했습니다/.test(t)) || null, 'generator toast', 15000).catch(() => false);
  await waitFor(page, (ids) => ids.every((id) => window.__game.ctx.inventory.countDefAll(id) > 0) || null, 'refund in stash', 15000, ids7).catch(() => null);
  await sleep(300);
  const post = await counts(ids7);
  const load = await H(({ POWER_FIELDS }) => {
    const h = window.__game.ctx.housing, s = h.state;
    return {
      version: s.version, gen: s.generatorLevel, rooms: s.rooms.slice(0, 4).map((x) => x.purpose),
      stored: Object.fromEntries(s.furnitureStorage.map((x) => [x.defId, x.qty])),
      station: s.furniture.filter((f) => f.defId === 'furn_grow_station').length,
      powerKeys: POWER_FIELDS.filter((k) => k in s),
      toasts: window.__bootNotify.slice(),
      saved: (() => { try { const j = JSON.parse(localStorage.getItem('scav.s1.ship')); return { v: j.version, keys: POWER_FIELDS.filter((k) => k in j) }; } catch { return null; } })(),
    };
  }, { POWER_FIELDS });
  ok(!!toastOk, `토스트 「발전기 레벨이 모자란 시설 2곳을 제거했습니다 — …」`, JSON.stringify(load.toasts));
  ok(load.version === 13 && load.gen === 2 && same(load.rooms, ['empty', 'greenhouse', 'empty', 'empty']) && load.station === 1
    && load.stored.furn_analyzer === 1 && load.stored.furn_bookshelf === 1 && load.powerKeys.length === 0,
    `로드된 함선: v13 · 발전기 2 · 온실만 남음 · 분석기 · 책장은 가구 창고 · 전력 필드 없음`, JSON.stringify(load));
  const got7 = bagOf(ids7.map((id) => ({ defId: id, qty: post[id] - pre[id] })));
  ok(same(got7, bagOf(want7)), `환불이 함선 창고에 들어왔다 (${JSON.stringify(got7)})`, JSON.stringify({ want: bagOf(want7), pre, post }));
  await sleep(700);                                      // markDirty debounce → 다시 쓴 세이브
  const saved = await H(({ POWER_FIELDS }) => { try { const j = JSON.parse(localStorage.getItem('scav.s1.ship')); return { v: j.version, keys: POWER_FIELDS.filter((k) => k in j), rooms: j.rooms.slice(0, 4).map((x) => x.purpose) }; } catch (e) { return { err: String(e) }; } }, { POWER_FIELDS });
  ok(saved.v === 13 && saved.keys.length === 0 && same(saved.rooms, ['empty', 'greenhouse', 'empty', 'empty']), `정리된 상태가 localStorage 에 다시 저장됐다 (v${saved.v})`, JSON.stringify(saved));

  await H(() => { for (const k of ['scav.s1.ship', 'scav.s1.stash', 'scav.s1.grant']) localStorage.removeItem(k); });
  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
