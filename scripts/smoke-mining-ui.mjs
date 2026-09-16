// Single-player smoke test for the **암호화폐 채굴 화면 · 가구 모델** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」 — 에이전트 ④:
// housing/ui/mining + hub/interiors/FurnitureMining). 채굴 규칙 · 지갑 · 매매 자체는 smoke-mining 류(에이전트 ③)의 몫이고,
// 여기서는 화면이 계약을 제대로 부르고 그리는지를 본다.
//  1. 함선 · 채굴 시설에 메인 컴퓨터 1 · 연산 클러스터 2 를 제작 · 배치 → 두 모델이 씬에 서고 **점광원 개수가 그대로**,
//     프로세서를 꽂으면 켜진 코어 재질(`mining-core-lit`) 메시가 생긴다 (광원 없이).
//  2. 연산 클러스터 화면: 프로세서 칸 9 · 레일 2 · 코인 8(잠김 4) · `ui:miningToggled` · **놓은 그 칸에 끌어온 그 인스턴스**(내구도
//     그대로 · 빼면 그대로 돌아온다) · 이미 찬 칸 · 가득 · 프로세서 아닌 것 거절 · 우클릭 = 가방 · 더블클릭 = 창고로 1개 ·
//     코인 지정 · 진행도 있을 때 다른 코인 = 1초 홀드 경고(취소하면 그대로) · 잠긴 코인 거절 ·
//     레일 전환 · Tab / Esc 닫기 · 가구 상호작용(`interact()`)이 이 화면을 연다.
//     2026-09-16 (사용자 결정 — 연산 코어 폐지): 꽂히는 것은 `mat_processor` 이고 칸은 개수가 아니라 **칸마다의 남은 내구도**다.
//  3. 메인 컴퓨터: 현황 줄 2(누르면 클러스터 화면) · 지갑 줄 8(지갑 단위 표기) · 거래소 — **스텁 `ctx.net.crypto`** 로 watch 참조 계수
//     (지갑 · 거래소 탭에서만) · requestHistory · 차트 그리기(캔버스 픽셀) · 호버 OHLC · 기간 · 봉/선 · 매매 버튼이 견적 사유로 막힘 ·
//     짧게 누르면 거래 없음 · 1초 홀드 = `tradeCrypto(coin, side, units)` 한 번 + 토스트 · 잠긴 코인 = 매매 잠김 · 오프라인 문구 · Tab 닫기 ·
//     없는 컴퓨터 토스트.
// Usage: node scripts/smoke-mining-ui.mjs [http://localhost:5273]   (needs `npm run dev`)   SMOKE_SHOTS=1 → scripts/logs/mining-ui-*.png
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SHOTS = !!process.env.SMOKE_SHOTS;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const note = (m) => console.log(`  note ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    '--window-size=1600,960', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

  const H = (fn, arg) => page.evaluate(fn, arg);
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync('scripts/logs', { recursive: true });
    await page.screenshot({ path: `scripts/logs/mining-ui-${name}.png` });
    console.log(`  shot scripts/logs/mining-ui-${name}.png`);
  };
  const waitSim = (sec) => page.evaluate(async (s) => {
    const ctx = window.__game.ctx, t0 = ctx.time;
    const until = Date.now() + 20000;
    while (ctx.time - t0 < s && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
  }, sec);

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    const ctx = window.__game.ctx;
    window.__notify = [];
    window.__toggles = [];
    ctx.bus.on('ui:notify', (p) => window.__notify.push(p.text));
    ctx.bus.on('ui:miningToggled', (p) => window.__toggles.push(p));
    window.__lights = () => { let n = 0; ctx.scene.traverseVisible((o) => { if (o.isLight && !o.isAmbientLight) n++; }); return n; };
    window.__models = (name) => {
      const out = [];
      ctx.scene.traverse((o) => { if (o.name === name) { let meshes = 0, lit = 0; o.traverse((m) => { if (m.isMesh) { meshes++; if (m.material?.name === 'mining-core-lit') lit += m.geometry.attributes.position.count; } }); out.push({ meshes, lit }); } });
      return out;
    };
  });
  const lastNotify = () => H(() => window.__notify[window.__notify.length - 1] ?? '');

  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitFor(page, () => [...document.querySelectorAll('.menu.hidden')].every((m) => {
    const cs = getComputedStyle(m);
    return cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
  }), '숨은 메뉴의 페이드가 끝난다', 5000);
  await waitSim(0.5);

  const giveStash = (id, n) => H(({ id, n }) => {
    const ctx = window.__game.ctx;
    const def = ctx.loot.getItemDef(id);
    if (!def) return -1;
    let added = 0;
    while (added < n) { const q = Math.min(def.stackMax ?? 1, n - added); if (!ctx.inventory.tryAddToStash(ctx.loot.createItem(id, q))) break; added += q; }
    return added;
  }, { id, n });
  const countAll = (id) => H((d) => window.__game.ctx.housing.countDef(d), id);
  const bagQty = (id) => H((d) => window.__game.ctx.inventory.getAllItems().filter((i) => i.defId === d).reduce((a, i) => a + i.qty, 0), id);
  const stashQty = (id) => H((d) => window.__game.ctx.inventory.getStashItems().filter((i) => i.defId === d).reduce((a, i) => a + i.qty, 0), id);

  /* ══ 1. 채굴 시설 · 모델 · 광원 ═══════════════════════════════════════════ */
  console.log('채굴 시설 · 모델');
  for (const [id, n] of [['mat_scrap', 40], ['mat_alloy', 30], ['mat_cable', 30], ['mat_circuit', 20]]) await giveStash(id, n);
  const ROOM = 3;
  await H((room) => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = 5;                        // 채굴 시설 = 발전기 Lv.5 (2026-09-13 최대)
    h.state.rooms[room].purpose = 'mining';
    h.changed('smoke');
  }, ROOM);
  await waitSim(0.3);
  const lightsBefore = await H(() => window.__lights());
  const placeFurn = (room, defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    if (!h.craftFurniture(defId)) return { err: `craft: ${h.furnitureCraftBlock?.(defId) ?? '?'}` };
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return { err: 'no spot' };
    const p = h.place(room, defId, spot.x, spot.y, spot.yaw);
    return p ? { uid: p.uid } : { err: `place refused: ${h.placementBlock?.(room, defId, spot.x, spot.y, spot.yaw) ?? '?'}` };
  }, { room, defId });
  const pcP = await placeFurn(ROOM, 'furn_mining_computer');
  const c1P = await placeFurn(ROOM, 'furn_compute_cluster');
  const c2P = await placeFurn(ROOM, 'furn_compute_cluster');
  ok(pcP.uid && c1P.uid && c2P.uid, '메인 컴퓨터 1 · 연산 클러스터 2 제작 + 배치', JSON.stringify({ pcP, c1P, c2P }));
  const PC = pcP.uid, C1 = c1P.uid, C2 = c2P.uid;
  // 2026-09-13 (전력 할당 폐지): 할당 단계 없음 — 메인 컴퓨터가 있으면 클러스터에 가동 사유가 없다
  const op = await H((u) => ({ block: window.__game.ctx.housing.furnitureOperationalBlock(u), api: typeof window.__game.ctx.housing.setPowerAllocation }), c1P.uid);
  ok(op.block === null && op.api === 'undefined', `전력 할당 없음 — 클러스터 가동 사유 없음 (${JSON.stringify(op)})`);
  await waitSim(0.4);
  const lightsAfter = await H(() => window.__lights());
  ok(lightsAfter === lightsBefore, `가구 배치 뒤 점광원 개수 그대로 (${lightsBefore} → ${lightsAfter})`);
  const models0 = await H(() => ({ cl: window.__models('furn-furn_compute_cluster'), pc: window.__models('furn-furn_mining_computer') }));
  ok(models0.cl.length === 2 && models0.cl.every((m) => m.meshes >= 5), `연산 클러스터 모델 2 (${JSON.stringify(models0.cl)})`);
  ok(models0.pc.length === 1 && models0.pc[0].meshes >= 5, `메인 컴퓨터 모델 1 (${JSON.stringify(models0.pc)})`);
  ok(models0.cl.every((m) => m.lit === 0), '코어 없는 클러스터 = 켜진 코어 칸 없음');
  await shot('01-room');

  /* ══ 2. 채굴 탭 (옛 연산 클러스터 화면) ═══════════════════════════════════
     2026-09-14 (사용자 결정): 연산 클러스터 화면과 메인 컴퓨터 화면이 **한 창**(`.menu.mining-screen`)으로 합쳐졌고
     상단 가로 탭 넷(`nav.mn-tabs > button.mn-tab[data-tab]`)이 배치를 갈아 끼운다. 코인은 버튼 8칸 줄이 아니라
     현황 칸의 **드롭다운**(`.mn-cp` / `.mn-cp-btn` → `.mn-cpi[data-coin]`)이 고르고, 코어는 **한 번에 하나**씩 꽂힌다. */
  console.log('채굴 탭 (연산 클러스터)');
  await H((u) => window.__game.ctx.housing.openComputeCluster(u), C1);
  await waitFor(page, () => document.querySelector('.menu.mining-screen') && !document.querySelector('.menu.mining-screen').hidden, 'mining screen', 5000);
  await sleep(60);
  const dom = await H(() => {
    const r = document.querySelector('.menu.mining-screen');
    const cp = r.querySelector('.mn-cp-btn');
    cp?.click();                                            // 코인 드롭다운을 펼쳐 목록을 센다
    const coins = r.querySelectorAll('.mn-cpi[data-coin]:not(.mn-cpi-clear)').length;
    const locked = r.querySelectorAll('.mn-cpi.is-locked').length;
    window.__game.ctx.housing.miningScreen.cluster['picker'].close();
    return {
      tabs: [...r.querySelectorAll('nav.mn-tabs > button.mn-tab')].map((b) => `${b.dataset.tab}:${b.textContent}${b.classList.contains('is-on') ? '*' : ''}`),
      cores: r.querySelectorAll('.mn-core[data-core]').length,
      rail: r.querySelectorAll('.hs-rail-item').length,
      coins, locked,
      grids: [...r.querySelectorAll('[data-tg-grid]')].map((g) => g.dataset.tgGrid),
      gridsShown: !r.querySelector('.hs-pane-right').hidden,
      title: r.querySelector('.hs-station-head .title')?.textContent,
      expectLocked: (window.__game.ctx.housing.getCryptoCoins?.() ?? []).filter((c) => !c.unlocked).length,
    };
  });
  ok(dom.tabs.join(' ') === 'cluster:채굴* clusters:클러스터 현황 wallet:지갑 exchange:거래소',
    `상단 탭 넷 · 연산 클러스터로 열면 「채굴」 (${dom.tabs.join(' ')})`);
  ok(dom.cores === 9 && dom.rail === 2 && dom.coins === 8, `코어 칸 9 · 레일 2 · 드롭다운 코인 8 (${JSON.stringify(dom)})`);
  ok(dom.locked === dom.expectLocked && dom.locked > 0, `잠긴 코인 딤드 ${dom.locked} (housing ${dom.expectLocked})`);
  ok(dom.grids.includes('stash') && dom.grids.includes('bag') && dom.gridsShown, '함선 창고 · 가방 격자 카드 (채굴 탭에서만 보인다)');
  ok(dom.title === '연산 클러스터 1', `제목 = 레일 번호 (${dom.title})`);
  ok(await H(() => window.__toggles.some((t) => t.open && t.page === 'cluster')), 'ui:miningToggled {open, page: cluster}');

  /* 2026-09-16 (사용자 결정 — 연산 코어 폐지): 칸에 꽂는 것은 **프로세서**(2×1 · 내구도 500)다. 칸을 지정한 드롭은
     `insertClusterProcessor(uid, cell, item.uid)` — **끌어온 그 인스턴스**가 **놓은 그 칸**에 들어간다. 프로세서는 저마다
     내구도가 달라 「아무거나 다음 빈 칸」이 더 이상 같은 결과가 아니기 때문이다 (인덱스가 곧 화면 격자의 칸). */
  const hasCoreApi = await H(() => typeof window.__game.ctx.housing.insertClusterProcessor === 'function' && !!window.__game.ctx.loot.getItemDef('mat_processor'));
  /* `ClusterPage.dropOn` 은 `mountStationGrids` 의 `onTake` 와 같은 경로다 (격자 타일을 프로세서 칸에 떨어뜨린 것). */
  const dropVia = (defId, sel) => H(({ defId, sel }) => {
    const ctx = window.__game.ctx;
    const p = ctx.housing.miningScreen?.cluster;
    const item = [...ctx.inventory.getStashItems(), ...ctx.inventory.getAllItems()].find((i) => i.defId === defId);
    const t = document.querySelector(sel);
    if (!p || !item || !t) return { ok: false, item: !!item, target: !!t };
    p.dropOn(item, t);
    return { ok: true };
  }, { defId, sel });
  /** 드롭할 인스턴스를 **uid 로** 고른다 — 「끌어온 그것이 그 칸에 들어간다」를 내구도로 확인하는 길. */
  const dropUid = (uid, sel) => H(({ uid, sel }) => {
    const ctx = window.__game.ctx;
    const p = ctx.housing.miningScreen?.cluster;
    const item = [...ctx.inventory.getStashItems(), ...ctx.inventory.getAllItems()].find((i) => i.uid === uid);
    const t = document.querySelector(sel);
    if (!p || !item || !t) return { ok: false, item: !!item, target: !!t };
    p.dropOn(item, t);
    return { ok: true };
  }, { uid, sel });
  const coresOf = (u) => H((u) => window.__game.ctx.housing.getComputeCluster?.(u)?.cores ?? -1, u);
  const cellsOf = (u) => H((u) => [...(window.__game.ctx.housing.getComputeCluster?.(u)?.processors ?? [])], u);
  const giveWorn = (dur) => H((d) => {
    const ctx = window.__game.ctx;
    const it = ctx.loot.createItem('mat_processor', 1, { durability: d });
    return ctx.inventory.tryAddToStash(it) ? it.uid : null;
  }, dur);
  if (!hasCoreApi) {
    ok(false, 'insertClusterProcessor / mat_processor 가 없다 — 프로세서 칸 검사를 건너뛴다');
  } else {
    const DUR_MAX = await H(() => window.__game.ctx.loot.getItemDef('mat_processor').durabilityMax ?? 0);
    ok(DUR_MAX > 0, `프로세서는 내구도를 가진 아이템이다 (최대 ${DUR_MAX})`);
    // 2026-09-14 (사용자 결정): 아이템이 2×1 이고 드롭 · 더블클릭 · 우클릭은 **한 개씩** 옮긴다
    await giveStash('mat_processor', 3);
    const stackBefore = await countAll('mat_processor');
    const d1 = await dropVia('mat_processor', '.mining-screen .mn-core[data-core="4"]');
    await sleep(60);
    const cells1 = await cellsOf(C1);
    ok(d1.ok && (await coresOf(C1)) === 1 && (await countAll('mat_processor')) === stackBefore - 1
      && cells1[4] === DUR_MAX && cells1.every((v, i) => i === 4 || v === null),
    `빈 칸에 드롭 → 한 개만, **놓은 그 칸**(4번)에 꽂힌다 (${JSON.stringify(cells1)}) ${JSON.stringify(d1)}`);

    /* 2026-09-16 (사용자 결정): 칸은 개수가 아니라 **그 칸의 남은 내구도**다 — 끌어온 인스턴스의 내구도가 칸에 그대로 적히고,
       빼면 그대로 돌아온다 (닳은 것만 골라 빼서 작업대로 가져가는 길). */
    const WORN = Math.max(1, Math.round(DUR_MAX * 0.24));
    const wornUid = await giveWorn(WORN);
    const d2 = await dropUid(wornUid, '.mining-screen .mn-core[data-core="7"]');
    await sleep(60);
    const cells2 = await cellsOf(C1);
    ok(!!wornUid && d2.ok && cells2[7] === WORN && cells2[4] === DUR_MAX,
      `닳은 프로세서(내구도 ${WORN})를 끌어다 놓으면 그 칸이 그 내구도를 든다 (${JSON.stringify(cells2)})`);
    await dropVia('mat_processor', '.mining-screen .mn-core[data-core="7"]');
    await sleep(40);
    ok((await lastNotify()) === '이미 프로세서가 꽂힌 칸입니다' && (await coresOf(C1)) === 2,
      `이미 찬 칸에 드롭 → 거절 (${await lastNotify()})`);
    const bagWorn0 = await bagQty('mat_processor');
    await H(() => document.querySelector('.mining-screen .mn-core[data-core="7"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await sleep(60);
    const backDur = await H(() => window.__game.ctx.inventory.getAllItems().filter((i) => i.defId === 'mat_processor').map((i) => i.durability ?? null));
    ok((await coresOf(C1)) === 1 && (await bagQty('mat_processor')) === bagWorn0 + 1 && backDur.includes(WORN),
      `그 칸을 빼면 내구도 ${WORN} 을 그대로 들고 가방으로 (${JSON.stringify(backDur)})`);

    await giveStash('mat_processor', 12);
    const stash1 = await countAll('mat_processor');
    for (const cell of [0, 1, 2, 3, 5, 6, 7, 8]) { await dropVia('mat_processor', `.mining-screen .mn-core[data-core="${cell}"]`); await sleep(20); }
    ok((await coresOf(C1)) === 9 && (await countAll('mat_processor')) === stash1 - 8, `남은 여덟 칸을 채우면 가득 (프로세서 9 · 창고 ${stash1} → ${await countAll('mat_processor')})`);
    const lit = await H(() => ({ on: document.querySelectorAll('.mining-screen .mn-core.is-on').length, count: document.querySelector('.mining-screen .mn-corebox .mn-sec-count')?.textContent }));
    ok(lit.on === 9 && lit.count === '9 / 9', `켜진 칸 9 · 「9 / 9」 (${JSON.stringify(lit)})`);
    await dropVia('mat_processor', '.mining-screen .mn-core[data-core="0"]');
    await sleep(30);
    ok((await lastNotify()).includes('가득'), `가득 찬 클러스터에 드롭 → 거절 토스트 (${await lastNotify()})`);
    await dropVia('mat_scrap', '.mining-screen .mn-core[data-core="0"]');
    await sleep(30);
    ok((await lastNotify()) === '프로세서만 꽂을 수 있습니다', '프로세서가 아닌 아이템 → 거절');
    await waitSim(0.3);
    const models1 = await H(() => window.__models('furn-furn_compute_cluster'));
    ok(models1.some((m) => m.lit > 0) && models1.some((m) => m.lit === 0), `프로세서 9 클러스터만 켜진 코어 칸 메시 (${JSON.stringify(models1)})`);
    ok((await H(() => window.__lights())) === lightsBefore, '프로세서를 꽂아 모델을 다시 지어도 점광원 그대로');

    const bag0 = await bagQty('mat_processor'), stash0 = await stashQty('mat_processor');
    await H(() => document.querySelector('.mining-screen .mn-core.is-on')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await sleep(60);
    ok((await coresOf(C1)) === 8 && (await bagQty('mat_processor')) === bag0 + 1, '우클릭 → 프로세서 1개 빼기 (가방 먼저)');
    await H(() => document.querySelector('.mining-screen .mn-core.is-on')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    await sleep(60);
    ok((await coresOf(C1)) === 7 && (await stashQty('mat_processor')) === stash0 + 1, '더블클릭 → 프로세서 1개 빼기 (함선 창고 먼저)');
  }

  /* 코인 지정 — 2026-09-14 부터 현황 칸의 드롭다운(`CoinPicker`)이다: 버튼을 누르면 목록이 펼쳐지고 줄을 누른다.
     잠긴 코인도 목록에 남고 딤드이며, 누르면 사유 토스트만 난다. */
  const coins = await H(() => (window.__game.ctx.housing.getCryptoCoins?.() ?? []).map((c) => ({ id: c.def.id, unlocked: c.unlocked, reason: c.lockReason })));
  const open = coins.filter((c) => c.unlocked), locked = coins.filter((c) => !c.unlocked);
  const coinOf = (u) => H((u) => window.__game.ctx.housing.getComputeCluster?.(u)?.coinId ?? null, u);
  const pickCoin = (id) => H((id) => {
    document.querySelector('.mining-screen .mn-cp-btn')?.click();
    document.querySelector(`.mining-screen .mn-cpi[data-coin="${id}"]`)?.click();
  }, id);
  if (open.length >= 2) {
    await pickCoin(open[0].id);
    await sleep(60);
    ok((await coinOf(C1)) === open[0].id, `드롭다운에서 코인 선택 → setClusterCoin (${open[0].id})`);
    const stat = await H(() => [...document.querySelectorAll('.mining-screen .mn-stat')].filter((r) => !r.hidden && !r.classList.contains('mn-stat-coin')).map((r) => `${r.querySelector('.k').textContent}=${r.querySelector('.v').textContent}`));
    ok(stat.some((s) => /^채굴 주기=.*(시간|분|초)/.test(s)) && stat.some((s) => s.startsWith('주기당 채굴=')), `상태 줄 (${stat.join(' | ')})`);
    // 진행도가 있는 척 → 다른 코인 = 홀드 경고, 취소하면 그대로
    await H(() => {
      const h = window.__game.ctx.housing;
      const real = h.getComputeCluster.bind(h);
      h.__realGetCluster = real;
      h.getComputeCluster = (u) => { const c = real(u); return c ? { ...c, progress: 0.4 } : c; };
    });
    await pickCoin(open[1].id);
    await sleep(80);
    const ask = await H(() => { const a = document.querySelector('.sh-ask[data-ask="mn-coin-change"]'); return a && !a.hidden ? a.querySelector('.sh-ask-body')?.textContent ?? '' : null; });
    ok(ask !== null && ask.includes('40 %'), `진행도 있을 때 코인 변경 → 1초 홀드 경고 (${ask})`);
    await H(() => document.querySelector('.sh-ask[data-ask="mn-coin-change"] button[data-cancel]')?.click());
    await sleep(60);
    ok((await coinOf(C1)) === open[0].id, '경고 취소 → 코인 그대로');
    await H(() => { const h = window.__game.ctx.housing; h.getComputeCluster = h.__realGetCluster; delete h.__realGetCluster; });
  } else note('열린 코인이 둘 미만 — 코인 지정 검사 건너뜀');
  if (locked.length) {
    await pickCoin(locked[0].id);
    await sleep(60);
    ok((await coinOf(C1)) !== locked[0].id && (await lastNotify()) === (locked[0].reason ?? '잠긴 코인입니다'), `잠긴 코인 줄 클릭 → 거절 (${await lastNotify()})`);
    await H(() => window.__game.ctx.housing.miningScreen.cluster['picker'].close());
  }
  await shot('02-cluster');
  // 레일 전환
  await H((u) => document.querySelector(`.mining-screen .hs-rail-item[data-uid="${u}"]`)?.click(), C2);
  await sleep(60);
  ok(await H((u) => window.__game.ctx.housing.clusterScreen.currentUid === u && document.querySelector('.mining-screen .hs-station-head .title')?.textContent === '연산 클러스터 2', C2), '레일 → 클러스터 2');
  // Tab 닫기
  await tap('Tab');
  await sleep(80);
  ok(await H(() => document.querySelector('.menu.mining-screen').hidden), 'Tab → 채굴 화면 닫힘');
  ok(await H(() => window.__toggles.some((t) => !t.open && t.page === 'cluster')), 'ui:miningToggled {open: false}');
  // 가구 상호작용 → 화면 · Esc 닫기
  const viaInteract = await H((u) => {
    const i = window.__game.ctx.interactables.all().find((x) => x.id === `hub_furn_${u}`);
    if (!i) return 'no interactable';
    i.interact();
    const s = window.__game.ctx.housing.miningScreen;
    return !document.querySelector('.menu.mining-screen').hidden && s.currentTab === 'cluster' && s.currentUid === u ? 'ok' : 'not opened';
  }, C1);
  ok(viaInteract === 'ok', `연산 클러스터 interact() → 채굴 탭 (${viaInteract})`);
  await tap('Escape');
  await waitFor(page, () => document.querySelector('.menu.mining-screen').hidden, 'Esc closes mining screen', 5000).catch(() => null);
  ok(await H(() => document.querySelector('.menu.mining-screen').hidden), 'Esc → 채굴 화면 닫힘');

  /* ══ 3. 메인 컴퓨터 ═══════════════════════════════════════════════════════ */
  console.log('메인 컴퓨터');
  // 스텁 시세 (릴레이를 막은 스모크 — 서버 시세 대신)
  await H(() => {
    const ctx = window.__game.ctx;
    const s = window.__cryptoStub = { watch: 0, unwatch: 0, req: [] };
    const now = Date.now();
    const SPAN = { '1h': 60000, '1d': 900000, '1w': 3600000, '1M': 14400000 };
    const COUNT = { '1h': 60, '1d': 96, '1w': 168, '1M': 180 };
    const prices = {}, change24h = {};
    (ctx.housing.getCryptoCoins?.() ?? []).forEach((c, i) => { prices[c.def.id] = c.def.basePrice; change24h[c.def.id] = (i % 2 ? -1 : 1) * 0.012 * (i + 1); });
    const hist = new Map();
    const gen = (coin, range) => {
      const span = SPAN[range], n = COUNT[range];
      let p = prices[coin] ?? 1000;
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = Math.floor(now / span) * span - (n - 1 - i) * span;
        const o = p, c = o * (1 + Math.sin(i * 0.7) * 0.02 + Math.cos(i * 0.23) * 0.01);
        out.push({ t, o, h: Math.max(o, c) * 1.006, l: Math.min(o, c) * 0.994, c });
        p = c;
      }
      return out;
    };
    const stub = {
      available: true, prices, change24h, pricesAt: now,
      watch() { s.watch++; let done = false; return () => { if (!done) { done = true; s.unwatch++; } }; },
      requestHistory(coin, range) { s.req.push(`${coin}:${range}`); hist.set(`${coin}:${range}`, gen(coin, range)); setTimeout(() => ctx.bus.emit('net:cryptoHistory', { coin, range }), 10); },
      getHistory(coin, range) { return hist.get(`${coin}:${range}`) ?? null; },
    };
    Object.defineProperty(ctx.net, 'crypto', { value: stub, configurable: true, writable: true });
    ctx.bus.emit('net:cryptoPrices', { at: now });
    ctx.housing.devSetCryptoWallet?.('scrap', 2500);
  });
  await H(() => window.__game.ctx.housing.openMiningComputer(null));
  await waitFor(page, () => document.querySelector('.menu.mining-screen') && !document.querySelector('.menu.mining-screen').hidden, 'mining screen (computer)', 5000);
  await sleep(80);
  const pc = await H(() => {
    const r = document.querySelector('.menu.mining-screen');
    return {
      // 2026-09-14: 옛 좌측 레일 탭(`.hs-rail .hs-tab`)은 창 상단의 가로 탭 넷이 됐다
      tabs: [...r.querySelectorAll('nav.mn-tabs > button.mn-tab')].map((t) => t.textContent),
      active: r.querySelector('.mn-tab.is-on')?.dataset.tab,
      rows: r.querySelectorAll('.mn-crow[data-uid]').length,
      head: [...r.querySelectorAll('.mn-crow.mn-chead span')].map((s) => s.textContent).join('|'),
      gridsShown: !r.querySelector('.hs-pane-right').hidden,
      railShown: !r.querySelector('.hs-rail').hidden,
      upgrade: !!r.querySelector('.hs-up-open'),
      watch: window.__cryptoStub.watch,
      toggled: window.__toggles.some((t) => t.open && t.page === 'computer'),
    };
  });
  ok(pc.tabs.join('|') === '채굴|클러스터 현황|지갑|거래소' && pc.active === 'clusters', `상단 탭 넷 · 메인 컴퓨터로 열면 「클러스터 현황」 (${pc.tabs.join('|')})`);
  ok(pc.rows === 2 && !pc.gridsShown && !pc.railShown && !pc.upgrade, `현황 줄 2 · 격자 · 레일 숨김 · 업그레이드 없음 (${JSON.stringify(pc)})`);
  // 2026-09-16 (사용자 결정 — 연산 코어 폐지): 셋째 칸 이름이 「코어」 → 「프로세서」다. 전력 칸은 2026-09-13 부터 그대로 없다.
  ok(pc.head === '클러스터|코인|프로세서|이번 주기|상태', `현황 머리줄 = 프로세서 칸 · 전력 칸 없음 (${pc.head})`);
  ok(pc.watch === 0 && pc.toggled, `현황 탭은 시세를 구독하지 않는다 · ui:miningToggled computer (watch ${pc.watch})`);
  const rowText = await H(() => document.querySelector('.mining-screen .mn-crow[data-uid] .mn-ccores')?.textContent ?? '');
  ok(/\d\/9/.test(rowText), `현황 줄 코어 n/9 (${rowText})`);
  await shot('03-computer-clusters');
  // 줄 클릭 → 그 클러스터의 채굴 탭 (2026-09-14: 창을 닫지 않고 탭만 바꾼다)
  await H((u) => document.querySelector(`.mining-screen .mn-crow[data-uid="${u}"]`)?.click(), C2);
  await sleep(80);
  ok(await H((u) => {
    const s = window.__game.ctx.housing.miningScreen;
    return !document.querySelector('.menu.mining-screen').hidden && s.currentTab === 'cluster' && s.currentUid === u;
  }, C2), '현황 줄 클릭 → 그 클러스터의 채굴 탭 (창은 열린 채)');
  await tap('Tab');
  await sleep(60);

  // 지갑
  await H((u) => window.__game.ctx.housing.openMiningComputer(u, 'wallet'), PC);
  await sleep(80);
  const wallet = await H(() => {
    const r = document.querySelector('.menu.mining-screen');
    const row = r.querySelector('.mn-wrow[data-coin="scrap"]');
    return { rows: r.querySelectorAll('.mn-wrow[data-coin]').length, units: row?.querySelectorAll('.mn-num')[0]?.textContent, value: row?.querySelectorAll('.mn-num')[1]?.textContent, watch: window.__cryptoStub.watch, active: r.querySelector('.mn-tab.is-on')?.dataset.tab };
  });
  ok(wallet.active === 'wallet' && wallet.rows === 8, `openMiningComputer(uid, 'wallet') → 지갑 줄 8 (${JSON.stringify(wallet)})`);
  ok(wallet.units === '2.500 SCRP' && /크레딧/.test(wallet.value ?? ''), `보유 2.500 SCRP · 평가액 (${wallet.units} · ${wallet.value})`);
  ok(wallet.watch === 1, `지갑 탭 = 시세 구독 1 (${wallet.watch})`);

  // 거래소
  await H(() => document.querySelector('.mining-screen .mn-tab[data-tab="exchange"]')?.click());
  await waitFor(page, () => window.__game.ctx.housing.miningComputer.chart.debug.candles > 0, 'chart candles', 5000).catch(() => null);
  await sleep(120);
  const x = await H(() => {
    const m = window.__game.ctx.housing.miningComputer;
    const cv = document.querySelector('.mining-screen .mn-chart-canvas');
    let painted = 0;
    try {
      const g = cv.getContext('2d');
      const data = g.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < data.length; i += 16) if (data[i] > 0) painted++;
    } catch { painted = -1; }
    return { coin: m.selectedCoin, watch: window.__cryptoStub.watch, unwatch: window.__cryptoStub.unwatch, req: window.__cryptoStub.req.slice(), debug: { ...m.chart.debug }, painted,
      list: document.querySelectorAll('.mining-screen .mn-xrow[data-coin]').length, msg: !document.querySelector('.mining-screen .mn-chart-msg').hidden };
  });
  ok(x.list === 8 && x.watch === 1 && x.unwatch === 0, `거래소: 코인 목록 8 · 구독은 그대로 1 (${JSON.stringify({ list: x.list, watch: x.watch, unwatch: x.unwatch })})`);
  ok(x.req.includes(`${x.coin}:1d`), `선택 코인 이력 요청 (${x.req.join(', ')})`);
  ok(x.debug.candles >= 96 && x.debug.draws > 0 && x.painted > 50 && !x.msg, `차트가 봉을 그렸다 (${JSON.stringify(x.debug)} · 픽셀 ${x.painted})`);
  const hover = await H(() => {
    const cv = document.querySelector('.mining-screen .mn-chart-canvas');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * 0.45, clientY: r.top + r.height * 0.5 }));
    const tip = document.querySelector('.mining-screen .mn-chart-tip');
    return { shown: !tip.hidden, text: tip.textContent, idx: window.__game.ctx.housing.miningComputer.chart.debug.hoverIndex };
  });
  ok(hover.shown && hover.idx >= 0 && ['시가', '고가', '저가', '종가'].every((k) => hover.text.includes(k)), `호버 → 십자선 + OHLC 카드 (idx ${hover.idx})`);
  await shot('04-exchange');
  await H(() => document.querySelector('.mining-screen .mn-chart-canvas')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })));
  await H(() => document.querySelector('.mining-screen .mn-seg-btn[data-range="1w"]')?.click());
  await sleep(80);
  ok(await H((c) => window.__cryptoStub.req.includes(`${c}:1w`) && document.querySelector('.mining-screen .mn-seg-btn[data-range="1w"]').classList.contains('is-active'), x.coin), '기간 1주 → 이력 요청 · 활성 표시');
  const draws0 = await H(() => window.__game.ctx.housing.miningComputer.chart.debug.draws);
  await H(() => document.querySelector('.mining-screen .mn-seg-btn[data-mode="line"]')?.click());
  ok(await H((d0) => window.__game.ctx.housing.miningComputer.chart.currentMode === 'line' && window.__game.ctx.housing.miningComputer.chart.debug.draws > d0, draws0), '봉 → 선 모드 다시 그리기');

  // 매매 — 견적 사유로 막히는 홀드 버튼 (스텁 시세를 방금 받은 것으로 — 오래된 시세는 따로 본다)
  const freshPrices = (ageMs = 0) => H((age) => { const ctx = window.__game.ctx; ctx.net.crypto.pricesAt = Date.now() - age; ctx.bus.emit('net:cryptoPrices', { at: ctx.net.crypto.pricesAt }); }, ageMs);
  await freshPrices();
  const trade = () => H(() => {
    const r = document.querySelector('.mining-screen');
    return { disabled: r.querySelector('.mn-hold').disabled, block: r.querySelector('.mn-trade-block').textContent, locked: r.querySelector('.mn-trade').classList.contains('is-locked'), label: r.querySelector('.mn-hold-label').textContent };
  });
  const setAmount = (v) => H((v) => { const i = document.querySelector('.mining-screen .mn-amt-input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setAmount('');
  let t = await trade();
  ok(t.disabled && t.block === '수량을 입력하세요', `수량 없음 → 버튼 잠김 (${t.block})`);
  await setAmount('1');
  t = await trade();
  const realQuote = await H((c) => window.__game.ctx.housing.cryptoQuote?.(c, 'buy', 1000) ?? null, x.coin);
  if (realQuote) ok(t.disabled === !!realQuote.block && (!realQuote.block || t.block === realQuote.block), `housing 견적 사유를 따른다 (${realQuote.block ?? '막힘 없음'} / 버튼 ${t.disabled ? '잠김' : '열림'})`);
  else note('cryptoQuote 없음 — 실제 견적 검사 건너뜀');
  await H(() => {
    const h = window.__game.ctx.housing;
    h.__realQuote = h.cryptoQuote; h.__realTrade = h.tradeCrypto;
    window.__quoteBlock = '크레딧이 부족합니다';
    window.__trades = [];
    h.cryptoQuote = (coin, side, units) => ({ coinId: coin, side, units, price: 1800, credits: Math.ceil(1800 * units / 1000 * 1.02), block: window.__quoteBlock });
    h.tradeCrypto = (coin, side, units) => { window.__trades.push({ coin, side, units }); return new Promise((r) => setTimeout(() => r(null), 700)); };
  });
  await setAmount('0.5');
  t = await trade();
  ok(t.disabled && t.block === '크레딧이 부족합니다', `견적 사유 → 버튼 잠김 (${t.block})`);
  await H(() => { window.__quoteBlock = null; });
  await setAmount('0.5');
  t = await trade();
  ok(!t.disabled && t.label === '매수', `막힘 없음 → 「매수」 버튼 열림 (${JSON.stringify(t)})`);
  await H(() => { const b = document.querySelector('.mining-screen .mn-hold'); b.click(); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7 })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 7 })); });
  await sleep(1300);
  ok(await H(() => window.__trades.length === 0), '클릭 · 짧게 누르기로는 거래하지 않는다');
  await freshPrices();
  const subT0 = await H(() => ({ ...window.__cryptoStub }));
  await H(() => document.querySelector('.mining-screen .mn-hold').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 8 })));
  await sleep(1200);
  const mid = await H(() => ({ trades: window.__trades.slice(), s: { ...window.__cryptoStub }, label: document.querySelector('.mining-screen .mn-hold-label').textContent }));
  ok(mid.trades.length === 1 && mid.trades[0].coin === x.coin && mid.trades[0].side === 'buy' && mid.trades[0].units === 500, `1초 홀드 → tradeCrypto 한 번 (${JSON.stringify(mid.trades)})`);
  ok(mid.s.watch === subT0.watch + 1 && mid.label === '처리 중…', `거래 답을 기다리는 동안 시세 구독을 하나 더 쥔다 (watch ${subT0.watch} → ${mid.s.watch} · ${mid.label})`);
  await H(() => document.querySelector('.mining-screen .mn-tab[data-tab="clusters"]')?.click());   // 답이 오기 전에 탭을 바꾼다
  await sleep(40);
  const midTab = await H(() => ({ ...window.__cryptoStub }));
  ok(midTab.watch - midTab.unwatch === 1, `탭을 바꿔도 거래 구독은 남는다 (watch ${midTab.watch} · unwatch ${midTab.unwatch})`);
  await sleep(900);
  const traded = await H(() => ({ s: { ...window.__cryptoStub }, note: window.__notify[window.__notify.length - 1] ?? '' }));
  ok(traded.s.watch === traded.s.unwatch, `답이 오면 거래 구독도 푼다 (watch ${traded.s.watch} · unwatch ${traded.s.unwatch})`);
  ok(/매수 — .*크레딧/.test(traded.note), `거래 토스트 (${traded.note})`);
  await H(() => document.querySelector('.mining-screen .mn-tab[data-tab="exchange"]')?.click());
  await sleep(60);
  await freshPrices(60000);
  await setAmount('0.5');
  t = await trade();
  ok(t.disabled && t.block.startsWith('시세가 오래되었습니다'), `오래된 시세(60 s) → 확정 잠김 (${t.block})`);
  await freshPrices();
  await H(() => document.querySelector('.mining-screen .mn-seg-btn[data-side="sell"]')?.click());
  await setAmount('0.2');
  t = await trade();
  ok(!t.disabled && t.label === '매도', '매도 쪽으로 바꾸면 「매도」');
  await H(() => { const h = window.__game.ctx.housing; h.cryptoQuote = h.__realQuote; h.tradeCrypto = h.__realTrade; delete h.__realQuote; delete h.__realTrade; });

  // 잠긴 코인 = 차트는 보이고 매매는 잠김
  if (locked.length) {
    await H((id) => document.querySelector(`.mining-screen .mn-xrow[data-coin="${id}"]`)?.click(), locked[0].id);
    await sleep(120);
    t = await trade();
    const lockedChart = await H((id) => ({ req: window.__cryptoStub.req.includes(`${id}:1w`), msg: !document.querySelector('.mining-screen .mn-chart-msg').hidden }), locked[0].id);
    ok(t.locked && t.disabled && t.block === (locked[0].reason ?? '잠긴 코인입니다'), `잠긴 코인 → 매매 잠김 + 사유 (${t.block})`);
    ok(lockedChart.req && !lockedChart.msg, '잠긴 코인도 차트 이력을 요청하고 그린다');
  }
  // 탭 전환 → 구독 해제, 다시 거래소 → 다시 구독
  const sub0 = await H(() => ({ ...window.__cryptoStub }));
  await H(() => document.querySelector('.mining-screen .mn-tab[data-tab="clusters"]')?.click());
  await sleep(40);
  const sub1 = await H(() => ({ ...window.__cryptoStub }));
  await H(() => document.querySelector('.mining-screen .mn-tab[data-tab="exchange"]')?.click());
  await sleep(40);
  const sub2 = await H(() => ({ ...window.__cryptoStub }));
  ok(sub1.unwatch === sub0.unwatch + 1 && sub1.watch === sub0.watch && sub2.watch === sub0.watch + 1, `현황 탭 → 구독 해제 · 거래소 → 다시 구독 (${JSON.stringify({ sub0, sub1, sub2 })})`);
  // 오프라인 (열린 코인으로 돌아가서 — 잠긴 코인이면 잠김 사유가 먼저다)
  await H((id) => document.querySelector(`.mining-screen .mn-xrow[data-coin="${id}"]`)?.click(), x.coin);
  await sleep(60);
  await H(() => { const ctx = window.__game.ctx; ctx.net.crypto.available = false; ctx.bus.emit('net:cryptoPrices', { at: Date.now() }); });
  await sleep(80);
  const off = await H(() => ({ msg: document.querySelector('.mining-screen .mn-chart-msg'), t: document.querySelector('.mining-screen .mn-trade-block').textContent }));
  const offMsg = await H(() => { const m = document.querySelector('.mining-screen .mn-chart-msg'); return { shown: !m.hidden, text: m.textContent }; });
  ok(offMsg.shown && offMsg.text === '서버에 연결되어야 합니다', `오프라인 → 차트 자리 문구 (${offMsg.text})`);
  ok(off.t === '서버에 연결되어야 합니다', `오프라인 → 매매 사유 (${off.t})`);
  await H(() => document.querySelector('.mining-screen .mn-tab[data-tab="clusters"]')?.click());
  await sleep(40);
  ok(await H(() => document.querySelectorAll('.mining-screen .mn-crow[data-uid]').length === 2), '오프라인이어도 현황 탭은 그대로');
  // Tab 닫기 → 구독 해제 · 이벤트
  await H(() => { window.__game.ctx.net.crypto.available = true; document.querySelector('.mining-screen .mn-tab[data-tab="exchange"]')?.click(); });
  await sleep(40);
  await tap('Tab');
  await sleep(80);
  const closed = await H(() => ({ hidden: document.querySelector('.menu.mining-screen').hidden, s: { ...window.__cryptoStub }, ev: window.__toggles.some((t) => !t.open && t.page === 'computer') }));
  ok(closed.hidden && closed.ev && closed.s.watch === closed.s.unwatch, `Tab → 컴퓨터 닫힘 · 구독 전부 해제 (${JSON.stringify(closed.s)})`);
  // interact() → 메인 컴퓨터
  const pcInteract = await H((u) => {
    const i = window.__game.ctx.interactables.all().find((x) => x.id === `hub_furn_${u}`);
    if (!i) return 'no interactable';
    i.interact();
    return !document.querySelector('.menu.mining-screen').hidden ? 'ok' : 'not opened';
  }, PC);
  ok(pcInteract === 'ok', `메인 컴퓨터 interact() → 화면 (${pcInteract})`);
  await tap('Escape');
  await waitFor(page, () => document.querySelector('.menu.mining-screen').hidden, 'Esc closes computer', 5000).catch(() => null);
  ok(await H(() => document.querySelector('.menu.mining-screen').hidden), 'Esc → 메인 컴퓨터 닫힘');
  await H(() => window.__game.ctx.housing.openMiningComputer('f-nope'));
  await sleep(30);
  ok((await lastNotify()) === '메인 컴퓨터가 없습니다', '없는 메인 컴퓨터 → 토스트');

  // 모델 스크린샷 — 가까이 (플레이어 카메라 덮어쓰기) + 시설 관리 카메라
  if (SHOTS) {
    for (const [name, off] of [['06-models-near', [2.4, 1.3, 0.9]], ['07-models-near-b', [2.2, 1.6, -1.6]]]) {
      const framed = await H(({ C1, PC, off }) => {
        const ctx = window.__game.ctx;
        const layer = window.__game.getSystem('hub')?.furniture;
        const o1 = layer?.objectOf(C1), o2 = layer?.objectOf(PC);
        if (!o1 || !o2 || typeof ctx.player?.setCameraOverride !== 'function') return false;
        const V = o1.position.constructor;
        const a = new V(), b = new V();
        o1.getWorldPosition(a); o2.getWorldPosition(b);
        const look = a.clone().add(b).multiplyScalar(0.5); look.y = 0.9;
        ctx.player.setCameraOverride(look.clone().add(new V(off[0], off[1], off[2])), look, true);
        return true;
      }, { C1, PC, off });
      if (framed) { await waitSim(0.6); await shot(name); }
    }
    await H(() => window.__game.ctx.player?.setCameraOverride?.(null, undefined, true));
  }
  if (SHOTS) {
    await H((room) => window.__game.ctx.housing.openShipManage(room), ROOM);
    await waitSim(1.2);
    await shot('05-models');
    await H(() => window.__game.ctx.housing.closeShipManage());
  }
  ok((await H(() => window.__lights())) === lightsBefore, `끝까지 점광원 개수 그대로 (${lightsBefore})`);
  ok(errors.length === 0, `페이지 오류 없음`, errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e?.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke-mining-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
