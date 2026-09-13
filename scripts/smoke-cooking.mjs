// Single-player smoke test for the **요리 미니게임 · 요리 품질** (2026-09-13, docs/plans/cooking-minigames.md §6-1, src/housing —
// parts/CookGames · parts/Cooking · ui/cook · parts/Dining · ui/DiningTable):
// 판정 6종을 화면 없이 (`cookDebug.makeGame`) — 썰기(예비 박자 무시 · 창 · 헛클릭 = 다음 표식 실패 · 놓침), 다지기(번갈아 채움 · 같은 버튼
// 연타 = 반대 게이지 감소 · 시간 선형 점수 · 강제 종료 0 점), 굽기(50 % 뒤집기 · 100 % 꺼내기 · 늦은 뒤집기 = 실패 + 꺼내기 · 탐 ·
// 불에 닿기 전 클릭 무시), 볶기(예비 박 무시 · 한 박자 한 번 · 바 채움 · 판정 평균), 젓기(누르기만 = 0 점 · 온도 제어 = 1 점 · 주기적
// stir 연출), 붓기(램프 적분 · 붓기 전엔 안 끝남 · 떼고 SETTLE 뒤 끝 · 넘침 = 0 점) → cookBlock 사유 · 조리대 레벨 잠김 → 조리대 화면
// (레일 · 단계 칩 · 조리 시작 버튼) → 세션(블로커 · ESC · 커서 · 키 가이드 · 실제 pointerdown 칼질 → housing:cookBeat) → 결과 = 품질 요리가
// 창고에 · 재료 소모 → 다시 만들기 → 품질이 다른 요리 둘이 안 합쳐진다 → Tab 닫기 → 취소(Esc · game:abort · 자세 리셋) = 재료 그대로 →
// 자동 가구 Lv.1/2/3 점수 · 선택 카드 · 자동 연출 → 식탁 (품질 줄 · 먹기) → 새로고침 뒤 품질 보존 → 출격 식사의 derived 보너스.
// Usage: node scripts/smoke-cooking.mjs [http://localhost:5273]   (needs `npm run dev`)
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

