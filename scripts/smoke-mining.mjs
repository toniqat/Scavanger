// Single-player smoke test for **암호화폐 채굴 — housing 규칙 · 지갑 · 거래소 · 데이터** (2026-09-13, docs/plans/power-crypto.md, agent ③).
// 화면(housing/ui/mining)은 이 스모크의 몫이 아니다 — 여기서는 `ctx.housing` API · `state` · 세이브 · `ctx.meta.creditsTx` · 데이터만 본다:
//   0. 순수 규칙 — `coinCycleMs` 가 코어마다 절반, `MiningRules.takeCompletedCycles` / `foldProgress` / `sanitizeClusters`(코어 클램프 ·
//      진행도 [0,1) · 구간 시작 · 코인 id 모양 · 중복 uid · 배치되지 않은 uid 의 코어 = orphanCores) / `sanitizeUnitsMap`.
//   1. 데이터 — 프로세서 · 연산 코어 def(전설), 가공 작업대 레시피, 상자 티어 배수(프로세서 T4 · T5 만, 코어 0), 안드로이드 시체 줄.
//   2. 채굴 시설 — 방 용도 mining · 메인 컴퓨터 1 + 클러스터 2 제작 · 배치(클러스터는 `multi` 라 두 번째도 제작, 컴퓨터는 「이미 보유 중」),
//      2026-09-13 전력 할당 폐지 — 전력 API 가 없고 메인 컴퓨터가 있으면 `furnitureOperationalBlock` 은 null.
//   3. 클러스터 — 코인 미지정 사유, 잠긴 코인 거절(`<기업> 퀘스트 「…」 완료 필요`), 코어 없음 사유, 코어 넣기(가방 → 창고 소모) · 주기가 코어마다
//      절반, 가짜 시간(구간 시작을 되돌림) → 틱이 끝난 주기를 한 번에 넣음(`housing:cryptoMined` 1건 · `walletChanged mined` · 진행도 소수 부분 유지),
//      코어 수 변경 = 끝난 주기 넣고 진행도 접기, 멈춘 시계 없음(`stationNow` = `nowMs`) · 메인 컴퓨터 회수 = 사유 + 채굴 안 함(끝난 주기를
//      넣지 않고 구간만 지금으로) → 다시 놓으면 그 자리에서 이어감, 코인 변경 = 진행도 0, 퀘스트 완료(가짜) 뒤 잠긴 코인 허용,
//      코어 빼기(가방 · 창고로), 코어가 꽂힌 클러스터 회수 거절(`코어를 먼저 빼세요`) → 빼면 회수 · 칸 지움, `devAdvanceMining`.
//   4. 거래소 — 서버 없음 = `서버에 연결되어야 합니다`, 시세 스텁 → 매도(크레딧 +floor(가격 × 코인 × (1 − 수수료)) · 지갑 −) · 매수(올림 · 지갑 +) ·
//      잔고 부족 · 크레딧 부족 · 최대 단위 · 잠긴 코인 · 서버 거절이면 지갑 복구 · `creditsTx` 로컬 거절, 콘솔 `crypto wallet`.
//   5. 세이브 — `sanitize` 왕복(클러스터 · 지갑 · 누적 채굴 그대로), 배치되지 않은 클러스터의 코어 → `out.refund`, localStorage 에 적힌 것도 같다.
// Usage: node scripts/smoke-mining.mjs [http://localhost:5273/]   (needs `npm run dev`)
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
const near = (a, b, eps) => Math.abs(a - b) <= eps;
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
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
  await page.evaluate(() => { for (const k of ['scav.s1.ship', 'scav.s1.stash', 'scav.s1.grant', 'scav.s1.meta']) localStorage.removeItem(k); });
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot && !!window.__game.ctx.meta, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    window.__ev = {};
    for (const n of ['housing:cryptoMined', 'housing:walletChanged', 'housing:clusterChanged', 'housing:changed']) {
      window.__ev[n] = [];
      window.__game.ctx.bus.on(n, (p) => window.__ev[n].push(JSON.parse(JSON.stringify(p))));
    }
  });
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await H(() => { const st = window.__game.getSystem('inventory').getStash(); for (const p of st.items()) st.remove(p.item.uid); });

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
  const slot = (uid) => H((u) => { const s = window.__game.ctx.housing.state.clusters?.find((x) => x.uid === u); return s ? JSON.parse(JSON.stringify(s)) : null; }, uid);
  const walletOf = (coin) => H((c) => window.__game.ctx.housing.getCryptoWallet()[c] ?? 0, coin);

  /* ══ 0. 순수 규칙 ══════════════════════════════════════════════════════════ */
  console.log('순수 규칙');
  const pure = await H(async () => {
    const R = await import('/src/housing/MiningRules.ts');
    const S = await import('/src/shared/index.ts');
    const o = {};
    const scrap = S.CRYPTO_COIN_MAP.get('scrap');
    o.cycles = [1, 2, 3, 9].map((n) => S.coinCycleMs(scrap, n));
    o.cycle0 = S.coinCycleMs(scrap, 0) === Infinity;   // Infinity 는 page.evaluate 직렬화를 못 지난다 — 여기서 비교한다
    o.base = scrap.cycleHours * 3600e3;
    const s1 = { uid: 'f-1', cores: 1, progress: 0.25, segmentAt: 1000 };
    o.take = [R.takeCompletedCycles(s1, 1000, 3750), s1.progress, s1.segmentAt, R.takeCompletedCycles(s1, 1000, 4000), s1.progress];
    const s2 = { uid: 'f-1', cores: 2, progress: 0.1, segmentAt: 0 };
    R.foldProgress(s2, 1000, 400);
    o.fold = [s2.progress, s2.segmentAt];
    const s3 = { uid: 'f-1', cores: 0, progress: 0.3, segmentAt: 0 };
    R.foldProgress(s3, Infinity, 999);
    o.foldInf = [s3.progress, s3.segmentAt];
    const san = R.sanitizeClusters([
      { uid: 'f-1', cores: 12, progress: 5, segmentAt: 'x', coinId: 'BAD!' },
      { uid: 'f-1', cores: 3, coinId: 'volt' },
      { uid: 'f-9', cores: 4, coinId: 'scrap' },
      { uid: 'f-2', cores: 0, progress: 0.5, segmentAt: 5 },
      { uid: 'f-3', cores: 2.7, progress: -1, segmentAt: 42, coinId: 'volt' },
      null, 'junk',
    ], new Set(['f-1', 'f-2', 'f-3']), 9, 777);
    o.san = san;
    o.units = R.sanitizeUnitsMap({ scrap: 12.9, volt: -3, 'Bad-Key': 5, pulse: 'x', void: 0, helix: Infinity });
    return o;
  });
  ok(pure.cycles[0] === pure.base && pure.cycles[1] === pure.base / 2 && pure.cycles[2] === pure.base / 4 && pure.cycles[3] === pure.base / 256,
    'coinCycleMs — 코어 1 = 기준 · 2 = 50 % · 3 = 25 % · 9 = 1/256', JSON.stringify(pure.cycles));
  ok(pure.cycle0 === true, 'coinCycleMs — 코어 0 = Infinity');
  ok(pure.take[0] === 3 && near(pure.take[1], 0, 1e-9) && pure.take[2] === 3750 && pure.take[3] === 0 && near(pure.take[4], 0, 1e-9),
    'takeCompletedCycles — 끝난 주기 3 · 소수 부분 · 새 구간, 다시 부르면 0 (구간은 그대로)', JSON.stringify(pure.take));
  ok(near(pure.fold[0], 0.5, 1e-9) && pure.fold[1] === 400 && pure.foldInf[0] === 0.3 && pure.foldInf[1] === 999,
    'foldProgress — 옛 주기로 접고 새 구간 · 주기 없으면 진행도 그대로', JSON.stringify([pure.fold, pure.foldInf]));
  const sc = pure.san.clusters;
  ok(sc.length === 2 && sc[0].uid === 'f-1' && sc[0].cores === 9 && sc[0].progress < 1 && sc[0].segmentAt === 777 && !('coinId' in sc[0])
    && sc[1].uid === 'f-3' && sc[1].cores === 2 && sc[1].progress === 0 && sc[1].segmentAt === 42 && sc[1].coinId === 'volt',
  'sanitizeClusters — 코어 클램프 · 진행도 [0,1) · 구간 시작 · 코인 모양 · 중복 uid 버림 · 빈 칸 버림', JSON.stringify(sc));
  ok(pure.san.orphanCores === 4, 'sanitizeClusters — 배치되지 않은 클러스터의 코어 = orphanCores 4', String(pure.san.orphanCores));
  ok(JSON.stringify(pure.units) === JSON.stringify({ scrap: 12 }), 'sanitizeUnitsMap — id 모양 키 · 정수 ≥ 1 만', JSON.stringify(pure.units));

  /* ══ 1. 데이터 ═══════════════════════════════════════════════════════════ */
  console.log('데이터');
  const data = await H(async () => {
    const ctx = window.__game.ctx;
    const LT = await import('/src/items/LootTables.ts');
    const p = ctx.loot.getItemDef('mat_processor'), c = ctx.loot.getItemDef('mat_compute_core');
    const rec = ctx.loot.getAllRecipes().find((r) => r.outputDefId === 'mat_compute_core');
    const mul = (t, id) => LT.getTierTable(t).itemWeightMul?.[id];
    const android = LT.CORPSE_TABLE_MAP?.get?.('android');
    return {
      p: p && { rarity: p.rarity, cat: p.category, w: p.width, h: p.height, stack: p.stackMax, value: p.value },
      c: c && { rarity: c.rarity, cat: c.category, stack: c.stackMax },
      rec: rec && { station: rec.station, bench: rec.bench, inputs: rec.inputs },
      procMul: [1, 2, 3, 4, 5].map((t) => mul(t, 'mat_processor')),
      coreMul: [1, 2, 3, 4, 5].map((t) => mul(t, 'mat_compute_core')),
      android: android ? JSON.stringify(android).includes('mat_processor') : null,
    };
  });
  ok(data.p && data.p.rarity === 'legendary' && data.p.cat === 'material' && data.p.w === 1 && data.p.h === 1 && data.p.stack <= 3 && data.p.value > 0,
    '프로세서 def — 전설 재료 1×1 · 작은 스택', JSON.stringify(data.p));
  ok(data.c && data.c.cat === 'material' && data.c.stack >= 1, '연산 코어 def', JSON.stringify(data.c));
  ok(data.rec && data.rec.bench === 'refine' && data.rec.station === 'ship'
    && data.rec.inputs.some((i) => i.defId === 'mat_processor') && data.rec.inputs.some((i) => i.defId === 'mat_circuit'),
  '연산 코어 레시피 — 가공 작업대 · 회로 기판 + 프로세서', JSON.stringify(data.rec));
  ok(data.procMul[0] === 0 && data.procMul[1] === 0 && data.procMul[2] === 0 && data.procMul[3] > 0 && data.procMul[4] > 0,
    '상자 배수 — 프로세서는 티어 4 · 5 에서만', JSON.stringify(data.procMul));
  ok(data.coreMul.every((m) => m === 0), '상자 배수 — 연산 코어는 모든 티어 0', JSON.stringify(data.coreMul));
  if (data.android === null) note('안드로이드 시체 표를 찾지 못했다 (CORPSE_TABLE_MAP)');
  else ok(data.android, '안드로이드 시체 표에 프로세서 줄');

  /* ══ 2. 채굴 시설 ═════════════════════════════════════════════════════════ */
  console.log('채굴 시설');
  for (const [id, n] of [['mat_scrap', 40], ['mat_cable', 30], ['mat_circuit', 30], ['mat_alloy', 30]]) await giveStash(id, n);
  const ROOM = 3;
  // 채굴 시설은 발전기 Lv.5 (2026-09-13 최대) — 게이트는 smoke-housing 의 몫이라 상태로 올린다
  await H((room) => { const h = window.__game.ctx.housing; h.state.generatorLevel = 5; h.state.rooms[room].purpose = 'mining'; h.state.rooms[room].level = 1; }, ROOM);
  const placeFurn = (room, defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    if (!h.craftFurniture(defId)) return { err: `craft: ${h.furnitureCraftBlock?.(defId) ?? '?'}` };
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return { err: 'no spot' };
    const p = h.place(room, defId, spot.x, spot.y, spot.yaw);
    return p ? { uid: p.uid } : { err: 'place refused' };
  }, { room, defId });
  const pc = await placeFurn(ROOM, 'furn_mining_computer');
  const c1 = await placeFurn(ROOM, 'furn_compute_cluster');
  const c2 = await placeFurn(ROOM, 'furn_compute_cluster');
  ok(pc.uid && c1.uid && c2.uid, '메인 컴퓨터 1 + 연산 클러스터 2 제작 · 배치 (클러스터는 multi)', JSON.stringify({ pc, c1, c2 }));
  if (!(pc.uid && c1.uid && c2.uid)) throw new Error('채굴 시설을 짓지 못했다');
  const C1 = c1.uid, C2 = c2.uid;
  const blocks = await H(() => { const h = window.__game.ctx.housing; return [h.furnitureCraftBlock('furn_mining_computer'), h.furnitureCraftBlock('furn_compute_cluster'), h.getMiningComputerUid()]; });
  ok(blocks[0] === '이미 보유 중입니다' && blocks[1] !== '이미 보유 중입니다' && blocks[2] === pc.uid,
    '제작 잠금 — 메인 컴퓨터는 「이미 보유 중」, 클러스터는 아니다 · getMiningComputerUid', JSON.stringify(blocks));
  // 2026-09-13 (전력 할당 폐지): 할당할 것이 없다 — 메인 컴퓨터가 놓여 있으면 어떤 채굴 가구에도 가동 사유가 없다
  const opBlock = await H(({ c1, c2, pc }) => {
    const h = window.__game.ctx.housing;
    return { c1: h.furnitureOperationalBlock(c1), c2: h.furnitureOperationalBlock(c2), pc: h.furnitureOperationalBlock(pc),
      powerApi: ['getPowerOverview', 'getFacilityPower', 'setPowerAllocation', 'isFurnitureDisabled', 'setFurnitureDisabled'].filter((k) => typeof h[k] === 'function') };
  }, { c1: C1, c2: C2, pc: pc.uid });
  ok(opBlock.c1 === null && opBlock.c2 === null && opBlock.pc === null && opBlock.powerApi.length === 0,
    '전력 할당 없음 — 메인 컴퓨터가 있으면 furnitureOperationalBlock 은 null · 전력 API 없음', JSON.stringify(opBlock));

  /* ══ 3. 클러스터 ═════════════════════════════════════════════════════════ */
  console.log('클러스터');
  const list0 = await H(() => window.__game.ctx.housing.getComputeClusters());
  ok(list0.length === 2 && list0.every((c) => c.coinId === null && c.cores === 0 && !c.mining && c.block === '채굴할 코인을 정하세요' && c.maxCores === 9),
    'getComputeClusters — 두 대 · 코인 미지정 사유', JSON.stringify(list0));
  const coins = await H(() => window.__game.ctx.housing.getCryptoCoins().map((c) => ({ id: c.def.id, unlocked: c.unlocked, lock: c.lockReason, price: c.price })));
  ok(coins.length === 8 && coins.filter((c) => c.unlocked).length === 4 && coins.every((c) => c.price === null),
    'getCryptoCoins — 8종 · 4종 열림 · 서버 없음 = 시세 null', JSON.stringify(coins.map((c) => [c.id, c.unlocked])));
  const nomadLock = coins.find((c) => c.id === 'nomad')?.lock ?? '';
  ok(/^노마드.* 퀘스트 「.+」 완료 필요$/.test(nomadLock), '잠긴 코인 사유 — `<기업> 퀘스트 「…」 완료 필요`', nomadLock);
  const lockedSet = await H((u) => window.__game.ctx.housing.setClusterCoin(u, 'nomad'), C1);
  ok(lockedSet === nomadLock, '잠긴 코인은 지정 거절', String(lockedSet));
  const unknownSet = await H((u) => window.__game.ctx.housing.setClusterCoin(u, 'nope'), C1);
  ok(unknownSet === '알 수 없는 코인입니다', '모르는 코인 거절', String(unknownSet));
  await clearEv();
  const setScrap = await H((u) => window.__game.ctx.housing.setClusterCoin(u, 'scrap'), C1);
  const info1 = await H((u) => window.__game.ctx.housing.getComputeCluster(u), C1);
  const evSet = await ev('housing:clusterChanged');
  const chSet = await ev('housing:changed');
  ok(setScrap === null && info1.coinId === 'scrap' && info1.block === '연산 코어를 꽂으세요' && evSet.some((e) => e.uid === C1) && chSet.length > 0,
    '코인 지정 → 코어 없음 사유 · housing:clusterChanged · housing:changed', JSON.stringify({ setScrap, info1, evSet, ch: chSet.length }));
  const noCore = await H((u) => window.__game.ctx.housing.insertClusterCores(u, 1), C1);
  ok(typeof noCore === 'string' && noCore.includes('없습니다'), '코어가 없으면 넣기 거절', String(noCore));
  ok(await giveStash('mat_compute_core', 6) === 6, '연산 코어 6 지급');
  const count = () => H(() => window.__game.ctx.inventory.countDefAll('mat_compute_core'));
  const cyc = [];
  for (const n of [1, 1, 1]) {
    const r = await H(({ u, n }) => window.__game.ctx.housing.insertClusterCores(u, n), { u: C1, n });
    const i = await H((u) => window.__game.ctx.housing.getComputeCluster(u), C1);
    cyc.push({ r, cores: i.cores, cycle: i.cycleMs });
  }
  ok(cyc.every((c) => c.r === null) && cyc.map((c) => c.cores).join() === '1,2,3' && cyc[1].cycle === cyc[0].cycle / 2 && cyc[2].cycle === cyc[0].cycle / 4
    && cyc[0].cycle === pure.base, '코어 넣기 1 → 2 → 3 — 주기 100 % · 50 % · 25 %', JSON.stringify(cyc));
  ok(await count() === 3, '넣은 코어만큼 가방 · 창고에서 빠짐 (6 → 3)');
  const over = await H((u) => window.__game.ctx.housing.insertClusterCores(u, 99), C1);
  const afterOver = await H((u) => window.__game.ctx.housing.getComputeCluster(u).cores, C1);
  ok(over === null && afterOver === 6 && await count() === 0, '많이 넣으면 가진 만큼만 (3 + 3 = 6)', JSON.stringify({ over, afterOver }));
  const miningNow = await H((u) => window.__game.ctx.housing.getComputeCluster(u), C1);
  ok(miningNow.mining && miningNow.block === null && miningNow.remainingS > 0, '채굴 중 — 사유 없음 · 남은 초 (메인 컴퓨터만 있으면 돈다)', JSON.stringify(miningNow));
  ok(miningNow.power === 0, 'ComputeClusterInfo.power — 계약 필드만 남아 늘 0 (2026-09-13 전력 할당 폐지)', String(miningNow.power));

  // 가짜 시간: 구간 시작을 2.5 주기 되돌린다 → 틱이 두 주기를 한 번에 넣는다
  const cycle6 = miningNow.cycleMs;
  await clearEv();
  const w0 = await walletOf('scrap');
  await H(({ u, cycle }) => {
    const h = window.__game.ctx.housing;
    const s = h.state.clusters.find((x) => x.uid === u);
    const now = h.nowMs();
    s.progress = 0; s.segmentAt = now - cycle * 2.5;
  }, { u: C1, cycle: cycle6 });
  const yieldScrap = await H(() => window.__game.ctx.housing.getCryptoCoins().find((c) => c.def.id === 'scrap').def.yieldUnits);
  await waitFor(page, ({ w, y }) => (window.__game.ctx.housing.getCryptoWallet().scrap ?? 0) >= w + 2 * y, 'mining deposit', 15000, { w: w0, y: yieldScrap });
  const s1 = await slot(C1);
  const mined = await ev('housing:cryptoMined');
  const wch = await ev('housing:walletChanged');
  ok(await walletOf('scrap') === w0 + 2 * yieldScrap, `틱이 끝난 주기 2개를 지갑에 (+${2 * yieldScrap} 단위)`);
  ok(mined.length === 1 && mined[0].uid === C1 && mined[0].units === 2 * yieldScrap && mined[0].coinId === 'scrap',
    'housing:cryptoMined — 따라잡기는 클러스터마다 한 번', JSON.stringify(mined));
  ok(wch.some((e) => e.reason === 'mined' && e.delta === 2 * yieldScrap), 'housing:walletChanged {reason: mined}', JSON.stringify(wch));
  ok(near(s1.progress, 0.5, 0.05), '진행도 소수 부분이 남는다 (≈ 0.5)', String(s1.progress));
  const minedMap = await H(() => window.__game.ctx.housing.state.cryptoMined?.scrap ?? 0);
  ok(minedMap >= 2 * yieldScrap, 'cryptoMined 누적', String(minedMap));

  // 코어 수 변경: 1.3 주기 → 넣기 = 한 주기 넣고 0.3 을 새 주기로 접는다
  await H(({ u, cycle }) => {
    const h = window.__game.ctx.housing;
    const s = h.state.clusters.find((x) => x.uid === u);
    const now = h.nowMs();
    s.progress = 0; s.segmentAt = now - cycle * 1.3;
  }, { u: C1, cycle: cycle6 });
  const w1 = await walletOf('scrap');
  await giveStash('mat_compute_core', 1);
  const fold = await H((u) => window.__game.ctx.housing.insertClusterCores(u, 1), C1);
  const s2 = await slot(C1);
  const info7 = await H((u) => window.__game.ctx.housing.getComputeCluster(u), C1);
  ok(fold === null && s2.cores === 7 && near(s2.progress, 0.3, 0.05) && await walletOf('scrap') === w1 + yieldScrap && info7.cycleMs === cycle6 / 2,
    '코어 변경 — 끝난 주기는 넣고 진행도는 접어 새 주기(절반)로 잇는다', JSON.stringify({ fold, s2, w: await walletOf('scrap') - w1, cycle: info7.cycleMs }));

  /* 2026-09-13 (전력 할당 폐지): 멈추는 시계는 없다 — `stationNow` = `nowMs`, `housing:operationalChanged {pausedMs}` 를 내는 곳도 받는 곳도 없다.
     남은 「가동」 조건은 메인 컴퓨터 하나다: 없으면 클러스터는 끝난 주기를 넣지 않고 틱마다 구간만 지금으로 다시 연다(진행도는 그대로),
     다시 놓으면 그 자리에서 이어간다 — 막혀 있던 시간은 따라잡지 않는다. */
  const clockSame = await H((u) => { const h = window.__game.ctx.housing; const a = h.nowMs(), b = h.stationNow(u), c = h.nowMs(); return b >= a && b <= c; }, C1);
  ok(clockSame, 'stationNow(uid) = nowMs() — 멈춘 시계 없음');
  const pcRec = await H((u) => { const h = window.__game.ctx.housing; return { block: h.recoverBlock(u), rec: h.recover(u), comp: h.getMiningComputerUid() }; }, pc.uid);
  const noPc = await H((u) => { const h = window.__game.ctx.housing; const i = h.getComputeCluster(u); return { op: h.furnitureOperationalBlock(u), mining: i.mining, block: i.block, remainingS: i.remainingS }; }, C1);
  ok(pcRec.block === null && pcRec.rec === true && pcRec.comp === null && noPc.op === '채굴 시설에 메인 컴퓨터가 있어야 합니다' && noPc.block === noPc.op && noPc.mining === false && noPc.remainingS === 0,
    '메인 컴퓨터 회수 → 클러스터 사유 「채굴 시설에 메인 컴퓨터가 있어야 합니다」 · 채굴 안 함', JSON.stringify({ pcRec, noPc }));
  await clearEv();
  const wBlocked = await walletOf('scrap');
  const tBlocked = await H((a) => {
    const h = window.__game.ctx.housing;
    const s = h.state.clusters.find((x) => x.uid === a.u);
    const now = h.nowMs();
    s.progress = 0.3; s.segmentAt = now - a.cycle * 2.5;
    return now;
  }, { u: C1, cycle: cycle6 / 2 });
  await sleep(2300);                                            // MINING_TICK_MS 1 s — at least two ticks while blocked
  const sBlocked = await slot(C1);
  ok(await walletOf('scrap') === wBlocked && (await ev('housing:cryptoMined')).length === 0 && near(sBlocked.progress, 0.3, 1e-9) && sBlocked.segmentAt >= tBlocked,
    '메인 컴퓨터가 없는 동안 — 끝난 주기 2.5 개를 넣지 않고 진행도는 그대로 · 구간은 지금으로 다시 연다', JSON.stringify({ sBlocked, tBlocked }));
  const rePc = await H((room) => {
    const h = window.__game.ctx.housing;
    const spot = h.findFreeSpot(room, 'furn_mining_computer');
    const p = spot ? h.place(room, 'furn_mining_computer', spot.x, spot.y, spot.yaw) : null;
    return { uid: p?.uid ?? null, comp: h.getMiningComputerUid(), now: h.nowMs() };
  }, ROOM);
  await sleep(1300);
  const sResumed = await slot(C1);
  const iResumed = await H((u) => window.__game.ctx.housing.getComputeCluster(u), C1);
  ok(!!rePc.uid && rePc.comp === rePc.uid && iResumed.mining && iResumed.block === null && await walletOf('scrap') === wBlocked
    && near(sResumed.progress, 0.3, 1e-9) && sResumed.segmentAt >= tBlocked && sResumed.segmentAt <= rePc.now,
  '다시 놓으면 곧바로 채굴 — 막혀 있던 시간은 따라잡지 않고 진행도 0.3 에서 이어간다', JSON.stringify({ rePc, sResumed, mining: iResumed.mining, block: iResumed.block }));

  // 코인 변경 = 진행도 0
  await H(({ u, cycle }) => {
    const h = window.__game.ctx.housing;
    const s = h.state.clusters.find((x) => x.uid === u);
    const now = h.nowMs();
    s.progress = 0; s.segmentAt = now - cycle * 0.6;
  }, { u: C1, cycle: cycle6 / 2 });
  const toVolt = await H((u) => window.__game.ctx.housing.setClusterCoin(u, 'volt'), C1);
  const s3 = await slot(C1);
  ok(toVolt === null && s3.coinId === 'volt' && s3.progress === 0, '코인 변경 — 진행도 0', JSON.stringify(s3));

  // 퀘스트 완료(가짜) 뒤 잠긴 코인 허용
  await H(() => { const m = window.__game.getSystem('meta'); m.store.corp('nomad').quests['nm_crypto'] = 'complete'; });
  const unlocked = await H((u) => [window.__game.ctx.meta.getQuestState('nm_crypto'), window.__game.ctx.housing.setClusterCoin(u, 'nomad'),
    window.__game.ctx.housing.getCryptoCoins().find((c) => c.def.id === 'nomad').unlocked], C1);
  ok(unlocked[0] === 'complete' && unlocked[1] === null && unlocked[2] === true, '퀘스트 완료 → 잠긴 코인 지정 · unlocked', JSON.stringify(unlocked));

  // 코어 빼기
  const c0 = await count();
  const rem = await H((u) => window.__game.ctx.housing.removeClusterCores(u, 2), C1);
  ok(rem === null && (await slot(C1)).cores === 5 && await count() === c0 + 2, '코어 빼기 — 2개가 가방 · 창고로', JSON.stringify({ rem, c: await count() - c0 }));
  const remBad = await H((u) => window.__game.ctx.housing.removeClusterCores(u, 1), C2);
  ok(remBad === '꽂힌 코어가 없습니다', '빈 클러스터에서 빼기 거절', String(remBad));

  // 회수: 코어가 있으면 거절
  const rb = await H((u) => [window.__game.ctx.housing.recoverBlock(u), window.__game.ctx.housing.recover(u)], C1);
  ok(rb[0] === '코어를 먼저 빼세요' && rb[1] === false && !!(await slot(C1)), '코어가 꽂힌 클러스터 — recoverBlock 사유 · recover 거절', JSON.stringify(rb));
  await H((u) => window.__game.ctx.housing.removeClusterCores(u, 9), C1);
  const rc = await H((u) => { const h = window.__game.ctx.housing; return [h.recoverBlock(u), h.recover(u)]; }, C1);
  ok(rc[1] === true && !(await slot(C1)) && await count() === c0 + 7, '코어를 다 빼면 회수 · 칸이 지워진다 · 코어 7 보존', JSON.stringify({ rc, c: await count() - c0 }));

  // devAdvanceMining — 두 번째 클러스터: 스크랩 · 코어 1 · 24 시간 = 두 주기
  await H((u) => { const h = window.__game.ctx.housing; h.setClusterCoin(u, 'scrap'); h.devSetClusterCores(u, 1); }, C2);
  const wff = await walletOf('scrap');
  const ffUnits = await H(() => window.__game.ctx.housing.devAdvanceMining(24));
  ok(ffUnits === 2 * yieldScrap && await walletOf('scrap') === wff + 2 * yieldScrap, 'devAdvanceMining(24) — 코어 1 스크랩 = 두 주기', String(ffUnits));

  /* ══ 4. 거래소 ═══════════════════════════════════════════════════════════ */
  console.log('거래소');
  const offline = await H(async () => {
    const h = window.__game.ctx.housing;
    return [h.cryptoQuote('scrap', 'sell', 10)?.block, await h.tradeCrypto('scrap', 'sell', 10), h.cryptoQuote('nope', 'buy', 1)];
  });
  ok(offline[0] === '서버에 연결되어야 합니다' && offline[1] === '서버에 연결되어야 합니다' && offline[2] === null, '서버 없음 — 견적 · 매매 거절, 모르는 코인 = null', JSON.stringify(offline));
  // 콘솔 `crypto wallet scrap 2.5` → 2500 단위
  const consoleOut = await H(async () => {
    const mod = await import('/src/console/commands/crypto.ts');
    const cmd = mod.cryptoCmd({});
    const r1 = cmd.run(['wallet', 'scrap', '2.5'], window.__game.ctx, () => {});
    const r2 = cmd.run([], window.__game.ctx, () => {});
    return { r1, r2, units: window.__game.ctx.housing.getCryptoWallet().scrap };
  });
  ok(consoleOut.units === 2500 && typeof consoleOut.r1 === 'string' && typeof consoleOut.r2 === 'string' && consoleOut.r2.includes('지갑'),
    '콘솔 crypto wallet scrap 2.5 → 2500 단위 · crypto 상태 출력', JSON.stringify(consoleOut));
  // 시세 스텁 (net 의 getter 를 인스턴스 속성으로 가린다)
  await H(() => {
    Object.defineProperty(window.__game.ctx.net, 'crypto', {
      configurable: true,
      value: { available: true, prices: { scrap: 2000, helix: 5000, nomad: 4000 }, change24h: { scrap: 0.01 }, pricesAt: Date.now(),
        watch: () => () => {}, requestHistory: () => {}, getHistory: () => null },
    });
  });
  const trade = await H(async () => {
    const ctx = window.__game.ctx, h = ctx.housing, m = ctx.meta, S = await import('/src/shared/index.ts');
    const o = { fee: S.CRYPTO_TRADE_FEE, per: S.CRYPTO_UNITS_PER_COIN, max: S.CRYPTO_TRADE_MAX_UNITS };
    o.coinPrice = h.getCryptoCoins().find((c) => c.def.id === 'scrap').price;
    o.c0 = m.credits; o.w0 = h.getCryptoWallet().scrap ?? 0;
    o.qSell = h.cryptoQuote('scrap', 'sell', 1000);
    o.sell = await h.tradeCrypto('scrap', 'sell', 1000);
    o.c1 = m.credits; o.w1 = h.getCryptoWallet().scrap ?? 0;
    o.qBuy = h.cryptoQuote('scrap', 'buy', 500);
    o.buy = await h.tradeCrypto('scrap', 'buy', 500);
    o.c2 = m.credits; o.w2 = h.getCryptoWallet().scrap ?? 0;
    o.tooMuch = h.cryptoQuote('scrap', 'sell', 999999)?.block;
    o.broke = h.cryptoQuote('scrap', 'buy', S.CRYPTO_TRADE_MAX_UNITS)?.block;
    o.overMax = h.cryptoQuote('scrap', 'buy', S.CRYPTO_TRADE_MAX_UNITS + 1)?.block;
    o.zero = h.cryptoQuote('scrap', 'buy', 0)?.block;
    o.locked = h.cryptoQuote('helix', 'buy', 10)?.block;
    o.lockedTrade = await h.tradeCrypto('helix', 'buy', 10);
    o.nomadOk = h.cryptoQuote('nomad', 'buy', 10)?.block;
    // 서버 거절 → 떼어 둔 지갑 복구
    m.creditsTx = async () => ({ ok: false, reason: '테스트 거절' });
    o.wBeforeRefuse = h.getCryptoWallet().scrap ?? 0; o.cBeforeRefuse = m.credits;
    o.refused = await h.tradeCrypto('scrap', 'sell', 100);
    o.wAfterRefuse = h.getCryptoWallet().scrap ?? 0; o.cAfterRefuse = m.credits;
    delete m.creditsTx;
    o.txLocal = await m.creditsTx(-(m.credits + 1), 'cbuy:scrap:1');
    return o;
  });
  const sellWant = Math.floor(2000 * 1 * (1 - trade.fee));
  const buyWant = Math.ceil(2000 * 0.5 * (1 + trade.fee));
  ok(trade.coinPrice === 2000, 'getCryptoCoins — 시세 스텁 반영', String(trade.coinPrice));
  ok(trade.qSell?.block === null && trade.qSell.credits === sellWant && trade.sell === null && trade.c1 === trade.c0 + sellWant && trade.w1 === trade.w0 - 1000,
    `매도 1코인 → +${sellWant} C · 지갑 −1000 단위`, JSON.stringify({ q: trade.qSell, sell: trade.sell, dc: trade.c1 - trade.c0, dw: trade.w1 - trade.w0 }));
  ok(trade.qBuy?.block === null && trade.qBuy.credits === buyWant && trade.buy === null && trade.c2 === trade.c1 - buyWant && trade.w2 === trade.w1 + 500,
    `매수 0.5코인 → −${buyWant} C (올림) · 지갑 +500 단위`, JSON.stringify({ q: trade.qBuy, buy: trade.buy, dc: trade.c2 - trade.c1, dw: trade.w2 - trade.w1 }));
  ok(trade.tooMuch === '지갑 잔고가 부족합니다', '매도 — 지갑 잔고 부족', String(trade.tooMuch));
  ok(trade.broke === '크레딧이 부족합니다', '매수 — 크레딧 부족', String(trade.broke));
  ok(typeof trade.overMax === 'string' && trade.overMax.includes('까지 거래할 수 있습니다'), '최대 단위 초과', String(trade.overMax));
  ok(trade.zero === '거래할 수량을 정하세요', '수량 0', String(trade.zero));
  ok(typeof trade.locked === 'string' && trade.locked.includes('완료 필요') && trade.lockedTrade === trade.locked, '잠긴 코인 매매 거절 (차트만)', JSON.stringify([trade.locked, trade.lockedTrade]));
  ok(trade.nomadOk === null, '해금된 코인은 매수 견적 가능', String(trade.nomadOk));
  ok(trade.refused === '테스트 거절' && trade.wAfterRefuse === trade.wBeforeRefuse && trade.cAfterRefuse === trade.cBeforeRefuse,
    '서버 거절 — 떼어 둔 지갑 복구 · 크레딧 그대로 · 사유 전달', JSON.stringify({ r: trade.refused, w: [trade.wBeforeRefuse, trade.wAfterRefuse] }));
  ok(trade.txLocal && trade.txLocal.ok === false && typeof trade.txLocal.reason === 'string', 'meta.creditsTx — 로컬 잔액 부족은 곧바로 거절', JSON.stringify(trade.txLocal));
  await H(() => { delete window.__game.ctx.net.crypto; });

  /* ══ 5. 세이브 ═══════════════════════════════════════════════════════════ */
  console.log('세이브');
  const save = await H(async ({ c2 }) => {
    const h = window.__game.ctx.housing;
    const S = await import('/src/housing/ShipState.ts');
    h.save();
    const live = JSON.parse(JSON.stringify(h.state));
    const round = S.sanitize(JSON.parse(JSON.stringify(live)), { refund: [] });
    let stored = null;
    try { stored = S.sanitize(JSON.parse(localStorage.getItem('scav.s1.ship')), { refund: [] }); } catch { stored = null; }
    const orphanRaw = JSON.parse(JSON.stringify(live));
    orphanRaw.furniture = orphanRaw.furniture.filter((f) => f.uid !== c2);
    const out = { refund: [] };
    const orphan = S.sanitize(orphanRaw, out);
    return {
      liveClusters: live.clusters, roundClusters: round.clusters, storedClusters: stored?.clusters ?? null,
      liveWallet: live.cryptoWallet, roundWallet: round.cryptoWallet, storedWallet: stored?.cryptoWallet ?? null,
      liveMined: live.cryptoMined, roundMined: round.cryptoMined,
      orphanClusters: orphan.clusters, refund: out.refund,
    };
  }, { c2: C2 });
  const strip = (list) => JSON.stringify((list ?? []).map((s) => [s.uid, s.coinId ?? null, s.cores, Math.round(s.progress * 1e6), s.segmentAt]));
  ok(strip(save.roundClusters) === strip(save.liveClusters) && save.liveClusters.length === 1,
    'sanitize 왕복 — 클러스터 칸 그대로', `${strip(save.liveClusters)} → ${strip(save.roundClusters)}`);
  ok(JSON.stringify(save.roundWallet) === JSON.stringify(save.liveWallet) && JSON.stringify(save.roundMined) === JSON.stringify(save.liveMined),
    'sanitize 왕복 — 지갑 · 누적 채굴 그대로', JSON.stringify([save.liveWallet, save.roundWallet]));
  ok(save.storedClusters && strip(save.storedClusters) === strip(save.liveClusters) && JSON.stringify(save.storedWallet) === JSON.stringify(save.liveWallet),
    'localStorage 에 적힌 함선도 같다', JSON.stringify({ c: save.storedClusters, w: save.storedWallet }));
  const coreRefund = save.refund.find((r) => r.defId === 'mat_compute_core');
  ok(save.orphanClusters.length === 0 && coreRefund?.qty === 1, '배치되지 않은 클러스터 — 칸은 버리고 코어 1 은 refund 로', JSON.stringify({ c: save.orphanClusters, refund: save.refund }));

  ok(errors.length === 0, 'no page errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL (exception) ${e?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\nsmoke-mining: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
