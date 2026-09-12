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
 *  - 무작위로 **2층**이다 (`upperChance`). 1층 → 2층은 **실내 계단**, 맨 위층 → 옥상은
 *    격벽에 붙은 **사다리**와 옥상 바닥의 해치 구멍이다 (1층 건물도 옥상이 있다).
 *  - **맵 스캐너는 언제나 옥상**에 선다.
 *  - 층마다 바깥벽의 무작위 자리에 **창문**이 있다 (`parts/Glass` — 총알 · 투척물에 깨진다).
 *  - 컨테이너가 놓인 방마다 천장 조명(발광 판 + 광원 자리 `LightFixture`)이 달린다.
 *  - **지하실**은 흙구덩이가 아니라 방이다: 바닥판 · 벽 · 천장 · 조명. 들어가는 길은 1층 바닥의 계단 구멍 →
 *    양옆이 벽인 **계단 복도** → 층계참 → **서 있는 문**(키카드). 예전의 바닥 해치는 없다.
 *  - 계단은 전부 **경사 콜라이더**(`parts/Stairs`) — 한 단씩 튀지 않는다.
 *
 * ## 2026-09-12 — 드나드는 자리를 먼저 비운다 (사용자 보고 4건)
 *  ① 1층 → 2층 계단 입구가 0.8 m 틈(몸 지름 0.9 m)이라 **1층에서 들어갈 수 없었다** → 층계참 `STAIR_LANDING` 1.6 m,
 *     그리고 1층의 방 쪽 벽을 걷었다 (계단 덩어리 자체가 밑까지 막혀 있어 벽이 필요 없다 — 방에서 계단이 보인다).
 *  ② 무너진 틈이 계단이 붙은 바깥벽에 뚫리면 계단이 **밖으로만** 열렸다 → 틈은 계단 덩어리 · 층계참을 피한다.
 *     창문도 모든 층에서 계단 구간을 피한다.
 *  ③ 지하 계단 구멍의 난간이 정문 · 격벽 통로 **바로 앞**을 막았다 → 출입구마다 앞마당(`OPENING_APPROACH`)을 두고
 *     구멍 + 난간이 그것과 겹치는 자리는 고르지 않는다. 격벽 통로는 구멍 자리를 고른 **뒤에** 그 앞을 피해 고른다.
 *  ④ 보이지 않는 벽: 실내 작업대 · 팔레트는 0.7 m 원기둥이었다(길이 2.6 m 회전 상자 밑) → 그린 상자 그대로.
 *     불시착 함선의 기수 · 날개 · 램프 · 엔진은 콜라이더가 없거나 달랐다 → 그린 메시에서 잰다 (`fitBox` · `propHullOf`).
 * rng 쓰는 순서가 바뀌었으므로 같은 시드의 건물 **안쪽** 배치는 2026-09-11 과 다르다 (부지 · 크기 · 층수 · 지하실
 * 유무는 `layout.ts` 라 그대로다). 도달성은 `scripts/smoke-structure-reach.mjs` 가 여러 시드로 잰다.
 *
 * ## 2026-09-12 — 연구소 잠긴 방 · 지상드론 개구멍 (소모형 만능 열쇠)
 *  - 연구소는 지하실이 없다. **2층이 올라간 연구소**의 2층 모서리 하나에 **잠긴 방**(바깥벽 두 면 + 안벽 두 면)을 세운다 —
 *    계단 구멍 · 도착 자리 · 사다리/해치 구역 · 격벽 통로 앞마당을 피하고, 문 앞마당(`OPENING_APPROACH`)을 비운다.
 *    자리는 전용 rng(`plan.lockRng`)로 고르므로 건물 본래의 추첨 스트림을 밀지 않는다. 자리가 없으면 방이 없다.
 *  - 잠긴 문(지하실 문 · 잠긴 방 문) **바로 옆 벽 하단에 개구멍**: 벽 토막 사이의 틈 + 인방(밑면 = 바닥 + `VENT_H`).
 *    사람 · 적은 인방에 밀리고, 키를 넘기는 지상드론만 지나간다 (`WorldRef.resolveCollision(p, r, height)`).
 *    지하실은 문 앞 층계참 구간의 **복도 옆벽**(복도 ↔ 지하실 방)에, 잠긴 방은 **문 벽**에 뚫는다. 문이 열려도 그대로다.
 *
 * 3인칭 카메라가 천장에 갇히는 문제는 `player/CameraRig` 가 이미 `world.raycast` 로 당겨 오므로 특례가 없다.
 */
