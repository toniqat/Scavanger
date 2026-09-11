// 버려진 구조물 · 선로 · 전차 스모크 (2026-09-09).
//
// 왜 있나: 이 배치가 world/ 에 **사각(OBB) 콜라이더**(`Obstacle.box`)를 처음 들여왔다. 벽 · 지하실 천장 슬래브 ·
// 플랫폼 데크 · 전차 차체가 전부 상자다. 원기둥 때와 같은 사고 — 콜라이더가 그려진 것보다 커져 보이지 않는
// 벽이 되는 것 (`scripts/smoke-props-collision.mjs` 의 2026-09-09 사건) — 을 **숫자로** 막는다.
//
// 검사:
//   1. 구조물이 시드마다 1개 이상 서고, `structureAt` 이 안/밖을 가른다
//   2. 모든 `box` 콜라이더가 자기 구조물이 **그린 바운딩 박스 안**에 있다 (여유 SLACK_M)
//   3. 실내가 걸어 다닐 수 있다: 방 한가운데는 밀려나지 않고, 벽 한가운데는 밀려난다
//   4. 벽이 총알을 막는다 (`raycast` 가 벽 두께 안에서 멈춘다)
//   5. 지하실 (2026-09-11 개편): 계단 복도 끝의 **서 있는 문**이 잠긴 동안 복도를 막고, 지하실 바닥이 서는 판이다
//   6. 선로: 플랫폼 데크 윗면 = 전차 바닥 높이 (틈 없이 건너탄다), 계단이 한 단씩 `PROP_STEP_UP_MAX` 안이다
//   7. 전차: 시동을 걸면 데크가 움직이고 `getStandingObstacle(...).velocity` 가 `TRAM_SPEED` 를 가리킨다
//      (player/PlayerController 가 그 값을 위치에 더한다 — 실제로 실려 가는지의 근거)
//   8. 호출 콘솔 (2026-09-10): 플랫폼마다 데크 위에 서고, 전차가 선 승강장에서는 잠기고(홀드 0), 반대편에서
//      부르면 **선로 위 거리**가 줄며 다가오고, 운행 중에는 중복 호출 · 운전실 콘솔이 둘 다 거부된다
//   9. (2026-09-11) 천장 · 2층 · 사다리 · 옥상 스캐너 · 경사 계단 · 창문 · 열린 모습 동기화 · 조명 풀 · 스캔 파동
//   0. (2026-09-11, C-38) 발판 동점: 같은 윗면이면 `velocity` 를 든(움직이는) 발판을 삽입 순서와 상관없이 고른다
//  10. (2026-09-11, C-22) 발밑 재질: 구조물 바닥 · 계단 concrete, 불시착 함선 metal, 선로 · 전차 metal, 전차 데크 metal
//  11. (2026-09-11, C-39) 호출 콘솔 소리: 수락 = `tram_call`(콘솔 자리), 거부 = `tram_deny`
//
// Usage: node scripts/smoke-structures.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEEDS = [21, 7, 1234];
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/** 상자 콜라이더가 그려진 실루엣 밖으로 나가도 봐주는 여유(m). */
const SLACK_M = 0.6;

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
/** swiftshader 는 몇 fps 라 실시간을 믿을 수 없다 — 시뮬레이션 시간으로 기다린다. */
async function waitSim(page, seconds) {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${seconds}s`, 120000, t0 + seconds);
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
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs)
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

  for (const seed of SEEDS) {
    console.log(`seed ${seed}`);
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(400);

    /* ── 0. 2026-09-11 (C-38): 발판 동점 — 같은 윗면이면 **움직이는 발판(velocity 보유)** 이 이긴다 ──────
     * 반경 0 질의는 칸 하나를 삽입 순서로 훑는다. 선로 발판이 전차보다 먼저 들어가므로 예전에는 고정 발판이
     * 늘 이겼다. 두 삽입 순서 모두에서, 정지한(0 벡터) 발판도, 창(`PROP_TOP_MARGIN`) 안에서 조금 낮아도
     * 움직이는 쪽이어야 한다. 창 밖(발 높이에서 먼) 발판은 여전히 후보가 아니다. 허공(지형 +200 m)에 세운다. */
    if (seed === SEEDS[0]) {
      const tie = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world;
        const hash = window.__game.getSystem('world').hash;
        const V3 = ctx.camera.position.constructor;
        const sp = w.getPlayerSpawn();
        const x = sp.x, z = sp.z, base = w.getHeightAt(x, z) + 200;
        const run = (movingFirst, movingDrop, fixedLift) => {
          const mk = (kind, lift) => hash.addBox(new V3(x, base + lift, z), 2, 2, 0.3, 1, kind);
          let fixed, moving;
          if (movingFirst) { moving = mk('smoke_moving', -movingDrop); fixed = mk('smoke_fixed', fixedLift); }
          else { fixed = mk('smoke_fixed', fixedLift); moving = mk('smoke_moving', -movingDrop); }
          moving.velocity = new V3(0, 0, 0);
          const got = w.getStandingObstacle(x, z, base + 1);
          hash.remove(fixed); hash.remove(moving);
          return got ? got.kind : null;
        };
        return {
          fixedFirst: run(false, 0, 0),
          movingFirst: run(true, 0, 0),
          movingLower: run(false, 0.1, 0),          // 창(0.15) 안에서 0.1 m 낮아도 움직이는 쪽
          fixedAbove: run(false, 0, 0.1),           // 고정 발판이 0.1 m 높아도 움직이는 쪽
          outOfWindow: run(false, 0.5, 0),          // 움직이는 발판이 창 밖이면 후보가 아니다
        };
      });
      ok(tie.fixedFirst === 'smoke_moving' && tie.movingFirst === 'smoke_moving',
        'C-38: 같은 윗면의 고정 · 움직이는 발판 → 삽입 순서와 상관없이 움직이는 쪽', JSON.stringify(tie));
      ok(tie.movingLower === 'smoke_moving' && tie.fixedAbove === 'smoke_moving',
        'C-38: PROP_TOP_MARGIN 창 안에서는 높이보다 velocity 가 먼저', JSON.stringify(tie));
      ok(tie.outOfWindow === 'smoke_fixed', 'C-38: 창 밖의 움직이는 발판은 고르지 않는다', JSON.stringify(tie));
    }

    /* ── 1 · 2. 구조물이 서고, 상자 콜라이더가 그려진 것 안에 있다 ─────────── */
    const r = await page.evaluate((slack) => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const V3 = ctx.camera.position.constructor;
      const structs = world.getStructures().map((s) => ({
        id: s.id, kind: s.kind, x: s.position.x, y: s.position.y, z: s.position.z,
        radius: s.radius, hasBasement: s.hasBasement,
        door: s.basementDoor ? { x: s.basementDoor.x, y: s.basementDoor.y, z: s.basementDoor.z } : null,
        yaw: s.yaw,
      }));

      // 그려진 바운딩 박스: 이름이 구조물 id 로 시작하는 메시들(본체 · 글로우 · 콘솔 · 해치)의 합
      const drawn = new Map();
      const v = new V3();
      ctx.scene.traverse((n) => {
        if (!n.isMesh || !n.name) return;
        const owner = structs.find((s) => n.name.startsWith(s.id))?.id
          ?? (n.name.startsWith('rail_') || n.name === 'tram' ? 'rail' : null);
        if (!owner) return;
        n.updateWorldMatrix(true, false);
        const pos = n.geometry.getAttribute('position');
        if (!pos) return;
        let b = drawn.get(owner);
        if (!b) { b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: -Infinity }; drawn.set(owner, b); }
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(n.matrixWorld);
          if (v.x < b.minX) b.minX = v.x; if (v.x > b.maxX) b.maxX = v.x;
          if (v.z < b.minZ) b.minZ = v.z; if (v.z > b.maxZ) b.maxZ = v.z;
          if (v.y > b.maxY) b.maxY = v.y;
        }
      });

      // 상자 콜라이더 하나하나를 그 소유자의 바운딩 박스와 견준다
      let boxes = 0, worst = -Infinity, worstRow = null;
      for (const o of world.getObstacles()) {
        if (!o.box) continue;
        boxes++;
        const owner = ['building', 'slab', 'hatch', 'console', 'door', 'glass'].includes(o.kind)
          ? structs.find((s) => Math.hypot(s.x - o.position.x, s.z - o.position.z) < s.radius + 12)?.id
          : 'rail';
        const b = owner ? drawn.get(owner) : null;
        if (!b) continue;
        const c = Math.cos(o.box.yaw), sn = Math.sin(o.box.yaw);
        let over = -Infinity;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const lx = sx * o.box.halfX, lz = sz * o.box.halfZ;
          const wx = o.position.x + lx * c - lz * sn, wz = o.position.z + lx * sn + lz * c;
          over = Math.max(over, b.minX - wx, wx - b.maxX, b.minZ - wz, wz - b.maxZ);
        }
        if (over > worst) { worst = over; worstRow = { kind: o.kind, owner, over: +over.toFixed(2) }; }
      }

      // 원기둥 소품은 그대로여야 한다 (box 가 없는 항목이 여전히 대다수)
      const cylinders = world.getObstacles().filter((o) => !o.box).length;
      return { structs, boxes, cylinders, worst, worstRow, slack };
    }, SLACK_M);

    ok(r.structs.length >= 1, `structures placed (${r.structs.length}: ${r.structs.map((s) => s.kind).join(', ')})`);
    ok(r.boxes > 0, `box colliders registered (${r.boxes})`);
    ok(r.cylinders > 200, `cylinder props untouched (${r.cylinders})`);
    ok(r.worst <= SLACK_M, `no box collider reaches outside what its structure draws (worst +${r.worst.toFixed(2)} m)`, JSON.stringify(r.worstRow));

    /* ── 3 · 4 · 5. 실내 이동 · 엄폐 · 지하실 ───────────────────────────── */
    const inside = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const V3 = ctx.camera.position.constructor;
      const s = world.getStructures()[0];
      if (!s) return null;
      const y = world.getSurfaceY(s.position.x, s.position.z, s.position.y + 0.5);

      // 1층 바닥의 대부분에서 밀려나지 않아야 한다 — 벽 · 계단 · 난간이 방을 통째로 막으면 여기서 잡힌다.
      // (2026-09-11: 한가운데 한 점만 보던 검사를 격자로 바꿨다 — 계단 구멍 · 소품이 한가운데에 설 수 있다.)
      let onFloor = 0, free = 0;
      const R = Math.max(2, s.radius - 6);
      for (let gx = -R; gx <= R; gx += 1.0) for (let gz = -R; gz <= R; gz += 1.0) {
        if (gx * gx + gz * gz > R * R) continue;
        const x = s.position.x + gx, z = s.position.z + gz;
        const sy = world.getSurfaceY(x, z, s.position.y + 0.3);
        if (Math.abs(sy - s.position.y) > 0.05) continue;
        onFloor++;
        const q = new V3(x, sy, z);
        world.resolveCollision(q, 0.4);
        if (Math.hypot(q.x - x, q.z - z) < 0.01) free++;
      }
      const centreMove = onFloor > 0 ? 1 - free / onFloor : 1;

      // 바깥 벽을 향해 쏜다 — 반드시 무언가에 막혀야 한다
      let blocked = 0, tries = 0;
      const o = new V3(s.position.x, y + 1.2, s.position.z), d = new V3();
      for (let a = 0; a < 8; a++) {
        d.set(Math.cos((a / 8) * Math.PI * 2), 0, Math.sin((a / 8) * Math.PI * 2));
        tries++;
        const hit = world.raycast(o, d, s.radius + 6);
        if (hit && hit.distance < s.radius + 2) blocked++;
      }

      // 지하실이 있으면 (2026-09-11): 잠긴 문짝이 복도를 막고, 문 앞 지하실 바닥이 서는 판이며, 1층보다 3 m 넘게 아래다
      let hatchTop = null, basementDrop = null, doorBlocks = null;
      const withBase = world.getStructures().find((x) => x.hasBasement);
      if (withBase && withBase.basementDoor) {
        const dpos = withBase.basementDoor;
        hatchTop = world.getSurfaceY(dpos.x, dpos.z, dpos.y + 0.5) - dpos.y;   // 지하실 바닥 = 문 밑변 높이
        basementDrop = withBase.position.y - dpos.y;
        const door = world.getObstacles().find((o) => o.kind === 'door' && Math.hypot(o.position.x - dpos.x, o.position.z - dpos.z) < 0.2);
        if (door) {
          const p = new V3(dpos.x, dpos.y, dpos.z);
          world.resolveCollision(p, 0.45);
          doorBlocks = Math.hypot(p.x - dpos.x, p.z - dpos.z);
        } else doorBlocks = -1;
      }
      return { centreMove, blocked, tries, hatchTop, basementDrop, doorBlocks, structs: world.getStructures().length };
    });

    if (inside) {
      ok(inside.centreMove < 0.4, `most of a structure's ground floor is standable (${((1 - inside.centreMove) * 100).toFixed(0)} % free)`);
      ok(inside.blocked >= 6, `walls stop shots from inside (${inside.blocked}/${inside.tries} directions blocked)`);
      if (inside.hatchTop !== null) {
        ok(Math.abs(inside.hatchTop) < 0.2, `basement floor in front of the door is a standing plate (Δ ${inside.hatchTop.toFixed(2)} m)`);
        ok(inside.basementDrop > 3, `the basement is a storey below the ground floor (${inside.basementDrop.toFixed(1)} m)`);
        ok(inside.doorBlocks > 0.2, `the locked standing door blocks the stair corridor (pushed ${inside.doorBlocks.toFixed(2)} m)`);
      } else {
        console.log('  --   no basement this seed (basementChance)');
      }
    }


    /* ── 10. 2026-09-11 (C-22): 발밑 재질 — 구조물 바닥 concrete · 불시착 함선 metal · 선로 metal ────────── */
    const surf = await page.evaluate(() => {
      const w = window.__game.ctx.world;
      const out = { floors: {}, wreck: {}, rail: {}, stair: {} };
      const bump = (t, m) => { t[m] = (t[m] ?? 0) + 1; };
      for (const s of w.getStructures()) {
        const R = Math.max(2, s.radius - 6);
        for (let gx = -R; gx <= R; gx += 1.5) for (let gz = -R; gz <= R; gz += 1.5) {
          const x = s.position.x + gx, z = s.position.z + gz;
          const sy = w.getSurfaceY(x, z, s.position.y + 0.3);
          if (Math.abs(sy - s.position.y) > 0.05) continue;
          const st = w.getStandingObstacle(x, z, sy);
          if (!st || (st.kind !== 'slab' && st.kind !== 'building')) continue;   // 컨테이너 · 문 윗면 등은 뺀다
          bump(s.kind === 'wreck' ? out.wreck : out.floors, w.getSurfaceMaterial(x, z, sy));
        }
      }
      for (const o of w.getObstacles()) {
        if (!o.ramp || o.kind !== 'slab') continue;
        const top = w.getSurfaceY(o.position.x, o.position.z, o.position.y + o.height);
        bump(out.stair, w.getSurfaceMaterial(o.position.x, o.position.z, top));
      }
      const line = w.getRailLines()[0];
      if (line) {
        for (let i = 0; i < line.points.length; i += Math.max(1, Math.floor(line.points.length / 12))) {
          const p = line.points[i];
          const top = w.getSurfaceY(p.x, p.z);
          const st = w.getStandingObstacle(p.x, p.z, top);
          if (st && (st.kind === 'rail' || st.kind === 'tram')) bump(out.rail, w.getSurfaceMaterial(p.x, p.z, top));
        }
      }
      return out;
    });
    const only = (t, m) => Object.keys(t).length === 0 || (Object.keys(t).length === 1 && t[m] > 0);
    ok(Object.keys(surf.floors).length > 0 && only(surf.floors, 'concrete'), `C-22: 전진기지 · 연구실 바닥 → concrete`, JSON.stringify(surf.floors));
    ok(only(surf.stair, 'concrete'), `C-22: 구조물 계단(경사면) → concrete`, JSON.stringify(surf.stair));
    ok(only(surf.wreck, 'metal'), `C-22: 불시착 함선 데크 → metal (${JSON.stringify(surf.wreck)})`);
    ok(only(surf.rail, 'metal'), `C-22: 선로 발판 · 전차 → metal (${JSON.stringify(surf.rail)})`);

    /* ── 9. 2026-09-11: 천장 · 2층 · 사다리 · 옥상 스캐너 · 경사 계단 · 창문 · 동기화 · 조명 · 파동 ─────────── */
    const b = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const ws = window.__game.getSystem('world');
      const st = ws.structures;
      const V3 = ctx.camera.position.constructor;
      const rows = [];
      for (const s of world.getStructures()) {
        if (s.kind === 'wreck') continue;
        const lad = world.getLadders().filter((l) => l.id.startsWith(`ladder_${s.id}_`));
        const scan = ctx.interactables.all().find((i) => i.id === `struct:${s.id}:scan`);
        const l = lad[0];
        rows.push({
          id: s.id, ladders: lad.length,
          storeys: l ? Math.round((l.topY - s.position.y) / 4.1) : 0,
          roofStand: l ? +(world.getSurfaceY(l.exit.x, l.exit.z, l.exit.y + 0.5) - l.exit.y).toFixed(2) : null,
          baseStand: l ? +(world.getSurfaceY(l.base.x, l.base.z, l.base.y + 0.5) - l.base.y).toFixed(2) : null,
          scanOnRoof: !!scan && !!l && Math.abs(scan.position.y - l.topY) < 0.05,
          // 1층 한가운데서 위로 쏘면 천장(바닥판 밑면)에 맞는다
          ceil: (() => { const h = world.raycast(new V3(s.position.x, s.position.y + 1.2, s.position.z), new V3(0, 1, 0), 10); return h ? +(h.point.y - s.position.y).toFixed(2) : null; })(),
        });
      }
      const wreckScan = world.getStructures().filter((s) => s.kind === 'wreck').some((s) => ctx.interactables.all().some((i) => i.id === `struct:${s.id}:scan`));

      // 경사 계단: 낮은 끝 → 높은 끝을 0.1 m 씩 훑은 표면 높이의 가장 큰 한 걸음
      let ramps = 0, worstStep = 0, worstEnd = 0;
      for (const o of world.getObstacles()) {
        if (!o.ramp || !o.box) continue;
        ramps++;
        const c = Math.cos(o.box.yaw), sn = Math.sin(o.box.yaw);
        let prev = null;
        for (let lx = -o.box.halfX + 0.05; lx <= o.box.halfX - 0.05; lx += 0.1) {
          const x = o.position.x + lx * c, z = o.position.z + lx * sn;
          const y = world.getSurfaceY(x, z, prev === null ? o.position.y + o.height - o.ramp.rise + 0.1 : prev + 0.1);
          if (prev !== null) worstStep = Math.max(worstStep, y - prev);
          prev = y;
        }
        const hx = o.position.x + o.box.halfX * c, hz = o.position.z + o.box.halfX * sn;
        worstEnd = Math.max(worstEnd, Math.abs(world.getSurfaceY(hx, hz, o.position.y + o.height + 0.3) - (o.position.y + o.height)));
      }

      // 창문: 레이가 유리에 맞고, 깨면 레이는 지나가며, 사람 크기 몸은 여전히 막히고 수류탄 크기는 지나간다
      const glass = st.glassSet;
      let win = { count: glass.count, hit: false, passAfter: false, bodyBlocked: false, smallPasses: false, broken: 0 };
      const pane = world.getObstacles().find((o) => o.kind === 'glass' && o.fragile);
      if (pane) {
        const c = Math.cos(pane.box.yaw), sn = Math.sin(pane.box.yaw);
        const nx = -sn, nz = c;                                  // 창 면의 법선
        const mid = new V3(pane.position.x, pane.position.y + pane.height / 2, pane.position.z);
        const from = new V3(mid.x + nx * 3, mid.y, mid.z + nz * 3);
        const dir = new V3(-nx, 0, -nz);
        const h1 = world.raycast(from, dir, 5);
        win.hit = !!h1 && h1.obstacle === pane;
        if (h1 && h1.obstacle && h1.obstacle.destructible) h1.obstacle.destructible.onDamage(10, h1.point);
        const h2 = world.raycast(from, dir, 5);
        win.passAfter = !h2 || h2.obstacle !== pane;
        const body = new V3(mid.x, pane.position.y + 0.1, mid.z);
        world.resolveCollision(body, 0.45);
        win.bodyBlocked = Math.hypot(body.x - mid.x, body.z - mid.z) > 0.1;
        const small = new V3(mid.x, mid.y, mid.z);
        world.resolveCollision(small, 0.08);
        win.smallPasses = Math.hypot(small.x - mid.x, small.z - mid.z) < 0.01;
        win.broken = glass.brokenCount;
      }

      // 열린 모습: 컨테이너 하나를 남이 연 것처럼 표시
      const cont = ctx.interactables.all().find((i) => i.id.startsWith('container:struct_'));
      const cid = cont ? cont.id.slice('container:'.length) : null;
      const markOk = cid ? st.markContainerOpened(cid) && st.isContainerOpened(cid) : false;

      // 조명 풀
      const pool = st.lights;
      return { rows, wreckScan, ramps, worstStep, worstEnd, win, markOk, pool: pool ? { size: pool.size, fixtures: pool.fixtureList.length } : null };
    });
    ok(b.rows.length >= 1 && b.rows.every((r) => r.ladders >= 1), `전진기지 · 연구실마다 옥상 사다리가 있다 (${b.rows.map((r) => `${r.id}:${r.storeys}층`).join(', ')})`, JSON.stringify(b.rows));
    ok(b.rows.every((r) => r.roofStand !== null && Math.abs(r.roofStand) < 0.1), '사다리 꼭대기의 내리는 자리가 옥상 바닥이다', JSON.stringify(b.rows.map((r) => r.roofStand)));
    ok(b.rows.every((r) => r.baseStand !== null && Math.abs(r.baseStand) < 0.1), '사다리 발치가 맨 위층 바닥이다', JSON.stringify(b.rows.map((r) => r.baseStand)));
    ok(b.rows.every((r) => r.scanOnRoof), '맵 스캐너가 옥상에 있다', JSON.stringify(b.rows.map((r) => r.scanOnRoof)));
    ok(!b.wreckScan, '불시착 함선에는 스캐너가 없다');
    ok(b.rows.every((r) => r.ceil !== null && r.ceil > 3 && r.ceil < 4.5), `1층에 천장이 있다 (천장 높이 ${b.rows.map((r) => r.ceil).join(', ')} m)`);
    ok(b.ramps >= 1 && b.worstStep < 0.12, `계단이 경사면이라 한 걸음(0.1 m)에 튀지 않는다 (경사 ${b.ramps}개, 최대 ${b.worstStep.toFixed(3)} m)`);
    ok(b.worstEnd < 0.1, `계단 높은 끝이 위층 바닥과 이어진다 (Δ ${b.worstEnd.toFixed(3)} m)`);
    ok(b.win.count > 0 && b.win.hit, `창문 유리가 레이를 막는다 (창 ${b.win.count}장)`, JSON.stringify(b.win));
    ok(b.win.passAfter && b.win.broken >= 1, '깨진 창은 총알이 지나간다', JSON.stringify(b.win));
    ok(b.win.bodyBlocked && b.win.smallPasses, '깨진 창은 몸은 막고 투척물은 지나간다', JSON.stringify(b.win));
    ok(b.markOk, '남이 연 컨테이너가 열린 모습이 된다');
    ok(!!b.pool && b.pool.size === 4 && b.pool.fixtures > 0, `구조물 조명 풀 (${b.pool && b.pool.size}개 광원 · 자리 ${b.pool && b.pool.fixtures})`);

    // 스캔 파동: 옥상 콘솔을 누르면 파동이 퍼진다
    const wave = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const st = window.__game.getSystem('world').structures;
      const s = ctx.world.getStructures().find((x) => x.kind !== 'wreck');
      const c = s && ctx.interactables.all().find((i) => i.id === `struct:${s.id}:scan`);
      if (!c) return null;
      c.interact();
      return { active: st.scanWaves.activeCount, scanned: s.scanned };
    });
    ok(!!wave && wave.scanned && wave.active >= 1, '맵 스캔이 파동을 쏜다', JSON.stringify(wave));
    await waitSim(page, 7);
    const waveEnd = await page.evaluate(() => window.__game.getSystem('world').structures.scanWaves.activeCount);
    ok(waveEnd === 0, `파동이 STRUCTURE_SCAN_WAVE_S 뒤에 끝난다 (남은 ${waveEnd})`);

    /* ── 6 · 7. 선로 · 플랫폼 · 전차 ─────────────────────────────────── */
    const rail = await page.evaluate(() => {
      const world = window.__game.ctx.world;
      const lines = world.getRailLines();
      if (lines.length === 0) return null;
      const line = lines[0];
      const tram = world.getTrams()[0] ?? null;
      const plat = line.platforms[0];
      const deckTop = world.getSurfaceY(plat.position.x, plat.position.z, plat.position.y + 0.5);
      return {
        kind: line.kind, length: line.length, platforms: line.platforms.length,
        deckDelta: deckTop - plat.position.y,
        tram: tram ? { id: tram.id, s: tram.s, state: tram.state, y: tram.position.y } : null,
        platY: plat.position.y,
      };
    });

    if (!rail) {
      console.log('  --   no rail line this seed (RAIL_CHANCE)');
    } else {
      ok(rail.platforms >= 2, `rail has platforms (${rail.kind}, ${rail.platforms}, ${rail.length.toFixed(0)} m)`);
      ok(Math.abs(rail.deckDelta) < 0.2, `platform deck top is standable at its own height (Δ ${rail.deckDelta.toFixed(2)} m)`);
      ok(rail.tram !== null && rail.tram.state === 'idle', 'the tram waits until a console starts it');

      /* 2026-09-10 — 선로 자체가 **발판**이고 지형 위로 떠 있어야 한다.
       * `getSurfaceY`(발 높이 제한 없이)가 중심선 위에서 레일 상면을 돌려주면 콜라이더가 걸린 것이고,
       * 그 높이가 지형보다 확실히 위면 파묻히지 않은 것이다. */
      const deck = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const line = w.getRailLines()[0];
        const step = Math.max(1, Math.floor(line.points.length / 12));
        const out = [];
        for (let i = 0; i < line.points.length; i += step) {
          const p = line.points[i];
          const ground = w.getHeightAt(p.x, p.z);
          out.push({ deck: +(w.getSurfaceY(p.x, p.z) - ground).toFixed(2), clear: +(p.y - ground).toFixed(2) });
        }
        return out;
      });
      ok(deck.every((d) => d.deck >= d.clear - 0.35), `선로 위에 발판 콜라이더가 있다 (표본 ${deck.length}곳)`, JSON.stringify(deck));
      ok(deck.every((d) => d.clear > 0.4), '선로가 지형에 파묻히지 않는다', JSON.stringify(deck.map((d) => d.clear)));

      /* 2026-09-10 — **차체는 선로 방향으로 길쭉하다.** 바닥 콜라이더의 상자 반길이(로컬 +X = 접선)가
       * 반폭(로컬 +Z)보다 커야 한다. 예전에는 정확히 반대여서 선로와 수직인 판때기가 달려 있었다. */
      const body = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const t = w.getTrams()[0];
        // 바닥판 = `velocity` 를 든 상자 중 단면이 가장 큰 것. `getStandingObstacle` 로 찍으면 전차 옆의
        // 선로 발판과 동점이 날 수 있어(높이가 같다) 검사가 흔들린다 — 콜라이더 목록에서 곧장 고른다.
        let floor = null;
        for (const o of w.getObstacles()) {
          if (o.kind !== 'tram' || !o.box || !o.velocity) continue;
          if (!floor || o.box.halfX * o.box.halfZ > floor.box.halfX * floor.box.halfZ) floor = o;
        }
        const con = window.__game.ctx.interactables.all().find((i) => i.id === 'rail:tram_rail_0:console');
        if (!floor) return { halfX: 0, halfZ: 0, console: null, ride: false };
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const dx = con ? con.position.x - t.position.x : 0, dz = con ? con.position.z - t.position.z : 0;
        const st = w.getStandingObstacle(t.position.x, t.position.z, t.position.y);
        return {
          halfX: floor.box.halfX, halfZ: floor.box.halfZ,
          console: con ? { lx: dx * c + dz * s, lz: -dx * s + dz * c } : null,
          ride: !!(st && st.velocity),
        };
      });
      ok(body.ride, '전차 바닥에 서면 탑승 발판(velocity)이 잡힌다 — 옆 선로 발판에 밀리지 않는다');
      ok(body.halfX > body.halfZ * 1.5, `차체가 선로 방향으로 길쭉하다 (반길이 ${body.halfX.toFixed(1)} m · 반폭 ${body.halfZ.toFixed(1)} m)`);
      ok(!!body.console && Math.abs(body.console.lx) < body.halfX && Math.abs(body.console.lz) < body.halfZ,
        '시동 콘솔이 전차 차체 **안**에 있다', JSON.stringify(body.console));

      /* 2026-09-10 — **플랫폼 계단은 한 단이 `PROP_STEP_UP_MAX`(0.9) 안**이라야 걸어 올라간다.
       * 데크 바깥으로 나가는 축을 훑으며 표면 높이의 최대 상승폭을 잰다. */
      const stairs = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const plat = w.getRailLines()[0].platforms[0];
        const ax = -Math.sin(plat.yaw), az = Math.cos(plat.yaw);
        const ys = [];
        for (let off = 16; off >= 2.5; off -= 0.1) {
          ys.push(w.getSurfaceY(plat.position.x + ax * off, plat.position.z + az * off));
        }
        let worst = 0;
        for (let i = 1; i < ys.length; i++) worst = Math.max(worst, ys[i] - ys[i - 1]);
        return { worst: +worst.toFixed(3), top: ys[ys.length - 1], deck: plat.position.y };
      });
      ok(stairs.worst <= 0.9 + 1e-3, `플랫폼 계단 한 단이 PROP_STEP_UP_MAX 안이다 (최대 ${stairs.worst.toFixed(2)} m)`);
      ok(Math.abs(stairs.top - stairs.deck) < 0.25, `계단이 데크 상판으로 이어진다 (Δ ${(stairs.top - stairs.deck).toFixed(2)} m)`);

      /* 2026-09-10 (두 번째) — **플랫폼 호출 콘솔**.
       * 시동이 운전실로 들어간 뒤 플랫폼에서 전차를 부르는 유일한 수단이다. 상태는 `canInteract` 가 아니라
       * **프롬프트 + 홀드 시간**으로 드러나야 한다 (부를 수 없으면 홀드 0 = 눌러 보면 즉시 거부).
       * `canInteract` 를 내리면 `findBest` 가 통째로 걸러 프롬프트조차 안 뜬다. */
      /* 전차가 부른 승강장 쪽으로 오는지는 **선로 위 거리**로 재야 한다 — 순환 선로에서 반대편 플랫폼은
       * 지름의 양 끝이라 XZ 직선거리는 40 m 를 달려도 2 m 밖에 줄지 않는다. 아래 두 함수는 `rails/model`
       * 의 `nearestS` · `deltaS` 를 **스모크가 독립적으로 다시 구현한 것**이다 (같은 코드를 부르지 않는다). */
      const callIdle = await page.evaluate(() => {
        const railS = (line, x, z) => {
          const segs = line.kind === 'loop' ? line.points.length : line.points.length - 1;
          let cum = 0, bestS = 0, bestD = Infinity;
          for (let i = 0; i < segs; i++) {
            const a = line.points[i], b = line.points[(i + 1) % line.points.length];
            const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz), len2 = dx * dx + dz * dz;
            const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
            const px = a.x + dx * t, pz = a.z + dz * t;
            const d = (px - x) * (px - x) + (pz - z) * (pz - z);
            if (d < bestD) { bestD = d; bestS = cum + len * t; }
            cum += len;
          }
          return bestS;
        };
        const gapS = (line, from, to) => {
          let d = to - from;
          if (line.kind === 'loop') { const h = line.length / 2; while (d > h) d -= line.length; while (d < -h) d += line.length; }
          return Math.abs(d);
        };
        const ctx = window.__game.ctx, w = ctx.world;
        const line = w.getRailLines()[0], t = w.getTrams()[0];
        const cab = ctx.interactables.all().find((x) => x.id === 'rail:tram_rail_0:console');
        return {
          cons: line.platforms.map((p) => {
            const i = ctx.interactables.all().find((x) => x.id === `rail:${p.id}:call`);
            return {
              id: p.id, found: !!i,
              onDeck: i ? Math.hypot(i.position.x - p.position.x, i.position.z - p.position.z) <= p.radius : false,
              prompt: i ? i.getPrompt() : null, hold: i ? (i.holdTime ?? 0) : -1, can: i ? i.canInteract() : false,
              gap: +gapS(line, t.s, railS(line, p.position.x, p.position.z)).toFixed(1),
            };
          }),
          cab: cab ? { prompt: cab.getPrompt(), hold: cab.holdTime ?? 0, can: cab.canInteract() } : null,
        };
      });
      ok(callIdle.cons.length >= 2 && callIdle.cons.every((c) => c.found && c.onDeck && c.can),
        `플랫폼마다 호출 콘솔이 데크 위에 있다 (${callIdle.cons.length}개)`, JSON.stringify(callIdle.cons));
      const here = callIdle.cons.reduce((a, b) => (a.gap <= b.gap ? a : b));
      const far = callIdle.cons.reduce((a, b) => (a.gap >= b.gap ? a : b));
      ok(here.hold === 0 && /대기/.test(here.prompt ?? ''),
        `전차가 선 승강장에서는 호출이 잠긴다 (${here.prompt})`, JSON.stringify(here));
      ok(far.hold > 0 && /호출/.test(far.prompt ?? ''),
        `반대편 승강장에서는 부를 수 있다 (${far.prompt} · 홀드 ${far.hold}s · ${far.gap} m)`, JSON.stringify(far));
      ok(!!callIdle.cab && callIdle.cab.can && callIdle.cab.hold > 0,
        `정차 중에는 운전실 콘솔이 눌린다 (${callIdle.cab?.prompt})`, JSON.stringify(callIdle.cab));

      // 부른다 → 기존 출발 절차 그대로 (알림 → 1초 대기 → 3초 가속) 이므로 5.5초 뒤에 재본다.
      // 2026-09-11 (C-39): 수락되면 부른 콘솔 자리에서 `tram_call` 이 이 클라이언트에 울린다.
      const callSnd = await page.evaluate((id) => {
        const ctx = window.__game.ctx;
        const snd = [];
        const off = ctx.bus.on('audio:play', (p) => { if (/^tram_|keycard_deny/.test(p.id)) snd.push({ id: p.id, p: p.position ? [p.position.x, p.position.z] : null }); });
        const con = ctx.interactables.all().find((i) => i.id === `rail:${id}:call`);
        con?.interact();
        off();
        return { snd, at: con ? [con.position.x, con.position.z] : null };
      }, far.id);
      const chime = callSnd.snd.find((s) => s.id === 'tram_call');
      ok(!!chime && !!chime.p && !!callSnd.at && Math.hypot(chime.p[0] - callSnd.at[0], chime.p[1] - callSnd.at[1]) < 0.5,
        'C-39: 호출이 수락되면 부른 콘솔 자리에서 tram_call 차임', JSON.stringify(callSnd));
      await waitSim(page, 5.5);
      const called = await page.evaluate((farId) => {
        const railS = (line, x, z) => {
          const segs = line.kind === 'loop' ? line.points.length : line.points.length - 1;
          let cum = 0, bestS = 0, bestD = Infinity;
          for (let i = 0; i < segs; i++) {
            const a = line.points[i], b = line.points[(i + 1) % line.points.length];
            const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz), len2 = dx * dx + dz * dz;
            const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
            const px = a.x + dx * t, pz = a.z + dz * t;
            const d = (px - x) * (px - x) + (pz - z) * (pz - z);
            if (d < bestD) { bestD = d; bestS = cum + len * t; }
            cum += len;
          }
          return bestS;
        };
        const gapS = (line, from, to) => {
          let d = to - from;
          if (line.kind === 'loop') { const h = line.length / 2; while (d > h) d -= line.length; while (d < -h) d += line.length; }
          return Math.abs(d);
        };
        const ctx = window.__game.ctx, w = ctx.world;
        const line = w.getRailLines()[0], t = w.getTrams()[0];
        const p = line.platforms.find((q) => q.id === farId);
        const cab = ctx.interactables.all().find((x) => x.id === 'rail:tram_rail_0:console');
        return {
          state: t.state, s: t.s,
          gap: +gapS(line, t.s, railS(line, p.position.x, p.position.z)).toFixed(1),
          cons: line.platforms.map((q) => {
            const i = ctx.interactables.all().find((x) => x.id === `rail:${q.id}:call`);
            return { id: q.id, hold: i ? (i.holdTime ?? 0) : -1, prompt: i ? i.getPrompt() : null };
          }),
          cabCan: cab ? cab.canInteract() : true,
        };
      }, far.id);
      ok(called.state === 'moving', `호출로 전차가 출발한다 (${called.state})`);
      ok(called.gap < far.gap - 20, `부른 승강장 쪽으로 다가온다 (${far.gap} → ${called.gap} m)`);
      ok(called.cons.every((c) => c.hold === 0 && /운행/.test(c.prompt ?? '')),
        '운행 중에는 중복 호출이 거부된다 (홀드 0 + 이유가 적힌 프롬프트)', JSON.stringify(called.cons));
      ok(!called.cabCan, '운행 중에는 운전실 콘솔도 잠긴다');
      // 2026-09-11 (C-39): 운행 중 호출 = 거부 전용음 `tram_deny` (예전에는 지하실 카드 리더기의 `keycard_deny`)
      const denySnd = await page.evaluate((id) => {
        const ctx = window.__game.ctx;
        const snd = [];
        const off = ctx.bus.on('audio:play', (p) => { if (/^tram_|keycard_deny/.test(p.id)) snd.push(p.id); });
        ctx.interactables.all().find((i) => i.id === `rail:${id}:call`)?.interact();
        off();
        return snd;
      }, far.id);
      ok(denySnd.includes('tram_deny') && !denySnd.includes('keycard_deny') && !denySnd.includes('tram_call'),
        'C-39: 부를 수 없을 때는 tram_deny 만 울린다', JSON.stringify(denySnd));

      // 달리는 동안 데크가 발판 속도를 들고 있는지 — 콘솔은 **전차 안**에 있다 (2026-09-10).
      // 전차는 위의 **호출**로 이미 달리고 있으므로 이 누름은 (설계대로) 아무 일도 하지 않는다.
      await page.evaluate(() => {
        window.__game.ctx.interactables.all().find((i) => i.id === 'rail:tram_rail_0:console')?.interact();
      });
      // 2026-09-10: 출발은 알림 뒤 `TRAM_START_DELAY_S`(1초) 대기 + `TRAM_ACCEL_S`(3초) cubic 가속이다 —
      // 예전처럼 2초만 기다리면 아직 1 m/s 도 안 나온다. 최고 속도까지 간 뒤에 잰다.
      await waitSim(page, 5.5);
      const riding = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const t = w.getTrams()[0];
        const st = w.getStandingObstacle(t.position.x, t.position.z, t.position.y);
        return {
          state: t.state, s: t.s,
          hasDeck: !!st,
          speed: st && st.velocity ? Math.hypot(st.velocity.x, st.velocity.z) : 0,
          deckTop: w.getSurfaceY(t.position.x, t.position.z, t.position.y + 0.5) - t.position.y,
          material: w.getSurfaceMaterial(t.position.x, t.position.z, t.position.y),
        };
      });
      ok(riding.material === 'metal', `C-22: 달리는 전차 데크 → metal (${riding.material})`);

      /* 2026-09-11 (C-18): 달리는 전차는 **적 · 끊긴 분대원도 친다** (권위 = 이 싱글 페이지). 적 둘을 차체 한가운데에
         세운다 — 하나는 발이 데크 윗면 − 1.0 m(선로 옆 땅 = 치인다), 하나는 데크 위(탑승자 = 안 치인다). AI 가 한
         프레임 움직이기 전에 `rails.update` 를 직접 한 번 돌려 판정만 본다. 고스트는 `net.getRemotePlayers()` 에
         가짜 분대원을 끼워 넣는다. 같은 적을 곧바로 다시 돌리면 **대상별 쿨다운**으로 안 치여야 한다. */
      const hit = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world;
        const ws = window.__game.getSystem('world');
        const es = window.__game.getSystem('enemies');
        const rp = window.__game.getSystem('remotePlayers');
        const t = w.getTrams()[0];
        const V3 = ctx.camera.position.constructor;
        const ground = es.debugSpawn('warrior', { x: t.position.x, z: t.position.z }, false);
        const rider = es.debugSpawn('warrior', { x: t.position.x + Math.cos(t.yaw) * 2, z: t.position.z + Math.sin(t.yaw) * 2 }, false);
        if (!ground || !rider) return { spawned: false };
        ground.position.set(t.position.x, t.position.y - 1.0, t.position.z);
        rider.position.set(t.position.x + Math.cos(t.yaw) * 2, t.position.y, t.position.z + Math.sin(t.yaw) * 2);
        const ref = rp.debugSpawn({ id: 'tram-ghost', slot: 3, position: new V3(t.position.x - Math.cos(t.yaw) * 2, t.position.y - 1.0, t.position.z - Math.sin(t.yaw) * 2) });
        ref.hp = 100; ref.position.set(t.position.x - Math.cos(t.yaw) * 2, t.position.y - 1.0, t.position.z - Math.sin(t.yaw) * 2);
        rp.debugSuspend('tram-ghost', true);
        const net = ctx.net; const orig = net.getRemotePlayers.bind(net);
        net.getRemotePlayers = () => [...orig(), ref];
        const snd = [], gd = [];
        const offA = ctx.bus.on('audio:play', (p) => { if (p.id === 'tram_hit') snd.push(p.id); });
        const offG = ctx.bus.on('ghost:damage', (e) => gd.push({ id: e.id, amount: e.amount, kb: !!e.kb }));
        const g0 = ground.hp, r0 = rider.hp, gv0 = Math.hypot(ground.velocity.x, ground.velocity.z);
        // 적 공간 격자는 이번 프레임의 적 update 에서 만들어졌다 — 방금 옮긴 적이 안 잡히므로 선형 검색으로 돌린다.
        // (실제 프레임에서는 world 가 enemies 보다 먼저 돌아 늘 선형 검색이다.)
        es.gridTime = -1;
        ws.rails.update(1 / 120, ctx.time);
        const g1 = ground.hp, r1 = rider.hp, gv1 = Math.hypot(ground.velocity.x, ground.velocity.z);
        ground.position.set(t.position.x, t.position.y - 1.0, t.position.z);
        es.gridTime = -1;
        ws.rails.update(1 / 120, ctx.time);
        const g2 = ground.hp;
        offA(); offG(); delete net.getRemotePlayers; rp.debugClear();
        return { spawned: true, state: t.state, g0, g1, g2, r0, r1, gv0, gv1, snd: snd.length, gd, keys: [...ws.rails.tram.hitUntil.keys()] };
      });
      ok(hit.spawned && hit.g1 < hit.g0 && hit.gv1 > hit.gv0 + 1, `C-18: 달리는 전차가 선로 옆 적을 치고 민다 (hp ${hit.g0} → ${hit.g1}, 속도 ${hit.gv0?.toFixed?.(1)} → ${hit.gv1?.toFixed?.(1)})`, JSON.stringify(hit));
      ok(hit.spawned && hit.r1 === hit.r0, `C-18: 데크 위에 탄 적은 치지 않는다 (hp ${hit.r0} → ${hit.r1})`, JSON.stringify(hit));
      ok(hit.spawned && hit.g2 === hit.g1, 'C-18: 쿨다운은 대상별 — 방금 친 적은 곧바로 다시 치이지 않는다', JSON.stringify(hit));
      ok(hit.spawned && hit.gd.length === 1 && hit.gd[0].id === 'tram-ghost' && hit.gd[0].kb && hit.snd >= 2,
        'C-18: 끊긴 분대원(고스트)은 ghost:damage {kb} 로 치이고 치임음은 tram_hit', JSON.stringify(hit));
      ok(riding.state === 'moving' && riding.s !== rail.tram.s, `호출로 출발한 전차가 계속 달린다 (s ${rail.tram.s.toFixed(0)} → ${riding.s.toFixed(0)})`);
      ok(Math.abs(riding.deckTop) < 0.2, `the tram deck is standable at the tram floor (Δ ${riding.deckTop.toFixed(2)} m)`);
      ok(riding.hasDeck && riding.speed > 5, `standing on the deck reports a ride velocity (${riding.speed.toFixed(1)} m/s)`, JSON.stringify(riding));
    }
  }

  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
