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
//      - 방마다 서 있을 수 있는 칸의 대부분에 닿는다 (1층 · 2층 — 잠긴 방 안은 뺀다)
//      - 2층 건물: 1층 계단 층계참 → 2층 도착 자리
//      - 옥상 사다리 발치 · 지하실 문 앞 · 잠긴 방 문 앞 (문은 잠겨 있어도 문 앞까지는 간다)
//      - 지상 컨테이너마다 상호작용 거리 안
//   3. 음성 대조: 걸어서는 옥상에 올라가지 못한다 (flood fill 이 벽 · 천장을 뚫지 않는다는 근거)
//
// 2026-09-12 (소모형 만능 열쇠 · 연구소 잠긴 방 · 지상드론 개구멍) — 추가 검사:
//   4. 잠긴 방: 잠긴 동안 사람 flood fill 이 방 안쪽 칸에 **닿지 않는다** (문 · 개구멍 · 창으로 새지 않는다)
//   5. 개구멍: 문 쪽 → 방 쪽으로 곧장 걸어 보면 **지상드론 몸**(반지름 0.35 · 키 0.45, `resolveCollision(p, r, h)`)은
//      지나가고 **사람 몸**(0.45, 키 없음)은 막힌다 — 지하실 문 옆 · 잠긴 방 문 옆 둘 다
//   6. 열쇠: 열쇠 없음 → 거부 · 다른 종류 열쇠 → 거부(안 줄어든다) · 맞는 열쇠 → 열리고 **그 열쇠만 1 개** 줄어든다,
//      문짝 콜라이더가 빠진다 (전진기지 = `key_basement`, 연구소 = `keycard_lab`)
//   7. 연 뒤: 안에서 걸어 잠긴 방 컨테이너 · 지하실 컨테이너에 손이 닿는다
//   8. 미리보기: `world.previewContainerItems(id)` 가 두 번 불러도 같고, 실제로 열었을 때 inventory 가 채운 내용물과
//      같다 (구조물 지상 · 잠긴 방 · 맵 상자 · 열쇠 부가 굴림이 맞은 컨테이너)
//
// 2026-09-13 — 9. **진짜 `PlayerController`** 로 정문 안쪽에서 바깥까지 걸어 나간다. flood fill 은 컨트롤러의 경사 처리를 타지 않아,
//   지하실 구덩이 위 바닥판에서 지형 법선 때문에 벽 · 정문 앞에서 멈추던 것(실내에서 못 나감)을 못 잡았다.
//
// 시드를 돌려 전진기지 · 연구실 · 2층 · 지하실 · 잠긴 방 · 불시착 함선이 각각 몇 채 이상 나올 때까지 (최대 MAX_SEEDS).
//
// Usage: node scripts/smoke-structure-reach.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEED_POOL = [21, 7, 1234, 3, 42, 99, 555, 808, 2026, 31337, 11, 64, 777, 4242, 9001, 123, 5150, 6060];
const MAX_SEEDS = 16;
const WANT = { outpost: 4, lab: 4, twoFloor: 4, basement: 4, locked: 3, wreck: 2 };
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

/**
 * 브라우저 안에서 도는 flood fill. 건물마다 결과 한 줄.
 * `after` = 열쇠 검사로 문을 연 **뒤**의 두 번째 패스 — 잠긴 문이 있던 건물만, 안쪽 컨테이너(`_l` · `_b`) 손닿음만 잰다.
 */
