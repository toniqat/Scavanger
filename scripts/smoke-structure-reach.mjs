// 구조물 도달성 스모크 (2026-09-12).
//
// 왜 있나: 사용자 보고 넷 — ① 1층 → 2층 계단 입구가 벽에 막혀 1층에서 못 올라감 ② 계단이 실내가 아니라 바깥으로
// 뚫림 ③ 지하 계단 난간이 1층 문을 막음 ④ 실내 보이지 않는 벽. `smoke-structures` 는 콜라이더가 그린 것 **안에**
// 있는지만 재서 넷 다 못 잡았다 — 전부 "콜라이더는 맞는데 사람이 못 지나간다" 였다. 여기서는 **진짜 월드 질의**
// (`getSurfaceY` 로 발을 올리고 `resolveCollision` 으로 밀어내기 — `player/PlayerController` 와 같은 순서)로 몸 반지름
// 0.45 m 의 flood fill 을 돌려, 사람이 실제로 걸어서 닿는지를 여러 시드 · 건물 종류로 잰다.
//
// 검사 (건물마다):
//   1. 정문 바깥에서 걸어 들어갈 수 있다 (불시착 함선은 후미 램프)
//   2. **건물 밖으로 나가지 않고** (틈 · 창으로 돌아 들어가는 길 금지) 정문 안쪽에서:
//      - 방마다 서 있을 수 있는 칸의 대부분에 닿는다 (1층 · 2층)
//      - 2층 건물: 1층 계단 층계참 → 2층 도착 자리
//      - 옥상 사다리 발치 · 지하실 문 앞 (문은 잠겨 있어도 문 앞까지는 간다)
//      - 지상 컨테이너마다 상호작용 거리 안
//   3. 음성 대조: 걸어서는 옥상에 올라가지 못한다 (flood fill 이 벽 · 천장을 뚫지 않는다는 근거)
//
// 시드를 돌려 전진기지 · 연구실 · 2층 · 지하실 · 불시착 함선이 각각 몇 채 이상 나올 때까지 (최대 MAX_SEEDS).
//
// Usage: node scripts/smoke-structure-reach.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEED_POOL = [21, 7, 1234, 3, 42, 99, 555, 808, 2026, 31337, 11, 64, 777, 4242, 9001, 123, 5150, 6060];
const MAX_SEEDS = 14;
const WANT = { outpost: 4, lab: 4, twoFloor: 4, basement: 4, wreck: 2 };
/** 방 하나에서 서 있을 수 있는 칸 중 닿아야 하는 비율. 벽 · 컨테이너 사이 몸이 안 들어가는 구석은 애초에 칸이 아니다. */
const ROOM_COVERAGE_MIN = 0.85;

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

