import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  BARRIER, BARRIER_GHOST_OVERLAP, BARRIER_LEN, BARRIER_MESH_YAW, CLIFF2_EDGE_Z, CRAWL, DECK_LOWER_Y,
  DECK_UPPER_Y, DRESSING_SEED, PIT, PIT_RAMP_TOE_X, PIT_WALLS, RUINS, SHIP_POS, SHIP_SLOPE, SHIP_YAW, barrierLocal,
  barrierPoint, box, corridorHalfXAt, crawlClearanceAt, inAbyssCut, inChasm, pitSurfaceY, rectContains, shipHillSurfaceY,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * 손으로 지은 구조물 — 시작 폐허 · 무너진 통로(포복 구간) · 사선 방벽(블라인드 철조망) · 돌부스러기.
 *
 * 규칙 하나: **콜라이더가 있는 것만 큼직하게 그리고, 콜라이더 없는 것은 발끝보다 낮게 둔다.** 그래야
 * "보이는 실루엣이 콜라이더" (`CLAUDE.md`) 가 깨지지 않는다. 광원은 0개이고 켜져 보이는 것은 전부 emissive 다.
 *
 * 2026-09-14 2차 (통로 폭 축소): 통로에 닿는 x 는 전부 `corridorHalfXAt(z)` 에서 뽑는다 — 상수 반폭을 베껴
 * 쓰면 구간 프로파일을 고칠 때마다 소품이 벽 속에 묻히거나 벽 밖으로 삐져나온다. 시작 폐허의 벽 다섯 장은
 * 좁은 구간이라 손으로 안쪽으로 옮겼다 (3차에 반폭이 11 → 7.7 이 되면서 한 번 더).
 *
 * 2026-09-14 3차 — **지나가는 구간의 바닥 장식을 걷어냈다.** 포복 구간처럼 몸을 낮추고 지나는 데서는
 * 콜라이더 없는 부스러기를 엎드린 몸이 그대로 뚫고 지나가 눈에 거슬린다. 천장 아래로 늘어져 있던 철근도
 * 같은 이유로 없앴다 (머리가 그 안을 지나갔다).
 *
 * 2026-09-15 — 옛 「무너진 벽」(통로를 가로지르고 가운데 5 m 만 뚫림)을 **사선 방벽**(`buildBarrier`)으로 바꿨다.
 * 치수 · 검산은 전부 `model.ts` 의 `BARRIER` · `BACKSTOP` 주석에 있다.
 *
 * 2026-09-15 2차 (사용자 결정) — 철조망이 **절반 높이**(1.35)로 보이되 콜라이더는 위에 `passRays` + `passSmall`
 * **유령 토막**을 얹어 사람만 막는다(`BARRIER.blockHeight`). 살 치수는 이제 전부 `BARRIER.fenceHeight` 에서 유도한다.
 * 그리고 마지막 안드로이드 둘이 **웅덩이**(`model.ts` 의 `PIT`, 땅은 `parts/Ground.buildPit`) 안에 서므로 웅덩이 안 부스러기가
 * `pitSurfaceY` 를 기준으로 내려갔다.
 *
 * 2026-09-15 3차 (사용자 결정) — ① 콘크리트 `BACKSTOP` 은 없어졌다: 수류탄을 멈추는 벽은 이제 웅덩이를 두르는 바위 벽
 * (`model.ts` 의 `PIT_WALLS`, `parts/Ground.buildPit`)이고 여기서는 그 밑동에 부스러기만 놓는다. ② 철조망 너머에 절벽 구멍
 * (`ABYSS_CUTS`)이 생겨 부스러기는 `inAbyssCut` 자리를 뺀다 (허공에 뜬다). ③ 깨어나는 자리의 **넘어진 안테나 기둥**이 통로
 * 한가운데에 콜라이더 없이 누워 있던 것을 왼쪽 폐허 벽 곁으로 옮기고 실루엣과 같은 상자 콜라이더를 줬다 (`buildRuins`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 콜라이더 없이 그리기만 하는 최대 높이 (발을 걸지 않고 넘어간다 — `PROP_STEP_UP_MAX` 0.9 보다 낮다). */
const FLAT_DEBRIS_H = 0.35;

/*
 * 블라인드 철조망의 그림 치수. **높이(`BARRIER.fenceHeight`)에서 전부 유도한다** — 2026-09-15 2차에 2.7 → 1.35 로
 * 절반이 되면서 옛 고정 치수(살 0.12 + 틈 0.18, 밑 0.25)로는 살이 셋밖에 안 들어갔다.
 *   한 칸 `SLAT_PITCH` = 높이 / (`SLAT_COUNT` + 1) = 1.35 / 6 = **0.225** (맨 위 한 칸은 난간 · 철선 자리)
 *   살 `SLAT_H` = 칸의 40 % = 0.09, 틈 0.135 → **틈이 60 %** 라 건너편이 보인다 (옛 비율 그대로).
 *   밑 `SLAT_BASE` = 칸의 80 % = 0.18 → 맨 윗살 윗면 0.18 + 4 × 0.225 + 0.09 = **1.17 m**, 윗 난간 1.28 … 1.33 —
 *   전부 철조망 높이 1.35 **밑**이라 넘겨 던진 수류탄의 궤적과 그림이 어긋나지 않는다.
 * 살은 방벽 중심선에서 ±`SLAT_FACE`(0.55) 두 겹 — 콜라이더 면(±0.6)보다 5 cm 안쪽이라 총알 자국이 살 바로 앞에 선다.
 * 두 겹의 살 높이가 같아 틈이 겹치므로 틈으로 보이는 세로 각은 atan(0.135 / 1.1) = **7.0°** 까지다.
 *   ⚠ 이 각이 「멀리서도 건너편이 보이는가」를 정한다: 웅덩이 속 안드로이드(가슴 = 데크 +0.27)를 보는 각은 철조망에서
 *   2.31 m 뒤에서 6.2° 이고 더 뒤로 갈수록 작아지므로 **살 사이로 보이고**, 2.31 m 안쪽에서는 사선이 철조망 윗면 위로
 *   올라가 **넘어 보인다** — 두 구간이 이어져 어디에 서도 보인다 (`model.ts` 의 `BARRIER` 검산).
 *   2026-09-17: 높이 ×1.5(2.025) — 칸 0.3375 · 살 0.135 · 틈 0.2025 → 틈 각 **10.4°**. 윗면이 눈(1.55)보다 높아 넘어 보이는 자리는
 *   없어졌지만 붙어 서도 사선이 6.2° 이하라 **어디서나 살 사이로 보인다**.
 */
const SLAT_COUNT = 5, SLAT_T = 0.04;
const SLAT_PITCH = BARRIER.fenceHeight / (SLAT_COUNT + 1);
const SLAT_H = SLAT_PITCH * 0.4, SLAT_GAP = SLAT_PITCH - SLAT_H, SLAT_BASE = SLAT_PITCH * 0.8;
const SLAT_FACE = BARRIER.halfT - 0.05;
const RAIL_H = 0.1;
/** 철조망 밑의 콘크리트 턱 높이 — 첫 살(`SLAT_BASE`)보다 낮다. */
const SILL_H = SLAT_PITCH * 0.7;
/** 기둥 간격 (m) — 철조망 토막을 이 길이 이하의 칸으로 나눈다. */
const POST_STEP_M = 3;
/**
 * 방벽 콜라이더 한 장의 최대 길이 (m). 한 장으로 넣으면 외접원이 17.5 m 가 되어 `SpatialHash.maxRadius` 가 데크 타일(11.3)보다
 * 커지고 **모든** 해시 질의가 느려진다 (`DECK_TILE_M` 과 같은 이유). 이음매는 `BARRIER_JOIN_M` 만큼 겹친다.
 */
const BARRIER_COLLIDER_MAX_M = 12;
const BARRIER_JOIN_M = 0.05;

export class Dressing {
  readonly group = new THREE.Group();
  private entries: ObstacleEntry[] = [];
  private disposables: Array<{ dispose(): void }> = [];

  constructor() { this.group.name = 'TutorialDressing'; }

  build(root: THREE.Group, hash: SpatialHash): void {
    root.add(this.group);
    const rng = new Random(DRESSING_SEED);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x776d5e, roughness: 0.95, metalness: 0.05, emissive: 0x141210, emissiveIntensity: 0.55 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x6b4530, roughness: 0.9, metalness: 0.25, emissive: 0x120a06, emissiveIntensity: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x5a5e60, roughness: 0.7, metalness: 0.3, emissive: 0x0b0c0d, emissiveIntensity: 0.6 });
    this.disposables.push(concrete, rust, steel);

    const solid: THREE.BufferGeometry[] = [];   // 콜라이더가 붙는 콘크리트
    const flat: THREE.BufferGeometry[] = [];    // 바닥 부스러기 (콜라이더 없음)
    const metal: THREE.BufferGeometry[] = [];   // 철조망 (콜라이더는 방벽 한 덩어리)

    this.buildRuins(hash, solid, flat, rng);
    this.buildCrawl(hash, solid, rng);
    this.buildBarrier(hash, solid, metal, flat, rng);
    this.scatterRubble(flat, rng);

    this.addMerged(solid, concrete, 'tut-concrete');
    this.addMerged(flat, rust, 'tut-debris');
    this.addMerged(metal, steel, 'tut-fence');
  }

  /* ── 시작 폐허: 깨어나는 자리를 감싸는 부서진 벽 몇 장과 넘어진 안테나 ── */
  private buildRuins(hash: SpatialHash, solid: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random): void {
    const y = DECK_UPPER_Y;
    // 반쯤 남은 벽 다섯 장 — 깨어난 자리(0, 112)를 둘러싸되 앞(−Z)은 열어 둔다.
    // 2026-09-14 3차: 이 구간의 반폭이 7.7 로 줄었고 벽이 안쪽으로 최대 1.1 파고드므로(`Ground` 의 bite,
    // 좁은 구간에서는 같은 비율로 줄어 (4 × 0.55 × 0.5) = 1.1) 안쪽 면은 최소 |x| 6.6 이다. 그래서 폐허 소품은
    // 전부 **|x| ≤ 6.5** 안에 든다 (아래 각 줄 옆의 실제 x 범위 참조).
    const walls: Array<[number, number, number, number, number]> = [
      // x, z, 길이, yaw, 높이                      // 차지하는 x
      [-3.2, 116, 6.0, 0, 3.4],                     // −6.20 … −0.20
      [3.2, 115, 5.6, 0.12, 2.6],                   //   0.37 …  6.03
      [-5.9, 107, 9, Math.PI / 2, 3.0],             // −6.35 … −5.45
      [5.5, 104, 12, Math.PI / 2 + 0.08, 2.2],      //   4.57 …  6.43
      [-2.8, 98, 5, 0.25, 1.9],                     // −5.33 … −0.27
    ];
    for (const [x, z, len, yaw, h] of walls) {
      solid.push(box(len, h, 0.9, x, y + h / 2, z, yaw));
      this.addBox(hash, x, y, z, len / 2, 0.45, yaw, h, 'tut_ruin');
      // 벽 밑동의 무너진 조각
      flat.push(box(len * 0.6, FLAT_DEBRIS_H, 2.2, x + rng.range(-1, 1), y + FLAT_DEBRIS_H / 2, z + rng.range(-2, 2), yaw + 0.1));
    }
    /* 넘어진 안테나 기둥 — 2026-09-15 3차 (사용자 결정 — 「깨어나는 자리 한가운데의 장식 기둥이 콜라이더 없이 놓여 있어 어색하다」):
     * 통로 한가운데(옛 x −2.92 … 5.72 · z 109)에서 **왼쪽 폐허 벽 곁**으로 옮겨 통로와 나란히 눕히고, 실루엣(길이 9 · 지름 0.9 →
     * 높이 0.85)과 같은 상자 콜라이더를 준다. 0.85 < `PROP_STEP_UP_MAX` 0.9 라 밟고 올라설 수는 있지만 뚫고 지나가지는 않는다.
     * 자리: 중심 (−4.45, 104.5), 살짝 비스듬(0.06 rad) → x −5.17 … −3.73 · z 100 … 109. 왼쪽 벽 조각(x −6.35 … −5.45, z 102.5 … 111.5)과
     * 0.28 m, 앞쪽 벽 조각(z ≤ 99.05)과 0.95 m 떨어져 겹치지 않고, 벽 안쪽 면(|x| ≥ 6.6)보다 안이라 벽 속에 묻히지 않는다. */
    const mastYaw = Math.PI / 2 + 0.06;
    const mast = new THREE.CylinderGeometry(0.35, 0.45, 9, 8);
    mast.rotateZ(Math.PI / 2);
    mast.rotateY(mastYaw);
    mast.translate(-4.45, y + 0.4, 104.5);
    solid.push(mast);
    this.addBox(hash, -4.45, y, 104.5, 4.5, 0.45, mastYaw, 0.85, 'tut_ruin');
    // 포드 잔해 한 조각 — "여기서 떨어졌다" 를 말하는 유일한 소품. x −3.83 … 0.23
    solid.push(box(3.2, 2.0, 2.6, -1.8, y + 1.0, 118.5, 0.5));
    this.addBox(hash, -1.8, y, 118.5, 1.6, 1.3, 0.5, 2.0, 'tut_ruin');
  }

  /**
   * 무너진 통로 — 양옆이 잔해로 막혀 `CRAWL.gapHalfX` 만큼만 열려 있고, 그 위를 슬래브가 덮는다.
   *
   * 2026-09-14 3차 (사용자 결정):
   *   - 슬래브를 **기울였다**(`CRAWL.slabSlope`) — 「무너져 내려앉은 잔해」로 읽힌다. 그림은 기울인 상자 한
   *     장이고 **콜라이더는 `CRAWL.slabSegments` 장**으로 쪼갠 축 정렬 상자다 (밑면은 각 조각 한가운데의 값).
   *   - 천장 아래로 늘어져 있던 **얇은 철근을 없앴다** (지나가는 머리를 뚫고 지나갔다).
   *   - 지나가는 **바닥의 부스러기 판도 없앴다** (엎드린 몸이 그 안을 통과했다).
   *
   * 2026-09-14 4차: 기울기의 **부호가 뒤집혔고**(입구 → 출구로 높아진다) 조각이 7 장, 두께가 2.4 다.
   * 2026-09-15: 입구가 1.35 → **1.70** 으로 올라가(앉은 머리 꼭대기 1.55 + 0.15) 기울기가 완만해졌다.
   * 이 파일의 식은 두 번 다 한 줄도 안 바뀌었다 — 그림의 중심(`clearance + slabThickness / 2`)도 콜라이더의 base 도
   * **밑면 기준**이라 두께를 키우면 위로만 자라고, 기울기는 `crawlClearanceAt` 이 부호째 답한다.
   * 검산(양 끝 · 조각별 밑면 · 머리 꼭대기)은 전부 `CRAWL` 주석에 있다.
   */
  private buildCrawl(hash: SpatialHash, solid: THREE.BufferGeometry[], rng: Random): void {
    const y = DECK_UPPER_Y;
    const zMid = (CRAWL.z0 + CRAWL.z1) / 2, depth = CRAWL.z0 - CRAWL.z1;
    const corridor = corridorHalfXAt(zMid);
    for (const sx of [-1, 1]) {
      const inner = sx * CRAWL.gapHalfX, outer = sx * corridor;
      const cx = (inner + outer) / 2, half = Math.abs(outer - inner) / 2;
      const h = 5.2;
      solid.push(box(half * 2, h, depth, cx, y + h / 2, zMid));
      this.addBox(hash, cx, y, zMid, half, depth / 2, 0, h, 'tut_crawl');
      // 잔해 더미의 실루엣을 깨는 덩어리 몇 개 (막힌 쪽이라 콜라이더 없이 얹는다)
      for (let i = 0; i < 4; i++) {
        const s = rng.range(1.2, 2.6);
        solid.push(box(s, s * 0.7, s, cx + rng.range(-half * 0.6, half * 0.6), y + h - 0.2, zMid + rng.range(-depth / 2, depth / 2), rng.range(0, 1)));
      }
    }
    // 머리 위 슬래브 — 그림은 기울인 상자 한 장 (rotateX(−atan(slope)) 라 밑면의 dy/dz 가 곧 `slabSlope` 다:
    // 4차부터 slope 가 음수라 z 가 작을수록(= 나갈수록) 높다)
    const slabW = CRAWL.gapHalfX * 2 + 1.2;
    const slab = new THREE.BoxGeometry(slabW, CRAWL.slabThickness, depth);
    slab.rotateX(-Math.atan(CRAWL.slabSlope));
    slab.translate(0, y + CRAWL.clearance + CRAWL.slabThickness / 2, zMid);
    solid.push(slab);
    // 콜라이더는 조각마다 축 정렬 상자 — 밑면은 그 조각 한가운데의 슬래브 높이
    const segD = depth / CRAWL.slabSegments;
    for (let i = 0; i < CRAWL.slabSegments; i++) {
      const zc = CRAWL.z0 - segD * (i + 0.5);
      this.addBox(hash, 0, y + crawlClearanceAt(zc), zc, slabW / 2, segD / 2, 0, CRAWL.slabThickness, 'tut_crawl');
    }
  }

  /**
   * 사선 방벽 (2026-09-15) — 콘크리트 토막 둘 사이에 **가로 블라인드 철조망**, 그리고 건너편 안드로이드 뒤의 **콘크리트 방벽**.
   *
   * 모든 조각을 방벽 좌표(`barrierPoint(along, depth)`)로 놓는다: `box()` 의 로컬 +X 를 `BARRIER_MESH_YAW` 로 돌리면 방벽 방향,
   * 로컬 +Z 는 가까운 쪽 법선이 된다 (rotateY(θ) 가 +Z 를 (sin θ, cos θ) = (−0.685, 0.728) 로 보낸다).
   * 콜라이더는 `addBox` 에 **메시 yaw** 를 넘기고 거기서 부호를 뒤집는다 (파일 끝 주석).
   *
   * 철조망의 콜라이더는 살이 아니라 **토막 전체**이고 2026-09-15 2차부터 **두 겹**이다 — 아래(그려진 1.35 m)는 총알 · 적 시야까지
   * 막고, 위(`blockHeight` 까지)는 `passRays` + `passSmall` 유령이라 사람 · 적만 막는다 (`BARRIER` 주석의 표).
   */
  private buildBarrier(
    hash: SpatialHash, solid: THREE.BufferGeometry[], metal: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random,
  ): void {
    const y = DECK_LOWER_Y;
    const yaw = BARRIER_MESH_YAW;
    const T = BARRIER.halfT * 2;
    const fence0 = BARRIER.solidFarM, fence1 = BARRIER_LEN - BARRIER.solidNearM;

    // ① 콘크리트 토막 둘 (`far` 끝 · `near` 끝)
    for (const [a0, a1] of [[0, fence0], [fence1, BARRIER_LEN]] as const) {
      const c = barrierPoint((a0 + a1) / 2, 0);
      const h = BARRIER.solidHeight;
      solid.push(box(a1 - a0, h, T, c.x, y + h / 2, c.z, yaw));
      this.addBox(hash, c.x, y, c.z, (a1 - a0) / 2 + BARRIER_JOIN_M, BARRIER.halfT, yaw, h, 'tut_barrier');
    }
    // `far` 끝 기둥 — 틈 쪽에서 보이는 끝을 굵게 마감한다 (콜라이더 안, 높이도 콘크리트와 같다 — 이륙 카메라가 3 m 옆에서 출발한다)
    {
      const c = barrierPoint(0.3, 0);
      solid.push(box(0.6, BARRIER.solidHeight, T + 0.1, c.x, y + BARRIER.solidHeight / 2, c.z, yaw));
    }
    // `near` 끝 토막의 부서진 윗면 (오른쪽 벽 쪽 — 카메라 · 틈과 멀다)
    for (let i = 0; i < 4; i++) {
      const s = rng.range(0.5, 1.1);
      const p = barrierPoint(rng.range(fence1 + 0.8, BARRIER_LEN - 2.5), rng.range(-0.25, 0.25));
      solid.push(box(s * 1.4, s * 0.6, T * 0.8, p.x, y + BARRIER.solidHeight + s * 0.3 - 0.15, p.z, yaw + rng.range(-0.2, 0.2)));
    }

    // ② 블라인드 철조망
    const fenceLen = fence1 - fence0;
    const bays = Math.max(1, Math.ceil(fenceLen / POST_STEP_M));
    const bay = fenceLen / bays;
    const H = BARRIER.fenceHeight;
    {
      const c = barrierPoint(fence0 + fenceLen / 2, 0);
      solid.push(box(fenceLen, SILL_H, T - 0.1, c.x, y + SILL_H / 2, c.z, yaw));
    }
    for (let i = 0; i <= bays; i++) {
      const c = barrierPoint(fence0 + bay * i, 0);
      metal.push(box(0.14, H, T - 0.1, c.x, y + H / 2, c.z, yaw));
    }
    for (let i = 0; i < bays; i++) {
      const mid = fence0 + bay * (i + 0.5);
      for (const face of [-1, 1]) {
        const c = barrierPoint(mid, face * SLAT_FACE);
        for (let k = 0; k < SLAT_COUNT; k++) {
          const sy = y + SLAT_BASE + k * (SLAT_H + SLAT_GAP) + SLAT_H / 2;
          metal.push(box(bay - 0.14, SLAT_H, SLAT_T, c.x, sy, c.z, yaw));
        }
        metal.push(box(bay, RAIL_H, 0.08, c.x, y + H - RAIL_H / 2 - 0.02, c.z, yaw));
      }
      // 두 난간 사이를 오가는 지그재그 철선 (철조망)
      const zig = Math.max(2, Math.round(bay / 0.6));
      for (let k = 0; k < zig; k++) {
        const a0 = fence0 + bay * i + (bay * k) / zig, a1 = a0 + bay / zig;
        const d0 = (k % 2 === 0 ? -1 : 1) * SLAT_FACE;
        const p0 = barrierPoint(a0, d0), p1 = barrierPoint(a1, -d0);
        const dx = p1.x - p0.x, dz = p1.z - p0.z;
        metal.push(box(Math.hypot(dx, dz), 0.025, 0.025, (p0.x + p1.x) / 2, y + H - 0.05, (p0.z + p1.z) / 2, -Math.atan2(dz, dx)));
      }
    }
    /* 철조망 콜라이더 — **두 겹**이다 (2026-09-15 2차, `model.ts` 의 `BARRIER` 주석):
     *   아래 `y … y + fenceHeight`         평범한 토막 — 사람 · 적 · 총알 · 수류탄 전부 막는다 (그려진 철조망과 같은 높이).
     *   위   `… y + blockHeight`           `passRays` + `passSmall` **유령 토막** — 총알 · 적 시야 · 수류탄은 지나가고
     *                                      사람(0.45) · 적만 밀려난다. 그래서 절반 높이로 보여도 **넘어갈 수 없다**.
     * 두 겹은 `BARRIER_GHOST_OVERLAP` 만큼 겹친다 — 정확히 같은 선이면 그 선 위의 점이 양쪽에서 빠질 수 있다.
     * 길이는 `BARRIER_COLLIDER_MAX_M` 이하로 나누고 이음매는 `BARRIER_JOIN_M` 만큼 겹친다. */
    const pieces = Math.max(1, Math.ceil(fenceLen / BARRIER_COLLIDER_MAX_M));
    const ghostBase = y + H - BARRIER_GHOST_OVERLAP;
    const ghostH = y + BARRIER.blockHeight - ghostBase;
    for (let i = 0; i < pieces; i++) {
      const a0 = fence0 + (fenceLen * i) / pieces, a1 = fence0 + (fenceLen * (i + 1)) / pieces;
      const c = barrierPoint((a0 + a1) / 2, 0);
      const halfLen = (a1 - a0) / 2 + BARRIER_JOIN_M;
      this.addBox(hash, c.x, y, c.z, halfLen, BARRIER.halfT, yaw, H, 'tut_fence');
      const ghost = this.addBox(hash, c.x, ghostBase, c.z, halfLen, BARRIER.halfT, yaw, ghostH, 'tut_fence_ghost');
      ghost.passRays = true;
      ghost.passSmall = true;
    }

    /* ③ 웅덩이 벽 밑동의 부스러기 (2026-09-15 3차) — 벽 자체는 땅(`parts/Ground.buildPit`, `PIT_WALLS`)이다. 동쪽 벽 · 남쪽 벽 안쪽
     * 밑동을 따라 납작한 조각 몇 개를 **웅덩이 바닥 높이**에 놓는다 (수류탄이 굴러와 멈추는 자리라 콜라이더는 없다 — `FLAT_DEBRIS_H`). */
    for (let i = 0; i < 3; i++) {
      const px = PIT.x1 - rng.range(0.5, 1.3), pz = PIT.z0 - rng.range(1, PIT.z0 - PIT.z1 - 1.5);
      flat.push(box(rng.range(0.7, 1.4), FLAT_DEBRIS_H, rng.range(0.6, 1.2), px, (pitSurfaceY(px, pz) ?? y) + FLAT_DEBRIS_H / 2, pz, rng.range(0, Math.PI)));
    }
    for (let i = 0; i < 3; i++) {
      const px = rng.range(PIT_RAMP_TOE_X + 1.5, PIT.x1 - 1.5), pz = PIT.z1 + rng.range(0.5, 1.3);
      flat.push(box(rng.range(0.8, 1.8), FLAT_DEBRIS_H, rng.range(0.5, 1.0), px, (pitSurfaceY(px, pz) ?? y) + FLAT_DEBRIS_H / 2, pz, rng.range(0, Math.PI)));
    }
  }

  /**
   * 2026-09-15 — 바닥 부스러기를 뿌리지 않는 자리: 방벽의 발밑(콜라이더 속에 반쯤 묻혀 보인다)과
   * **버려진 함선의 발자국**(부스러기 0.35 m 가 화물칸 바닥 · 램프를 뚫고 올라온다). 함선 로컬 좌표는 `extraction/Ship.bayLocal` 과
   * 같은 식이고, 외피 x ±5.25 · z −9.7 … 램프 끝 +3.25 에 여유를 둔다.
   *
   * 2026-09-15 2차 — **웅덩이의 오르막**도 뺀다. 부스러기는 yaw 로만 돌리는 납작한 상자라 19.8° 경사에 놓으면
   * 한쪽 끝이 0.25 m 뜨고 반대쪽이 묻힌다. 평평한 **바닥**은 빼지 않는다 — `scatterRubble` 이 `pitSurfaceY` 로
   * 높이를 내려 잡으므로 웅덩이 안에도 부스러기가 깔린다 (턱만 있고 아무것도 없으면 파 놓은 구멍처럼 보인다).
   *
   * 2026-09-15 3차 — **웅덩이 벽의 발밑**(`PIT_WALLS` + 0.5 m — 벽 속에 묻힌다)과 **철조망 너머의 절벽 구멍**(`inAbyssCut`, 가장자리
   * 0.6 m 까지 — 데크 높이의 부스러기가 허공에 뜬다)도 뺀다.
   *
   * 2026-09-16 — **함선 언덕 오르막**(`SHIP_SLOPE`)도 뺀다 (웅덩이 오르막과 같은 이유). 언덕 꼭대기는 빼지 않고 `shipHillSurfaceY` 높이에 놓는다.
   */
  private blocksRubble(x: number, z: number): boolean {
    const b = barrierLocal(x, z);
    if (b.along > -1.5 && b.along < BARRIER_LEN + 1.5 && Math.abs(b.depth) < BARRIER.halfT + 1.2) return true;
    if (pitSurfaceY(x, z) !== null && x < PIT_RAMP_TOE_X) return true;
    if (inAbyssCut(x, z, 0.6)) return true;
    if (rectContains(SHIP_SLOPE, x, z)) return true;   // 2026-09-16 함선 언덕 오르막 — 웅덩이 오르막과 같은 이유 (기울어 있다)
    for (const w of PIT_WALLS) {
      if (x >= w.rect.x0 - 0.5 && x <= w.rect.x1 + 0.5 && z <= w.rect.z0 + 0.5 && z >= w.rect.z1 - 0.5) return true;
    }
    const c = Math.cos(SHIP_YAW), s = Math.sin(SHIP_YAW);
    const dx = x - SHIP_POS.x, dz = z - SHIP_POS.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) < 6 && lz > -10.5 && lz < 4.2;
  }

  /* ── 통로 전체에 흩뿌린 바닥 부스러기 (전부 콜라이더 없음) ── */
  private scatterRubble(flat: THREE.BufferGeometry[], rng: Random): void {
    for (let i = 0; i < 90; i++) {
      const z = rng.range(-160, RUINS.z0);
      // 벽에서 2 m 떨어뜨린다 — 좁은 구간에서는 그 구간의 반폭을 기준으로 (rng 호출 순서는 그대로다)
      const lim = Math.max(2.5, corridorHalfXAt(z) - 2);
      const x = rng.range(-lim, lim);
      // 2026-09-15 2차: 웅덩이 안이면 그 바닥 높이로 — 데크 높이로 놓으면 0.9 m 떠 보인다. 2026-09-16: 함선 언덕 위면 언덕 높이로 (묻힌다)
      const y = pitSurfaceY(x, z) ?? shipHillSurfaceY(x, z) ?? (z > CLIFF2_EDGE_Z ? DECK_UPPER_Y : DECK_LOWER_Y);
      if (inChasm(x, z, 1.5)) continue;        // 절벽 1 의 틈에는 아무것도 없다 (2026-09-14 3차: 사선이다)
      // 포복 구간 — 엎드린 몸이 콜라이더 없는 부스러기를 뚫고 지나가 보인다 (2026-09-14 3차)
      if (z <= CRAWL.z0 + 1 && z >= CRAWL.z1 - 1) continue;
      if (this.blocksRubble(x, z)) continue;   // 방벽 발밑 · 웅덩이 오르막 · 웅덩이 벽 · 절벽 구멍 · 함선 발자국 (2026-09-15)
      const w = rng.range(0.4, 1.6);
      flat.push(box(w, FLAT_DEBRIS_H * rng.range(0.5, 1), w * rng.range(0.5, 1.4), x, y + FLAT_DEBRIS_H / 2, z, rng.range(0, Math.PI)));
    }
  }

  /**
   * ⚠ `yaw` 는 **메시의 `rotateY`** 값이다. `Obstacle.box.yaw` 는 부호가 반대인 수학 관례(`world/obb.ts` 의
   * `toLocal` · `extraction/Hull` 의 같은 주석)라 여기서 한 번 뒤집는다 — 안 뒤집으면 기울어진 폐허 벽의
   * 콜라이더가 그려진 판과 **거울상**이 된다 (2026-09-14 2차에 바로잡았다).
   */
  private addBox(
    hash: SpatialHash, x: number, y: number, z: number, hx: number, hz: number, yaw: number, height: number, kind: string,
  ): ObstacleEntry {
    const e = hash.addBox(new THREE.Vector3(x, y, z), hx, hz, -yaw, height, kind);
    this.entries.push(e);
    return e;
  }

  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): void {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.disposables.push(merged);
  }

  dispose(hash: SpatialHash): void {
    for (const e of this.entries) hash.remove(e);
    this.entries.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}