/** `data/constants.csv` 의 COOK_* · `data/tables.csv` 의 품질 · 자동 점수 표 — 기대값을 수치에서 유도한다. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const K = {};
for (const line of readFileSync(join(ROOT, 'data', 'constants.csv'), 'utf8').split(/\r?\n/)) {
  const m = /^(COOK_[A-Z_]+),([^,]+)/.exec(line);
  if (m) K[m[1]] = Number(m[2]);
}
const T = { MEAL_QUALITY_SCORE_MIN: [], MEAL_QUALITY_BONUS: [], COOK_AUTO_SCORE_BY_LEVEL: [] };
for (const line of readFileSync(join(ROOT, 'data', 'tables.csv'), 'utf8').split(/\r?\n/)) {
  const m = /^(MEAL_QUALITY_SCORE_MIN|MEAL_QUALITY_BONUS|COOK_AUTO_SCORE_BY_LEVEL),(\d+),([^,\s]+)/.exec(line);
  if (m) T[m[1]][Number(m[2])] = Number(m[3]);
}
const qualityFor = (s) => { let q = 0; T.MEAL_QUALITY_SCORE_MIN.forEach((min, i) => { if (s + 1e-9 >= min) q = i; }); return q; };

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const note = (s) => console.log(`  note ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
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
      window.__rec = { sessions: [], steps: [], beats: [], results: [], audio: [], guide: [], station: [], served: [], notify: [] };
      b.on('housing:cookSession', (p) => window.__rec.sessions.push({ ...p }));
      b.on('housing:cookStep', (p) => window.__rec.steps.push({ ...p }));
      b.on('housing:cookBeat', (p) => window.__rec.beats.push({ ...p }));
      b.on('housing:cookResult', (p) => window.__rec.results.push({ ...p }));
      b.on('ui:cookStationToggled', (p) => window.__rec.station.push({ ...p }));
      b.on('ui:notify', (p) => window.__rec.notify.push(p.text));
      b.on('audio:play', (p) => { if (/^cook_/.test(p.id)) window.__rec.audio.push(p.id); });
      b.on('ui:keyGuide', (p) => { if (p.owner === 'housing.cook') window.__rec.guide.push(p.keys ? p.keys.map((k) => k.label) : null); });
    });
  };

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');
  await page.evaluate(() => { localStorage.removeItem('scav.s1.ship'); localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); });
  await page.reload({ waitUntil: 'load' });
  await boot();

  /* ══ 1. 판정 — 화면 없이 ══════════════════════════════════════════════════ */
  console.log('판정 (썰기)');
  const chop = await H((K) => {
    const g = window.__game.ctx.housing.cookDebug.makeGame('chop');
    const to = (t) => g.update(t - g.time);
    const n = g.notes, B = g.beatS, W = g.window;
    g.press('left');                                   // 예비 박자 동안의 클릭은 무시
    const lead = g.judgements.length;
    to(n[0].t); g.press('right'); g.press('left');     // 우클릭은 썰기가 아니다 · 정박 → 완벽
    to(n[1].t + W * 0.6); g.press('left');             // 좋음
    to(n[2].t - B / 2); g.press('left');               // 헛클릭 → 다음 표식(2) 실패
    to(n[3].t + W + 0.01);                             // 놓침 (클릭 없음)
    for (let i = 4; i < n.length; i++) { to(n[i].t); g.press('left'); }
    const ev = g.drain();
    return { lead, total: g.total, judgements: [...g.judgements], score: g.score, done: g.done,
      cuts: ev.filter((e) => e.type === 'beat' && e.action === 'cut').length, times: n.map((x) => x.t) };
  }, K);
  const chopWant = ['perfect', 'good', 'miss', 'miss', ...Array(Math.max(0, K.COOK_CHOP_CUTS - 4)).fill('perfect')];
  ok(chop.lead === 0, '예비 박자 동안의 좌클릭은 판정이 아니다');
  ok(chop.total === K.COOK_CHOP_CUTS && near(chop.times[0], K.COOK_LEAD_BEATS * K.COOK_CHOP_BEAT_S), `표식 ${chop.total}개 · 첫 표식 ${chop.times[0]} 초`);
  ok(JSON.stringify(chop.judgements) === JSON.stringify(chopWant), `정박 · 좋음 · 헛클릭 · 놓침 (${JSON.stringify(chop.judgements)})`);
  const chopScore = ((K.COOK_CHOP_CUTS - 3) * K.COOK_SCORE_PERFECT + K.COOK_SCORE_GOOD) / K.COOK_CHOP_CUTS;
  ok(chop.done && near(chop.score, chopScore), `썰기 점수 = 판정 평균 (${chop.score?.toFixed(4)} = ${chopScore.toFixed(4)})`);
  ok(chop.cuts === K.COOK_CHOP_CUTS - 1, `칼질 연출 ${chop.cuts}회 (놓친 표식은 칼질이 없다)`);

  console.log('판정 (다지기)');
  const mince = await H((K) => {
    const d = window.__game.ctx.housing.cookDebug;
    // ① 같은 버튼 연타는 반대 게이지를 깎는다
    const a = d.makeGame('mince');
    a.press('right'); const v1 = a.v;
    a.press('left'); const h1 = a.h;
    a.press('left'); const drained = { h: a.h, v: a.v };
    a.press('left'); a.press('left'); a.press('left');         // 반대쪽은 0 아래로 안 간다
    const floor = a.v;
    const beats = a.drain().filter((e) => e.type === 'beat').map((e) => e.action);
    // ② 번갈아 누르면 PERFECT_S 안에 끝 → 1 점
    const b = d.makeGame('mince');
    let guard = 0;
    while (!b.done && guard++ < 500) { b.update(0.05); b.press(guard % 2 ? 'left' : 'right'); }
    // ③ 끝난 시간이 PERFECT 와 ZERO 의 한가운데 → 0.5 점
    const c = d.makeGame('mince');
    const need = Math.ceil(1 / K.COOK_MINCE_FILL);
    const mid = (K.COOK_MINCE_PERFECT_S + K.COOK_MINCE_ZERO_S) / 2;
    for (let i = 0; i < need * 2 - 1; i++) c.press(i % 2 ? 'right' : 'left');
    c.update(mid - c.time);
    c.press(need * 2 % 2 ? 'left' : 'right');
    // ④ 강제 종료
    const e = d.makeGame('mince');
    e.press('left');
    e.update(K.COOK_MINCE_MAX_S + 0.01);
    return { v1, h1, drained, floor, beats: beats.slice(0, 3), fast: { done: b.done, score: b.score, t: b.doneAt },
      mid: { done: c.done, score: c.score, t: c.doneAt, h: c.h, v: c.v }, timeout: { done: e.done, score: e.score, timedOut: e.timedOut } };
  }, K);
  ok(near(mince.v1, K.COOK_MINCE_FILL) && near(mince.h1, K.COOK_MINCE_FILL), `클릭마다 그 게이지 +${K.COOK_MINCE_FILL}`);
  ok(near(mince.drained.h, K.COOK_MINCE_FILL * 2) && near(mince.drained.v, Math.max(0, K.COOK_MINCE_FILL - K.COOK_MINCE_DRAIN)), `같은 버튼 연타 = 반대 게이지 −${K.COOK_MINCE_DRAIN} (${JSON.stringify(mince.drained)})`);
  ok(mince.floor === 0, `반대 게이지는 0 아래로 안 간다 (${mince.floor})`);
  ok(JSON.stringify(mince.beats) === JSON.stringify(['mince_v', 'mince_h', 'mince_h']), `연출: 우클릭 = mince_v · 좌클릭 = mince_h (${JSON.stringify(mince.beats)})`);
  ok(mince.fast.done && mince.fast.score === 1 && mince.fast.t <= K.COOK_MINCE_PERFECT_S, `번갈아 빠르게 = 1 점 (${mince.fast.t?.toFixed(2)} 초)`);
  ok(mince.mid.done && near(mince.mid.score, 0.5, 1e-3), `끝난 시간이 완벽 ~ 0점 한가운데 = 0.5 점 (${mince.mid.score?.toFixed(4)} · ${mince.mid.t?.toFixed(2)} 초)`, JSON.stringify(mince.mid));
  ok(mince.timeout.done && mince.timeout.timedOut && mince.timeout.score === 0, `${K.COOK_MINCE_MAX_S} 초 강제 종료 = 0 점`);

  console.log('판정 (굽기)');
  const grill = await H((K) => {
    const d = window.__game.ctx.housing.cookDebug;
    const step = { meal: 'smoke', order: 1, game: 'grill', items: ['food_beef', 'food_chicken'], liquid: null, targetMl: null };
    const g = d.makeGame(step);
    const to = (t) => g.update(t - g.time);
    const [p0, p1] = g.pieces;
    g.clickPiece(1);                                             // 아직 불에 안 닿았다 → 무시
    const early = { judgements: g.judgements.length, flipped: p1.flipped };
    to(p0.start + p0.seconds * 0.5); g.clickPiece(0);            // 50 % 뒤집기 → 완벽
    to(p1.start + p1.seconds * (0.5 + K.COOK_GRILL_FLIP_GOOD * 0.8)); g.clickPiece(1);   // 좋음
    to(p0.start + p0.seconds * 1.0); g.clickPiece(0);            // 100 % 꺼내기 → 완벽
    to(p1.start + p1.seconds * K.COOK_GRILL_BURN_AT + 0.01);     // 안 꺼냈다 → 탐
    const ev = g.drain();
    const late = d.makeGame(step);
    const q0 = late.pieces[0];
    late.update(q0.start + q0.seconds * 0.9 - late.time);        // 안 뒤집고 90 % → 뒤집기 실패 + 곧장 꺼내기(좋음)
    late.clickPiece(0);
    return { early, seconds: [p0.seconds, p1.seconds], start1: p1.start, judgements: [...g.judgements], score: g.score, done: g.done,
      burned: p1.burned, beats: ev.filter((e) => e.type === 'beat').map((e) => e.action), sizzles: ev.filter((e) => e.type === 'sound').length,
      late: { judgements: [...late.judgements], removed: q0.removed, flipQ: q0.flipQ, doneQ: q0.doneQ, done: late.done } };
  }, K);
  ok(grill.early.judgements === 0 && !grill.early.flipped, '불에 닿기 전의 조각 클릭은 무시');
  ok(near(grill.seconds[0], 8) && near(grill.seconds[1], 7) && near(grill.start1, K.COOK_GRILL_STAGGER_S), `굽는 시간 = cook_grill.csv (소 ${grill.seconds[0]} · 닭 ${grill.seconds[1]}) · 두 번째 조각은 ${grill.start1} 초 늦게`);
  ok(JSON.stringify(grill.judgements) === JSON.stringify(['perfect', 'good', 'perfect', 'miss']) && grill.burned && grill.done, `뒤집기 완벽 · 좋음 · 꺼내기 완벽 · 탐 (${JSON.stringify(grill.judgements)})`);
  ok(near(grill.score, (2 * K.COOK_SCORE_PERFECT + K.COOK_SCORE_GOOD) / 4), `굽기 점수 = 조각 × 2 판정 평균 (${grill.score?.toFixed(4)})`);
  ok(JSON.stringify(grill.beats) === JSON.stringify(['flip', 'flip', 'remove', 'burn']) && grill.sizzles === 2, `연출 flip · flip · remove · burn · 지글 ${grill.sizzles}회`);
  ok(JSON.stringify(grill.late.judgements) === JSON.stringify(['miss', 'good']) && grill.late.removed && !grill.late.done, `늦은 첫 클릭 = 뒤집기 실패 + 꺼내기 (${JSON.stringify(grill.late)})`);

  console.log('판정 (볶기)');
  const stirfry = await H((K) => {
    const g = window.__game.ctx.housing.cookDebug.makeGame('stirfry');
    const to = (t) => g.update(t - g.time);
    const B = g.beatS, W = g.window;
    g.press('left');                                   // 예비 박
    const lead = g.judgements.length;
    to(g.beatTime(0)); g.press('left');                // 완벽
    const bar1 = g.bar;
    to(g.beatTime(0) + 0.01); g.press('left');         // 같은 박자 두 번째 → 무시
    const dup = g.judgements.length;
    to(g.beatTime(1) + W * 0.6); g.press('left');      // 좋음
    to(g.beatTime(2) + Math.min(B / 2 - 0.01, W + 0.05)); g.press('left');   // 창 밖이지만 가까운 박자 → 실패(조금 찬다)
    const bars = [bar1, g.bar];
    let k = 3;
    while (!g.done && k < 60) { to(g.beatTime(k)); g.press('left'); k++; }
    return { lead, bar1, dup, bars, judgements: [...g.judgements], score: g.score, done: g.done, bar: g.bar,
      tosses: g.drain().filter((e) => e.type === 'beat' && e.action === 'toss').length };
  }, K);
  const sfFill = K.COOK_STIRFRY_FILL_PERFECT + K.COOK_STIRFRY_FILL_GOOD + K.COOK_STIRFRY_FILL_MISS;
  const sfMore = Math.max(0, Math.ceil((1 - sfFill) / K.COOK_STIRFRY_FILL_PERFECT - 1e-9));
  const sfWant = ['perfect', 'good', 'miss', ...Array(sfMore).fill('perfect')];
  ok(stirfry.lead === 0 && near(stirfry.bar1, K.COOK_STIRFRY_FILL_PERFECT) && stirfry.dup === 1, '예비 박 무시 · 완벽 = 바 +FILL_PERFECT · 같은 박자 두 번째 클릭은 무시');
  ok(near(stirfry.bars[1], sfFill), `완벽 · 좋음 · 실패 = 바 ${sfFill.toFixed(2)} (${stirfry.bars[1]?.toFixed(3)})`);
  ok(stirfry.done && JSON.stringify(stirfry.judgements) === JSON.stringify(sfWant), `바 ≥ 1 이면 끝 (${JSON.stringify(stirfry.judgements)})`);
  const sfScore = ((sfMore + 1) * K.COOK_SCORE_PERFECT + K.COOK_SCORE_GOOD) / (sfMore + 3);
  ok(near(stirfry.score, sfScore) && stirfry.tosses === sfWant.length, `볶기 점수 = 판정 평균 (${stirfry.score?.toFixed(4)} = ${sfScore.toFixed(4)}) · 팬 튕김 ${stirfry.tosses}`);

  console.log('판정 (젓기)');
  const stir = await H((K) => {
    const d = window.__game.ctx.housing.cookDebug;
    const a = d.makeGame('stir');
    const t0 = a.temp;
    a.press('left');
    let guard = 0;
    while (!a.done && guard++ < 10000) a.update(0.02);
    const hold = { done: a.done, score: a.score, ratio: a.ratio, elapsed: a.elapsed, temp: a.temp,
      stirs: a.drain().filter((e) => e.type === 'beat' && e.action === 'stir').length };
    // 온도 제어: 가운데보다 뜨거우면 누르고 아니면 뗀다
    const b = d.makeGame('stir');
    const mid = (K.COOK_STIR_BAND_LOW + K.COOK_STIR_BAND_HIGH) / 2;
    guard = 0;
    while (!b.done && guard++ < 20000) {
      if (b.temp > mid && !b.holding) b.press('left');
      else if (b.temp <= mid && b.holding) b.release('left');
      b.update(0.02);
    }
    // 떼고만 있으면 온도가 오르고 완성은 멈춘다
    const c = d.makeGame('stir');
    c.update(1);
    return { t0, hold, control: { done: b.done, score: b.score, ratio: b.ratio }, idle: { temp: c.temp, progress: c.progress, done: c.done } };
  }, K);
  ok(near(stir.t0, (K.COOK_STIR_BAND_LOW + K.COOK_STIR_BAND_HIGH) / 2), `시작 온도 = 구간 한가운데 (${stir.t0})`);
  ok(stir.hold.done && near(stir.hold.elapsed, K.COOK_STIR_TIME_S, 0.03) && stir.hold.score === 0, `누르기만 = ${K.COOK_STIR_TIME_S} 초에 끝 · 구간 유지 ${Math.round(stir.hold.ratio * 100)} % = 0 점`, JSON.stringify(stir.hold));
  // hub 의 국자는 마지막 stir 0.45 초 뒤 멈춘다 — 누르는 동안 적어도 0.3 초마다 와야 한다
  ok(stir.hold.stirs >= Math.floor(K.COOK_STIR_TIME_S / 0.3), `누르는 동안 stir 연출이 0.3 초 이내 간격으로 (${stir.hold.stirs}회 / ${K.COOK_STIR_TIME_S} 초)`);
  ok(stir.control.done && stir.control.score === 1 && stir.control.ratio >= K.COOK_STIR_PERFECT_RATIO, `온도를 구간에 두면 1 점 (유지 ${Math.round(stir.control.ratio * 100)} %)`);
  ok(stir.idle.temp > stir.t0 && stir.idle.progress === 0 && !stir.idle.done, `떼고 있으면 온도 ↑ · 완성은 멈춘다 (${stir.idle.temp.toFixed(3)})`);

  console.log('판정 (붓기)');
  const pour = await H((K) => {
    const d = window.__game.ctx.housing.cookDebug;
    const step = { meal: 'smoke', order: 1, game: 'pour', items: [], liquid: 'water', targetMl: 250 };
    const a = d.makeGame(step);
    a.update(3);                                              // 한 번도 안 부었다 → 안 끝난다
    const idleDone = a.done;
    a.press('left');
    a.update(K.COOK_POUR_RAMP_S / 2);
    const half = { flow: a.flow, amount: a.amount };
    // 떼는 동안 부어지는 양(램프의 반) 만큼 일찍 뗀다
    const tail = K.COOK_POUR_RATE_ML_S * K.COOK_POUR_RAMP_S / 2;
    let guard = 0;
    while (a.amount + tail < a.target && guard++ < 100000) a.update(0.001);
    a.release('left');
    a.update(K.COOK_POUR_RAMP_S);
    const afterRamp = { flow: a.flow, done: a.done, amount: a.amount };
    a.update(K.COOK_POUR_SETTLE_S * 0.5);
    const beforeSettle = a.done;
    a.update(K.COOK_POUR_SETTLE_S * 0.5 + 0.01);
    const b = d.makeGame(step);
    b.press('left');
    guard = 0;
    while (!b.done && guard++ < 100000) b.update(0.01);
    return { idleDone, half, afterRamp, beforeSettle, done: a.done, score: a.score, err: a.error, amount: a.amount,
      beats: a.drain().filter((e) => e.type === 'beat').map((e) => e.action),
      over: { done: b.done, overflowed: b.overflowed, score: b.score, amount: b.amount, cap: b.capacity } };
  }, K);
  ok(!pour.idleDone, '한 번도 붓지 않았으면 가만히 있어도 끝나지 않는다');
  ok(near(pour.half.flow, 0.5, 1e-6) && near(pour.half.amount, K.COOK_POUR_RATE_ML_S * (K.COOK_POUR_RAMP_S / 2) * 0.25, 1e-6), `램프 중간: 흐름 0.5 · 양 ${pour.half.amount?.toFixed(2)} ml (사다리꼴 적분)`);
  ok(pour.afterRamp.flow === 0 && !pour.afterRamp.done && !pour.beforeSettle && pour.done, `떼고 흐름 0 → ${K.COOK_POUR_SETTLE_S} 초 가만히 있어야 끝`);
  ok(pour.err <= K.COOK_POUR_PERFECT_ERR && pour.score === 1, `목표 250 ml ≈ ${pour.amount?.toFixed(1)} ml → 1 점`);
  ok(JSON.stringify(pour.beats) === JSON.stringify(['pour_start', 'pour_stop']), `연출 pour_start · pour_stop (${JSON.stringify(pour.beats)})`);
  ok(pour.over.done && pour.over.overflowed && pour.over.score === 0 && near(pour.over.amount, 250 * K.COOK_POUR_BEAKER_MUL), `넘치면 곧장 끝 · 0 점 (${pour.over.amount} / ${pour.over.cap})`);

  /* ══ 2. 함선 · 주방 · 조리대 ══════════════════════════════════════════════ */
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitFor(page, () => [...document.querySelectorAll('.menu.hidden')].every((m) => {
    const cs = getComputedStyle(m);
    return cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
  }), '숨은 메뉴의 페이드가 끝난다', 5000);
  const giveStash = (id, n) => H(({ id, n }) => {
    const ctx = window.__game.ctx;
    const def = ctx.loot.getItemDef(id);
    let added = 0;
    while (added < n) { const q = Math.min(def.stackMax ?? 1, n - added); if (!ctx.inventory.tryAddToStash(ctx.loot.createItem(id, q))) break; added += q; }
    return added;
  }, { id, n });
  for (const [id, n] of [['mat_scrap', 60], ['mat_alloy', 20], ['mat_cable', 16], ['mat_circuit', 8], ['mat_cloth', 12]]) await giveStash(id, n);
  await H(() => {
    const h = window.__game.ctx.housing;
    h.state.generatorLevel = 5;
    for (const [i, p] of [[3, 'greenhouse'], [5, 'kitchen']]) h.state.rooms[i].purpose = p;
  });
  const placeFurn = (room, defId) => H(({ room, defId }) => {
    const h = window.__game.ctx.housing;
    const have = h.getPlaced().find((p) => p.defId === defId);
    if (have) return { uid: have.uid };
    if (!h.craftFurniture(defId)) return { err: `craft: ${h.furnitureCraftBlock?.(defId) ?? '?'}` };
    const spot = h.findFreeSpot(room, defId);
    if (!spot) return { err: 'no spot' };
    const p = h.place(room, defId, spot.x, spot.y, spot.yaw);
    return p ? { uid: p.uid } : { err: 'place refused' };
  }, { room, defId });
  const benchP = await placeFurn(5, 'furn_bench_cook');
  const tableP = await placeFurn(5, 'furn_dining_table');
  ok(benchP.uid && tableP.uid, 'craft + place 조리대 · 식탁', JSON.stringify({ benchP, tableP }));
  const BENCH = benchP.uid, TABLE = tableP.uid;
  const apis = await H(() => {
    const inv = window.__game.ctx.inventory, p = window.__game.ctx.progression;
    return { cookBlock: typeof inv.cookBlock === 'function', completeCook: typeof inv.completeCook === 'function', countQ: typeof inv.countDefQualityAll === 'function',
      stacks: typeof inv.getMealStacks === 'function', mealQ: typeof p.getMealQuality === 'function' };
  });
  ok(apis.cookBlock && apis.completeCook && apis.countQ && apis.stacks, `inventory 조리 API (${JSON.stringify(apis)})`);
  if (!apis.mealQ) note('progression.getMealQuality 없음 — 식탁 품질 · derived 보너스 검사는 건너뛴다 (cook-progression-player 미완)');
  for (const [id, n] of [['crop_leafgreen', 40], ['crop_frostberry', 10], ['crop_tuber', 20]]) await giveStash(id, n);

  /* ══ 3. cookBlock ═════════════════════════════════════════════════════════ */
  console.log('cookBlock');
  const blocks = await H(({ BENCH, TABLE }) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const out = {
      notBench: h.cookBlock(TABLE, 'cook_green_salad'), unknown: h.cookBlock('f-9999', 'cook_green_salad'),
      notRecipe: h.cookBlock(BENCH, 'make_boost_adrenaline'), ok: h.cookBlock(BENCH, 'cook_green_salad'),
      level: h.cookBlock(BENCH, 'cook_sausage'), benchLv: h.getPlacedByUid(BENCH).level,
    };
    ctx.isRaidActive = () => true;
    out.raid = h.cookBlock(BENCH, 'cook_green_salad');
    delete ctx.isRaidActive;
    out.start = h.startCook(TABLE, 'cook_green_salad');
    out.sessions = window.__rec.sessions.length;
    out.info = h.cookSession;
    out.recipes = h.cookDebug.recipes();
    return out;
  }, { BENCH, TABLE });
  ok(blocks.notBench === '조리대가 아닙니다' && blocks.unknown === '조리대가 아닙니다', `조리대가 아니면 거절 (${blocks.notBench})`);
  ok(blocks.raid === '함선에서만 요리할 수 있습니다', `레이드 중이면 거절 (${blocks.raid})`);
  ok(blocks.notRecipe === '요리 레시피가 아닙니다', `조리대 레시피가 아니면 거절 (${blocks.notRecipe})`);
  ok(blocks.ok === null, `재료가 있는 잎채소 샐러드는 시작할 수 있다 (${blocks.ok})`);
  ok(blocks.benchLv === 1 && typeof blocks.level === 'string' && /Lv\.? ?2/.test(blocks.level), `조리대 Lv.1 에서 Lv.2 요리는 잠김 (${blocks.level})`);
  ok(blocks.start === '조리대가 아닙니다' && blocks.sessions === 0 && blocks.info === null, 'startCook 거절은 세션도 이벤트도 없다');
  const salad = blocks.recipes.find((r) => r.id === 'cook_green_salad');
  const stew = blocks.recipes.find((r) => r.id === 'cook_tuber_stew');
  ok(salad && JSON.stringify(salad.steps) === '["chop"]' && stew && JSON.stringify(stew.steps) === '["chop","stir"]', `레시피 단계 = cook_steps.csv (샐러드 ${JSON.stringify(salad?.steps)} · 스튜 ${JSON.stringify(stew?.steps)})`);

  /* ══ 4. 조리대 화면 ═══════════════════════════════════════════════════════ */
  console.log('조리대 화면');
  const st = await H((BENCH) => {
    const h = window.__game.ctx.housing;
    h.openCookStation(BENCH);
    return { debug: h.cookDebug.station, ev: window.__rec.station.at(-1) ?? null, blocker: window.__game.ctx.uiBlockers.has('housing') };
  }, BENCH);
  await waitFor(page, () => { const r = document.querySelector('.menu.cook-station'); return r && !r.hidden && r.querySelectorAll('.cook-rail-item').length > 0; }, 'cook station open', 5000);
  ok(st.debug.open && st.debug.uid === BENCH && st.ev?.open === true && st.ev.uid === BENCH && st.blocker, `openCookStation → 화면 + ui:cookStationToggled (${JSON.stringify(st.ev)})`);
  // 스튜를 레일에서 클릭해 고른다 → 단계 칩 두 개
  const pick = await H(() => {
    const btn = document.querySelector('.menu.cook-station .cook-rail-item[data-recipe="cook_tuber_stew"]');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return !!btn;
  });
  await sleep(50);
  const stDom = await H(() => {
    const r = document.querySelector('.menu.cook-station');
    const h = window.__game.ctx.housing;
    return { picked: h.cookDebug.station.recipeId, rail: r.querySelectorAll('.cook-rail-item').length, recipes: h.cookDebug.recipes().length,
      tiers: r.querySelectorAll('.cook-rail-tier').length, chips: [...r.querySelectorAll('.cook-stepchip-main')].map((x) => x.textContent),
      cost: r.querySelectorAll('.cook-sel-cost .item-chip').length, effects: r.querySelectorAll('.cook-eff-line').length,
      start: r.querySelector('.cook-start')?.classList.contains('is-blocked'), name: r.querySelector('.cook-sel-name')?.textContent,
      grids: r.querySelectorAll('.hs-card-inv .trade-grids').length };
  });
  ok(pick && stDom.picked === 'cook_tuber_stew' && stDom.name === '덩이줄기 스튜', `레일 클릭으로 요리 선택 (${stDom.picked} · ${stDom.name})`);
  ok(stDom.rail === stDom.recipes && stDom.tiers >= 1, `레일 = 조리대 레시피 ${stDom.rail}줄 · 티어 묶음 ${stDom.tiers}`);
  ok(stDom.chips.length === 2 && /① .*썰기/.test(stDom.chips[0]) && /② .*젓기/.test(stDom.chips[1]), `단계 칩 줄 (${JSON.stringify(stDom.chips)})`);
  ok(stDom.cost === 2 && stDom.effects >= 1 && stDom.start === false && stDom.grids === 2, `재료 칩 ${stDom.cost} · 능력치 줄 ${stDom.effects} · 조리 시작 활성 · 창고/가방 카드`);

  /* ══ 5. 세션 — 스튜 (썰기 → 젓기), 버튼으로 시작 ══════════════════════════ */
  console.log('세션 (덩이줄기 스튜)');
  const before = await H(() => { const inv = window.__game.ctx.inventory; return { tuber: inv.countDefAll('crop_tuber'), leaf: inv.countDefAll('crop_leafgreen') }; });
  await H(() => document.querySelector('.menu.cook-station .cook-start').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const s1 = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    return { info: h.cookSession, ev: window.__rec.sessions.at(-1) ?? null, blocker: ctx.uiBlockers.has('housing.cook'), esc: ctx.escape.has('housing.cook'),
      cursor: ctx.input.cursor?.has?.('housing.cook') ?? ctx.input.isCursorMode ?? null, stationOpen: h.cookDebug.station.open, screen: h.cookDebug.screen, game: h.cookDebug.game?.game ?? null,
      step: window.__rec.steps.at(-1) ?? null, guide: window.__rec.guide.at(-1) ?? null, panel: !document.querySelector('.cook').hidden,
      head: document.querySelector('.cook-steps')?.textContent ?? '', again: h.startCook(h.cookDebug.station.uid || '', 'cook_tuber_stew'),
      audio: window.__rec.audio.includes('cook_start'), stage: !!document.querySelector('.cook-panel .cook-stage.cook-chop') };
  });
  ok(s1.info?.recipeId === 'cook_tuber_stew' && s1.info.mealDefId === 'meal_tuber_stew' && s1.info.steps.length === 2, `조리 시작 버튼 → 세션 (${JSON.stringify(s1.info?.steps?.map((x) => x.game))})`);
  ok(s1.ev?.active === true && s1.ev.completed === false && s1.audio, 'housing:cookSession {active:true} · cook_start');
  ok(s1.blocker && s1.esc && s1.cursor === true && !s1.stationOpen && s1.panel, `블로커 · ESC · 커서 모드 housing.cook · 조리대 화면은 닫힌다 (cursor=${s1.cursor})`);
  ok(s1.screen === 'game' && s1.game === 'chop' && s1.stage && s1.step?.phase === 'play' && s1.step.index === 0 && s1.step.total === 2, `자동 가구가 없으면 곧장 미니게임 (${JSON.stringify(s1.step)})`);
  ok(JSON.stringify(s1.guide) === JSON.stringify(['썰기']) && /① 썰기 …/.test(s1.head), `키 가이드 · 머리줄 (${s1.head})`);
  ok(typeof s1.again === 'string', `조리 중 두 번째 시작은 거절 (${s1.again})`);
  // 실제 pointerdown — 표식이 판정선에 가까워질 때 무대에서 좌클릭
  const live = await H(() => new Promise((res) => {
    const h = window.__game.ctx.housing;
    const t0 = performance.now();
    const iv = setInterval(() => {
      const g = h.cookDebug.game;
      if (!g) { clearInterval(iv); res({ err: 'no game' }); return; }
      const n = g.upcoming;
      if ((n && n.t - g.time < 0.03) || performance.now() - t0 > 8000) {
        clearInterval(iv);
        const stage = document.querySelector('.cook-panel .cook-stage');
        stage.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
        res({ beats: window.__rec.beats.map((b) => ({ ...b })), judgements: [...g.judgements], audio: window.__rec.audio.slice(-4) });
      }
    }, 2);
  }));
  const cut = live.beats?.[0];
  ok(cut && cut.action === 'cut' && cut.game === 'chop' && ['perfect', 'good'].includes(cut.quality) && live.audio.includes('cook_chop'),
    `무대 좌클릭 → housing:cookBeat cut (${JSON.stringify(cut)})`, JSON.stringify(live));
  const s2 = await H(() => {
    const h = window.__game.ctx.housing;
    const r = h.cookDebug.finishStep(1);
    return { r, screen: h.cookDebug.screen, index: h.cookDebug.stepIndex, game: h.cookDebug.game?.game ?? null, steps: window.__rec.steps.slice(-2),
      head: document.querySelector('.cook-steps')?.textContent ?? '', guide: window.__rec.guide.at(-1) };
  });
  ok(s2.r && s2.screen === 'game' && s2.index === 1 && s2.game === 'stir', `finishStep(1) → 두 번째 단계 젓기 (${s2.screen} · ${s2.game})`);
  ok(s2.steps[0]?.phase === 'done' && s2.steps[0].score === 1 && s2.steps[0].auto === false && s2.steps[1]?.phase === 'play' && s2.steps[1].index === 1, 'housing:cookStep done(1) → play(1)');
  ok(/① 썰기 ✓/.test(s2.head) && /② 젓기 …/.test(s2.head) && JSON.stringify(s2.guide) === JSON.stringify(['젓기']), `머리줄 ${s2.head} · 키 가이드 젓기 (꾹)`);
  const wantQ1 = qualityFor((1 + 0.5) / 2);
  const s3 = await H(() => {
    const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
    h.cookDebug.finishStep(0.5);
    const r = h.cookDebug.result;
    return { screen: h.cookDebug.screen, r, ev: window.__rec.results.at(-1) ?? null, tuber: inv.countDefAll('crop_tuber'), leaf: inv.countDefAll('crop_leafgreen'),
      q: r ? inv.countDefQualityAll('meal_tuber_stew', r.quality) : -1, stars: document.querySelector('.cook-result .cook-stars')?.textContent ?? '',
      landed: document.querySelector('.cook-result .cook-landed')?.textContent ?? '', audio: window.__rec.audio.includes('cook_finish'),
      again: !document.querySelector('.cook-result .cook-again')?.classList.contains('is-blocked') };
  });
  ok(s3.screen === 'result' && s3.r && near(s3.r.score, 0.75) && s3.r.quality === wantQ1 && JSON.stringify(s3.r.stepScores) === '[1,0.5]', `요리 점수 = 평균 0.75 → 품질 ${s3.r?.quality} (기대 ${wantQ1})`, JSON.stringify(s3.r));
  ok(s3.r && !s3.r.reason && s3.r.itemUid && s3.r.landed === 'stash' && s3.ev?.uid === BENCH && s3.audio, `요리가 함선 창고로 · housing:cookResult · cook_finish (${s3.r?.reason ?? s3.r?.landed})`);
  ok(s3.tuber === before.tuber - 3 && s3.leaf === before.leaf - 2 && s3.q >= 1, `재료는 끝에서 빠진다 (덩이줄기 ${before.tuber} → ${s3.tuber} · 잎채소 ${before.leaf} → ${s3.leaf}) · 품질 ${s3.r?.quality} 스튜 ${s3.q}`);
  ok(s3.stars === '★'.repeat(wantQ1) + '☆'.repeat(5 - wantQ1) && /함선 창고/.test(s3.landed) && s3.again, `결과 카드 (${s3.stars} · ${s3.landed})`);

  /* ── 다시 만들기 → 품질이 다른 요리 둘은 안 합쳐진다 ── */
  const again = await H(() => {
    const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory;
    const r = h.cookDebug.restart();
    const mid = { screen: h.cookDebug.screen, index: h.cookDebug.stepIndex, sessions: window.__rec.sessions.length };
    h.cookDebug.finishStep(1); h.cookDebug.finishStep(1);
    const res = h.cookDebug.result;
    const stacks = inv.getMealStacks().filter((s) => s.defId === 'meal_tuber_stew');
    return { r, mid, res, stacks, q5: inv.countDefQualityAll('meal_tuber_stew', 5) };
  });
  ok(again.r === null && again.mid.screen === 'game' && again.mid.index === 0, `다시 만들기 → 같은 세션에서 첫 단계부터 (${JSON.stringify(again.mid)})`);
  ok(again.res && again.res.quality === qualityFor(1) && again.q5 === 1, `두 번째 판 1 점 → 품질 ${again.res?.quality}`);
  ok(again.stacks.length === 2 && again.stacks.every((s) => s.qty === 1) && again.stacks[0].quality > again.stacks[1].quality, `품질이 다른 스튜 둘은 따로 쌓인다 (${JSON.stringify(again.stacks)})`);
  const dtab = async () => H(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', key: 'Tab', bubbles: true }));
  });
  await dtab();
  const closed = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    return { ev: window.__rec.sessions.at(-1), info: h.cookSession, blocker: ctx.uiBlockers.has('housing.cook'), esc: ctx.escape.has('housing.cook'),
      hidden: document.querySelector('.cook').hidden, inv: !!ctx.inventory.isOpen, guide: window.__rec.guide.at(-1), ticking: h.cookScreen?.ticking };
  });
  ok(closed.ev.active === false && closed.ev.completed === true && closed.info === null, 'Tab → housing:cookSession {active:false, completed:true}');
  ok(!closed.blocker && !closed.esc && closed.hidden && !closed.inv && closed.guide === null && closed.ticking === false, 'Tab: 블로커 · ESC · 화면 · 키 가이드 · 루프 정리, 인벤토리는 안 열린다');

  /* ══ 6. 취소 = 재료 그대로 ════════════════════════════════════════════════ */
  console.log('취소');
  const cancel = await H(({ BENCH }) => {
    const ctx = window.__game.ctx, h = ctx.housing, inv = ctx.inventory;
    const count = () => ({ leaf: inv.countDefAll('crop_leafgreen'), berry: inv.countDefAll('crop_frostberry'), salad: inv.countDefAll('meal_green_salad') });
    const c0 = count();
    const res0 = window.__rec.results.length;
    const out = {};
    out.startEsc = h.startCook(BENCH, 'cook_green_salad');
    ctx.escape.closeTop();
    out.evEsc = window.__rec.sessions.at(-1);
    out.startPose = h.startCook(BENCH, 'cook_green_salad');
    ctx.bus.emit('player:furniturePoseEnded', { kind: 'cook', reason: 'caller' });
    out.caller = h.cookSession !== null;
    ctx.bus.emit('player:furniturePoseEnded', { kind: 'cook', reason: 'reset' });
    out.reset = h.cookSession === null;
    // game:abort 은 페이즈를 함선 밖으로 옮긴다 — 마지막에 하고, 아래에서 함선으로 다시 들어간다
    out.startAbort = h.startCook(BENCH, 'cook_green_salad');
    ctx.bus.emit('game:abort', {});
    out.evAbort = { ev: window.__rec.sessions.at(-1), info: h.cookSession, hidden: document.querySelector('.cook').hidden };
    out.c1 = count();
    out.c0 = c0;
    out.results = window.__rec.results.length - res0;
    return out;
  }, { BENCH });
  ok(cancel.startEsc === null && cancel.evEsc.active === false && cancel.evEsc.completed === false, 'Esc (게임 도중) → 취소 completed:false');
  ok(cancel.evAbort.info === null && cancel.evAbort.ev.completed === false && cancel.evAbort.hidden, 'game:abort → 세션 · 화면 정리');
  // `caller` 는 hub 가 스스로 푼 자세라는 뜻이다 — 가짜 이벤트는 hub `CookStaging`(자기가 풀지 않은 cook 자세 끝 = 취소)이 받아 취소하므로
  // 여기서는 housing 쪽 규칙(reset = 취소)만 끝까지 본다.
  ok(cancel.startPose === null && cancel.reset, `자세가 reset 으로 풀리면 조리도 취소 (${cancel.startPose})`);
  if (!cancel.caller) note('가짜 caller 이벤트도 취소됐다 — hub CookStaging 이 자기가 풀지 않은 cook 자세 끝을 취소로 받는다 (정상)');
  ok(cancel.startAbort === null, `취소 뒤 다시 시작할 수 있다 (${cancel.startAbort})`);
  ok(JSON.stringify(cancel.c1) === JSON.stringify(cancel.c0) && cancel.results === 0, `취소는 재료 · 요리 · 결과가 그대로 (${JSON.stringify(cancel.c1)})`);
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.isHubPhase(), 'hub phase again', 20000);
  await sleep(400);

  /* ══ 7. 자동 가구 ═════════════════════════════════════════════════════════ */
  console.log('자동 가구 (푸드 프로세서)');
  const procP = await placeFurn(5, 'furn_food_processor');
  ok(!!procP.uid, 'craft + place 푸드 프로세서', JSON.stringify(procP));
  const autos = await H((uid) => {
    const h = window.__game.ctx.housing;
    const item = h.getPlacedByUid(uid);
    const levels = [];
    for (const lv of [1, 2, 3]) { item.level = lv; const a = h.getCookAuto('chop'); levels.push({ lv, level: a?.level, score: a?.score, uid: a?.uid, mince: h.getCookAuto('mince')?.score }); }
    const stir = h.getCookAuto('stir');
    item.level = 2;
    return { levels, stir };
  }, procP.uid);
  ok(autos.levels.every((a) => a.uid === procP.uid && a.level === a.lv && near(a.score, T.COOK_AUTO_SCORE_BY_LEVEL[a.lv]) && near(a.mince, a.score)), `자동 점수 Lv.1/2/3 = ${autos.levels.map((a) => a.score).join(' / ')} (썰기 · 다지기 공통)`);
  ok(autos.stir === null, '푸드 프로세서는 젓기를 대신하지 않는다');
  const au = await H((BENCH) => {
    const h = window.__game.ctx.housing;
    h.openCookStation(BENCH);
    h.cookStation.select('cook_green_salad');
    const chipAuto = document.querySelector('.menu.cook-station .cook-stepchip-auto')?.textContent ?? '';
    const r = h.startCook(BENCH, 'cook_green_salad');
    return { r, chipAuto, screen: h.cookDebug.screen, step: window.__rec.steps.at(-1), manual: document.querySelector('.cook-choose .cook-choose-manual')?.textContent ?? '',
      auto: document.querySelector('.cook-choose .cook-choose-auto')?.textContent ?? '', guide: window.__rec.guide.at(-1) };
  }, BENCH);
  ok(/푸드 프로세서 Lv\.2 · 자동 60 %/.test(au.chipAuto), `조리대 화면 단계 칩에 자동 가구 (${au.chipAuto})`);
  ok(au.r === null && au.screen === 'choose' && au.step?.phase === 'choose' && au.step.game === 'chop', `자동 가구가 있으면 선택 카드 (${JSON.stringify(au.step)})`);
  ok(au.manual === '직접 하기' && /자동 — 푸드 프로세서 Lv\.2 · 60 %/.test(au.auto) && JSON.stringify(au.guide) === '[]', `선택 카드 버튼 (${au.auto})`);
  await H(() => document.querySelector('.cook-choose .cook-choose-auto').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const au2 = await H(() => ({ screen: window.__game.ctx.housing.cookDebug.screen, step: window.__rec.steps.at(-1), audio: window.__rec.audio.includes('cook_auto') }));
  ok(au2.screen === 'auto' && au2.step.phase === 'play' && au2.step.auto === true && au2.audio, `자동 버튼 → 자동 연출 · cook_auto (${au2.screen})`);
  await waitFor(page, () => window.__game.ctx.housing.cookDebug.screen === 'result', '자동 → 결과', 8000);
  const au3 = await H(() => ({ r: window.__game.ctx.housing.cookDebug.result, done: window.__rec.steps.filter((s) => s.phase === 'done').at(-1) }));
  ok(au3.r && au3.r.stepAuto[0] === true && near(au3.r.stepScores[0], T.COOK_AUTO_SCORE_BY_LEVEL[2]) && au3.r.quality === qualityFor(T.COOK_AUTO_SCORE_BY_LEVEL[2]) && !au3.r.reason,
    `자동 Lv.2 → 단계 ${au3.r?.stepScores[0]} · 품질 ${au3.r?.quality}`, JSON.stringify(au3.r));
  ok(au3.done?.auto === true && near(au3.done.score, T.COOK_AUTO_SCORE_BY_LEVEL[2]), 'housing:cookStep done {auto:true}');
  // 결과에서 E → 닫기
  await H(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true })); });
  ok(await H(() => window.__game.ctx.housing.cookSession === null && window.__rec.sessions.at(-1).completed === true), '결과 화면에서 E → 닫기');
  // 막힌 조리 시작 = 거절 토스트
  const denied = await H((BENCH) => {
    const h = window.__game.ctx.housing;
    h.openCookStation(BENCH);
    // 레일에 있는(숙련 0) 요리 중 재료가 없는 콩죽 — 레일에 없는 요리를 고르면 화면이 첫 요리로 되돌린다
    const blocked = h.cookBlock(BENCH, 'cook_bean_porridge');
    h.cookStation.select('cook_bean_porridge');
    const n0 = window.__rec.notify.length;
    const r = h.cookStation.start();
    const out = { blocked, r, toast: window.__rec.notify.slice(n0), session: h.cookSession, reason: document.querySelector('.menu.cook-station .cook-sel-reason')?.textContent ?? '',
      picked: h.cookDebug.station.recipeId, dim: document.querySelector('.menu.cook-station .cook-start')?.classList.contains('is-blocked') };
    h.closeMenus();
    h.cancelCook();
    return out;
  }, BENCH);
  ok(typeof denied.blocked === 'string' && denied.picked === 'cook_bean_porridge' && denied.dim && denied.reason === denied.blocked, `막힌 요리: 조리 시작 딤드 + 사유 줄 (${denied.reason})`);
  ok(denied.r === denied.blocked && denied.toast.includes(denied.blocked) && denied.session === null, `막힌 요리의 조리 시작 → 거절 토스트 · 세션 없음 (${denied.blocked})`);

  /* ══ 8. 식탁 ══════════════════════════════════════════════════════════════ */
  console.log('식탁');
  await H((u) => window.__game.ctx.housing.openDiningTable(u), TABLE);
  await waitFor(page, () => !document.querySelector('.menu.dining-table')?.hidden, 'dining open', 5000);
  await sleep(50);
  const dt = await H(() => {
    const rows = [...document.querySelectorAll('.menu.dining-table .dt-row[data-def="meal_tuber_stew"]')];
    return rows.map((r) => ({ q: Number(r.dataset.q), stars: r.querySelector('.cook-dt-stars')?.textContent ?? '', badge: r.querySelector('.cook-dt-q')?.textContent ?? null,
      effects: r.querySelector('.dt-effects')?.textContent ?? '' }));
  });
  const q5row = dt.find((r) => r.q === 5), qlow = dt.find((r) => r.q !== 5);
  ok(dt.length === 2 && q5row && q5row.stars === '★★★★★' && q5row.badge === '★5', `식탁 목록 = (요리, 품질) 한 줄씩 (${JSON.stringify(dt.map((r) => [r.q, r.stars, r.badge]))})`);
  const stewAmount = await H(() => window.__game.ctx.loot.getItemDef('meal_tuber_stew').meal.effects[0].amount);
  const q5val = Math.round(stewAmount * (1 + T.MEAL_QUALITY_BONUS[5]) * 10) / 10;
  ok(q5row && q5row.effects.includes(`+${q5val}`) && qlow && qlow.effects.includes(`+${Math.round(stewAmount * (1 + T.MEAL_QUALITY_BONUS[qlow.q]) * 10) / 10}`),
    `능력치는 품질 보너스 반영 (★5 ${q5row?.effects} · ★${qlow?.q} ${qlow?.effects})`);
  if (apis.mealQ) {
    const eat = await H((TABLE) => {
      const h = window.__game.ctx.housing, inv = window.__game.ctx.inventory, p = window.__game.ctx.progression;
      const r = h.eatMeal(TABLE, 'meal_tuber_stew', 5);
      return { r, meal: p.getMeal(), q: p.getMealQuality(), q5: inv.countDefQualityAll('meal_tuber_stew', 5), total: inv.countDefAll('meal_tuber_stew'),
        plate: document.querySelector('.menu.dining-table .dt-plate-name')?.textContent ?? '' };
    }, TABLE);
    await sleep(50);
    const plate = await H(() => ({ name: document.querySelector('.menu.dining-table .dt-plate-name')?.textContent ?? '', badge: document.querySelector('.menu.dining-table .dt-plate .cook-dt-q')?.textContent ?? null }));
    ok(eat.r === null && eat.meal === 'meal_tuber_stew' && eat.q === 5 && eat.q5 === 0 && eat.total === 1, `★5 스튜를 먹는다 → 식사 품질 5 · 그 품질만 빠진다 (${JSON.stringify(eat)})`);
    ok(/★★★★★/.test(plate.name) && plate.badge === '★5', `접시에 실린 식사의 별 (${plate.name})`);
  }
  await H(() => window.__game.ctx.housing.closeMenus());

  /* ══ 9. 새로고침 ══════════════════════════════════════════════════════════ */
  console.log('새로고침');
  const keep = await H(() => {
    const inv = window.__game.ctx.inventory;
    return { stacks: inv.getMealStacks().filter((s) => s.defId === 'meal_tuber_stew' || s.defId === 'meal_green_salad'), q: window.__game.ctx.progression.getMealQuality?.() ?? null };
  });
  await sleep(1500);                                                   // 저장 debounce
  await page.reload({ waitUntil: 'load' });
  await boot();
  await sleep(500);
  const back = await H(() => {
    const inv = window.__game.ctx.inventory;
    return { stacks: inv.getMealStacks().filter((s) => s.defId === 'meal_tuber_stew' || s.defId === 'meal_green_salad'), q: window.__game.ctx.progression.getMealQuality?.() ?? null };
  });
  const key = (a) => JSON.stringify([...a].sort((x, y) => (x.defId + x.quality).localeCompare(y.defId + y.quality)));
  ok(keep.stacks.length >= 2 && key(back.stacks) === key(keep.stacks), `품질 요리 스택이 새로고침을 건넌다 (${key(back.stacks)})`, key(keep.stacks));
  if (apis.mealQ) ok(back.q === keep.q && back.q === 5, `식사 품질이 새로고침을 건넌다 (${back.q})`);

  /* ══ 10. 출격 식사 → derived 보너스 ══════════════════════════════════════ */
  if (apis.mealQ) {
    console.log('derived 보너스');
    const d = await H(() => {
      const p = window.__game.ctx.progression;
      const def = window.__game.ctx.loot.getItemDef('meal_tuber_stew');
      const e = def.meal.effects[0];
      const beforeV = p.derived[e.buff];
      p.armPreps();
      const afterV = p.derived[e.buff];
      const activeQ = p.getActiveMealQuality?.() ?? null;
      p.clearActivePreps();
      return { buff: e.buff, amount: e.amount, beforeV, afterV, activeQ, cleared: p.derived[e.buff] };
    });
    const want = d.amount * (1 + T.MEAL_QUALITY_BONUS[5]);
    ok(d.activeQ === 5 && near(d.afterV - d.beforeV, want, 1e-6), `출격한 ★5 스튜: derived.${d.buff} +${(d.afterV - d.beforeV).toFixed(4)} = ${d.amount} × ${1 + T.MEAL_QUALITY_BONUS[5]}`, JSON.stringify(d));
    ok(near(d.cleared, d.beforeV, 1e-6), '레이드가 끝나면(clearActivePreps) 보너스가 빠진다');
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
