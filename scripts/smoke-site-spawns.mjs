// 거점 스폰 자리 스모크 (2026-09-13, 행성별 적 팩션 — world-sites).
//
// `WorldRef.getSiteSpawnPoints(siteId, place, count, minGap, seed)` · `getRuinSites()` 를 여러 시드 × 행성에서 잰다.
// 스폰 감독(enemies)이 `world:ready` 에서 호스트로 부르는 질의라, 여기서는 **돌려준 자리가 정말 설 수 있는 자리인가**만 본다.
//
// 검사 (맵마다):
//   1. 연구소 · 전진기지마다 실내 ≥ 1 · 실외 ≥ 2
//   2. 실내 자리: `structureAt(x, z)` 가 그 건물 · 층 바닥 높이(`nav.levels`) · 바깥벽 안쪽 · 잠긴 방 밖 · 몸(0.45) 충돌 없음(< 0.05 m) ·
//      머리 위 1.8 m 여유 · 정문에서 몸 반지름 flood fill 로 **걸어서 닿는다** (`smoke-structure-reach` 와 같은 식)
//   3. 실외 자리: 발자국 바깥 · 맵 안 · 선로 중심선에서 `RAIL_CLEARANCE_M` 밖 · 다른 구조물 안이 아님 · 충돌 없음 · 머리 위 여유 · 땅 위
//   4. 선로 플랫폼(있으면): 실내 = 데크 윗면 · 데크 사각형 안 · 충돌 없음, 실외 ≥ 1
//   5. 폐허 전초: `getRuinSites()` 가 비지 않고 id 가 `outpost_<i>`, 실내 = 바닥판 안 · 반경 안 · 충돌 없음, 실외 ≥ 1
//   6. 불시착 함선(있으면): 실내가 있으면 충돌 없음 · 동체 안, 실외 ≥ 1
//   7. 결정성: 같은 인자 두 번 = 같은 좌표, `minGap` 을 지킨다, count 를 넘지 않는다, 질의가 장애물 수를 바꾸지 않는다
//   8. 모르는 id · count 0 → [], 훈련장 → [] · getRuinSites() = []
//
// Usage: node scripts/smoke-site-spawns.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
/** [시드, 행성] — 행성마다 한 번 이상, 선로 · 2층 · 잠긴 방 · 불시착 함선이 나올 때까지. */
const RUNS = [[21, 'amber'], [7, 'tundra'], [1234, 'mossy'], [42, 'ashen'], [99, 'crimson'], [555, 'amber'], [808, 'tundra'], [2026, 'mossy'], [31337, 'ashen'], [11, 'crimson']];
const MAX_RUNS = 10;
const WANT = { lab: 3, outpost: 3, platform: 2, ruin: 8, twoFloor: 2, locked: 1, wreck: 1 };
/** 한 맵의 모든 질의에 걸린 시간 상한(ms) — world:ready 에서 한 번 치르는 비용이다. */
const MAP_MS_MAX = 4000;

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