function reachAll({ roomMin, after }) {
  const ctx = window.__game.ctx, w = ctx.world;
  const V3 = ctx.camera.position.constructor;
  const ws = window.__game.getSystem('world');
  const R = 0.45, STEP = 0.3, MARGIN = 4, NODE_CAP = 80000;
  const DRONE_R = 0.35, DRONE_H = 0.45;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const p = new V3();
  const rows = [];
  const defs = new Map(w.getStructures().map((d) => [d.id, d]));

  for (const s of ws.structures.debugNav()) {
    if (after && !s.lockedDoor && !s.basementDoor) continue;
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
    /** 곧장 걸어 보기: 로컬 `a` → `b` 로 0.1 m 씩 내디디며 표면 먼저 · 밀어내기 나중. 끝에서 `b` 까지 남은 거리. */
    const walk = (a, b, y, r, h) => {
      const [ax, az] = toW(a[0], a[1]), [bx, bz] = toW(b[0], b[1]);
      p.set(ax, w.getSurfaceY(ax, az, y + 0.3), az);
      for (let it = 0; it < 90; it++) {
        const dx = bx - p.x, dz = bz - p.z, d = Math.hypot(dx, dz);
        if (d < 0.04) break;
        const st = Math.min(0.1, d);
        p.x += (dx / d) * st; p.z += (dz / d) * st;
        p.y = w.getSurfaceY(p.x, p.z, p.y);
        if (h === undefined) w.resolveCollision(p, r); else w.resolveCollision(p, r, h);
      }
      return +Math.hypot(bx - p.x, bz - p.z).toFixed(2);
    };
    const containersOf = (set, prefix, tol) => {
      const out = { total: 0, reached: 0, missing: [] };
      for (const it of ctx.interactables.all()) {
        if (!it.id.startsWith(`container:${s.id}_${prefix}`)) continue;
        out.total++;
        const [lx, lz] = toL(it.position.x, it.position.z);
        const r = near(set, lx, lz, it.position.y, tol);
        if (r.ok) out.reached++;
        else out.missing.push({ id: it.id.slice(10), d: r.d });
      }
      return out;
    };

    const y0 = nav.levels[0];
    const inside = bfs(nav.doorIn, y0, true);
    const def = defs.get(s.id);

    if (after) {
      rows.push({
        id: s.id, kind: s.kind, unlocked: !!def?.unlocked, inBlocked: inside.startBlocked, capped: inside.capped,
        locked: s.lockedDoor ? containersOf(inside.seen, 'l', 1.5) : null,
        basement: s.basementDoor ? containersOf(inside.seen, 'b', 1.5) : null,
        ms: Math.round(performance.now() - t0),
      });
      continue;
    }

    const outside = bfs(nav.doorOut, y0, false);
    /* 9. (2026-09-13) **진짜 `PlayerController`** 로 정문 안쪽 → 바깥까지 걸어 나간다. 위 flood fill 은 `getSurfaceY` +
     * `resolveCollision` 만 흉내 내서, 컨트롤러의 경사 처리가 바닥판 밑 지형(지하실 구덩이)을 읽어 벽 앞에서 멈추던 것을 못 잡았다. */
    let exitGap = null;
    if (s.kind !== 'wreck') {
      const Ctl = window.__game.getSystem('player').controller.constructor;
      const ctl = new Ctl();
      const [sx, sz] = toW(nav.doorIn[0], nav.doorIn[1] + 1.5);
      ctl.reset(new V3(sx, w.getSurfaceY(sx, sz, y0 + 0.3), sz));
      const [tx, tz] = toW(nav.doorOut[0], nav.doorOut[1]);
      const mv = { x: 0, z: 1, sprint: false, jump: false, stance: 'stand', aiming: false };
      const res = { footstep: false, landed: 0, jumped: false, rollEnded: false, rung: false, climbEnded: null };
      for (let it = 0; it < 900; it++) {
        const dx = tx - ctl.position.x, dz = tz - ctl.position.z;
        if (Math.hypot(dx, dz) < 0.3) break;
        ctl.update(1 / 60, mv, Math.atan2(-dx, -dz), w, res);
      }
      exitGap = +Math.hypot(tx - ctl.position.x, tz - ctl.position.z).toFixed(2);
    }
    const lockedR = nav.locked;
    const row = {
      exitGap,
      id: s.id, kind: s.kind, floors: nav.levels.length, basement: !!s.basementDoor, lockedRoom: !!s.lockedDoor, breach: nav.breach,
      outBlocked: outside.startBlocked, inBlocked: inside.startBlocked, capped: outside.capped || inside.capped,
      nodes: inside.seen.size,
      doorIn: near(outside.seen, nav.doorIn[0], nav.doorIn[1], y0, 0.45),
      stairBottom: null, stairTop: null, ladder: null, basementDoor: null, lockedDoor: null, lockedLeak: null,
      vents: [],
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
    if (s.lockedDoor) {
      const [lx, lz] = toL(s.lockedDoor.x, s.lockedDoor.z);
      row.lockedDoor = near(set, lx, lz, s.lockedDoor.y, 0.6);
    }
    if (lockedR) {
      // 잠긴 동안 방 안쪽(벽에서 0.3 m 들인 사각형)의 칸에 사람이 닿으면 새는 것이다 — 안에서도 밖에서도
      const ly = nav.levels[lockedR.k];
      let leak = 0;
      for (const seenSet of [inside.seen, outside.seen]) {
        for (const [i, j, yy] of seenSet.values()) {
          if (Math.abs(yy - ly) > 0.35) continue;
          const x = i * STEP, z = j * STEP;
          if (x > lockedR.x0 + 0.3 && x < lockedR.x1 - 0.3 && z > lockedR.z0 + 0.3 && z < lockedR.z1 - 0.3) leak++;
        }
      }
      row.lockedLeak = leak;
    }
    for (const v of nav.vents) {
      row.vents.push({
        drone: walk(v.out, v.in, v.y, DRONE_R, DRONE_H),
        person: walk(v.out, v.in, v.y, R, undefined),
      });
    }
    row.containers = containersOf(set, 'c', 1.5);
    for (const room of nav.rooms) {
      const level = nav.levels[room.k];
      let clear = 0, got = 0;
      const lost = [];
      for (let i = Math.ceil(room.x0 / STEP); i * STEP <= room.x1; i++) {
        for (let j = Math.ceil(room.z0 / STEP); j * STEP <= room.z1; j++) {
          // 잠긴 방 (+ 벽 두께 여유) 안의 칸은 잠긴 동안 닿지 않는 것이 맞다 — 세지 않는다
          if (lockedR && room.k === lockedR.k) {
            const x = i * STEP, z = j * STEP;
            if (x > lockedR.x0 - 0.8 && x < lockedR.x1 + 0.8 && z > lockedR.z0 - 0.8 && z < lockedR.z1 + 0.8) continue;
          }
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

/** 열쇠 검사 (6): 잠긴 문이 있는 건물마다 — 없음 · 다른 종류 · 맞는 열쇠. 이 클라이언트 혼자(싱글)라 호스트 경로 그대로다. */
function keyFlow() {
  const ctx = window.__game.ctx, w = ctx.world, inv = ctx.inventory, loot = ctx.loot;
  const count = (id) => inv.countWhere((d) => d.id === id);
  const clear = (id) => { const n = count(id); if (n > 0) inv.consumeWhere((d) => d.id === id, n); };
  const give = (id) => inv.tryAddItem(loot.createItem(id, 1));
  const rows = [];
  for (const s of w.getStructures()) {
    if (!s.unlockDefId || s.unlocked) continue;
    const it = ctx.interactables.all().find((x) => x.id === `struct:${s.id}:door`);
    const doorPos = s.basementDoor ?? s.lockedRoomDoor;
    if (!it || !doorPos) { rows.push({ id: s.id, missing: true }); continue; }
    const doorObs = () => w.getObstacles().some((o) => o.kind === 'door' && Math.hypot(o.position.x - doorPos.x, o.position.z - doorPos.z) < 0.25);
    const key = s.unlockDefId;
    const other = key === 'key_basement' ? 'keycard_lab' : 'key_basement';
    clear('key_basement'); clear('keycard_lab');
    const r = { id: s.id, kind: s.kind, key, basement: !!s.hasBasement, lockedRoom: !!s.hasLockedRoom, missing: false };
    r.promptNoKey = it.getPrompt();
    r.holdNoKey = it.holdTime ?? null;
    it.interact();
    r.denyKeepsLocked = !s.unlocked && doorObs();
    r.otherGiven = give(other);
    it.interact();
    r.wrongKeyKeepsLocked = !s.unlocked && doorObs() && count(other) === 1;
    r.keyGiven = give(key);
    r.promptWithKey = it.getPrompt();
    r.holdWithKey = it.holdTime ?? null;
    it.interact();
    r.unlocked = s.unlocked;
    r.doorGone = !doorObs();
    r.keyLeft = count(key);
    r.otherLeft = count(other);
    r.promptAfter = it.getPrompt();
    clear(other);
    rows.push(r);
  }
  return rows;
}

/** 미리보기 검사 (8): 미리보기 두 번 = 같다, 그리고 실제로 열어 inventory 캐시와 견준다. */
function previewFlow() {
  const ctx = window.__game.ctx, w = ctx.world;
  const invSys = window.__game.getSystem('inventory');
  const sig = (items) => {
    const m = new Map();
    for (const it of items) m.set(it.defId, (m.get(it.defId) ?? 0) + it.qty);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, q]) => `${d}x${q}`).join(',');
  };
  const ids = [];
  const all = ctx.interactables.all().filter((x) => x.id.startsWith('container:struct_')).map((x) => x.id.slice(10));
  const keyed = all.filter((id) => (w.previewContainerItems(id) ?? []).some((it) => it.defId === 'key_basement' || it.defId === 'keycard_lab'));
  ids.push(...keyed.slice(0, 3));
  for (const id of all.filter((x) => /_c\d+$/.test(x)).slice(0, 2)) if (!ids.includes(id)) ids.push(id);
  for (const id of all.filter((x) => /_l\d+$/.test(x)).slice(0, 1)) if (!ids.includes(id)) ids.push(id);
  const crate = w.getCrates()[0];
  const rows = [];
  for (const id of ids) {
    const a = w.previewContainerItems(id), b = w.previewContainerItems(id);
    const it = ctx.interactables.all().find((x) => x.id === `container:${id}`);
    const wasCached = !!invSys.containers.get(id);
    it?.interact();
    const cont = invSys.containers.get(id);
    const got = cont ? cont.grid.items().map((pl) => pl.item) : null;
    ctx.inventory.closeAll();
    rows.push({
      id, kind: 'structure', keyed: keyed.includes(id), wasCached,
      stable: !!a && !!b && sig(a) === sig(b), preview: a ? sig(a) : null, opened: got ? sig(got) : null,
    });
  }
  if (crate && !invSys.containers.get(crate.id)) {
    const a = w.previewContainerItems(crate.id);
    ctx.bus.emit('crate:open', { crateId: crate.id, tier: crate.tier, position: crate.position });
    const cont = invSys.containers.get(crate.id);
    ctx.inventory.closeAll();
    rows.push({
      id: crate.id, kind: 'crate', keyed: false, wasCached: false, stable: true,
      preview: a ? sig(a) : null, opened: cont ? sig(cont.grid.items().map((pl) => pl.item)) : null,
    });
  }
  rows.push({ id: 'unknown-id', kind: 'unknown', unknownIsNull: w.previewContainerItems('nope_container') === null });
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

  const seen = { outpost: 0, lab: 0, twoFloor: 0, basement: 0, locked: 0, wreck: 0 };
  const enough = () => Object.entries(WANT).every(([k, v]) => seen[k] >= v);
  let seeds = 0, keyedPreviews = 0;
  for (const seed of SEED_POOL) {
    if (seeds >= MAX_SEEDS || enough()) break;
    seeds++;
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(300);
    const rows = await page.evaluate(reachAll, { roomMin: ROOM_COVERAGE_MIN, after: false });
    console.log(`seed ${seed}: ${rows.length} structures`);
    for (const r of rows) {
      if (r.kind === 'outpost' || r.kind === 'lab') seen[r.kind]++;
      if (r.kind === 'wreck') seen.wreck++;
      if (r.floors === 2) seen.twoFloor++;
      if (r.basement) seen.basement++;
      if (r.lockedRoom) seen.locked++;
      const tag = `${r.id} (${r.kind}${r.floors === 2 ? ' · 2층' : ''}${r.basement ? ' · 지하실' : ''}${r.lockedRoom ? ' · 잠긴 방' : ''}${r.breach ? ` · 틈 ${['북', '서', '동'][r.breach.side]}` : ''})`;
      const detail = JSON.stringify({ ...r, rooms: r.rooms.map((x) => `${x.k}:${x.got}/${x.clear}${x.lost.length ? ` ${JSON.stringify(x.lost)}` : ''}`) });
      console.log(`  --   ${tag}: 노드 ${r.nodes} · 방 ${r.rooms.map((x) => `${x.k}F ${Math.round(x.cov * 100)}%`).join(' ')} · 컨테이너 ${r.containers.reached}/${r.containers.total}${r.vents.length ? ` · 개구멍 ${r.vents.map((v) => `드론 ${v.drone} / 사람 ${v.person}`).join(' · ')}` : ''} · ${r.ms} ms`);
      ok(!r.outBlocked && !r.inBlocked && !r.capped, `${tag}: flood fill 시작 자리가 비어 있다`, detail);
      ok(r.doorIn.ok, `${tag}: 바깥에서 ${r.kind === 'wreck' ? '후미 램프로' : '정문으로'} 걸어 들어간다`, detail);
      if (r.kind !== 'wreck') ok(r.exitGap !== null && r.exitGap < 0.5, `${tag}: 진짜 PlayerController 로 안에서 정문 밖까지 걸어 나간다 (남은 ${r.exitGap} m)`, detail);
      if (r.kind !== 'wreck') ok(r.roomsOk, `${tag}: 방마다 서 있을 수 있는 칸의 ${Math.round(ROOM_COVERAGE_MIN * 100)}% 이상에 **안에서** 닿는다`, detail);
      if (r.stairBottom) ok(r.stairBottom.ok, `${tag}: 1층 안에서 계단 층계참에 닿는다`, detail);
      if (r.stairTop) ok(r.stairTop.ok, `${tag}: 실내 계단으로 2층에 올라간다`, detail);
      if (r.ladder) ok(r.ladder.ok, `${tag}: 옥상 사다리 발치에 안에서 닿는다`, detail);
      if (r.basementDoor) ok(r.basementDoor.ok, `${tag}: 지하 계단으로 지하실 문 앞까지 내려간다`, detail);
      if (r.lockedDoor) ok(r.lockedDoor.ok, `${tag}: 2층 잠긴 방 문 앞까지 안에서 걸어간다`, detail);
      if (r.lockedLeak !== null) ok(r.lockedLeak === 0, `${tag}: 잠긴 동안 사람은 잠긴 방 안쪽 칸에 닿지 못한다 (${r.lockedLeak}칸)`, detail);
      if (r.kind === 'lab') ok(!r.basement, `${tag}: 연구소에는 지하실이 없다`, detail);
      if (r.basement || r.lockedRoom) ok(r.vents.length >= 1, `${tag}: 잠긴 문 옆에 개구멍이 있다 (${r.vents.length})`, detail);
      r.vents.forEach((v, i) => {
        ok(v.drone < 0.15, `${tag}: 개구멍 ${i} — 지상드론 몸(0.35 · 키 0.45)은 지나간다 (남은 ${v.drone} m)`, detail);
        ok(v.person > 0.6, `${tag}: 개구멍 ${i} — 사람 몸(0.45)은 막힌다 (남은 ${v.person} m)`, detail);
      });
      ok(r.containers.reached === r.containers.total, `${tag}: 지상 컨테이너 ${r.containers.total}개 모두 손이 닿는다`, detail);
      if (r.kind !== 'wreck') ok(!r.roofWalk, `${tag}: (음성 대조) 걸어서는 옥상에 못 올라간다`, detail);
    }

    // 8. 미리보기 = 첫 개봉 (열쇠 검사 · 열린 뒤 flood fill 보다 먼저 — 문을 열어도 컨테이너 내용물은 안 바뀌지만 순서를 고정한다)
    const prev = await page.evaluate(previewFlow);
    for (const p of prev) {
      if (p.kind === 'unknown') { ok(p.unknownIsNull, 'previewContainerItems(모르는 id) === null'); continue; }
      if (p.keyed) keyedPreviews++;
      const tag = `seed ${seed} ${p.id}${p.keyed ? ' (열쇠 부가 굴림)' : ''}`;
      ok(p.preview !== null && p.stable, `${tag}: 미리보기가 있고 두 번 불러도 같다`, JSON.stringify(p));
      if (!p.wasCached) ok(p.preview === p.opened, `${tag}: 미리보기 = 실제로 열었을 때의 내용물`, JSON.stringify(p));
    }

    // 6. 열쇠
    const keys = await page.evaluate(keyFlow);
    for (const k of keys) {
      if (k.missing) { ok(false, `seed ${seed} ${k.id}: 잠긴 문 상호작용 · 위치가 있다`); continue; }
      const tag = `seed ${seed} ${k.id} (${k.kind}, ${k.key})`;
      const detail = JSON.stringify(k);
      ok(k.kind === 'outpost' ? k.key === 'key_basement' && k.basement : k.key === 'keycard_lab' && k.lockedRoom,
        `${tag}: 전진기지 지하실 = 열쇠 · 연구소 잠긴 방 = 키카드`, detail);
      ok(/필요/.test(k.promptNoKey ?? '') && k.holdNoKey === 0, `${tag}: 열쇠 없으면 「… 필요」 프롬프트 · 홀드 0 (${k.promptNoKey})`, detail);
      ok(k.denyKeepsLocked, `${tag}: 열쇠 없이 누르면 문이 그대로 잠겨 있다`, detail);
      ok(k.otherGiven && k.wrongKeyKeepsLocked, `${tag}: 다른 종류 열쇠로는 안 열리고 그 열쇠도 안 줄어든다`, detail);
      ok(k.keyGiven && /개방/.test(k.promptWithKey ?? '') && k.holdWithKey > 0, `${tag}: 맞는 열쇠가 있으면 「… 개방 (E)」 · 홀드 (${k.promptWithKey})`, detail);
      ok(k.unlocked && k.doorGone && k.promptAfter === null, `${tag}: 맞는 열쇠로 열린다 — 문짝 콜라이더가 빠진다`, detail);
      ok(k.keyLeft === 0 && k.otherLeft === 1, `${tag}: 연 열쇠만 1 개 소모된다 (남은 ${k.keyLeft} · 다른 종류 ${k.otherLeft})`, detail);
    }

    // 7. 연 뒤 — 안쪽 컨테이너 손닿음 (문짝이 미끄러지는 애니메이션은 콜라이더와 무관하다)
    const afterRows = await page.evaluate(reachAll, { roomMin: ROOM_COVERAGE_MIN, after: true });
    for (const r of afterRows) {
      const tag = `seed ${seed} ${r.id} (연 뒤)`;
      const detail = JSON.stringify(r);
      if (!r.unlocked) continue;
      if (r.locked) ok(r.locked.total >= 2 && r.locked.reached === r.locked.total, `${tag}: 잠긴 방 컨테이너 ${r.locked.total}개 모두 손이 닿는다 (2–3개)`, detail);
      if (r.basement) ok(r.basement.reached === r.basement.total, `${tag}: 지하실 컨테이너 ${r.basement.total}개 모두 손이 닿는다`, detail);
    }
  }
  console.log(`seeds ${seeds}: ${JSON.stringify(seen)} · 열쇠 부가 굴림이 맞은 컨테이너 미리보기 ${keyedPreviews}개`);
  ok(enough(), `건물 종류가 충분히 나왔다 (원하는 수 ${JSON.stringify(WANT)})`, JSON.stringify(seen));
  if (keyedPreviews === 0) console.log('  --   이번 시드들에서는 열쇠 부가 굴림이 맞은 지상 컨테이너가 없었다 (keyChance) — 그 경로의 미리보기 대조는 건너뛰었다');
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
