/**
 * src/world/structures/parts/Build.ts — 버려진 구조물의 **지오메트리와 콜라이더**.
 *
 * `Structures` 클래스에서 떼어낸 메서드 묶음이고 상태는 없다. 여기서 만드는 것은
 * ① 병합용 지오메트리 조각, ② `SpatialHash` 에 들어가는 **사각(OBB) 콜라이더**, ③ 컨테이너 · 콘솔 · 해치가
 * 설 자리(월드 좌표)뿐이다.
 *
 * 규약 두 가지를 지킨다:
 *  - **콜라이더는 보이는 실루엣이다.** 벽 하나 = 상자 하나이고 크기는 그린 `BoxGeometry` 와 같은 수를 쓴다.
 *    원기둥으로 벽을 흉내내지 않는다 (예전 `Outposts` 가 그래서 톱니 같은 벽을 갖고 있다).
 *  - **회전 규약**: `Obstacle.box.yaw` 는 수학 규약(로컬 +X → 월드 `(cos, sin)`)이고, 같은 상자를 그리는
 *    메시의 Euler 는 그 부호를 뒤집은 `-yaw` 다 (three 의 Y 회전이 반대 손이다). 두 값이 어긋나면
 *    보이는 벽과 막는 벽이 갈라진다.
 */
