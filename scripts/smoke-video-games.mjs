// Single-player smoke test for **video games** (2026-09-13, H2 — src/housing/README.md Decisions,
// src/housing — parts/VideoGame · Rules.tvSeatFor · parts/GymGames tuning · ui/tv/TvMenu · ui/gym game mode +
// progression applyGymSession intelligence · perception):
//   1. The seat rule matrix (pure — the furniture list is swapped for a moment, `videoGameDebug.seatFor`) — no seat ·
//      seated facing away · behind the TV · no overlap in width · another room · tall furniture in the path =
//      blocked · furniture outside the width · low furniture passes · the sofa · the nearest seat · blocked > not
//      watching · a TV lying on its side
//   2. The judgement tuning (`makeGame(kind, tuning)`) — an empty tuning = the default · countMul the judgement
//      count · speedMul · windowMul · the pattern (rests · feet)
//   3. A real placement (a library TV · chair · game disc stand) → tvSeatBlock / getTvSeat
//   4. Mounting · swapping · pulling a console · the gates · collecting the TV = the console returned / collection
//      refused when the stash is blocked
//   5. The game list · a console mismatch · the gameBlock reasons
//   6. The session — the TV screen → play → housing:gameSession · the game mode screen · gameBeat · the result
//      (intelligence · perception) · 0 XP while debuffed · cancel
// If the item data (the console · game disc defs) is not there yet, 4–6 are skipped with a note.
// Usage: node scripts/smoke-video-games.mjs [http://localhost:5273]   (needs `npm run dev`)
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

/** GYM_* from `data/constants.csv` — the expected values are derived from the numbers. */
const K = {};
for (const line of readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'constants.csv'), 'utf8').split(/\r?\n/)) {
  const m = /^(GYM_[A-Z_]+),([^,]+)/.exec(line);
  if (m) K[m[1]] = Number(m[2]);
}

