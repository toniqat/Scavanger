// Single-player smoke test for the **가구 화면 개편** (2026-09-12, src/housing/ui): the shared station frame (제목 + `Lv. n` ·
// 우상단 업그레이드 · 좌 패널 / 우 가방 · 함선 창고 · 라벨 없음), the 업그레이드 모달 (클릭은 확정하지 않고 1초 홀드만,
// Tab 은 모달만 닫는다), `HH:MM:SS` 시계 (2026-09-12: `:SS` 도 `HH:MM` 과 **같은 크기**), 재배 스테이션 (잠긴 층 =
// 테두리만, 흙구멍 50 % · 하얀 바가 구멍 윗변까지, **영역별** 호버 카드(흙구멍 = 토양 · 식물 공간 = 작물), 우클릭 흙
// 비우기, 더블클릭 = 함선 창고 먼저, 끌어서 가방에 놓기 = 가방 — **창고 · 가방 블록이 드래그 전에 둘 다 스크롤
// 없이 닿는지**까지 본다(`gridProbe`), the coalesced
// refresh (드롭 한 번 = refresh 한 번 · 재배층 재구축 0회), 분석기 (잠긴 칸 = 빈 칸, 이름 위 · 시간 아래, 우하단 버튼,
// 좌측 레일의 분석 도감 탭, 더블클릭 회수), 배양조 (`.cult-*`, 우클릭 · 더블클릭 수확) and 식탁 (업그레이드 없음).
// 2026-09-13 (요리 재료 티어 — docs/plans/food-tiers.md §5): 수확해도 흙 · 배지가 **비지 않고 내구도가 닳는다**, 토양 카드의
// 내구도 · 보너스 · 소켓 줄, 흙구멍 안 소켓 점, 소켓 드롭(반대 대상 = 거절 토스트 · 가득 = 고르기 메뉴 → 1초 홀드 교체 팝업,
// 클릭 · Enter · 취소로는 교체되지 않는다), 소켓이 있는 흙 비우기 = 홀드 경고, 분석기 계열 칩 · 「?」 → 결과 칩 · 「새 발견」,
// 분석 도감 3구획(실루엣은 호버 카드로 이름이 새지 않는다), 배양조 스캐폴드 드롭 · 「스캐폴드 빼기」 · 종별 고기 · 배지 소켓 점,
// 식탁의 티어 이름 · 능력치 여러 줄.
// Usage: node scripts/smoke-stations.mjs [http://localhost:5273]   (needs `npm run dev`)
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
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1440,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  // wide enough for the two-column station frame (좌 패널 + 우 격자 — below 1100 px the panes stack)
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
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);

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
    window.__notify = [];
    window.__game.ctx.bus.on('ui:notify', (p) => window.__notify.push(p.text));
  });
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  /**
   * 2026-09-12: **화면 전환(타이틀 페이드)이 끝나기를 기다린다.** `.menu.hidden` 은 `opacity` · `visibility` 를 함께
   * 전이시키는데, `visibility` 는 전이가 **끝날 때** 비로소 `hidden` 이 된다 — 그 300 ms 남짓 동안 투명해진 타이틀
   * 화면이 화면 전체를 덮은 채 `pointer-events: auto` 로 남아 **모든 `elementFromPoint` 를 가져간다**(실측: 280 ms
   * 에 `.hidden`, 600 ms 에 `visibility: hidden`). 사람은 그 사이에 함선에 들어가 가구를 놓고 스테이션을 열 수
   * 없지만 스모크는 그보다 빠르다(같은 구간을 350 ms 에 끝낸다) — 그래서 격자 위 hit-test 가 타이틀 버튼을 집어
   * `hit: null` 이 됐다. 게임 쪽 배치 문제가 아니므로 여기서 전환이 끝나기를 기다린다.
   */
  await waitFor(page, () => [...document.querySelectorAll('.menu.hidden')].every((m) => {
    const cs = getComputedStyle(m);
    return cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
  }), '숨은 메뉴의 페이드가 끝난다 (투명한 타이틀 화면이 hit-test 를 먹지 않는다)', 5000);

  /** Units of `defId` into the stash in def-sized stacks. */
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
  const stashQty = (defId) => H((d) => window.__game.ctx.inventory.getStashItems().filter((i) => i.defId === d).reduce((a, i) => a + i.qty, 0), defId);
  const bagQty = (defId) => H((d) => window.__game.ctx.inventory.getAllItems().filter((i) => i.defId === d).reduce((a, i) => a + i.qty, 0), defId);
  const ownQty = async (defId) => (await stashQty(defId)) + (await bagQty(defId));
  /**
   * 2026-09-13: 격자 타일을 칸에 **떨어뜨린 것과 같은 경로**(`panel.dropOn(item, target)` — `mountStationGrids` 의 `onTake`)를
   * 부른다. 진짜 포인터 드래그는 재배 칸 드롭 하나가 이미 본다 — 여기서는 드롭 **이후**의 소켓 · 스캐폴드 흐름이 대상이다.
   */
  const dropVia = (panel, defId, sel) => H(({ panel, defId, sel }) => {
    const ctx = window.__game.ctx;
    const p = ctx.housing[panel];
    const item = [...ctx.inventory.getStashItems(), ...ctx.inventory.getAllItems()].find((i) => i.defId === defId);
    const t = document.querySelector(sel);
    if (!p || !item || !t) return { ok: false, item: !!item, target: !!t };
    p.dropOn(item, t);
    return { ok: true };
  }, { panel, defId, sel });
  /** 공용 홀드 팝업 (`shared/holdAsk`, `.sh-ask[data-ask]`). */
  const askState = (id) => H((id) => {
    const a = document.querySelector(`.sh-ask[data-ask="${id}"]`);
    return a ? { shown: !a.hidden, body: a.querySelector('.sh-ask-body')?.textContent ?? '', buttons: [...a.querySelectorAll('button')].map((b) => b.textContent) } : null;
  }, id);
  const askHold = (id) => H((id) => document.querySelector(`.sh-ask[data-ask="${id}"] button[data-hold]`)
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })), id);
  const askCancel = (id) => H((id) => document.querySelector(`.sh-ask[data-ask="${id}"] button[data-cancel]`)?.click(), id);

  /**
   * 2026-09-12 (회귀 가드): 한 격자 블록(`[data-tg-grid]`)이 **스크롤 없이** 닿는가 — 끌고 있는 동안에는
   * 스크롤할 수 없으므로, 창고 → 흙구멍도 수확물 → 가방도 드래그를 시작하기 전에 대상이 화면 안에 있어야 한다.
   * 한 스크롤에 두 격자를 세로로 이어 붙이면(창고 24행 1381 px · 가방 틀 12행 709 px) 어느 쪽을 위에 올려도
   * 다른 쪽이 화면 밖으로 나갔다 — 지금은 블록마다 자기 스크롤이다 (housing.css 의 `.hs-inv .tg-gridwrap`).
   * 겨눌 좌표(`tx`/`ty`)도 여기서 돌려주므로 드래그 목적지 계산이 한 곳뿐이다.
   */
  const gridProbe = (menu, id) => H(({ menu, id }) => {
    const blk = document.querySelector(`.menu.${menu} [data-tg-grid="${id}"]`);
    if (!blk) return null;
    const box = blk.closest('.tg-scroll');
    const b = blk.getBoundingClientRect(), v = box ? box.getBoundingClientRect() : b;
    const top = Math.max(b.top, v.top), bottom = Math.min(b.bottom, v.bottom);
    const tx = b.left + Math.min(60, b.width / 2), ty = (top + bottom) / 2;
    const el = document.elementFromPoint(tx, ty);
    return { id, tx, ty, visibleH: bottom - top, onScreen: tx > 0 && tx < innerWidth && ty > 0 && ty < innerHeight,
      hit: el?.closest('[data-tg-grid]')?.dataset.tgGrid ?? null,
      top: el ? `${el.tagName.toLowerCase()}.${el.className}` : null,   // `hit` 이 null 일 때 **무엇이 덮었는지**를 말해 준다
      block: { x: b.left, y: b.top, h: b.height }, view: { y: v.top, h: v.height } };
  }, { menu, id });
  const reachable = (p) => !!p && p.visibleH > 40 && p.onScreen && p.hit === p.id;

  /* ── ship set-up: rooms straight in the state (the purpose rules are smoke-housing's business) ── */
  for (const [id, n] of [['mat_scrap', 60], ['mat_cable', 24], ['mat_bio_sample', 30], ['mat_circuit', 16], ['mat_cloth', 10],
    ['mat_alloy', 30], ['mat_power_cell', 4], ['mat_control_module', 2], ['mat_capacitor', 2]]) await giveStash(id, n);
  await H(() => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = 5;
    for (const [i, p] of [[3, 'greenhouse'], [4, 'lab'], [5, 'kitchen'], [6, 'greenhouse']]) h.state.rooms[i].purpose = p;
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
  const dtP = await placeFurn(5, 'furn_dining_table');
  ok(gsP.uid && azP.uid && ctP.uid && dtP.uid, 'craft + place 재배 스테이션 · 분석기 · 배양조 · 식탁', JSON.stringify({ gsP, azP, ctP, dtP }));
  const GS = gsP.uid, AZ = azP.uid, CT = ctP.uid, DT = dtP.uid;

  /* ══ 1. 재배 스테이션 — 공통 틀 ══════════════════════════════════════════ */
  console.log('재배 스테이션');
  await H((u) => window.__game.ctx.housing.openGrowStation(u), GS);
  await waitFor(page, () => !document.querySelector('.menu.grow-station')?.hidden, 'grow station open');
  const frame = await H(() => {
    const r = document.querySelector('.menu.grow-station');
    const head = r.querySelector('.hs-station-head');
    const up = head?.querySelector('.hs-up-open');
    const headRect = head?.getBoundingClientRect();
    const card = (sel) => {
      const c = r.querySelector(sel);
      if (!c) return null;
      const b = c.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom),
        title: c.querySelector('.hs-card-title')?.textContent ?? null,
        grids: [...c.querySelectorAll('[data-tg-grid]')].map((g) => g.dataset.tgGrid), own: c.querySelectorAll('.trade-grids').length };
    };
    return {
      title: head?.querySelector('.title')?.textContent ?? null,
      lv: head?.querySelector('.hs-lv')?.textContent ?? null,
      meta: head?.querySelector('.hs-meta')?.textContent ?? null,
      subtitle: !!r.querySelector('.subtitle'),
      up: up?.textContent ?? null, upRight: up && headRect ? Math.abs(up.getBoundingClientRect().right - headRect.right) < 2 : false,
      upInCard: !!up?.closest('.hs-card-station'),
      labels: [...r.querySelectorAll('.ui-label')].map((e) => e.textContent),
      hints: [...r.querySelectorAll('.hs-pane .hint')].map((e) => e.textContent),
      buttons: [...r.querySelectorAll('.hs-pane-left button, .hs-foot button')].map((b) => b.textContent),
      oldUp: !!r.querySelector('.gs-up'),
      station: card('.hs-card-station'), stash: card('.hs-card-stash'), bag: card('.hs-card-bag'),
      frameBorder: getComputedStyle(r.querySelector('.frame')).borderTopWidth, vw: innerWidth,
      tiers: [...r.querySelectorAll('.gs-tier')].map((t) => ({ locked: t.classList.contains('is-locked'), kids: t.children.length, pots: t.querySelectorAll('.gs-pot[data-tier]').length })),
      tierText: r.querySelector('.gs-tiers').textContent,
    };
  });
  ok(frame.title === '재배 스테이션', `제목에 방 번호가 없다 (${frame.title})`);
  ok(frame.lv === 'Lv. 1' && !frame.subtitle && frame.meta === '성장 속도 +0%', `제목 옆 「Lv. 1」 · 성장 속도 · 설명 줄 없음 (${frame.lv} ${frame.meta})`);
  ok(frame.up === '업그레이드' && frame.upRight && frame.upInCard && !frame.oldUp, '스테이션 카드 우상단 업그레이드 버튼 · 옛 강화 줄 없음', JSON.stringify(frame));
  // 2026-09-13 (사용자 결정 「작업대 제작 화면처럼」): 바깥 틀 없이 카드 셋이 한 줄 — [스테이션] [함선 창고] [가방]
  const { station: cS, stash: cT, bag: cB } = frame;
  ok(!!cS && !!cT && !!cB && cS.right <= cT.left && cT.right <= cB.left && cB.right <= frame.vw && cS.left >= 0
    && Math.abs(cS.top - cT.top) < 2 && Math.abs(cT.top - cB.top) < 2 && frame.frameBorder === '0px',
  `카드 셋이 한 줄 (1440) · 바깥 틀 없음 (${JSON.stringify({ cS, cT, cB })})`);
  ok(cT?.title === '함선 창고' && cB?.title === '가방' && cT.grids.join() === 'stash' && cB.grids.join() === 'bag' && cT.own === 1 && cB.own === 1,
    `격자 카드마다 자기 머리 · 격자 하나 (${JSON.stringify({ cT, cB })})`);
  ok(!frame.labels.some((l) => /가방|창고/.test(l)) && frame.hints.length === 0, `좌 패널에 「가방 · 함선 창고」 라벨 · 안내문 없음 (${JSON.stringify(frame.labels)})`);
  ok(!frame.buttons.some((b) => /수확/.test(b)), `수확 · 모두 수확 버튼 없음 (${JSON.stringify(frame.buttons)})`);
  ok(frame.tiers.length === 3 && frame.tiers.every((t) => !t.locked && t.pots === 3),
    `Lv.1: 세 층 모두 열림 · 층마다 흙구멍 3 (2026-09-13) (${JSON.stringify(frame.tiers)})`);
  ok(!/재배층|사용 중|끌어다/.test(frame.tierText), `층 라벨 · 「N칸 사용 중」 · 「토양을 끌어다 놓으세요」 없음 (${frame.tierText.slice(0, 60)})`);

  const geo = await H(() => {
    const r = document.querySelector('.menu.grow-station');
    // 중앙 층(tier 0)과 그 위에 그려지는 윗층(tier 2) — `GROW_TIER_DRAW_ORDER` 가 위 → 중앙 → 아래
    const mid = r.querySelector('.gs-tier[data-tier-row="0"]');
    const pot = mid.querySelector('.gs-pot[data-tier]').getBoundingClientRect();
    const bar = mid.querySelector('.gs-bar').getBoundingClientRect();
    const plant = mid.querySelector('.gs-plant').getBoundingClientRect();
    const tierAbove = r.querySelector('.gs-tier[data-tier-row="2"]').getBoundingClientRect();
    return { potW: pot.width, potTop: pot.top, potH: pot.height, barTop: bar.top, barBottom: bar.bottom, plantTop: plant.top, plantBottom: plant.bottom, aboveBottom: tierAbove.bottom };
  });
  ok(Math.abs(geo.potW - 39) < 1.5, `흙구멍 지름 50 % (78 → ${geo.potW.toFixed(1)} px)`);
  ok(Math.abs(geo.barTop - (geo.potTop + geo.potH * 0.13)) < 1.5, `하얀 바의 윗변 = 흙구멍 윗변 (${geo.barTop.toFixed(1)} vs ${(geo.potTop + geo.potH * 0.13).toFixed(1)})`);
  ok(Math.abs(geo.plantBottom - geo.potTop) < 1.5 && geo.plantTop >= geo.aboveBottom - 0.5, `작물 자리는 구멍 위, 윗층과 겹치지 않는다 (${JSON.stringify(geo)})`);

  /* ── 드롭: 창고 타일을 흙구멍으로 끌어 놓는다 (진짜 포인터) + 합쳐진 refresh ── */
  await giveStash('soil_mineral', 3); await giveStash('seed_tuber', 4); await giveStash('seed_beanpod', 1);
  // 2026-09-12 (회귀 가드 — 이 화면의 드래그 두 방향이 전부 여기 달려 있다): 창고에서 흙구멍으로 끌든 수확물을
  // 가방에 놓든, **시작 전에 두 격자가 다 보여야** 한다. 한 스크롤에 세로로 이어 붙였을 때는 늘 한 쪽이 밖이었다.
  const probes = { stash: await gridProbe('grow-station', 'stash'), bag: await gridProbe('grow-station', 'bag') };
  ok(reachable(probes.stash) && reachable(probes.bag),
    `창고 · 가방 격자가 드래그 전에 둘 다 보인다 (창고 ${Math.round(probes.stash?.visibleH ?? -1)} px · 가방 ${Math.round(probes.bag?.visibleH ?? -1)} px)`,
    JSON.stringify(probes));
  await H(() => { const gs = window.__game.ctx.housing.growStation; window.__perf0 = { builds: gs.debug.builds, runs: gs.refreshStats.runs, requests: gs.refreshStats.requests }; });
  // the embedded grids repaint on the next animation frame — wait for the new soil tile to exist (found by uid)
  const soilUid = await H(() => window.__game.ctx.inventory.getStashItems().find((i) => i.defId === 'soil_mineral')?.uid ?? null);
  const tileSel = `.menu.grow-station [data-tg-grid="stash"] .inv-tile[data-uid="${soilUid}"]`;
  try { await waitFor(page, (s) => !!document.querySelector(s), 'soil tile in the stash grid', 5000, tileSel); } catch { /* reported below */ }
  const dragFrom = await H((sel) => {
    const tile = document.querySelector(sel);
    if (!tile) return null;
    // 블록마다 자기 스크롤이므로 이것이 스크롤하는 것은 그 블록의 `.inv-grid` 다 (바깥 `.tg-scroll` 은 넘치지 않는다)
    tile.scrollIntoView({ block: 'center' });
    const a = tile.getBoundingClientRect();
    const b = document.querySelector('.menu.grow-station .gs-pot[data-tier="0"][data-slot="0"]').getBoundingClientRect();
    const x = a.left + 20, y = a.top + 20;
    return { x, y, tx: b.left + b.width / 2, ty: b.top + b.height * 0.7,
      srcHit: document.elementFromPoint(x, y)?.closest('[data-tg-grid]')?.dataset.tgGrid ?? null };
  }, tileSel);
  const diag = { soilUid, dragFrom, tiles: await H(() => document.querySelectorAll('.menu.grow-station [data-tg-grid="stash"] .inv-tile').length) };
  if (dragFrom) {
    await page.mouse.move(dragFrom.x, dragFrom.y);
    await page.mouse.down();
    await page.mouse.move(dragFrom.x - 40, dragFrom.y, { steps: 4 });
    await page.mouse.move(dragFrom.tx, dragFrom.ty, { steps: 12 });
    await sleep(60);
    Object.assign(diag, await H((t) => {
      const u = document.elementFromPoint(t.tx, t.ty);
      return { ghost: !!document.querySelector('.tg-ghost'), under: u ? `${u.tagName}.${u.className}` : null,
        down: document.elementFromPoint(t.x, t.y)?.className ?? null };
    }, dragFrom));
    await page.mouse.up();
    await sleep(50);
  }
  if (!(await H((u) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 0)?.soilDefId, GS))) {
    console.log(`  note drag diagnostics: ${JSON.stringify(diag)}`);
  }
  const dropped = await H((u) => {
    const h = window.__game.ctx.housing, gs = h.growStation, p0 = window.__perf0;
    return { soil: h.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 0)?.soilDefId ?? null,
      builds: gs.debug.builds - p0.builds, runs: gs.refreshStats.runs - p0.runs, requests: gs.refreshStats.requests - p0.requests,
      cls: document.querySelector('.gs-slot[data-key="0:0"]').classList.contains('has-soil') };
  }, GS);
  ok(!!dragFrom && dropped.soil === 'soil_mineral' && dropped.cls, `창고의 토양을 흙구멍에 끌어다 놓아 부었다 (${JSON.stringify(dropped)})`);
  ok(dropped.builds === 0, `드롭이 재배층 DOM 을 다시 짓지 않는다 (재구축 ${dropped.builds}회)`);
  ok(dropped.runs === 1 && dropped.requests >= 2, `이벤트 ${dropped.requests}개가 refresh 1회로 합쳐진다 (${dropped.runs}회)`);

  const clock = await H((u) => {
    const h = window.__game.ctx.housing;
    // (드래그가 실패했어도 나머지 검사는 돈다 — 그 실패는 위에서 이미 FAIL 로 셌다)
    if (!h.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 0)?.soilDefId) h.fillSoil(u, 0, 0, 'soil_mineral');
    const r = [h.fillSoil(u, 0, 1, 'soil_mineral'), h.plantSeedAt(u, 0, 0, 'seed_tuber')];
    const t = document.querySelector('.gs-slot[data-key="0:0"] .gs-time');
    return new Promise((res) => queueMicrotask(() => {
      const hm = t.querySelector('.hs-clock-hm'), ss = t.querySelector('.hs-clock-ss');
      res({ r, text: t.textContent, hm: hm?.textContent, ss: ss?.textContent,
        hmPx: hm ? parseFloat(getComputedStyle(hm).fontSize) : 0, ssPx: ss ? parseFloat(getComputedStyle(ss).fontSize) : 0,
        planted: t.parentElement.classList.contains('is-planted') });
    }));
  }, GS);
  ok(clock.r.every((v) => v === null) && CLOCK.test(clock.text ?? '') && /^:\d{2}$/.test(clock.ss ?? ''), `남은 시간 HH:MM:SS (${clock.text})`);
  // 2026-09-12 (사용자 지적 — 분석기에서 초가 너무 작았다): `:SS` 의 절반 크기를 **없앴다**. `.hs-clock-ss` 가
  // `font-size: inherit` 라 스테이션 네 화면이 한 크기를 쓰고, 재배 칸의 「상태가 바뀌어도 높이가 한 픽셀도
  // 변하지 않는다」도 글자 크기가 하나여야 지켜진다. 그래서 이 검사는 「절반」이 아니라 「같다」를 본다.
  ok(clock.ssPx > 0 && Math.abs(clock.ssPx - clock.hmPx) < 0.6, `:SS 는 HH:MM 과 같은 크기 (${clock.hmPx} → ${clock.ssPx} px)`);
  ok(!(await H(() => document.querySelector('.gs-slot[data-key="0:0"]').textContent)).includes('궁합'), '칸 아래 궁합 줄 없음');

  /* ── 호버 카드 — 2026-09-12 (사용자 결정) 부터 **영역별**이다 ──
     흙구멍(`.gs-pot`) 위면 토양 카드(종류 · 속성 · 내구도 · 보너스 · 소켓 · 우클릭 안내), 그 위의 식물 공간(`.gs-plant`) 위면
     작물 카드(씨앗 · 남은 시간 · 궁합 % · 수확물). 예전에는 칸 어디를 짚어도 한 카드가 둘을 다 실었으므로
     이 검사도 한 번의 호버만 봤다 — 이제 두 영역을 따로 짚는다. */
  const hoverTip = (sel, key = '0:0') => H(({ s, key }) => {
    const slot = document.querySelector(`.gs-slot[data-key="${key}"]`);
    const r = slot.getBoundingClientRect();
    // 같은 칸 · 같은 영역이면 카드를 다시 그리지 않으므로 먼저 벗어난다
    document.querySelector('.menu.grow-station .gs-tiers').dispatchEvent(new PointerEvent('pointerleave'));
    slot.querySelector(s).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
    const t = document.querySelector('.menu.grow-station .hs-tip');
    return { shown: !!t && !t.hidden, text: t?.textContent ?? '' };
  }, { s: sel, key });
  const soilTip = await hoverTip('.gs-pot');
  // 2026-09-13: 「남은 수확 n회」 대신 내구도 · 보너스 비율 · 소켓 줄
  ok(soilTip.shown && /토양/.test(soilTip.text) && /속성/.test(soilTip.text) && /내구도/.test(soilTip.text) && /보너스/.test(soilTip.text)
    && /소켓/.test(soilTip.text) && /우클릭: 흙 비우기/.test(soilTip.text) && !/궁합/.test(soilTip.text) && !/남은 수확/.test(soilTip.text),
  `흙구멍 호버 = 토양 카드 (속성 · 내구도 · 보너스 · 소켓 · 우클릭 안내) (${soilTip.text.slice(0, 120)})`);
  const plantTip = await hoverTip('.gs-plant');
  ok(plantTip.shown && /씨앗/.test(plantTip.text) && /남은 시간/.test(plantTip.text) && /궁합/.test(plantTip.text) && /%/.test(plantTip.text) && /수확물/.test(plantTip.text),
    `식물 공간 호버 = 작물 카드 (씨앗 · 남은 시간 · 궁합(%) · 수확물) (${plantTip.text.slice(0, 90)})`);
  await H(() => document.querySelector('.menu.grow-station .gs-tiers').dispatchEvent(new PointerEvent('pointerleave')));
  ok(await H(() => document.querySelector('.menu.grow-station .hs-tip').hidden), '벗어나면 카드가 사라진다');

  /* ── 다 자람 → 「수확 가능」 → 더블클릭 = 함선 창고 먼저 ── */
  const ripen = (uid, tier, slot) => H(({ uid, tier, slot }) => {
    const h = window.__game.ctx.housing;
    const g = h.state.grows.find((x) => x.uid === uid && x.tier === tier && x.slot === slot);
    if (!g || !g.readyAt) return false;
    g.readyAt = Date.now() - 1000; g.plantedAt = g.readyAt - 3600e3;
    h.growStation.refresh();
    return true;
  }, { uid, tier, slot });
  const growInfo = (key) => H(({ u, key }) => window.__game.ctx.housing.getGrowSlots(u).find((s) => `${s.tier}:${s.slot}` === key) ?? null, { u: GS, key });
  ok(await ripen(GS, 0, 0), '재배 칸을 여물게 한다 (readyAt 과거)');
  ok(await H(() => document.querySelector('.gs-slot[data-key="0:0"] .gs-time').textContent === '수확 가능'), '시간 자리에 「수확 가능」');
  const stash0 = await stashQty('crop_tuber'), bag0 = await bagQty('crop_tuber');
  const soilBefore = await growInfo('0:0');
  await H(() => document.querySelector('.gs-slot[data-key="0:0"] .gs-pot').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  const afterDbl = { stash: await stashQty('crop_tuber'), bag: await bagQty('crop_tuber'), slot: await growInfo('0:0') };
  ok(afterDbl.stash > stash0 && afterDbl.bag === bag0 && afterDbl.slot.seedDefId === null,
    `더블클릭 수확 → 함선 창고 (${stash0} → ${afterDbl.stash}, 가방 ${afterDbl.bag})`);
  // 2026-09-13 (요리 재료 티어): 수확해도 칸이 비지 않는다 — 흙은 남고 내구도만 닳는다
  ok(afterDbl.slot.soilDefId === 'soil_mineral' && afterDbl.slot.soilDurabilityMax > 0
    && afterDbl.slot.soilDurability < soilBefore.soilDurability && afterDbl.slot.soilDurability >= 0,
  `흙은 남고 내구도가 닳는다 (${soilBefore.soilDurability} → ${afterDbl.slot.soilDurability} / ${afterDbl.slot.soilDurabilityMax})`);
  ok(await H(() => document.querySelector('.gs-slot[data-key="0:0"]').classList.contains('has-soil')), '수확 뒤에도 흙구멍에 흙이 그대로 그려진다');

  /* ── 끌어서 가방 격자에 놓기 = 가방 ── */
  await H((u) => window.__game.ctx.housing.plantSeedAt(u, 0, 0, 'seed_tuber'), GS);
  await ripen(GS, 0, 0);
  // 겨눌 자리는 위의 `gridProbe` 하나가 정한다 (계산이 한 곳뿐이다). 여기서 다시 재는 이유는 그 사이에 한 번
  // 수확해서 격자 내용이 바뀌었기 때문이고, **드래그 직전의 실제 화면**을 봐야 하기 때문이다.
  const bagAt = await gridProbe('grow-station', 'bag');
  const from = await H(() => {
    const b = document.querySelector('.gs-slot[data-key="0:0"] .gs-pot').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height * 0.7 };
  });
  ok(reachable(bagAt), `가방 격자가 스크롤 없이 닿는다 (보이는 높이 ${Math.round(bagAt?.visibleH ?? -1)} px)`, JSON.stringify(bagAt));
  const bag1 = await bagQty('crop_tuber'), stash1 = await stashQty('crop_tuber');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y, { steps: 3 });
  const ghost = await H(() => !!document.querySelector('.hs-ghost'));
  await page.mouse.move(bagAt.tx, bagAt.ty, { steps: 12 });
  await sleep(60);
  const bagDiag = await H((t) => {
    const u = document.elementFromPoint(t.tx, t.ty);
    return { under: u ? `${u.tagName}.${u.className}` : null, grid: u?.closest('[data-tg-grid]')?.dataset.tgGrid ?? null,
      over: !!document.querySelector('[data-tg-grid].hs-drop-over') };
  }, bagAt);
  await page.mouse.up();
  await sleep(50);
  const bag2 = await bagQty('crop_tuber'), stash2 = await stashQty('crop_tuber');
  ok(ghost, '다 자란 작물을 끌면 고스트가 따라온다');
  ok(bag2 > bag1 && stash2 === stash1, `가방 격자에 놓으면 가방으로만 (${bag1} → ${bag2}, 창고 ${stash1} → ${stash2})`,
    JSON.stringify({ bagDiag, notify: await H(() => window.__notify.slice(-3)) }));
  ok(bagDiag.over && bagDiag.grid === 'bag', `끄는 동안 가방 격자가 강조된다 (${JSON.stringify(bagDiag)})`);
  ok(await H(() => !document.querySelector('.hs-ghost')), '놓으면 고스트가 사라진다');

  /* ── 우클릭 메뉴: 흙 비우기 / 작물 버리고 흙 비우기 ── */
  const ctxMenu = (key) => H((k) => {
    const s = document.querySelector(`.gs-slot[data-key="${k}"]`);
    const r = s.getBoundingClientRect();
    s.querySelector('.gs-pot').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
    const m = document.querySelector('.menu.grow-station .hs-ctx');
    return { shown: !!m && !m.hidden, items: m ? [...m.querySelectorAll('.hs-ctx-item')].map((b) => b.textContent) : [] };
  }, key);
  const m1 = await ctxMenu('0:1');
  ok(m1.shown && m1.items.join() === '흙 비우기', `흙만 있는 칸 우클릭 = 「흙 비우기」 (${JSON.stringify(m1)})`);
  await tap('Escape');
  ok(await H(() => document.querySelector('.menu.grow-station .hs-ctx').hidden && !document.querySelector('.menu.grow-station').hidden), 'Escape 는 메뉴만 닫는다');
  await ctxMenu('0:1');
  await H(() => document.querySelector('.menu.grow-station .hs-ctx .hs-ctx-item').click());
  ok(await H((u) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 1).soilDefId === null, GS), '「흙 비우기」 → 칸이 빈다 (소켓이 없으면 묻지 않는다)');
  await H((u) => { const h = window.__game.ctx.housing; h.fillSoil(u, 0, 2, 'soil_mineral'); h.plantSeedAt(u, 0, 2, 'seed_beanpod'); }, GS);
  const m2 = await ctxMenu('0:2');
  ok(m2.items.join() === '작물 버리고 흙 비우기', `자라는 칸 우클릭 = 「작물 버리고 흙 비우기」 (${JSON.stringify(m2)})`);
  await H(() => document.querySelector('.menu.grow-station .hs-ctx .hs-ctx-item').click());
  ok(await H((u) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 2).soilDefId === null, GS), '작물까지 버리고 비웠다 (`clearSoil(…, true)`)');

  /* ── 2026-09-13 토양 소켓: 반대 대상 거절 · 빈 칸 끼우기 · 흙구멍 안 점 · 가득 → 고르기 → 1초 홀드 교체 · 비우기 경고 ── */
  const socketDefs = await H(() => {
    const l = window.__game.ctx.loot;
    return ['sock_soil_speed_1', 'sock_soil_yield_1', 'sock_medium_speed_1'].map((id) => !!l.getItemDef(id)?.growSocket);
  });
  if (!socketDefs.every(Boolean)) {
    ok(false, `소켓 아이템 def (items 로더의 growSocket) — 에이전트 A 의 표가 아직이면 예상된 실패 (${JSON.stringify(socketDefs)})`);
  } else {
    await giveStash('sock_soil_speed_1', 4); await giveStash('sock_soil_yield_1', 2); await giveStash('sock_medium_speed_1', 3);
    const POT = '.menu.grow-station .gs-pot[data-tier="0"][data-slot="0"]';
    const n0 = await H(() => window.__notify.length);
    const wrong = await dropVia('growStation', 'sock_medium_speed_1', POT);
    await sleep(20);
    const wrongState = { drop: wrong, notify: await H((n) => window.__notify.slice(n), n0), sockets: (await growInfo('0:0')).sockets };
    ok(wrong.ok && wrongState.notify.some((t) => /배양조/.test(t)) && wrongState.sockets.length === 0,
      `배지 소켓을 흙구멍에 놓으면 거절 토스트 (${JSON.stringify(wrongState)})`);

    const slots = (await growInfo('0:0')).socketSlots;
    ok(slots > 0, `광물토의 소켓 칸 = 등급별 (${slots}칸)`);
    const own0 = await ownQty('sock_soil_speed_1');
    for (let i = 0; i < slots; i++) await dropVia('growStation', 'sock_soil_speed_1', POT);
    await sleep(30);
    const filled = await H(() => {
      const d = document.querySelector('.gs-slot[data-key="0:0"] .gs-socks');
      return { hidden: d?.hidden ?? null, dots: d?.children.length ?? 0, on: d?.querySelectorAll('i.on').length ?? 0,
        insidePot: !!d?.closest('.gs-pot'), timeH: document.querySelector('.gs-slot[data-key="0:0"] .gs-time').getBoundingClientRect().height,
        ask: !!document.querySelector('.sh-ask') };
    });
    const info1 = await growInfo('0:0');
    ok(info1.sockets.length === slots && (await ownQty('sock_soil_speed_1')) === own0 - slots && !filled.ask,
      `빈 소켓 칸에는 묻지 않고 끼운다 (${info1.sockets.length} / ${slots}, 보유 ${own0} → ${await ownQty('sock_soil_speed_1')})`);
    ok(!filled.hidden && filled.dots === slots && filled.on === slots && filled.insidePot && Math.abs(filled.timeH - 20) < 0.6,
      `흙구멍 안의 소켓 점 = 칸 수 · 끼운 수, 시계 줄 높이는 그대로 (${JSON.stringify(filled)})`);
    const sockTip = await hoverTip('.gs-pot');
    ok(sockTip.shown && new RegExp(`${slots} / ${slots}칸`).test(sockTip.text) && /성장 속도/.test(sockTip.text),
      `토양 카드의 소켓 줄 (${sockTip.text.slice(0, 160)})`);
    await H(() => document.querySelector('.menu.grow-station .gs-tiers').dispatchEvent(new PointerEvent('pointerleave')));

    // 가득 찬 칸에 덮어 끼우기 → (칸이 둘 이상이면) 교체할 소켓 고르기 → 1초 홀드 경고
    const yield0 = await ownQty('sock_soil_yield_1');
    await dropVia('growStation', 'sock_soil_yield_1', POT);
    await sleep(20);
    if (slots > 1) {
      const picker = await H(() => {
        const m = document.querySelector('.menu.grow-station .hs-ctx');
        return { shown: !!m && !m.hidden, items: m ? [...m.querySelectorAll('.hs-ctx-item')].map((b) => b.textContent) : [] };
      });
      ok(picker.shown && picker.items.length === slots && picker.items.every((t) => /교체/.test(t)), `가득 찬 칸 = 교체할 소켓 고르기 (${JSON.stringify(picker)})`);
      await H(() => document.querySelectorAll('.menu.grow-station .hs-ctx .hs-ctx-item')[1]?.click());
    }
    const ask = await askState('hs-socket-replace');
    ok(!!ask && ask.shown && /빼낼 수 없습니다/.test(ask.body) && /파괴/.test(ask.body) && ask.buttons.join() === '취소,교체',
      `교체 경고 팝업: 「끼운 소켓은 빼낼 수 없습니다 — … 파괴됩니다」 (${JSON.stringify(ask)})`);
    await H(() => document.querySelector('.sh-ask[data-ask="hs-socket-replace"] button[data-hold]')?.click());
    await tap('Enter');
    const idx = slots > 1 ? 1 : 0;
    ok((await growInfo('0:0')).sockets[idx] === 'sock_soil_speed_1' && (await ownQty('sock_soil_yield_1')) === yield0, '클릭 · Enter 로는 교체되지 않는다');
    await askHold('hs-socket-replace');
    await sleep(400);
    ok((await growInfo('0:0')).sockets[idx] === 'sock_soil_speed_1', '홀드 도중에는 아직 교체되지 않는다');
    try { await waitFor(page, ({ u, i }) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 0)?.sockets[i] === 'sock_soil_yield_1', '1초 홀드 → 교체', 4000, { u: GS, i: idx }); } catch { /* reported below */ }
    const replaced = await growInfo('0:0');
    ok(replaced.sockets[idx] === 'sock_soil_yield_1' && replaced.sockets.length === slots && (await ownQty('sock_soil_yield_1')) === yield0 - 1
      && !(await H(() => !!document.querySelector('.sh-ask[data-ask="hs-socket-replace"]'))),
    `1초 홀드 → ${idx + 1}번 소켓을 파괴하고 교체 · 팝업 닫힘 (${JSON.stringify(replaced.sockets)})`);

    // 취소하면 아무 일도 없다
    await dropVia('growStation', 'sock_soil_yield_1', POT);
    await sleep(20);
    if (slots > 1) await H(() => document.querySelector('.menu.grow-station .hs-ctx .hs-ctx-item')?.click());
    await askCancel('hs-socket-replace');
    ok(JSON.stringify((await growInfo('0:0')).sockets) === JSON.stringify(replaced.sockets) && (await ownQty('sock_soil_yield_1')) === yield0 - 1,
      '교체 팝업 「취소」 → 소켓 · 보유 수 그대로');

    // 소켓이 있는 흙 비우기 = 「소켓도 함께 사라집니다」 1초 홀드 경고
    const m3 = await ctxMenu('0:0');
    await H(() => document.querySelector('.menu.grow-station .hs-ctx .hs-ctx-item').click());
    const clearAsk = await askState('hs-soil-clear');
    ok(m3.items.join() === '흙 비우기' && !!clearAsk && clearAsk.shown && /소켓도 함께 사라집니다/.test(clearAsk.body)
      && (await growInfo('0:0')).soilDefId === 'soil_mineral', `소켓이 있는 흙 비우기 → 홀드 경고 (흙은 아직 그대로) (${JSON.stringify(clearAsk)})`);
    await tap('Tab');
    ok(!(await H(() => !!document.querySelector('.sh-ask[data-ask="hs-soil-clear"]'))) && !(await H(() => document.querySelector('.menu.grow-station').hidden))
      && (await growInfo('0:0')).soilDefId === 'soil_mineral', 'Tab 은 경고 팝업만 닫는다 (비우지 않는다 · 패널은 그대로)');
  }

  /* ── 업그레이드 모달 ── */
  const cost = await H((u) => window.__game.ctx.housing.furnitureUpgradeCost(u), GS);
  for (const c of cost ?? []) await giveStash(c.defId, c.qty);
  await H(() => document.querySelector('.menu.grow-station .hs-up-open').click());
  await sleep(30);
  const modal = await H(() => {
    const m = document.querySelector('.menu.grow-station .hs-modal');
    return { shown: !!m && !m.hidden, chips: m?.querySelectorAll('.hs-modal-cost .item-chip').length ?? 0, lv: m?.querySelector('.hs-modal-lv')?.textContent ?? '',
      gain: m?.querySelector('.hs-modal-gain')?.textContent ?? '', ok: !m?.querySelector('.hs-modal-ok')?.disabled, note: m?.querySelector('.hs-modal-note')?.textContent ?? '' };
  });
  ok(modal.shown && modal.chips === (cost?.length ?? -1) && /Lv\. 1\s+→\s+Lv\. 2/.test(modal.lv) && /성장 속도 \+0% → \+15%/.test(modal.gain),
    `업그레이드 모달: 재료 썸네일 ${modal.chips} · ${modal.lv} · ${modal.gain}`, JSON.stringify(modal));
  ok(modal.ok && /초/.test(modal.note), `재료가 있으면 확정 버튼이 열리고 홀드 안내가 붙는다 (${modal.note})`);
  await H(() => document.querySelector('.menu.grow-station .hs-modal-ok').click());
  ok(await H((u) => window.__game.ctx.housing.getPlacedByUid(u).level === 1, GS), '클릭만으로는 강화되지 않는다');
  await tap('Enter');
  ok(await H((u) => window.__game.ctx.housing.getPlacedByUid(u).level === 1 && !document.querySelector('.menu.grow-station .hs-modal').hidden, GS), 'Enter 도 확정하지 않는다');
  await tap('Tab');
  ok(await H(() => document.querySelector('.menu.grow-station .hs-modal').hidden && !document.querySelector('.menu.grow-station').hidden), 'Tab 은 모달만 닫는다 (패널은 그대로)');
  await H(() => document.querySelector('.menu.grow-station .hs-up-open').click());
  await H(() => document.querySelector('.menu.grow-station .hs-modal-ok').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
  await sleep(450);
  const mid = await H((u) => ({ level: window.__game.ctx.housing.getPlacedByUid(u).level, hold: window.__game.ctx.housing.growStation.modal?.holdProgress ?? null }), GS);
  ok(mid.level === 1, `홀드 도중에는 아직 강화되지 않는다 (${JSON.stringify(mid)})`);
  await waitFor(page, (u) => window.__game.ctx.housing.getPlacedByUid(u).level === 2, '1초 홀드 → Lv.2', 4000, GS);
  await sleep(30);
  const up2 = await H(() => {
    const r = document.querySelector('.menu.grow-station');
    return { lv: r.querySelector('.hs-lv').textContent, modal: r.querySelector('.hs-modal').hidden, meta: r.querySelector('.hs-meta').textContent,
      tiers: [...r.querySelectorAll('.gs-tier')].map((t) => t.classList.contains('is-locked')) };
  });
  ok(up2.lv === 'Lv. 2' && up2.modal && up2.tiers.join() === 'false,false,false' && up2.meta === '성장 속도 +15%',
    `1초 홀드 → Lv. 2 · 모달 닫힘 · 성장 속도 +15% (층은 그대로) (${JSON.stringify(up2)})`);
  await tap('Tab');
  ok(await H(() => document.querySelector('.menu.grow-station').hidden), 'Tab → 재배 화면 닫힘');

  /* ══ 2. 분석기 ════════════════════════════════════════════════════════════ */
  console.log('분석기');
  // 2026-09-13: 새 드롭 표본은 계열 3종 — 표가 아직이면 옛 표본(은퇴해도 자기 계열로 해석된다)으로
  const SAMPLE = await H(() => (window.__game.ctx.loot.getItemDef('spec_cell')?.sample ? 'spec_cell' : 'spec_tissue'));
  await giveStash(SAMPLE, 2);
  await H((u) => window.__game.ctx.housing.openAnalyzer(u), AZ);
  await waitFor(page, () => !document.querySelector('.menu.analyzer-panel')?.hidden, 'analyzer open');
  const az = await H(() => {
    const r = document.querySelector('.menu.analyzer-panel');
    return {
      title: r.querySelector('.hs-station-head .title').textContent, lv: r.querySelector('.hs-lv').textContent,
      // 2026-09-12: 탭은 좌 패널 안의 `.hs-tabs` 가 아니라 **화면 맨 왼쪽 공통 레일**(`StationShell.rail` = `.hs-rail`)에 산다
      tabs: [...r.querySelectorAll('.hs-rail .hs-tab')].map((b) => b.textContent),
      dexHidden: r.querySelector('.az-dexhost').hidden,
      slots: [...r.querySelectorAll('.az-slot')].map((s) => ({ locked: s.classList.contains('is-locked'), kids: s.children.length })),
      allBtn: [...r.querySelectorAll('button')].some((b) => /모두 회수/.test(b.textContent)),
      labels: [...r.querySelectorAll('.ui-label')].map((e) => e.textContent),
    };
  });
  ok(az.title === '분석기' && az.lv === 'Lv. 1', `분석기 제목 · Lv (${az.title} ${az.lv})`);
  ok(az.tabs.join() === '해석,분석 도감' && az.dexHidden, `좌측 탭 「해석」 · 「분석 도감」, 도감은 자기 탭에 (${az.tabs})`);
  ok(az.slots.length === 3 && az.slots[0].kids > 0 && az.slots.slice(1).every((s) => s.locked && s.kids === 0), `잠긴 해석 칸 = 빈 칸 (${JSON.stringify(az.slots)})`);
  ok(!az.allBtn && !az.labels.some((l) => /가방|창고|도감/.test(l)), '모두 회수 · 라벨 없음');
  await H(({ u, s }) => window.__game.ctx.housing.startAnalysis(u, 0, s), { u: AZ, s: SAMPLE });
  await sleep(20);
  const run = await H(() => {
    const s = document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"]');
    const body = s.querySelector('.az-slot-body');
    const acts = s.querySelector('.az-acts').getBoundingClientRect(), sr = s.getBoundingClientRect();
    const res = s.querySelector('.az-result');
    return { order: [...body.children].map((c) => c.className.split(' ')[0]), name: s.querySelector('.az-name').textContent, time: s.querySelector('.az-time').textContent,
      text: s.textContent, actsRight: sr.right - acts.right, actsBottom: sr.bottom - acts.bottom,
      fam: s.querySelector('.az-fam')?.hidden ? null : s.querySelector('.az-fam')?.textContent ?? null,
      result: { pending: res?.classList.contains('is-pending') ?? false, text: res?.textContent ?? '', chip: !!res?.querySelector('.item-chip') } };
  });
  ok(run.order[0] === 'az-name' && run.order[1] === 'az-time' && run.name.length > 0 && CLOCK.test(run.time), `이름 위 · 작은 HH:MM:SS 아래 (${run.name} / ${run.time})`);
  ok(!/처음 해석|도감에 있는/.test(run.text), '「처음 해석」 부연 없음');
  ok(run.actsRight >= 0 && run.actsRight < 20 && run.actsBottom >= 0 && run.actsBottom < 20, `회수 · 중단 버튼은 칸 우하단 (${run.actsRight.toFixed(1)}, ${run.actsBottom.toFixed(1)})`);
  // 2026-09-13: 계열 칩 · 해석 중 결과 자리는 「?」 (결과는 넣는 순간 굴렸지만 끝나기 전에는 보이지 않는다)
  ok(!!run.fam && /세포|광물|DNA/.test(run.fam), `표본 칸에 계열 칩 (${run.fam})`);
  ok(run.result.pending && run.result.text === '?' && !run.result.chip, `해석 중 결과 자리 = 「?」 (${JSON.stringify(run.result)})`);
  ok(await H((u) => window.__game.ctx.housing.getAnalyses(u)[0].resultDefId === null, AZ), '해석 중에는 계약도 결과를 숨긴다 (`resultDefId` null)');
  await H((u) => { const h = window.__game.ctx.housing; const a = h.state.analyses.find((x) => x.uid === u && x.slot === 0); a.readyAt = Date.now() - 1000; h.analyzerPanel.refresh(); }, AZ);
  ok(await H(() => document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"] .az-time').textContent === '해석 완료'), '끝나면 「해석 완료」');
  const done = await H((u) => {
    const info = window.__game.ctx.housing.getAnalyses(u)[0];
    const res = document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"] .az-result');
    return { resultDefId: info.resultDefId, resultQty: info.resultQty, firstTime: info.firstTime,
      chip: res?.querySelector('.item-chip')?.dataset.defId ?? null, isNew: !!res?.querySelector('.az-new'), pending: res?.classList.contains('is-pending') };
  }, AZ);
  ok(!!done.resultDefId && done.chip === done.resultDefId && !done.pending && done.isNew === !!done.firstTime && done.firstTime,
    `끝나면 결과 칩 (${done.resultDefId} ×${done.resultQty}) + 「새 발견」 (${JSON.stringify(done)})`);
  const reward = done.resultDefId;
  const rw0 = await stashQty(reward);
  await H(() => document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"] .az-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  ok(await stashQty(reward) > rw0 && await H((u) => window.__game.ctx.housing.getAnalyses(u)[0].sampleDefId === null, AZ), `더블클릭 회수 → 함선 창고 (${reward})`);
  await H(() => document.querySelector('.menu.analyzer-panel .hs-tab[data-tab="dex"]').click());
  await sleep(20);
  const dex = await H((found) => {
    const r = document.querySelector('.menu.analyzer-panel');
    const host = r.querySelector('.az-dexhost');
    return { dexHidden: host.hidden, slotsHidden: r.querySelector('.az-slots').hidden, rows: host.querySelectorAll('.az-dex-row').length,
      active: r.querySelector('.hs-tab.is-active')?.dataset.tab,
      fams: [...host.querySelectorAll('.az-dex-fam')].map((f) => f.dataset.family),
      lv: [...host.querySelectorAll('.az-dex-lv')].map((e) => e.textContent),
      mul: host.querySelector('.az-dex-mul')?.textContent ?? '',
      owned: !!host.querySelector(`.az-dex-row.owned[data-def-id-row="${found}"] .item-chip[data-def-id="${found}"]`),
      leak: host.querySelectorAll('.az-dex-row:not(.owned) [data-def-id]').length,
      unknown: [...host.querySelectorAll('.az-dex-row.is-unknown .az-dex-title')].map((e) => e.textContent),
      locked: [...host.querySelectorAll('.az-dex-row.is-locked .az-dex-title')].map((e) => e.textContent) };
  }, reward);
  ok(!dex.dexHidden && dex.slotsHidden && dex.rows > 0 && dex.active === 'dex', `분석 도감 탭 (${dex.rows}행)`);
  ok(dex.fams.length === 3 && dex.lv.every((t) => /^Lv\.\d/.test(t)) && /해석 시간 ×/.test(dex.mul), `계열 3구획 · Lv · 해석 시간 배수 (${JSON.stringify({ fams: dex.fams, lv: dex.lv, mul: dex.mul })})`);
  ok(dex.owned, `회수한 산출물은 도감에 아이템 칩으로 (${reward})`);
  ok(dex.leak === 0 && dex.unknown.every((t) => t === '???') && dex.locked.every((t) => /^Lv\.\d 해금$/.test(t)) && dex.locked.length > 0,
    `미발견 = 실루엣 + 「???」 (호버 카드로 이름이 새지 않는다) · 잠김 = 「Lv.n 해금」 (${JSON.stringify({ leak: dex.leak, unknown: dex.unknown.length, locked: dex.locked.slice(0, 2) })})`);
  await tap('Tab');

  /* ══ 3. 배양조 ════════════════════════════════════════════════════════════ */
  console.log('배양조');
  // 2026-09-13: 옛 세포주는 은퇴해 배양조가 받지 않는다 — 스캐폴드 산출이 있는 새 세포주를 쓴다 (표가 아직이면 아무 세포주나)
  const STRAIN = await H(() => {
    const l = window.__game.ctx.loot;
    const ok = (d) => !!d && !!d.strain && !d.retired;
    if (ok(l.getItemDef('cell_cow'))) return 'cell_cow';
    return l.getAllItemDefs().find((d) => ok(d) && d.strain.scaffoldOutputDefId)?.id ?? l.getAllItemDefs().find(ok)?.id ?? 'strain_algae';
  });
  await giveStash('mat_medium_basic', 1); await giveStash(STRAIN, 3);
  await H((u) => window.__game.ctx.housing.openCultureTank(u), CT);
  await waitFor(page, () => !document.querySelector('.menu.culture-tank')?.hidden, 'culture tank open');
  const started = await H(({ u, s }) => { const h = window.__game.ctx.housing; return [h.fillMedium(u, 0, 'mat_medium_basic'), h.insertStrain(u, 0, s)]; }, { u: CT, s: STRAIN });
  await sleep(20);
  const ct = await H(() => {
    const r = document.querySelector('.menu.culture-tank');
    return { title: r.querySelector('.hs-station-head .title').textContent,
      cols: getComputedStyle(r.querySelector('.cult-slots')).gridTemplateColumns.split(' ').filter(Boolean).length,
      slots: [...r.querySelectorAll('.cult-slot')].map((s) => {
        const g = s.querySelector('.cult-glass')?.getBoundingClientRect();
        return { locked: s.classList.contains('is-locked'), drop: !!s.querySelector('.cult-cell[data-slot]'), lock: s.querySelector('.cult-lock')?.textContent ?? null,
          w: Math.round(g?.width ?? 0), h: Math.round(g?.height ?? 0), top: Math.round(s.getBoundingClientRect().top) };
      }),
      lvl: r.querySelector('.cult-slot[data-slot="0"] .cult-fluid')?.style.getPropertyValue('--lvl') ?? '',
      fills: window.__game.ctx.housing.cultureTank.debug.fills,
      oldCls: r.querySelectorAll('[class^="ct-"], [class*=" ct-"]').length,
      buttons: [...r.querySelectorAll('.hs-pane-left button')].length,
      time: r.querySelector('.cult-slot[data-slot="0"] .cult-time')?.textContent ?? '' };
  });
  ok(started.every((v) => v === null) && ct.title === '배양조' && ct.oldCls === 0, `배양조 — 옛 .ct-* 이름 없음 (기업 화면과 겹치지 않는다) (${ct.oldCls}) ${JSON.stringify(started)}`);
  // 2026-09-13 (사용자 결정): 세로로 긴 유리 배양관 3개가 늘 3열로 나란히, 잠긴 관은 점선 + 「Lv.N 필요」
  ok(ct.cols === 3 && ct.slots.length === 3 && ct.slots[0].drop && ct.slots[0].h > ct.slots[0].w * 2 && ct.slots.every((s) => s.top === ct.slots[0].top),
    `배양관 3개가 한 줄 3열 · 세로로 긴 유리관 (${JSON.stringify(ct.slots)})`);
  ok(ct.slots.slice(1).every((s, i) => s.locked && !s.drop && s.lock === `Lv.${i + 2} 필요`) && ct.buttons === 0 && CLOCK.test(ct.time),
    `잠긴 관 = 드롭 대상 아님 + 「Lv.N 필요」 · 칸 버튼 없음 · HH:MM:SS (${ct.time})`);
  ok(ct.lvl === '1.000' && ct.fills >= 1, `배지를 부으면 그 관의 액체가 차오른다 (--lvl ${ct.lvl} = 새 배지 내구도 가득, 연출 ${ct.fills}회)`);
  const cm = await H(() => {
    const c = document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-cell');
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    const m = document.querySelector('.menu.culture-tank .hs-ctx');
    return { shown: !m.hidden, items: [...m.querySelectorAll('.hs-ctx-item')].map((b) => b.textContent) };
  });
  ok(cm.shown && cm.items.join() === '세포주 버리고 배지 비우기', `배양 중인 칸 우클릭 (${JSON.stringify(cm)})`);
  await tap('Escape');
  const ctInfo = () => H((u) => window.__game.ctx.housing.getCultureSlots(u)[0], CT);
  const ripenCulture = () => H((u) => { const h = window.__game.ctx.housing; const c = h.state.cultures.find((x) => x.uid === u && x.slot === 0); c.readyAt = Date.now() - 1000; h.cultureTank.refresh(); }, CT);
  const ctYield = (await ctInfo()).yieldDefId;
  await ripenCulture();
  ok(await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-time').textContent === '수확 가능'), '배양 끝 → 「수확 가능」');
  const cy0 = await stashQty(ctYield);
  await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  ok(await stashQty(ctYield) > cy0, `더블클릭 수확 → 함선 창고 (${ctYield})`);
  await sleep(30);
  const afterHarvest = await ctInfo();
  const lvlAfter = await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-fluid').style.getPropertyValue('--lvl'));
  const wantLvl = afterHarvest.mediumDurabilityMax > 0 ? (afterHarvest.mediumDurability / afterHarvest.mediumDurabilityMax).toFixed(3) : null;
  // 2026-09-13 (요리 재료 티어): 배지는 비지 않고 내구도가 닳는다 — 액체 높이 = 내구도 ÷ 최대
  ok(afterHarvest.mediumDefId === 'mat_medium_basic' && !afterHarvest.strainDefId && wantLvl !== null && lvlAfter === wantLvl && Number(lvlAfter) < 1,
    `수확해도 배지는 남고 내구도만 닳아 액체가 ${lvlAfter} (${afterHarvest.mediumDurability} / ${afterHarvest.mediumDurabilityMax})`);
  ok(/^내구도 \d+\/\d+$/.test(await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-time').textContent)), '배지만 있는 관 아래 줄 = 「내구도 n/max」');

  /* ── 2026-09-13 배양 스캐폴드 · 배지 소켓 ── */
  const scafDef = await H(() => !!window.__game.ctx.loot.getItemDef('food_scaffold')?.scaffold);
  const CELL = '.menu.culture-tank .cult-cell[data-slot="0"]';
  if (!scafDef) {
    ok(false, '배양 스캐폴드 def (items 로더의 scaffold) — 에이전트 A 의 표가 아직이면 예상된 실패');
  } else {
    await giveStash('food_scaffold', 2);
    const sc0 = await ownQty('food_scaffold');
    const scDrop = await dropVia('cultureTank', 'food_scaffold', CELL);
    // 격자는 opacity 로 나타난다 — 전역 전이가 걸려 있어도 끝날 때까지 기다린다 (20 ms 에 재면 0 이었다)
    try {
      await waitFor(page, () => parseFloat(getComputedStyle(document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-scaffold')).opacity) > 0.5,
        'scaffold lattice visible', 3000);
    } catch { /* reported below */ }
    const scState = await H(() => {
      const s = document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"]');
      return { cls: s.classList.contains('has-scaffold'), op: parseFloat(getComputedStyle(s.querySelector('.cult-scaffold')).opacity) };
    });
    ok(scDrop.ok && (await ctInfo()).scaffoldDefId === 'food_scaffold' && (await ownQty('food_scaffold')) === sc0 - 1 && scState.cls && scState.op > 0.5,
      `스캐폴드를 배양관에 놓으면 들어가고 격자가 보인다 (${JSON.stringify(scState)})`);
    const cm2 = await H(() => {
      const c = document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-cell');
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      const m = document.querySelector('.menu.culture-tank .hs-ctx');
      return { shown: !m.hidden, items: [...m.querySelectorAll('.hs-ctx-item')].map((b) => b.textContent) };
    });
    ok(cm2.shown && cm2.items.join() === '스캐폴드 빼기,배지 비우기', `세포주 없는 스캐폴드 칸 우클릭 = 「스캐폴드 빼기」 · 「배지 비우기」 (${JSON.stringify(cm2)})`);
    await H(() => document.querySelector('.menu.culture-tank .hs-ctx .hs-ctx-item').click());
    await sleep(20);
    ok(!(await ctInfo()).scaffoldDefId && (await ownQty('food_scaffold')) === sc0
      && !(await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"]').classList.contains('has-scaffold'))),
    '「스캐폴드 빼기」 → 되돌려받고 격자가 사라진다');

    // 배지 소켓 — 반대 대상(토양 소켓)은 거절 · 배지 소켓은 끼운다 → 유리 안 점
    if (socketDefs.every(Boolean)) {
      const n1 = await H(() => window.__notify.length);
      await dropVia('cultureTank', 'sock_soil_speed_1', CELL);
      await sleep(20);
      ok((await H((n) => window.__notify.slice(n), n1)).some((t) => /재배 스테이션/.test(t)) && (await ctInfo()).sockets.length === 0, '토양 소켓을 배양관에 놓으면 거절 토스트');
      await dropVia('cultureTank', 'sock_medium_speed_1', CELL);
      await sleep(20);
      const ms = await H(() => {
        const d = document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-socks');
        return { hidden: d?.hidden ?? null, dots: d?.children.length ?? 0, on: d?.querySelectorAll('i.on').length ?? 0 };
      });
      const mInfo = await ctInfo();
      ok(mInfo.sockets.join() === 'sock_medium_speed_1' && !ms.hidden && ms.dots === mInfo.socketSlots && ms.on === 1,
        `배지 소켓을 끼우면 유리 안의 점 ${ms.on} / ${ms.dots} (${JSON.stringify(ms)})`);
      // 가득 채운 뒤 덮어 끼우기 → 교체 팝업 (고르기는 칸이 둘 이상일 때)
      for (let i = mInfo.sockets.length; i < mInfo.socketSlots; i++) await dropVia('cultureTank', 'sock_medium_speed_1', CELL);
      await sleep(20);
      await dropVia('cultureTank', 'sock_medium_speed_1', CELL);
      await sleep(20);
      if (mInfo.socketSlots > 1) await H(() => document.querySelector('.menu.culture-tank .hs-ctx .hs-ctx-item')?.click());
      const mAsk = await askState('hs-socket-replace');
      ok(!!mAsk && mAsk.shown && /파괴/.test(mAsk.body), `가득 찬 배지에 덮어 끼우면 같은 교체 팝업 (${JSON.stringify(mAsk)})`);
      await askCancel('hs-socket-replace');
    }

    // 스캐폴드 + 세포주 → 종별 고기 (산출물 = 세포주의 스캐폴드 산출) → 수확하면 스캐폴드 소모 · 배지는 남는다
    await dropVia('cultureTank', 'food_scaffold', CELL);
    const out = await H((s) => window.__game.ctx.loot.getItemDef(s)?.strain?.scaffoldOutputDefId ?? null, STRAIN);
    const ins = await H(({ u, s }) => window.__game.ctx.housing.insertStrain(u, 0, s), { u: CT, s: STRAIN });
    await sleep(20);
    const meatInfo = await ctInfo();
    ok(ins === null && !!out && meatInfo.yieldDefId === out, `스캐폴드 칸의 세포주 → 산출물 = 종별 고기 (${meatInfo.yieldDefId}, 기대 ${out}) ${ins ?? ''}`);
    const ctTip = await H(() => {
      const r = document.querySelector('.menu.culture-tank');
      r.querySelector('.cult-slots').dispatchEvent(new PointerEvent('pointerleave'));
      r.querySelector('.cult-slot[data-slot="0"] .cult-cell').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 300, clientY: 300 }));
      const t = r.querySelector('.hs-tip');
      return { shown: !!t && !t.hidden, text: t?.textContent ?? '' };
    });
    ok(ctTip.shown && /내구도/.test(ctTip.text) && /배양 속도/.test(ctTip.text) && /스캐폴드/.test(ctTip.text) && /산출물/.test(ctTip.text)
      && (!socketDefs.every(Boolean) || /소켓/.test(ctTip.text)),
    `배양관 호버 카드: 내구도 · 배양 속도 · 소켓 · 스캐폴드 · 산출물 (${ctTip.text.slice(0, 160)})`);
    await H(() => document.querySelector('.menu.culture-tank .cult-slots').dispatchEvent(new PointerEvent('pointerleave')));
    await ripenCulture();
    const meat0 = out ? await ownQty(out) : 0;
    await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await sleep(20);
    const afterMeat = await ctInfo();
    ok(!!out && (await ownQty(out)) > meat0 && !afterMeat.scaffoldDefId && afterMeat.mediumDefId === 'mat_medium_basic',
      `종별 고기 수확 → 스캐폴드 소모 · 배지는 남는다 (${meat0} → ${out ? await ownQty(out) : '?'})`);
  }
  await tap('Tab');

  /* ══ 4. 식탁 ══════════════════════════════════════════════════════════════ */
  console.log('식탁');
  const MEAL = await H(() => {
    const l = window.__game.ctx.loot;
    const d = l.getItemDef('meal_sausage');
    if (d?.meal?.effects?.length > 1) return d.id;
    return l.getAllItemDefs().find((x) => x.meal && !x.retired && x.meal.effects?.length > 1)?.id ?? null;
  });
  if (MEAL) await giveStash(MEAL, 1);
  await H((u) => window.__game.ctx.housing.openDiningTable(u), DT);
  await waitFor(page, () => !document.querySelector('.menu.dining-table')?.hidden, 'dining open');
  const dt = await H(() => {
    const r = document.querySelector('.menu.dining-table');
    return { title: r.querySelector('.hs-station-head .title').textContent, up: !!r.querySelector('.hs-up-open'), lvHidden: r.querySelector('.hs-lv').hidden,
      subtitle: !!r.querySelector('.subtitle'), grids: !!r.querySelector('.hs-pane-right .trade-grids'),
      labels: [...r.querySelectorAll('.ui-label')].map((e) => e.textContent) };
  });
  ok(dt.title === '식탁' && !dt.up && dt.lvHidden && !dt.subtitle, `식탁: 같은 틀 · 업그레이드 · Lv 없음 (${JSON.stringify(dt)})`);
  ok(dt.grids && !dt.labels.some((l) => /가방|창고/.test(l)), '식탁 우 패널 = 격자, 「가방 · 함선 창고」 라벨 없음');
  if (!MEAL) {
    ok(false, '능력치가 여러 줄인 요리 def (items 로더의 meal.effects) — 에이전트 A 의 표가 아직이면 예상된 실패');
  } else {
    const row = await H((id) => {
      const def = window.__game.ctx.loot.getItemDef(id);
      const r = [...document.querySelectorAll('.menu.dining-table .dt-row')].find((x) => x.querySelector(`.item-chip[data-def-id="${id}"]`));
      return { tier: r?.querySelector('.dt-tier')?.textContent ?? null, effects: r?.querySelector('.dt-effects')?.textContent ?? '', n: def.meal.effects.length, t: def.meal.tier };
    }, MEAL);
    ok(row.tier === ({ 1: '채소 요리', 2: '페이스트 요리', 3: '고기 요리', 4: '유제품 요리' })[row.t] && row.effects.split(' · ').length === row.n,
      `가진 요리 줄 = 티어 이름 + 능력치 ${row.n}줄 전부 (${JSON.stringify(row)})`);
  }
  await tap('Tab');

  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
