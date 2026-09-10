/**
 * src/world/structures/parts/Build.ts — 버려진 구조물의 **지오메트리와 콜라이더**.
 *
 * `Structures` 클래스에서 떼어낸 메서드 묶음이고 상태는 없다. 여기서 만드는 것은
 * ① 병합용 지오메트리 조각, ② `SpatialHash` 에 들어가는 **사각(OBB) · 경사 콜라이더**, ③ 컨테이너 · 콘솔 · 문 ·
 * 사다리 · 창문 · 광원이 설 자리(월드 좌표)뿐이다.
 *
 * 규약 두 가지를 지킨다:
 *  - **콜라이더는 보이는 실루엣이다.** 벽 하나 = 상자 하나이고 크기는 그린 `BoxGeometry` 와 같은 수를 쓴다.
 *  - **회전 규약**: `Obstacle.box.yaw` 는 수학 규약(로컬 +X → 월드 `(cos, sin)`)이고, 같은 상자를 그리는
 *    메시의 Euler 는 그 부호를 뒤집은 `-yaw` 다 (three 의 Y 회전이 반대 손이다).
 *
 * ## 2026-09-11 — 천장이 있는 건물 (사용자 요청 5건)
 * 2026-09-09 의 "무너진 지붕" 을 걷어냈다. 전진기지 · 연구실은 이제
 *  - **층마다 천장**이 있다 (천장 높이 = `wallH` = PC 두 명). 층 사이 바닥판 = 아래층 천장이고 맨 위는 **옥상**이다.
 *  - 무작위로 **2층**이다 (`upperChance`). 1층 → 2층은 벽으로 둘러싼 **실내 계단**, 맨 위층 → 옥상은
 *    격벽에 붙은 **사다리**와 옥상 바닥의 해치 구멍이다 (1층 건물도 옥상이 있다).
 *  - **맵 스캐너는 언제나 옥상**에 선다.
 *  - 층마다 바깥벽의 무작위 자리에 **창문**이 있다 (`parts/Glass` — 총알 · 투척물에 깨진다).
 *  - 컨테이너가 놓인 방마다 천장 조명(발광 판 + 광원 자리 `LightFixture`)이 달린다.
 *  - **지하실**은 흙구덩이가 아니라 방이다: 바닥판 · 벽 · 천장 · 조명. 들어가는 길은 1층 바닥의 계단 구멍 →
 *    양옆이 벽인 **계단 복도** → 층계참 → **서 있는 문**(키카드). 예전의 바닥 해치는 없다.
 *  - 계단은 전부 **경사 콜라이더**(`parts/Stairs`) — 한 단씩 튀지 않는다.
 *
 * 3인칭 카메라가 천장에 갇히는 문제는 `player/CameraRig` 가 이미 `world.raycast` 로 당겨 오므로 특례가 없다.
 */
import * as THREE from 'three';
import type { LightFixture, Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import {
  BASEMENT_FLOOR_T, BASEMENT_HALL_HALF, BASEMENT_LANDING, DOOR_H, DOOR_W, FLOOR_LIP, FLOOR_OVERHANG, HATCH_D, HATCH_W,
  LADDER_STANDOFF, PARAPET_H, RAIL_H, RAIL_T, SLAB_T, STAIR_SLOPE, STAIR_W, WALL_T, WINDOW_SILL, WINDOW_TOP, WINDOW_W,
} from '../model';
import type { WindowSpec } from './Glass';
import { buildStairFlight } from './Stairs';

/** 구조물 한 채를 세우는 데 필요한 부지 정보 (`layout.StructureSite` 에서 옮겨 온다). */
export interface BuildingPlan {
  cx: number; cz: number; yaw: number;
  /** 지상층 바닥 높이 (패드 높이). */
  y0: number;
  halfW: number; halfD: number;
  /** 층의 천장 높이(m). */
  wallH: number;
  pit: { halfX: number; halfZ: number; depth: number } | null;
  /** 지상 층수 (1 · 2). 계단이 들어갈 자리가 없으면 1 로 내려간다. */
  floors: number;
  /** 지상 · 지하 컨테이너 수. 조명이 **컨테이너 있는 방에만** 달리므로 자리 고르기가 여기서 끝난다. */
  containers: number;
  basementContainers: number;
}

/** 무언가가 설 자리 — 월드 좌표 + 벽을 등진 방향(수학 규약 yaw). */
export interface Spot { x: number; y: number; z: number; yaw: number }

/** 사다리 한 줄 (`LadderDef` 에서 id 만 빠진 것). */
export interface LadderSpot {
  base: { x: number; y: number; z: number };
  topY: number;
  normal: { x: number; z: number };
  exit: { x: number; y: number; z: number };
}

/** 지하실의 서 있는 문. 문짝 · 콜라이더 · 애니메이션은 `Structures` 가 만든다. */
export interface DoorSpot {
  /** 문짝 밑변 가운데. */
  x: number; y: number; z: number;
  /** 문짝이 가로로 뻗는 방향 (수학 규약). */
  yaw: number;
  halfW: number;
  height: number;
  thick: number;
  /** 열리면 문짝이 옮겨 가는 월드 변위. */
  slideX: number; slideZ: number;
  /** 카드 리더기 (복도 벽에 붙는다) — 자리와 복도 쪽을 보는 방향. */
  reader: { x: number; z: number; yaw: number };
  /** 상호작용 자리 (층계참, y = 지하실 바닥). */
  interact: { x: number; y: number; z: number };
}

export interface BuildingOut {
  parts: THREE.BufferGeometry[];
  glow: THREE.BufferGeometry[];
  containers: Spot[];
  basementContainers: Spot[];
  /** 맵 스캐너 자리 (옥상). 불시착 함선은 null. */
  console: Spot | null;
  /** 지하실 문 (지하실이 없으면 null). */
  door: DoorSpot | null;
  /** 지하실 바닥 높이 (지하실이 없으면 y0). */
  basementY: number;
  ladders: LadderSpot[];
  windows: WindowSpec[];
  fixtures: LightFixture[];
  /** 실제로 세운 지상 층수. */
  floors: number;
  /** 옥상 바닥 높이 (없으면 NaN). */
  roofY: number;
}

const CONCRETE = new THREE.Color(0x7a7770);
const CONCRETE_DARK = new THREE.Color(0x4a4844);
const CEILING = new THREE.Color(0x5b5954);
const METAL = new THREE.Color(0x424750);
const METAL_DARK = new THREE.Color(0x24272c);
const RUST = new THREE.Color(0x6d4a30);

/** 방 조명 색 · 세기 · 닿는 거리 (그림 값 — 밸런스 수치가 아니다). */
const LIGHT_WARM = 0xffd9a8;
const LIGHT_COOL = 0xd2ecff;
const LIGHT_INTENSITY = 16;
const LIGHT_DISTANCE = 12;

/** 로컬 사각형 (건물 좌표). */
interface Rect { x0: number; x1: number; z0: number; z1: number }
const rect = (xa: number, xb: number, za: number, zb: number): Rect =>
  ({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: Math.min(za, zb), z1: Math.max(za, zb) });
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 - m, z1: r.z1 + m });
const inRect = (r: Rect, x: number, z: number): boolean => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