/** 브라우저 안에서 도는 flood fill. 건물마다 결과 한 줄. */
function reachAll(roomMin) {
  const ctx = window.__game.ctx, w = ctx.world;
  const V3 = ctx.camera.position.constructor;
  const ws = window.__game.getSystem('world');
  const R = 0.45, STEP = 0.3, MARGIN = 4, NODE_CAP = 80000;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const p = new V3();
  const rows = [];

  for (const s of ws.structures.debugNav()) {
    const t0 = performance.now();
    const nav = s.nav;
    const c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
    const toW = (lx, lz) => [nav.cx + lx * c - lz * sn, nav.cz + lx * sn + lz * c];
    const toL = (x, z) => { const dx = x - nav.cx, dz = z - nav.cz; return [dx * c + dz * sn, -dx * sn + dz * c]; };
    // 격자는 시작 자리(정문 바깥 · 후미 램프 너머)까지 품어야 한다 — 불시착 함선의 램프 너머는 halfD + 4 m 보다 멀다
    const I = Math.ceil((Math.max(nav.halfW, Math.abs(nav.doorOut[0])) + MARGIN) / STEP);
    const J = Math.ceil((Math.max(nav.halfD, Math.abs(nav.doorOut[1])) + MARGIN) / STEP);
    const keyOf = (i, j, y) => `${i},${j},${Math.round(y * 2)}`;
    /** 칸 (i, j) 에 발 높이 `feet` 에서 한 걸음 내디뎠을 때 서는 높이, 밀려나면 null. */
    const stand = (i, j, feet) => {
      const [x, z] = toW(i * STEP, j * STEP);
      const y = w.getSurfaceY(x, z, feet);
      p.set(x, y, z);
      w.resolveCollision(p, R);
      return Math.hypot(p.x - x, p.z - z) < 0.02 ? y : null;
    };

    const bfs = (startL, startY, inside) => {
      const seen = new Map();
      const bad = new Set();
      const si = Math.round(startL[0] / STEP), sj = Math.round(startL[1] / STEP);
      const sy = stand(si, sj, startY + 0.3);
      if (sy === null) return { seen, startBlocked: true, capped: false };
      const q = [[si, sj, sy]];
      seen.set(keyOf(si, sj, sy), q[0]);
      const limX = nav.halfW - 0.1, limZ = nav.halfD - 0.1;
      let head = 0;
      while (head < q.length) {
        const [i, j, y] = q[head++];
        for (const [di, dj] of DIRS) {
          const ni = i + di, nj = j + dj;
          if (Math.abs(ni) > I || Math.abs(nj) > J) continue;
          if (inside && (Math.abs(ni * STEP) > limX || Math.abs(nj * STEP) > limZ)) continue;
          const [x, z] = toW(ni * STEP, nj * STEP);
          const ny = w.getSurfaceY(x, z, y);
          const k = keyOf(ni, nj, ny);
          if (seen.has(k) || bad.has(k)) continue;
          p.set(x, ny, z);
          w.resolveCollision(p, R);
          if (Math.hypot(p.x - x, p.z - z) >= 0.02) { bad.add(k); continue; }
          const node = [ni, nj, ny];
          seen.set(k, node);
          q.push(node);
          if (q.length > NODE_CAP) return { seen, startBlocked: false, capped: true };
        }
      }
      return { seen, startBlocked: false, capped: false };
    };
    const near = (seen, lx, lz, y, tol, ytol = 0.35) => {
      let best = Infinity;
      for (const [i, j, yy] of seen.values()) {
        if (Math.abs(yy - y) > ytol) continue;
        const d = Math.hypot(i * STEP - lx, j * STEP - lz);
        if (d < best) best = d;
      }
      return { ok: best <= tol, d: Number.isFinite(best) ? +best.toFixed(2) : null };
    };

    const y0 = nav.levels[0];
    const outside = bfs(nav.doorOut, y0, false);
    const inside = bfs(nav.doorIn, y0, true);
    const row = {
      id: s.id, kind: s.kind, floors: nav.levels.length, basement: !!s.basementDoor, breach: nav.breach,
      outBlocked: outside.startBlocked, inBlocked: inside.startBlocked, capped: outside.capped || inside.capped,
      nodes: inside.seen.size,
      doorIn: near(outside.seen, nav.doorIn[0], nav.doorIn[1], y0, 0.45),
      stairBottom: null, stairTop: null, ladder: null, basementDoor: null,
      containers: { total: 0, reached: 0, missing: [] },
      rooms: [],
      roofWalk: false,
    };
    const set = s.kind === 'wreck' ? outside.seen : inside.seen;

    if (nav.stairBottom) row.stairBottom = near(set, nav.stairBottom[0], nav.stairBottom[1], y0, 0.5);
    if (nav.stairTop) row.stairTop = near(set, nav.stairTop[0], nav.stairTop[1], nav.levels[1], 0.5);
    const lad = w.getLadders().find((l) => l.id.startsWith(`ladder_${s.id}_`));
    if (lad) {
      const [lx, lz] = toL(lad.base.x, lad.base.z);
      row.ladder = near(set, lx, lz, lad.base.y, 0.6);
      // 음성 대조: 옥상 높이의 칸이 하나라도 걸어서 닿았으면 flood fill 이 무언가를 뚫은 것이다
      for (const [, , yy] of outside.seen.values()) if (Math.abs(yy - lad.topY) < 0.3) { row.roofWalk = true; break; }
    }
    if (s.basementDoor) {
      const [lx, lz] = toL(s.basementDoor.x, s.basementDoor.z);
      row.basementDoor = near(set, lx, lz, s.basementDoor.y, 0.6);
    }
    for (const it of ctx.interactables.all()) {
      if (!it.id.startsWith(`container:${s.id}_c`)) continue;
      row.containers.total++;
      const [lx, lz] = toL(it.position.x, it.position.z);
      const r = near(set, lx, lz, it.position.y, 1.5);
      if (r.ok) row.containers.reached++;
      else row.containers.missing.push({ id: it.id.slice(10), d: r.d });
    }
    for (const room of nav.rooms) {
      const level = nav.levels[room.k];
      let clear = 0, got = 0;
      const lost = [];
      for (let i = Math.ceil(room.x0 / STEP); i * STEP <= room.x1; i++) {
        for (let j = Math.ceil(room.z0 / STEP); j * STEP <= room.z1; j++) {
          const y = stand(i, j, level + 0.3);
          if (y === null || Math.abs(y - level) > 0.05) continue;
          clear++;
          if (set.has(keyOf(i, j, y))) got++;
          else if (lost.length < 3) lost.push([+(i * STEP).toFixed(1), +(j * STEP).toFixed(1)]);
        }
      }
      row.rooms.push({ k: room.k, clear, got, cov: clear > 0 ? +(got / clear).toFixed(3) : 1, lost });
    }
    row.ms = Math.round(performance.now() - t0);
    row.roomsOk = row.rooms.every((r) => r.cov >= roomMin);
    rows.push(row);
  }
  return rows;
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

  const seen = { outpost: 0, lab: 0, twoFloor: 0, basement: 0, wreck: 0 };
  const enough = () => Object.entries(WANT).every(([k, v]) => seen[k] >= v);
  let seeds = 0;
  for (const seed of SEED_POOL) {
    if (seeds >= MAX_SEEDS || enough()) break;
    seeds++;
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(300);
    const rows = await page.evaluate(reachAll, ROOM_COVERAGE_MIN);
    console.log(`seed ${seed}: ${rows.length} structures`);
    for (const r of rows) {
      if (r.kind === 'outpost' || r.kind === 'lab') seen[r.kind]++;
      if (r.kind === 'wreck') seen.wreck++;
      if (r.floors === 2) seen.twoFloor++;
      if (r.basement) seen.basement++;
      const tag = `${r.id} (${r.kind}${r.floors === 2 ? ' · 2층' : ''}${r.basement ? ' · 지하실' : ''}${r.breach ? ` · 틈 ${['북', '서', '동'][r.breach.side]}` : ''})`;
      const detail = JSON.stringify({ ...r, rooms: r.rooms.map((x) => `${x.k}:${x.got}/${x.clear}${x.lost.length ? ` ${JSON.stringify(x.lost)}` : ''}`) });
      console.log(`  --   ${tag}: 노드 ${r.nodes} · 방 ${r.rooms.map((x) => `${x.k}F ${Math.round(x.cov * 100)}%`).join(' ')} · 컨테이너 ${r.containers.reached}/${r.containers.total} · ${r.ms} ms`);
      ok(!r.outBlocked && !r.inBlocked && !r.capped, `${tag}: flood fill 시작 자리가 비어 있다`, detail);
      ok(r.doorIn.ok, `${tag}: 바깥에서 ${r.kind === 'wreck' ? '후미 램프로' : '정문으로'} 걸어 들어간다`, detail);
      if (r.kind !== 'wreck') ok(r.roomsOk, `${tag}: 방마다 서 있을 수 있는 칸의 ${Math.round(ROOM_COVERAGE_MIN * 100)}% 이상에 **안에서** 닿는다`, detail);
      if (r.stairBottom) ok(r.stairBottom.ok, `${tag}: 1층 안에서 계단 층계참에 닿는다`, detail);
      if (r.stairTop) ok(r.stairTop.ok, `${tag}: 실내 계단으로 2층에 올라간다`, detail);
      if (r.ladder) ok(r.ladder.ok, `${tag}: 옥상 사다리 발치에 안에서 닿는다`, detail);
      if (r.basementDoor) ok(r.basementDoor.ok, `${tag}: 지하 계단으로 지하실 문 앞까지 내려간다`, detail);
      ok(r.containers.reached === r.containers.total, `${tag}: 지상 컨테이너 ${r.containers.total}개 모두 손이 닿는다`, detail);
      if (r.kind !== 'wreck') ok(!r.roofWalk, `${tag}: (음성 대조) 걸어서는 옥상에 못 올라간다`, detail);
    }
  }
  console.log(`seeds ${seeds}: ${JSON.stringify(seen)}`);
  ok(enough(), `건물 종류가 충분히 나왔다 (원하는 수 ${JSON.stringify(WANT)})`, JSON.stringify(seen));
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