/** 브라우저 안: 거점마다 질의하고 검사 재료를 한 줄씩 돌려준다. */
function probe({ seed }) {
  const ctx = window.__game.ctx, w = ctx.world;
  const V3 = ctx.camera.position.constructor;
  const ws = window.__game.getSystem('world');
  const R = 0.45, STEP = 0.3, WALL_T = 0.42, RAIL_CLEAR = 9, HALF_MAP = w.size / 2;
  const p = new V3();
  const UP = new V3(0, 1, 0);
  const obstaclesBefore = w.getObstacles().length;
  const t0 = performance.now();
  const round = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
  const pushOf = (v) => { p.copy(v); w.resolveCollision(p, R); return Math.hypot(p.x - v.x, p.z - v.z); };
  const headroom = (v) => w.raycast(new V3(v.x, v.y + 0.1, v.z), UP, 1.8) === null;
  const toL = (f, x, z) => { const c = Math.cos(f.yaw), s = Math.sin(f.yaw), dx = x - f.cx, dz = z - f.cz; return [dx * c + dz * s, -dx * s + dz * c]; };
  const gapOk = (pts, gap) => pts.every((a, i) => pts.every((b, j) => i >= j || a.distanceTo(b) >= gap - 1e-6));
  const railPts = w.getRailLines()[0]?.points ?? null;
  const railKind = w.getRailLines()[0]?.kind ?? null;
  const railDist = (x, z) => {
    if (!railPts) return Infinity;
    let best = Infinity;
    const n = railPts.length, segs = railKind === 'loop' ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = railPts[i], b = railPts[(i + 1) % n];
      const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / L2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t)));
    }
    return best;
  };
  /** 몸 반지름 flood fill (정문 안쪽에서, 발자국 밖으로 나가지 않고) — smoke-structure-reach 와 같은 식. */
  const reachSet = (nav) => {
    const c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
    const toW = (lx, lz) => [nav.cx + lx * c - lz * sn, nav.cz + lx * sn + lz * c];
    const keyOf = (i, j, y) => `${i},${j},${Math.round(y * 2)}`;
    const seen = new Map();
    const toLocal = (x, z) => { const dx = x - nav.cx, dz = z - nav.cz; return [dx * c + dz * sn, -dx * sn + dz * c]; };
    const si = Math.round(nav.doorIn[0] / STEP), sj = Math.round(nav.doorIn[1] / STEP);
    const [sx, sz] = toW(si * STEP, sj * STEP);
    const sy = w.getSurfaceY(sx, sz, nav.levels[0] + 0.3);
    p.set(sx, sy, sz); w.resolveCollision(p, R);
    if (Math.hypot(p.x - sx, p.z - sz) >= 0.02) return { seen, toL: toLocal };
    const q = [[si, sj, sy]];
    seen.set(keyOf(si, sj, sy), q[0]);
    const limX = nav.halfW - 0.1, limZ = nav.halfD - 0.1;
    for (let head = 0; head < q.length && q.length < 80000; head++) {
      const [i, j, y] = q[head];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (Math.abs(ni * STEP) > limX || Math.abs(nj * STEP) > limZ) continue;
        const [x, z] = toW(ni * STEP, nj * STEP);
        const ny = w.getSurfaceY(x, z, y);
        const k = keyOf(ni, nj, ny);
        if (seen.has(k)) continue;
        p.set(x, ny, z); w.resolveCollision(p, R);
        if (Math.hypot(p.x - x, p.z - z) >= 0.02) continue;
        const node = [ni, nj, ny];
        seen.set(k, node); q.push(node);
      }
    }
    return { seen, toL: (x, z) => { const dx = x - nav.cx, dz = z - nav.cz; return [dx * c + dz * sn, -dx * sn + dz * c]; } };
  };
  /** 자리 v 가 flood fill 칸(같은 격자 · 같은 반 뼘 높이, 이웃 한 칸까지)에 들었나. */
  const reached = (rs, v) => {
    if (!rs.seen || rs.seen.size === 0) return false;
    const [lx, lz] = rs.toL(v.x, v.z);
    const i0 = Math.round(lx / STEP), j0 = Math.round(lz / STEP), yk = Math.round(v.y * 2);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const dy of [0, -1, 1]) if (rs.seen.has(`${i0 + di},${j0 + dj},${yk + dy}`)) return true;
    }
    return false;
  };
  /** 같은 인자 두 번 = 같은 좌표. */
  const twice = (id, place, count, gap, s) => {
    const a = w.getSiteSpawnPoints(id, place, count, gap, s);
    const b = w.getSiteSpawnPoints(id, place, count, gap, s);
    return { pts: a, same: JSON.stringify(a.map(round)) === JSON.stringify(b.map(round)) };
  };

  const rows = [];
  const navs = new Map(ws.structures.debugNav().map((n) => [n.id, n.nav]));
  /* 스폰 감독이 world:ready 에서 이미 물어 캐시가 데워져 있을 수 있다 — 그 답을 적어 두고 캐시를 비운 뒤 다시 물어
   * ① 차가운 첫 질의 비용을 재고 ② 처음부터 다시 계산해도 같은 좌표인지 본다. */
  const warm = new Map(w.getStructures().map((d) => [d.id, JSON.stringify(w.getSiteSpawnPoints(d.id, 'indoor', 4, 1.2, seed).map(round))]));
  const canReset = typeof ws.siteSpawns?.reset === 'function';
  if (canReset) ws.siteSpawns.reset();
  for (const def of w.getStructures()) {
    const nav = navs.get(def.id);
    const f = { cx: nav.cx, cz: nav.cz, yaw: nav.yaw };
    const tIn = performance.now();
    const indoor = twice(def.id, 'indoor', 4, 1.2, seed);
    const msIndoor = Math.round(performance.now() - tIn);
    const rebuiltSame = JSON.stringify(indoor.pts.map(round)) === warm.get(def.id);
    const outdoor = twice(def.id, 'outdoor', 4, 1.5, seed);
    const big = w.getSiteSpawnPoints(def.id, 'indoor', 40, 1.2, seed + 1);
    const out8 = w.getSiteSpawnPoints(def.id, 'outdoor', 8, 1.5, seed + 2);
    const spread = out8.length === 8 ? { d: +out8[0].distanceTo(out8[4]).toFixed(2) } : null;
    /* 실내 후보 전체 (world 내부 캐시 — 시드와 무관한 목록). 고르기가 첫 자리 곁으로 모이므로 돌려준 자리만 보면 한 층만 보인다 —
     * 후보 전체를 같은 기준으로 검사하고 층 수도 거기서 센다. 캐시 이름이 바뀌었으면 돌려준 자리로 대신한다. */
    const cache = ws.siteSpawns?.indoorCache?.get(def.id) ?? null;
    const all = cache ?? big;
    const rs = def.kind === 'wreck' ? null : reachSet(nav);
    const lock = nav.locked;
    const inWallX = (def.kind === 'wreck' ? nav.halfW : nav.halfW - WALL_T / 2) + 0.01;
    const inWallZ = (def.kind === 'wreck' ? nav.halfD : nav.halfD - WALL_T / 2) + 0.01;
    const inBad = [];
    for (const v of [...indoor.pts, ...all]) {
      const [lx, lz] = toL(f, v.x, v.z);
      const why = [];
      if (w.structureAt(v.x, v.z)?.id !== def.id) why.push('structureAt');
      if (!nav.levels.some((lv) => Math.abs(lv - v.y) <= 0.06)) why.push(`level y=${v.y.toFixed(2)}`);
      if (Math.abs(lx) > inWallX || Math.abs(lz) > inWallZ) why.push(`wall ${lx.toFixed(2)},${lz.toFixed(2)}`);
      if (lock && Math.abs(v.y - nav.levels[lock.k]) < 0.1 && lx > lock.x0 && lx < lock.x1 && lz > lock.z0 && lz < lock.z1) why.push('locked');
      const push = pushOf(v);
      if (push >= 0.05) why.push(`push ${push.toFixed(3)}`);
      if (!headroom(v)) why.push('headroom');
      if (rs && !reached(rs, v)) why.push('unreached');
      if (why.length) inBad.push({ at: round(v), why });
    }
    const outBad = [];
    for (const v of outdoor.pts) {
      const [lx, lz] = toL(f, v.x, v.z);
      const why = [];
      const d = Math.hypot(Math.max(0, Math.abs(lx) - nav.halfW), Math.max(0, Math.abs(lz) - nav.halfD));
      if (d < 2.5) why.push(`footprint d=${d.toFixed(2)}`);
      if (Math.abs(v.x) > HALF_MAP || Math.abs(v.z) > HALF_MAP) why.push('bounds');
      const rd = railDist(v.x, v.z);
      if (rd < RAIL_CLEAR - 0.5) why.push(`rail ${rd.toFixed(2)}`);
      const st = w.structureAt(v.x, v.z);
      if (st && st.id !== def.id) why.push(`inside ${st.id}`);
      const push = pushOf(v);
      if (push >= 0.05) why.push(`push ${push.toFixed(3)}`);
      if (!headroom(v)) why.push('headroom');
      if (v.y - w.getHeightAt(v.x, v.z) > 0.4) why.push('lifted');
      if (why.length) outBad.push({ at: round(v), why });
    }
    rows.push({
      kind: def.kind, id: def.id, floors: nav.levels.length, locked: !!lock,
      indoor: indoor.pts.length, outdoor: outdoor.pts.length, big: big.length, msIndoor,
      same: indoor.same && outdoor.same, rebuiltSame: !canReset || rebuiltSame,
      gap: gapOk(indoor.pts, 1.2) && gapOk(outdoor.pts, 1.5) && gapOk(big, 1.2),
      all: all.length, fromCache: !!cache,
      floorsUsed: [...new Set(all.map((v) => nav.levels.findIndex((lv) => Math.abs(lv - v.y) <= 0.06)))].length,
      inBad: inBad.slice(0, 4), inBadN: inBad.length, outBad: outBad.slice(0, 4), outBadN: outBad.length,
    });
  }

  // 선로 플랫폼
  const platRows = [];
  for (const pl of w.getRailLines()[0]?.platforms ?? []) {
    const f = { cx: pl.position.x, cz: pl.position.z, yaw: pl.yaw };
    const indoor = twice(pl.id, 'indoor', 4, 1.2, seed);
    const outdoor = twice(pl.id, 'outdoor', 3, 1.5, seed);
    const bad = [];
    for (const v of indoor.pts) {
      const [lx, lz] = toL(f, v.x, v.z);
      const why = [];
      if (Math.abs(v.y - pl.position.y) > 0.06) why.push(`deck y=${v.y.toFixed(2)} top=${pl.position.y.toFixed(2)}`);
      if (Math.abs(lx) > 7 + 0.01 || Math.abs(lz) > 4.5 + 0.01) why.push(`rect ${lx.toFixed(2)},${lz.toFixed(2)}`);
      const push = pushOf(v);
      if (push >= 0.05) why.push(`push ${push.toFixed(3)}`);
      if (!headroom(v)) why.push('headroom');
      if (why.length) bad.push({ at: round(v), why });
    }
    for (const v of outdoor.pts) {
      const why = [];
      const rd = railDist(v.x, v.z);
      if (rd < RAIL_CLEAR - 0.5) why.push(`rail ${rd.toFixed(2)}`);
      const push = pushOf(v);
      if (push >= 0.05) why.push(`out push ${push.toFixed(3)}`);
      if (why.length) bad.push({ at: round(v), why });
    }
    platRows.push({ id: pl.id, indoor: indoor.pts.length, outdoor: outdoor.pts.length, same: indoor.same && outdoor.same, gap: gapOk(indoor.pts, 1.2), bad });
  }

  // 폐허 전초
  const ruins = w.getRuinSites();
  const ruinRows = [];
  const sites = ws.outposts.getSites();
  for (const r of ruins) {
    const site = sites.find((s) => s.id === r.id);
    const f = { cx: r.position.x, cz: r.position.z, yaw: r.yaw };
    const indoor = twice(r.id, 'indoor', 4, 1.2, seed);
    const outdoor = twice(r.id, 'outdoor', 3, 1.5, seed);
    const bad = [];
    for (const v of indoor.pts) {
      const [lx, lz] = toL(f, v.x, v.z);
      const why = [];
      if (!site || Math.abs(lx) > site.slabHalfX || Math.abs(lz) > site.slabHalfZ) why.push(`slab ${lx.toFixed(2)},${lz.toFixed(2)}`);
      if (Math.hypot(v.x - r.position.x, v.z - r.position.z) > r.radius + 0.01) why.push('radius');
      const push = pushOf(v);
      if (push >= 0.05) why.push(`push ${push.toFixed(3)}`);
      if (!headroom(v)) why.push('headroom');
      if (why.length) bad.push({ at: round(v), why });
    }
    for (const v of outdoor.pts) {
      const push = pushOf(v);
      if (push >= 0.05) bad.push({ at: round(v), why: [`out push ${push.toFixed(3)}`] });
      if (railDist(v.x, v.z) < RAIL_CLEAR - 0.5) bad.push({ at: round(v), why: ['out rail'] });
    }
    ruinRows.push({ id: r.id, indoor: indoor.pts.length, outdoor: outdoor.pts.length, same: indoor.same && outdoor.same, gap: gapOk(indoor.pts, 1.2), bad });
  }

  const misc = {
    unknown: w.getSiteSpawnPoints('struct_nope_9', 'indoor', 3, 1, seed).length === 0 && w.getSiteSpawnPoints('plat_99', 'outdoor', 3, 1, seed).length === 0
      && w.getSiteSpawnPoints('outpost_999', 'indoor', 3, 1, seed).length === 0,
    zeroCount: w.getStructures().length === 0 || w.getSiteSpawnPoints(w.getStructures()[0].id, 'indoor', 0, 1, seed).length === 0,
    ruinIds: ruins.every((r, i) => r.id === `outpost_${i}`),
    obstaclesSame: w.getObstacles().length === obstaclesBefore,
    ms: Math.round(performance.now() - t0),
  };
  return { rows, platRows, ruinRows, misc };
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');

  const seen = { lab: 0, outpost: 0, platform: 0, ruin: 0, twoFloor: 0, locked: 0, wreck: 0 };
  const enough = () => Object.entries(WANT).every(([k, v]) => seen[k] >= v);
  let runs = 0;
  for (const [seed, planet] of RUNS) {
    if (runs >= MAX_RUNS || (runs >= 5 && enough())) break;   // 행성 다섯은 늘 한 번씩 돈다
    runs++;
    await page.evaluate((s, pl) => { const ctx = window.__game.ctx; ctx.missionPlanet = pl; ctx.bus.emit('game:newMission', { seed: s, planet: pl }); }, seed, planet);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(200);
    const res = await page.evaluate(probe, { seed });
    const worldPlanet = await page.evaluate(() => window.__game.ctx.world.planet);
    console.log(`seed ${seed} · ${worldPlanet}: 구조물 ${res.rows.length} · 플랫폼 ${res.platRows.length} · 폐허 ${res.ruinRows.length} · 전체 질의 ${res.misc.ms} ms`);

    for (const r of res.rows) {
      const tag = `seed ${seed} ${r.id}${r.floors === 2 ? ' · 2층' : ''}${r.locked ? ' · 잠긴 방' : ''}`;
      const detail = JSON.stringify(r);
      console.log(`  --   ${tag}: 실내 ${r.indoor} (40 요청 → ${r.big}, 후보 ${r.all}${r.fromCache ? '' : ' (캐시 없음)'}, 층 ${r.floorsUsed}) · 실외 ${r.outdoor} · 첫 실내 질의 ${r.msIndoor} ms`);
      if (r.kind === 'wreck') {
        seen.wreck++;
        ok(r.inBadN === 0, `${tag}: 불시착 함선 실내 자리(${r.big})가 동체 안 · 충돌 없음 · 머리 위 여유`, detail);
        ok(r.outdoor >= 1, `${tag}: 실외 ≥ 1 (${r.outdoor})`, detail);
      } else {
        seen[r.kind]++;
        if (r.floors === 2) seen.twoFloor++;
        if (r.locked) seen.locked++;
        ok(r.indoor >= 1, `${tag}: 실내 ≥ 1 (${r.indoor})`, detail);
        ok(r.outdoor >= 2, `${tag}: 실외 ≥ 2 (${r.outdoor})`, detail);
        ok(r.inBadN === 0, `${tag}: 실내 자리 ${r.indoor + r.big}개 전부 — 그 건물 · 층 바닥 · 벽 안 · 잠긴 방 밖 · 충돌 없음 · 머리 위 여유 · 정문에서 걸어서 닿는다`, detail);
        if (r.floors === 2) ok(r.floorsUsed === 2, `${tag}: 2층 건물은 두 층 모두에 실내 후보가 있다 (후보 ${r.all})`, detail);
      }
      ok(r.outBadN === 0, `${tag}: 실외 자리 — 발자국 밖 · 맵 안 · 선로 회랑 밖 · 다른 구조물 밖 · 충돌 없음 · 땅 위`, detail);
      ok(r.same, `${tag}: 같은 인자 두 번 = 같은 좌표`, detail);
      ok(r.rebuiltSame, `${tag}: 캐시를 비우고 처음부터 다시 계산해도 같은 좌표`, detail);
      if (r.spread) ok(r.spread.d >= 6, `${tag}: 실외 8개 요청 = 두 무리 — 첫 자리와 둘째 무리 첫 자리가 ${r.spread.d} m 떨어져 있다 (≥ 6)`, detail);
      ok(r.gap && r.indoor <= 4 && r.outdoor <= 4, `${tag}: minGap 을 지키고 count 를 넘지 않는다`, detail);
    }
    for (const r of res.platRows) {
      seen.platform++;
      const tag = `seed ${seed} ${r.id}`;
      const detail = JSON.stringify(r);
      ok(r.indoor >= 1 && r.outdoor >= 1, `${tag}: 선로 플랫폼 실내 ${r.indoor} · 실외 ${r.outdoor} (각 ≥ 1)`, detail);
      ok(r.bad.length === 0, `${tag}: 데크 윗면 · 데크 안 · 충돌 없음, 실외는 선로 회랑 밖`, detail);
      ok(r.same && r.gap, `${tag}: 결정적 · minGap`, detail);
    }
    ok(res.ruinRows.length > 0, `seed ${seed}: 폐허 전초가 있다 (${res.ruinRows.length})`);
    for (const r of res.ruinRows) {
      seen.ruin++;
      const tag = `seed ${seed} ${r.id}`;
      const detail = JSON.stringify(r);
      ok(r.indoor >= 1 && r.outdoor >= 1, `${tag}: 폐허 실내 ${r.indoor} · 실외 ${r.outdoor} (각 ≥ 1)`, detail);
      ok(r.bad.length === 0, `${tag}: 바닥판 안 · 반경 안 · 충돌 없음 · 머리 위 여유`, detail);
      ok(r.same && r.gap, `${tag}: 결정적 · minGap`, detail);
    }
    ok(res.misc.unknown && res.misc.zeroCount, `seed ${seed}: 모르는 id · count 0 → []`, JSON.stringify(res.misc));
    ok(res.misc.ruinIds, `seed ${seed}: 폐허 id 는 outpost_<i>`, JSON.stringify(res.misc));
    ok(res.misc.obstaclesSame, `seed ${seed}: 질의가 장애물 목록을 바꾸지 않는다`, JSON.stringify(res.misc));
    ok(res.misc.ms < MAP_MS_MAX, `seed ${seed}: 맵 한 장의 질의 전부 ${res.misc.ms} ms < ${MAP_MS_MAX} ms (검사 flood fill 포함)`, JSON.stringify(res.misc));
  }
  console.log(`runs ${runs}: ${JSON.stringify(seen)}`);
  ok(enough(), `거점 종류가 충분히 나왔다 (원하는 수 ${JSON.stringify(WANT)})`, JSON.stringify(seen));

  // 8. 훈련장 → 빈 답
  await page.evaluate(() => { const ctx = window.__game.ctx; ctx.missionMode = 'training'; ctx.bus.emit('game:newMission', { seed: 5, mode: 'training' }); });
  await waitFor(page, () => window.__game.ctx.world.mode === 'training' && window.__game.ctx.world.ready, 'training world', 30000);
  const training = await page.evaluate(() => {
    const w = window.__game.ctx.world;
    return { ruins: w.getRuinSites().length, pts: w.getSiteSpawnPoints('struct_lab_0', 'indoor', 3, 1, 5).length + w.getSiteSpawnPoints('outpost_0', 'outdoor', 3, 1, 5).length };
  });
  ok(training.ruins === 0 && training.pts === 0, '훈련장: getRuinSites() = [] · getSiteSpawnPoints = []', JSON.stringify(training));
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
