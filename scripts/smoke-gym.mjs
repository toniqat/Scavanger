// Single-player smoke test for the **헬스장 운동 세션** (A-3a, 2026-09-12, src/housing — parts/Gym · parts/GymGames · ui/gym):
// `gymBlock` 사유 (운동 기구가 아님 · 없는 uid · 다른 화면 · 레이드) → 판정 규칙을 화면 없이 (`gymDebug.makeGame`) —
// 벤치프레스(가운데 거리 → 완벽 / 좋음 / 실패 · 회차마다 빨라짐 · 점수 = 평균), 호흡 달리기(예비 박자 무시 · 탭 창 ·
// 헛누름 = 다음 표식 실패 · 하 = 시작 + 떼기 둘 다 · 너무 일찍 / 너무 오래), 사이클링(틀린 발 · 놓침 · 점프 무시) →
// 실제 세션: `housing:gymSession {active:true}` · 블로커 · ESC 스택 · 키 가이드 → Space 는 `Input` 에 기록되지 않고 게임을
// 시작 → 가운데에서 누른 첫 판정 → `finish(1)` → `applyGymSession` 결과 + `housing:gymResult` + 근육통 → Tab 닫기 = completed →
// 근육통 중 두 번째 근력 운동 = 경험치 0 (디버프 안 늘어남) → Space 연타로 끝까지 가서 결과 화면 → 입력 없이 화면이 흐른다
// (2026-09-12: 벤치프레스 커서 `left` · 호흡 · 사이클 표식 `--x` 를 MutationObserver 로, 키 핸들러가 그 자리에서 다시 그린다,
// 닫으면 rAF · 예비 타이머가 멈춘다) → 취소 · Tab 취소 = 아무것도
// 안 걸린다 · 게임 도중 E 는 삼키기만 → 새로고침 뒤에도 단련 · 근육통이 남는다.
// Usage: node scripts/smoke-gym.mjs [http://localhost:5273]   (needs `npm run dev`)
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

