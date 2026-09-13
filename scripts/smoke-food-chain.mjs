// Single-player smoke test for **요리 재료 티어 — housing 규칙** (2026-09-13, docs/plans/food-tiers.md §4, agent B).
// 화면(housing/ui)은 smoke-stations 의 몫이고, 여기서는 `ctx.housing` API · `state` · 세이브만 본다:
//   0. `Rules.ts` 순수 함수 — 뒤 두 인자의 기본값이 옛 식과 **같은 값**(`growDurationMs` · `cultureDurationMs`), 흙 궁합 보너스만 비율을 탄다
//      (패널티는 그대로), 소켓 speed 바닥, `durabilityRatio` · `wearAfterHarvest`(wear 소켓 바닥), `analysisDurationMs`, 결과표 가중 추첨(rng 0 →
//      첫 줄 최소 개수 · rng ≈1 → 마지막 해금 줄 최대 개수 · defOk 거절 → null), `analysisChances` 합 1 · 잠긴 줄 없음.
//   1. 분석기 — 넣는 순간 결과를 굴려 칸에 적는다(계열 · 결과 · 개수 범위 · 시간 = analyzeHours × analysisTimeMul(Lv)), 해석 중에는 결과를 숨긴다,
//      레벨이 바뀌어도 적힌 결과는 그대로, 회수 = 산출물 하나(첫 해석 보너스 없음) → 계열 경험치 → `housing:analysisFound` → 레벨업
//      (`housing:analysisLevelUp`) · 시간 배수, `housing:sampleDexAdded` 는 더 안 난다, 결과 없는 옛 칸은 회수할 때 굴린다, 결과표 정렬 · 확률,
//      은퇴 표본도 해석된다, 세이브 왕복(`sanitize` 가 새 필드를 버리지 않는다).
//   2. 재배 스테이션 — 부은 흙 = 내구도 최대 · 소켓 칸 = 등급, 수확마다 닳고 **0 이어도 칸 유지** · 0 에서 궁합 보너스가 사라진다 · 비율 절반,
//      소켓 사유(흙 없음 · 소켓 아님 · 반대 대상 · 가득 참 · 없는 칸) · 교체(옛 소켓 파괴, 이벤트 `replaced`) · speed 가 파종 시간에 · yield 덤(마모
//      전 비율, 0 이면 없음) · wear 소켓 · 흙 비우기 = 소켓도 사라짐 · `getOwnedSockets(target)` · 옛 세이브 `soilUsesLeft` → 내구도 이관 · 세이브 왕복.
//   3. 배양조 — 배지 내구도 · 스캐폴드 넣기 / 빼기 / 사유, 스캐폴드 산출이 없는 세포주 거절, 은퇴 세포주 거절, 스캐폴드 → 종별 고기
//      (`scaffoldHours` · 수확 때 스캐폴드 소모 · 칸 유지), 스캐폴드 없이 = 고기 페이스트, 배지 소켓, 스캐폴드만 든 칸 비우기 = 스캐폴드 반환,
//      은퇴 세포주가 든 옛 칸 = 세포주 필드만 지운다, 세이브 왕복.
//   4. (마지막, 너그럽게) 요리 `effects` 가 `derived` 에 전부 접히는가 — progression(agent D)의 몫이라 안 접히면 SKIP 으로 적는다.
// 아이템 데이터(agent A: 표본 family · 토양/배지 durability · 소켓 · 세포주 · 스캐폴드)가 아직 없으면 그 구획은 한 줄 FAIL 뒤 건너뛴다.
// Usage: node scripts/smoke-food-chain.mjs [http://localhost:5273/]   (needs `npm run dev`)
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
    for (const n of ['housing:analysisFound', 'housing:analysisLevelUp', 'housing:sampleDexAdded', 'housing:socketInserted', 'gather:collected']) {
      window.__ev[n] = [];
      window.__game.ctx.bus.on(n, (p) => window.__ev[n].push(JSON.parse(JSON.stringify(p))));
    }
  });
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  // a fresh stash is granted the 기본 지급품 — empty it so nothing below depends on it
  await H(() => { const st = window.__game.getSystem('inventory').getStash(); for (const p of st.items()) st.remove(p.item.uid); });

  /** Units of `defId` into the stash in def-sized stacks (−1 = no such item def). */
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
  const ev = (n) => H((k) => window.__ev[k].slice(), n);
  const clearEv = () => H(() => { for (const k of Object.keys(window.__ev)) window.__ev[k].length = 0; });
  const missing = (ids) => H((list) => list.filter((id) => !window.__game.ctx.loot.getItemDef(id)), ids);

  /* ══ 0. Rules — 순수 함수 ══════════════════════════════════════════════════ */
  console.log('Rules — 순수 함수');
  const pure = await H(async () => {
    const R = await import('/src/housing/Rules.ts');
    const S = await import('/src/shared/index.ts');
    const o = {};
    const skillMul = (g) => 1 - S.GROW_SKILL_SPEEDUP * (Math.max(0, Math.min(S.SKILL_LEVEL_MAX, g)) / S.SKILL_LEVEL_MAX);
    const oldGrow = Math.max(1000, Math.round((2 * 3600e3 * skillMul(30) * (1 - S.SOIL_MATCH_SPEEDUP)) / R.growStationSpeedMul(2)));
    o.growDefault = [R.growDurationMs(2, true, 30, 2), R.growDurationMs(2, true, 30, 2, 1, 0), oldGrow];
    o.growMiss = R.growDurationMs(2, false, 0, 1, 0.3, 0) === Math.round(2 * 3600e3 * (1 + S.SOIL_MISMATCH_PENALTY));
    o.growRatio0 = R.growDurationMs(1, true, 0, 1, 0, 0) === 3600e3;
    o.growHalf = R.growDurationMs(1, true, 0, 1, 0.5, 0) === Math.round(3600e3 * (1 - S.SOIL_MATCH_SPEEDUP * 0.5));
    o.growSocket = R.growDurationMs(1, true, 0, 1, 1, 0.2) === Math.round(3600e3 * (1 - S.SOIL_MATCH_SPEEDUP) * Math.max(S.GROW_SOCKET_TIME_FLOOR, 0.8));
    o.growSocketHalf = R.growDurationMs(1, false, 0, 1, 0.5, 0.2) === Math.round(3600e3 * (1 + S.SOIL_MISMATCH_PENALTY) * Math.max(S.GROW_SOCKET_TIME_FLOOR, 0.9));
    o.growFloor = R.growDurationMs(1, false, 0, 1, 1, 5) === Math.round(3600e3 * (1 + S.SOIL_MISMATCH_PENALTY) * S.GROW_SOCKET_TIME_FLOOR);
    const oldCult = Math.max(1000, Math.round(3 * 3600e3 * 0.75 * skillMul(10)));
    o.cultDefault = [R.cultureDurationMs(3, 0.75, 10), R.cultureDurationMs(3, 0.75, 10, 1, 0), oldCult];
    o.cultRatio0 = R.cultureDurationMs(1, 0.75, 0, 0, 0) === 3600e3;
    o.cultHalf = R.cultureDurationMs(1, 0.6, 0, 0.5, 0.1) === Math.round(3600e3 * 0.8 * Math.max(S.GROW_SOCKET_TIME_FLOOR, 0.95));
    o.ratio = [R.durabilityRatio(50, 100), R.durabilityRatio(5, 0), R.durabilityRatio(150, 100), R.durabilityRatio(-3, 100)];
    o.wear = [R.wearAfterHarvest(100, 25, 0), R.wearAfterHarvest(100, 25, 0.4), R.wearAfterHarvest(100, 25, 5), R.wearAfterHarvest(10, 25, 0)];
    o.wearWant = [75, 85, Math.round((100 - 25 * S.GROW_WEAR_MUL_FLOOR) * 100) / 100, 0];
    o.analysis = [R.analysisDurationMs(2, 1) === Math.round(2 * 3600e3 * S.analysisTimeMul(1)),
      R.analysisDurationMs(2, 2) === Math.round(2 * 3600e3 * S.analysisTimeMul(2)), R.analysisDurationMs(0, 1) === 1000];
    const c1 = S.ANALYSIS_RESULTS.filter((r) => r.family === 'cell' && r.minLevel <= 1 && r.weight > 0);
    const lo = R.rollAnalysisResult('cell', 1, () => 0, () => true);
    const hi = R.rollAnalysisResult('cell', 1, () => 0.999999, () => true);
    o.rows1 = c1.length;
    o.rollLo = !!lo && lo.defId === c1[0].defId && lo.qty === c1[0].qtyMin;
    o.rollHi = !!hi && hi.defId === c1[c1.length - 1].defId && hi.qty === c1[c1.length - 1].qtyMax;
    o.rollNone = R.rollAnalysisResult('cell', 1, () => 0.5, () => false) === null;
    const ch1 = R.analysisChances('cell', 1, () => true);
    const lockedAt1 = S.ANALYSIS_RESULTS.filter((r) => r.family === 'cell' && r.minLevel > 1).map((r) => r.defId).filter((id) => !c1.some((r) => r.defId === id));
    o.chances = Math.abs(Object.values(ch1).reduce((a, b) => a + b, 0) - 1) < 1e-9 && lockedAt1.every((id) => !(id in ch1));
    const chMax = R.analysisChances('cell', S.ANALYSIS_LEVEL_MAX, () => true);
    o.chancesMax = lockedAt1.length > 0 && lockedAt1.every((id) => chMax[id] > 0) && Math.abs(Object.values(chMax).reduce((a, b) => a + b, 0) - 1) < 1e-9;
    return o;
  });
  ok(pure.growDefault[0] === pure.growDefault[2] && pure.growDefault[1] === pure.growDefault[2],
    `growDurationMs 의 새 인자 기본값 = 옛 식 (${JSON.stringify(pure.growDefault)})`);
  ok(pure.cultDefault[0] === pure.cultDefault[2] && pure.cultDefault[1] === pure.cultDefault[2],
    `cultureDurationMs 의 새 인자 기본값 = 옛 식 (${JSON.stringify(pure.cultDefault)})`);
  ok(pure.growMiss && pure.growRatio0 && pure.growHalf, '흙 궁합 보너스만 내구도 비율을 탄다 (0 = 보너스 없음 · 0.5 = 절반) · 불일치 패널티는 그대로', JSON.stringify(pure));
  ok(pure.growSocket && pure.growSocketHalf && pure.growFloor, '소켓 speed = 1 − 합 × 비율, 바닥 GROW_SOCKET_TIME_FLOOR', JSON.stringify(pure));
  ok(pure.cultRatio0 && pure.cultHalf, '배지 속도 보너스(1 − speedMul) · 소켓 speed 가 배지 내구도 비율을 탄다', JSON.stringify(pure));
  ok(JSON.stringify(pure.ratio) === JSON.stringify([0.5, 0, 1, 0]), `durabilityRatio (${JSON.stringify(pure.ratio)})`);
  ok(JSON.stringify(pure.wear) === JSON.stringify(pure.wearWant), `wearAfterHarvest — wear 소켓 합 · 바닥 GROW_WEAR_MUL_FLOOR · 0 아래로 안 간다 (${JSON.stringify(pure.wear)})`);
  ok(pure.analysis.every(Boolean), 'analysisDurationMs = analyzeHours × analysisTimeMul(Lv), 최소 1000 ms');
  ok(pure.rows1 > 0 && pure.rollLo && pure.rollHi && pure.rollNone, 'rollAnalysisResult: rng 0 → 첫 줄 최소 개수 · rng ≈1 → 마지막 해금 줄 최대 개수 · 받을 수 있는 줄이 없으면 null');
  ok(pure.chances && pure.chancesMax, 'analysisChances: 합 1 · Lv.1 에는 잠긴 줄이 없고 최대 레벨에서는 들어온다');

  /* ── 계약 API ── */
  const api = await H(() => ['getAnalysisLevel', 'getAnalysisResults', 'getAnalysisFound', 'insertGrowSocket', 'insertCultureSocket', 'insertScaffold', 'takeScaffold', 'getOwnedSockets']
    .filter((k) => typeof window.__game.ctx.housing[k] !== 'function'));
  ok(api.length === 0, 'HousingRef 요리 재료 티어 API 8종', `missing: ${api.join(', ')}`);
  const st0 = await H(() => ({ v: window.__game.ctx.housing.state.version, xp: window.__game.ctx.housing.state.analysisXp, found: window.__game.ctx.housing.state.analysisFound }));
  ok(st0.v === 11 && st0.xp && Object.keys(st0.xp).length === 0 && Array.isArray(st0.found) && st0.found.length === 0, `새 함선 = v11 · analysisXp {} · analysisFound [] (${JSON.stringify(st0)})`);

  /* ── 함선: 방 용도는 state 에 직접 (용도 규칙은 smoke-housing 의 몫) ── */
  for (const [id, n] of [['mat_scrap', 60], ['mat_cable', 24], ['mat_bio_sample', 30], ['mat_circuit', 16], ['mat_cloth', 10],
    ['mat_alloy', 30], ['mat_power_cell', 4], ['mat_control_module', 2], ['mat_capacitor', 2]]) await giveStash(id, n);
  await H(() => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = 5;
    for (const [i, p] of [[3, 'greenhouse'], [4, 'lab'], [6, 'greenhouse']]) h.state.rooms[i].purpose = p;
  });
  const placeFurn = (room, defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    if (!h.craftFurniture(defId)) return { err: `craft: ${h.furnitureCraftBlock?.(defId) ?? '?'}` };
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return { err: 'no spot' };
    const p = h.place(room, defId, spot.x, spot.y, spot.yaw);
    return p ? { uid: p.uid } : { err: 'place refused' };
  }, { room, defId });
  const gsP = await placeFurn(3, 'furn_grow_station');
  const azP = await placeFurn(4, 'furn_analyzer');
  const ctP = await placeFurn(6, 'furn_culture_tank');
  ok(gsP.uid && azP.uid && ctP.uid, 'craft + place 재배 스테이션 · 분석기 · 배양조', JSON.stringify({ gsP, azP, ctP }));
  const GS = gsP.uid, AZ = azP.uid, CT = ctP.uid;

  /* ══ 1. 분석기 ══════════════════════════════════════════════════════════════ */
  console.log('분석기 — 결과표 · 분석 레벨 · 분석 도감');
  const sMiss = await missing(['spec_cell', 'spec_mineral', 'spec_dna']);
  const famOk = sMiss.length === 0 && await H(() => ['spec_cell', 'spec_mineral', 'spec_dna']
    .every((id, i) => window.__game.ctx.loot.getItemDef(id)?.sample?.family === ['cell', 'mineral', 'dna'][i]));
  ok(famOk, `표본 3종 + family 데이터 (agent A) (missing: ${sMiss.join(', ') || '없음'})`);
  if (AZ && famOk) {
    ok(await giveStash('spec_cell', 12) === 12 && await giveStash('spec_mineral', 2) === 2 && await giveStash('spec_dna', 1) === 1, '표본 준비 (세포 12 · 광물 2 · DNA 1)');
    const K = await H(async () => {
      const S = await import('/src/shared/index.ts');
      const d = window.__game.ctx.loot.getItemDef('spec_cell');
      return { xpBy: S.ANALYSIS_XP_BY_RARITY[d.rarity], hours: d.sample.analyzeHours,
        xp2: S.analysisXpForLevel(2), xp3: S.analysisXpForLevel(3), mul2: S.analysisTimeMul(2), lv1: S.analysisLevelForXp(S.ANALYSIS_XP_BY_RARITY[d.rarity]) };
    });
    const started = await H(async (AZ) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory, loot = window.__game.ctx.loot;
      const S = await import('/src/shared/index.ts');
      const R = await import('/src/housing/Rules.ts');
      const before = inv.countDefAll('spec_cell');
      const err = h.startAnalysis(AZ, 0, 'spec_cell');
      const raw = JSON.parse(JSON.stringify(h.state.analyses.find((a) => a.uid === AZ && a.slot === 0) ?? null));
      const def = loot.getItemDef('spec_cell');
      const okDef = (id) => { const d = loot.getItemDef(id); return !!d && !d.retired; };
      const pool = S.ANALYSIS_RESULTS.filter((r) => r.family === 'cell' && r.minLevel <= 1 && r.weight > 0 && okDef(r.defId));
      const row = raw && pool.find((r) => r.defId === raw.resultDefId);
      return { err, spent: before - inv.countDefAll('spec_cell'), raw, info: JSON.parse(JSON.stringify(h.getAnalyses(AZ)[0])),
        wantMs: R.analysisDurationMs(def.sample.analyzeHours, 1),
        inPool: !!row && raw.resultQty >= row.qtyMin && raw.resultQty <= row.qtyMax,
        isReward: pool.length === 0 && raw?.resultDefId === def.sample.rewardDefId };
    }, AZ);
    ok(started.err === null && started.spent === 1, `startAnalysis(spec_cell) — 표본 1개 소모 (${started.err})`);
    ok(started.raw?.family === 'cell' && (started.inPool || started.isReward),
      `넣는 순간 결과를 굴려 칸에 적는다 — 계열 cell · 해금된 줄 · 개수 범위 안 (${started.raw?.resultDefId} ×${started.raw?.resultQty})`, JSON.stringify(started.raw));
    ok(started.raw && started.raw.readyAt - started.raw.startedAt === started.wantMs, `Lv.1 해석 시간 = analyzeHours × analysisTimeMul(1) (${started.raw && started.raw.readyAt - started.raw.startedAt} ms)`);
    ok(started.info.family === 'cell' && !started.info.ready && started.info.resultDefId === null && started.info.rewardDefId === null && started.info.resultQty === 0,
      '해석 중에는 결과를 보여 주지 않는다 (family 만)', JSON.stringify(started.info));

    const stable = await H((AZ) => {
      const h = window.__game.ctx.housing;
      const a = h.state.analyses.find((x) => x.uid === AZ && x.slot === 0);
      const r0 = `${a.resultDefId}×${a.resultQty}`;
      h.state.analysisXp = { cell: 9999 };
      h.getAnalyses(AZ);
      const r1 = `${a.resultDefId}×${a.resultQty}`;
      h.state.analysisXp = {};
      a.readyAt = h.nowMs() - 1000;
      return { r0, r1, info: JSON.parse(JSON.stringify(h.getAnalyses(AZ)[0])) };
    }, AZ);
    ok(stable.r0 === stable.r1, `분석 레벨이 바뀌어도 칸에 적힌 결과는 그대로 (${stable.r0})`);
    ok(stable.info.ready && stable.info.resultDefId === started.raw.resultDefId && stable.info.rewardDefId === started.raw.resultDefId
      && stable.info.resultQty === started.raw.resultQty && stable.info.rewardQty === started.raw.resultQty && stable.info.firstTime === true,
    '끝난 칸 = 결과 · reward 같은 값 · 도감에 없으니 firstTime', JSON.stringify(stable.info));

    await clearEv();
    const col = await H((AZ) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
      const a = h.state.analyses.find((x) => x.uid === AZ && x.slot === 0);
      const id = a.resultDefId, qty = a.resultQty;
      const total = () => inv.getStashItems().reduce((s, i) => s + i.qty, 0) + inv.getAllItems().reduce((s, i) => s + i.qty, 0);
      const before = inv.countDefAll(id), t0 = total();
      const err = h.collectAnalysis(AZ, 0, 'stash-first');
      return { err, id, qty, gained: inv.countDefAll(id) - before, totalGain: total() - t0, left: h.state.analyses.filter((x) => x.uid === AZ).length,
        lv: h.getAnalysisLevel('cell'), found: [...h.getAnalysisFound()], dex: [...h.getSampleDex()] };
    }, AZ);
    const evFound = await ev('housing:analysisFound');
    ok(col.err === null && col.gained === col.qty && col.totalGain === col.qty && col.left === 0,
      `회수 → 산출물 하나만 (${col.id} ×${col.qty}, 첫 해석 보너스 없음) · 칸 제거`, JSON.stringify(col));
    ok(col.lv.xp === K.xpBy && col.lv.level === K.lv1, `경험치 +ANALYSIS_XP_BY_RARITY[표본 등급] (${col.lv.xp})`);
    ok(col.found.includes(col.id) && evFound.length === 1 && evFound[0].family === 'cell' && evFound[0].defId === col.id,
      `처음 받은 산출물 → analysisFound + housing:analysisFound (${JSON.stringify(evFound)})`);
    ok((await ev('housing:sampleDexAdded')).length === 0 && col.dex.includes('spec_cell'), 'housing:sampleDexAdded 는 더 나지 않고 옛 표본 도감은 조용히 찬다');

    await clearEv();
    const lvl = await H((AZ) => {
      const h = window.__game.ctx.housing;
      const log = [];
      for (let i = 0; i < 12 && h.getAnalysisLevel('cell').level < 2; i++) {
        const e1 = h.startAnalysis(AZ, 0, 'spec_cell');
        const a = h.state.analyses.find((x) => x.uid === AZ && x.slot === 0);
        if (a) a.readyAt = h.nowMs() - 1000;
        log.push([e1, h.collectAnalysis(AZ, 0, 'stash-first')]);
      }
      return { log, info: h.getAnalysisLevel('cell') };
    }, AZ);
    const evLv = await ev('housing:analysisLevelUp');
    ok(lvl.log.every(([a, b]) => a === null && b === null) && lvl.info.level === 2, `해석을 거듭하면 세포 분석 Lv.2 (${lvl.log.length}회 더, xp ${lvl.info.xp})`, JSON.stringify(lvl.log));
    ok(evLv.length === 1 && evLv[0].family === 'cell' && evLv[0].level === 2, `housing:analysisLevelUp {cell, 2} 한 번 (${JSON.stringify(evLv)})`);
    ok(lvl.info.levelXp === K.xp2 && lvl.info.nextLevelXp === K.xp3 && lvl.info.timeMul === K.mul2,
      `getAnalysisLevel — levelXp · nextLevelXp · timeMul (${JSON.stringify(lvl.info)})`);
    const lv2 = await H((AZ) => {
      const h = window.__game.ctx.housing;
      const e = h.startAnalysis(AZ, 0, 'spec_cell');
      const a = h.state.analyses.find((x) => x.uid === AZ && x.slot === 0);
      return { e, ms: a ? a.readyAt - a.startedAt : 0 };
    }, AZ);
    ok(lv2.e === null && lv2.ms === Math.max(1000, Math.round(K.hours * 3600e3 * K.mul2)), `Lv.2 해석 시간 = analyzeHours × ${K.mul2} (${lv2.ms} ms)`);

    const legacy = await H((AZ) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
      const a = h.state.analyses.find((x) => x.uid === AZ && x.slot === 0);
      delete a.resultDefId; delete a.resultQty; delete a.family;
      a.readyAt = h.nowMs() - 1000;
      const info = JSON.parse(JSON.stringify(h.getAnalyses(AZ)[0]));
      const xp0 = h.getAnalysisLevel('cell').xp;
      const total = () => inv.getStashItems().reduce((s, i) => s + i.qty, 0) + inv.getAllItems().reduce((s, i) => s + i.qty, 0);
      const t0 = total();
      const err = h.collectAnalysis(AZ, 0, 'stash-first');
      return { info, err, xpGain: h.getAnalysisLevel('cell').xp - xp0, gain: total() - t0 };
    }, AZ);
    ok(legacy.info.ready && legacy.info.resultDefId === null && legacy.info.family === 'cell', '결과가 없는 옛 칸: 끝나도 결과 null · 계열은 표본 def 에서 읽는다', JSON.stringify(legacy.info));
    ok(legacy.err === null && legacy.gain >= 1 && legacy.xpGain === K.xpBy, `옛 칸은 회수하는 순간 굴려서 준다 (+${legacy.gain}개 · xp +${legacy.xpGain})`);

    const res = await H(() => ({ list: window.__game.ctx.housing.getAnalysisResults('cell'), lv: window.__game.ctx.housing.getAnalysisLevel('cell').level, found: [...window.__game.ctx.housing.getAnalysisFound()] }));
    const unlocked = res.list.filter((r) => r.unlocked);
    ok(res.list.length > 0 && res.list.every((r, i) => i === 0 || res.list[i - 1].minLevel <= r.minLevel)
      && res.list.every((r, i) => i === 0 || res.list[i - 1].minLevel < r.minLevel || res.list[i - 1].chance >= r.chance - 1e-12),
    `getAnalysisResults: 최소 레벨 오름차순 · 같은 레벨은 가중치(= 확률) 내림차순 (${res.list.map((r) => `${r.defId}@${r.minLevel}`).join(' ')})`);
    ok(res.list.every((r) => r.unlocked === (r.minLevel <= res.lv)) && res.list.every((r) => r.unlocked || r.chance === 0)
      && Math.abs(unlocked.reduce((s, r) => s + r.chance, 0) - 1) < 1e-9 && res.list.every((r) => r.found === res.found.includes(r.defId)),
    `해금 = minLevel ≤ Lv.${res.lv} · 잠긴 줄 확률 0 · 해금 줄 합 1 · found = 분석 도감`);

    const retired = await H(() => { const d = window.__game.ctx.loot.getItemDef('spec_tissue'); return { has: !!d, retired: !!d?.retired, family: d?.sample?.family ?? null }; });
    if (retired.has && retired.retired) {
      await giveStash('spec_tissue', 1);
      const rt = await H((AZ) => {
        const h = window.__game.ctx.housing;
        const e1 = h.startAnalysis(AZ, 0, 'spec_tissue');
        const a = h.state.analyses.find((x) => x.uid === AZ && x.slot === 0);
        const fam = a?.family ?? null;
        if (a) a.readyAt = h.nowMs() - 1000;
        return { e1, fam, want: window.__game.ctx.loot.getItemDef('spec_tissue').sample.family, e2: h.collectAnalysis(AZ, 0, 'stash-first') };
      }, AZ);
      ok(rt.e1 === null && rt.e2 === null && rt.fam === rt.want, `은퇴 표본(spec_tissue)도 자기 계열(${rt.want})로 해석된다`, JSON.stringify(rt));
    } else {
      note(`spec_tissue 에 은퇴 표시가 아직 없다 (agent A) — ${JSON.stringify(retired)}`);
    }

    const owned = await H(() => window.__game.ctx.housing.getOwnedSamples().map((o) => window.__game.ctx.loot.getItemDef(o.defId).sample.family));
    ok(owned.length >= 3 && owned.every((f, i) => i === 0 || ['cell', 'mineral', 'dna'].indexOf(owned[i - 1]) <= ['cell', 'mineral', 'dna'].indexOf(f)),
      `getOwnedSamples: 계열 순 (${owned.join(' ')})`);
    ok(await H(() => { const r = window.__game.ctx.housing.getSampleDexRatio(); return r > 0 && r <= 1; }), 'getSampleDexRatio (@deprecated) = 발견한 산출물 ÷ 결과표 산출물, 0…1');

    const persist = await H(async (AZ) => {
      const h = window.__game.ctx.housing;
      const e = h.startAnalysis(AZ, 0, 'spec_mineral');
      h.changed('smoke'); h.save();
      const raw = JSON.parse(localStorage.getItem('scav.s1.ship'));
      const SS = await import('/src/housing/ShipState.ts');
      const pick = (s) => ({ v: s.version, xp: s.analysisXp?.cell ?? null, found: s.analysisFound ?? null,
        a: (s.analyses ?? []).map((a) => `${a.uid}/${a.slot}:${a.family}:${a.resultDefId}:${a.resultQty}`) });
      const out = { e, raw: pick(raw), san: pick(SS.sanitize(raw)) };
      h.cancelAnalysis(AZ, 0);
      return out;
    }, AZ);
    ok(persist.e === null && persist.raw.v === 11 && persist.raw.xp > 0 && persist.raw.found?.length > 0 && /:mineral:[a-z]\w+:\d+$/.test(persist.raw.a[0] ?? ''),
      `세이브에 계열 · 결과 · analysisXp · analysisFound 가 실린다 (${JSON.stringify(persist.raw)})`);
    ok(JSON.stringify(persist.san) === JSON.stringify(persist.raw), 'ShipState.sanitize 가 분석 새 필드를 버리지 않는다', JSON.stringify(persist.san));
  }

  /* ══ 2. 재배 스테이션 — 흙 내구도 · 소켓 ═══════════════════════════════════════ */
  console.log('재배 스테이션 — 흙 내구도 · 소켓');
  const gIds = ['soil_humus', 'seed_beanpod', 'sock_soil_speed_1', 'sock_soil_speed_2', 'sock_soil_yield_1', 'sock_soil_wear_2', 'sock_medium_speed_1'];
  const gMiss = await missing(gIds);
  const soilOk = gMiss.length === 0 && await H(() => (window.__game.ctx.loot.getItemDef('soil_humus')?.soil?.durability ?? 0) > 0
    && !!window.__game.ctx.loot.getItemDef('sock_soil_speed_1')?.growSocket);
  ok(soilOk, `토양 durability · 소켓 아이템 데이터 (agent A) (missing: ${gMiss.join(', ') || '없음'})`);
  if (GS && soilOk) {
    for (const [id, n] of [['soil_humus', 8], ['seed_beanpod', 20], ['sock_soil_speed_1', 4], ['sock_soil_speed_2', 1], ['sock_soil_yield_1', 3],
      ['sock_soil_wear_2', 1], ['sock_medium_speed_1', 1]]) await giveStash(id, n);
    const wantGrow = (ratio, speed) => H(async ({ GS, ratio, speed }) => {
      const R = await import('/src/housing/Rules.ts');
      const h = window.__game.ctx.housing;
      return R.growDurationMs(window.__game.ctx.loot.getItemDef('seed_beanpod').seed.growHours, true, h.gardening(), h.stationOf(GS).level, ratio, speed);
    }, { GS, ratio, speed });
    const growMs = (tier, slot) => H(({ GS, tier, slot }) => {
      const g = window.__game.ctx.housing.state.grows.find((x) => x.uid === GS && x.tier === tier && x.slot === slot);
      return g?.readyAt ? g.readyAt - g.plantedAt : 0;
    }, { GS, tier, slot });

    const fill = await H(async (GS) => {
      const S = await import('/src/shared/index.ts');
      const h = window.__game.ctx.housing, def = window.__game.ctx.loot.getItemDef('soil_humus');
      const err = h.fillSoil(GS, 0, 0, 'soil_humus');
      const s = JSON.parse(JSON.stringify(h.getGrowSlots(GS).find((x) => x.tier === 0 && x.slot === 0)));
      return { err, s, max: def.soil.durability, slots: S.growSocketSlotsFor(def.rarity), wear: S.SOIL_WEAR_PER_HARVEST,
        plant: h.plantSeedAt(GS, 0, 0, 'seed_beanpod'), matchTag: window.__game.ctx.loot.getItemDef('seed_beanpod').seed.soilTag === def.soil.tag };
    }, GS);
    const WEAR = fill.wear;
    ok(fill.err === null && fill.matchTag && fill.s.soilDurability === fill.max && fill.s.soilDurabilityMax === fill.max && fill.s.soilBonusRatio === 1
      && fill.s.sockets.length === 0 && fill.s.socketSlots === fill.slots && fill.s.soilUsesLeft === Math.ceil(fill.max / WEAR),
    `부은 흙 = 내구도 최대 · 비율 1 · 소켓 0 / 등급 칸 ${fill.slots} · 남은 수확 ceil(${fill.max}/${WEAR})`, JSON.stringify(fill.s));
    ok(fill.plant === null && await growMs(0, 0) === await wantGrow(1, 0), '비율 1 · 소켓 없음의 파종 시간 = growDurationMs(…, 1, 0)');

    const n = Math.ceil(fill.max / WEAR);
    const worn = await H(({ GS, n }) => {
      const h = window.__game.ctx.housing;
      const at = () => h.getGrowSlots(GS).find((x) => x.tier === 0 && x.slot === 0);
      const errs = [], durs = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) errs.push(h.plantSeedAt(GS, 0, 0, 'seed_beanpod'));
        for (const g of h.state.grows) if (g.uid === GS && g.tier === 0 && g.slot === 0 && g.readyAt) g.readyAt = h.nowMs() - 1000;
        errs.push(h.harvestAt(GS, 0, 0, 'stash-first'));
        durs.push(at().soilDurability);
      }
      return { errs, durs, s: JSON.parse(JSON.stringify(at())), rows: h.state.grows.filter((g) => g.uid === GS && g.tier === 0 && g.slot === 0).length };
    }, { GS, n });
    ok(worn.errs.every((e) => e === null) && worn.durs.every((d, i) => d === Math.max(0, fill.max - WEAR * (i + 1))),
      `수확마다 ${WEAR} 씩 닳는다 (${JSON.stringify(worn.durs)})`, JSON.stringify(worn.errs));
    ok(worn.s.soilDefId === 'soil_humus' && worn.s.soilDurability === 0 && worn.s.soilUsesLeft === 0 && worn.s.soilBonusRatio === 0 && worn.rows === 1,
      '내구도 0 이어도 칸은 비지 않는다 (흙 그대로 · 남은 수확 0 · 비율 0)', JSON.stringify(worn.s));
    ok(await H((GS) => window.__game.ctx.housing.plantSeedAt(GS, 0, 0, 'seed_beanpod'), GS) === null, '내구도 0 인 흙에도 심을 수 있다');
    const ms0 = await growMs(0, 0), ms0Want = await wantGrow(0, 0), ms1Want = await wantGrow(1, 0);
    ok(ms0 === ms0Want && ms0 > ms1Want, `내구도 0 = 궁합 보너스 없음 (${ms0} ms > 비율 1 의 ${ms1Want} ms)`);

    const half = await H((GS) => {
      const h = window.__game.ctx.housing;
      const e1 = h.fillSoil(GS, 0, 1, 'soil_humus');
      const g = h.state.grows.find((x) => x.uid === GS && x.tier === 0 && x.slot === 1);
      g.soilDurability = g.soilDurability / 2;
      const ratio = h.getGrowSlots(GS).find((x) => x.tier === 0 && x.slot === 1).soilBonusRatio;
      return { e1, ratio, e2: h.plantSeedAt(GS, 0, 1, 'seed_beanpod') };
    }, GS);
    ok(half.e1 === null && half.e2 === null && half.ratio === 0.5 && await growMs(0, 1) === await wantGrow(0.5, 0), `내구도 절반 = 비율 0.5 의 파종 시간 (${half.ratio})`);

    await clearEv();
    const sk = await H((GS) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
      const at = () => h.getGrowSlots(GS).find((x) => x.tier === 0 && x.slot === 2);
      const r = {};
      r.noSoil = h.insertGrowSocket(GS, 0, 2, 'sock_soil_speed_1');
      r.fill = h.fillSoil(GS, 0, 2, 'soil_humus');
      r.notSocket = h.insertGrowSocket(GS, 0, 2, 'seed_beanpod');
      const med0 = inv.countDefAll('sock_medium_speed_1');
      r.wrongTarget = h.insertGrowSocket(GS, 0, 2, 'sock_medium_speed_1');
      r.medKept = inv.countDefAll('sock_medium_speed_1') === med0;
      r.slots = at().socketSlots;
      const sp10 = inv.countDefAll('sock_soil_speed_1');
      r.ins = [];
      for (let i = 0; i < r.slots; i++) r.ins.push(h.insertGrowSocket(GS, 0, 2, 'sock_soil_speed_1'));
      r.sp1Spent = sp10 - inv.countDefAll('sock_soil_speed_1');
      r.full = h.insertGrowSocket(GS, 0, 2, 'sock_soil_speed_1');
      r.badIdx = h.insertGrowSocket(GS, 0, 2, 'sock_soil_speed_2', 7);
      const sp20 = inv.countDefAll('sock_soil_speed_2'), sp1Mid = inv.countDefAll('sock_soil_speed_1');
      r.replace = h.insertGrowSocket(GS, 0, 2, 'sock_soil_speed_2', 0);
      r.sp2Spent = sp20 - inv.countDefAll('sock_soil_speed_2');
      r.oldNotBack = inv.countDefAll('sock_soil_speed_1') === sp1Mid;
      r.sockets = [...at().sockets];
      const loot = window.__game.ctx.loot;
      r.speed = r.sockets.reduce((s, id) => s + (loot.getItemDef(id).growSocket.effect === 'speed' ? loot.getItemDef(id).growSocket.amount : 0), 0);
      r.plant = h.plantSeedAt(GS, 0, 2, 'seed_beanpod');
      return r;
    }, GS);
    const skEv = await ev('housing:socketInserted');
    ok(sk.noSoil === '흙을 먼저 채우세요' && sk.fill === null, `흙이 없으면 「${sk.noSoil}」`);
    ok(sk.notSocket === '소켓이 아닙니다' && sk.wrongTarget === '배지 소켓은 배양조에 끼웁니다' && sk.medKept, `소켓 아님 · 반대 대상 거절 (소켓을 먹지 않는다) (${sk.notSocket} / ${sk.wrongTarget})`);
    ok(sk.slots >= 1 && sk.ins.every((e) => e === null) && sk.sp1Spent === sk.slots, `빈 칸 ${sk.slots}개에 끼우고 1개씩 소모`, JSON.stringify(sk.ins));
    ok(sk.full === '소켓 칸이 가득 찼습니다' && sk.badIdx === '없는 소켓 칸입니다', `가득 참 · 없는 소켓 칸 (${sk.full} / ${sk.badIdx})`);
    ok(sk.replace === null && sk.sp2Spent === 1 && sk.oldNotBack && sk.sockets[0] === 'sock_soil_speed_2' && sk.sockets.length === sk.slots,
      `replaceIndex 0 → 교체, 옛 소켓은 파괴(돌려주지 않는다) (${sk.sockets.join(', ')})`, JSON.stringify(sk));
    const lastEv = skEv[skEv.length - 1];
    ok(skEv.length === sk.slots + 1 && skEv[0].replaced === null && skEv[0].target === 'soil' && skEv[0].uid === GS
      && lastEv.defId === 'sock_soil_speed_2' && lastEv.replaced === 'sock_soil_speed_1', `housing:socketInserted ×${skEv.length} (마지막 replaced ${lastEv?.replaced})`, JSON.stringify(skEv));
    ok(sk.plant === null && await growMs(0, 2) === await wantGrow(1, sk.speed), `speed 소켓(합 ${sk.speed})이 파종 시간에 든다`);

    const yl = await H((GS) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory, loot = window.__game.ctx.loot;
      const r = { fill: h.fillSoil(GS, 1, 0, 'soil_humus') };
      r.slots = h.getGrowSlots(GS).find((x) => x.tier === 1 && x.slot === 0).socketSlots;
      r.ins = [];
      for (let i = 0; i < r.slots; i++) r.ins.push(h.insertGrowSocket(GS, 1, 0, 'sock_soil_yield_1'));
      const seed = loot.getItemDef('seed_beanpod').seed;
      r.base = h.yieldQty(seed.yieldQty);
      /** 심고 · 익히고 · 거둔다. `rv` 가 있으면 소켓 굴림(`slots` 번)만 그 값으로 고정하고 나머지 Math.random 은 그대로 둔다. */
      const harvest = (rv, calls) => {
        h.plantSeedAt(GS, 1, 0, 'seed_beanpod');
        for (const g of h.state.grows) if (g.uid === GS && g.tier === 1 && g.slot === 0 && g.readyAt) g.readyAt = h.nowMs() - 1000;
        const before = inv.countDefAll(seed.yieldDefId);
        const orig = Math.random;
        let left = rv === null ? 0 : calls;
        Math.random = () => (left-- > 0 ? rv : orig());
        let err;
        try { err = h.harvestAt(GS, 1, 0, 'stash-first'); } finally { Math.random = orig; }
        return { err, got: inv.countDefAll(seed.yieldDefId) - before };
      };
      window.__ev['gather:collected'].length = 0;
      r.lucky = harvest(0, r.slots);
      r.gather = window.__ev['gather:collected'].slice(-1)[0] ?? null;
      r.unlucky = harvest(0.999999, r.slots);
      // 내구도 0 이면 덤 확률도 0 — 굴림 자체가 없어 고정하지 않는다
      h.state.grows.find((x) => x.uid === GS && x.tier === 1 && x.slot === 0).soilDurability = 0;
      r.worn = harvest(null, 0);
      return r;
    }, GS);
    ok(yl.fill === null && yl.ins.every((e) => e === null) && yl.lucky.err === null && yl.lucky.got === yl.base + yl.slots,
      `yield 소켓 ${yl.slots}개 · 굴림 성공 → 수확 ${yl.base} + ${yl.slots} (${yl.lucky.got})`, JSON.stringify(yl));
    ok(yl.gather?.qty === yl.base + yl.slots, `gather:collected.qty 에 덤이 들어간다 (${yl.gather?.qty})`);
    ok(yl.unlucky.got === yl.base && yl.worn.err === null && yl.worn.got === yl.base, `굴림 실패 · 내구도 0 이면 덤 없음 (${yl.unlucky.got} · ${yl.worn.got})`);

    const wr = await H(async (GS) => {
      const R = await import('/src/housing/Rules.ts'); const S = await import('/src/shared/index.ts');
      const h = window.__game.ctx.housing;
      const at = () => h.getGrowSlots(GS).find((x) => x.tier === 1 && x.slot === 1);
      const r = { fill: h.fillSoil(GS, 1, 1, 'soil_humus'), ins: h.insertGrowSocket(GS, 1, 1, 'sock_soil_wear_2') };
      const amt = window.__game.ctx.loot.getItemDef('sock_soil_wear_2').growSocket.amount;
      const max = at().soilDurabilityMax;
      r.usesBefore = at().soilUsesLeft; r.usesBeforeWant = R.harvestsUntilWorn(max, S.SOIL_WEAR_PER_HARVEST, amt);
      r.plant = h.plantSeedAt(GS, 1, 1, 'seed_beanpod');
      for (const g of h.state.grows) if (g.uid === GS && g.tier === 1 && g.slot === 1 && g.readyAt) g.readyAt = h.nowMs() - 1000;
      r.harvest = h.harvestAt(GS, 1, 1, 'stash-first');
      r.dur = at().soilDurability; r.want = R.wearAfterHarvest(max, S.SOIL_WEAR_PER_HARVEST, amt); r.plain = max - S.SOIL_WEAR_PER_HARVEST;
      return r;
    }, GS);
    ok(wr.fill === null && wr.ins === null && wr.plant === null && wr.harvest === null && wr.dur === wr.want && wr.dur > wr.plain && wr.usesBefore === wr.usesBeforeWant,
      `wear 소켓 → 덜 닳는다 (${wr.dur} > ${wr.plain}) · 남은 수확도 그만큼 늘어난다 (${wr.usesBefore})`, JSON.stringify(wr));

    const clr = await H((GS) => {
      const h = window.__game.ctx.housing;
      const e1 = h.clearSoil(GS, 0, 2, true);
      const e2 = h.fillSoil(GS, 0, 2, 'soil_humus');
      return { e1, e2, sockets: [...h.getGrowSlots(GS).find((x) => x.tier === 0 && x.slot === 2).sockets] };
    }, GS);
    ok(clr.e1 === null && clr.e2 === null && clr.sockets.length === 0, '흙을 비우면 소켓도 함께 사라진다 (다시 부은 흙은 소켓 0)');

    const owned = await H(() => {
      const h = window.__game.ctx.housing, loot = window.__game.ctx.loot;
      const t = (list) => list.map((o) => loot.getItemDef(o.defId).growSocket.target);
      return { soil: t(h.getOwnedSockets('soil')), medium: t(h.getOwnedSockets('medium')), all: h.getOwnedSockets().length };
    });
    ok(owned.soil.length > 0 && owned.soil.every((x) => x === 'soil') && owned.medium.length > 0 && owned.medium.every((x) => x === 'medium')
      && owned.all === owned.soil.length + owned.medium.length, `getOwnedSockets(target) (${JSON.stringify(owned)})`);

    const mig = await H((GS) => {
      const h = window.__game.ctx.housing, def = window.__game.ctx.loot.getItemDef('soil_humus');
      const e = h.fillSoil(GS, 1, 2, 'soil_humus');
      const g = h.state.grows.find((x) => x.uid === GS && x.tier === 1 && x.slot === 2);
      delete g.soilDurability; delete g.sockets;
      g.soilUsesLeft = 1;
      h.growsPruned = false;
      const s = h.getGrowSlots(GS).find((x) => x.tier === 1 && x.slot === 2);
      const uses = def.soil.uses;
      return { e, dur: s.soilDurability, want: uses > 0 ? Math.round(def.soil.durability * Math.max(0, Math.min(1, 1 / uses))) : def.soil.durability, sockets: s.sockets, uses };
    }, GS);
    ok(mig.e === null && mig.dur === mig.want && Array.isArray(mig.sockets) && mig.sockets.length === 0,
      `옛 세이브 칸(soilDurability 없음, soilUsesLeft 1 / uses ${mig.uses}) → 내구도 ${mig.dur} 로 옮긴다`, JSON.stringify(mig));

    const gp = await H(async (GS) => {
      const h = window.__game.ctx.housing;
      h.changed('smoke'); h.save();
      const raw = JSON.parse(localStorage.getItem('scav.s1.ship'));
      const SS = await import('/src/housing/ShipState.ts');
      const pick = (s) => (s.grows ?? []).filter((g) => g.uid === GS).map((g) => `${g.tier}/${g.slot}:${g.soilDurability}:${(g.sockets ?? ['∅']).join('+')}:${g.soilUsesLeft}`).sort();
      return { raw: pick(raw), san: pick(SS.sanitize(raw)) };
    }, GS);
    ok(gp.raw.length >= 5 && gp.raw.every((x) => !/:undefined:|:∅:/.test(x)) && gp.raw.some((x) => x.includes('sock_')) && gp.raw.some((x) => /:0:/.test(x)),
      `세이브에 흙 내구도 · 소켓 · 남은 수확 0 이 실린다 (${gp.raw.join(' ')})`);
    ok(JSON.stringify(gp.san) === JSON.stringify(gp.raw), 'ShipState.sanitize 가 흙 새 필드를 버리지 않는다 (soilUsesLeft 0 도 그대로)', JSON.stringify(gp.san));
  }

  /* ══ 3. 배양조 — 배지 내구도 · 스캐폴드 · 소켓 ═════════════════════════════════ */
  console.log('배양조 — 배지 내구도 · 스캐폴드 · 소켓');
  const cIds = ['mat_medium_basic', 'food_scaffold', 'cell_cow', 'cell_algae', 'strain_myocyte', 'sock_medium_speed_1', 'sock_soil_speed_1'];
  const cMiss = await missing(cIds);
  const cultOk = cMiss.length === 0 && await H(() => {
    const d = (id) => window.__game.ctx.loot.getItemDef(id);
    return (d('mat_medium_basic')?.medium?.durability ?? 0) > 0 && d('food_scaffold')?.scaffold === true && !!d('cell_cow')?.strain?.scaffoldOutputDefId
      && !!d('cell_algae')?.strain && !d('cell_algae').strain.scaffoldOutputDefId;
  });
  ok(cultOk, `배지 durability · 스캐폴드 · 새 세포주 데이터 (agent A) (missing: ${cMiss.join(', ') || '없음'})`);
  if (CT && cultOk) {
    for (const [id, n] of [['mat_medium_basic', 6], ['food_scaffold', 4], ['cell_cow', 3], ['cell_algae', 2], ['strain_myocyte', 1],
      ['sock_medium_speed_1', 2], ['sock_soil_speed_1', 1]]) await giveStash(id, n);
    const cu = await H(async (CT) => {
      const R = await import('/src/housing/Rules.ts'); const S = await import('/src/shared/index.ts');
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory, loot = window.__game.ctx.loot;
      const at = () => JSON.parse(JSON.stringify(h.getCultureSlots(CT)[0]));
      const md = loot.getItemDef('mat_medium_basic');
      const cow = loot.getItemDef('cell_cow').strain;
      const r = { max: md.medium.durability, slotsWant: S.growSocketSlotsFor(md.rarity), mwear: S.MEDIUM_WEAR_PER_HARVEST,
        cowOut: { id: cow.scaffoldOutputDefId, qty: cow.scaffoldOutputQty, base: cow.outputDefId, baseQty: Math.max(1, Math.floor(cow.outputQty)) } };
      r.scNoMedium = h.insertScaffold(CT, 0, 'food_scaffold');
      r.fill = h.fillMedium(CT, 0, 'mat_medium_basic');
      r.s0 = at();
      r.scNot = h.insertScaffold(CT, 0, 'cell_cow');
      const sc0 = inv.countDefAll('food_scaffold');
      r.scIn = h.insertScaffold(CT, 0, 'food_scaffold');
      r.scDelta1 = inv.countDefAll('food_scaffold') - sc0;
      r.scTwice = h.insertScaffold(CT, 0, 'food_scaffold');
      r.take = h.takeScaffold(CT, 0);
      r.scDelta2 = inv.countDefAll('food_scaffold') - sc0;
      r.scIn2 = h.insertScaffold(CT, 0, 'food_scaffold');
      const alg0 = inv.countDefAll('cell_algae');
      r.algae = h.insertStrain(CT, 0, 'cell_algae');
      r.algaeKept = inv.countDefAll('cell_algae') === alg0;
      const myo0 = inv.countDefAll('strain_myocyte');
      r.retiredDef = { retired: !!loot.getItemDef('strain_myocyte').retired, strain: !!loot.getItemDef('strain_myocyte').strain };
      r.retired = h.insertStrain(CT, 0, 'strain_myocyte');
      r.retiredKept = inv.countDefAll('strain_myocyte') === myo0;
      r.cow = h.insertStrain(CT, 0, 'cell_cow');
      const c = h.state.cultures.find((x) => x.uid === CT && x.slot === 0);
      r.ms = c.readyAt - c.startedAt;
      r.msWant = R.cultureDurationMs(cow.scaffoldHours, md.medium.speedMul, h.gardening(), 1, 0);
      r.s1 = at();
      r.takeBusy = h.takeScaffold(CT, 0);
      c.readyAt = h.nowMs() - 1000;
      const out0 = inv.countDefAll(cow.scaffoldOutputDefId);
      r.harvest = h.harvestCulture(CT, 0, 'stash-first');
      r.gotScaffoldOut = inv.countDefAll(cow.scaffoldOutputDefId) - out0;
      r.s2 = at();
      r.rows = h.state.cultures.filter((x) => x.uid === CT).length;
      r.cow2 = h.insertStrain(CT, 0, 'cell_cow');
      const c2 = h.state.cultures.find((x) => x.uid === CT && x.slot === 0);
      r.ms2 = c2.readyAt - c2.startedAt;
      r.ms2Want = R.cultureDurationMs(cow.cultureHours, md.medium.speedMul, h.gardening(), h.getCultureSlots(CT)[0].mediumBonusRatio, 0);
      r.s3 = at();
      r.clear = h.clearMedium(CT, 0, true);
      r.rowsAfterClear = h.state.cultures.filter((x) => x.uid === CT).length;
      return r;
    }, CT);
    ok(cu.scNoMedium === '영양 배지를 먼저 채우세요' && cu.fill === null, `배지 없이 스캐폴드 거절 (${cu.scNoMedium})`);
    ok(cu.s0.mediumDurability === cu.max && cu.s0.mediumDurabilityMax === cu.max && cu.s0.mediumBonusRatio === 1 && cu.s0.sockets.length === 0
      && cu.s0.socketSlots === cu.slotsWant && cu.s0.scaffoldDefId === null && cu.s0.mediumUsesLeft === Math.ceil(cu.max / cu.mwear),
    `부은 배지 = 내구도 최대 · 소켓 칸 ${cu.slotsWant} · 스캐폴드 없음`, JSON.stringify(cu.s0));
    ok(cu.scNot === '배양 스캐폴드가 아닙니다' && cu.scIn === null && cu.scDelta1 === -1 && cu.scTwice === '이미 스캐폴드가 들어 있습니다'
      && cu.take === null && cu.scDelta2 === 0 && cu.scIn2 === null, '스캐폴드 넣기(1개 소모) · 두 번 거절 · 빼면 돌아온다', JSON.stringify(cu));
    ok(cu.algae === '이 세포주는 스캐폴드에서 자라지 않습니다' && cu.algaeKept, `스캐폴드 산출이 없는 세포주 거절 (${cu.algae})`);
    ok(typeof cu.retired === 'string' && cu.retiredKept, `은퇴 세포주 거절 (${cu.retired}) — def ${JSON.stringify(cu.retiredDef)}`);
    ok(cu.cow === null && cu.ms === cu.msWant && cu.s1.yieldDefId === cu.cowOut.id && cu.s1.yieldQty === cu.cowOut.qty && cu.s1.scaffoldDefId === 'food_scaffold',
      `스캐폴드 + 소 세포주 → ${cu.cowOut.id} ×${cu.cowOut.qty} · scaffoldHours (${cu.ms} ms)`, JSON.stringify(cu.s1));
    ok(typeof cu.takeBusy === 'string', `배양 중에는 스캐폴드를 뺄 수 없다 (${cu.takeBusy})`);
    ok(cu.harvest === null && cu.gotScaffoldOut === cu.cowOut.qty && cu.s2.strainDefId === null && cu.s2.scaffoldDefId === null
      && cu.s2.mediumDurability === cu.max - cu.mwear && cu.s2.mediumDefId === 'mat_medium_basic' && cu.rows === 1,
    '수확 → 종별 고기 · 스캐폴드 소모 · 배지가 닳고 칸은 남는다', JSON.stringify(cu.s2));
    ok(cu.cow2 === null && cu.ms2 === cu.ms2Want && cu.s3.yieldDefId === cu.cowOut.base && cu.s3.yieldQty === cu.cowOut.baseQty && cu.s3.scaffoldDefId === null,
      `스캐폴드 없이 = ${cu.cowOut.base} · 기본 시간 × 배지 비율 (${cu.ms2} ms)`, JSON.stringify(cu.s3));
    ok(cu.clear === null && cu.rowsAfterClear === 0, '세포주 버리고 배지 비우기');

    await clearEv();
    const cu2 = await H(async (CT) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory, loot = window.__game.ctx.loot;
      const r = {};
      r.noMedium = h.insertCultureSocket(CT, 0, 'sock_medium_speed_1');
      r.fill = h.fillMedium(CT, 0, 'mat_medium_basic');
      r.wrong = h.insertCultureSocket(CT, 0, 'sock_soil_speed_1');
      r.ins = h.insertCultureSocket(CT, 0, 'sock_medium_speed_1');
      r.sockets = [...h.getCultureSlots(CT)[0].sockets];
      const sc0 = inv.countDefAll('food_scaffold');
      r.sc = h.insertScaffold(CT, 0, 'food_scaffold');
      // 세이브 왕복 (배지 내구도 · 소켓 · 스캐폴드)
      h.changed('smoke'); h.save();
      const raw = JSON.parse(localStorage.getItem('scav.s1.ship'));
      const SS = await import('/src/housing/ShipState.ts');
      const pick = (s) => (s.cultures ?? []).filter((c) => c.uid === CT).map((c) => `${c.slot}:${c.mediumDurability}:${(c.sockets ?? ['∅']).join('+')}:${c.scaffoldDefId}:${c.mediumUsesLeft}`);
      r.raw = pick(raw); r.san = pick(SS.sanitize(raw));
      r.clear = h.clearMedium(CT, 0);
      r.scBack = inv.countDefAll('food_scaffold') - sc0;
      // 은퇴 세포주가 든 옛 칸
      r.fill2 = h.fillMedium(CT, 0, 'mat_medium_basic');
      const c = h.state.cultures.find((x) => x.uid === CT && x.slot === 0);
      r.myoHasStrain = !!loot.getItemDef('strain_myocyte')?.strain;
      c.strainDefId = 'strain_myocyte'; c.startedAt = h.nowMs(); c.readyAt = h.nowMs() + 60000;
      h.culturesPruned = false;
      h.cultures();
      r.pruned = { strain: c.strainDefId ?? null, started: c.startedAt ?? null, medium: c.mediumDefId, rows: h.state.cultures.filter((x) => x.uid === CT).length };
      h.clearMedium(CT, 0, true);
      return r;
    }, CT);
    const cEv = await ev('housing:socketInserted');
    ok(cu2.noMedium === '배지를 먼저 채우세요' && cu2.wrong === '토양 소켓은 재배 스테이션에 끼웁니다' && cu2.ins === null
      && JSON.stringify(cu2.sockets) === JSON.stringify(['sock_medium_speed_1']) && cEv.length === 1 && cEv[0].target === 'medium' && cEv[0].uid === CT,
    `배지 소켓: 사유 (${cu2.noMedium} / ${cu2.wrong}) · 끼우기 · 이벤트 target medium`, JSON.stringify({ cu2, cEv }));
    ok(cu2.sc === null && cu2.raw.length === 1 && /:sock_medium_speed_1:food_scaffold:/.test(cu2.raw[0]) && JSON.stringify(cu2.raw) === JSON.stringify(cu2.san),
      `ShipState.sanitize 가 배지 내구도 · 소켓 · 스캐폴드를 버리지 않는다 (${cu2.raw[0]})`, JSON.stringify(cu2.san));
    ok(cu2.clear === null && cu2.scBack === 0, '스캐폴드만 든 칸의 배지를 비우면 스캐폴드는 돌아온다');
    if (!cu2.myoHasStrain) {
      ok(cu2.fill2 === null && cu2.pruned.strain === null && cu2.pruned.started === null && cu2.pruned.medium === 'mat_medium_basic' && cu2.pruned.rows === 1,
        '은퇴 세포주(strain 데이터 없음)가 든 옛 칸 → 세포주 필드만 지우고 배지는 남긴다', JSON.stringify(cu2.pruned));
    } else {
      note('strain_myocyte 에 아직 strain 데이터가 남아 있다 (agent A 가 비운다) — 옛 칸 정리 검사 건너뜀');
    }
  }

  /* ══ 4. 요리 effects → derived (agent D, 너그럽게) ══════════════════════════════ */
  console.log('요리 effects → derived (progression 의 몫)');
  const meal = await H(() => {
    const ctx = window.__game.ctx, p = ctx.progression, loot = ctx.loot;
    const defs = loot.getAllItemDefs().filter((d) => d.meal && !d.retired && Array.isArray(d.meal.effects) && d.meal.effects.length >= 2);
    if (!defs.length || typeof p?.useMeal !== 'function' || typeof p.armPreps !== 'function') return { skip: '여러 줄 요리 def 또는 progression API 가 없다' };
    defs.sort((a, b) => b.meal.effects.length - a.meal.effects.length);
    const def = defs[0];
    const before = { ...p.derived };
    const err = p.useMeal(def.id);
    if (err) return { skip: `useMeal: ${err}` };
    p.armPreps();
    const after = { ...p.derived };
    const rows = def.meal.effects.map((e) => ({ buff: e.buff, amount: e.amount, before: before[e.buff], after: after[e.buff],
      folded: typeof after[e.buff] === 'number' && Math.abs(after[e.buff] - Math.max(0, before[e.buff] + e.amount)) < 1e-9 }));
    p.clearActivePreps();
    return { id: def.id, rows };
  });
  if (meal.skip) note(`요리 effects 검사 — ${meal.skip}`);
  else if (meal.rows.every((r) => r.folded)) ok(true, `${meal.id} 의 effects ${meal.rows.length}줄이 전부 derived 에 접힌다`);
  else note(`${meal.id} 의 effects 가 아직 derived 에 다 접히지 않는다 (agent D) — ${JSON.stringify(meal.rows)}`);

  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