import * as THREE from 'three';
import type { Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import { DOOR_W, PIT_BLEND, SLAB_T, STAIR_HALF, WALL_T } from '../model';

/** 구조물 한 채를 세우는 데 필요한 부지 정보 (`layout.StructureSite` 에서 옮겨 온다). */
export interface BuildingPlan {
  cx: number; cz: number; yaw: number;
  /** 지상층 바닥 높이 (패드 높이). */
  y0: number;
  halfW: number; halfD: number; wallH: number;
  pit: { halfX: number; halfZ: number; depth: number } | null;
}

/** 무언가가 설 자리 — 월드 좌표 + 벽을 등진 방향(수학 규약 yaw). */
export interface Spot { x: number; y: number; z: number; yaw: number }

export interface BuildingOut {
  parts: THREE.BufferGeometry[];
  glow: THREE.BufferGeometry[];
  containers: Spot[];
  basementContainers: Spot[];
  console: Spot;
  /** 지하실 해치 (지하실이 없으면 null). `halfX/halfZ` 는 뚜껑 = 계단 구멍의 반길이다. */
  hatch: (Spot & { halfX: number; halfZ: number }) | null;
  /** 지하실 바닥 높이 (지하실이 없으면 y0). */
  basementY: number;
}

const CONCRETE = new THREE.Color(0x7a7770);
const CONCRETE_DARK = new THREE.Color(0x4a4844);
const METAL = new THREE.Color(0x424750);
const METAL_DARK = new THREE.Color(0x24272c);
const RUST = new THREE.Color(0x6d4a30);

/**
 * 지상 건물(전진기지 · 연구실) 한 채. 벽 · 문틀 · 복도 격벽 · **무너진 지붕** · 지하실 구덩이 라이닝 ·
 * 천장 슬래브 · 계단 · 해치를 만들고, 컨테이너 · 콘솔 자리를 돌려준다.
 *
 * **지붕은 일부러 무너져 있다** — 3인칭 카메라가 실내에서 천장에 갇히지 않게 하는 가장 싼 답이고
 * (지붕을 페이드시키거나 카메라를 당기는 특례가 하나도 필요 없다), 버려진 건물이라는 설정과도 맞는다.
 * 남은 서까래 · 처마 · 난간은 **콜라이더가 없다** — 실루엣만 있고 아무것도 막지 않는다.
 */
export function buildBuilding(ctx: BuildCtx, plan: BuildingPlan, rng: Random, lab: boolean): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD, wallH } = plan;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];

  /** 벽 한 장: 그린 상자와 **같은 수**로 OBB 콜라이더를 건다. */
  const wall = (lx: number, lz: number, halfLen: number, height: number, alongZ: boolean, thick = WALL_T): void => {
    if (halfLen <= 0.2) return;
    const [wx, wz] = rot(lx, lz);
    const byaw = yaw + (alongZ ? Math.PI / 2 : 0);
    const g = new THREE.BoxGeometry(halfLen * 2, height, thick);
    xform(g, { x: wx, y: y0 + height / 2, z: wz }, new THREE.Euler(0, -byaw, 0));
    paintGradient(g, CONCRETE_DARK, CONCRETE, y0, y0 + height);
    parts.push(g);
    ctx.hash.addBox(new THREE.Vector3(wx, y0, wz), halfLen, thick / 2, byaw, height, 'building');
  };

  /** 한 변을 따라 구멍(문 · 무너진 자리)을 빼고 남는 만큼만 벽을 세운다. */
  const side = (alongZ: boolean, fixed: number, from: number, to: number, gaps: { c: number; w: number }[], height: number): void => {
    const cuts = gaps.slice().sort((a, b) => a.c - b.c);
    let s = from;
    const emit = (a: number, b: number): void => {
      if (b - a < 0.5) return;
      const mid = (a + b) / 2, hl = (b - a) / 2;
      if (alongZ) wall(fixed, mid, hl, height, true);
      else wall(mid, fixed, hl, height, false);
    };
    for (const g of cuts) {
      const g0 = g.c - g.w / 2, g1 = g.c + g.w / 2;
      if (g0 > s) emit(s, Math.min(g0, to));
      if (g1 > s) s = g1;
    }
    emit(s, to);
  };

  /* ── 바깥 벽 (남쪽에 정문, 다른 한 면에 무너진 틈) ──────────────────────── */
  const doorX = rng.range(-halfW * 0.45, halfW * 0.45);
  const breachSide = rng.int(0, 2);          // 0 = 북, 1 = 서, 2 = 동
  const breachAt = rng.range(-0.45, 0.45);
  side(false, -halfD, -halfW, halfW, [{ c: doorX, w: DOOR_W }], wallH);
  side(false, halfD, -halfW, halfW, breachSide === 0 ? [{ c: breachAt * halfW * 2, w: 3.2 }] : [], wallH);
  side(true, -halfW, -halfD, halfD, breachSide === 1 ? [{ c: breachAt * halfD * 2, w: 3.2 }] : [], wallH);
  side(true, halfW, -halfD, halfD, breachSide === 2 ? [{ c: breachAt * halfD * 2, w: 3.2 }] : [], wallH);

  /* 문틀 (상인방 + 기둥) — 정문이 눈에 띄게 */
  {
    const [dx, dz] = rot(doorX, -halfD);
    const lintel = new THREE.BoxGeometry(DOOR_W + 0.9, 0.45, WALL_T + 0.2);
    xform(lintel, { x: dx, y: y0 + wallH - 0.22, z: dz }, new THREE.Euler(0, -yaw, 0));
    paint(lintel, METAL, 0.06, rng);
    parts.push(lintel);
    const lamp = new THREE.BoxGeometry(0.5, 0.12, 0.16);
    xform(lamp, { x: dx, y: y0 + wallH - 0.5, z: dz }, new THREE.Euler(0, -yaw, 0));
    glow.push(lamp);
  }

  /* ── 격벽 (방 둘 + 통로) ───────────────────────────────────────────────── */
  const partZ = rng.range(-halfD * 0.3, halfD * 0.2);
  const passX = rng.range(-halfW * 0.5, halfW * 0.5);
  side(false, partZ, -halfW, halfW, [{ c: passX, w: DOOR_W }], wallH);

  /* ── 계단 구멍 (지하실이 있을 때). 소품 · 컨테이너보다 **먼저** 정해야 그 위에 아무것도 서지 않는다 —
   *    구멍 위는 바닥이 없으므로 거기 놓인 것은 허공에 뜬다. 뒤쪽 방(격벽 너머)에 두어 정문에서 바로 보이지 않게. */
  const pit = plan.pit;
  const run = pit ? Math.max(3.0, pit.depth * 1.25) : 0;
  const runHalf = run / 2;
  const openZ = pit ? Math.min(pit.halfZ - runHalf - 0.4, Math.max(partZ + runHalf + 1.2, 0)) : 0;
  const openX = pit ? Math.max(-pit.halfX + STAIR_HALF + 0.3, Math.min(pit.halfX - STAIR_HALF - 0.3, rng.range(-2, 2))) : 0;
  /** 로컬 좌표가 계단 구멍 위(여유 `pad`)인가. */
  const overHole = (lx: number, lz: number, pad = 0): boolean =>
    !!pit && Math.abs(lx - openX) < STAIR_HALF + pad && Math.abs(lz - openZ) < runHalf + pad;

  /* ── 지상층 바닥 ───────────────────────────────────────────────────────
   * 2026-09-10 — **계단 구멍을 도려낸 네 조각**이다. 예전에는 발자국 전체를 덮는 판 하나였다:
   * 콜라이더가 없으니 걸어 내려갈 수는 있었지만 **눈에는 지하실 입구가 통째로 막혀 보였다** —
   * 해치를 열어도 바닥이 그대로 깔려 있으니 "열린 게 맞나?" 가 됐다 (전진기지 · 연구실 공통).
   * 그래서 천장 슬래브(`slab`)와 **똑같이** 구멍 둘레만 남긴다. 이 조각들은 예전처럼 콜라이더가 없다 —
   * 걸어 다니는 바닥은 지형이고, 지하실 위를 덮는 것은 아래의 슬래브 상자다.
   * (그래서 이 블록은 구멍 자리 `openX/openZ` 가 정해진 **뒤**로 내려왔다.) */
  {
    const fx = halfW + 0.3, fz = halfD + 0.3;
    const floorPiece = (lx0: number, lx1: number, lz0: number, lz1: number): void => {
      if (lx1 - lx0 < 0.3 || lz1 - lz0 < 0.3) return;
      const hx = (lx1 - lx0) / 2, hz = (lz1 - lz0) / 2;
      const [wx, wz] = rot((lx0 + lx1) / 2, (lz0 + lz1) / 2);
      const g = new THREE.BoxGeometry(hx * 2, 0.24, hz * 2);
      xform(g, { x: wx, y: y0 - 0.1, z: wz }, new THREE.Euler(0, -yaw, 0));
      paint(g, CONCRETE_DARK, 0.07, rng);
      parts.push(g);
    };
    if (!pit) {
      floorPiece(-fx, fx, -fz, fz);
    } else {
      const hx0 = openX - STAIR_HALF, hx1 = openX + STAIR_HALF;
      const hz0 = openZ - runHalf, hz1 = openZ + runHalf;
      floorPiece(-fx, fx, -fz, hz0);
      floorPiece(-fx, fx, hz1, fz);
      floorPiece(-fx, hx0, hz0, hz1);
      floorPiece(hx1, fx, hz0, hz1);
    }
  }

  /* ── 무너진 지붕: 서까래 · 처마 · 난간 (콜라이더 없음) ──────────────────── */
  {
    const beams = 4 + rng.int(0, 2);
    for (let i = 0; i < beams; i++) {
      const t = (i + 0.5) / beams;
      const lz = -halfD + t * halfD * 2;
      if (rng.chance(0.32)) continue;                       // 무너져 사라진 서까래
      const g = new THREE.BoxGeometry(halfW * 2 + 0.4, 0.22, 0.24);
      const [bx, bz] = rot(0, lz);
      xform(g, { x: bx, y: y0 + wallH + 0.12, z: bz }, new THREE.Euler(0, -yaw, rng.range(-0.02, 0.02)));
      paint(g, METAL, 0.08, rng);
      parts.push(g);
    }
    // 가장자리 처마 두 조각 (한쪽만 남았다)
    for (const s of [-1, 1]) {
      if (rng.chance(0.4)) continue;
      const w = rng.range(1.6, 3.0);
      const [px, pz] = rot(s * (halfW - w / 2), rng.range(-halfD * 0.6, halfD * 0.6));
      const g = new THREE.BoxGeometry(w, 0.16, rng.range(2.4, 4.4));
      xform(g, { x: px, y: y0 + wallH + 0.28, z: pz }, new THREE.Euler(0, -yaw, 0));
      paint(g, CONCRETE, 0.06, rng);
      parts.push(g);
    }
    // 난간 (벽 위 낮은 턱)
    for (const [alongZ, fixed] of [[false, -halfD], [false, halfD], [true, -halfW], [true, halfW]] as [boolean, number][]) {
      const len = alongZ ? halfD : halfW;
      const g = new THREE.BoxGeometry(len * 2, 0.34, WALL_T + 0.16);
      const [px, pz] = alongZ ? rot(fixed, 0) : rot(0, fixed);
      xform(g, { x: px, y: y0 + wallH + 0.17, z: pz }, new THREE.Euler(0, -(yaw + (alongZ ? Math.PI / 2 : 0)), 0));
      paint(g, CONCRETE, 0.05, rng);
      parts.push(g);
    }
  }

  /* ── 실내 소품 (연구실은 작업대, 전진기지는 탄약 팔레트) ──────────────────── */
  {
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const lx = rng.range(-halfW + 1.6, halfW - 1.6), lz = rng.range(-halfD + 1.6, halfD - 1.6);
      if (overHole(lx, lz, 1.0)) continue;
      const [px, pz] = rot(lx, lz);
      const g = lab
        ? new THREE.BoxGeometry(rng.range(1.6, 2.6), 0.9, 0.8)
        : new THREE.BoxGeometry(rng.range(1.0, 1.6), rng.range(0.5, 0.9), rng.range(0.9, 1.4));
      xform(g, { x: px, y: y0 + 0.45, z: pz }, new THREE.Euler(0, -(yaw + rng.range(-0.4, 0.4)), 0));
      paint(g, lab ? METAL : RUST, 0.1, rng);
      parts.push(g);
      ctx.hash.add(new THREE.Vector3(px, y0, pz), 0.7, 0.9, 'building');
    }
  }

  /* ── 컨테이너 · 콘솔 자리 ──────────────────────────────────────────────── */
  const spots: Spot[] = [];
  {
    const inset = 1.15;
    const push = (lx: number, lz: number, facing: number): void => {
      // 문 · 통로 앞은 비운다
      if (Math.abs(lz - (-halfD)) < 1.2 && Math.abs(lx - doorX) < DOOR_W) return;
      if (Math.abs(lz - partZ) < 1.4 && Math.abs(lx - passX) < DOOR_W) return;
      if (overHole(lx, lz, 0.8)) return;                 // 계단 구멍 위에는 아무것도 놓지 않는다
      const [wx, wz] = rot(lx, lz);
      spots.push({ x: wx, y: y0, z: wz, yaw: yaw + facing });
    };
    const step = 2.1;
    for (let lx = -halfW + inset; lx <= halfW - inset; lx += step) {
      push(lx, -halfD + inset, Math.PI / 2);
      push(lx, halfD - inset, -Math.PI / 2);
      push(lx, partZ - inset, -Math.PI / 2);
      push(lx, partZ + inset, Math.PI / 2);
    }
    for (let lz = -halfD + inset * 2; lz <= halfD - inset * 2; lz += step) {
      push(-halfW + inset, lz, 0);
      push(halfW - inset, lz, Math.PI);
    }
    // 시드 결정적 셔플
    for (let i = spots.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = spots[i]; spots[i] = spots[j]; spots[j] = t;
    }
  }
  const consoleSpot: Spot = spots.length > 0 ? spots.pop()! : { x: cx, y: y0, z: cz, yaw };

  /* ── 지하실: 구덩이 라이닝 + 천장 슬래브 + 계단 + 해치 ──────────────────── */
  let hatch: (Spot & { halfX: number; halfZ: number }) | null = null;
  const basementSpots: Spot[] = [];
  let basementY = y0;
  if (pit) {
    basementY = y0 - pit.depth;

    /* 구덩이 흙벽을 콘크리트로 덮고 **콜라이더도 건다.** 지형만 믿으면 안 된다 — 구덩이 벽은
     * `PIT_BLEND` 폭의 급경사일 뿐이고 `getSurfaceY` 는 지형에 오르막 제한이 없어서, 지하실 안에서 벽으로
     * 걸어가면 흙을 타고 올라가 천장 슬래브에 끼인다. 벽을 세우면 지하실이 제대로 된 방이 된다. */
    for (const [alongZ, fixed] of [[false, -pit.halfZ], [false, pit.halfZ], [true, -pit.halfX], [true, pit.halfX]] as [boolean, number][]) {
      const len = alongZ ? pit.halfZ : pit.halfX;
      const g = new THREE.BoxGeometry(len * 2, pit.depth, 0.3);
      const [px, pz] = alongZ ? rot(fixed, 0) : rot(0, fixed);
      const byaw = yaw + (alongZ ? Math.PI / 2 : 0);
      xform(g, { x: px, y: basementY + pit.depth / 2, z: pz }, new THREE.Euler(0, -byaw, 0));
      paintGradient(g, CONCRETE_DARK.clone().multiplyScalar(0.7), CONCRETE_DARK, basementY, y0);
      parts.push(g);
      // 윗면이 정확히 지상층 바닥(y0)이라 위에서는 그냥 바닥이다 (`PROP_TOP_MARGIN` 로 통과)
      ctx.hash.addBox(new THREE.Vector3(px, basementY, pz), len, 0.15, byaw, pit.depth, 'building');
    }

    /* 천장 슬래브 = 지상층 바닥. **뜬 상자 콜라이더**라 윗면(= y0)은 걸어 다니고 밑은 지하실 천장이다
     * (`WorldSystem.resolveCollision` 이 `BOX_HEADROOM` 위의 상자를 밀어내지 않는다). 계단 구멍만 뺀다.
     * 슬래브는 구덩이보다 `PIT_BLEND` 만큼 **더 넓다** — 지형이 그 폭에 걸쳐 내려가므로 딱 맞게 덮으면
     * 구덩이 둘레에 도랑이 남아 실내를 걷다 빠진다. */
    const slab = (lx0: number, lx1: number, lz0: number, lz1: number): void => {
      if (lx1 - lx0 < 0.3 || lz1 - lz0 < 0.3) return;
      const hx = (lx1 - lx0) / 2, hz = (lz1 - lz0) / 2;
      const [wx, wz] = rot((lx0 + lx1) / 2, (lz0 + lz1) / 2);
      const g = new THREE.BoxGeometry(hx * 2, SLAB_T, hz * 2);
      xform(g, { x: wx, y: y0 - SLAB_T / 2, z: wz }, new THREE.Euler(0, -yaw, 0));
      paint(g, CONCRETE_DARK, 0.05, rng);
      parts.push(g);
      ctx.hash.addBox(new THREE.Vector3(wx, y0 - SLAB_T, wz), hx, hz, yaw, SLAB_T, 'slab');
    };
    const ox0 = openX - STAIR_HALF, ox1 = openX + STAIR_HALF;
    const oz0 = openZ - runHalf, oz1 = openZ + runHalf;
    const sx = Math.min(halfW - 0.5, pit.halfX + PIT_BLEND), sz = Math.min(halfD - 0.5, pit.halfZ + PIT_BLEND);
    slab(-sx, sx, -sz, oz0);
    slab(-sx, sx, oz1, sz);
    slab(-sx, ox0, oz0, oz1);
    slab(ox1, sx, oz0, oz1);

    // 계단: 구멍 안에서 +Z 로 내려간다
    {
      const steps = Math.max(6, Math.round(pit.depth / 0.28));
      const tread = run / steps;
      for (let i = 0; i < steps; i++) {
        const top = y0 - (pit.depth * (i + 1)) / steps;
        const lz = oz0 + tread * (i + 0.5);
        const [wx, wz] = rot(openX, lz);
        const h = Math.max(0.05, top - basementY);
        const g = new THREE.BoxGeometry(STAIR_HALF * 2, h, tread);
        xform(g, { x: wx, y: basementY + h / 2, z: wz }, new THREE.Euler(0, -yaw, 0));
        paint(g, CONCRETE_DARK, 0.04, rng);
        parts.push(g);
        ctx.hash.addBox(new THREE.Vector3(wx, basementY, wz), STAIR_HALF, tread / 2, yaw, h, 'slab');
      }
    }

    // 지하 조명 (빛나는 띠 두 줄)
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.14, 0.1, pit.halfZ * 1.4);
      const [px, pz] = rot(s * (pit.halfX - 0.35), 0);
      xform(g, { x: px, y: y0 - SLAB_T - 0.12, z: pz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }

    // 지하실 컨테이너 자리 (벽을 등지고)
    {
      const cand: Spot[] = [];
      for (let lx = -pit.halfX + 1.1; lx <= pit.halfX - 1.1; lx += 2.0) {
        for (const [lz, f] of [[-pit.halfZ + 1.0, Math.PI / 2], [pit.halfZ - 1.0, -Math.PI / 2]] as [number, number][]) {
          if (Math.abs(lx - openX) < STAIR_HALF + 0.8 && Math.abs(lz - openZ) < runHalf + 1.0) continue;
          const [wx, wz] = rot(lx, lz);
          cand.push({ x: wx, y: basementY, z: wz, yaw: yaw + f });
        }
      }
      for (let i = cand.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
      basementSpots.push(...cand);
    }

    const [hx, hz] = rot(openX, openZ);
    hatch = { x: hx, y: y0, z: hz, yaw, halfX: STAIR_HALF, halfZ: runHalf };
  }

  return { parts, glow, containers: spots, basementContainers: basementSpots, console: consoleSpot, hatch, basementY };
}