/** `data/constants.csv` 의 GYM_* — 기대값을 수치에서 유도한다 (값을 고쳐도 스모크가 따라간다). */
const K = {};
for (const line of readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'constants.csv'), 'utf8').split(/\r?\n/)) {
  const m = /^(GYM_[A-Z_]+),([^,]+)/.exec(line);
  if (m) K[m[1]] = Number(m[2]);
}

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const note = (s) => console.log(`  note ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 입력 없이 화면이 흐르는지 재는 창 · 기준 (2026-09-12 F) — 헤드리스 GPU 60 fps 면 창 동안 ~50 번 바뀐다. 병렬 러너의 느린 프레임을 넉넉히 봐준다. */
const FLOW_WINDOW_MS = 900, FLOW_MIN_CHANGES = 12, FLOW_MAX_GAP_MS = 250;
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
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  /**
   * 2026-09-12 (F): 입력 없이 `FLOW_WINDOW_MS` 동안 요소의 스타일 값(`left` 또는 CSS 변수)이 **화면에서** 몇 번 · 얼마 간격으로
   * 바뀌는지 잰다. MutationObserver 라 표본을 뜨는 쪽이 타이머에 굶지 않고, 페이지 밖 호출(CDP)도 창 동안 하지 않는다.
   * 처음 판은 `setInterval` 이 그려서 무거운 프레임 + 입력 사이에서 60–120 ms 씩 건너뛰었다 — 판정 객체만 몰던 검사는 그걸 못 봤다.
   */
  const sampleFlow = (sel, prop) => page.evaluate(({ sel, prop, ms }) => new Promise((res) => {
    const target = document.querySelector(sel);
    if (!target) { res({ err: `no ${sel}`, wall: 0, changes: 0, distinct: 0, maxGap: 1e9, nums: [] }); return; }
    const read = () => (prop === 'left' ? target.style.left : target.style.getPropertyValue(prop));
    const t0 = performance.now();
    const times = [t0], values = [read()];
    const mo = new MutationObserver(() => {
      const v = read();
      if (v !== values[values.length - 1]) { times.push(performance.now()); values.push(v); }
    });
    mo.observe(target, { attributes: true, attributeFilter: ['style'] });
    setTimeout(() => {
      mo.disconnect();
      const end = performance.now();
      times.push(end);
      let maxGap = 0;
      for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, times[i] - times[i - 1]);
      res({ wall: Math.round(end - t0), changes: values.length - 1, distinct: new Set(values).size, maxGap: Math.round(maxGap),
        first: values[0], last: values[values.length - 1], nums: values.map((v) => parseFloat(v)) });
    }, ms);
  }), { sel, prop, ms: FLOW_WINDOW_MS });

  /** Boot + frame driver (rAF stalls in headless) + fake pointer lock + event recorders. */
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot && !!window.__game.ctx.progression, 'boot');
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      const b = window.__game.ctx.bus;
      window.__rec = { sessions: [], beats: [], results: [], audio: [], guide: [] };
      b.on('housing:gymSession', (p) => window.__rec.sessions.push({ ...p }));
      b.on('housing:gymBeat', (p) => window.__rec.beats.push({ ...p }));
      b.on('housing:gymResult', (p) => window.__rec.results.push({ ...p }));
      b.on('audio:play', (p) => { if (/^gym_/.test(p.id)) window.__rec.audio.push(p.id); });
      b.on('ui:keyGuide', (p) => { if (p.owner === 'housing.gym') window.__rec.guide.push(p.keys ? p.keys.map((k) => k.label) : null); });
    });
  };

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await boot();
  const hasProg = await H(() => typeof window.__game.ctx.progression.applyGymSession === 'function');
  ok(hasProg, 'progression 이 applyGymSession 을 갖고 있다 (없으면 결과 · 새로고침 검사는 건너뛴다)');
  // 단련 · 근육통을 0 에서 시작한다 (콘솔용 공개 API — 없으면 그대로 진행하고 기록만)
  const reset = await H(() => {
    const p = window.__game.ctx.progression;
    if (typeof p.clearGymFatigue !== 'function' || typeof p.addTrainedXp !== 'function') return false;
    p.clearGymFatigue();
    p.addTrainedXp('strength', -1e7); p.addTrainedXp('endurance', -1e7);
    return true;
  });
  if (!reset) note('progression.clearGymFatigue / addTrainedXp 없음 — 이전 실행의 근육통이 남아 있을 수 있다');

  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitFor(page, () => [...document.querySelectorAll('.menu.hidden')].every((m) => {
    const cs = getComputedStyle(m);
    return cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
  }), '숨은 메뉴의 페이드가 끝난다', 5000);

  /* ── 헬스장 방 + 기구 4종 ── */
  await H(() => {
    const ctx = window.__game.ctx;
    for (const [id, n] of [['mat_scrap', 60], ['mat_alloy', 20], ['mat_cable', 10], ['mat_circuit', 6]]) {
      const def = ctx.loot.getItemDef(id);
      let added = 0;
      while (added < n) { const q = Math.min(def.stackMax ?? 1, n - added); if (!ctx.inventory.tryAddToStash(ctx.loot.createItem(id, q))) break; added += q; }
    }
    const h = ctx.housing;
    h.state.generatorLevel = 5;
    h.state.rooms[2].purpose = 'gym';
  });
  const placeFurn = (room, defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    if (!h.craftFurniture(defId)) return { err: `craft: ${h.furnitureCraftBlock?.(defId) ?? '?'}` };
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return { err: 'no spot' };
    const p = h.place(room, defId, spot.x, spot.y, spot.yaw);
    return p ? { uid: p.uid } : { err: 'place refused' };
  }, { room, defId });
  const bench = await placeFurn(2, 'furn_bench_rack');
  const smith = await placeFurn(2, 'furn_smith_machine');
  const tread = await placeFurn(2, 'furn_treadmill');
  const bike = await placeFurn(2, 'furn_exercise_bike');
  ok(bench.uid && smith.uid && tread.uid && bike.uid, 'craft + place 벤치 랙 · 스미스 머신 · 트레드밀 · 사이클', JSON.stringify({ bench, smith, tread, bike }));
  const BENCH = bench.uid, SMITH = smith.uid, TREAD = tread.uid, BIKE = bike.uid;

  /* ══ 1. gymBlock ══════════════════════════════════════════════════════════ */
  console.log('gymBlock');
  const blocks = await H(({ BENCH }) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const other = h.getPlaced().find((p) => !/^gym_/.test(h.getFurnitureDef(p.defId)?.interaction ?? ''))?.uid ?? null;
    const out = { other, notGym: other ? h.gymBlock(other) : 'no other piece', unknown: h.gymBlock('f-9999'), bench: h.gymBlock(BENCH), blockers: [...ctx.uiBlockers] };
    ctx.uiBlockers.add('smoke');
    out.blocked = h.gymBlock(BENCH);
    ctx.uiBlockers.delete('smoke');
    ctx.isRaidActive = () => true;
    out.raid = h.gymBlock(BENCH);
    delete ctx.isRaidActive;
    out.startNotGym = other ? h.startGymSession(other) : null;
    out.sessions = window.__rec.sessions.length;
    out.info = h.gymSession;
    return out;
  }, { BENCH });
  ok(blocks.notGym === '운동 기구가 아닙니다' && blocks.unknown === '운동 기구가 아닙니다', `운동 기구가 아니면 / 없는 uid 면 거절 (${blocks.notGym} · ${blocks.unknown})`);
  ok(blocks.bench === null, `배치한 벤치 랙은 시작할 수 있다 (${blocks.bench})`, JSON.stringify(blocks.blockers));
  ok(blocks.blocked === '다른 화면을 먼저 닫으세요', `다른 화면(블로커)이 있으면 거절 (${blocks.blocked})`);
  ok(blocks.raid === '함선에서만 운동할 수 있습니다', `레이드 중이면 거절 (${blocks.raid})`);
  ok(blocks.startNotGym === '운동 기구가 아닙니다' && blocks.sessions === 0 && blocks.info === null, 'startGymSession 거절은 세션도 이벤트도 없다');

  /* ══ 2. 판정 — 화면 없이 ══════════════════════════════════════════════════ */
  console.log('판정 (벤치프레스)');
  const press = await H(() => {
    const g = window.__game.ctx.housing.gymDebug.makeGame('press');
    const seek = (lo, hi) => { for (let i = 0; i < 200000; i++) { const off = Math.abs(g.pos - 0.5); if (off >= lo && off <= hi) return true; g.update(0.0005); } return false; };
    const speeds = [];
    const plan = [[0, 0.004], [0.075, 0.085], [0.4, 0.5]];
    for (let i = 0; i < g.total; i++) {
      const [lo, hi] = plan[i] ?? plan[0];
      if (!seek(lo, hi)) return { err: `seek ${i}` };
      speeds.push(g.speed);
      g.press('left');                 // 벤치프레스는 점프만 받는다
      g.press('jump');
    }
    const ev = g.drain();
    return { total: g.total, judgements: [...g.judgements], score: g.score, done: g.done, speeds, judgeEvents: ev.filter((e) => e.type === 'judge').length };
  });
  const pressWant = ['perfect', 'good', 'miss', ...Array(Math.max(0, K.GYM_PRESS_REPS - 3)).fill('perfect')];
  ok(press.total === K.GYM_PRESS_REPS && JSON.stringify(press.judgements) === JSON.stringify(pressWant), `가운데 · 좋음 구역 · 바깥 → 완벽 · 좋음 · 실패, 나머지 완벽 (${JSON.stringify(press.judgements)})`, JSON.stringify(press));
  const pressScore = ((K.GYM_PRESS_REPS - 2) * K.GYM_SCORE_PERFECT + K.GYM_SCORE_GOOD) / K.GYM_PRESS_REPS;
  ok(press.done && Math.abs(press.score - pressScore) < 1e-9, `점수 = 판정 평균 (${press.score?.toFixed(4)} = ${pressScore.toFixed(4)})`);
  ok(press.speeds.every((s, i) => Math.abs(s - (K.GYM_PRESS_SPEED + i * K.GYM_PRESS_SPEED_STEP)) < 1e-9), `회차마다 커서가 빨라진다 (${press.speeds.map((s) => s.toFixed(2)).join(' → ')})`);
  ok(press.judgeEvents === K.GYM_PRESS_REPS, `판정 이벤트 ${press.judgeEvents}개 (왼쪽 키는 판정이 아니다)`);

  console.log('판정 (호흡 달리기)');
  const breath = await H(() => {
    const g = window.__game.ctx.housing.gymDebug.makeGame('breath');
    const B = g.beat, W = g.window, HS = g.holdS, TOL = g.holdTol;
    const to = (t) => g.update(t - g.time);
    const log = [];
    g.press('jump'); g.release('jump');                           // 예비 박자 동안의 입력은 무시
    log.push({ lead: g.judgements.length });
    const n = g.notes;
    // note 0 후: 정박 → 완벽 / 1 후: 창의 0.6 → 좋음 / 2 하: 정박에 누르고 정확히 뗀다 → 완벽
    to(n[0].t); g.press('jump'); g.release('jump');
    to(n[1].t + W * 0.6); g.press('jump'); g.release('jump');
    to(n[2].t); g.press('jump'); to(n[2].t + HS); g.release('jump');
    // 3 후: 안 누른다 → 놓침 / 4 후: 반 박 일찍 → 헛누름 실패 / 5 하: 반만 쥐고 뗀다 → 실패
    to(n[3].t + W + 0.01);
    log.push({ afterMiss: [...g.judgements] });
    to(n[4].t - B / 2); g.press('jump'); g.release('jump');
    to(n[5].t); g.press('jump'); to(n[5].t + HS / 2); g.release('jump');
    // 6 · 7 후 완벽 / 8 하: 너무 오래 쥔다 → 실패 (그 뒤의 떼기는 무시)
    to(n[6].t); g.press('jump'); g.release('jump');
    to(n[7].t); g.press('jump'); g.release('jump');
    to(n[8].t); g.press('jump'); to(n[8].t + HS + TOL + 0.02); g.release('jump');
    for (let i = 9; i < n.length; i++) {
      to(n[i].t); g.press('jump');
      if (n[i].hold) to(n[i].t + HS);
      g.release('jump');
    }
    const ev = g.drain();
    return { log, total: g.total, holds: n.filter((x) => x.hold).length, judgements: [...g.judgements], score: g.score, done: g.done,
      breaths: ev.filter((e) => e.type === 'sound' && e.id === 'gym_breath').length };
  });
  const bTotal = K.GYM_BREATH_CYCLES * 3;
  const bWant = ['perfect', 'good', 'perfect', 'miss', 'miss', 'miss', 'perfect', 'perfect', 'miss', ...Array(Math.max(0, bTotal - 9)).fill('perfect')];
  ok(breath.log[0].lead === 0, '예비 박자 동안의 Space 는 판정이 아니다');
  ok(breath.total === bTotal && breath.holds === K.GYM_BREATH_CYCLES, `판정 ${breath.total} = 묶음 ${K.GYM_BREATH_CYCLES} × (후 · 후 · 하)`);
  ok(JSON.stringify(breath.judgements) === JSON.stringify(bWant), `탭 창 · 놓침 · 헛누름 · 일찍 뗌 · 오래 쥠 (${JSON.stringify(breath.judgements.slice(0, 9))})`, JSON.stringify(breath));
  const bScore = ((bTotal - 5) * K.GYM_SCORE_PERFECT + K.GYM_SCORE_GOOD) / bTotal;
  ok(breath.done && Math.abs(breath.score - bScore) < 1e-9, `호흡 점수 (${breath.score?.toFixed(4)} = ${bScore.toFixed(4)})`);
  ok(breath.breaths === bTotal - 2, `창 안에서 누를 때마다 gym_breath (${breath.breaths}회 — 놓침 · 헛누름 제외)`);

  console.log('판정 (사이클링)');
  const cycle = await H(() => {
    const g = window.__game.ctx.housing.gymDebug.makeGame('cycle');
    const W = g.window, n = g.notes;
    const to = (t) => g.update(t - g.time);
    to(n[0].t); g.press('jump'); g.press(n[0].lane);                  // 점프는 무시, 왼발 정박 → 완벽
    to(n[1].t); g.press('left');                                      // 오른발 차례에 왼발 → 실패
    to(n[2].t + W * 0.6); g.press(n[2].lane);                         // 좋음
    to(n[3].t + W + 0.01);                                            // 놓침
    for (let i = 4; i < n.length; i++) { to(n[i].t); g.press(n[i].lane); }
    const ev = g.drain();
    return { total: g.total, lanes: n.slice(0, 4).map((x) => x.lane), judgements: [...g.judgements], score: g.score, done: g.done,
      pedals: ev.filter((e) => e.type === 'sound' && e.id === 'gym_pedal').length };
  });
  const cWant = ['perfect', 'miss', 'good', 'miss', ...Array(Math.max(0, K.GYM_CYCLE_STROKES - 4)).fill('perfect')];
  ok(cycle.total === K.GYM_CYCLE_STROKES && JSON.stringify(cycle.lanes) === JSON.stringify(['left', 'right', 'left', 'right']), `왼발 · 오른발 번갈아 ${cycle.total}회`);
  ok(JSON.stringify(cycle.judgements) === JSON.stringify(cWant), `정박 · 틀린 발 · 좋음 · 놓침 (${JSON.stringify(cycle.judgements.slice(0, 4))})`, JSON.stringify(cycle));
  const cScore = ((K.GYM_CYCLE_STROKES - 3) * K.GYM_SCORE_PERFECT + K.GYM_SCORE_GOOD) / K.GYM_CYCLE_STROKES;
  ok(cycle.done && Math.abs(cycle.score - cScore) < 1e-9 && cycle.pedals === K.GYM_CYCLE_STROKES - 2, `사이클 점수 ${cycle.score?.toFixed(4)} · 페달 소리 ${cycle.pedals}회`);

  /* ══ 3. 실제 세션 — 벤치 랙 ══════════════════════════════════════════════ */
  console.log('세션 (벤치 랙)');
  const s1 = await H((u) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const r = h.startGymSession(u);
    return { r, info: h.gymSession, ev: window.__rec.sessions.at(-1) ?? null, blocker: ctx.uiBlockers.has('housing.gym'), esc: ctx.escape.has('housing.gym'),
      screen: h.gymDebug.screen, intro: !!document.querySelector('.gym:not([hidden]) .gym-intro'),
      title: document.querySelector('.gym-intro .gym-title')?.textContent ?? null, guide: window.__rec.guide.at(-1) ?? null,
      again: h.startGymSession(u) };
  }, BENCH);
  ok(s1.r === null && s1.info?.uid === BENCH && s1.info.stat === 'strength' && s1.info.minigame === 'press', `startGymSession → 세션 (${JSON.stringify(s1.info)})`, `r=${s1.r}`);
  ok(s1.ev && s1.ev.active === true && s1.ev.completed === false && s1.ev.uid === BENCH, 'housing:gymSession {active:true, completed:false}');
  ok(s1.blocker && s1.esc, '블로커 housing.gym · ESC 스택 housing.gym');
  ok(s1.screen === 'intro' && s1.intro && s1.title === '벤치 랙', `시작 안내 화면 (${s1.title})`);
  ok(JSON.stringify(s1.guide) === JSON.stringify(['시작']), `키 가이드: 시작 (${JSON.stringify(s1.guide)})`);
  ok(s1.again === '이미 운동 중입니다', `세션 중 두 번째 시작은 거절 (${s1.again})`);
  if (!s1.info) note('세션이 곧바로 끝났다 — hub 가 자세를 걸지 못해 cancelGymSession 을 불렀을 수 있다 (player/hub 미완)');

  // Space: keydown 만 보내고 Input 이 기록하지 않았는지 본 뒤 keyup
  const spaceDown = await H(() => {
    const ctx = window.__game.ctx;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    const r = { down: ctx.input.isDown('Space'), pressed: ctx.input.wasPressed('Space'), screen: ctx.housing.gymDebug.screen };
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    r.afterUp = ctx.input.isDown('Space');
    return r;
  });
  ok(spaceDown.screen === 'game' && !spaceDown.down && !spaceDown.pressed && !spaceDown.afterUp, `Space → 게임 시작, Input 은 점프를 기록하지 않는다 (${JSON.stringify(spaceDown)})`);
  const g1 = await H(() => ({ bar: !!document.querySelector('.gym-panel .gym-press-bar .gym-press-cursor'), pips: document.querySelectorAll('.gym-panel .gym-pip').length,
    guide: window.__rec.guide.at(-1), audio: window.__rec.audio.includes('gym_start') }));
  ok(g1.bar && g1.pips === K.GYM_PRESS_REPS && g1.audio, `게임 화면: 바 · 커서 · 회차 칸 ${g1.pips} · gym_start`);
  ok(JSON.stringify(g1.guide) === JSON.stringify(['들어 올리기']), `키 가이드: 들어 올리기 (${JSON.stringify(g1.guide)})`);
  // 2026-09-12: 입력 없이도 **화면의** 커서가 흐른다 — 판정 객체가 아니라 DOM(`style.left`)을 3D 장면이 그려지는 채로 잰다
  const pressFlow = await sampleFlow('.gym-press-cursor', 'left');
  ok(pressFlow.changes >= FLOW_MIN_CHANGES && pressFlow.distinct >= FLOW_MIN_CHANGES && pressFlow.maxGap < FLOW_MAX_GAP_MS,
    `입력 없이 벤치프레스 커서가 흐른다 (${pressFlow.wall} ms 동안 left 변경 ${pressFlow.changes}회 · 값 ${pressFlow.distinct}개 · 최대 간격 ${pressFlow.maxGap} ms)`, JSON.stringify(pressFlow));
  // 커서가 가운데 근처일 때 진짜 keydown — 핸들러가 **지금까지** 게임을 민 뒤 판정하고, 그 자리를 **곧바로** 그린다
  const live = await H(() => new Promise((res) => {
    const h = window.__game.ctx.housing;
    const t0 = performance.now();
    const iv = setInterval(() => {
      const g = h.gymDebug.game;
      if (!g) { clearInterval(iv); res({ err: 'no game' }); return; }
      if (Math.abs(g.pos - 0.5) < 0.012 || performance.now() - t0 > 8000) {
        clearInterval(iv);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
        const drawn = { left: document.querySelector('.gym-press-cursor')?.style.left ?? null, want: `${(g.pos * 100).toFixed(2)}%`,
          count: document.querySelector('.gym-count')?.textContent ?? null, wantCount: `${Math.min(g.judgements.length + 1, g.total)} / ${g.total}` };
        document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
        res({ beats: window.__rec.beats.map((b) => ({ ...b })), judgements: [...g.judgements], verdict: document.querySelector('.gym-verdict')?.textContent ?? null, drawn });
      }
    }, 1);
  }));
  ok(live.beats?.length === 1 && live.beats[0].index === 0 && live.beats[0].total === K.GYM_PRESS_REPS && live.beats[0].quality !== 'miss',
    `가운데에서 누른 판정 → housing:gymBeat (${JSON.stringify(live.beats?.[0])})`, JSON.stringify(live));
  ok(['완벽', '좋음'].includes(live.verdict), `판정 글자 (${live.verdict})`);
  ok(live.drawn && live.drawn.left === live.drawn.want && live.drawn.count === live.drawn.wantCount,
    `키 핸들러가 판정 직후의 커서 · 회차를 그 자리에서 그린다 (${JSON.stringify(live.drawn)})`);

  if (hasProg) {
    const fin = await H(() => {
      const h = window.__game.ctx.housing, p = window.__game.ctx.progression;
      const r = h.gymDebug.finish(1);
      return { r, ev: window.__rec.results.at(-1) ?? null, screen: h.gymDebug.screen, fatigue: p.getGymFatigueUntil('strength'), now: Date.now(),
        prog: p.getTrainedProgress('strength'), text: document.querySelector('.gym-result')?.textContent ?? '', audio: window.__rec.audio.includes('gym_finish') };
    });
    ok(fin.r && fin.r.xp === K.GYM_SESSION_XP && fin.r.wasFatigued === false && fin.r.stat === 'strength', `finish(1) → 단련 경험치 +${fin.r?.xp}`, JSON.stringify(fin.r));
    ok(fin.ev && fin.ev.uid === BENCH && JSON.stringify(fin.ev.result) === JSON.stringify(fin.r), 'housing:gymResult = applyGymSession 결과 그대로');
    const hours = (fin.fatigue - fin.now) / 3600e3;
    ok(Math.abs(hours - K.GYM_FATIGUE_HOURS) < 0.01 && fin.r.fatigueUntil === fin.fatigue, `근육통 ${hours.toFixed(2)} 시간`);
    ok(Math.abs(fin.prog - K.GYM_SESSION_XP / Math.round(K.GYM_TRAIN_XP_BASE)) < 1e-6 || fin.r.trainedAfter > 0, `단련 진행도 ${fin.prog.toFixed(3)}`);
    ok(fin.screen === 'result' && /100/.test(fin.text) && fin.text.includes(`단련 경험치 +${K.GYM_SESSION_XP}`) && /근육통 · 남은 \d{2}:\d{2}:\d{2}/.test(fin.text) && fin.audio,
      `결과 화면 (${fin.text.slice(0, 90)})`);
    ok(JSON.stringify(await H(() => window.__rec.guide.at(-1))) === '[]', '결과 화면의 키 가이드는 닫기뿐');
  }
  await tap('Tab');
  const closed = await H(() => {
    const ctx = window.__game.ctx;
    return { ev: window.__rec.sessions.at(-1), info: ctx.housing.gymSession, blocker: ctx.uiBlockers.has('housing.gym'), esc: ctx.escape.has('housing.gym'),
      hidden: document.querySelector('.gym').hidden, inv: !!ctx.inventory.isOpen, guide: window.__rec.guide.at(-1), ticking: ctx.housing.gymScreen?.ticking };
  });
  ok(closed.ev.active === false && closed.ev.completed === hasProg && closed.info === null, `Tab → housing:gymSession {active:false, completed:${closed.ev.completed}}`);
  ok(!closed.blocker && !closed.esc && closed.hidden && !closed.inv && closed.guide === null, 'Tab: 블로커 · ESC · 화면 · 키 가이드 정리, 인벤토리는 안 열린다');
  ok(closed.ticking === false, `Tab: 화면 루프(rAF · 예비 타이머)가 멈춘다 (ticking=${closed.ticking})`);

  if (hasProg) {
    /* ── 근육통 중 두 번째 근력 운동 ── */
    console.log('세션 (스미스 머신 — 근육통 중)');
    const s2 = await H((u) => {
      const h = window.__game.ctx.housing, p = window.__game.ctx.progression;
      const before = { until: p.getGymFatigueUntil('strength'), prog: p.getTrainedProgress('strength'), bonus: p.getTrainedBonus('strength') };
      const r0 = h.startGymSession(u);
      const warn = document.querySelector('.gym-intro .gym-warn')?.textContent ?? '';
      h.gymDebug.start();
      const r = h.gymDebug.finish(1);
      const text = document.querySelector('.gym-result')?.textContent ?? '';
      const after = { until: p.getGymFatigueUntil('strength'), prog: p.getTrainedProgress('strength'), bonus: p.getTrainedBonus('strength') };
      window.__game.ctx.escape.closeTop();
      return { r0, warn, r, text, before, after, ev: window.__rec.sessions.at(-1), info: h.gymSession };
    }, SMITH);
    ok(s2.r0 === null && /^근육통 — 이번 운동으로는 근력이 오르지 않습니다 \(남은 \d{2}:\d{2}:\d{2}\)$/.test(s2.warn), `시작 안내의 근육통 경고 (${s2.warn})`);
    ok(s2.r && s2.r.xp === 0 && s2.r.wasFatigued && s2.after.until === s2.before.until && s2.after.prog === s2.before.prog, `근육통 중 = 경험치 0 · 디버프 안 늘어남 (${JSON.stringify(s2.r)})`);
    ok(s2.text.includes('근육통 중이라 근력이 오르지 않았습니다'), '결과 화면이 이유를 말한다');
    ok(s2.ev.active === false && s2.ev.completed === true && s2.info === null, 'ctx.escape.closeTop() → 결과 화면 닫기 = completed');

    /* ── 끝까지 (Space 연타) → 결과 화면 ── */
    console.log('세션 (벤치 랙 — 끝까지)');
    const beats0 = await H(() => window.__rec.beats.length);
    await H((u) => { const h = window.__game.ctx.housing; h.startGymSession(u); h.gymDebug.start(); }, BENCH);
    for (let i = 0; i < K.GYM_PRESS_REPS; i++) { await tap('Space'); await sleep(40); }
    const nat = await H(() => ({ screen: window.__game.ctx.housing.gymDebug.screen, results: window.__rec.results.length, score: window.__game.ctx.housing.gymDebug.game?.score ?? null }));
    ok(nat.screen === 'game', `마지막 판정 직후엔 판정 글자를 보여 준다 (${nat.screen})`);
    await waitFor(page, () => window.__game.ctx.housing.gymDebug.screen === 'result', '결과 화면', 5000);
    const nat2 = await H((n0) => ({ beats: window.__rec.beats.slice(n0).map((b) => b.index), res: window.__rec.results.at(-1), text: document.querySelector('.gym-result .gym-counts')?.textContent ?? '' }), beats0);
    ok(nat2.beats.length === K.GYM_PRESS_REPS && nat2.beats.every((b, i) => b === i), `판정 ${nat2.beats.length}개 (index 0…${K.GYM_PRESS_REPS - 1})`);
    ok(nat2.res && nat2.res.uid === BENCH && Math.abs(nat2.res.result.score - nat.score) < 1e-9 && /완벽\d+좋음\d+실패\d+/.test(nat2.text), `끝낸 게임의 점수가 넘어갔다 (${nat.score?.toFixed(3)} · ${nat2.text})`);
    await tap('KeyE');
    ok(await H(() => window.__game.ctx.housing.gymSession === null && window.__rec.sessions.at(-1).completed === true), '결과 화면에서 E → 닫기');
  }

  /* ══ 3-1. 화면 흐름 — 호흡 · 사이클 (입력 없이) ══════════════════════════════ */
  console.log('화면 흐름 (호흡 달리기 · 사이클링 — 입력 없이)');
  for (const [uid, kind, label] of [[TREAD, 'breath', '호흡 달리기'], [BIKE, 'cycle', '사이클링']]) {
    const st = await H((u) => {
      const h = window.__game.ctx.housing;
      const r = h.startGymSession(u);
      const started = h.gymDebug.start();
      return { r, started, screen: h.gymDebug.screen, minigame: h.gymSession?.minigame ?? null, notes: document.querySelectorAll('.gym-panel .gym-note').length };
    }, uid);
    ok(st.r === null && st.started && st.screen === 'game' && st.minigame === kind && st.notes > 0, `${label} 게임 화면 (표식 ${st.notes}개)`, JSON.stringify(st));
    // 첫 표식(DOM 첫 `.gym-note`)은 오른쪽 가까이에서 출발해 판정선 쪽으로 — `--x` 가 창 내내 줄어든다
    const flow = await sampleFlow('.gym-panel .gym-note', '--x');
    const falling = flow.nums.length > 1 && flow.nums.every((v, i) => i === 0 || v < flow.nums[i - 1]);
    ok(flow.changes >= FLOW_MIN_CHANGES && flow.maxGap < FLOW_MAX_GAP_MS && falling,
      `입력 없이 ${label} 표식이 흘러온다 (${flow.wall} ms 동안 --x ${flow.first} → ${flow.last} · 변경 ${flow.changes}회 · 최대 간격 ${flow.maxGap} ms)`, JSON.stringify({ ...flow, nums: flow.nums.slice(0, 8) }));
    const stopped = await H(() => { const h = window.__game.ctx.housing; h.cancelGymSession(); return { ticking: h.gymScreen?.ticking, info: h.gymSession }; });
    ok(stopped.ticking === false && stopped.info === null, `${label} 취소 → 화면 루프가 멈춘다 (ticking=${stopped.ticking})`);
  }

  /* ══ 4. 취소 ══════════════════════════════════════════════════════════════ */
  console.log('취소');
  const cancel = await H(async ({ TREAD, BIKE }) => {
    const ctx = window.__game.ctx, h = ctx.housing, p = ctx.progression;
    const res0 = window.__rec.results.length;
    const before = { until: p.getGymFatigueUntil?.('endurance') ?? 0, prog: p.getTrainedProgress?.('endurance') ?? 0 };
    h.startGymSession(TREAD);
    h.gymDebug.start();
    await new Promise((r) => setTimeout(r, 300));
    const midScreen = h.gymDebug.screen;
    h.cancelGymSession();
    const evCancel = window.__rec.sessions.at(-1);
    // 사이클: 게임 도중 E 는 삼키기만, Tab 은 취소
    h.startGymSession(BIKE);
    const bikeGuideIntro = window.__rec.guide.at(-1);
    h.gymDebug.start();
    const bikeGuide = window.__rec.guide.at(-1);
    const lanes = document.querySelectorAll('.gym-panel .gym-lane').length;
    const keyE = () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true })); };
    keyE();
    const afterE = { screen: h.gymDebug.screen, pressed: ctx.input.wasPressed('KeyE') };
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', key: 'Tab', bubbles: true }));
    const evTab = window.__rec.sessions.at(-1);
    // 시작 안내에서 E → 닫기
    h.startGymSession(BIKE);
    keyE();
    const evIntroE = window.__rec.sessions.at(-1);
    return { midScreen, evCancel, bikeGuideIntro, bikeGuide, lanes, afterE, evTab, evIntroE, results: window.__rec.results.length - res0,
      after: { until: p.getGymFatigueUntil?.('endurance') ?? 0, prog: p.getTrainedProgress?.('endurance') ?? 0 }, before, info: h.gymSession };
  }, { TREAD, BIKE });
  ok(cancel.midScreen === 'game' && cancel.evCancel.active === false && cancel.evCancel.completed === false && cancel.evCancel.minigame === 'breath', 'cancelGymSession (게임 도중) → completed:false');
  ok(cancel.results === 0 && cancel.after.until === cancel.before.until && cancel.after.prog === cancel.before.prog, `취소는 결과 · 단련 · 심폐 피로 없음 (${JSON.stringify(cancel.after)})`);
  ok(JSON.stringify(cancel.bikeGuide) === JSON.stringify(['왼발', '오른발']) && cancel.lanes === 2, `사이클: 두 줄 · 키 가이드 왼발 · 오른발 (${JSON.stringify(cancel.bikeGuide)})`);
  ok(cancel.afterE.screen === 'game' && !cancel.afterE.pressed, `게임 도중 E 는 삼키기만 한다 (${JSON.stringify(cancel.afterE)})`);
  ok(cancel.evTab.active === false && cancel.evTab.completed === false && cancel.evTab.minigame === 'cycle', 'Tab (게임 도중) → 취소');
  ok(cancel.evIntroE.active === false && cancel.evIntroE.completed === false && cancel.info === null, '시작 안내에서 E → 닫기');
  // 페이즈가 바뀌면 세션이 끝난다
  const phase = await H((u) => { const h = window.__game.ctx.housing; h.startGymSession(u); window.__game.ctx.bus.emit('game:abort', {}); return { info: h.gymSession, ev: window.__rec.sessions.at(-1), hidden: document.querySelector('.gym').hidden }; }, BIKE);
  ok(phase.info === null && phase.ev.active === false && phase.ev.completed === false && phase.hidden, 'game:abort → 세션 · 화면 정리');

  /* ══ 5. 새로고침 ══════════════════════════════════════════════════════════ */
  if (hasProg) {
    console.log('새로고침');
    const keep = await H(() => { const p = window.__game.ctx.progression; return { bonus: p.getTrainedBonus('strength'), prog: p.getTrainedProgress('strength'), until: p.getGymFatigueUntil('strength') }; });
    await page.reload({ waitUntil: 'load' });
    await boot();
    const back = await H(() => { const p = window.__game.ctx.progression; return { bonus: p.getTrainedBonus('strength'), prog: p.getTrainedProgress('strength'), until: p.getGymFatigueUntil('strength'), info: window.__game.ctx.housing.gymSession }; });
    ok(back.bonus === keep.bonus && Math.abs(back.prog - keep.prog) < 1e-9 && back.until === keep.until && keep.until > 0 && back.info === null,
      `단련 · 근육통이 새로고침을 건넌다 (${JSON.stringify(back)})`, JSON.stringify(keep));
    // 다른 스모크를 위해 치운다
    await H(() => { const p = window.__game.ctx.progression; p.clearGymFatigue?.(); p.addTrainedXp?.('strength', -1e7); p.addTrainedXp?.('endurance', -1e7); });
  }

  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
