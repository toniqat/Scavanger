// Single-player smoke test for the **cooking minigames · meal quality** (2026-09-13, src/housing —
// parts/CookGames · parts/Cooking · ui/cook · parts/Dining · ui/DiningTable):
// The six judges with no screen (`cookDebug.makeGame`) — chop (a click during the lead-in beats is ignored · the
// window · a stray click = the next mark missed · a miss), mince (alternating fills · the same button hammered = the
// opposite gauge drains · a score linear in time · a forced end = 0 points), grill (flip at 50 % · remove at 100 % ·
// a late flip = miss + remove · burnt · a click before the piece reaches the fire is ignored), stir-fry (the lead-in
// beat ignored · one press per beat · the bar fills · the judgement average), stir (holding alone = 0 points ·
// temperature control = 1 point · the periodic stir cue), pour (the ramp integral · never ends before the first
// pour · ends SETTLE after the release · overflow = 0 points) → cookBlock reasons · the bench level lock → the cook
// bench screen (rail · step chips · the 「조리 시작」 button) → the session (blocker · ESC · cursor · key guide · a
// real pointerdown chop → housing:cookBeat) → the result = the dining table's plate · the ingredients consumed →
// cook again (the 「식탁의 요리를 바꿉니다」 warning · Enter ignored · confirm) → Tab closes → cancel (Esc · game:abort ·
// the pose reset) = ingredients · plate unchanged → auto appliance Lv.1/2/3 scores · the choice card · the auto
// cutscene → the replace warning on the bench screen (Escape cancels · confirm) → the dining table (eating a plate ·
// it does not shrink · the launch warning · squadmates' plates on the shared table) → the plate · meal quality
// survive a reload → the derived bonus of the launched meal → a raid start clears the plate.
// 2026-09-16 (the plate model, user's decision): a meal is not an item — with no dining table furniture the cook
// bench cannot be used (that gate is checked too).
// Usage: node scripts/smoke-cooking.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
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