/**
 * 불시착한 함선. 지하실은 없고, **위가 찢겨 열린** 동체가 곧 방이다 — 건물과 같은 이유로 천장을 닫지 않는다.
 * 동체 옆판 · 후미 격벽만 OBB 콜라이더를 갖고 날개 · 엔진은 실루엣이다 (밖에 있어 지나갈 일이 드물고,
 * 원기둥으로 감싸면 그려진 것보다 두꺼워진다).
 */
export function buildWreck(ctx: BuildCtx, plan: BuildingPlan, rng: Random): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD, wallH } = plan;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];

  // 바닥 (동체 데크)
  {
    const g = new THREE.BoxGeometry(halfW * 2, 0.26, halfD * 2);
    xform(g, { x: cx, y: y0 - 0.06, z: cz }, new THREE.Euler(0, -yaw, 0));
    paint(g, METAL_DARK, 0.08, rng);
    parts.push(g);
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
    const [wx, wz] = rot(0, -halfD);
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
    const ramp = new THREE.BoxGeometry(DOOR_W, 0.16, 2.6);
    xform(ramp, { x: wx, y: y0 - 0.2, z: wz }, new THREE.Euler(0.16, -yaw, 0));
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
    // 비상등 두 개
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.18, 0.12, 0.5);
      const [px, pz] = rot(s * halfW * 0.85, halfD * 0.3);
      xform(g, { x: px, y: y0 + wallH * 0.8, z: pz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }
  }

  // 컨테이너 · 콘솔 자리 — 데크를 따라
  const spots: Spot[] = [];
  for (let lz = -halfD + 1.6; lz <= halfD - 1.6; lz += 2.0) {
    for (const s of [-1, 1]) {
      const [wx, wz] = rot(s * (halfW - 1.1), lz);
      spots.push({ x: wx, y: y0, z: wz, yaw: yaw + (s < 0 ? 0 : Math.PI) });
    }
  }
  for (let i = spots.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = spots[i]; spots[i] = spots[j]; spots[j] = t; }
  const consoleSpot: Spot = spots.length > 0 ? spots.pop()! : { x: cx, y: y0, z: cz, yaw };

  return { parts, glow, containers: spots, basementContainers: [], console: consoleSpot, hatch: null, basementY: y0 };
}

/** 컨테이너 · 콘솔 · 해치가 쓰는 색 (파트 밖에서도 같은 팔레트를 쓰도록 내보낸다). */
export const PALETTE = { CONCRETE, CONCRETE_DARK, METAL, METAL_DARK, RUST };

/** `parts` 를 하나로 합친다. 비어 있으면 null (빈 geometry 로 머지하면 three 가 던진다). */
export function mergeOrNull(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  return merge(parts);
}