const R_NONE = 'TV 정면에 의자나 쇼파가 없습니다';
const R_FACING = '좌석이 TV 를 보고 있지 않습니다';
const R_BLOCKED = 'TV 와 좌석 사이를 가구가 막고 있습니다';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const note = (s) => console.log(`  note ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
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

  // One boot (E-12): puppeteer starts every run on a throw-away profile dir, so localStorage is already empty here.
  // The old goto → remove ship / stash / grant → reload only undid what that first boot had written itself
  // (measured 2026-09-21: the second boot then inherited just a session token · clockHigh · playerName · an unsent
  // starter-stash queue entry, all content-identical to a first boot's).
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot && !!window.__game.ctx.progression, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    const b = window.__game.ctx.bus;
    window.__rec = { sessions: [], beats: [], results: [], consoles: [], menu: [], guide: [] };
    b.on('housing:gameSession', (p) => window.__rec.sessions.push({ ...p }));
    b.on('housing:gameBeat', (p) => window.__rec.beats.push({ ...p }));
    b.on('housing:gameResult', (p) => window.__rec.results.push({ ...p }));
    b.on('housing:tvConsoleChanged', (p) => window.__rec.consoles.push({ ...p }));
    b.on('ui:tvMenuToggled', (p) => window.__rec.menu.push({ ...p }));
    b.on('ui:keyGuide', (p) => { if (p.owner === 'housing.game') window.__rec.guide.push(p.keys ? p.keys.map((k) => k.label) : null); });
  });
  const api = await H(() => {
    const h = window.__game.ctx.housing;
    return ['videoGameDebug', 'tvSeatBlock', 'getTvSeat', 'attachTvConsole', 'detachTvConsole', 'getTvConsole', 'getPlayableGames', 'openTvMenu', 'gameBlock', 'startGameSession', 'cancelGameSession']
      .filter((k) => h[k] === undefined);
  });
  ok(api.length === 0, `HousingRef 비디오게임 API 가 전부 있다 (${api.join(', ') || '빠짐 없음'})`);

  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitFor(page, () => [...document.querySelectorAll('.menu.hidden')].every((m) => {
    const cs = getComputedStyle(m);
    return cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
  }), '숨은 메뉴의 페이드가 끝난다', 5000);

  /* ══ 1. The seat rule matrix (pure) ══════════════════════════════ */
  console.log('좌석 규칙');
  const seat = await H(() => {
    const h = window.__game.ctx.housing, dbg = h.videoGameDebug;
    const defs = h.getAllFurnitureDefs();
    const sofa = defs.find((d) => d.interaction === 'seat' && d.cols * d.rows > 1)?.id ?? null;
    const chair = defs.find((d) => d.id === 'furn_chair' && d.interaction === 'seat')?.id ?? defs.find((d) => d.interaction === 'seat' && d.cols === 1 && d.rows === 1)?.id ?? null;
    const rocking = defs.find((d) => d.interaction === 'rocking_chair')?.id ?? null;
    const low = defs.find((d) => d.low)?.id ?? null;
    const high = defs.find((d) => !d.low && d.interaction === 'none' && d.cols === 1 && d.rows === 1)?.id
      ?? defs.find((d) => !d.low && !['seat', 'rocking_chair', 'tv'].includes(d.interaction))?.id ?? null;
    const saved = h.state.furniture;
    const P = (uid, defId, x, y, yaw, room = 3) => ({ uid, defId, room, x, y, yaw, level: 1 });
    const run = (items, tv = 't') => { h.state.furniture = items; try { return dbg.seatFor(tv); } finally { h.state.furniture = saved; } };
    const TV = P('t', 'furn_tv', 6, 10, 0);                 // 3×1, the front = decreasing grid y → the seat is on the y < 10 side
    const seatDef = chair ?? rocking;
    const out = { chair, sofa, rocking, low, high, seatDef };
    if (!seatDef) return out;
    out.none = run([TV]);
    out.valid = run([TV, P('c', seatDef, 7, 5, 2)]);
    out.facing = run([TV, P('c', seatDef, 7, 5, 0)]);
    out.behind = run([TV, P('c', seatDef, 7, 12, 0)]);
    out.offWidth = run([TV, P('c', seatDef, 10, 5, 2)]);
    out.otherRoom = run([TV, P('c', seatDef, 7, 5, 2, 4)]);
    out.notTv = run([TV, P('c', seatDef, 7, 5, 2)], 'c');
    if (high) {
      out.blocked = run([TV, P('c', seatDef, 7, 5, 2), P('h', high, 7, 8, 0)]);
      out.besideCorridor = run([TV, P('c', seatDef, 7, 5, 2), P('h', high, 12, 8, 0)]);
      out.blockedBeatsFacing = run([TV, P('c', seatDef, 7, 5, 2), P('h', high, 7, 8, 0), P('d', seatDef, 6, 5, 0)]);
    }
    if (low) out.low = run([TV, P('c', seatDef, 7, 3, 2), P('l', low, 6, 5, 0)]);
    if (sofa) {
      out.sofa = run([TV, P('s', sofa, 5, 4, 2)]);
      out.nearest = run([TV, P('c', seatDef, 7, 2, 2), P('s', sofa, 5, 6, 2)]);
    }
    out.nearestChair = run([TV, P('c', seatDef, 7, 7, 2), P('d', seatDef, 6, 2, 2)]);
    const TV1 = P('t', 'furn_tv', 5, 5, 1);                // yaw 1 → 1×3, the front = increasing grid x → the seat is on the x > 5 side, yaw 3
    out.side = run([TV1, P('c', seatDef, 9, 6, 3)]);
    out.sideFacing = run([TV1, P('c', seatDef, 9, 6, 1)]);
    return out;
  });
  if (!seat.seatDef) {
    ok(false, '좌석 가구(interaction seat · rocking_chair)가 하나도 없다 — data/furniture.csv', JSON.stringify(seat));
  } else {
    ok(seat.none.seatUid === null && seat.none.reason === R_NONE, `좌석 없음 → ${seat.none.reason}`);
    ok(seat.valid.seatUid === 'c' && seat.valid.reason === null && JSON.stringify(seat.valid.corridor) === JSON.stringify({ x: 7, y: 6, cols: 1, rows: 4 }),
      `TV 정면 · TV 를 보는 좌석 → 좌석 (통로 ${JSON.stringify(seat.valid.corridor)})`, JSON.stringify(seat.valid));
    ok(seat.facing.reason === R_FACING, `반대로 앉은 좌석 → ${seat.facing.reason}`);
    ok(seat.behind.reason === R_NONE, `TV 뒤의 좌석 → ${seat.behind.reason}`);
    ok(seat.offWidth.reason === R_NONE, `폭이 겹치지 않는 좌석 → ${seat.offWidth.reason}`);
    ok(seat.otherRoom.reason === R_NONE, `다른 방의 좌석 → ${seat.otherRoom.reason}`);
    ok(seat.notTv.reason === 'TV 가 아닙니다', `TV 가 아닌 uid → ${seat.notTv.reason}`);
    if (seat.high) {
      ok(seat.blocked.reason === R_BLOCKED, `통로의 높은 가구(${seat.high}) → ${seat.blocked.reason}`);
      ok(seat.besideCorridor.seatUid === 'c', `통로 폭 밖의 가구는 막지 않는다 (${seat.besideCorridor.reason})`);
      ok(seat.blockedBeatsFacing.reason === R_BLOCKED, `막힘 사유가 「보고 있지 않음」보다 앞선다 (${seat.blockedBeatsFacing.reason})`);
    } else note('높은 1×1 가구 def 가 없어 막힘 검사를 건너뛴다');
    if (seat.low) ok(seat.low.seatUid === 'c', `낮은 가구(${seat.low})는 통로를 막지 않는다 (${seat.low.reason})`, JSON.stringify(seat.low));
    else note('FurnitureDef.low 가구가 아직 없다 — 낮은 가구 검사를 건너뛴다 (data/furniture.csv 의 low 열)');
    if (seat.sofa) {
      ok(seat.sofa.seatUid === 's', `쇼파(${seat.sofa ? 'sofa' : ''})도 좌석이다 (${seat.sofa.reason})`, JSON.stringify(seat.sofa));
      ok(seat.nearest.seatUid === 's', `더 가까운 좌석을 고른다 (${seat.nearest.seatUid})`);
    } else note('쇼파 def 가 아직 없다');
    ok(seat.nearestChair.seatUid === 'c', `같은 종류면 통로가 짧은 좌석 (${seat.nearestChair.seatUid})`);
    ok(seat.side.seatUid === 'c' && seat.sideFacing.reason === R_FACING, `옆으로 누운 TV(yaw 1): x 증가 쪽 · yaw 3 좌석 (${seat.side.reason} / ${seat.sideFacing.reason})`, JSON.stringify(seat.side));
  }

  /* ══ 2. The judgement tuning ═══════════════════════════════════════════ */
  console.log('판정 튜닝');
  const tune = await H(() => {
    const dbg = window.__game.ctx.housing.videoGameDebug;
    const noteOf = (g) => g.notes.map((n) => [n.t, n.lane, n.hold]);
    const pd = dbg.makeGame('press'), pe = dbg.makeGame('press', {}), pt = dbg.makeGame('press', { countMul: 1.3, speedMul: 1.5, windowMul: 0.5 });
    pt.update(0.1);
    let presses = 0;
    while (!pt.done && presses < 100) { pt.press('jump'); presses++; }
    const bd = dbg.makeGame('breath'), be = dbg.makeGame('breath', { pattern: 'L-R' });
    const bt = dbg.makeGame('breath', { speedMul: 0.85, windowMul: 1.1, pattern: 't-t-h-r' });
    const cd = dbg.makeGame('cycle'), cz = dbg.makeGame('cycle', { speedMul: 1, windowMul: 1, countMul: 1, pattern: '' });
    const ct = dbg.makeGame('cycle', { speedMul: 1.25, windowMul: 0.85, countMul: 1.2, pattern: 'L-L-R-r' });
    return {
      press: { dTotal: pd.total, eSame: pe.total === pd.total && pe.speed === pd.speed && pe.zone === pd.zone && pe.perfect === pd.perfect,
        tTotal: pt.total, presses, tPos: 0, tSpeed0: dbg.makeGame('press', { speedMul: 1.5 }).speed, zone: pt.zone, perfect: pt.perfect, dSpeed: pd.speed },
      pressPos: (() => { const g = dbg.makeGame('press', { speedMul: 1.5 }); g.update(0.1); return g.pos; })(),
      breath: { same: JSON.stringify(noteOf(bd)) === JSON.stringify(noteOf(be)) && bd.beat === be.beat && bd.window === be.window,
        dTotal: bd.total, tTotal: bt.total, beat: bt.beat, window: bt.window, holdS: bt.holdS, holds: bt.notes.filter((n) => n.hold).length,
        gapAfterHold: bt.notes[3].t - bt.notes[2].t, gapTap: bt.notes[1].t - bt.notes[0].t },
      cycle: { same: JSON.stringify(noteOf(cd)) === JSON.stringify(noteOf(cz)) && cd.beat === cz.beat && cd.window === cz.window,
        dTotal: cd.total, tTotal: ct.total, lanes: ct.notes.slice(0, 4).map((n) => n.lane), t3: ct.notes[3].t, beat: ct.beat, window: ct.window },
    };
  });
  ok(tune.press.dTotal === K.GYM_PRESS_REPS && tune.press.eSame, `빈 튜닝 = 헬스 기본 (벤치프레스 ${tune.press.dTotal}회)`);
  ok(tune.press.tTotal === Math.round(K.GYM_PRESS_REPS * 1.3) && tune.press.presses === tune.press.tTotal, `countMul 1.3 → 판정 ${tune.press.tTotal}회 (누른 수 ${tune.press.presses})`);
  ok(near(tune.press.tSpeed0, K.GYM_PRESS_SPEED * 1.5) && near(tune.pressPos, K.GYM_PRESS_SPEED * 1.5 * 0.1, 1e-6), `speedMul 1.5 → 커서 ${tune.press.tSpeed0.toFixed(3)} 바/초 (기본 ${tune.press.dSpeed})`);
  ok(near(tune.press.zone, K.GYM_PRESS_ZONE * 0.5) && near(tune.press.perfect, K.GYM_PRESS_PERFECT * 0.5), `windowMul 0.5 → 구역 반폭 ${tune.press.zone} · 완벽 ${tune.press.perfect}`);
  ok(tune.breath.same && tune.breath.dTotal === K.GYM_BREATH_CYCLES * 3, `호흡: 맞지 않는 패턴 토큰(L-R)은 버려져 헬스 기본 (${tune.breath.dTotal}회)`);
  const bBeat = K.GYM_BREATH_BEAT_S / 0.85, bHold = K.GYM_BREATH_HOLD_S / 0.85;
  /* 2026-09-14 (user's decision 「보이는 것 = 판정」): `game.window` is now the **outer (good) band**, the csv window
     × `GYM_GOOD_OF_PERFECT` (the perfect band = the csv window as it is = the marker drawn on screen). The cap (half
     a beat) still applies. */
  ok(tune.breath.tTotal === K.GYM_BREATH_CYCLES * 3 && tune.breath.holds === K.GYM_BREATH_CYCLES && near(tune.breath.beat, bBeat)
    && near(tune.breath.window, Math.min(K.GYM_BREATH_WINDOW_S * 1.1 * K.GYM_GOOD_OF_PERFECT, bBeat / 2)),
    `호흡 t-t-h-r: 판정 ${tune.breath.tTotal} · 꾹 ${tune.breath.holds} · 박자 ${tune.breath.beat.toFixed(3)} s`, JSON.stringify(tune.breath));
  ok(near(tune.breath.gapTap, bBeat, 1e-6) && near(tune.breath.gapAfterHold, bHold + 2 * bBeat, 1e-6), `호흡 쉼 r = 한 박 (꾹 뒤 간격 ${tune.breath.gapAfterHold.toFixed(3)} = 쥐기 + 2 박)`);
  const cBeat = K.GYM_CYCLE_BEAT_S / 1.25;
  ok(tune.cycle.same && tune.cycle.dTotal === K.GYM_CYCLE_STROKES, `사이클: 1 · 빈 패턴 = 헬스 기본 (${tune.cycle.dTotal}회)`);
  ok(tune.cycle.tTotal === Math.round(K.GYM_CYCLE_STROKES * 1.2) && JSON.stringify(tune.cycle.lanes) === JSON.stringify(['left', 'left', 'right', 'left'])
    && near(tune.cycle.beat, cBeat) && near(tune.cycle.t3, (K.GYM_LEAD_BEATS + 4) * cBeat, 1e-6)
    && near(tune.cycle.window, Math.min(K.GYM_CYCLE_WINDOW_S * 0.85 * K.GYM_GOOD_OF_PERFECT, cBeat / 2)),
  `사이클 L-L-R-r: 판정 ${tune.cycle.tTotal} · 발 ${tune.cycle.lanes.join(' ')} · 쉼 뒤 표식 박자 ${K.GYM_LEAD_BEATS + 4}`, JSON.stringify(tune.cycle));

  /* ══ 3. A real placement ═══════════════════════════════════════════════ */
  console.log('실제 배치');
  const setup = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    for (const [id, n] of [['mat_scrap', 80], ['mat_alloy', 20], ['mat_cable', 10], ['mat_circuit', 10], ['mat_cloth', 30]]) {
      const def = ctx.loot.getItemDef(id);
      if (!def) continue;
      let added = 0;
      while (added < n) { const q = Math.min(def.stackMax ?? 1, n - added); if (!ctx.inventory.tryAddToStash(ctx.loot.createItem(id, q))) break; added += q; }
    }
    h.state.generatorLevel = Math.max(h.state.generatorLevel, 5);   // the library = generator Lv.4 (2026-09-13 — max Lv.5)
    h.state.rooms[3].purpose = 'library';
    const place = (defId, x, y, yaw) => {
      if (!h.storageEntry(defId) && !h.craftFurniture(defId)) return { err: `craft ${defId}: ${h.furnitureCraftBlock?.(defId)}` };
      const spot = x === undefined ? h.findFreeSpot(3, defId) : { x, y, yaw };
      if (!spot) return { err: `no spot ${defId}` };
      const p = h.place(3, defId, spot.x, spot.y, spot.yaw);
      return p ? { uid: p.uid } : { err: `place ${defId} refused: ${h.placementBlock?.(3, defId, spot.x, spot.y, spot.yaw)}` };
    };
    const tv = place('furn_tv', 6, 10, 0);
    const chair = place('furn_chair', 7, 5, 2);
    const stand = h.getFurnitureDef('furn_game_stand') ? place('furn_game_stand', 0, 13, 1) : { err: 'no furn_game_stand def' };
    // 2026-09-13 (power allocation dropped): there is no power to allocate — a TV works as soon as it is placed
    return { tv, chair, stand, tvOp: tv.uid ? h.furnitureOperationalBlock(tv.uid) : 'no tv' };
  });
  ok(!!setup.tv.uid && !!setup.chair.uid, `서재에 TV · 의자 배치 (${JSON.stringify({ tv: setup.tv, chair: setup.chair })})`);
  ok(setup.tvOp === null, 'TV 가 작동한다 (전력 할당 없음 — furnitureOperationalBlock null)', String(setup.tvOp));
  const TV = setup.tv.uid, CHAIR = setup.chair.uid, STAND = setup.stand.uid ?? null;
  if (!STAND) note(`게임 디스크 전시대를 놓지 못했다 — ${setup.stand.err}`);
  const live = await H(({ TV, CHAIR }) => {
    const h = window.__game.ctx.housing;
    return { block: h.tvSeatBlock(TV), seat: h.getTvSeat(TV), notTv: h.tvSeatBlock(CHAIR) };
  }, { TV, CHAIR });
  ok(live.block === null && live.seat === CHAIR, `배치한 의자가 TV 좌석 (${live.seat} · ${live.block})`);
  ok(live.notTv === 'TV 가 아닙니다', `의자 uid 로 물으면 TV 가 아니다 (${live.notTv})`);

  /* ══ 4. The console ══════════════════════════════════════════════════════ */
  const data = await H(() => {
    const loot = window.__game.ctx.loot;
    const consoles = loot.getAllItemDefs().filter((d) => d.gameConsole).map((d) => ({ id: d.id, kind: d.gameConsole.console }));
    const discs = loot.getAllItemDefs().filter((d) => d.gameDisc).map((d) => ({ id: d.id, console: d.gameDisc.console, stat: d.gameDisc.stat, minigame: d.gameDisc.minigame, color: d.gameDisc.color, tuning: d.gameDisc.tuning }));
    return { consoles, discs };
  });
  const C = data.consoles, D = data.discs;
  const haveData = C.length >= 2 && D.length >= 2;
  if (!haveData) {
    note(`게임기 ${C.length} · 게임 디스크 ${D.length} def — items 로더가 아직 ItemDef.gameConsole / gameDisc 를 만들지 않는다. 4–6 을 건너뛴다.`);
  } else {
    console.log('게임기');
    const cA = C[0], cB = C.find((c) => c.kind !== cA.kind) ?? C[1];
    const cons = await H(({ TV, A, B, all }) => {
      const ctx = window.__game.ctx, h = ctx.housing, inv = ctx.inventory, loot = ctx.loot;
      for (const id of [A, B]) inv.tryAddToStash(loot.createItem(id, 1));
      const n0 = { a: h.countDef(A), b: h.countDef(B) };
      const r = {};
      r.attach = h.attachTvConsole(TV, A);
      r.afterAttach = { cur: h.getTvConsole(TV), a: h.countDef(A), ev: window.__rec.consoles.at(-1) ?? null, saved: { ...((h.state.tvConsoles ?? []).find((s) => s.uid === TV) ?? {}) } };   // a copy — a swap rewrites the same cell object
      r.again = h.attachTvConsole(TV, A);
      r.replace = h.attachTvConsole(TV, B);
      r.afterReplace = { cur: h.getTvConsole(TV), a: h.countDef(A), b: h.countDef(B) };
      const missing = all.find((id) => id !== A && id !== B && h.countDef(id) === 0) ?? null;
      r.missing = missing ? h.attachTvConsole(TV, missing) : 'skip';
      r.notConsole = h.attachTvConsole(TV, 'mat_scrap');
      ctx.isRaidActive = () => true;
      r.raid = h.attachTvConsole(TV, A);
      delete ctx.isRaidActive;
      r.detach = h.detachTvConsole(TV);
      r.afterDetach = { cur: h.getTvConsole(TV), b: h.countDef(B), ev: window.__rec.consoles.at(-1) ?? null };
      r.detach2 = h.detachTvConsole(TV);
      return { n0, ...r };
    }, { TV, A: cA.id, B: cB.id, all: C.map((c) => c.id) });
    ok(cons.attach === null && cons.afterAttach.cur === cA.id && cons.afterAttach.a === cons.n0.a - 1, `장착 → 게임기 소모 (${cA.id} ${cons.n0.a} → ${cons.afterAttach.a})`, JSON.stringify(cons));
    ok(cons.afterAttach.ev?.uid === TV && cons.afterAttach.ev?.defId === cA.id && cons.afterAttach.saved?.defId === cA.id, 'housing:tvConsoleChanged · ShipState.tvConsoles', JSON.stringify({ TV, afterAttach: cons.afterAttach }));
    ok(typeof cons.again === 'string' && cons.again.startsWith('이미'), `같은 게임기 다시 → ${cons.again}`);
    ok(cons.replace === null && cons.afterReplace.cur === cB.id && cons.afterReplace.a === cons.n0.a && cons.afterReplace.b === cons.n0.b - 1, `교체 → 옛 게임기 반환 (${JSON.stringify(cons.afterReplace)})`);
    ok(cons.missing === 'skip' || (typeof cons.missing === 'string' && cons.missing.endsWith('없습니다')), `없는 게임기 → ${cons.missing}`);
    ok(cons.notConsole === '게임기가 아닙니다', `게임기가 아닌 아이템 → ${cons.notConsole}`);
    ok(cons.raid === '함선에서만 게임기를 장착할 수 있습니다', `레이드 중 → ${cons.raid}`);
    ok(cons.detach === null && cons.afterDetach.cur === null && cons.afterDetach.b === cons.n0.b && cons.afterDetach.ev?.defId === null, `빼기 → 반환 · 이벤트 defId null (${JSON.stringify(cons.afterDetach)})`);
    ok(cons.detach2 === '장착된 게임기가 없습니다', `두 번 빼기 → ${cons.detach2}`);

    console.log('TV 회수');
    const rec = await H(({ TV, A }) => {
      const ctx = window.__game.ctx, h = ctx.housing, inv = ctx.inventory;
      const r = {};
      r.attach = h.attachTvConsole(TV, A);
      const n = h.countDef(A);
      // pretending the stash is blocked — the recoverBlock reason · recover refused (the TV · console stay)
      h.stashSpaceBlock = () => '함선 창고 가득';
      r.block = h.recoverBlock(TV);
      delete h.stashSpaceBlock;
      const realAdd = inv.tryAddToStash;
      inv.tryAddToStash = () => false;
      r.refused = h.recover(TV);
      inv.tryAddToStash = realAdd;
      r.afterRefused = { placed: !!h.getPlacedByUid(TV), cur: h.getTvConsole(TV) };
      r.ok = h.recover(TV);
      r.after = { placed: !!h.getPlacedByUid(TV), cons: (h.state.tvConsoles ?? []).filter((s) => s.uid === TV).length, count: h.countDef(A), n, ev: window.__rec.consoles.at(-1) ?? null };
      // placed again (the same spot)
      const p = h.place(3, 'furn_tv', 6, 10, 0);
      r.replaced = p ? p.uid : null;
      return r;
    }, { TV, A: cA.id });
    ok(rec.attach === null && typeof rec.block === 'string' && rec.block.includes('게임기'), `게임기가 든 TV + 창고 가득 → recoverBlock (${rec.block})`);
    ok(rec.refused === false && rec.afterRefused.placed && rec.afterRefused.cur === cA.id, `창고에 못 넣으면 회수 거절 · TV 와 게임기 그대로 (${JSON.stringify(rec.afterRefused)})`);
    ok(rec.ok === true && !rec.after.placed && rec.after.cons === 0 && rec.after.count === rec.after.n + 1 && rec.after.ev?.uid === TV && rec.after.ev.defId === null,
      `TV 회수 → 게임기가 함선 창고로 · 칸 지움 (${JSON.stringify(rec.after)})`);
    ok(!!rec.replaced, `TV 를 다시 놓는다 (${rec.replaced})`);
    const TV2 = rec.replaced;

    /* ══ 5. The game list ════════════════════════════════════════════════ */
    console.log('게임 목록');
    const discA = D.find((d) => d.console === cA.kind && d.stat === 'intelligence') ?? D.find((d) => d.console === cA.kind);
    const discP = D.find((d) => d.console === cA.kind && d.stat === 'perception' && d !== discA) ?? D.find((d) => d.console === cA.kind && d !== discA);
    const discX = D.find((d) => d.console !== cA.kind);
    if (!STAND || !TV2 || !discA || !discP || !discX) {
      note(`게임 목록 · 세션 검사에 필요한 것이 없다 (stand ${STAND} · tv ${TV2} · discs ${discA?.id} ${discP?.id} ${discX?.id})`);
    } else {
      const list = await H(({ TV, STAND, ids }) => {
        const ctx = window.__game.ctx, h = ctx.housing, inv = ctx.inventory, loot = ctx.loot;
        for (const id of ids) inv.tryAddToStash(loot.createItem(id, 1));
        const put = ids.map((id, slot) => h.placeShelfItem(STAND, slot, id));
        const noConsole = h.getPlayableGames(TV).map((g) => ({ ...g }));
        return { put, medium: h.getShelfMedium(STAND), noConsole };
      }, { TV: TV2, STAND, ids: [discA.id, discP.id, discX.id] });
      if (list.put.some((r) => r !== null)) {
        note(`게임 디스크를 전시대에 꽂지 못했다 (${JSON.stringify(list.put)} · medium ${list.medium}) — 서재 보관함 쪽(H1) 미완. 5–6 을 건너뛴다.`);
      } else {
        ok(list.noConsole.length === 3 && list.noConsole.every((g) => g.block === '게임기를 먼저 장착하세요' && g.standUid === STAND),
          `전시대의 디스크 3 · 게임기 없음 사유 (${JSON.stringify(list.noConsole.map((g) => g.block))})`);
        const withC = await H(({ TV, A, discA, discX, CHAIR }) => {
          const ctx = window.__game.ctx, h = ctx.housing;
          const r = { attach: h.attachTvConsole(TV, A) };
          r.games = Object.fromEntries(h.getPlayableGames(TV).map((g) => [g.defId, g.block]));
          r.blockOk = h.gameBlock(TV, discA);
          r.blockX = h.gameBlock(TV, discX);
          r.blockNotShelved = h.gameBlock(TV, 'mat_scrap');
          ctx.uiBlockers.add('smoke');
          r.blockOther = h.gameBlock(TV, discA);
          ctx.uiBlockers.delete('smoke');
          // 2026-09-17 (user's decision): a seat is not a requirement — it can start with the chair collected and
          // is played standing (`seatUid` null, no sitting pose)
          const chairItem = h.getPlacedByUid(CHAIR);
          r.recoverChair = h.recover(CHAIR);
          r.noSeat = h.gameBlock(TV, discA);
          r.noSeatUid = h.getTvSeat(TV);
          r.noSeatReason = h.tvSeatBlock(TV);
          h.openTvMenu(TV);
          r.standMenu = { seat: document.querySelector('.tv-menu .tvm-seat')?.textContent ?? null, bad: !!document.querySelector('.tv-menu .tvm-seat.is-bad') };
          h.tvMenu?.close(false);
          r.standStart = h.startGameSession(TV, discA);
          window.__game.getSystem('player').recomputeBuffs?.();
          r.stand = { info: h.gameSession ? { ...h.gameSession } : null, ev: window.__rec.sessions.at(-1) ?? null, pose: ctx.player.furniturePose ?? null,
            gaming: (ctx.player.buffs ?? []).some((b) => b.kind === 'gaming') || null };
          h.cancelGameSession();
          r.standEnd = { info: h.gameSession, ev: window.__rec.sessions.at(-1) ?? null };
          r.chair = h.place(chairItem.room, chairItem.defId, chairItem.x, chairItem.y, chairItem.yaw)?.uid ?? null;
          r.back = h.gameBlock(TV, discA);
          return r;
        }, { TV: TV2, A: cA.id, discA: discA.id, discX: discX.id, CHAIR });
        ok(withC.attach === null && withC.games[discA.id] === null && withC.games[discP.id] === null, `게임기가 맞는 디스크는 사유 없음 (${JSON.stringify(withC.games)})`);
        ok(typeof withC.games[discX.id] === 'string' && withC.games[discX.id].endsWith('전용 게임입니다') && withC.blockX === withC.games[discX.id], `게임기 불일치 → ${withC.games[discX.id]}`);
        ok(withC.blockOk === null, `gameBlock: 시작할 수 있다 (${withC.blockOk})`);
        ok(withC.blockNotShelved === '게임 디스크가 아닙니다', `gameBlock: 게임 디스크가 아님 (${withC.blockNotShelved})`);
        ok(withC.blockOther === '다른 화면을 먼저 닫으세요', `gameBlock: 다른 블로커 (${withC.blockOther})`);
        ok(withC.recoverChair === true && withC.noSeat === null && withC.noSeatUid === null && withC.noSeatReason === R_NONE && !!withC.chair && withC.back === null,
          `좌석을 치워도 시작할 수 있다 (gameBlock ${withC.noSeat} · 좌석 ${withC.noSeatUid} · 진단 ${withC.noSeatReason})`, JSON.stringify(withC));
        ok(withC.standMenu.seat === '서서 플레이합니다' && !withC.standMenu.bad, `좌석 없는 TV 화면: 「${withC.standMenu.seat}」 (경고 아님)`);
        ok(withC.standStart === null && withC.stand.info?.seatUid === null && withC.stand.ev?.active === true && withC.stand.ev.seatUid === null && withC.stand.pose === null,
          `좌석 없이 시작 → 서서 플레이 (seatUid null · 자세 ${withC.stand.pose})`, JSON.stringify(withC.stand));
        ok(withC.stand.gaming === true, '서서 하는 게임도 「게임 중」 버프 (player/parts/Buffs)', JSON.stringify(withC.stand));
        ok(withC.standEnd.info === null && withC.standEnd.ev?.active === false, '서서 하던 세션 취소 → 정리', JSON.stringify(withC.standEnd));
        const CHAIR2 = withC.chair;

        /* ══ 6. The session ══════════════════════════════════════════════════ */
        console.log('세션');
        const hasProg = await H(() => {
          const p = window.__game.ctx.progression;
          p.clearGymFatigue?.();
          for (const s of ['intelligence', 'perception']) p.addTrainedXp?.(s, -1e7);
          return typeof p.applyGymSession === 'function';
        });
        const menu = await H(({ TV }) => {
          const ctx = window.__game.ctx, h = ctx.housing;
          const on0 = h.isFurnitureOn(TV);
          h.openTvMenu(TV);
          const r = {
            on0, toggled: window.__rec.menu.at(-1) ?? null, open: !!h.tvMenu?.isOpen, blocker: ctx.uiBlockers.has('housing'), esc: ctx.escape.has('housing'),
            rows: document.querySelectorAll('.tv-menu:not([hidden]) .tvm-game').length, seat: document.querySelector('.tv-menu .tvm-seat')?.textContent ?? null,
            seatBad: !!document.querySelector('.tv-menu .tvm-seat.is-bad'), consoleName: document.querySelector('.tv-menu .tvm-console .tvm-name')?.textContent ?? null,
          };
          return r;
        }, { TV: TV2 });
        ok(menu.open && menu.toggled?.open === true && menu.toggled.uid === TV2 && menu.blocker && menu.esc, `openTvMenu → ui:tvMenuToggled · 블로커 · ESC (${JSON.stringify(menu.toggled)})`);
        ok(menu.rows === 3 && !menu.seatBad && /앉아 플레이합니다/.test(menu.seat ?? ''), `TV 화면: 게임 줄 ${menu.rows} · 좌석 줄 「${menu.seat}」 · 게임기 ${menu.consoleName}`);
        const blockWithMenu = await H(({ TV, id }) => window.__game.ctx.housing.gameBlock(TV, id), { TV: TV2, id: discA.id });
        ok(blockWithMenu === null, `TV 화면이 열려 있는 것은 사유가 아니다 (${blockWithMenu})`);

        const s1 = await H(({ TV, id }) => {
          const ctx = window.__game.ctx, h = ctx.housing;
          const btn = document.querySelector(`.tv-menu .tvm-game[data-def="${id}"] .tvm-play`);
          btn?.click();
          const root = document.querySelector('.gym');
          return {
            clicked: !!btn, info: h.gameSession, ev: window.__rec.sessions.at(-1) ?? null, menuOpen: !!h.tvMenu?.isOpen, menuEv: window.__rec.menu.at(-1) ?? null,
            on: h.isFurnitureOn(TV), blocker: ctx.uiBlockers.has('housing.game'), esc: ctx.escape.has('housing.game'),
            game: !!root?.classList.contains('is-game') && !root.hidden, accent: root?.style.getPropertyValue('--c-accent') ?? '',
            title: document.querySelector('.gym-intro .gym-title')?.textContent ?? null, kicker: document.querySelector('.gym-intro .gym-kicker')?.textContent ?? null,
            screen: h.videoGameDebug.screen, guide: window.__rec.guide.at(-1) ?? null, again: h.startGameSession(TV, id),
          };
        }, { TV: TV2, id: discA.id });
        ok(s1.clicked && s1.info?.tvUid === TV2 && s1.info.discDefId === discA.id && s1.info.seatUid === CHAIR2 && s1.info.stat === discA.stat,
          `플레이 클릭 → 게임 세션 (${JSON.stringify(s1.info)})`, JSON.stringify(s1));
        if (!s1.info) {
          note('세션이 곧바로 끝났다 — hub 가 좌석 자세를 걸지 못해 cancelGameSession 을 불렀을 수 있다 (hub 미완). 나머지 세션 검사를 건너뛴다.');
        } else {
          ok(s1.ev?.active === true && s1.ev.completed === false && s1.ev.seatUid === CHAIR2 && s1.ev.minigame === discA.minigame, 'housing:gameSession {active:true, seatUid, minigame}');
          ok(!s1.menuOpen && s1.menuEv?.open === false && s1.on === true, `TV 화면이 닫히고 TV 가 켜진다 (on0=${menu.on0} → ${s1.on})`);
          ok(s1.blocker && s1.esc && s1.game && s1.accent.toLowerCase() === discA.color.toLowerCase(), `블로커 · ESC housing.game · 게임 모드 화면 · 강조색 ${s1.accent}`);
          ok(s1.screen === 'intro' && s1.title && /비디오게임/.test(s1.kicker ?? '') && JSON.stringify(s1.guide) === JSON.stringify(['시작']), `시작 안내 (${s1.kicker} · ${s1.title})`);
          ok(s1.again === '이미 게임 중입니다', `세션 중 두 번째 시작 → ${s1.again}`);
          const g1 = await H(() => {
            const h = window.__game.ctx.housing;
            const started = h.videoGameDebug.start();
            const g = h.videoGameDebug.game;
            return { started, total: g?.total ?? null, minigame: g?.minigame ?? null, zone: document.querySelector('.gym-panel .gym-press-zone')?.style.width ?? null, gz: g?.zone ?? null, guide: window.__rec.guide.at(-1) };
          });
          const wantTotal = discA.minigame === 'press' ? Math.max(1, Math.round(K.GYM_PRESS_REPS * (discA.tuning?.countMul ?? 1)))
            : discA.minigame === 'cycle' ? Math.max(1, Math.round(K.GYM_CYCLE_STROKES * (discA.tuning?.countMul ?? 1))) : Math.max(1, Math.round(K.GYM_BREATH_CYCLES * 3 * (discA.tuning?.countMul ?? 1)));
          ok(g1.started && g1.minigame === discA.minigame && g1.total === wantTotal, `게임 시작 — 디스크 튜닝 판정 수 ${g1.total} (${discA.minigame})`, JSON.stringify(g1));
          if (discA.minigame === 'press') ok(near(parseFloat(g1.zone ?? 'NaN'), Number((g1.gz * 200).toFixed(2)), 1e-6) && near(g1.gz, K.GYM_PRESS_ZONE * (discA.tuning?.windowMul ?? 1)), `구역 폭 = 튜닝된 zone (${g1.zone} = ${g1.gz} × 200)`);
          // real keys — the bench press Space / breathing Space / cycling A · D, all of them (one of the two judges)
          await tap('Space'); await tap('KeyA'); await tap('KeyD');
          await waitFor(page, () => window.__rec.beats.length > 0 || (window.__game.ctx.housing.videoGameDebug.game?.time ?? 0) > 3, 'beat', 8000).catch(() => null);
          if (discA.minigame === 'press') ok((await H(() => window.__rec.beats.at(-1))) ?.tvUid === TV2, `진짜 Space → housing:gameBeat (${JSON.stringify(await H(() => window.__rec.beats.at(-1)))})`);
          if (hasProg) {
            const fin = await H(({ stat }) => {
              const h = window.__game.ctx.housing, p = window.__game.ctx.progression;
              const r = h.videoGameDebug.finish(1);
              return { r, ev: window.__rec.results.at(-1) ?? null, fatigue: p.getGymFatigueUntil(stat), now: Date.now(), text: document.querySelector('.gym-result')?.textContent ?? '', screen: h.videoGameDebug.screen };
            }, { stat: discA.stat });
            ok(fin.r && fin.r.stat === discA.stat && fin.r.xp === K.GYM_SESSION_XP && fin.r.wasFatigued === false, `finish(1) → applyGymSession('${discA.stat}') +${fin.r?.xp}`, JSON.stringify(fin.r));
            ok(fin.ev?.tvUid === TV2 && fin.ev.discDefId === discA.id && JSON.stringify(fin.ev.result) === JSON.stringify(fin.r), 'housing:gameResult = 결과 그대로');
            ok(Math.abs((fin.fatigue - fin.now) / 3600e3 - K.GYM_FATIGUE_HOURS) < 0.01, `디버프 ${((fin.fatigue - fin.now) / 3600e3).toFixed(2)} 시간`);
            ok(fin.screen === 'result' && /게임 완료/.test(fin.text), `결과 화면 (${fin.text.slice(0, 60)})`);
          } else note('progression.applyGymSession 없음 — 결과 검사를 건너뛴다');
          await tap('Tab');
          const closed = await H(() => { const ctx = window.__game.ctx; return { ev: window.__rec.sessions.at(-1), info: ctx.housing.gameSession, blocker: ctx.uiBlockers.has('housing.game'), esc: ctx.escape.has('housing.game'), guide: window.__rec.guide.at(-1) }; });
          ok(closed.ev.active === false && closed.ev.completed === hasProg && closed.info === null && !closed.blocker && !closed.esc && closed.guide === null, `Tab → housing:gameSession {active:false, completed:${closed.ev.completed}} · 정리`);

          if (hasProg) {
            const s2 = await H(({ TV, id, stat }) => {
              const h = window.__game.ctx.housing;
              const r0 = h.startGameSession(TV, id);
              const r = h.videoGameDebug.finish(1);
              window.__game.ctx.escape.closeTop();
              return { r0, r, stat, ev: window.__rec.results.at(-1) ?? null };
            }, { TV: TV2, id: discP.id, stat: discP.stat });
            ok(s2.r0 === null && s2.r?.stat === discP.stat && (discP.stat === discA.stat ? s2.r.xp === 0 : s2.r.xp === K.GYM_SESSION_XP), `두 번째 능력치 게임(${discP.stat}) → +${s2.r?.xp}`, JSON.stringify(s2));
            const s3 = await H(({ TV, id, stat }) => {
              const h = window.__game.ctx.housing, p = window.__game.ctx.progression;
              const before = { until: p.getGymFatigueUntil(stat), prog: p.getTrainedProgress(stat) };
              const r0 = h.startGameSession(TV, id);
              const warn = document.querySelector('.gym-intro .gym-warn')?.textContent ?? '';
              const r = h.videoGameDebug.finish(1);
              const text = document.querySelector('.gym-result')?.textContent ?? '';
              window.__game.ctx.escape.closeTop();
              h.openTvMenu(TV);
              const fatigueLine = document.querySelector(`.tv-menu .tvm-game[data-def="${id}"] .tvm-fatigue`)?.textContent ?? '';
              h.tvMenu.close();
              return { r0, warn, r, text, before, after: { until: p.getGymFatigueUntil(stat), prog: p.getTrainedProgress(stat) }, fatigueLine };
            }, { TV: TV2, id: discA.id, stat: discA.stat });
            ok(s3.r0 === null && /이번 게임으로는/.test(s3.warn), `피로 중 시작 안내 경고 (${s3.warn})`);
            ok(s3.r?.xp === 0 && s3.r.wasFatigued && s3.after.until === s3.before.until && s3.after.prog === s3.before.prog, `피로 중 = 경험치 0 · 디버프 그대로 (${JSON.stringify(s3.r)})`);
            ok(/남은 \d{2}:\d{2}:\d{2}/.test(s3.fatigueLine) && /경험치 0/.test(s3.fatigueLine), `TV 화면의 피로 줄 (${s3.fatigueLine})`);
          }

          console.log('취소');
          const cancel = await H(({ TV, id }) => {
            const ctx = window.__game.ctx, h = ctx.housing, b = ctx.bus;
            const res0 = window.__rec.results.length;
            const out = {};
            h.startGameSession(TV, id); h.videoGameDebug.start();
            out.attachDuring = h.attachTvConsole(TV, h.getTvConsole(TV));
            h.cancelGameSession();
            out.cancel = window.__rec.sessions.at(-1);
            // (a fake `caller` event is not checked — the hub's GameStaging tells 「what we released」 apart by its own
            //  releasing flag rather than by the reason, so an invented caller reads as 「released behind our
            //  back」 and cancels too.
            //  The housing-side caller ignore is crossed by the GymScreen close path on every run.)
            out.startForReset = h.startGameSession(TV, id);
            b.emit('player:furniturePoseEnded', { kind: 'sit', reason: 'reset' });
            out.afterReset = { info: h.gameSession, ev: window.__rec.sessions.at(-1) };
            h.startGameSession(TV, id);
            b.emit('game:abort', {});
            out.abort = { info: h.gameSession, ev: window.__rec.sessions.at(-1), hidden: document.querySelector('.gym').hidden };
            out.results = window.__rec.results.length - res0;
            return out;
          }, { TV: TV2, id: discP.id });
          ok(cancel.cancel.active === false && cancel.cancel.completed === false, 'cancelGameSession → completed:false');
          ok(typeof cancel.attachDuring === 'string' && cancel.attachDuring.includes('게임 중'), `게임 중 게임기 교체 거절 (${cancel.attachDuring})`);
          ok(cancel.startForReset === null && cancel.afterReset.info === null && cancel.afterReset.ev.active === false && cancel.afterReset.ev.completed === false,
            `앉은 자세가 reset 으로 풀리면 게임 세션 취소 (${cancel.startForReset})`, JSON.stringify(cancel.afterReset));
          ok(cancel.abort.info === null && cancel.abort.ev.active === false && cancel.abort.hidden && cancel.results === 0, `game:abort → 정리 · 취소는 결과 없음 (${cancel.results})`);
        }
        await H(() => { const p = window.__game.ctx.progression; p.clearGymFatigue?.(); for (const s of ['intelligence', 'perception']) p.addTrainedXp?.(s, -1e7); });
      }
    }
  }

  ok(errors.length === 0, `no page errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