/** 벽 구멍 (문 · 창 · 무너진 틈). `y0`/`y1` 은 층 바닥 기준. */
interface Opening { c: number; w: number; y0: number; y1: number }

/**
 * 지상 건물(전진기지 · 연구실) 한 채.
 */
export function buildBuilding(ctx: BuildCtx, plan: BuildingPlan, rng: Random, lab: boolean): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD } = plan;
  const H = plan.wallH;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const windows: WindowSpec[] = [];
  const fixtures: LightFixture[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];
  const dirW = (dx: number, dz: number): [number, number] => [dx * cos - dz * sin, dx * sin + dz * cos];
  const iw = halfW - WALL_T / 2, id = halfD - WALL_T / 2;          // 벽 안쪽 면
  const pit = plan.pit;
  const lightColor = lab ? LIGHT_COOL : LIGHT_WARM;

  /* ── 그리기 · 콜라이더 도우미 ──────────────────────────────────────────── */
  /** 상자 한 개: 로컬 (lx, lz) 가운데, `alongZ` 면 긴 쪽이 로컬 Z. 색은 [gy0, gy1] 높이로 그라데이션. */
  const solid = (
    lx: number, lz: number, halfLen: number, halfThick: number, yBot: number, h: number, alongZ: boolean,
    kind: string | null, dark = CONCRETE_DARK, light = CONCRETE, gy0 = yBot, gy1 = yBot + h,
  ): void => {
    if (halfLen <= 0.02 || h <= 0.02) return;
    const [wx, wz] = rot(lx, lz);
    const byaw = yaw + (alongZ ? Math.PI / 2 : 0);
    const g = new THREE.BoxGeometry(halfLen * 2, h, halfThick * 2);
    xform(g, { x: wx, y: yBot + h / 2, z: wz }, new THREE.Euler(0, -byaw, 0));
    paintGradient(g, dark, light, gy0, gy1);
    parts.push(g);
    if (kind) ctx.hash.addBox(new THREE.Vector3(wx, yBot, wz), halfLen, halfThick, byaw, h, kind);
  };

  /**
   * 바닥판 한 조각 — **그리는 판과 서는 판이 같다** (2026-09-10). 콜라이더 윗면은 정확히 `yTop`, 밑면은
   * `yTop − SLAB_T` 라 아래층에서는 그대로 천장이다. `lip` 은 지형과 z-fighting 을 피하려고 그린 윗면만 띄운다.
   */
  const plate = (x0: number, x1: number, z0: number, z1: number, yTop: number, lip: number, color: THREE.Color): void => {
    if (x1 - x0 < 0.2 || z1 - z0 < 0.2) return;
    const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    const [wx, wz] = rot((x0 + x1) / 2, (z0 + z1) / 2);
    const g = new THREE.BoxGeometry(hx * 2, SLAB_T, hz * 2);
    xform(g, { x: wx, y: yTop + lip - SLAB_T / 2, z: wz }, new THREE.Euler(0, -yaw, 0));
    paintGradient(g, CEILING, color, yTop - SLAB_T, yTop);
    parts.push(g);
    ctx.hash.addBox(new THREE.Vector3(wx, yTop - SLAB_T, wz), hx, hz, yaw, SLAB_T, 'slab');
  };
  /** 구멍 하나를 뚫은 바닥판 (네 조각). */
  const slab = (fx: number, fz: number, yTop: number, lip: number, color: THREE.Color, hole: Rect | null): void => {
    if (!hole) { plate(-fx, fx, -fz, fz, yTop, lip, color); return; }
    plate(-fx, fx, -fz, hole.z0, yTop, lip, color);
    plate(-fx, fx, hole.z1, fz, yTop, lip, color);
    plate(-fx, hole.x0, hole.z0, hole.z1, yTop, lip, color);
    plate(hole.x1, fx, hole.z0, hole.z1, yTop, lip, color);
  };

  /** 한 변을 따라 구멍을 빼고 벽을 세운다 — 구멍 위 · 아래(상인방 · 창턱)도 벽이다 (천장이 생겼다). */
  const wallRun = (alongZ: boolean, fixed: number, from: number, to: number, yBase: number, h: number, ops: Opening[]): void => {
    const cuts = ops.slice().sort((a, b) => a.c - b.c);
    let s = from;
    const seg = (a: number, b: number, yb: number, hh: number): void => {
      if (b - a < 0.05 || hh < 0.03) return;
      const mid = (a + b) / 2, hl = (b - a) / 2;
      if (alongZ) solid(fixed, mid, hl, WALL_T / 2, yb, hh, true, 'building', CONCRETE_DARK, CONCRETE, yBase, yBase + h);
      else solid(mid, fixed, hl, WALL_T / 2, yb, hh, false, 'building', CONCRETE_DARK, CONCRETE, yBase, yBase + h);
    };
    for (const op of cuts) {
      const g0 = Math.max(from, op.c - op.w / 2), g1 = Math.min(to, op.c + op.w / 2);
      if (g1 <= s) continue;
      if (g0 > s) seg(s, g0, yBase, h);
      const a = Math.max(s, g0);
      seg(a, g1, yBase, op.y0);
      seg(a, g1, yBase + op.y1, h - op.y1);
      s = g1;
    }
    seg(s, to, yBase, h);
  };

  /* ── 배치 결정: 격벽 · 실내 계단 · 지하 계단 복도 ─────────────────────────
   * 서로 부딪히는 제약이 셋이다 — 계단이 들어갈 만큼 긴 방, 1층 바닥의 지하 계단 구멍이 격벽 밑을 지나가지 않을 것,
   * 그 복도가 구덩이 안에 들어갈 것. 격벽 자리를 여러 번 굴려 셋을 한꺼번에 만족하는 것을 고른다. */
  const stairRise = H + SLAB_T;
  const stairRun = stairRise / STAIR_SLOPE;
  const needStairRoom = stairRun + 0.8 + 1.3;           // 계단 + 아래 입구 여유 + 위 도착 여유
  const bRise = pit ? pit.depth - BASEMENT_FLOOR_T : 0;
  const yB = y0 - bRise;
  const bRun = bRise / STAIR_SLOPE;
  const bLen = bRun + BASEMENT_LANDING + WALL_T;
  const pitInX = pit ? pit.halfX - 0.15 : 0, pitInZ = pit ? pit.halfZ - 0.15 : 0;

  let floors = plan.floors >= 2 ? 2 : 1;
  let partZ = 0;
  let hasPartition = true;
  const stairSide = rng.chance(0.5) ? 1 : -1;
  let stairRoom = 1;                                      // +1 = 격벽 뒤(+Z) 방, −1 = 앞 방
  let bSide = -stairSide;
  let bDz = 1;
  let bZA = 0;
  const partMargin = WALL_T / 2 + 0.25;

  const tryLayout = (pz: number, fl: number, withPartition: boolean): boolean => {
    if (fl === 2) {
      const front = (pz - WALL_T / 2) + id;
      const back = id - (pz + WALL_T / 2);
      const opts: number[] = [];
      if (back >= needStairRoom) opts.push(1);
      if (front >= needStairRoom) opts.push(-1);
      if (opts.length === 0) return false;
      stairRoom = opts[rng.int(0, opts.length - 1)];
    }
    if (pit) {
      bSide = fl === 2 ? -stairSide : (rng.chance(0.5) ? 1 : -1);
      const cands: [number, number][] = [];
      for (const dz of [1, -1]) {
        for (let k = 0; k <= 40; k++) {
          const zA = dz > 0 ? -pitInZ + k * 0.25 : pitInZ - k * 0.25;
          const zLow = zA + dz * bRun, zEnd = zA + dz * bLen;
          const beyond = dz > 0 ? pitInZ - zEnd : zEnd + pitInZ;
          if (beyond < 2.4) break;
          if (withPartition) {
            const h0 = Math.min(zA, zLow), h1 = Math.max(zA, zLow);
            if (pz + partMargin > h0 && pz - partMargin < h1) continue;
            const entry = zA - dz * 1.1;
            if ((entry - pz) * (zA - pz) < 0) continue;
          }
          if (Math.abs(zA - dz * 1.1) > id - 0.2) continue;
          cands.push([dz, zA]);
        }
      }
      if (cands.length === 0) return false;
      [bDz, bZA] = cands[rng.int(0, cands.length - 1)];
    }
    return true;
  };
  let ok = false;
  for (let a = 0; a < 60 && !ok; a++) { partZ = rng.range(-halfD * 0.35, halfD * 0.3); ok = tryLayout(partZ, floors, true); }
  if (!ok && floors === 2) {
    floors = 1;
    for (let a = 0; a < 60 && !ok; a++) { partZ = rng.range(-halfD * 0.35, halfD * 0.3); ok = tryLayout(partZ, 1, true); }
  }
  if (!ok) { hasPartition = false; partZ = 0; tryLayout(0, 1, false); }

  const levelY = (k: number): number => y0 + k * (H + SLAB_T);
  const topK = floors - 1;
  const roofY = levelY(floors);

  /* 실내 계단 (2층일 때) — 한쪽 바깥벽에 붙어 오르고, 방 쪽은 벽으로 막혀 있다 (입구는 아래 끝 하나). */
  const sOuter = stairSide * iw, sInner = stairSide * (iw - STAIR_W);
  const sXc = (sOuter + sInner) / 2;
  const sBottomZ = stairRoom > 0 ? partZ + WALL_T / 2 + 0.8 : partZ - WALL_T / 2 - 0.8;
  const sTopZ = sBottomZ + stairRoom * stairRun;
  const stairRect = rect(sOuter, sInner, sBottomZ, sTopZ);
  /* 바닥판에 뚫는 구멍은 계단 높은 끝에서 한 뼘 짧다 — 경사면 끝과 바닥판이 겹쳐야 이음매에서 발이 빠지지 않는다
   * (정확히 같은 선이면 부동소수 오차로 두 콜라이더 모두 그 점을 놓친다). */
  const stairHole = rect(sOuter, sInner, sBottomZ, sTopZ - stairRoom * 0.08);

  /* 지하 계단 복도 — 구덩이 한쪽 벽을 따라 내려간다. */
  const bOuter = bSide * pitInX, bInner = bSide * (pitInX - 2 * BASEMENT_HALL_HALF);
  const bXc = (bOuter + bInner) / 2;
  const bLowZ = bZA + bDz * bRun;
  const bDoorZ = bLowZ + bDz * (BASEMENT_LANDING + WALL_T / 2);
  const bHole = rect(bOuter, bInner, bZA, bLowZ);
  const bHoleSlab = rect(bOuter, bInner, bZA + bDz * 0.08, bLowZ);

  /* 격벽의 통로 · 정문 · 무너진 틈 */
  let passX = 0;
  for (let a = 0; a < 40; a++) {
    passX = rng.range(-iw + DOOR_W / 2 + 0.6, iw - DOOR_W / 2 - 0.6);
    if (floors === 2 && Math.abs(passX - sXc) < STAIR_W / 2 + DOOR_W / 2 + 0.4) continue;
    break;
  }
  const doorX = rng.range(-halfW * 0.45, halfW * 0.45);
  const breachSide = rng.int(0, 2);          // 0 = 북, 1 = 서, 2 = 동 (1층만)
  const breachAt = rng.range(-0.45, 0.45);

  /* 사다리 (맨 위층 → 옥상): 격벽 면에 붙고, 매달린 사람은 격벽을 본다. 옥상에 올라서면 격벽 너머로 넘어간다. */
  const mountZ = hasPartition ? partZ : 0;
  let ladderSide = 1, ladderX = 0;
  {
    let found = false;
    for (let a = 0; a < 80 && !found; a++) {
      const side = a % 2 === 0 ? 1 : -1;
      const lx = rng.range(-iw + 1.1, iw - 1.1);
      if (hasPartition && Math.abs(lx - passX) < DOOR_W / 2 + 1.1) continue;
      const face = mountZ + side * WALL_T / 2;
      const zone = rect(lx - 1.1, lx + 1.1, face, face + side * 2.0);
      if (Math.abs(face + side * 2.0) > id) continue;
      if (floors === 2 && overlaps(zone, grow(stairRect, 0.6))) continue;
      if (floors === 1 && pit && overlaps(zone, grow(bHole, 1.0))) continue;
      ladderSide = side; ladderX = lx; found = true;
    }
  }
  const ladderFace = mountZ + ladderSide * WALL_T / 2;
  const hatch = rect(ladderX - HATCH_W / 2, ladderX + HATCH_W / 2, ladderFace, ladderFace + ladderSide * HATCH_D);
  const ladderZone = rect(ladderX - 1.1, ladderX + 1.1, ladderFace, ladderFace + ladderSide * 2.0);

  /* ── 바닥판 · 천장 · 옥상 ────────────────────────────────────────────────── */
  const fx0 = halfW + FLOOR_OVERHANG, fz0 = halfD + FLOOR_OVERHANG;
  const fxs = halfW + WALL_T / 2, fzs = halfD + WALL_T / 2;
  slab(fx0, fz0, y0, FLOOR_LIP, CONCRETE_DARK, pit ? bHoleSlab : null);                  // 1층 바닥 = 지하실 천장
  if (floors === 2) {
    slab(fxs, fzs, levelY(1), 0, CONCRETE_DARK, stairHole);                          // 2층 바닥 = 1층 천장
    slab(fxs, fzs, roofY, 0, CONCRETE, hatch);                                        // 옥상 = 2층 천장
  } else {
    slab(fxs, fzs, roofY, 0, CONCRETE, hatch);                                        // 옥상 = 1층 천장
  }

  /* ── 층마다 바깥벽 · 격벽 · 창문 ─────────────────────────────────────────── */
  /** 한 벽의 창 자리 (무작위 1~3 개). 유리 명세와 창턱은 벽을 세운 뒤 `emitWindows` 가 만든다. */
  const windowOps = (len: number, forbid: { c: number; w: number }[]): Opening[] => {
    const ops: Opening[] = [];
    const want = rng.int(1, len > 9.5 ? 3 : 2);
    for (let a = 0; a < 40 && ops.length < want; a++) {
      const c = rng.range(-len + 1.4, len - 1.4);
      if (forbid.some((f) => Math.abs(c - f.c) < (f.w + WINDOW_W) / 2 + 0.5)) continue;
      if (ops.some((o) => Math.abs(c - o.c) < WINDOW_W + 1.0)) continue;
      ops.push({ c, w: WINDOW_W, y0: WINDOW_SILL, y1: WINDOW_TOP });
    }
    return ops;
  };
  const emitWindows = (alongZ: boolean, fixed: number, yBase: number, ops: Opening[]): void => {
    for (const o of ops) {
      if (o.y0 <= 0.01) continue;                             // 문 · 틈
      const lx = alongZ ? fixed : o.c, lz = alongZ ? o.c : fixed;
      const [wx, wz] = rot(lx, lz);
      windows.push({
        x: wx, y: yBase + o.y0, z: wz, halfW: o.w / 2, height: o.y1 - o.y0,
        yaw: yaw + (alongZ ? Math.PI / 2 : 0),
      });
      solid(lx, lz, o.w / 2 + 0.1, WALL_T / 2 + 0.08, yBase + o.y0 - 0.07, 0.07, alongZ, null, METAL_DARK, METAL);
    }
  };

  for (let k = 0; k < floors; k++) {
    const yk = levelY(k);
    const south: Opening[] = [], north: Opening[] = [], west: Opening[] = [], east: Opening[] = [];
    const fS: { c: number; w: number }[] = [], fN: { c: number; w: number }[] = [];
    const fW: { c: number; w: number }[] = [], fE: { c: number; w: number }[] = [];
    if (hasPartition) { fW.push({ c: partZ, w: WALL_T + 0.6 }); fE.push({ c: partZ, w: WALL_T + 0.6 }); }
    if (k === 0) {
      south.push({ c: doorX, w: DOOR_W, y0: 0, y1: DOOR_H }); fS.push({ c: doorX, w: DOOR_W });
      const breach = { c: breachAt * (breachSide === 0 ? halfW : halfD) * 2, w: 3.2 };
      const bOp: Opening = { ...breach, y0: 0, y1: 2.9 };
      if (breachSide === 0) { north.push(bOp); fN.push(breach); }
      if (breachSide === 1) { west.push(bOp); fW.push(breach); }
      if (breachSide === 2) { east.push(bOp); fE.push(breach); }
      if (floors === 2) {
        const sc = { c: (sBottomZ + sTopZ) / 2, w: stairRun + 1.2 };
        (stairSide > 0 ? fE : fW).push(sc);
      }
    }
    south.push(...windowOps(iw, fS));
    north.push(...windowOps(iw, fN));
    west.push(...windowOps(id, fW));
    east.push(...windowOps(id, fE));
    wallRun(false, -halfD, -halfW, halfW, yk, H, south);
    wallRun(false, halfD, -halfW, halfW, yk, H, north);
    wallRun(true, -halfW, -halfD, halfD, yk, H, west);
    wallRun(true, halfW, -halfD, halfD, yk, H, east);
    emitWindows(false, -halfD, yk, south);
    emitWindows(false, halfD, yk, north);
    emitWindows(true, -halfW, yk, west);
    emitWindows(true, halfW, yk, east);
    if (hasPartition) wallRun(false, partZ, -iw, iw, yk, H, [{ c: passX, w: DOOR_W, y0: 0, y1: DOOR_H }]);
  }
  if (!hasPartition) {
    // 격벽이 들어갈 자리가 없던 건물: 사다리를 붙일 짧은 벽 한 토막만 맨 위층에 세운다
    solid(ladderX, mountZ, 1.6, WALL_T / 2, levelY(topK), H, false, 'building');
  }

  /* 정문 상인방 장식 + 등 (그림만) */
  {
    solid(doorX, -halfD, DOOR_W / 2 + 0.45, WALL_T / 2 + 0.1, y0 + DOOR_H - 0.05, 0.4, false, null, METAL, METAL);
    const [lx, lz] = rot(doorX, -halfD - WALL_T / 2 - 0.1);
    const lamp = new THREE.BoxGeometry(0.5, 0.12, 0.16);
    xform(lamp, { x: lx, y: y0 + DOOR_H + 0.5, z: lz }, new THREE.Euler(0, -yaw, 0));
    glow.push(lamp);
  }

  /* ── 옥상: 난간벽 · 해치 난간 · 안테나 ────────────────────────────────────── */
  wallRun(false, -halfD, -halfW, halfW, roofY, PARAPET_H, []);
  wallRun(false, halfD, -halfW, halfW, roofY, PARAPET_H, []);
  wallRun(true, -halfW, -halfD, halfD, roofY, PARAPET_H, []);
  wallRun(true, halfW, -halfD, halfD, roofY, PARAPET_H, []);
  {
    // 해치 둘레 세 변 (올라서는 쪽 = 격벽 쪽은 비운다)
    const far = ladderFace + ladderSide * HATCH_D;
    solid(ladderX, far + ladderSide * RAIL_T / 2, HATCH_W / 2 + RAIL_T, RAIL_T / 2, roofY, RAIL_H, false, 'building', METAL_DARK, METAL);
    for (const s of [-1, 1]) {
      solid(ladderX + s * (HATCH_W / 2 + RAIL_T / 2), ladderFace + ladderSide * HATCH_D / 2, HATCH_D / 2, RAIL_T / 2,
        roofY, RAIL_H, true, 'building', METAL_DARK, METAL);
    }
  }

  /* ── 사다리 (그림) ─────────────────────────────────────────────────────── */
  const ladders: LadderSpot[] = [];
  {
    const yLow = levelY(topK), yHigh = roofY + 1.15;
    const railZ = ladderFace + ladderSide * 0.07;
    for (const s of [-1, 1]) {
      solid(ladderX + s * 0.26, railZ, 0.035, 0.035, yLow, yHigh - yLow, true, null, METAL_DARK, METAL);
    }
    for (let y = yLow + 0.3; y < yHigh - 0.1; y += 0.32) {
      solid(ladderX, railZ, 0.26, 0.022, y, 0.045, false, null, METAL, METAL);
    }
    const [bx, bz] = rot(ladderX, ladderFace + ladderSide * LADDER_STANDOFF);
    const [nx, nz] = dirW(0, ladderSide);
    const [ex, ez] = rot(ladderX, mountZ - ladderSide * (WALL_T / 2 + 0.85));
    ladders.push({ base: { x: bx, y: yLow, z: bz }, topY: roofY, normal: { x: nx, z: nz }, exit: { x: ex, y: roofY, z: ez } });
  }

  /* ── 실내 계단 (1층 → 2층) ─────────────────────────────────────────────── */
  if (floors === 2) {
    const [hx, hz] = rot(sXc, sTopZ);
    const [ux, uz] = dirW(0, -stairRoom);
    buildStairFlight(ctx, parts, rng, {
      hx, hz, ux, uz, width: STAIR_W - 0.04, run: stairRun, topY: levelY(1), bottomY: y0, solidY: y0,
      dark: CONCRETE_DARK, light: CONCRETE, kind: 'slab',
    });
    // 방 쪽 벽 (1층 천장까지) — 계단은 아래 끝으로만 들어간다
    solid(sInner - stairSide * 0.1, (sBottomZ + sTopZ) / 2, stairRun / 2, 0.1, y0, H, true, 'building');
    // 2층 계단 구멍 난간: 방 쪽 긴 변 + 아래 끝 짧은 변 (위 끝 = 도착하는 쪽은 비운다)
    const y1 = levelY(1);
    solid(sInner - stairSide * RAIL_T / 2, (sBottomZ + sTopZ) / 2, stairRun / 2, RAIL_T / 2, y1, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(sXc, sBottomZ - stairRoom * RAIL_T / 2, STAIR_W / 2, RAIL_T / 2, y1, RAIL_H, false, 'building', METAL_DARK, METAL);
  }

  /* ── 지하실 ───────────────────────────────────────────────────────────── */
  let door: DoorSpot | null = null;
  const basementSpots: Spot[] = [];
  if (pit) {
    const pitBottom = y0 - pit.depth;
    /* 구덩이 흙벽을 콘크리트로 덮고 콜라이더를 건다 (지형만 믿으면 흙을 타고 올라가 천장에 끼인다). */
    for (const [alongZ, fixed] of [[false, -pit.halfZ], [false, pit.halfZ], [true, -pit.halfX], [true, pit.halfX]] as [boolean, number][]) {
      const len = alongZ ? pit.halfZ : pit.halfX;
      solid(alongZ ? fixed : 0, alongZ ? 0 : fixed, len, 0.15, pitBottom, pit.depth, alongZ, 'building',
        CONCRETE_DARK.clone().multiplyScalar(0.7), CONCRETE_DARK, pitBottom, y0);
    }
    /* 지하실 바닥판 (윗면 = yB) */
    plate(-pit.halfX, pit.halfX, -pit.halfZ, pit.halfZ, yB, 0, CONCRETE_DARK.clone().multiplyScalar(0.85));

    /* 계단: 1층 바닥 구멍의 높은 끝(bZA)에서 복도를 따라 내려간다 */
    {
      const [hx, hz] = rot(bXc, bZA);
      const [ux, uz] = dirW(0, bDz);
      buildStairFlight(ctx, parts, rng, {
        hx, hz, ux, uz, width: 2 * BASEMENT_HALL_HALF - 0.04, run: bRun, topY: y0, bottomY: yB, solidY: yB,
        dark: CONCRETE_DARK, light: CONCRETE, kind: 'slab',
      });
    }
    /* 계단 양옆 벽 — 바깥쪽은 구덩이 벽이고, 방 쪽에 벽을 세운다 (구멍 시작부터 문 벽 바로 앞까지, 1층 바닥 높이까지).
     * 문 벽 앞에서 한 뼘 끊는다 — 열린 문짝이 그 틈으로 방 쪽에 밀려 들어간다. */
    {
      const zEnd = bDoorZ - bDz * (WALL_T / 2 + 0.14);
      solid(bInner - bSide * 0.1, (bZA + zEnd) / 2, Math.abs(zEnd - bZA) / 2, 0.1, yB, bRise, true, 'building');
    }
    /* 1층에서 구멍으로 떨어지지 않게 난간 세 변 (높은 끝 = 들어가는 쪽은 비운다) */
    solid(bInner - bSide * RAIL_T / 2, (bZA + bLowZ) / 2, bRun / 2, RAIL_T / 2, y0, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(bOuter + bSide * RAIL_T / 2, (bZA + bLowZ) / 2, bRun / 2, RAIL_T / 2, y0, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(bXc, bLowZ + bDz * RAIL_T / 2, BASEMENT_HALL_HALF, RAIL_T / 2, y0, RAIL_H, false, 'building', METAL_DARK, METAL);

    /* 문 벽: 문 위 상인방 + 문틀 기둥 (문짝은 `Structures` 가 단다) */
    solid(bXc, bDoorZ, BASEMENT_HALL_HALF, WALL_T / 2, yB + DOOR_H, (y0 - SLAB_T) - (yB + DOOR_H), false, 'building');
    // 문틀: 구덩이 벽 쪽 기둥 + 위 가로대 (방 쪽 기둥은 두지 않는다 — 문짝이 그쪽으로 밀려 나간다)
    solid(bXc + bSide * (BASEMENT_HALL_HALF - 0.06), bDoorZ, 0.08, WALL_T / 2 + 0.05, yB, DOOR_H, false, null, METAL_DARK, METAL);
    solid(bXc, bDoorZ, BASEMENT_HALL_HALF, WALL_T / 2 + 0.05, yB + DOOR_H - 0.1, 0.12, false, null, METAL_DARK, METAL);
    {
      const [dx, dz] = rot(bXc, bDoorZ);
      const slide = 2 * BASEMENT_HALL_HALF + 0.15;
      const [sx, sz] = dirW(-bSide * slide, 0);
      const [rx, rz] = rot(bInner + bSide * 0.22, bDoorZ - bDz * 0.75);
      const [ix, iz] = rot(bXc, bDoorZ - bDz * 0.85);
      door = {
        x: dx, y: yB, z: dz, yaw, halfW: BASEMENT_HALL_HALF - 0.08, height: DOOR_H - 0.04, thick: 0.18,
        slideX: sx, slideZ: sz,
        reader: { x: rx, z: rz, yaw: yaw + (bSide > 0 ? 0 : Math.PI) },
        interact: { x: ix, y: yB, z: iz },
      };
    }

    /* 지하실 조명: 문 너머 방 한가운데 + 복도 옆 방 (발광 판 + 광원 자리) + 복도 천장 발광 띠 */
    const ceilY = y0 - SLAB_T;
    const farEdge = bDz > 0 ? pitInZ : -pitInZ;
    const roomA = { x: -bSide * pitInX * 0.3, z: (bDoorZ + bDz * WALL_T / 2 + farEdge) / 2 };
    const roomB = { x: (bInner - bSide * 0.2 + -bSide * pitInX) / 2, z: (bZA + bDoorZ) / 2 };
    for (const r of [roomA, roomB]) {
      const [wx, wz] = rot(r.x, r.z);
      const g = new THREE.BoxGeometry(1.3, 0.07, 0.45);
      xform(g, { x: wx, y: ceilY - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
      fixtures.push({ x: wx, y: ceilY - 0.35, z: wz, color: lightColor, intensity: LIGHT_INTENSITY * 0.8, distance: LIGHT_DISTANCE });
    }
    {
      const [wx, wz] = rot(bXc, (bLowZ + bDoorZ) / 2);
      const g = new THREE.BoxGeometry(0.12, 0.06, Math.abs(bDoorZ - bLowZ) + 0.6);
      xform(g, { x: wx, y: ceilY - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }

    /* 지하실 컨테이너 자리 (벽을 등지고, 복도 · 문 앞은 비운다) */
    {
      const corridor = rect(bOuter, bInner - bSide * 1.1, bZA - bDz * 0.3, bDoorZ + bDz * 2.0);
      const cand: Spot[] = [];
      const inset = 0.8;
      for (let lx = -pitInX + inset; lx <= pitInX - inset; lx += 2.0) {
        for (const [lz, f] of [[-pitInZ + inset, Math.PI / 2], [pitInZ - inset, -Math.PI / 2]] as [number, number][]) {
          if (inRect(corridor, lx, lz)) continue;
          const [wx, wz] = rot(lx, lz);
          cand.push({ x: wx, y: yB, z: wz, yaw: yaw + f });
        }
      }
      for (let lz = -pitInZ + inset * 2; lz <= pitInZ - inset * 2; lz += 2.0) {
        for (const [lx, f] of [[-pitInX + inset, 0], [pitInX - inset, Math.PI]] as [number, number][]) {
          if (inRect(corridor, lx, lz)) continue;
          const [wx, wz] = rot(lx, lz);
          cand.push({ x: wx, y: yB, z: wz, yaw: yaw + f });
        }
      }
      for (let i = cand.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
      basementSpots.push(...cand.slice(0, Math.max(0, plan.basementContainers)));
    }
  }

  /* ── 지상 층의 비울 자리 ───────────────────────────────────────────────── */
  const exclusions = (k: number): Rect[] => {
    const ex: Rect[] = [];
    if (hasPartition) ex.push(rect(passX - DOOR_W * 0.8, passX + DOOR_W * 0.8, partZ - 1.5, partZ + 1.5));
    if (k === 0) {
      ex.push(rect(doorX - DOOR_W, doorX + DOOR_W, -id, -id + 1.6));
      if (breachSide === 0) ex.push(rect(breachAt * halfW * 2 - 2.2, breachAt * halfW * 2 + 2.2, id - 1.6, id));
      if (breachSide === 1) ex.push(rect(-iw, -iw + 1.6, breachAt * halfD * 2 - 2.2, breachAt * halfD * 2 + 2.2));
      if (breachSide === 2) ex.push(rect(iw - 1.6, iw, breachAt * halfD * 2 - 2.2, breachAt * halfD * 2 + 2.2));
      if (floors === 2) ex.push(grow(rect(sOuter, sInner - stairSide * 0.3, sBottomZ - stairRoom * 1.6, sTopZ), 0.2));
      if (pit) ex.push(grow(rect(bOuter, bInner, bZA - bDz * 1.6, bLowZ), 0.9));
    }
    if (k === 1) ex.push(grow(rect(sOuter, sInner, sBottomZ, sTopZ + stairRoom * 1.6), 0.5));
    if (k === topK) ex.push(grow(ladderZone, 0.2));
    return ex;
  };

  /* ── 실내 소품 (연구실은 작업대, 전진기지는 탄약 팔레트) ──────────────────── */
  for (let k = 0; k < floors; k++) {
    const ex = exclusions(k);
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const lx = rng.range(-iw + 1.6, iw - 1.6), lz = rng.range(-id + 1.6, id - 1.6);
      if (ex.some((r) => inRect(grow(r, 0.8), lx, lz))) continue;
      if (hasPartition && Math.abs(lz - partZ) < 1.3) continue;
      const [px, pz] = rot(lx, lz);
      const g = lab
        ? new THREE.BoxGeometry(rng.range(1.6, 2.6), 0.9, 0.8)
        : new THREE.BoxGeometry(rng.range(1.0, 1.6), rng.range(0.5, 0.9), rng.range(0.9, 1.4));
      xform(g, { x: px, y: levelY(k) + 0.45, z: pz }, new THREE.Euler(0, -(yaw + rng.range(-0.4, 0.4)), 0));
      paint(g, lab ? METAL : RUST, 0.1, rng);
      parts.push(g);
      ctx.hash.add(new THREE.Vector3(px, levelY(k), pz), 0.7, 0.9, 'building');
    }
  }

  /* ── 컨테이너 자리 (층마다 벽을 따라) ─────────────────────────────────────── */
  const floorSpots: { spot: Spot; room: string; rx: number; rz: number; k: number }[] = [];
  for (let k = 0; k < floors; k++) {
    const yk = levelY(k);
    const ex = exclusions(k);
    const inset = 1.15;
    const push = (lx: number, lz: number, facing: number): void => {
      if (ex.some((r) => inRect(r, lx, lz))) return;
      const [wx, wz] = rot(lx, lz);
      const back = hasPartition && lz > partZ;
      floorSpots.push({ spot: { x: wx, y: yk, z: wz, yaw: yaw + facing }, room: `${k}${back ? 'b' : 'f'}`, rx: lx, rz: lz, k });
    };
    const step = 2.1;
    for (let lx = -halfW + inset; lx <= halfW - inset; lx += step) {
      push(lx, -halfD + inset, Math.PI / 2);
      push(lx, halfD - inset, -Math.PI / 2);
      if (hasPartition) {
        push(lx, partZ - inset, -Math.PI / 2);
        push(lx, partZ + inset, Math.PI / 2);
      }
    }
    for (let lz = -halfD + inset * 2; lz <= halfD - inset * 2; lz += step) {
      if (hasPartition && Math.abs(lz - partZ) < 1.0) continue;
      push(-halfW + inset, lz, 0);
      push(halfW - inset, lz, Math.PI);
    }
  }
  for (let i = floorSpots.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = floorSpots[i]; floorSpots[i] = floorSpots[j]; floorSpots[j] = t;
  }
  const chosen = floorSpots.slice(0, Math.max(0, plan.containers));

  /* 컨테이너가 있는 방마다 천장 조명 한 개 (발광 판 + 광원 자리) */
  {
    const rooms = new Set(chosen.map((c) => c.room));
    for (const room of rooms) {
      const k = Number(room[0]);
      const back = room[1] === 'b';
      const z0 = hasPartition ? (back ? partZ + WALL_T / 2 : -id) : -id;
      const z1 = hasPartition ? (back ? id : partZ - WALL_T / 2) : id;
      // 조명은 계단 쪽을 피해 방 한가운데 조금 옆에 (2층 바닥 구멍 밑에 발광 판이 뜨지 않게)
      const lx = floors === 2 ? -stairSide * iw * 0.3 : 0;
      const lz = (z0 + z1) / 2;
      const ceil = levelY(k) + H;
      const [wx, wz] = rot(lx, lz);
      const g = new THREE.BoxGeometry(1.4, 0.07, 0.5);
      xform(g, { x: wx, y: ceil - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
      fixtures.push({ x: wx, y: ceil - 0.4, z: wz, color: lightColor, intensity: LIGHT_INTENSITY, distance: LIGHT_DISTANCE });
    }
  }

  /* ── 옥상의 맵 스캐너 자리 ────────────────────────────────────────────────── */
  let consoleSpot: Spot | null = null;
  {
    const [ex, ez] = [ladderX, mountZ - ladderSide * (WALL_T / 2 + 0.85)];
    for (let a = 0; a < 60 && !consoleSpot; a++) {
      const lx = rng.range(-iw + 1.6, iw - 1.6), lz = rng.range(-id + 1.6, id - 1.6);
      if (inRect(grow(hatch, 1.8), lx, lz)) continue;
      if (Math.hypot(lx - ex, lz - ez) < 2.5) continue;
      const [wx, wz] = rot(lx, lz);
      // 옥상 한가운데를 보게 (등은 난간벽 쪽)
      consoleSpot = { x: wx, y: roofY, z: wz, yaw: Math.atan2(cz - wz, cx - wx) - Math.PI / 2 };
    }
    if (!consoleSpot) {
      const [wx, wz] = rot(-ladderX * 0.5, -mountZ * 0.5 - ladderSide * 3);
      consoleSpot = { x: wx, y: roofY, z: wz, yaw };
    }
    // 안테나 마스트 (그림만, 콜라이더 없음 — 옥상 가장자리)
    const ax = stairSide * (iw - 0.8), az = -id + 0.8;
    solid(ax, az, 0.08, 0.08, roofY, 3.2, false, null, METAL_DARK, METAL);
    solid(ax, az, 0.5, 0.04, roofY + 2.6, 0.06, false, null, METAL, METAL);
    const [mx, mz] = rot(ax, az);
    const tip = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    xform(tip, { x: mx, y: roofY + 3.25, z: mz });
    glow.push(tip);
  }

  return {
    parts, glow,
    containers: chosen.map((c) => c.spot),
    basementContainers: basementSpots,
    console: consoleSpot, door, basementY: pit ? yB : y0,
    ladders, windows, fixtures, floors, roofY,
  };
}

/**
 * 불시착한 함선. 지하실은 없고, **위가 찢겨 열린** 동체가 곧 방이다 — 천장이 없으니 옥상도 스캐너도 없다
 * (2026-09-11 사용자 결정: 맵 스캐너는 전진기지 · 연구실 옥상에만). 컨테이너가 있으므로 비상등 광원 자리 하나.
 */
export function buildWreck(ctx: BuildCtx, plan: BuildingPlan, rng: Random): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD, wallH } = plan;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];

  /* 바닥 (동체 데크) — 그린 판이 곧 서는 판 */
  {
    const fx = halfW + FLOOR_OVERHANG, fz = halfD + FLOOR_OVERHANG;
    const [wx, wz] = rot(0, 0);
    const g = new THREE.BoxGeometry(fx * 2, SLAB_T, fz * 2);
    xform(g, { x: wx, y: y0 + FLOOR_LIP - SLAB_T / 2, z: wz }, new THREE.Euler(0, -yaw, 0));
    paint(g, METAL_DARK, 0.05, rng);
    parts.push(g);
    ctx.hash.addBox(new THREE.Vector3(wx, y0 - SLAB_T, wz), fx, fz, yaw, SLAB_T, 'slab');
  }

  // 옆판 (앞으로 갈수록 좁아진다) — 세 토막씩
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const t0 = -halfD + (i / 3) * halfD * 2, t1 = -halfD + ((i + 1) / 3) * halfD * 2;
      if (s < 0 && i === 1 && rng.chance(0.55)) continue;      // 찢겨 나간 옆구리 = 입구
      const mid = (t0 + t1) / 2;
      const shrink = 1 - Math.max(0, mid / halfD) * 0.35;
      const lx = s * halfW * shrink;
      const h = wallH * (0.75 + 0.25 * shrink);
      const [wx, wz] = rot(lx, mid);
      const byaw = yaw + Math.PI / 2;
      const g = new THREE.BoxGeometry((t1 - t0), h, 0.4);
      xform(g, { x: wx, y: y0 + h / 2, z: wz }, new THREE.Euler(0, -byaw, s * 0.12));
      paintGradient(g, METAL_DARK, METAL, y0, y0 + h);
      parts.push(g);
      ctx.hash.addBox(new THREE.Vector3(wx, y0, wz), (t1 - t0) / 2, 0.24, byaw, h, 'building');
    }
  }

  // 후미 격벽 (열린 램프)
  {
    for (const s of [-1, 1]) {
      const seg = halfW - DOOR_W / 2;
      if (seg < 0.4) break;
      const [px, pz] = rot(s * (halfW - seg / 2), -halfD);
      const g = new THREE.BoxGeometry(seg, wallH, 0.4);
      xform(g, { x: px, y: y0 + wallH / 2, z: pz }, new THREE.Euler(0, -yaw, 0));
      paintGradient(g, METAL_DARK, METAL, y0, y0 + wallH);
      parts.push(g);
      ctx.hash.addBox(new THREE.Vector3(px, y0, pz), seg / 2, 0.2, yaw, wallH, 'building');
    }
    const [rx, rz] = rot(0, -(halfD + FLOOR_OVERHANG + 1.2));
    const ramp = new THREE.BoxGeometry(DOOR_W, 0.16, 2.6);
    xform(ramp, { x: rx, y: y0 - 0.16, z: rz }, new THREE.Euler(0.16, -yaw, 0));
    paint(ramp, METAL, 0.06, rng);
    parts.push(ramp);
  }

  // 기수 (구겨진 원뿔) · 엔진 나셀 · 부러진 날개 — 전부 실루엣
  {
    const nose = new THREE.CylinderGeometry(halfW * 0.42, halfW * 0.9, halfD * 0.8, 7);
    const [nx, nz] = rot(0, halfD + halfD * 0.32);
    xform(nose, { x: nx, y: y0 + wallH * 0.45, z: nz }, new THREE.Euler(Math.PI / 2 + 0.18, -yaw, 0));
    paintGradient(nose, METAL, METAL_DARK);
    parts.push(nose);
    for (const s of [-1, 1]) {
      const wing = new THREE.BoxGeometry(halfW * 1.5, 0.3, halfD * 0.6);
      const [px, pz] = rot(s * halfW * 1.5, -halfD * 0.25);
      xform(wing, { x: px, y: y0 + 0.5, z: pz }, new THREE.Euler(0, -yaw, s * rng.range(0.2, 0.5)));
      paint(wing, s < 0 ? RUST : METAL, 0.09, rng);
      parts.push(wing);
      const nacelle = new THREE.CylinderGeometry(0.7, 0.85, 2.4, 8);
      const [ex, ez] = rot(s * halfW * 1.7, -halfD * 0.7);
      xform(nacelle, { x: ex, y: y0 + 0.7, z: ez }, new THREE.Euler(Math.PI / 2, -yaw, 0));
      paint(nacelle, METAL_DARK, 0.06, rng);
      parts.push(nacelle);
      ctx.hash.add(new THREE.Vector3(ex, y0, ez), 0.8, 1.5, 'building');
    }
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.18, 0.12, 0.5);
      const [px, pz] = rot(s * halfW * 0.85, halfD * 0.3);
      xform(g, { x: px, y: y0 + wallH * 0.8, z: pz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }
  }

  // 컨테이너 자리 — 데크를 따라
  const spots: Spot[] = [];
  for (let lz = -halfD + 1.6; lz <= halfD - 1.6; lz += 2.0) {
    for (const s of [-1, 1]) {
      const [wx, wz] = rot(s * (halfW - 1.1), lz);
      spots.push({ x: wx, y: y0, z: wz, yaw: yaw + (s < 0 ? 0 : Math.PI) });
    }
  }
  for (let i = spots.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = spots[i]; spots[i] = spots[j]; spots[j] = t; }

  const [fxw, fzw] = rot(0, halfD * 0.3);
  const fixtures: LightFixture[] = [{ x: fxw, y: y0 + wallH * 0.75, z: fzw, color: 0xff9a78, intensity: LIGHT_INTENSITY * 0.7, distance: LIGHT_DISTANCE }];

  return {
    parts, glow, containers: spots.slice(0, Math.max(0, plan.containers)), basementContainers: [], console: null, door: null,
    basementY: y0, ladders: [], windows: [], fixtures, floors: 1, roofY: Number.NaN,
  };
}

/** 컨테이너 · 콘솔 · 문이 쓰는 색 (파트 밖에서도 같은 팔레트를 쓰도록 내보낸다). */
export const PALETTE = { CONCRETE, CONCRETE_DARK, METAL, METAL_DARK, RUST };

/** `parts` 를 하나로 합친다. 비어 있으면 null (빈 geometry 로 머지하면 three 가 던진다). */
export function mergeOrNull(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  return merge(parts);
}