/** COOK_* from `data/constants.csv` · the quality · auto-score tables from `data/tables.csv` — expected values are
    derived from those numbers. */
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
/** 2026-09-13 (H3): the expected cooking-skill bonus — `COOK_SKILL_SCORE_AT_MAX × level / SKILL_LEVEL_MAX`. */
const SKILL_LEVEL_MAX = Number(/^SKILL_LEVEL_MAX,([^,\s]+)/m.exec(readFileSync(join(ROOT, 'data', 'constants.csv'), 'utf8'))?.[1] ?? 100);

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
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
      window.__rec = { sessions: [], steps: [], beats: [], results: [], audio: [], guide: [], station: [], served: [], notify: [], xp: [], plates: [] };
      b.on('housing:plateChanged', (p) => window.__rec.plates.push({ reason: p.reason, plate: p.plate ? { ...p.plate } : null }));
      // 2026-09-13 (H3): spies on the skill-XP calls — it is an instance property, so the
      // `ctx.progression.addSkillXp` that housing calls passes through here
      const prog = window.__game.ctx.progression;
      if (typeof prog.addSkillXp === 'function') {
        const origXp = prog.addSkillXp;
        prog.addSkillXp = function (id, amount) { window.__rec.xp.push([id, amount]); return origXp.call(this, id, amount); };
      }
      // 2026-09-13 (H3): overrides library totals · recipe unlocks on the housing instance with fakes and restores
      // them (only the rules are checked, independently of the library agent's implementation)
      window.__patched = new Map();
      window.__patch = (obj, key, value) => {
        if (!window.__patched.has(key)) window.__patched.set(key, [obj, Object.getOwnPropertyDescriptor(obj, key)]);
        obj[key] = value;
      };
      window.__unpatch = (key) => {
        const e = window.__patched.get(key);
        if (!e) return;
        const [obj, desc] = e;
        if (desc) Object.defineProperty(obj, key, desc); else delete obj[key];
        window.__patched.delete(key);
      };
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

  /* ══ 1. The judges — with no screen ═════════════════════════════════ */
  console.log('판정 (썰기)');
  const chop = await H((K) => {
    const g = window.__game.ctx.housing.cookDebug.makeGame('chop');
    const to = (t) => g.update(t - g.time);
    const n = g.notes, B = g.beatS, W = g.window;
    // 2026-09-14 (user's decision 「보이는 것 = 판정」): the window has split into two bands — `bands.perfect` (the
    // drawn mark) · `bands.good` (= `window`). A good judgement means aiming **between** the two bands (the
    // old `window × 0.6` is now inside the perfect band).
    const GOOD = (g.bands.perfect + g.bands.good) / 2;
    g.press('left');                                   // a click during the lead-in beats is ignored
    const lead = g.judgements.length;
    to(n[0].t); g.press('right'); g.press('left');     // right-click is not a chop · on the beat → perfect
    to(n[1].t + GOOD); g.press('left');                // good
    to(n[2].t - B / 2); g.press('left');               // a stray click → the next mark (2) is missed
    to(n[3].t + W + 0.01);                             // a miss (no click)
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
    // ① hammering the same button drains the opposite gauge
    const a = d.makeGame('mince');
    a.press('right'); const v1 = a.v;
    a.press('left'); const h1 = a.h;
    a.press('left'); const drained = { h: a.h, v: a.v };
    a.press('left'); a.press('left'); a.press('left');         // the opposite side never goes below 0
    const floor = a.v;
    const beats = a.drain().filter((e) => e.type === 'beat').map((e) => e.action);
    // ② alternating presses finish within PERFECT_S → 1 point
    const b = d.makeGame('mince');
    let guard = 0;
    while (!b.done && guard++ < 500) { b.update(0.05); b.press(guard % 2 ? 'left' : 'right'); }
    // ③ finishing halfway between PERFECT and ZERO → 0.5 points
    const c = d.makeGame('mince');
    const need = Math.ceil(1 / K.COOK_MINCE_FILL);
    const mid = (K.COOK_MINCE_PERFECT_S + K.COOK_MINCE_ZERO_S) / 2;
    for (let i = 0; i < need * 2 - 1; i++) c.press(i % 2 ? 'right' : 'left');
    c.update(mid - c.time);
    c.press(need * 2 % 2 ? 'left' : 'right');
    // ④ the forced end
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
    g.clickPiece(1);                                             // not on the fire yet → ignored
    const early = { judgements: g.judgements.length, flipped: p1.flipped };
    to(p0.start + p0.seconds * 0.5); g.clickPiece(0);            // flip at 50 % → perfect
    to(p1.start + p1.seconds * (0.5 + K.COOK_GRILL_FLIP_GOOD * 0.8)); g.clickPiece(1);   // good
    to(p0.start + p0.seconds * 1.0); g.clickPiece(0);            // remove at 100 % → perfect
    to(p1.start + p1.seconds * K.COOK_GRILL_BURN_AT + 0.01);     // not removed → burnt
    const ev = g.drain();
    const late = d.makeGame(step);
    const q0 = late.pieces[0];
    // removes without flipping, outside the perfect width and inside the good width → flip missed + a good remove
    // (the 2026-09-14 judgement easing brought the old fixed 90 % inside `COOK_GRILL_DONE_PERFECT` 0.10, so perfect)
    late.update(q0.start + q0.seconds * (1 - (K.COOK_GRILL_DONE_PERFECT + K.COOK_GRILL_DONE_GOOD) / 2) - late.time);
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
    const GOOD = (g.bands.perfect + g.bands.good) / 2;   // 2026-09-14: between the perfect band and the good band
    g.press('left');                                   // the lead-in beat
    const lead = g.judgements.length;
    to(g.beatTime(0)); g.press('left');                // perfect
    const bar1 = g.bar;
    to(g.beatTime(0) + 0.01); g.press('left');         // a second press on the same beat → ignored
    const dup = g.judgements.length;
    to(g.beatTime(1) + GOOD); g.press('left');         // good
    to(g.beatTime(2) + Math.min(B / 2 - 0.01, W + 0.05)); g.press('left');   // outside the window but near the beat → a miss (it still fills a little)
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
    // temperature control: holds while hotter than the middle, releases otherwise
    const b = d.makeGame('stir');
    const mid = (K.COOK_STIR_BAND_LOW + K.COOK_STIR_BAND_HIGH) / 2;
    guard = 0;
    while (!b.done && guard++ < 20000) {
      if (b.temp > mid && !b.holding) b.press('left');
      else if (b.temp <= mid && b.holding) b.release('left');
      b.update(0.02);
    }
    // with the button released the temperature rises and doneness stops
    const c = d.makeGame('stir');
    c.update(1);
    return { t0, hold, control: { done: b.done, score: b.score, ratio: b.ratio }, idle: { temp: c.temp, progress: c.progress, done: c.done } };
  }, K);
  ok(near(stir.t0, (K.COOK_STIR_BAND_LOW + K.COOK_STIR_BAND_HIGH) / 2), `시작 온도 = 구간 한가운데 (${stir.t0})`);
  ok(stir.hold.done && near(stir.hold.elapsed, K.COOK_STIR_TIME_S, 0.03) && stir.hold.score === 0, `누르기만 = ${K.COOK_STIR_TIME_S} 초에 끝 · 구간 유지 ${Math.round(stir.hold.ratio * 100)} % = 0 점`, JSON.stringify(stir.hold));
  // the hub's ladle stops 0.45 s after the last stir — while the button is held one must arrive every 0.3 s at least
  ok(stir.hold.stirs >= Math.floor(K.COOK_STIR_TIME_S / 0.3), `누르는 동안 stir 연출이 0.3 초 이내 간격으로 (${stir.hold.stirs}회 / ${K.COOK_STIR_TIME_S} 초)`);
  ok(stir.control.done && stir.control.score === 1 && stir.control.ratio >= K.COOK_STIR_PERFECT_RATIO, `온도를 구간에 두면 1 점 (유지 ${Math.round(stir.control.ratio * 100)} %)`);
  ok(stir.idle.temp > stir.t0 && stir.idle.progress === 0 && !stir.idle.done, `떼고 있으면 온도 ↑ · 완성은 멈춘다 (${stir.idle.temp.toFixed(3)})`);

  console.log('판정 (붓기)');
  const pour = await H((K) => {
    const d = window.__game.ctx.housing.cookDebug;
    const step = { meal: 'smoke', order: 1, game: 'pour', items: [], liquid: 'water', targetMl: 250 };
    const a = d.makeGame(step);
    a.update(3);                                              // never poured → it does not end
    const idleDone = a.done;
    a.press('left');
    a.update(K.COOK_POUR_RAMP_S / 2);
    const half = { flow: a.flow, amount: a.amount };
    // releases early by the amount that still pours during the release (half the ramp)
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

  /* ══ 2. Ship · kitchen · cook bench ════════════════════════════════ */
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
  /* 2026-09-16 (user's decision 「행성 광맥」): crafting · upgrading the cook bench eats limestone (`min_limestone`) —
     the minerals are stocked too (`data/furniture.csv` · `furniture_upgrades.csv`; with none, `craft: 재료 부족`). */
  for (const [id, n] of [['mat_scrap', 60], ['mat_alloy', 20], ['mat_cable', 16], ['mat_circuit', 8], ['mat_cloth', 12],
    ['min_limestone', 20], ['min_natron', 10]]) await giveStash(id, n);
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
  /* 2026-09-16 (the plate model, user's decision): with no dining table furniture the cook bench cannot be used —
     cookBlock · startCook · opening the screen (a toast) · the prompt */
  const noTable = await H((uid) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const n0 = window.__rec.notify.length;
    const out = { has: h.hasDiningTable(), block: h.cookBlock(uid, 'cook_green_salad'), start: h.startCook(uid, 'cook_green_salad') };
    h.openCookStation(uid);
    out.open = h.cookDebug.station.open;
    out.toast = window.__rec.notify.slice(n0);
    out.prompts = ctx.interactables.all().map((i) => { try { return i.getPrompt?.() ?? ''; } catch { return ''; } }).filter((p) => /조리대/.test(p));
    return out;
  }, benchP.uid);
  ok(noTable.has === false && noTable.block === '식탁이 없습니다' && noTable.start === '식탁이 없습니다' && !noTable.open && noTable.toast.some((t) => t.startsWith('식탁이 없습니다')),
    `식탁 없는 조리대: cookBlock · startCook 거절 · 화면 대신 토스트 (${JSON.stringify(noTable)})`);
  if (noTable.prompts.length) ok(noTable.prompts.every((p) => p.includes('식탁이 없습니다')), `식탁 없는 조리대의 프롬프트 (${JSON.stringify(noTable.prompts)})`);
  else note('조리대 프롬프트가 보이지 않는 자리다 (접근 면) — 프롬프트 검사는 건너뛴다');
  const tableP = await placeFurn(5, 'furn_dining_table');
  ok(benchP.uid && tableP.uid, 'craft + place 조리대 · 식탁', JSON.stringify({ benchP, tableP }));
  const BENCH = benchP.uid, TABLE = tableP.uid;
  // clears a plate left over from an earlier run (the ship state was wiped above, but a server copy can restore it)
  await H(() => window.__game.ctx.housing.clearPlate());
  const apis = await H(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, p = ctx.progression, h = ctx.housing;
    return { cookBlock: typeof inv.cookBlock === 'function', consume: typeof inv.consumeCookInputs === 'function', noComplete: typeof inv.completeCook !== 'function',
      plate: typeof h.getPlate === 'function' && typeof h.eatPlate === 'function' && typeof h.getTablePlates === 'function',
      notItem: ctx.loot.getItemDef('meal_tuber_stew') === undefined, has: h.hasDiningTable(), mealQ: typeof p.getMealQuality === 'function' };
  });
  ok(apis.cookBlock && apis.consume && apis.noComplete && apis.plate && apis.notItem && apis.has, `조리 · 접시 API · 요리는 아이템이 아니다 (${JSON.stringify(apis)})`);
  if (!apis.mealQ) note('progression.getMealQuality 없음 — 식탁 품질 · derived 보너스 검사는 건너뛴다 (cook-progression-player 미완)');
  /** 2026-09-13 (H3): sets the cooking skill to `level` (the profile outlives the smoke — so the previous run's XP
      does not leak into the step-score bonus). */
  const setCookSkill = (level) => H((level) => {
    const p = window.__game.ctx.progression;
    if (typeof p.addSkillXpRaw !== 'function') return null;
    p.addSkillXpRaw('cooking', -(p.getSkill('cooking') + 1));
    if (level > 0) p.addSkillXpRaw('cooking', level);
    const b = p.derived.cookScoreBonus;
    return { level: p.getSkill('cooking'), bonus: typeof b === 'number' ? b : null };
  }, level);
  const skill0 = await setCookSkill(0);
  ok(skill0 && skill0.level === 0 && (skill0.bonus === 0 || skill0.bonus === null), `요리 숙련 0 에서 시작 (${JSON.stringify(skill0)})`);
  if (skill0 && skill0.bonus === null) note('derived.cookScoreBonus 없음 — 요리 숙련 보너스는 0 으로 본다 (progression 미완)');
  for (const [id, n] of [['crop_leafgreen', 40], ['crop_frostberry', 10], ['crop_tuber', 20]]) await giveStash(id, n);

  /* ══ 3. cookBlock ═════════════════════════════════════════════════════════ */
  console.log('cookBlock');
  const blocks = await H(({ BENCH, TABLE }) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const out = {
      notBench: h.cookBlock(TABLE, 'cook_green_salad'), unknown: h.cookBlock('f-9999', 'cook_green_salad'),
      notRecipe: h.cookBlock(BENCH, 'make_boost_adrenaline'), ok: h.cookBlock(BENCH, 'cook_green_salad'),
      // if the bench was not placed the `craft + place` above has already failed — this must not kill the script with
      // a TypeError (2026-09-16)
      level: h.cookBlock(BENCH, 'cook_sausage'), benchLv: h.getPlacedByUid(BENCH)?.level ?? null,
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

  /* ══ 4. The cook bench screen ════════════════════════════════════════ */
  console.log('조리대 화면');
  const st = await H((BENCH) => {
    const h = window.__game.ctx.housing;
    h.openCookStation(BENCH);
    return { debug: h.cookDebug.station, ev: window.__rec.station.at(-1) ?? null, blocker: window.__game.ctx.uiBlockers.has('housing') };
  }, BENCH);
  await waitFor(page, () => { const r = document.querySelector('.menu.cook-station'); return r && !r.hidden && r.querySelectorAll('.cook-rail-item').length > 0; }, 'cook station open', 5000);
  ok(st.debug.open && st.debug.uid === BENCH && st.ev?.open === true && st.ev.uid === BENCH && st.blocker, `openCookStation → 화면 + ui:cookStationToggled (${JSON.stringify(st.ev)})`);
  // picks the stew by clicking it in the rail → two step chips
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
      /* 2026-09-15 4th pass: the tier header rows are gone (the sort is global) — a tier is a badge on the cell's
         corner. */
      tiers: r.querySelectorAll('.cook-cell-tier, .cook-cell-dot, .cook-rail-dot').length, chips: [...r.querySelectorAll('.cook-stepchip-main')].map((x) => x.textContent),
      cost: r.querySelectorAll('.cook-sel-cost .item-chip').length, effects: r.querySelectorAll('.cook-eff-line').length,
      start: r.querySelector('.cook-start')?.classList.contains('is-blocked'), name: r.querySelector('.cook-sel-name')?.textContent,
      grids: r.querySelectorAll('.hs-card-inv .trade-grids').length,
      // 2026-09-17 (user's decision): a recipe short of the bench level · recipe book is not in the list — the
      // expected count is taken from the API outside the screen
      listable: (() => {
        const lv = h.getPlacedByUid(h.cookDebug.station.uid)?.level ?? 0;
        const book = (id) => typeof h.isRecipeUnlocked === 'function' ? h.isRecipeUnlocked(id) !== false : true;
        const byId = new Map(window.__game.ctx.loot.getAllRecipes().map((x) => [x.id, x]));
        return h.cookDebug.recipes().filter((x) => { const rr = byId.get(x.id); return (rr?.benchLevel ?? 1) <= lv && (!rr?.unlockSeries || book(x.id)); }).length;
      })(),
      column: getComputedStyle(r.querySelector('.cook-list')).flexDirection,
      rowName: r.querySelector('.cook-cell[data-recipe="cook_tuber_stew"] .cook-cell-name')?.textContent ?? '',
      noteGone: !r.textContent.includes('재료는 요리가 끝날 때 빠집니다'),
      maxGone: !r.querySelector('.cook-eff-max, .cook-eff-head') };
  });
  ok(pick && stDom.picked === 'cook_tuber_stew' && stDom.name === '덩이줄기 스튜', `레일 클릭으로 요리 선택 (${stDom.picked} · ${stDom.name})`);
  ok(stDom.rail === stDom.listable && stDom.rail < stDom.recipes && stDom.tiers === 0, `목록 = 조리대 레벨 · 책이 되는 요리 ${stDom.rail}/${stDom.recipes}줄 · 티어 배지 · 초록 점 없음 (${stDom.tiers})`);
  ok(stDom.column === 'column' && stDom.rowName === '덩이줄기 스튜' && stDom.noteGone && stDom.maxGone, `세로 줄 목록 (썸네일 · 이름 「${stDom.rowName}」) · 안내문 · 최고 품질 보너스 없음`);
  ok(stDom.chips.length === 2 && /① .*썰기/.test(stDom.chips[0]) && /② .*젓기/.test(stDom.chips[1]), `단계 칩 줄 (${JSON.stringify(stDom.chips)})`);
  // 2026-09-15 4th pass (user's decision): stash · bag are **one grid view inside one card** (old two cards → one)
  ok(stDom.cost === 2 && stDom.effects >= 1 && stDom.start === false && stDom.grids === 1, `재료 칩 ${stDom.cost} · 능력치 줄 ${stDom.effects} · 조리 시작 활성 · 창고+가방 한 카드`);

  /* ── 2026-09-15 (B-15, user's decision 「전부 딤드 + 숙련 배지」): a recipe short of the skill is in the rail too ── */
  console.log('숙련 잠김 요리 (B-15)');
  const sk = await H((BENCH) => {
    const ctx = window.__game.ctx, h = ctx.housing, p = ctx.progression;
    const station = h.cookStation;
    const root = document.querySelector('.menu.cook-station');
    const benchLv = h.getPlacedByUid(BENCH).level;
    const setSkill = (id, level) => { p.addSkillXpRaw(id, -(p.getSkill(id) + 1)); if (level > 0) p.addSkillXpRaw(id, level); return p.getSkill(id); };
    const listed = new Set(h.cookDebug.recipes().map((r) => r.id));
    const table = ctx.loot.getAllRecipes().filter((r) => listed.has(r.id));
    const out = { skillApi: typeof p.addSkillXpRaw === 'function' };
    if (!out.skillApi) return out;
    // skills to 0 — a recipe whose bench level is fine but its skill short (skillOnly) · one short of both (both)
    const skillIds = [...new Set(table.map((r) => r.skill))];
    const before = Object.fromEntries(skillIds.map((id) => [id, p.getSkill(id)]));
    for (const id of skillIds) setSkill(id, 0);
    const skillOnly = table.find((r) => !r.unlockSeries && (r.benchLevel ?? 1) <= benchLv && r.skillRequired > 0);
    const both = table.find((r) => !r.unlockSeries && (r.benchLevel ?? 1) > benchLv && r.skillRequired > 0);
    out.skillOnly = skillOnly?.id ?? null;
    out.both = both?.id ?? null;
    if (!skillOnly) { for (const id of skillIds) setSkill(id, before[id]); return out; }
    out.label = `${p.getSkillDef(skillOnly.skill).name} ${skillOnly.skillRequired}`;
    out.need = skillOnly.skillRequired;
    out.inputs = skillOnly.inputs.length;
    out.stepsWant = h.cookDebug.recipes().find((r) => r.id === skillOnly.id).steps.length;
    const s0 = window.__rec.sessions.length;
    station.select(skillOnly.id);                                     // a synchronous refresh
    const item = root.querySelector(`.cook-rail-item[data-recipe="${skillOnly.id}"]`);
    out.row = { present: !!item, locked: !!item?.classList.contains('is-locked'), skill: !!item?.classList.contains('is-skill'), book: !!item?.classList.contains('is-book'),
      badge: item?.querySelector('.cook-rail-skill')?.textContent ?? null, lv: item?.querySelectorAll('.cook-rail-lv:not(.cook-rail-skill)').length ?? -1,
      dot: item?.dataset.rank === '0', title: item?.title ?? '' };
    if (both) {
      const bi = root.querySelector(`.cook-rail-item[data-recipe="${both.id}"]`);
      out.bothRow = { present: !!bi };                               // 2026-09-17: short of the bench level = not in the list, whatever the skill
    }
    /* 2026-09-15 4th pass (user's decision): the tier groups are gone and the rank is **global** — startable (a green
       dot) → blocked → locked. The comparison runs inside one group (the whole list): only then is 「만들 수 있는 것이
       앞으로」 checked over the whole list. */
    const groups = [[]];
    for (const c of root.querySelectorAll('.cook-rail-item')) {
      groups[0].push({ id: c.dataset.recipe, rank: Number(c.dataset.rank) });
    }
    out.sorted = groups.every((g) => g.every((x, i) => i === 0 || g[i - 1].rank <= x.rank));
    const g = groups.find((gr) => gr.some((x) => x.id === skillOnly.id)) ?? [];
    out.startableAbove = g.findIndex((x) => x.rank === 0) >= 0 && g.findIndex((x) => x.rank === 0) < g.findIndex((x) => x.id === skillOnly.id);
    out.ranks = groups.map((gr) => gr.map((x) => x.rank).join(''));
    // a locked recipe once picked: ingredients · steps still show, only 「조리 시작」 is blocked (with the real reason)
    out.sel = { picked: h.cookDebug.station.recipeId, cost: root.querySelectorAll('.cook-sel-cost .item-chip').length, steps: root.querySelectorAll('.cook-stepchip').length,
      dim: !!root.querySelector('.cook-start')?.classList.contains('is-blocked'), reason: root.querySelector('.cook-sel-reason')?.textContent ?? '',
      sub: root.querySelector('.cook-sel-sub')?.textContent ?? '', startBlock: h.cookDebug.station.startBlock };
    out.block = h.cookBlock(BENCH, skillOnly.id);
    out.start = h.startCook(BENCH, skillOnly.id);
    out.btnStart = station.start();
    out.noSession = window.__rec.sessions.length === s0 && h.cookSession === null && station.isOpen;
    // the default pick is still a recipe that can be started
    station.selectedRecipeId = null;
    station.refresh();
    out.defaultPick = { id: h.cookDebug.station.recipeId, block: h.cookDebug.station.startBlock };
    // the skill lock releases once the skill is high enough
    setSkill(skillOnly.skill, skillOnly.skillRequired);
    station.select(skillOnly.id);
    const it2 = root.querySelector(`.cook-rail-item[data-recipe="${skillOnly.id}"]`);
    out.after = { skill: !!it2?.classList.contains('is-skill'), badge: !!it2?.querySelector('.cook-rail-skill'), block: h.cookBlock(BENCH, skillOnly.id) };
    for (const id of skillIds) setSkill(id, before[id]);
    station.select('cook_tuber_stew');                                  // the session section below opens the stew with the 「조리 시작」 button
    out.back = h.cookDebug.station.recipeId;
    return out;
  }, BENCH);
  if (!sk.skillApi) note('progression.addSkillXpRaw 없음 — 숙련 잠김 요리 검사는 건너뛴다');
  else if (!sk.skillOnly) note(`숙련만 모자란 조리대 Lv.1 요리가 표에 없다 — 숙련 잠김 요리 검사 건너뜀 (${JSON.stringify(sk)})`);
  else {
    ok(sk.row.present && sk.row.locked && sk.row.skill && !sk.row.book && !sk.row.dot && sk.row.lv === 0 && sk.row.badge === sk.label,
      `숙련 잠김 ${sk.skillOnly}: 레일에 있다 · 딤드 · 숙련 배지 「${sk.row.badge}」 (조리대 Lv 배지 없음) · 호버 ${sk.row.title}`, JSON.stringify(sk.row));
    if (sk.both) ok(!sk.bothRow.present, `조리대 레벨 + 숙련 둘 다 모자란 ${sk.both}: 목록에 없다`, JSON.stringify(sk.bothRow));
    ok(sk.sorted && sk.startableAbove, `티어마다 시작할 수 있는 요리 → 막힌 요리 → 잠긴 요리 (${JSON.stringify(sk.ranks)})`);
    ok(sk.sel.picked === sk.skillOnly && sk.sel.cost === sk.inputs && sk.sel.steps === sk.stepsWant && sk.sel.sub.includes(`숙련 ${sk.need}`),
      `잠긴 요리를 골라도 재료 칩 ${sk.sel.cost} · 단계 칩 ${sk.sel.steps} · 부제 ${sk.sel.sub}`, JSON.stringify(sk.sel));
    ok(typeof sk.block === 'string' && sk.block.includes(`숙련 ${sk.need}`) && sk.sel.dim && sk.sel.reason === sk.block && sk.sel.startBlock === sk.block,
      `조리 시작 딤드 + 진짜 사유 (${sk.sel.reason})`);
    ok(sk.start === sk.block && sk.btnStart === sk.block && sk.noSession, `숙련 잠김 요리는 시작 거절 — startCook · 버튼 모두, 세션 없음 (${sk.start})`);
    ok(sk.defaultPick.id && sk.defaultPick.block === null, `기본 선택은 시작할 수 있는 요리 (${sk.defaultPick.id})`);
    ok(!sk.after.skill && !sk.after.badge && !(typeof sk.after.block === 'string' && sk.after.block.includes('숙련')), `숙련이 차면 숙련 잠김이 풀린다 (${sk.after.block})`);
    ok(sk.back === 'cook_tuber_stew', `스튜로 되돌린다 (${sk.back})`);
  }

  /* ══ 5. The session — stew (chop → stir), started from the button ══ */
  console.log('세션 (덩이줄기 스튜)');
  const before = await H(() => { const inv = window.__game.ctx.inventory; return { tuber: inv.countDefAll('crop_tuber'), leaf: inv.countDefAll('crop_leafgreen') }; });
  await H(() => document.querySelector('.menu.cook-station .cook-start').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const s1 = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    return { info: h.cookSession, ev: window.__rec.sessions.at(-1) ?? null, blocker: ctx.uiBlockers.has('housing.cook'), esc: ctx.escape.has('housing.cook'),
      cursor: ctx.input.cursor?.has?.('housing.cook') ?? ctx.input.isCursorMode ?? null, stationOpen: h.cookDebug.station.open, screen: h.cookDebug.screen, game: h.cookDebug.game?.game ?? null,
      step: window.__rec.steps.at(-1) ?? null, guide: window.__rec.guide.at(-1) ?? null, panel: !document.querySelector('.cook-ovl').hidden,
      head: document.querySelector('.cook-steps')?.textContent ?? '', again: h.startCook(h.cookDebug.station.uid || '', 'cook_tuber_stew'),
      audio: window.__rec.audio.includes('cook_start'), stage: !!document.querySelector('.cook-panel .cook-stage.cook-chop'),
      // 2026-09-17: is the overlay **really visible** — the old root `.cook` collided in name with the grenade
      // cooking gauge (base.css, opacity 0 · a 120 px box), so DOM · session were all alive while nothing showed on
      // screen. A check that only looked at `hidden` missed it.
      seen: (() => {
        const root = document.querySelector('.cook-ovl'), panel = root?.querySelector('.cook-panel');
        if (!root || !panel) return null;
        const r = panel.getBoundingClientRect(), rr = root.getBoundingClientRect();
        let op = 1;
        // the panel itself is mid entry animation (cookIn, 260 ms) so it is left out — what hides it is the opacity
        // of the root · its ancestors
        for (let e = root; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { op, rootW: rr.width, rootH: rr.height, onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 300,
          hit: !!hit && panel.contains(hit) };
      })() };
  });
  ok(s1.info?.recipeId === 'cook_tuber_stew' && s1.info.mealDefId === 'meal_tuber_stew' && s1.info.steps.length === 2, `조리 시작 버튼 → 세션 (${JSON.stringify(s1.info?.steps?.map((x) => x.game))})`);
  ok(s1.ev?.active === true && s1.ev.completed === false && s1.audio, 'housing:cookSession {active:true} · cook_start');
  ok(!!s1.seen && s1.seen.op > 0.99 && s1.seen.rootW === 1440 && s1.seen.rootH === 900 && s1.seen.onScreen && s1.seen.hit,
    `조리 오버레이가 화면에 보인다 — 불투명 · 화면 전체 루트 · 패널이 화면 안 · 맨 위에서 눌린다 (${JSON.stringify(s1.seen)})`);
  ok(s1.blocker && s1.esc && s1.cursor === true && !s1.stationOpen && s1.panel, `블로커 · ESC · 커서 모드 housing.cook · 조리대 화면은 닫힌다 (cursor=${s1.cursor})`);
  ok(s1.screen === 'game' && s1.game === 'chop' && s1.stage && s1.step?.phase === 'play' && s1.step.index === 0 && s1.step.total === 2, `자동 가구가 없으면 곧장 미니게임 (${JSON.stringify(s1.step)})`);
  ok(JSON.stringify(s1.guide) === JSON.stringify(['썰기']) && /① 썰기 …/.test(s1.head), `키 가이드 · 머리줄 (${s1.head})`);
  ok(typeof s1.again === 'string', `조리 중 두 번째 시작은 거절 (${s1.again})`);
  // a real pointerdown — a left click on the stage as a mark nears the judgement line
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
      plate: h.getPlate(), plateEv: window.__rec.plates.at(-1) ?? null, plateUid: window.__game.getSystem('hub')?.furniture?.diningPlateUid ?? null,
      stars: document.querySelector('.cook-result .cook-stars')?.textContent ?? '',
      landed: document.querySelector('.cook-result .cook-landed')?.textContent ?? '', audio: window.__rec.audio.includes('cook_finish'),
      again: !document.querySelector('.cook-result .cook-again')?.classList.contains('is-blocked'),
      xp: window.__rec.xp.filter(([id]) => id === 'cooking'), craftXp: window.__rec.xp.filter(([id]) => id === 'crafting') };
  });
  ok(s3.screen === 'result' && s3.r && near(s3.r.score, 0.75) && s3.r.quality === wantQ1 && JSON.stringify(s3.r.stepScores) === '[1,0.5]', `요리 점수 = 평균 0.75 → 품질 ${s3.r?.quality} (기대 ${wantQ1})`, JSON.stringify(s3.r));
  ok(s3.r && !s3.r.reason && s3.r.itemUid === null && s3.r.landed === 'table' && !s3.r.replaced && s3.ev?.uid === BENCH && s3.audio,
    `요리가 식탁의 접시로 · housing:cookResult · cook_finish (${s3.r?.reason ?? s3.r?.landed})`);
  ok(s3.tuber === before.tuber - 3 && s3.leaf === before.leaf - 2 && s3.plate?.mealDefId === 'meal_tuber_stew' && s3.plate.quality === s3.r?.quality && s3.plateEv?.reason === 'cooked',
    `재료는 끝에서 빠진다 (덩이줄기 ${before.tuber} → ${s3.tuber} · 잎채소 ${before.leaf} → ${s3.leaf}) · 식탁 접시 ${JSON.stringify(s3.plate)}`);
  ok(s3.stars === '★'.repeat(wantQ1) + '☆'.repeat(5 - wantQ1) && /식탁/.test(s3.landed) && s3.again, `결과 카드 (${s3.stars} · ${s3.landed})`);
  if (s3.plateUid === null && !(await H(() => !!window.__game.getSystem('hub')?.furniture))) note('hub 가구 층이 없다 — 식탁 3D 접시 검사는 건너뛴다');
  else ok(s3.plateUid === TABLE, `식탁 조각이 접시를 올린 채 다시 지어진다 (${s3.plateUid})`);
  ok(s3.xp.length === 1 && Math.abs(s3.xp[0][1] - K.COOK_SKILL_XP * Math.max(0.25, 0.75)) < 1e-9,
    `요리가 나온 판 → 요리 숙련 경험치 ${K.COOK_SKILL_XP} × max(0.25, 0.75) (${JSON.stringify(s3.xp)})`);
  ok(s3.craftXp.length === 0, `조리대 요리는 제작 경험치를 주지 않는다 — 요리 경험치만 (사용자 결정 2026-09-13) (${JSON.stringify(s3.craftXp)})`);

  /* ── cook again → the 「식탁의 요리를 바꿉니다」 warning (2026-09-16 plate model: one plate per table,
       replaced on a re-cook) ── */
  const again = await H(() => {
    const h = window.__game.ctx.housing;
    const plate0 = h.getPlate();
    const r = h.cookDebug.restart();
    const askEl = document.querySelector('.sh-ask[data-ask="cook-replace-plate"]');
    const ask = { open: h.cookDebug.replaceAsk, dom: !!askEl, screen: h.cookDebug.screen, body: askEl?.querySelector('.sh-ask-body')?.textContent ?? '',
      hold: !!askEl?.querySelector('button[data-hold]'), focusCancel: document.activeElement === askEl?.querySelector('button[data-cancel]') };
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));   // Enter does not confirm
    ask.afterEnter = h.cookDebug.replaceAsk && h.cookDebug.screen === 'result';
    const confirmed = h.cookDebug.confirmReplace();
    const mid = { screen: h.cookDebug.screen, index: h.cookDebug.stepIndex, sessions: window.__rec.sessions.length, ask: h.cookDebug.replaceAsk,
      dom: !!document.querySelector('.sh-ask[data-ask="cook-replace-plate"]') };
    h.cookDebug.finishStep(1); h.cookDebug.finishStep(1);
    const res = h.cookDebug.result;
    return { r, plate0, ask, confirmed, mid, res, plate: h.getPlate(), xp: window.__rec.xp.filter(([id]) => id === 'cooking') };
  });
  ok(again.xp.length === 2 && Math.abs(again.xp[1][1] - K.COOK_SKILL_XP) < 1e-9, `두 번째 판(점수 1) → 경험치 ${again.xp[1]?.[1]} (${JSON.stringify(again.xp)})`);
  ok(again.r === null && again.ask.open && again.ask.dom && again.ask.hold && again.ask.screen === 'result' && again.ask.afterEnter && /덩이줄기 스튜/.test(again.ask.body),
    `다시 만들기 → 「식탁의 요리를 바꿉니다」 1 초 홀드 경고 · Enter 는 확정하지 않는다 (${JSON.stringify(again.ask)})`);
  if (!again.ask.focusCancel) note('바꾸기 경고의 최초 포커스를 확인하지 못했다 (헤드리스 포커스) — 공용 openHoldAsk 가 취소 버튼에 둔다');
  ok(again.confirmed && again.mid.screen === 'game' && again.mid.index === 0 && !again.mid.ask && !again.mid.dom, `경고 확정 → 같은 세션에서 첫 단계부터 (${JSON.stringify(again.mid)})`);
  ok(again.res && again.res.quality === qualityFor(1) && again.plate?.mealDefId === 'meal_tuber_stew' && again.plate.quality === again.res.quality
    && again.res.replaced?.mealDefId === 'meal_tuber_stew' && again.res.replaced.quality === again.plate0?.quality,
  `두 번째 판 1 점 → 접시가 ★${again.plate?.quality} 로 바뀐다 · 치운 접시 ${JSON.stringify(again.res?.replaced)}`);
  const dtab = async () => H(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', key: 'Tab', bubbles: true }));
  });
  await dtab();
  const closed = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    return { ev: window.__rec.sessions.at(-1), info: h.cookSession, blocker: ctx.uiBlockers.has('housing.cook'), esc: ctx.escape.has('housing.cook'),
      hidden: document.querySelector('.cook-ovl').hidden, inv: !!ctx.inventory.isOpen, guide: window.__rec.guide.at(-1), ticking: h.cookScreen?.ticking };
  });
  ok(closed.ev.active === false && closed.ev.completed === true && closed.info === null, 'Tab → housing:cookSession {active:false, completed:true}');
  ok(!closed.blocker && !closed.esc && closed.hidden && !closed.inv && closed.guide === null && closed.ticking === false, 'Tab: 블로커 · ESC · 화면 · 키 가이드 · 루프 정리, 인벤토리는 안 열린다');

  /* ══ 5-1. Cooking skill · library bonus (2026-09-13 H3) ══ */
  console.log('요리 숙련 · 서재 보너스 (직접 하기)');
  const libApi = await H(() => ({ lib: typeof window.__game.ctx.housing.getLibraryEffects === 'function', unlock: typeof window.__game.ctx.housing.isRecipeUnlocked === 'function' }));
  note(`서재 API — getLibraryEffects ${libApi.lib ? '있음' : '없음'} · isRecipeUnlocked ${libApi.unlock ? '있음' : '없음'} (아래는 housing 인스턴스에 가짜 합산을 덮어 써서 규칙만 본다)`);
  const skill40 = await setCookSkill(40);
  const hasSkillBonus = !!skill40 && typeof skill40.bonus === 'number' && skill40.bonus > 0;
  if (skill40 && skill40.bonus !== null) {
    ok(skill40.level === 40 && near(skill40.bonus, K.COOK_SKILL_SCORE_AT_MAX * 40 / SKILL_LEVEL_MAX), `요리 숙련 40 → derived.cookScoreBonus ${skill40.bonus} = ${K.COOK_SKILL_SCORE_AT_MAX} × 40 / ${SKILL_LEVEL_MAX}`);
  }
  const b1 = await H(async ({ BENCH }) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const S = await import('/src/shared/index.ts');
    // stirring (stir) is not a library target — even when it is in the totals it must not apply
    window.__patch(h, 'getLibraryEffects', () => ({ ...S.EMPTY_LIBRARY_EFFECTS, cookScore: { chop: 0.1, stir: 0.5 }, revision: 9001 }));
    const bonus = { chop: h.cookDebug.bonus('chop'), stir: h.cookDebug.bonus('stir') };
    const xp0 = window.__rec.xp.length;
    const r = h.startCook(BENCH, 'cook_green_salad');
    const screen = h.cookDebug.screen;
    h.cookDebug.finishStep(0.5);
    const res = h.cookDebug.result;
    const out = { r, screen, bonus, res, raw: h.cookDebug.stepRaw, done: window.__rec.steps.filter((s) => s.phase === 'done').at(-1),
      flash: document.querySelector('.cook-stepscore')?.textContent ?? '', row: document.querySelector('.cook-result .cook-result-step')?.textContent ?? '' };
    // cook again — library 0 · raw score 0 → even with a cooking score below ¼ the XP is max(0.25, score)
    window.__patch(h, 'getLibraryEffects', () => ({ ...S.EMPTY_LIBRARY_EFFECTS, revision: 9002 }));
    out.bonus2 = h.cookDebug.bonus('chop');
    out.restart = h.cookDebug.restart();
    out.restartAsk = h.cookDebug.replaceAsk;                   // 2026-09-16: the table holds a plate — the replace warning is confirmed
    h.cookDebug.confirmReplace();
    h.cookDebug.finishStep(0);
    out.res2 = h.cookDebug.result;
    out.xp = window.__rec.xp.slice(xp0).filter(([id]) => id === 'cooking');
    ctx.escape.closeTop();
    return out;
  }, { BENCH });
  const want1 = Math.min(1, 0.5 + b1.bonus.chop.total);
  ok(near(b1.bonus.chop.library, 0.1) && b1.bonus.stir.library === 0 && near(b1.bonus.stir.skill, b1.bonus.chop.skill)
    && (!hasSkillBonus || near(b1.bonus.chop.skill, skill40.bonus)) && near(b1.bonus.chop.total, b1.bonus.chop.skill + b1.bonus.chop.library),
  `보너스 = 요리 숙련 + 서재 cookScore[game] — 서재는 썰기 · 다지기 · 굽기 · 볶기만 (${JSON.stringify(b1.bonus)})`);
  ok(b1.r === null && b1.screen === 'game' && b1.res && near(b1.res.stepScores[0], want1) && near(b1.raw[0], 0.5) && b1.res.quality === qualityFor(want1) && near(b1.done?.score, want1),
    `직접 하기 0.5 → 단계 점수 ${want1.toFixed(3)} · 원점수 0.5 유지 · 품질 ${b1.res?.quality} · cookStep done 도 보너스 반영`, JSON.stringify({ res: b1.res, raw: b1.raw, done: b1.done }));
  const pc1 = `50 → ${Math.round(want1 * 100)} %`;
  ok(b1.flash.includes(pc1) && b1.flash.includes(hasSkillBonus ? '(+요리 숙련 · 서재)' : '(+서재)'), `단계 점수 글자 (${b1.flash})`);
  ok(b1.row.includes(pc1), `결과 카드 단계 줄 (${b1.row})`);
  const want2 = Math.min(1, b1.bonus2.total);
  ok(b1.restart === null && b1.restartAsk && b1.res2 && near(b1.res2.stepScores[0], want2) && b1.bonus2.library === 0, `서재 0 · 원점수 0 → 단계 ${want2.toFixed(3)} (요리 숙련만)`, JSON.stringify(b1.res2));
  ok(b1.xp.length === 2 && Math.abs(b1.xp[0][1] - K.COOK_SKILL_XP * Math.max(0.25, b1.res?.score ?? 0)) < 1e-9 && Math.abs(b1.xp[1][1] - K.COOK_SKILL_XP * Math.max(0.25, b1.res2?.score ?? 0)) < 1e-9,
    `경험치 = ${K.COOK_SKILL_XP} × max(0.25, 점수) — ${b1.res?.score?.toFixed(3)} · ${b1.res2?.score?.toFixed(3)} (${JSON.stringify(b1.xp)})`);

  const b2 = await H(async ({ BENCH }) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const S = await import('/src/shared/index.ts');
    window.__patch(h, 'getLibraryEffects', () => ({ ...S.EMPTY_LIBRARY_EFFECTS, cookScore: { chop: 0.1 }, revision: 9003 }));
    const bonus = { chop: h.cookDebug.bonus('chop'), stir: h.cookDebug.bonus('stir') };
    const r = h.startCook(BENCH, 'cook_tuber_stew');
    h.cookDebug.finishStep(0.95);
    h.cookDebug.finishStep(0.4);
    const out = { r, bonus, res: h.cookDebug.result, raw: h.cookDebug.stepRaw, rows: [...document.querySelectorAll('.cook-result .cook-result-step')].map((x) => x.textContent) };
    ctx.escape.closeTop();
    window.__unpatch('getLibraryEffects');
    return out;
  }, { BENCH });
  const stirWant = Math.min(1, 0.4 + b2.bonus.stir.total);
  ok(b2.r === null && b2.res && b2.res.stepScores[0] === 1 && near(b2.raw[0], 0.95) && near(b2.res.stepScores[1], stirWant) && b2.bonus.stir.library === 0
    && b2.res.quality === qualityFor((1 + stirWant) / 2),
  `스튜: 썰기 0.95 + 보너스 → 1 로 자른다 · 젓기 0.4 → ${stirWant.toFixed(3)} (서재 없음) · 품질 ${b2.res?.quality}`, JSON.stringify({ res: b2.res, raw: b2.raw }));
  ok(b2.rows[0]?.includes('95 → 100 %') && (hasSkillBonus ? b2.rows[1]?.includes(`40 → ${Math.round(stirWant * 100)} %`) : /40 %$/.test(b2.rows[1] ?? '')), `결과 단계 줄 (${JSON.stringify(b2.rows)})`);

  /* ── Recipe books ── */
  console.log('레시피 책');
  const bk = await H(async ({ BENCH }) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const S = await import('/src/shared/index.ts');
    const all = ctx.loot.getAllRecipes();
    const skillOk = (x) => (ctx.progression.getSkill(x.skill) ?? 0) >= x.skillRequired;
    // 2026-09-17: a recipe short of the bench level is not in the list whatever the book — to check the book alone,
    // one the current bench level allows is picked
    const benchLv = h.getPlacedByUid(BENCH)?.level ?? 1;
    let r = all.find((x) => x.bench === 'cook' && x.unlockSeries && (x.benchLevel ?? 1) <= benchLv && S.cookStepsOf(x.outputDefId).length > 0 && skillOk(x));
    let stub = false;
    if (!r) {
      r = all.find((x) => x.id === 'cook_green_salad');
      const series = S.LIBRARY_SERIES_DEFS.find((s) => s.medium === 'book')?.id ?? 'smoke_recipe_book';
      try { r.unlockSeries = series; } catch { /* frozen */ }
      stub = r.unlockSeries === series;
      if (!stub) return { skip: '레시피 객체가 얼어 있고 unlockSeries 가 있는 조리 레시피도 없다' };
    }
    const want = `『${S.LIBRARY_SERIES_MAP.get(r.unlockSeries)?.name ?? '레시피 책'}』 을(를) 서재에 꽂아야 합니다`;
    const out = { id: r.id, stub, want, realApi: typeof h.isRecipeUnlocked === 'function', realLocked: null };
    if (out.realApi && !stub) out.realLocked = h.isRecipeUnlocked(r.id) === false;
    window.__patch(h, 'isRecipeUnlocked', (id) => id !== r.id);
    const s0 = window.__rec.sessions.length;
    out.block = h.cookBlock(BENCH, r.id);
    out.start = h.startCook(BENCH, r.id);
    out.noSession = window.__rec.sessions.length === s0 && h.cookSession === null;
    out.other = h.cookBlock(BENCH, 'cook_tuber_stew');
    h.openCookStation(BENCH);
    h.cookStation.select(r.id);
    return out;
  }, { BENCH });
  if (bk.skip) note(`레시피 책 검사 건너뜀 — ${bk.skip}`);
  else {
    if (bk.stub) note(`unlockSeries 가 있는 조리 레시피가 아직 없다 (데이터 에이전트) — ${bk.id} 에 임시로 붙여 검사한다`);
    if (bk.realLocked !== null) ok(bk.realLocked === true, `실제 isRecipeUnlocked: 책을 꽂지 않은 새 함선에서 ${bk.id} 는 잠김`);
    ok(bk.block === bk.want && bk.start === bk.want && bk.noSession, `책이 없으면 cookBlock · startCook 거절 (${bk.block})`);
    ok(bk.other !== bk.want, `책이 필요 없는 요리는 책으로 막히지 않는다 (${bk.other})`);
    await waitFor(page, () => document.querySelectorAll('.menu.cook-station .cook-rail-item').length > 0, '조리대 목록', 5000);
    const bk2 = await H((id) => {
      const root = document.querySelector('.menu.cook-station');
      return { present: !!root?.querySelector(`.cook-rail-item[data-recipe="${id}"]`), picked: window.__game.ctx.housing.cookDebug.station.recipeId };
    }, bk.id);
    // 2026-09-17 (user's decision): a recipe with no book is not in the list — picking it snaps the selection back to
    // a recipe that is
    ok(!bk2.present && bk2.picked !== bk.id, `조리대 화면: 책이 없는 요리는 목록에 없다 (선택 ${bk2.picked})`);
    // shelved → housing:libraryChanged releases the screen
    await H(() => { const ctx = window.__game.ctx; window.__patch(ctx.housing, 'isRecipeUnlocked', () => true); ctx.bus.emit('housing:libraryChanged', { revision: 9010 }); });
    await waitFor(page, (id) => !!document.querySelector(`.menu.cook-station .cook-rail-item[data-recipe="${id}"]`), 'libraryChanged → 목록에 나타남', 5000, bk.id);
    await H((id) => window.__game.ctx.housing.cookStation.select(id), bk.id);
    const bk3 = await H(({ id, BENCH }) => ({ block: window.__game.ctx.housing.cookBlock(BENCH, id), reason: document.querySelector('.menu.cook-station .cook-sel-reason')?.textContent ?? '' }), { id: bk.id, BENCH });
    ok(bk3.block !== bk.want && bk3.reason !== bk.want, `책을 꽂으면 풀린다 — housing:libraryChanged 에 화면도 (${bk3.block})`);
    // with no library API: a recipe that needs a book stays locked
    const bk4 = await H(({ id, BENCH, stub }) => {
      const ctx = window.__game.ctx, h = ctx.housing;
      window.__unpatch('isRecipeUnlocked');
      const out = { api: typeof h.isRecipeUnlocked === 'function', block: h.cookBlock(BENCH, id) };
      h.closeMenus();
      if (stub) { const r = ctx.loot.getAllRecipes().find((x) => x.id === id); delete r.unlockSeries; }
      ctx.bus.emit('housing:libraryChanged', { revision: 9011 });
      return out;
    }, { id: bk.id, BENCH, stub: bk.stub });
    if (!bk4.api) ok(bk4.block === bk.want, `isRecipeUnlocked 가 없으면 책이 필요한 레시피는 잠긴 채 (${bk4.block})`);
  }
  const skillBack = await setCookSkill(0);
  ok(!skillBack || skillBack.level === 0, `요리 숙련 0 으로 되돌린다 (${JSON.stringify(skillBack)})`);

  /* ══ 6. Cancel = the ingredients stay ══════════════════════════════ */
  console.log('취소');
  const cancel = await H(({ BENCH }) => {
    const ctx = window.__game.ctx, h = ctx.housing, inv = ctx.inventory;
    const count = () => ({ leaf: inv.countDefAll('crop_leafgreen'), berry: inv.countDefAll('crop_frostberry'), plate: JSON.stringify(h.getPlate()) });
    const c0 = count();
    const res0 = window.__rec.results.length;
    const xp0 = window.__rec.xp.length;
    const out = {};
    out.startEsc = h.startCook(BENCH, 'cook_green_salad');
    ctx.escape.closeTop();
    out.evEsc = window.__rec.sessions.at(-1);
    out.startPose = h.startCook(BENCH, 'cook_green_salad');
    ctx.bus.emit('player:furniturePoseEnded', { kind: 'cook', reason: 'caller' });
    out.caller = h.cookSession !== null;
    ctx.bus.emit('player:furniturePoseEnded', { kind: 'cook', reason: 'reset' });
    out.reset = h.cookSession === null;
    // game:abort moves the phase out of the ship — it goes last, and the ship is re-entered below
    out.startAbort = h.startCook(BENCH, 'cook_green_salad');
    ctx.bus.emit('game:abort', {});
    out.evAbort = { ev: window.__rec.sessions.at(-1), info: h.cookSession, hidden: document.querySelector('.cook-ovl').hidden };
    out.c1 = count();
    out.c0 = c0;
    out.results = window.__rec.results.length - res0;
    out.xp = window.__rec.xp.slice(xp0).filter(([id]) => id === 'cooking').length;
    return out;
  }, { BENCH });
  ok(cancel.xp === 0, `취소한 판은 요리 숙련 경험치가 없다 (${cancel.xp})`);
  ok(cancel.startEsc === null && cancel.evEsc.active === false && cancel.evEsc.completed === false, 'Esc (게임 도중) → 취소 completed:false');
  ok(cancel.evAbort.info === null && cancel.evAbort.ev.completed === false && cancel.evAbort.hidden, 'game:abort → 세션 · 화면 정리');
  // `caller` means the hub released the pose itself — the fake event is caught and cancelled by the hub's
  // `CookStaging` (the end of a cook pose it did not release = a cancel), so only the housing-side rule
  // (reset = cancel) is checked through to the end here.
  ok(cancel.startPose === null && cancel.reset, `자세가 reset 으로 풀리면 조리도 취소 (${cancel.startPose})`);
  if (!cancel.caller) note('가짜 caller 이벤트도 취소됐다 — hub CookStaging 이 자기가 풀지 않은 cook 자세 끝을 취소로 받는다 (정상)');
  ok(cancel.startAbort === null, `취소 뒤 다시 시작할 수 있다 (${cancel.startAbort})`);
  ok(JSON.stringify(cancel.c1) === JSON.stringify(cancel.c0) && cancel.results === 0, `취소는 재료 · 요리 · 결과가 그대로 (${JSON.stringify(cancel.c1)})`);
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.isHubPhase(), 'hub phase again', 20000);
  await sleep(400);

  /* ══ 7. The auto appliance ════════════════════════════════════════════ */
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
  // E on the result → close
  await H(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true })); });
  ok(await H(() => window.__game.ctx.housing.cookSession === null && window.__rec.sessions.at(-1).completed === true), '결과 화면에서 E → 닫기');
  // 2026-09-13 (H3): the cooking skill · library bonus applies to a step passed to the auto appliance too
  await setCookSkill(30);
  const ab = await H(async (BENCH) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const S = await import('/src/shared/index.ts');
    window.__patch(h, 'getLibraryEffects', () => ({ ...S.EMPTY_LIBRARY_EFFECTS, cookScore: { chop: 0.05 }, revision: 9100 }));
    const bonus = h.cookDebug.bonus('chop');
    h.openCookStation(BENCH);
    h.cookStation.select('cook_green_salad');
    const chipBonus = document.querySelector('.menu.cook-station .cook-stepchip-bonus')?.textContent ?? '';
    const r = h.startCook(BENCH, 'cook_green_salad');
    const btn = document.querySelector('.cook-choose .cook-choose-auto')?.textContent ?? '';
    const chosen = h.cookDebug.choose('auto');
    return { bonus, chipBonus, r, btn, chosen, screen: h.cookDebug.screen, autoText: document.querySelector('.cook-auto-score')?.textContent ?? '' };
  }, BENCH);
  await waitFor(page, () => window.__game.ctx.housing.cookDebug.screen === 'result', '자동 (보너스) → 결과', 8000);
  const ab2 = await H(() => {
    const h = window.__game.ctx.housing;
    const out = { res: h.cookDebug.result, raw: h.cookDebug.stepRaw, row: document.querySelector('.cook-result .cook-result-step')?.textContent ?? '' };
    window.__game.ctx.escape.closeTop();
    window.__unpatch('getLibraryEffects');
    return out;
  });
  const autoLv2 = T.COOK_AUTO_SCORE_BY_LEVEL[2];
  const wantA = Math.min(1, autoLv2 + ab.bonus.total);
  const bp = Math.round(ab.bonus.total * 100);
  ok(near(ab.bonus.library, 0.05) && bp > 0 && ab.chipBonus.startsWith(`점수 +${bp}`), `조리대 화면 단계 칩에 보너스 (${ab.chipBonus})`);
  ok(ab.r === null && ab.chosen && ab.screen === 'auto' && ab.btn.includes(`${Math.round(autoLv2 * 100)} % (+${bp})`) && ab.autoText.includes(`→ ${Math.round(wantA * 100)} %`),
    `선택 카드 · 자동 연출에 보너스 (${ab.btn} · ${ab.autoText})`);
  ok(ab2.res && ab2.res.stepAuto[0] === true && near(ab2.raw[0], autoLv2) && near(ab2.res.stepScores[0], wantA) && ab2.res.quality === qualityFor(wantA)
    && ab2.row.includes(`${Math.round(autoLv2 * 100)} → ${Math.round(wantA * 100)} %`),
  `자동 Lv.2 ${autoLv2} + 보너스 ${ab.bonus.total.toFixed(3)} → 단계 ${wantA.toFixed(3)} · 품질 ${ab2.res?.quality} (${ab2.row})`, JSON.stringify(ab2));
  await setCookSkill(0);
  // a blocked 「조리 시작」 = a refusal toast
  const denied = await H((BENCH) => {
    const h = window.__game.ctx.housing;
    h.openCookStation(BENCH);
    // bean porridge — in the rail (skill 0) but short of ingredients; picking a recipe not in the rail snaps the
    // screen back to the first one
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

  /* ── 2026-09-16 (the plate model, user's decision): with a plate on the table the bench screen's 「조리 시작」 also
       raises a 1 s hold warning **before** it starts ── */
  console.log('식탁 접시 바꾸기 경고 (조리대 화면)');
  const sa = await H((BENCH) => {
    const ctx = window.__game.ctx, h = ctx.housing;
    const plate0 = h.getPlate();
    h.openCookStation(BENCH);
    h.cookStation.select('cook_green_salad');
    const s0 = window.__rec.sessions.length;
    const r = h.cookStation.start();
    const open = { ask: h.cookDebug.replaceAsk, session: h.cookSession, station: h.cookStation.isOpen, top: ctx.escape.topKey };
    ctx.escape.closeTop();                                    // Escape = cancel — only the warning closes
    const cancelled = { ask: h.cookDebug.replaceAsk, session: h.cookSession, station: h.cookStation.isOpen, sessions: window.__rec.sessions.length - s0, plate: h.getPlate() };
    const r2 = h.cookStation.start();
    const confirmed = h.cookDebug.confirmReplace();
    const started = { session: h.cookSession?.recipeId ?? null, station: h.cookStation.isOpen };
    h.cancelCook();                                           // quitting midway → the old plate stays
    return { plate0, r, open, cancelled, r2, confirmed, started, plateAfter: h.getPlate() };
  }, BENCH);
  ok(!!sa.plate0 && sa.r === null && sa.open.ask && !sa.open.session && sa.open.station && /^holdAsk:/.test(sa.open.top ?? ''),
    `접시가 있으면 조리 시작 → 경고가 먼저 (세션 없음) (${JSON.stringify(sa.open)})`);
  ok(!sa.cancelled.ask && !sa.cancelled.session && sa.cancelled.station && sa.cancelled.sessions === 0 && JSON.stringify(sa.cancelled.plate) === JSON.stringify(sa.plate0),
    `Escape = 취소 — 조리대 화면 · 접시 그대로 (${JSON.stringify(sa.cancelled)})`);
  ok(sa.r2 === null && sa.confirmed && sa.started.session === 'cook_green_salad' && !sa.started.station, `경고 확정 → 조리 시작 (${JSON.stringify(sa.started)})`);
  ok(JSON.stringify(sa.plateAfter) === JSON.stringify(sa.plate0), `조리를 중간에 그만두면 옛 접시는 그대로 (${JSON.stringify(sa.plateAfter)})`);

  /* ══ 8. The dining table — the plate (2026-09-16 the plate model, user's decision) ══ */
  console.log('식탁 (접시)');
  await H(() => { const h = window.__game.ctx.housing; h.closeMenus(); h.devSetPlate('meal_tuber_stew', 5); });
  await H((u) => window.__game.ctx.housing.openDiningTable(u), TABLE);
  await waitFor(page, () => !document.querySelector('.menu.dining-table')?.hidden, 'dining open', 5000);
  await sleep(50);
  const dt = await H(async () => {
    const S = await import('/src/shared/index.ts');
    const rows = [...document.querySelectorAll('.menu.dining-table .dt-plate')];
    return { rows: rows.map((r) => ({ def: r.dataset.def, q: Number(r.dataset.q), owner: r.dataset.owner, stars: r.querySelector('.cook-dt-stars')?.textContent ?? '',
      badge: r.querySelector('.cook-dt-q')?.textContent ?? null, effects: r.querySelector('.dt-plate-buff')?.textContent ?? '', who: r.querySelector('.dt-plate-owner')?.textContent ?? '' })),
    grids: !!document.querySelector('.menu.dining-table .trade-grids'), amount: S.getMealDef('meal_tuber_stew').meal.effects[0].amount };
  });
  const prow = dt.rows[0];
  ok(dt.rows.length === 1 && prow.def === 'meal_tuber_stew' && prow.owner === 'me' && prow.stars === '★★★★★' && prow.badge === '★5' && /내 요리/.test(prow.who) && !dt.grids,
    `식탁 = 내 접시 한 장 · 격자 없음 (${JSON.stringify(dt.rows)})`);
  const q5val = Math.round(dt.amount * (1 + T.MEAL_QUALITY_BONUS[5]) * 10) / 10;
  ok(prow && prow.effects.includes(`+${q5val}`), `접시의 능력치는 품질 보너스 반영 (★5 ${prow?.effects})`);
  if (apis.mealQ) {
    const eat = await H((TABLE) => {
      const h = window.__game.ctx.housing, p = window.__game.ctx.progression;
      p.useMeal('meal_green_salad', 1);                        // loads a different meal first (the profile outlives the smoke)
      const r = h.diningTable.eat(null);
      const after = { meal: p.getMeal(), q: p.getMealQuality(), plate: h.getPlate() };
      return { r, after, again: h.eatPlate(TABLE, null), blocked: h.plateEatBlock(TABLE, null) };
    }, TABLE);
    await sleep(50);
    const plateDom = await H(() => ({ meal: document.querySelector('.menu.dining-table .dt-meal .dt-plate-name')?.textContent ?? '',
      btn: document.querySelector('.menu.dining-table .dt-plate .dt-eat')?.textContent ?? '', eaten: !!document.querySelector('.menu.dining-table .dt-plate.is-eaten') }));
    ok(eat.r === null && eat.after.meal === 'meal_tuber_stew' && eat.after.q === 5 && eat.after.plate?.mealDefId === 'meal_tuber_stew' && eat.after.plate.quality === 5,
      `★5 접시를 먹는다 → 식사 품질 5 · 접시는 그대로 (${JSON.stringify(eat.after)})`);
    ok(eat.again === '이미 같은 요리를 먹었습니다' && eat.blocked === '이미 먹었습니다', `같은 접시를 또 먹으면 거절 (${eat.again} · ${eat.blocked})`);
    ok(/★★★★★/.test(plateDom.meal) && plateDom.btn === '먹음' && plateDom.eaten, `실린 식사 카드 · 먹은 접시 표시 (${JSON.stringify(plateDom)})`);
    // the launch warning: an eaten plate says nothing; an uneaten plate while a different meal is loaded gives
    // `plateDiscard`
    const lw = await H(() => {
      const ctx = window.__game.ctx, h = ctx.housing;
      const ids = ctx.inventory.getLaunchWarnings().map((w) => w.id);
      h.devSetPlate('meal_green_salad', 2);
      const other = ctx.inventory.getLaunchWarnings().filter((w) => w.id === 'plateDiscard' || w.id === 'noMeal');
      h.devSetPlate('meal_tuber_stew', 5);
      return { ids, other };
    });
    ok(!lw.ids.includes('plateDiscard') && !lw.ids.includes('noMeal') && lw.other.length === 1 && lw.other[0].id === 'plateDiscard' && /잎채소 샐러드/.test(lw.other[0].detail),
      `출격 경고 — 먹은 접시는 조용 · 먹지 않은 접시는 plateDiscard (${JSON.stringify(lw)})`);

    /* the shared ship's fixed dining table (uid null): every squadmate's plate — filled from the resulting
       `net:squadPlate` event instead of the wire (`net/parts/Plates`) */
    console.log('공유 함선 식탁 (분대원 접시)');
    const sq = await H((TABLE) => {
      const ctx = window.__game.ctx, h = ctx.housing, hub = ctx.hub, p = ctx.progression;
      h.closeMenus();
      const out = {};
      ctx.bus.emit('net:squadPlate', { id: 'smoke-peer', name: '스모크대원', plate: { mealDefId: 'meal_omelet', quality: 3, cookedAt: 0 }, fresh: true });
      out.personal = h.getTablePlates(null).map((x) => x.ownerId);        // standing in the personal ship, squadmates' plates are not on the table
      out.personalTable = h.getTablePlates(TABLE).length;
      const desc = Object.getOwnPropertyDescriptor(hub, 'ship');
      Object.defineProperty(hub, 'ship', { value: 'shared', configurable: true, writable: true });
      try {
        out.plates = h.getTablePlates(null).map((x) => [x.ownerId, x.mealDefId, x.quality, x.ownerName, x.mine]);
        h.openDiningTable(null);
        out.rows = [...document.querySelectorAll('.menu.dining-table .dt-plate')].map((r) => [r.dataset.owner, r.querySelector('.dt-plate-owner')?.textContent ?? '']);
        out.title = document.querySelector('.menu.dining-table .hs-station-head .title')?.textContent ?? '';
        out.eat = h.diningTable.eat('smoke-peer');
        out.meal = [p.getMeal(), p.getMealQuality()];
        out.still = h.getTablePlates(null).length;
        ctx.bus.emit('net:squadPlate', { id: 'smoke-peer', name: '스모크대원', plate: null, fresh: false });
        out.gone = h.getTablePlates(null).length;
        h.closeMenus();
      } finally {
        if (desc) Object.defineProperty(hub, 'ship', desc); else delete hub.ship;
      }
      out.back = h.eatPlate(TABLE, null);                                  // the reload · derived sections below expect the ★5 stew
      return out;
    }, TABLE);
    ok(JSON.stringify(sq.personal) === '[null]' && sq.personalTable === 1, `개인 함선에서는 내 접시만 (${JSON.stringify(sq)})`);
    ok(sq.plates?.length === 2 && sq.plates[0][0] === null && sq.plates[0][4] === true && JSON.stringify(sq.plates[1]) === JSON.stringify(['smoke-peer', 'meal_omelet', 3, '스모크대원', false])
      && sq.title === '공유 함선 식탁' && sq.rows.length === 2 && sq.rows[1][0] === 'smoke-peer' && /스모크대원 님의 요리/.test(sq.rows[1][1]),
    `공유 함선 식탁 = 내 접시 + 분대원 접시 · 요리한 사람 표시 (${JSON.stringify({ plates: sq.plates, rows: sq.rows })})`);
    ok(sq.eat === null && sq.meal[0] === 'meal_omelet' && sq.meal[1] === 3 && sq.still === 2 && sq.gone === 1 && sq.back === null,
      `분대원 접시를 먹는다 → 내 대기 식사 · 접시는 줄지 않는다 · 떠나면 내려간다 (${JSON.stringify({ eat: sq.eat, meal: sq.meal, still: sq.still, gone: sq.gone })})`);
  }
  await H(() => window.__game.ctx.housing.closeMenus());

  /* ══ 9. Reload ════════════════════════════════════════════════════════ */
  console.log('새로고침');
  const keep = await H(() => {
    const p = window.__game.ctx.housing.getPlate();
    return { plate: p && [p.mealDefId, p.quality], q: window.__game.ctx.progression.getMealQuality?.() ?? null };
  });
  await sleep(1500);                                                   // the save debounce
  await page.reload({ waitUntil: 'load' });
  await boot();
  await sleep(500);
  const back = await H(() => {
    const p = window.__game.ctx.housing.getPlate();
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('scav.s1.ship'))?.plate ?? null; } catch { stored = 'err'; }
    return { plate: p && [p.mealDefId, p.quality], q: window.__game.ctx.progression.getMealQuality?.() ?? null, stored: stored && stored.mealDefId };
  });
  ok(JSON.stringify(keep.plate) === '["meal_tuber_stew",5]' && JSON.stringify(back.plate) === JSON.stringify(keep.plate) && back.stored === 'meal_tuber_stew',
    `식탁 접시가 새로고침을 건넌다 (함선 상태 저장) (${JSON.stringify(back)})`);
  if (apis.mealQ) ok(back.q === keep.q && back.q === 5, `식사 품질이 새로고침을 건넌다 (${back.q})`);

  /* ══ 10. The launched meal → the derived bonus ════════════════════ */
  if (apis.mealQ) {
    console.log('derived 보너스');
    const d = await H(async () => {
      const p = window.__game.ctx.progression;
      const S = await import('/src/shared/index.ts');
      const def = S.getMealDef('meal_tuber_stew');                // 2026-09-16: the meal table lives in shared (it is not an item)
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

  /* ══ 11. Raid start clears the plate (2026-09-16 user's decision — with `armPreps`, training range excluded) ══ */
  console.log('레이드 시작 → 접시 치움');
  const rs = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    h.devSetPlate('meal_tuber_stew', 5);
    ctx.bus.emit('game:newMission', { seed: 90210, mode: 'raid' });
    const out = { plate: h.getPlate(), ev: window.__rec.plates.at(-1) ?? null };
    ctx.bus.emit('game:abort', {});
    return out;
  });
  await sleep(1200);                                                   // the save debounce
  const rsStored = await H(() => { try { return JSON.parse(localStorage.getItem('scav.s1.ship'))?.plate ?? null; } catch { return 'err'; } });
  ok(rs.plate === null && rs.ev?.reason === 'raid' && rs.ev.plate === null && rsStored === null, `game:newMission (레이드) → 접시가 치워지고 저장된다 (${JSON.stringify({ rs, rsStored })})`);

  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
