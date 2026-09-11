// Single-player smoke test for the **가구 화면 개편** (2026-09-12, src/housing/ui): the shared station frame (제목 + `Lv. n` ·
// 우상단 업그레이드 · 좌 패널 / 우 가방 · 함선 창고 · 라벨 없음), the 업그레이드 모달 (클릭은 확정하지 않고 1초 홀드만,
// Tab 은 모달만 닫는다), `HH:MM:SS` 시계 (2026-09-12: `:SS` 도 `HH:MM` 과 **같은 크기**), 재배 스테이션 (잠긴 층 =
// 테두리만, 흙구멍 50 % · 하얀 바가 구멍 윗변까지, **영역별** 호버 카드(흙구멍 = 토양 · 식물 공간 = 작물), 우클릭 흙
// 비우기, 더블클릭 = 함선 창고 먼저, 끌어서 가방에 놓기 = 가방 — **창고 · 가방 블록이 드래그 전에 둘 다 스크롤
// 없이 닿는지**까지 본다(`gridProbe`), the coalesced
// refresh (드롭 한 번 = refresh 한 번 · 재배층 재구축 0회), 분석기 (잠긴 칸 = 빈 칸, 이름 위 · 시간 아래, 우하단 버튼,
// 좌측 레일의 해석 도감 탭, 더블클릭 회수), 배양조 (`.cult-*`, 우클릭 · 더블클릭 수확) and 식탁 (업그레이드 없음).
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
    return {
      title: head?.querySelector('.title')?.textContent ?? null,
      lv: head?.querySelector('.hs-lv')?.textContent ?? null,
      subtitle: !!r.querySelector('.subtitle'),
      up: up?.textContent ?? null, upRight: up && headRect ? Math.abs(up.getBoundingClientRect().right - headRect.right) < 2 : false,
      labels: [...r.querySelectorAll('.ui-label')].map((e) => e.textContent),
      hints: [...r.querySelectorAll('.hs-pane .hint')].map((e) => e.textContent),
      buttons: [...r.querySelectorAll('.hs-pane-left button, .hs-foot button')].map((b) => b.textContent),
      oldUp: !!r.querySelector('.gs-up'),
      grids: !!r.querySelector('.hs-pane-right .trade-grids'),
      panes: r.querySelectorAll('.hs-station-body > .hs-pane').length,
      tiers: [...r.querySelectorAll('.gs-tier')].map((t) => ({ locked: t.classList.contains('is-locked'), kids: t.children.length, pots: t.querySelectorAll('.gs-pot[data-tier]').length })),
      tierText: r.querySelector('.gs-tiers').textContent,
    };
  });
  ok(frame.title === '재배 스테이션', `제목에 방 번호가 없다 (${frame.title})`);
  ok(frame.lv === 'Lv. 1' && !frame.subtitle, `제목 옆 「Lv. 1」 · 설명 줄 없음 (${frame.lv})`);
  ok(frame.up === '업그레이드' && frame.upRight && !frame.oldUp, '우상단 업그레이드 버튼 · 옛 강화 줄 없음', JSON.stringify(frame));
  ok(frame.panes === 2 && frame.grids, '좌 패널 + 우 패널(가방 · 함선 창고 격자)');
  ok(!frame.labels.some((l) => /가방|창고/.test(l)) && frame.hints.length === 0, `「가방 · 함선 창고」 라벨 · 안내문 없음 (${JSON.stringify(frame.labels)})`);
  ok(!frame.buttons.some((b) => /수확/.test(b)), `수확 · 모두 수확 버튼 없음 (${JSON.stringify(frame.buttons)})`);
  ok(frame.tiers.length === 3 && frame.tiers[0].locked && frame.tiers[0].kids === 0 && frame.tiers[2].locked && frame.tiers[2].kids === 0
    && !frame.tiers[1].locked && frame.tiers[1].pots === 3, `Lv.1: 위 · 아래 층은 테두리만, 중앙 층 흙구멍 3 (${JSON.stringify(frame.tiers)})`);
  ok(!/재배층|사용 중|끌어다/.test(frame.tierText), `층 라벨 · 「N칸 사용 중」 · 「토양을 끌어다 놓으세요」 없음 (${frame.tierText.slice(0, 60)})`);

  const geo = await H(() => {
    const r = document.querySelector('.menu.grow-station');
    const pot = r.querySelector('.gs-pot[data-tier]').getBoundingClientRect();
    const bar = r.querySelector('.gs-bar').getBoundingClientRect();
    const plant = r.querySelector('.gs-plant').getBoundingClientRect();
    const tierAbove = r.querySelectorAll('.gs-tier')[0].getBoundingClientRect();
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
     흙구멍(`.gs-pot`) 위면 토양 카드(종류 · 속성 · 남은 수확 · 우클릭 안내), 그 위의 식물 공간(`.gs-plant`) 위면
     작물 카드(씨앗 · 남은 시간 · 궁합 % · 수확물). 예전에는 칸 어디를 짚어도 한 카드가 둘을 다 실었으므로
     이 검사도 한 번의 호버만 봤다 — 이제 두 영역을 따로 짚는다. */
  const hoverTip = (sel) => H((s) => {
    const slot = document.querySelector('.gs-slot[data-key="0:0"]');
    const r = slot.getBoundingClientRect();
    slot.querySelector(s).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
    const t = document.querySelector('.menu.grow-station .hs-tip');
    return { shown: !!t && !t.hidden, text: t?.textContent ?? '' };
  }, sel);
  const soilTip = await hoverTip('.gs-pot');
  ok(soilTip.shown && /토양/.test(soilTip.text) && /속성/.test(soilTip.text) && /남은 수확/.test(soilTip.text) && /우클릭: 흙 비우기/.test(soilTip.text)
    && !/궁합/.test(soilTip.text), `흙구멍 호버 = 토양 카드 (속성 · 남은 수확 · 우클릭 안내) (${soilTip.text.slice(0, 90)})`);
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
  ok(await ripen(GS, 0, 0), '재배 칸을 여물게 한다 (readyAt 과거)');
  ok(await H(() => document.querySelector('.gs-slot[data-key="0:0"] .gs-time').textContent === '수확 가능'), '시간 자리에 「수확 가능」');
  const stash0 = await stashQty('crop_tuber'), bag0 = await bagQty('crop_tuber');
  await H(() => document.querySelector('.gs-slot[data-key="0:0"] .gs-pot').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  const afterDbl = { stash: await stashQty('crop_tuber'), bag: await bagQty('crop_tuber'),
    slot: await H((u) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 0), GS) };
  ok(afterDbl.stash > stash0 && afterDbl.bag === bag0 && afterDbl.slot.seedDefId === null && afterDbl.slot.soilUsesLeft === 4,
    `더블클릭 수확 → 함선 창고 (${stash0} → ${afterDbl.stash}, 가방 ${afterDbl.bag}), 흙 5 → ${afterDbl.slot.soilUsesLeft}회`);

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
  ok(await H((u) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 1).soilDefId === null, GS), '「흙 비우기」 → 칸이 빈다');
  await H((u) => { const h = window.__game.ctx.housing; h.fillSoil(u, 0, 2, 'soil_mineral'); h.plantSeedAt(u, 0, 2, 'seed_beanpod'); }, GS);
  const m2 = await ctxMenu('0:2');
  ok(m2.items.join() === '작물 버리고 흙 비우기', `자라는 칸 우클릭 = 「작물 버리고 흙 비우기」 (${JSON.stringify(m2)})`);
  await H(() => document.querySelector('.menu.grow-station .hs-ctx .hs-ctx-item').click());
  ok(await H((u) => window.__game.ctx.housing.getGrowSlots(u).find((s) => s.tier === 0 && s.slot === 2).soilDefId === null, GS), '작물까지 버리고 비웠다 (`clearSoil(…, true)`)');

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
  ok(modal.shown && modal.chips === (cost?.length ?? -1) && /Lv\. 1\s+→\s+Lv\. 2/.test(modal.lv) && /아래 재배층/.test(modal.gain),
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
    return { lv: r.querySelector('.hs-lv').textContent, modal: r.querySelector('.hs-modal').hidden,
      tiers: [...r.querySelectorAll('.gs-tier')].map((t) => t.classList.contains('is-locked')) };
  });
  ok(up2.lv === 'Lv. 2' && up2.modal && up2.tiers.join() === 'true,false,false', `1초 홀드 → Lv. 2 · 모달 닫힘 · 아래 층 개방 (${JSON.stringify(up2)})`);
  await tap('Tab');
  ok(await H(() => document.querySelector('.menu.grow-station').hidden), 'Tab → 재배 화면 닫힘');

  /* ══ 2. 분석기 ════════════════════════════════════════════════════════════ */
  console.log('분석기');
  await giveStash('spec_tissue', 2);
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
  ok(az.tabs.join() === '해석,해석 도감' && az.dexHidden, `좌측 탭 「해석」 · 「해석 도감」, 도감은 자기 탭에 (${az.tabs})`);
  ok(az.slots.length === 3 && az.slots[0].kids > 0 && az.slots.slice(1).every((s) => s.locked && s.kids === 0), `잠긴 해석 칸 = 빈 칸 (${JSON.stringify(az.slots)})`);
  ok(!az.allBtn && !az.labels.some((l) => /가방|창고|도감/.test(l)), '모두 회수 · 라벨 없음');
  await H((u) => window.__game.ctx.housing.startAnalysis(u, 0, 'spec_tissue'), AZ);
  await sleep(20);
  const run = await H(() => {
    const s = document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"]');
    const body = s.querySelector('.az-slot-body');
    const acts = s.querySelector('.az-acts').getBoundingClientRect(), sr = s.getBoundingClientRect();
    return { order: [...body.children].map((c) => c.className.split(' ')[0]), name: s.querySelector('.az-name').textContent, time: s.querySelector('.az-time').textContent,
      text: s.textContent, actsRight: sr.right - acts.right, actsBottom: sr.bottom - acts.bottom };
  });
  ok(run.order[0] === 'az-name' && run.order[1] === 'az-time' && run.name.length > 0 && CLOCK.test(run.time), `이름 위 · 작은 HH:MM:SS 아래 (${run.name} / ${run.time})`);
  ok(!/처음 해석|도감에 있는/.test(run.text), '「처음 해석」 부연 없음');
  ok(run.actsRight >= 0 && run.actsRight < 20 && run.actsBottom >= 0 && run.actsBottom < 20, `회수 · 중단 버튼은 칸 우하단 (${run.actsRight.toFixed(1)}, ${run.actsBottom.toFixed(1)})`);
  const reward = await H((u) => window.__game.ctx.housing.getAnalyses(u)[0].rewardDefId, AZ);
  await H((u) => { const h = window.__game.ctx.housing; const a = h.state.analyses.find((x) => x.uid === u && x.slot === 0); a.readyAt = Date.now() - 1000; h.analyzerPanel.refresh(); }, AZ);
  ok(await H(() => document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"] .az-time').textContent === '해석 완료'), '끝나면 「해석 완료」');
  const rw0 = await stashQty(reward);
  await H(() => document.querySelector('.menu.analyzer-panel .az-slot[data-slot="0"] .az-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  ok(await stashQty(reward) > rw0 && await H((u) => window.__game.ctx.housing.getAnalyses(u)[0].sampleDefId === null, AZ), `더블클릭 회수 → 함선 창고 (${reward})`);
  await H(() => document.querySelector('.menu.analyzer-panel .hs-tab[data-tab="dex"]').click());
  const dex = await H(() => {
    const r = document.querySelector('.menu.analyzer-panel');
    return { dexHidden: r.querySelector('.az-dexhost').hidden, slotsHidden: r.querySelector('.az-slots').hidden, rows: r.querySelectorAll('.az-dexhost .az-dex-row').length,
      active: r.querySelector('.hs-tab.is-active')?.dataset.tab };
  });
  ok(!dex.dexHidden && dex.slotsHidden && dex.rows > 0 && dex.active === 'dex', `해석 도감 탭 (${dex.rows}행)`);
  await tap('Tab');

  /* ══ 3. 배양조 ════════════════════════════════════════════════════════════ */
  console.log('배양조');
  await giveStash('mat_medium_basic', 1); await giveStash('strain_algae', 1);
  await H((u) => window.__game.ctx.housing.openCultureTank(u), CT);
  await waitFor(page, () => !document.querySelector('.menu.culture-tank')?.hidden, 'culture tank open');
  const started = await H((u) => { const h = window.__game.ctx.housing; return [h.fillMedium(u, 0, 'mat_medium_basic'), h.insertStrain(u, 0, 'strain_algae')]; }, CT);
  await sleep(20);
  const ct = await H(() => {
    const r = document.querySelector('.menu.culture-tank');
    return { title: r.querySelector('.hs-station-head .title').textContent,
      slots: [...r.querySelectorAll('.cult-slot')].map((s) => ({ locked: s.classList.contains('is-locked'), kids: s.children.length })),
      oldCls: r.querySelectorAll('[class^="ct-"], [class*=" ct-"]').length,
      buttons: [...r.querySelectorAll('.hs-pane-left button')].length,
      time: r.querySelector('.cult-slot[data-slot="0"] .cult-time')?.textContent ?? '' };
  });
  ok(started.every((v) => v === null) && ct.title === '배양조' && ct.oldCls === 0, `배양조 — 옛 .ct-* 이름 없음 (기업 화면과 겹치지 않는다) (${ct.oldCls})`);
  ok(ct.slots.slice(1).every((s) => s.locked && s.kids === 0) && ct.buttons === 0 && CLOCK.test(ct.time), `잠긴 칸 = 빈 칸 · 칸 버튼 없음 · HH:MM:SS (${ct.time})`);
  const cm = await H(() => {
    const c = document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-cell');
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    const m = document.querySelector('.menu.culture-tank .hs-ctx');
    return { shown: !m.hidden, items: [...m.querySelectorAll('.hs-ctx-item')].map((b) => b.textContent) };
  });
  ok(cm.shown && cm.items.join() === '세포주 버리고 배지 비우기', `배양 중인 칸 우클릭 (${JSON.stringify(cm)})`);
  await tap('Escape');
  const ctYield = await H((u) => window.__game.ctx.housing.getCultureSlots(u)[0].yieldDefId, CT);
  await H((u) => { const h = window.__game.ctx.housing; const c = h.state.cultures.find((x) => x.uid === u && x.slot === 0); c.readyAt = Date.now() - 1000; h.cultureTank.refresh(); }, CT);
  ok(await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-time').textContent === '수확 가능'), '배양 끝 → 「수확 가능」');
  const cy0 = await stashQty(ctYield);
  await H(() => document.querySelector('.menu.culture-tank .cult-slot[data-slot="0"] .cult-cell').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  ok(await stashQty(ctYield) > cy0, `더블클릭 수확 → 함선 창고 (${ctYield})`);
  await tap('Tab');

  /* ══ 4. 식탁 ══════════════════════════════════════════════════════════════ */
  console.log('식탁');
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
