// 전술 지도 퀘스트 패널 · 퀘스트 토스트 스모크 (2026-09-14 — src/ui/map/QuestPanels · src/ui/hud/Notifications, docs/plans/messenger-quests.md §5).
//
// 왜 있나: 지도 좌측 열이 「머리 → 퀘스트 패널 목록 → 범례(좌측 하단) → 발밑 줄」 로 바뀌었고 패널이 `ctx.meta.npc.getRaidTracks()` 를
// 그린다. 패널이 늘어도 프레임(= 캔버스 높이)이 자라면 안 되고, 트랙이 없거나 목적지 선택 모드여도 열이 무너지면 안 된다.
//
// 검사 (가짜 NpcQuestRef 로 — 레이아웃은 meta 구현과 무관하게 본다. 진짜 `ctx.meta.npc` 가 있으면 끝에서 그것도 그린다):
//   1. 열 순서 · 범례 좌측 하단 고정 · 열 높이 = 캔버스 · 프레임이 화면 안
//   2. 패널 3 · 이름 · NPC · 레이드 목표 줄만(함선 목표 · 다른 행성 목표 제외) · 확정 ✓ · 게이지 = progress
//   3. 호버 → 툴팁 (설명 · 목표 전부 · 함선에서 · 보상), 떠나면 숨김
//   4. `npc:objectiveProgress` → 곧바로 다시 그림 · 트랙 6 → 목록만 스크롤(프레임 그대로) · 트랙 0 → 목록 숨김 + 범례 좌측 하단
//   5. 목적지 선택 모드 (차량이 있으면) → 퀘스트 목록 숨김, 나오면 복귀
//   6. 토스트 — 목표 달성 · 보고 가능 · 완료 보상, done:false · 함선 목표는 토스트 없음
//   7. 1280×720 · 1920×1080 — 프레임이 화면 안, 패널 3 + 툴팁 스크린샷
//
// Usage: node scripts/smoke-map-quests.mjs [http://localhost:5273/] [screenshot dir]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SHOT_DIR = process.argv[3] ?? 'scripts/logs';
const SEEDS = [21, 7, 1234];
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
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
async function waitSim(page, seconds) {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${seconds}s`, 120000, t0 + seconds);
}
const measure = (page) => page.evaluate(() => window.__mqMeasure());

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,720', '--no-sandbox'],
});
const errors = [];
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    window.__mqMeasure = () => {
      const r = (s) => {
        const e = document.querySelector(s);
        if (!e || e.closest('[hidden]')) return null;
        const b = e.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) return null;
        return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height, w: b.width };
      };
      const s = document.querySelector('.mq-scroll');
      return {
        side: r('.map-side'), head: r('.map-head'), list: r('.mq-list'), legend: r('.map-legend'), foot: r('.map-foot'),
        canvas: r('.map-canvas'), frame: r('.map-frame'), rover: r('.map-rover'), tip: r('.mq-tip'),
        vw: innerWidth, vh: innerHeight,
        panels: document.querySelectorAll('.map-screen .mq-panel').length,
        scroll: s ? { sh: s.scrollHeight, ch: s.clientHeight } : null,
      };
    };
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), SEEDS[0]);
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
  await waitSim(page, 1.5);

  /* ── 가짜 NpcQuestRef ── */
  const inst = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const npcs = {
      hx: { id: 'npc_mq_hx', name: '한서진', title: '헬릭스 조달실장', corp: 'helix', role: 'executive', color: '#ff8a5c', glyph: '한', requires: {}, intro: [], bio: '', order: 0 },
      ce: { id: 'npc_mq_ce', name: '윤하람', title: '세레스 임상 연구원', corp: 'ceres', role: 'staff', color: '#6ee7a8', glyph: '윤', requires: {}, intro: [], bio: '', order: 1 },
      ind: { id: 'npc_mq_ind', name: '카야 로웰', title: '고철 중개상', corp: null, role: 'independent', color: '#c79fff', glyph: '카', requires: {}, intro: [], bio: '', order: 2 },
    };
    const o = (quest, index, kind, target, progress, def, label, here = true) => {
      const raid = kind !== 'deliver';
      return { def: { quest, index, kind, target, ...def }, label, progress, target, done: progress >= target, raid, countsHere: raid && here, blocked: null };
    };
    const q = (id, npc, name, summary, objectives, rewards) => ({
      def: { id, npc: npc.id, name, summary, requires: {}, objectives: objectives.map((x) => x.def), rewards, lines: { offer: [], accept: [], decline: [], brief: [], complete: [] }, order: 0 },
      npc, state: 'active', at: Date.now(), objectives, ready: objectives.every((x) => x.done), blocked: null,
      progress: objectives.reduce((s, x) => s + Math.min(1, x.progress / x.target), 0) / objectives.length,
    });
    window.__mqBase = () => [
      q('mq_1', npcs.hx, '레이더 소탕 시연', '헬릭스의 신형 산탄총이 실전에서 먹히는지 직접 보고 싶다. 연구소도 한 번 뒤져 봐.', [
        o('mq_1', 0, 'kill', 5, 2, { enemy: 'raider', weapon: 'SG' }, '산탄총으로 레이더 5명 처치'),
        o('mq_1', 1, 'search', 3, 3, { site: 'lab' }, '연구소 컨테이너 3개 조사'),
        o('mq_1', 2, 'deliver', 10, 4, { item: 'mat_scrap' }, '폐금속 10개 납품'),
      ], { credits: 900, xp: 1500, rep: [{ corp: 'helix', amount: 300 }], items: [{ defId: 'mat_alloy', qty: 2 }] }),
      q('mq_2', npcs.ce, '전진기지의 표본', '버려진 전진기지에서 분비선을 회수해 줘요. 해석 전의 것이어야 해요.', [
        o('mq_2', 0, 'discover', 1, 0, { site: 'outpost', planet: 'amber' }, '아켈론 II 에서 전진기지 발견'),
        o('mq_2', 1, 'recover', 3, 1, { item: 'terminid_gland' }, '터미니드 분비선 3개 회수'),
      ], { credits: 400, xp: 600, rep: [], items: [] }),
      q('mq_3', npcs.ind, '아주 긴 이름의 중개상 의뢰 — 옥상 스캐너 기록 확보', '스캐너 기록을 돌려. 네임드는 덤이다.', [
        o('mq_3', 0, 'interact', 1, 0, { interact: 'scanner' }, '맵 스캐너 작동'),
        o('mq_3', 1, 'kill', 1, 0, { enemy: 'named', planet: 'ashen' }, '네임드 처치', false),
      ], { credits: 1200, xp: 800, rep: [{ corp: 'nomad', amount: 120 }], items: [] }),
    ];
    window.__mqTracks = window.__mqBase();
    const stub = {
      getContacts: () => [], getMessages: () => [], markRead() {}, unreadTotal: 0,
      getQuests: () => window.__mqTracks,
      getQuest: (id) => window.__mqTracks.find((t) => t.def.id === id) ?? null,
      accept: () => false, defer: () => false, deliver: () => 0, report: () => false,
      getRaidTracks: () => window.__mqTracks,
    };
    const meta = ctx.meta;
    const hadReal = !!(meta && meta.npc);
    let realOk = null;
    if (hadReal) { try { realOk = Array.isArray(meta.npc.getRaidTracks()); } catch (e) { realOk = String(e); } }
    window.__mqOwnDesc = meta ? Object.getOwnPropertyDescriptor(meta, 'npc') ?? null : null;
    let installed = false;
    try { Object.defineProperty(meta, 'npc', { configurable: true, get: () => stub }); installed = meta.npc === stub; } catch (e) { installed = String(e); }
    return { hadReal, realOk, installed };
  });
  console.log(`real ctx.meta.npc: ${inst.hadReal ? `present (getRaidTracks array: ${inst.realOk})` : 'absent — stub only'}`);
  ok(inst.installed === true, '가짜 NpcQuestRef 설치', String(inst.installed));
  ok(!inst.hadReal || inst.realOk === true, '진짜 ctx.meta.npc.getRaidTracks() 는 배열', String(inst.realOk));

  const hud = 'window.__game.getSystem("hud")';
  const openMap = () => page.evaluate(`${hud}.map.open()`);
  const closeMap = () => page.evaluate(`${hud}.map.close()`);
  await openMap();
  await sleep(250);
  ok(await page.evaluate(`${hud}.isMapOpen`), '지도 열림');

  const checkLayout = async (tag, expectList) => {
    const m = await measure(page);
    ok(!!m.side && !!m.legend && !!m.foot && !!m.canvas, `${tag}: 열 요소가 보인다`, JSON.stringify(m));
    if (!m.side || !m.legend || !m.foot || !m.canvas) return m;
    if (expectList) {
      ok(!!m.list && m.head.b <= m.list.t + 1 && m.list.b <= m.legend.t + 1, `${tag}: 머리 → 퀘스트 목록 → 범례 순`, JSON.stringify({ head: m.head, list: m.list, legend: m.legend }));
    } else {
      ok(!m.list, `${tag}: 퀘스트 목록 숨김`);
    }
    ok(m.legend.b <= m.foot.t + 1 && m.foot.t - m.legend.b <= 20, `${tag}: 범례 바로 아래 발밑 줄 (${(m.foot.t - m.legend.b).toFixed(0)} px)`);
    ok(Math.abs(m.foot.b - m.side.b) <= 2, `${tag}: 범례 · 발밑 줄이 좌측 하단 (${(m.side.b - m.foot.b).toFixed(1)} px)`);
    ok(Math.abs(m.side.h - m.canvas.h) <= 3, `${tag}: 열 높이 = 캔버스 (${m.side.h.toFixed(0)} / ${m.canvas.h.toFixed(0)})`);
    ok(m.frame.t >= 0 && m.frame.l >= 0 && m.frame.b <= m.vh + 0.5 && m.frame.r <= m.vw + 0.5, `${tag}: 프레임이 화면 안 (${m.vw}×${m.vh})`, JSON.stringify(m.frame));
    return m;
  };

  /* ── 1 · 2 ── */
  let m = await checkLayout('1280×720 트랙 3', true);
  ok(m.panels === 3, `패널 3 (${m.panels})`);
  const p1 = await page.evaluate(() => {
    const p = document.querySelector('.mq-panel[data-quest="mq_1"]');
    const p3 = document.querySelector('.mq-panel[data-quest="mq_3"]');
    const rows = [...p.querySelectorAll('.mq-obj')].map((r) => ({ l: r.querySelector('.mq-obj-l').textContent, n: r.querySelector('.mq-obj-n').textContent, done: r.classList.contains('is-done') }));
    const g = p.querySelector('.mq-gauge');
    return {
      name: p.querySelector('.mq-name').textContent, npc: p.querySelector('.mq-npc').textContent, glyph: p.querySelector('.mq-glyph').textContent,
      rows, gauge: g.dataset.progress, fill: g.querySelector('i').style.width, p3rows: p3.querySelectorAll('.mq-obj').length,
      ids: window.__game.getSystem('hud').map.questIds,
    };
  });
  ok(p1.name === '레이더 소탕 시연' && p1.npc === '한서진' && p1.glyph === '한', `패널 이름 · NPC · 초상 (${p1.name} / ${p1.npc})`);
  ok(p1.rows.length === 2 && !p1.rows.some((r) => r.l.includes('납품')), `레이드 목표 줄만 (${p1.rows.length})`, JSON.stringify(p1.rows));
  ok(p1.rows[0]?.n === '2 / 5' && !p1.rows[0]?.done, `진행 줄 2 / 5 (${p1.rows[0]?.n})`);
  ok(p1.rows[1]?.n === '✓' && p1.rows[1]?.done, '확정 목표 ✓ · 흐리게');
  ok(p1.gauge === '60' && p1.fill === '60%', `게이지 = progress 60 % (${p1.gauge} · ${p1.fill})`);
  ok(p1.p3rows === 1, `다른 행성의 레이드 목표는 패널에서 뺀다 (${p1.p3rows})`);
  ok(JSON.stringify(p1.ids) === '["mq_1","mq_2","mq_3"]', `questIds ${JSON.stringify(p1.ids)}`);

  /* ── 3 ── */
  const hover = async (id) => {
    await page.evaluate(() => document.querySelector('.mq-scroll').dispatchEvent(new PointerEvent('pointerleave')));
    await page.evaluate((q) => document.querySelector(`.mq-panel[data-quest="${q}"] .mq-name`).dispatchEvent(new PointerEvent('pointerover', { bubbles: true })), id);
    await sleep(60);
  };
  await hover('mq_1');
  const tip = await page.evaluate(() => {
    const t = document.querySelector('.mq-tip');
    const side = document.querySelector('.map-side').getBoundingClientRect();
    const b = t.getBoundingClientRect();
    return { hidden: t.hidden, text: t.textContent, left: b.left, sideRight: side.right, bottom: b.bottom, vh: innerHeight, q: window.__game.getSystem('hud').map.questTip, objs: t.querySelectorAll('.mq-tip-obj').length };
  });
  ok(!tip.hidden && tip.q === 'mq_1', `호버 → 툴팁 (${tip.q})`);
  ok(tip.text.includes('헬릭스의 신형 산탄총') && tip.objs === 3, `툴팁: 설명 · 목표 전부 3줄 (${tip.objs})`);
  ok(tip.text.includes('함선에서') && tip.text.includes('4 / 10'), '툴팁: 납품 목표는 「함선에서」 · 진행');
  ok(tip.text.includes('+900') && tip.text.includes('XP +1500') && tip.text.includes('헬릭스'), '툴팁: 보상 (크레딧 · XP · 신뢰도)', tip.text);
  ok(tip.left >= tip.sideRight && tip.bottom <= tip.vh, `툴팁은 열 오른쪽 · 화면 안 (${tip.left.toFixed(0)} ≥ ${tip.sideRight.toFixed(0)})`);
  await hover('mq_3');
  const tip3 = await page.evaluate(() => ({ off: document.querySelectorAll('.mq-tip .mq-tip-obj.is-off').length, text: document.querySelector('.mq-tip').textContent }));
  ok(tip3.off === 1 && tip3.text.includes('피로스 VII'), `툴팁: 다른 행성 목표는 흐리게 + 행성 태그 (${tip3.off})`, tip3.text);
  await page.evaluate(() => document.querySelector('.mq-scroll').dispatchEvent(new PointerEvent('pointerleave')));
  await sleep(40);
  ok(await page.evaluate(() => document.querySelector('.mq-tip').hidden), '떠나면 툴팁 숨김');

  /* ── 4 ── */
  const upd = await page.evaluate(() => {
    const t = window.__mqTracks[0], ob = t.objectives[0];
    ob.progress = 4;
    t.progress = t.objectives.reduce((s, x) => s + Math.min(1, x.progress / x.target), 0) / t.objectives.length;
    window.__game.ctx.bus.emit('npc:objectiveProgress', { questId: 'mq_1', index: 0, progress: 4, target: 5, done: false, delta: 2, raid: true });
    const p = document.querySelector('.mq-panel[data-quest="mq_1"]');
    return { n: p.querySelector('.mq-obj .mq-obj-n').textContent, g: p.querySelector('.mq-gauge').dataset.progress };
  });
  ok(upd.n === '4 / 5' && upd.g === '73', `npc:objectiveProgress → 곧바로 다시 그림 (${upd.n} · ${upd.g} %)`);

  await page.evaluate(() => {
    window.__mqTracks = [...window.__mqBase(), ...window.__mqBase().map((t) => ({ ...t, def: { ...t.def, id: `${t.def.id}b` } }))];
    window.__game.ctx.bus.emit('npc:questChanged', { id: 'mq_1b', npc: 'npc_mq_hx', state: 'active', prev: 'offered' });
  });
  await sleep(120);
  m = await checkLayout('트랙 6', true);
  ok(m.panels === 6 && m.scroll && m.scroll.sh > m.scroll.ch, `패널 6 → 목록만 스크롤 (${m.scroll?.sh} > ${m.scroll?.ch})`);

  await page.evaluate(() => { window.__mqTracks = []; window.__game.ctx.bus.emit('npc:questChanged', { id: 'mq_1', npc: 'npc_mq_hx', state: 'complete', prev: 'active' }); });
  await sleep(120);
  m = await checkLayout('트랙 0', false);
  ok(m.panels === 0, '트랙 0 → 패널 없음');

  /* ── 5 ── */
  await page.evaluate(() => { window.__mqTracks = window.__mqBase(); window.__game.ctx.bus.emit('npc:questChanged', { id: 'mq_1', npc: 'npc_mq_hx', state: 'active', prev: 'offered' }); });
  const hasRover = await page.evaluate(() => !!window.__game.ctx.world.rover);
  if (hasRover) {
    await page.evaluate(`${hud}.map.enterRoverMode()`);
    await sleep(120);
    const rm = await measure(page);
    ok(await page.evaluate(`${hud}.isMapRoverMode`), '목적지 선택 모드 진입');
    ok(!rm.list && !rm.legend && !!rm.rover, '목적지 선택 모드: 퀘스트 · 범례 숨김, 차량 패널', JSON.stringify({ list: rm.list, legend: rm.legend, rover: rm.rover }));
    ok(!!rm.foot && Math.abs(rm.foot.b - rm.side.b) <= 2, '목적지 선택 모드: 발밑 줄은 바닥');
    await page.evaluate(`${hud}.map.exitRoverMode(false)`);
    await sleep(120);
    m = await checkLayout('목적지 선택 모드 뒤', true);
    ok(m.panels === 3, `모드를 나오면 패널 복귀 (${m.panels})`);
  } else {
    console.log('  (no rover on this seed — rover-mode checks skipped)');
  }

  /* ── 6 ── */
  const toasts = await page.evaluate(async () => {
    const b = window.__game.ctx.bus;
    const texts = () => [...document.querySelectorAll('.notif')].map((n) => n.textContent);
    const n0 = texts().length;
    b.emit('npc:objectiveProgress', { questId: 'mq_1', index: 0, progress: 4, target: 5, done: false, delta: 1, raid: true });
    b.emit('npc:objectiveProgress', { questId: 'mq_1', index: 2, progress: 10, target: 10, done: true, delta: 6, raid: false });
    const nQuiet = texts().length;
    b.emit('npc:objectiveProgress', { questId: 'mq_1', index: 1, progress: 3, target: 3, done: true, delta: 1, raid: true });
    b.emit('npc:questReady', { id: 'mq_1', npc: 'npc_mq_hx' });
    b.emit('npc:questChanged', { id: 'mq_1', npc: 'npc_mq_hx', state: 'complete', prev: 'active' });
    const all = texts();
    return { n0, nQuiet, all };
  });
  ok(toasts.nQuiet === toasts.n0, `done:false · 함선 목표는 토스트 없음 (${toasts.nQuiet - toasts.n0})`);
  const has = (s) => toasts.all.some((t) => t.includes(s));
  ok(has('퀘스트 목표 달성') && has('연구소 컨테이너 3개 조사'), '토스트: 퀘스트 목표 달성 — 퀘스트: 목표', JSON.stringify(toasts.all));
  ok(has('함선에서 메신저로 완료 보고'), '토스트: 보고 가능');
  ok(toasts.all.some((t) => t.includes('퀘스트 완료') && t.includes('+900') && t.includes('XP +1500') && t.includes('신뢰도 +300')), '토스트: 완료 보상 요약');

  /* ── 7 ── */
  await page.evaluate(() => { window.__mqTracks = window.__mqBase(); window.__game.ctx.bus.emit('npc:questChanged', { id: 'mq_1', npc: 'npc_mq_hx', state: 'active', prev: 'offered' }); });
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await page.setViewport({ width: w, height: h });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await sleep(350);
    m = await checkLayout(`${w}×${h}`, true);
    const visible = await page.evaluate(() => {
      const s = document.querySelector('.mq-scroll').getBoundingClientRect();
      return [...document.querySelectorAll('.mq-panel')].filter((p) => { const b = p.getBoundingClientRect(); return b.top >= s.top - 1 && b.bottom <= s.bottom + 1; }).length;
    });
    ok(visible === 3, `${w}×${h}: 패널 3 이 스크롤 없이 다 보인다 (${visible})`);
    await hover('mq_1');
    const shot = join(SHOT_DIR, `map-quests-${w}.png`);
    await page.screenshot({ path: shot });
    console.log(`  screenshot ${shot}`);
    const tb = await measure(page);
    ok(!!tb.tip && tb.tip.b <= tb.vh + 0.5 && tb.tip.r <= tb.vw + 0.5, `${w}×${h}: 툴팁이 화면 안`, JSON.stringify(tb.tip));
  }

  /* ── 진짜 ref (있으면) ── */
  await page.evaluate(() => {
    const meta = window.__game.ctx.meta;
    delete meta.npc;
    if (window.__mqOwnDesc) Object.defineProperty(meta, 'npc', window.__mqOwnDesc);
  });
  if (inst.hadReal) {
    await closeMap();
    await openMap();
    await sleep(200);
    const real = await page.evaluate(() => ({ tracks: window.__game.ctx.meta.npc.getRaidTracks().length, panels: document.querySelectorAll('.mq-panel').length }));
    ok(real.tracks === real.panels, `진짜 ref: 패널 수 = getRaidTracks (${real.panels} / ${real.tracks})`);
  }
  await closeMap();
  ok(await page.evaluate(() => document.querySelector('.mq-tip').hidden), '지도를 닫으면 툴팁도 숨김');
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e && e.stack || e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
