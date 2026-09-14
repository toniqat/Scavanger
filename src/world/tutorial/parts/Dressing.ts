import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  BROKEN_WALL, CLIFF2_EDGE_Z, CRAWL, DECK_LOWER_Y, DECK_UPPER_Y, DRESSING_SEED, RUINS, box, corridorHalfXAt,
  crawlClearanceAt, inChasm,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * 손으로 지은 구조물 — 시작 폐허 · 무너진 통로(포복 구간) · 무너진 벽 · 돌부스러기.
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
 * ──────────────────────────────────────────────────────────────────────────── */

/** 콜라이더 없이 그리기만 하는 최대 높이 (발을 걸지 않고 넘어간다 — `PROP_STEP_UP_MAX` 0.9 보다 낮다). */
const FLAT_DEBRIS_H = 0.35;

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
    this.disposables.push(concrete, rust);

    const solid: THREE.BufferGeometry[] = [];   // 콜라이더가 붙는 콘크리트
    const flat: THREE.BufferGeometry[] = [];    // 바닥 부스러기 (콜라이더 없음)

    this.buildRuins(hash, solid, flat, rng);
    this.buildCrawl(hash, solid, rng);
    this.buildBrokenWall(hash, solid, flat, rng);
    this.scatterRubble(flat, rng);

    this.addMerged(solid, concrete, 'tut-concrete');
    this.addMerged(flat, rust, 'tut-debris');
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
    // 넘어진 안테나 기둥 (눕혀 둔 원기둥 — 넘어가는 높이라 콜라이더를 주지 않는다). x −2.92 … 5.72
    const mast = new THREE.CylinderGeometry(0.35, 0.45, 9, 8);
    mast.rotateZ(Math.PI / 2);
    mast.rotateY(0.4);
    mast.translate(1.4, y + 0.4, 109);
    flat.push(mast);
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
   * 2026-09-14 4차: 기울기의 **부호가 뒤집혔고**(입구 1.35 → 출구 1.95) 조각이 7 장, 두께가 2.4 다.
   * 이 파일의 식은 한 줄도 안 바뀐다 — 그림의 중심(`clearance + slabThickness / 2`)도 콜라이더의 base 도
   * **밑면 기준**이라 두께를 키우면 위로만 자라고, 기울기는 `crawlClearanceAt` 이 부호째 답한다.
   * 검산(양 끝 · 조각별 밑면)은 전부 `CRAWL.slabSlope` 주석에 있다.
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

  /* ── 무너진 벽: 가운데만 뚫려 있다 ── */
  private buildBrokenWall(hash: SpatialHash, solid: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random): void {
    const y = DECK_LOWER_Y, z = BROKEN_WALL.z, h = BROKEN_WALL.height, t = BROKEN_WALL.thickness;
    const corridor = corridorHalfXAt(z);
    for (const sx of [-1, 1]) {
      const inner = sx * BROKEN_WALL.gapHalfX, outer = sx * corridor;
      const cx = (inner + outer) / 2, half = Math.abs(outer - inner) / 2;
      solid.push(box(half * 2, h, t, cx, y + h / 2, z));
      this.addBox(hash, cx, y, z, half, t / 2, 0, h, 'tut_wall_break');
      // 틈 가장자리의 부서진 이빨
      for (let i = 0; i < 3; i++) {
        const s = rng.range(0.6, 1.3);
        solid.push(box(s, s, t * 0.9, inner + sx * rng.range(0.4, 2.4), y + h + s / 2 - 0.3, z, rng.range(-0.3, 0.3)));
      }
    }
    flat.push(box(BROKEN_WALL.gapHalfX * 2, FLAT_DEBRIS_H, 3.0, 0, y + FLAT_DEBRIS_H / 2, z, 0));
  }

  /* ── 통로 전체에 흩뿌린 바닥 부스러기 (전부 콜라이더 없음) ── */
  private scatterRubble(flat: THREE.BufferGeometry[], rng: Random): void {
    for (let i = 0; i < 90; i++) {
      const z = rng.range(-160, RUINS.z0);
      const y = z > CLIFF2_EDGE_Z ? DECK_UPPER_Y : DECK_LOWER_Y;
      // 벽에서 2 m 떨어뜨린다 — 좁은 구간에서는 그 구간의 반폭을 기준으로 (rng 호출 순서는 그대로다)
      const lim = Math.max(2.5, corridorHalfXAt(z) - 2);
      const x = rng.range(-lim, lim);
      if (inChasm(x, z, 1.5)) continue;        // 절벽 1 의 틈에는 아무것도 없다 (2026-09-14 3차: 사선이다)
      // 포복 구간 — 엎드린 몸이 콜라이더 없는 부스러기를 뚫고 지나가 보인다 (2026-09-14 3차)
      if (z <= CRAWL.z0 + 1 && z >= CRAWL.z1 - 1) continue;
      const w = rng.range(0.4, 1.6);
      flat.push(box(w, FLAT_DEBRIS_H * rng.range(0.5, 1), w * rng.range(0.5, 1.4), x, y + FLAT_DEBRIS_H / 2, z, rng.range(0, Math.PI)));
    }
  }

  /**
   * ⚠ `yaw` 는 **메시의 `rotateY`** 값이다. `Obstacle.box.yaw` 는 부호가 반대인 수학 관례(`world/obb.ts` 의
   * `toLocal` · `extraction/Hull` 의 같은 주석)라 여기서 한 번 뒤집는다 — 안 뒤집으면 기울어진 폐허 벽의
   * 콜라이더가 그려진 판과 **거울상**이 된다 (2026-09-14 2차에 바로잡았다).
   */
  private addBox(hash: SpatialHash, x: number, y: number, z: number, hx: number, hz: number, yaw: number, height: number, kind: string): void {
    this.entries.push(hash.addBox(new THREE.Vector3(x, y, z), hx, hz, -yaw, height, kind));
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