import * as THREE from 'three';
import type { LightFixture, Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import { propHullOf } from '../../propHull';
import {
  BASEMENT_FLOOR_T, BASEMENT_HALL_HALF, BASEMENT_LANDING, DOOR_H, DOOR_W, FLOOR_LIP, FLOOR_OVERHANG, HATCH_D, HATCH_W,
  LADDER_STANDOFF, LOCKED_DOOR_W, LOCKED_ROOM_DEPTH, LOCKED_ROOM_LEN, OPENING_APPROACH, PARAPET_H, RAIL_H, RAIL_T, SLAB_T,
  STAIR_ARRIVAL, STAIR_LANDING, STAIR_SLOPE, STAIR_W, VENT_H, VENT_MARGIN, VENT_POST, VENT_W,
  WALL_T, WINDOW_SILL, WINDOW_TOP, WINDOW_W,
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
  /** 2026-09-12: 2층 잠긴 방의 컨테이너 수 (0 = 방을 세우지 않는다). 2층이 실제로 올라갔을 때만 방이 선다. */
  lockedContainers: number;
  /** 잠긴 방 자리 고르기 전용 rng (건물 본래의 스트림을 밀지 않으려고 따로 받는다). 없으면 방을 세우지 않는다. */
  lockRng: Random | null;
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

/**
 * 2026-09-12 — 건물 **안내**: 도달성 스모크 · 디버그만 읽는다 (월드의 판정은 이것을 보지 않는다).
 * `[lx, lz]` 는 건물 로컬 좌표이고 월드로는 `(cx + lx·cos − lz·sin, cz + lx·sin + lz·cos)` 다.
 */
export interface StructureNav {
  cx: number; cz: number; yaw: number; halfW: number; halfD: number;
  /** 지상 층 바닥 높이 (`levels[k]`, k = 0 · 1). */
  levels: number[];
  /** 정문(불시착 함선은 후미 램프) 바깥 한 걸음 · 안쪽 한 걸음. */
  doorOut: [number, number];
  doorIn: [number, number];
  /** 방 사각형 (층 `k`) — 걸을 수 있는 칸이 얼마나 이어져 있는지 재는 단위. 불시착 함선은 비어 있다. */
  rooms: { k: number; x0: number; x1: number; z0: number; z1: number }[];
  /** 1층 계단 층계참 · 2층 도착 자리 (2층 건물만). */
  stairBottom: [number, number] | null;
  stairTop: [number, number] | null;
  /** 무너진 틈 (없으면 null) — side 0 북 · 1 서 · 2 동, `c` = 벽을 따라간 가운데. */
  breach: { side: number; c: number } | null;
  /** 2026-09-12: 2층 잠긴 방의 안쪽 사각형 (층 `k`), 없으면 null. 잠긴 동안 사람이 닿지 못해야 하는 칸이다. */
  locked: { k: number; x0: number; x1: number; z0: number; z1: number } | null;
  /** 2026-09-12: 지상드론 개구멍마다 문 쪽(`out`) · 방 쪽(`in`) 한 걸음과 바닥 높이 `y`. */
  vents: { out: [number, number]; in: [number, number]; y: number }[];
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
  /** 2026-09-12: 2층 잠긴 방 문 (방이 없으면 null) · 그 방의 컨테이너 자리. 한 건물에 지하실 문과 함께 서지 않는다. */
  lockedDoor: DoorSpot | null;
  lockedContainers: Spot[];
  /** 지하실 바닥 높이 (지하실이 없으면 y0). */
  basementY: number;
  ladders: LadderSpot[];
  windows: WindowSpec[];
  fixtures: LightFixture[];
  /** 실제로 세운 지상 층수. */
  floors: number;
  /** 옥상 바닥 높이 (없으면 NaN). */
  roofY: number;
  nav: StructureNav;
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

/** 1층 바깥벽의 무너진 틈 폭 · 높이(m). */
const BREACH_W = 3.2;
const BREACH_H = 2.9;

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
 * 2026-09-12 — **이미 월드로 옮긴** 지오메트리를 `frameYaw`(수학 규약, 로컬 +X = `(cos, sin)`) 축에 맞춘 상자로 잰다.
 * 기울거나 구른 메시(불시착 함선의 옆판 · 엔진)에 콜라이더를 손으로 맞추지 않고 그린 정점에서 곧장 뽑는다.
 */
function fitBox(g: THREE.BufferGeometry, frameYaw: number): { x: number; z: number; halfX: number; halfZ: number; yMin: number; yMax: number } {
  const pos = g.getAttribute('position');
  const c = Math.cos(frameYaw), s = Math.sin(frameYaw);
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = x * c + z * s, b = -x * s + z * c;
    if (a < aMin) aMin = a; if (a > aMax) aMax = a;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const am = (aMin + aMax) / 2, bm = (bMin + bMax) / 2;
  return { x: am * c - bm * s, z: am * s + bm * c, halfX: (aMax - aMin) / 2, halfZ: (bMax - bMin) / 2, yMin, yMax };
}

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

  /** 2026-09-12: 지상드론 개구멍마다 문 쪽 · 방 쪽 한 걸음 (도달성 스모크가 드론 몸 · 사람 몸으로 지나가 본다). */
  const vents: StructureNav['vents'] = [];
  /**
   * 2026-09-12 — 개구멍의 **그림**: 틀(윗대 + 양 기둥) + 방 쪽으로 들려 올라간 살창 덮개. 콜라이더는 없다 — 막는 것은
   * 벽 토막과 인방뿐이다. `c` 는 벽을 따라간 가운데, `thick` 은 벽 두께, `toward` 는 덮개가 들리는 쪽의 부호
   * (벽에 수직인 건물 축 — X 를 따라가는 벽이면 Z, Z 를 따라가는 벽이면 X). 덮개 아랫변은 드론 키보다 높게 들린다.
   */
  const ventDecor = (alongZ: boolean, fixed: number, c: number, yBase: number, thick: number, toward: number): void => {
    const at = (along: number): [number, number] => (alongZ ? [fixed, along] : [along, fixed]);
    {
      const [tx, tz] = at(c);
      solid(tx, tz, VENT_W / 2 + 0.07, thick / 2 + 0.04, yBase + VENT_H, 0.07, alongZ, null, METAL_DARK, METAL);
    }
    for (const s of [-1, 1]) {
      const [px, pz] = at(c + s * (VENT_W / 2 + 0.035));
      solid(px, pz, 0.035, thick / 2 + 0.04, yBase, VENT_H, alongZ, null, METAL_DARK, METAL);
    }
    const fh = VENT_H * 0.92;
    const pieces: THREE.BufferGeometry[] = [];
    const plateG = new THREE.BoxGeometry(VENT_W - 0.05, fh, 0.025);
    plateG.translate(0, -fh / 2, 0);
    pieces.push(plateG);
    for (let i = 0; i < 4; i++) {
      const slat = new THREE.BoxGeometry(VENT_W - 0.12, 0.035, 0.07);
      slat.translate(0, -fh * (0.16 + i * 0.22), 0.02);
      pieces.push(slat);
    }
    const flap = merge(pieces);
    for (const p of pieces) p.dispose();
    // 로컬 +Z 는 X 를 따라가는 벽이면 건물 +Z, Z 를 따라가는 벽이면 건물 −X 다 (`solid` 의 Euler 와 같은 규약).
    // rotateX(a) 는 아랫변을 로컬 −sign(a) Z 로 보낸다 → 원하는 쪽 부호의 반대로 돌린다. 1.4 rad 면 아랫변이 바닥 + 0.51 m.
    const localToward = toward * (alongZ ? -1 : 1);
    flap.rotateX(-localToward * 1.4);
    const [hx, hz] = rot(...at(c));
    xform(flap, { x: hx, y: yBase + VENT_H - 0.02, z: hz }, new THREE.Euler(0, -(yaw + (alongZ ? Math.PI / 2 : 0)), 0));
    paint(flap, METAL_DARK);   // rng 를 쓰지 않는다 — 지하실 개구멍이 건물 본래의 추첨 스트림을 밀면 안 된다
    parts.push(flap);
  };

  /* ── 배치 결정: 정문 → 격벽 · 실내 계단 · 지하 계단 구멍 · 격벽 통로 → 무너진 틈 ─────────────────────
   * 서로 부딪히는 제약: 계단이 들어갈 만큼 긴 방, 지하 계단 구멍이 격벽 밑을 지나가지 않을 것, 그 복도가 구덩이
   * 안에 들어갈 것, 그리고 (2026-09-12) **어느 출입구 앞마당도 막는 것과 겹치지 않을 것**. 격벽 자리를 여러 번 굴려
   * 전부를 한꺼번에 만족하는 것을 고른다. */
  const stairRise = H + SLAB_T;
  const stairRun = stairRise / STAIR_SLOPE;
  const needStairRoom = STAIR_LANDING + stairRun + STAIR_ARRIVAL;
  const bRise = pit ? pit.depth - BASEMENT_FLOOR_T : 0;
  const yB = y0 - bRise;
  const bRun = bRise / STAIR_SLOPE;
  const bLen = bRun + BASEMENT_LANDING + WALL_T;
  const pitInX = pit ? pit.halfX - 0.15 : 0, pitInZ = pit ? pit.halfZ - 0.15 : 0;

  let floors = plan.floors >= 2 ? 2 : 1;
  const stairSide = rng.chance(0.5) ? 1 : -1;
  const sOuter = stairSide * iw, sInner = stairSide * (iw - STAIR_W);
  const sXc = (sOuter + sInner) / 2;

  /* 정문은 격벽과 상관없이 남쪽 벽에 난다 — 먼저 정해 두고 나머지가 그 앞을 비운다. */
  const doorX = rng.range(-halfW * 0.45, halfW * 0.45);
  const frontZone = rect(doorX - DOOR_W / 2, doorX + DOOR_W / 2, -id, -id + OPENING_APPROACH);

  /** 1 → 2층 계단이 격벽 `pz` 의 `room` 쪽 방에 섰을 때: 덩어리(1층에서 막는 자리) · 층계참 + 방 쪽 들머리(비울 자리). */
  const stairAt = (pz: number, room: number): { face: number; bottom: number; top: number; body: Rect; landing: Rect } => {
    const face = pz + room * WALL_T / 2;
    const bottom = face + room * STAIR_LANDING;
    const top = bottom + room * stairRun;
    return {
      face, bottom, top,
      body: rect(sOuter, sInner, bottom, top),
      landing: rect(sOuter, sInner - stairSide * OPENING_APPROACH, face, bottom),
    };
  };
  /** 지하 계단 구멍 (`side` 쪽 구덩이 벽을 따라, 높은 끝 `zA` 에서 `dz` 로): 난간까지 막는 자리 · 입구 앞마당. */
  const holeAt = (side: number, dz: number, zA: number): { block: Rect; entry: Rect } => {
    const outer = side * pitInX, inner = side * (pitInX - 2 * BASEMENT_HALL_HALF);
    return {
      block: grow(rect(outer, inner, zA, zA + dz * bRun), RAIL_T + 0.05),
      entry: rect(outer, inner, zA - dz * OPENING_APPROACH, zA),
    };
  };
  /** 격벽 통로의 앞마당 (양쪽 방). */
  const passZoneAt = (pz: number, x: number): Rect =>
    rect(x - DOOR_W / 2, x + DOOR_W / 2, pz - WALL_T / 2 - OPENING_APPROACH, pz + WALL_T / 2 + OPENING_APPROACH);

  let partZ = 0;
  let hasPartition = true;
  let stairRoom = 1;                                      // +1 = 격벽 뒤(+Z) 방, −1 = 앞 방
  let stair = stairAt(0, 1);
  let bSide = -stairSide;
  let bDz = 1;
  let bZA = 0;
  let passX = 0;
  let relaxFront = false;
  const partMargin = WALL_T / 2 + 0.25;

  const tryLayout = (pz: number, fl: number, withPartition: boolean): boolean => {
    if (fl === 2) {
      const front = (pz - WALL_T / 2) + id;
      const back = id - (pz + WALL_T / 2);
      const opts: number[] = [];
      if (back >= needStairRoom) opts.push(1);
      if (front >= needStairRoom) opts.push(-1);
      const fit = opts.filter((r) => !overlaps(stairAt(pz, r).body, frontZone));
      if (fit.length === 0) return false;
      stairRoom = fit[rng.int(0, fit.length - 1)];
      stair = stairAt(pz, stairRoom);
    }
    /** 격벽 통로 후보 (계단 기둥에서 떨어지고, 지하 구멍이 그 앞을 막지 않는 자리). */
    const passOptions = (block: Rect | null): number[] => {
      const out: number[] = [];
      const lo = -iw + DOOR_W / 2 + 0.6, hi = iw - DOOR_W / 2 - 0.6;
      for (let x = lo; x <= hi + 1e-6; x += 0.25) {
        if (fl === 2 && Math.abs(x - sXc) < STAIR_W / 2 + DOOR_W / 2 + 0.4) continue;
        if (block && overlaps(passZoneAt(pz, x), block)) continue;
        out.push(x);
      }
      return out;
    };
    if (pit) {
      bSide = fl === 2 ? -stairSide : (rng.chance(0.5) ? 1 : -1);
      const cands: [number, number][] = [];
      for (const dz of [1, -1]) {
        for (let k = 0; k <= 40; k++) {
          const zA = dz > 0 ? -pitInZ + k * 0.25 : pitInZ - k * 0.25;
          const zLow = zA + dz * bRun, zEnd = zA + dz * bLen;
          const beyond = dz > 0 ? pitInZ - zEnd : zEnd + pitInZ;
          if (beyond < 2.4) break;
          const h = holeAt(bSide, dz, zA);
          if (h.entry.z0 < -id + 0.05 || h.entry.z1 > id - 0.05) continue;       // 입구 앞마당이 건물 안
          if (withPartition) {
            const h0 = Math.min(zA, zLow), h1 = Math.max(zA, zLow);
            if (pz + partMargin > h0 && pz - partMargin < h1) continue;           // 구멍이 격벽 밑으로
            if (h.entry.z0 < pz + WALL_T / 2 && h.entry.z1 > pz - WALL_T / 2) continue;   // 앞마당을 격벽이 가른다
          }
          if (!relaxFront && overlaps(h.block, frontZone)) continue;             // 난간이 정문 앞을 막는다
          if (fl === 2 && (overlaps(h.block, stair.body) || overlaps(h.block, stair.landing) || overlaps(h.entry, stair.body))) continue;
          cands.push([dz, zA]);
        }
      }
      while (cands.length > 0) {
        const i = rng.int(0, cands.length - 1);
        const [dz, zA] = cands[i];
        if (withPartition) {
          const xs = passOptions(holeAt(bSide, dz, zA).block);
          if (xs.length === 0) { cands.splice(i, 1); continue; }
          passX = xs[rng.int(0, xs.length - 1)];
        }
        bDz = dz; bZA = zA;
        return true;
      }
      return false;
    }
    if (withPartition) {
      const xs = passOptions(null);
      if (xs.length === 0) return false;
      passX = xs[rng.int(0, xs.length - 1)];
    }
    return true;
  };
  let ok = false;
  for (let a = 0; a < 60 && !ok; a++) { partZ = rng.range(-halfD * 0.35, halfD * 0.3); ok = tryLayout(partZ, floors, true); }
  if (!ok && floors === 2) {
    floors = 1;
    for (let a = 0; a < 60 && !ok; a++) { partZ = rng.range(-halfD * 0.35, halfD * 0.3); ok = tryLayout(partZ, 1, true); }
  }
  if (!ok) {
    hasPartition = false; partZ = 0;
    if (!tryLayout(0, 1, false)) { relaxFront = true; tryLayout(0, 1, false); }
  }

  const levelY = (k: number): number => y0 + k * (H + SLAB_T);
  const topK = floors - 1;
  const roofY = levelY(floors);

  /* 실내 계단 (2층일 때) — 한쪽 바깥벽에 붙어 층계참에서 바깥벽(북 · 남) 쪽으로 오른다. */
  const stairFace = stair.face;
  const sBottomZ = stair.bottom;
  const sTopZ = stair.top;
  const stairRect = stair.body;
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
  const bBlock = pit ? holeAt(bSide, bDz, bZA).block : null;

  /* 무너진 틈 (1층 북 · 서 · 동 중 하나): 계단 덩어리 · 층계참 · 지하 구멍 앞을 피한다. 맞는 자리가 없으면 틈이 없다. */
  const breachZoneAt = (side: number, c: number): Rect =>
    side === 0 ? rect(c - BREACH_W / 2, c + BREACH_W / 2, id - OPENING_APPROACH, id)
      : side === 1 ? rect(-iw, -iw + OPENING_APPROACH, c - BREACH_W / 2, c + BREACH_W / 2)
        : rect(iw - OPENING_APPROACH, iw, c - BREACH_W / 2, c + BREACH_W / 2);
  let breach: { side: number; c: number } | null = null;
  for (let a = 0; a < 24 && !breach; a++) {
    const side = rng.int(0, 2);                 // 0 = 북, 1 = 서, 2 = 동 (1층만)
    const c = rng.range(-0.45, 0.45) * (side === 0 ? halfW : halfD) * 2;
    const zone = breachZoneAt(side, c);
    if (floors === 2 && (overlaps(zone, grow(stairRect, 0.3)) || overlaps(zone, stair.landing))) continue;
    if (bBlock && overlaps(zone, bBlock)) continue;
    breach = { side, c };
  }

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

  /* ── 2026-09-12: 2층 잠긴 방 자리 ──────────────────────────────────────────
   * 모서리(sx, sz) 하나에 붙인다. 좌표는 (u, b) 틀로 잰다 — u = 문 벽을 따라 옆 벽 쪽 끝(0)에서 바깥벽 쪽(L)으로,
   * b = 모서리의 바깥벽 안쪽 면(0)에서 안으로. 문 벽은 b = D + WALL_T/2, 옆 벽은 u = −WALL_T/2 에 선다.
   * `alongZ` = 문 벽이 로컬 Z 를 따라간다. 8 후보(모서리 4 × 문 벽 방향 2)를 전용 rng 로 섞어 처음 맞는 것을 쓴다. */
  interface LockPlan {
    sx: number; sz: number; alongZ: boolean;
    map: (u: number, b: number) => [number, number];
    block: Rect; yard: Rect; interior: Rect;
  }
  const LOCK_L = LOCKED_ROOM_LEN, LOCK_D = LOCKED_ROOM_DEPTH;
  const LOCK_U_VENT = VENT_MARGIN + VENT_W / 2;
  const LOCK_U_DOOR0 = VENT_MARGIN + VENT_W + VENT_POST;
  const LOCK_U_DOOR = LOCK_U_DOOR0 + LOCKED_DOOR_W / 2;
  let lock: LockPlan | null = null;
  if (floors === 2 && plan.lockedContainers > 0 && plan.lockRng) {
    const lr = plan.lockRng;
    const makeLock = (sx: number, sz: number, alongZ: boolean): LockPlan => {
      const map = (u: number, b: number): [number, number] => (alongZ
        ? [sx * (iw - b), sz * (id - LOCK_L + u)]
        : [sx * (iw - LOCK_L + u), sz * (id - b)]);
      const fr = (u0: number, u1: number, b0: number, b1: number): Rect => {
        const [xa, za] = map(u0, b0), [xb, zb] = map(u1, b1);
        return rect(xa, xb, za, zb);
      };
      return {
        sx, sz, alongZ, map,
        block: fr(-WALL_T, LOCK_L, 0, LOCK_D + WALL_T),
        yard: fr(0, LOCK_U_DOOR0 + LOCKED_DOOR_W, LOCK_D + WALL_T, LOCK_D + WALL_T + OPENING_APPROACH),
        interior: fr(0, LOCK_L, 0, LOCK_D),
      };
    };
    // 2층의 계단 구멍 + 난간 + 도착 자리 (도착한 사람은 안쪽 옆으로 빠져나가므로 넉넉히 비운다)
    const stairZone2 = rect(sOuter, sInner, sBottomZ - stairRoom * RAIL_T, sTopZ + stairRoom * STAIR_ARRIVAL);
    const ladderWall = hasPartition ? null : rect(ladderX - 1.6, ladderX + 1.6, mountZ - WALL_T / 2, mountZ + WALL_T / 2);
    const fits = (c: LockPlan): boolean => {
      if (overlaps(grow(c.block, 1.2), stairZone2) || overlaps(c.yard, grow(stairZone2, 0.3))) return false;
      if (overlaps(grow(c.block, 1.0), ladderZone) || overlaps(c.yard, grow(ladderZone, 0.2))) return false;
      if (ladderWall && (overlaps(grow(c.block, 1.0), ladderWall) || overlaps(c.yard, ladderWall))) return false;
      if (hasPartition) {
        const pz0 = partZ - WALL_T / 2, pz1 = partZ + WALL_T / 2;
        // 방 · 앞마당이 격벽 한쪽에만 있고, 방과 격벽 사이는 사람이 지나갈 만큼(1.2 m) 떨어진다 (죽은 틈을 만들지 않는다)
        const z0 = Math.min(c.block.z0, c.yard.z0), z1 = Math.max(c.block.z1, c.yard.z1);
        if (c.sz > 0 ? z0 < pz1 + 0.05 : z1 > pz0 - 0.05) return false;
        if (c.sz > 0 ? c.block.z0 - pz1 < 1.2 : pz0 - c.block.z1 < 1.2) return false;
        const pass = passZoneAt(partZ, passX);
        if (overlaps(grow(c.block, 0.6), pass) || overlaps(c.yard, pass)) return false;
      }
      return true;
    };
    const cands: LockPlan[] = [];
    for (const sx of [1, -1]) for (const sz of [1, -1]) for (const az of [false, true]) cands.push(makeLock(sx, sz, az));
    for (let i = cands.length - 1; i > 0; i--) { const j = lr.int(0, i); const t = cands[i]; cands[i] = cands[j]; cands[j] = t; }
    lock = cands.find(fits) ?? null;
  }

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
      if (breach) {
        const f = { c: breach.c, w: BREACH_W };
        const bOp: Opening = { ...f, y0: 0, y1: BREACH_H };
        if (breach.side === 0) { north.push(bOp); fN.push(f); }
        if (breach.side === 1) { west.push(bOp); fW.push(f); }
        if (breach.side === 2) { east.push(bOp); fE.push(f); }
      }
    }
    // 2026-09-12: 계단이 붙은 바깥벽에는 **어느 층이든** 계단 구간(층계참 포함)에 창을 내지 않는다
    if (floors === 2) (stairSide > 0 ? fE : fW).push({ c: (stairFace + sTopZ) / 2, w: Math.abs(sTopZ - stairFace) + 1.2 });
    // 2026-09-12: 잠긴 방이 붙은 바깥벽 두 면에는 창을 내지 않는다 (안벽이 창 한가운데에 붙지 않게, 방은 봉인된 금고다)
    if (k === 1 && lock) {
      const b = lock.block;
      (lock.sz > 0 ? fN : fS).push({ c: (b.x0 + b.x1) / 2, w: b.x1 - b.x0 + 0.8 });
      (lock.sx > 0 ? fE : fW).push({ c: (b.z0 + b.z1) / 2, w: b.z1 - b.z0 + 0.8 });
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

  /* ── 2026-09-12: 2층 잠긴 방 — 안벽 두 면 · 문(자리만, 문짝은 `Structures`) · 개구멍 · 조명 · 컨테이너 자리 ───── */
  let lockedDoor: DoorSpot | null = null;
  const lockedSpots: Spot[] = [];
  if (lock) {
    const L = LOCK_L, D = LOCK_D;
    const y1 = levelY(1);
    const wallB = D + WALL_T / 2;
    /** 문 벽 위의 u 를 그 벽이 따라가는 로컬 좌표로. */
    const along = (u: number): number => { const [x, z] = lock!.map(u, wallB); return lock!.alongZ ? z : x; };
    const [fx, fz] = lock.map(0, wallB);
    const doorWallFixed = lock.alongZ ? fx : fz;
    const a0 = along(0), a1 = along(L);
    wallRun(lock.alongZ, doorWallFixed, Math.min(a0, a1), Math.max(a0, a1), y1, H, [
      { c: along(LOCK_U_VENT), w: VENT_W, y0: 0, y1: VENT_H },
      { c: along(LOCK_U_DOOR), w: LOCKED_DOOR_W, y0: 0, y1: DOOR_H },
    ]);
    // 옆 벽 (문 벽에 수직, 모서리 기둥 몫까지)
    {
      const sideAlongZ = !lock.alongZ;
      const [p0x, p0z] = lock.map(-WALL_T / 2, 0), [p1x, p1z] = lock.map(-WALL_T / 2, D + WALL_T);
      const fixed = sideAlongZ ? p0x : p0z;
      const s0 = sideAlongZ ? p0z : p0x, s1 = sideAlongZ ? p1z : p1x;
      wallRun(sideAlongZ, fixed, Math.min(s0, s1), Math.max(s0, s1), y1, H, []);
    }
    // 문틀: 양 문설주 + 윗대 (벽 면에서 조금 튀어나오므로 콜라이더를 건다 — 지하실 문틀과 같다)
    for (const u of [LOCK_U_DOOR0 - 0.08, LOCK_U_DOOR0 + LOCKED_DOOR_W + 0.08]) {
      const [px, pz] = lock.map(u, wallB);
      solid(px, pz, 0.08, WALL_T / 2 + 0.05, y1, DOOR_H, lock.alongZ, 'building', METAL_DARK, METAL);
    }
    {
      const [px, pz] = lock.map(LOCK_U_DOOR, wallB);
      solid(px, pz, LOCKED_DOOR_W / 2 + 0.16, WALL_T / 2 + 0.05, y1 + DOOR_H - 0.1, 0.12, lock.alongZ, 'building', METAL_DARK, METAL);
      // 문 위 경고등 띠 (그림만)
      const [gx, gz] = rot(...lock.map(LOCK_U_DOOR, D + WALL_T + 0.06));
      const lampG = new THREE.BoxGeometry(0.6, 0.1, 0.08);
      xform(lampG, { x: gx, y: y1 + DOOR_H + 0.25, z: gz }, new THREE.Euler(0, -(yaw + (lock.alongZ ? Math.PI / 2 : 0)), 0));
      glow.push(lampG);
    }
    ventDecor(lock.alongZ, doorWallFixed, along(LOCK_U_VENT), y1, WALL_T, lock.alongZ ? lock.sx : lock.sz);
    {
      const [ox, oz] = lock.map(LOCK_U_VENT, D + WALL_T + 0.8), [ix, iz] = lock.map(LOCK_U_VENT, D - 0.8);
      vents.push({ out: [ox, oz], in: [ix, iz], y: y1 });
    }
    // 문 (문짝은 벽 속 주머니 = +u 쪽으로 밀려 들어간다 — 문짝 두께 0.18 < 벽 두께라 열린 문짝은 벽 안에 숨는다)
    {
      const [dlx, dlz] = lock.map(LOCK_U_DOOR, wallB);
      const [dx, dz] = rot(dlx, dlz);
      const slide = LOCKED_DOOR_W + 0.02;
      const [sxw, szw] = lock.alongZ ? dirW(0, lock.sz * slide) : dirW(lock.sx * slide, 0);
      const [rx, rz] = rot(...lock.map(VENT_MARGIN + VENT_W + VENT_POST / 2, D + WALL_T + 0.08));
      const [ix, iz] = rot(...lock.map(LOCK_U_DOOR, D + WALL_T + 0.85));
      const byaw = yaw + (lock.alongZ ? Math.PI / 2 : 0);
      lockedDoor = {
        x: dx, y: y1, z: dz, yaw: byaw, halfW: LOCKED_DOOR_W / 2 - 0.06, height: DOOR_H - 0.04, thick: 0.18,
        slideX: sxw, slideZ: szw,
        reader: { x: rx, z: rz, yaw: byaw },
        interact: { x: ix, y: y1, z: iz },
      };
    }
    // 방 조명 (컨테이너가 있는 방이다 — 광원 풀의 자리 하나)
    {
      const [wx, wz] = rot(...lock.map(L / 2, D / 2));
      const g = new THREE.BoxGeometry(1.1, 0.07, 0.45);
      xform(g, { x: wx, y: y1 + H - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
      fixtures.push({ x: wx, y: y1 + H - 0.4, z: wz, color: lightColor, intensity: LIGHT_INTENSITY * 0.8, distance: LIGHT_DISTANCE });
    }
    // 컨테이너 자리: 바깥벽(b = 0)을 등지고 문 벽 쪽을 본다 — 층의 다른 컨테이너와 같은 인셋
    {
      const n = Math.min(4, plan.lockedContainers);
      const facing = lock.alongZ ? (lock.sx > 0 ? Math.PI : 0) : -lock.sz * Math.PI / 2;
      for (let i = 0; i < n; i++) {
        const [wx, wz] = rot(...lock.map(L * (i + 0.5) / n, 0.95));
        lockedSpots.push({ x: wx, y: y1, z: wz, yaw: yaw + facing });
      }
    }
  }

  /* 정문 상인방 장식 + 등 (그림만 — 문 높이 위라 머리에 닿지 않는다) */
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

  /* ── 사다리 (그림 — 매달리기는 `player/` 가 하므로 콜라이더를 두지 않는다) ─────────── */
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
    /* 2026-09-12: 1층의 방 쪽 벽(천장까지)을 걷었다. 계단 덩어리는 단마다 바닥에서 올라오는 통짜라 밑으로 들어갈 틈이
     * 없고, 낮은 쪽은 옆에서 올라서도 된다 — 벽은 입구를 0.8 m 틈 하나로 좁히고 방에서 계단을 가리기만 했다. */
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
      const wx = bInner - bSide * 0.1;
      /* 2026-09-12: 문 바로 앞 층계참 구간(계단 낮은 끝 ~ 벽 끝)의 가운데에 **지상드론 개구멍** — 벽 토막 둘 + 인방.
       * 복도 → 지하실 방으로 드론만 지나간다 (사람은 인방에 밀린다). 방 쪽 1.1 m 는 컨테이너 자리에서 이미 비어 있다. */
      const vc = (bLowZ + zEnd) / 2;
      const v0 = vc - VENT_W / 2, v1 = vc + VENT_W / 2;
      const zLo = Math.min(bZA, zEnd), zHi = Math.max(bZA, zEnd);
      const seg = (a: number, b: number, yb: number, h: number): void => {
        if (b - a > 0.05 && h > 0.03) solid(wx, (a + b) / 2, (b - a) / 2, 0.1, yb, h, true, 'building', CONCRETE_DARK, CONCRETE, yB, yB + bRise);
      };
      seg(zLo, v0, yB, bRise);
      seg(v0, v1, yB + VENT_H, bRise - VENT_H);
      seg(v1, zHi, yB, bRise);
      ventDecor(true, wx, vc, yB, 0.2, -bSide);
      vents.push({ out: [bInner + bSide * 0.6, vc], in: [bInner - bSide * 0.9, vc], y: yB });
    }
    /* 1층에서 구멍으로 떨어지지 않게 난간 세 변 (높은 끝 = 들어가는 쪽은 비운다) */
    solid(bInner - bSide * RAIL_T / 2, (bZA + bLowZ) / 2, bRun / 2, RAIL_T / 2, y0, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(bOuter + bSide * RAIL_T / 2, (bZA + bLowZ) / 2, bRun / 2, RAIL_T / 2, y0, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(bXc, bLowZ + bDz * RAIL_T / 2, BASEMENT_HALL_HALF, RAIL_T / 2, y0, RAIL_H, false, 'building', METAL_DARK, METAL);

    /* 문 벽: 문 위 상인방 + 문틀 기둥 (문짝은 `Structures` 가 단다) */
    solid(bXc, bDoorZ, BASEMENT_HALL_HALF, WALL_T / 2, yB + DOOR_H, (y0 - SLAB_T) - (yB + DOOR_H), false, 'building');
    // 문틀: 구덩이 벽 쪽 기둥 + 위 가로대 (방 쪽 기둥은 두지 않는다 — 문짝이 그쪽으로 밀려 나간다).
    // 2026-09-12: 그린 기둥 · 가로대에 콜라이더를 건다 (예전엔 그림뿐이라 기둥 모서리를 몸이 뚫었다).
    solid(bXc + bSide * (BASEMENT_HALL_HALF - 0.06), bDoorZ, 0.08, WALL_T / 2 + 0.05, yB, DOOR_H, false, 'building', METAL_DARK, METAL);
    solid(bXc, bDoorZ, BASEMENT_HALL_HALF, WALL_T / 2 + 0.05, yB + DOOR_H - 0.1, 0.12, false, 'building', METAL_DARK, METAL);
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
      if (breach) ex.push(grow(breachZoneAt(breach.side, breach.c), 0.6));
      if (floors === 2) ex.push(grow(stairRect, 0.2), grow(stair.landing, 0.2));
      if (pit) ex.push(grow(rect(bOuter, bInner, bZA - bDz * 1.6, bLowZ), 0.9));
    }
    if (k === 1) ex.push(grow(rect(sOuter, sInner, sBottomZ, sTopZ + stairRoom * 1.6), 0.5));
    if (k === 1 && lock) ex.push(grow(lock.block, 0.8), grow(lock.yard, 0.4));   // 2026-09-12: 잠긴 방 · 그 문 앞마당
    if (k === topK) ex.push(grow(ladderZone, 0.2));
    return ex;
  };

  /* ── 실내 소품 (연구실은 작업대, 전진기지는 탄약 팔레트) ────────────────────
   * 2026-09-12: 콜라이더는 **그린 상자 그대로**다. 예전엔 0.7 m 원기둥이라 긴 작업대의 양 끝은 뚫리고 앞면 30 cm 는
   * 보이지 않는 벽이었다. 높이가 `PROP_STEP_UP_MAX` 안이라 상자 규칙대로 올라설 수 있다. */
  for (let k = 0; k < floors; k++) {
    const ex = exclusions(k);
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const lx = rng.range(-iw + 1.6, iw - 1.6), lz = rng.range(-id + 1.6, id - 1.6);
      const w = lab ? rng.range(1.6, 2.6) : rng.range(1.0, 1.6);
      const h = lab ? 0.9 : rng.range(0.5, 0.9);
      const d = lab ? 0.8 : rng.range(0.9, 1.4);
      const pyaw = yaw + rng.range(-0.4, 0.4);
      const reach = Math.hypot(w, d) / 2;
      if (ex.some((r) => inRect(grow(r, reach + 0.3), lx, lz))) continue;
      if (hasPartition && Math.abs(lz - partZ) < WALL_T / 2 + reach + 0.6) continue;
      const [px, pz] = rot(lx, lz);
      const g = new THREE.BoxGeometry(w, h, d);
      xform(g, { x: px, y: levelY(k) + h / 2, z: pz }, new THREE.Euler(0, -pyaw, 0));
      paint(g, lab ? METAL : RUST, 0.1, rng);
      parts.push(g);
      ctx.hash.addBox(new THREE.Vector3(px, levelY(k), pz), w / 2, d / 2, pyaw, h, 'building');
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
      let lx = floors === 2 ? -stairSide * iw * 0.3 : 0;
      const lz = (z0 + z1) / 2;
      // 2026-09-12: 그 자리가 잠긴 방 안이면 방 밖으로 옮긴다 (방 조명은 잠긴 방이 따로 갖는다)
      if (k === 1 && lock && inRect(grow(lock.block, 0.5), lx, lz)) {
        const alt = [0, stairSide * iw * 0.3, -stairSide * iw * 0.6].find((x) =>
          !inRect(grow(lock!.block, 0.5), x, lz) && !inRect(grow(stairRect, 0.3), x, lz));
        if (alt !== undefined) lx = alt;
      }
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
    // 안테나 마스트 (옥상 가장자리). 2026-09-12: 마스트에 가는 콜라이더 — 예전엔 그림뿐이라 몸이 뚫고 지나갔다.
    const ax = stairSide * (iw - 0.8), az = -id + 0.8;
    solid(ax, az, 0.08, 0.08, roofY, 3.2, false, 'building', METAL_DARK, METAL);
    solid(ax, az, 0.5, 0.04, roofY + 2.6, 0.06, false, null, METAL, METAL);
    const [mx, mz] = rot(ax, az);
    const tip = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    xform(tip, { x: mx, y: roofY + 3.25, z: mz });
    glow.push(tip);
  }

  /* ── 안내 (스모크 · 디버그) ───────────────────────────────────────────────── */
  const rooms: StructureNav['rooms'] = [];
  for (let k = 0; k < floors; k++) {
    if (hasPartition) {
      rooms.push({ k, x0: -iw, x1: iw, z0: -id, z1: partZ - WALL_T / 2 });
      rooms.push({ k, x0: -iw, x1: iw, z0: partZ + WALL_T / 2, z1: id });
    } else {
      rooms.push({ k, x0: -iw, x1: iw, z0: -id, z1: id });
    }
  }
  const nav: StructureNav = {
    cx, cz, yaw, halfW, halfD,
    levels: Array.from({ length: floors }, (_, k) => levelY(k)),
    doorOut: [doorX, -halfD - FLOOR_OVERHANG - 1.4],
    doorIn: [doorX, -id + 0.8],
    rooms,
    stairBottom: floors === 2 ? [sXc, (stairFace + sBottomZ) / 2] : null,
    stairTop: floors === 2 ? [sXc, sTopZ + stairRoom * STAIR_ARRIVAL / 2] : null,
    breach,
    locked: lock ? { k: 1, ...lock.interior } : null,
    vents,
  };

  return {
    parts, glow,
    containers: chosen.map((c) => c.spot),
    basementContainers: basementSpots,
    console: consoleSpot, door, lockedDoor, lockedContainers: lockedSpots, basementY: pit ? yB : y0,
    ladders, windows, fixtures, floors, roofY, nav,
  };
}

/**
 * 불시착한 함선. 지하실은 없고, **위가 찢겨 열린** 동체가 곧 방이다 — 천장이 없으니 옥상도 스캐너도 없다
 * (2026-09-11 사용자 결정: 맵 스캐너는 전진기지 · 연구실 옥상에만). 컨테이너가 있으므로 비상등 광원 자리 하나.
 *
 * 2026-09-12 — 콜라이더를 **그린 메시에서** 잰다. 예전에는 ① 기울어진 옆판에 곧은 상자 ② 기수 · 날개 · 후미 램프에
 * 콜라이더 없음(기수를 뚫고 앞으로 걸어 나갔다) ③ 누운 엔진 나셀에 선 원기둥이었다. 그리고 기수 · 엔진은 Euler 순서가
 * `XYZ` 라 **월드 X 축**으로 눕혀져, 함선이 돌아가 있으면 동체와 다른 방향을 가리켰다 → `YXZ`(yaw 가 마지막).
 * 앞쪽 옆판이 안으로 좁아지는데 컨테이너 자리는 뒤쪽 폭을 써서 앞 컨테이너가 옆판 **바깥**에 서던 것도 고쳤다.
 */
export function buildWreck(ctx: BuildCtx, plan: BuildingPlan, rng: Random): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD, wallH } = plan;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];
  /** 동체 축(로컬 +Z) 의 수학 규약 yaw. */
  const axisYaw = yaw + Math.PI / 2;
  /** 옆판 토막 `i`(0 = 후미 · 2 = 앞) 가 앞으로 갈수록 좁아지는 비율. */
  const plateShrink = (i: number): number => {
    const mid = -halfD + ((i + 0.5) / 3) * halfD * 2;
    return 1 - Math.max(0, mid / halfD) * 0.35;
  };

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

  // 옆판 (앞으로 갈수록 좁아진다) — 세 토막씩. 콜라이더는 기울어진 판의 정점에서 잰 상자다.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const t0 = -halfD + (i / 3) * halfD * 2, t1 = -halfD + ((i + 1) / 3) * halfD * 2;
      if (s < 0 && i === 1 && rng.chance(0.55)) continue;      // 찢겨 나간 옆구리 = 입구
      const mid = (t0 + t1) / 2;
      const shrink = plateShrink(i);
      const lx = s * halfW * shrink;
      const h = wallH * (0.75 + 0.25 * shrink);
      const [wx, wz] = rot(lx, mid);
      const g = new THREE.BoxGeometry((t1 - t0), h, 0.4);
      xform(g, { x: wx, y: y0 + h / 2, z: wz }, new THREE.Euler(0, -axisYaw, s * 0.12));
      paintGradient(g, METAL_DARK, METAL, y0, y0 + h);
      parts.push(g);
      const f = fitBox(g, axisYaw);
      const base = Math.max(f.yMin, y0 - SLAB_T);
      ctx.hash.addBox(new THREE.Vector3(f.x, base, f.z), f.halfX, f.halfZ, axisYaw, f.yMax - base, 'building');
    }
  }

  // 후미 격벽 (열린 램프)
  let rampOut = -(halfD + FLOOR_OVERHANG + 3.4);
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
    /* 램프: 데크 끝(높은 끝 = 데크 윗면)에서 땅으로 내려가는 판. 동체 축을 따라 기울고(`rotateX` 가 먼저, yaw 가 나중),
     * 밟는 것은 같은 기울기의 경사 콜라이더다. */
    const len = 2.6, rise = 0.3, thick = 0.16;
    const highZ = -(halfD + FLOOR_OVERHANG - 0.1);
    const midZ = highZ - len / 2;
    const tilt = Math.atan2(rise, len);
    const topMid = y0 + FLOOR_LIP - rise / 2;
    const [rx, rz] = rot(0, midZ);
    const ramp = new THREE.BoxGeometry(DOOR_W, thick, len);
    ramp.rotateX(-tilt);
    xform(ramp, { x: rx, y: topMid - thick / 2, z: rz }, new THREE.Euler(0, -yaw, 0));
    paint(ramp, METAL, 0.06, rng);
    parts.push(ramp);
    const base = y0 - 0.8;
    ctx.hash.addRamp(new THREE.Vector3(rx, base, rz), len / 2, DOOR_W / 2, axisYaw, (y0 + FLOOR_LIP) - base, rise, 'building');
    rampOut = highZ - len - 1.4;
  }

  // 기수 (구겨진 원뿔) · 엔진 나셀 · 부러진 날개
  {
    const nose = new THREE.CylinderGeometry(halfW * 0.42, halfW * 0.9, halfD * 0.8, 7);
    const [nx, nz] = rot(0, halfD + halfD * 0.32);
    xform(nose, { x: nx, y: y0 + wallH * 0.45, z: nz }, new THREE.Euler(Math.PI / 2 + 0.18, -yaw, 0, 'YXZ'));
    paintGradient(nose, METAL, METAL_DARK);
    parts.push(nose);
    // 기수 콜라이더 = 땅 위로 보이는 원뿔의 볼록 윤곽 (바위 · 첨탑과 같은 측정)
    {
      const pc = propHullOf(ctx, nose, new THREE.Matrix4());
      if (pc) {
        const base = ctx.terrain.getHeightAt(pc.x, pc.z) - 0.3;
        ctx.hash.addHull(new THREE.Vector3(pc.x, base, pc.z), pc.hull, Math.max(0.1, pc.top - base), 'building');
      }
    }
    for (const s of [-1, 1]) {
      /* 날개: 동체 축을 도는 roll 로 바깥 끝이 들린 판. 밑으로 걸어 지나갈 수 있는 바깥쪽을 막지 않게, 길이를 토막 내어
       * 토막마다 **판 밑면부터** 윗면까지의 경사 콜라이더를 둔다 (한 덩어리 쐐기면 들린 날개 밑 허공이 벽이 된다). */
      const wingLen = halfW * 1.5, wingT = 0.3, wingD = halfD * 0.6;
      const wing = new THREE.BoxGeometry(wingLen, wingT, wingD);
      const wcx = s * halfW * 1.5, wcz = -halfD * 0.25, wcy = y0 + 0.5;
      const [px, pz] = rot(wcx, wcz);
      const roll = rng.range(0.2, 0.5);
      xform(wing, { x: px, y: wcy, z: pz }, new THREE.Euler(0, -yaw, s * roll));
      paint(wing, s < 0 ? RUST : METAL, 0.09, rng);
      parts.push(wing);
      {
        const segs = Math.max(2, Math.ceil(wingLen / 1.5));
        const sr = Math.sin(roll), cr = Math.cos(roll);
        const halfT = (wingT / 2) * cr;
        const ground = y0;
        for (let j = 0; j < segs; j++) {
          // v = 날개 가운데에서 바깥쪽으로 잰 길이 (바깥 끝이 높다)
          const v0 = -wingLen / 2 + (j / segs) * wingLen, v1 = -wingLen / 2 + ((j + 1) / segs) * wingLen;
          const topHi = wcy + v1 * sr + halfT;
          if (topHi <= ground - 0.05) continue;                  // 통째로 데크 · 땅 밑
          const under = wcy + v0 * sr - halfT;
          const base = Math.max(ground - 0.5, under);
          const [sx, sz] = rot(wcx + s * ((v0 + v1) / 2) * cr, wcz);
          ctx.hash.addRamp(new THREE.Vector3(sx, base, sz), ((v1 - v0) / 2) * cr, wingD / 2, s > 0 ? yaw : yaw + Math.PI,
            topHi - base, (v1 - v0) * sr, 'building');
        }
      }
      const nacelle = new THREE.CylinderGeometry(0.7, 0.85, 2.4, 8);
      const [ex, ez] = rot(s * halfW * 1.7, -halfD * 0.7);
      xform(nacelle, { x: ex, y: y0 + 0.7, z: ez }, new THREE.Euler(Math.PI / 2, -yaw, 0, 'YXZ'));
      paint(nacelle, METAL_DARK, 0.06, rng);
      parts.push(nacelle);
      const f = fitBox(nacelle, yaw);
      const base = Math.max(f.yMin, y0 - 0.5);
      ctx.hash.addBox(new THREE.Vector3(f.x, base, f.z), f.halfX, f.halfZ, yaw, f.yMax - base, 'building');
    }
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.18, 0.12, 0.5);
      const [px, pz] = rot(s * halfW * 0.85, halfD * 0.3);
      xform(g, { x: px, y: y0 + wallH * 0.8, z: pz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }
  }

  // 컨테이너 자리 — 데크를 따라, 그 자리 옆판의 안쪽 면에서 한 뼘
  const spots: Spot[] = [];
  for (let lz = -halfD + 1.6; lz <= halfD - 1.6; lz += 2.0) {
    const i = Math.max(0, Math.min(2, Math.floor(((lz + halfD) / (halfD * 2)) * 3)));
    const inner = halfW * plateShrink(i) - 1.1;
    for (const s of [-1, 1]) {
      const [wx, wz] = rot(s * inner, lz);
      spots.push({ x: wx, y: y0, z: wz, yaw: yaw + (s < 0 ? 0 : Math.PI) });
    }
  }
  for (let i = spots.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = spots[i]; spots[i] = spots[j]; spots[j] = t; }

  const [fxw, fzw] = rot(0, halfD * 0.3);
  const fixtures: LightFixture[] = [{ x: fxw, y: y0 + wallH * 0.75, z: fzw, color: 0xff9a78, intensity: LIGHT_INTENSITY * 0.7, distance: LIGHT_DISTANCE }];

  const nav: StructureNav = {
    cx, cz, yaw, halfW, halfD, levels: [y0],
    doorOut: [0, rampOut], doorIn: [0, -halfD + 1.2],
    rooms: [], stairBottom: null, stairTop: null, breach: null, locked: null, vents: [],
  };

  return {
    parts, glow, containers: spots.slice(0, Math.max(0, plan.containers)), basementContainers: [], console: null, door: null,
    lockedDoor: null, lockedContainers: [],
    basementY: y0, ladders: [], windows: [], fixtures, floors: 1, roofY: Number.NaN, nav,
  };
}

/** 컨테이너 · 콘솔 · 문이 쓰는 색 (파트 밖에서도 같은 팔레트를 쓰도록 내보낸다). */
export const PALETTE = { CONCRETE, CONCRETE_DARK, METAL, METAL_DARK, RUST };

/** `parts` 를 하나로 합친다. 비어 있으면 null (빈 geometry 로 머지하면 three 가 던진다). */
export function mergeOrNull(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  return merge(parts);
}
