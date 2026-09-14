import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  BROKEN_WALL, CRAWL, DECK_LOWER_Y, DECK_UPPER_Y, DRESSING_SEED, RUINS, box, corridorHalfXAt,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * 손으로 지은 구조물 — 시작 폐허 · 무너진 통로(포복 구간) · 무너진 벽 · 돌부스러기.
 *
 * 규칙 하나: **콜라이더가 있는 것만 큼직하게 그리고, 콜라이더 없는 것은 발끝보다 낮게 둔다.** 그래야
 * "보이는 실루엣이 콜라이더" (`CLAUDE.md`) 가 깨지지 않는다. 광원은 0개이고 켜져 보이는 것은 전부 emissive 다.
 *
 * 2026-09-14 2차 (통로 폭 축소): 통로에 닿는 x 는 전부 `corridorHalfXAt(z)` 에서 뽑는다 — 상수 반폭을 베껴
 * 쓰면 구간 프로파일을 고칠 때마다 소품이 벽 속에 묻히거나 벽 밖으로 삐져나온다. 시작 폐허의 벽 다섯 장은
 * 반폭 11 구간이라 손으로 안쪽으로 옮겼다.
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
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a4a4e, roughness: 0.6, metalness: 0.55, emissive: 0x0c0d0f, emissiveIntensity: 0.6 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x6b4530, roughness: 0.9, metalness: 0.25, emissive: 0x120a06, emissiveIntensity: 0.6 });
    this.disposables.push(concrete, steel, rust);

    const solid: THREE.BufferGeometry[] = [];   // 콜라이더가 붙는 콘크리트
    const metal: THREE.BufferGeometry[] = [];   // 콜라이더가 붙는 철골
    const flat: THREE.BufferGeometry[] = [];    // 바닥 부스러기 (콜라이더 없음)

    this.buildRuins(hash, solid, flat, rng);
    this.buildCrawl(hash, solid, metal, flat, rng);
    this.buildBrokenWall(hash, solid, flat, rng);
    this.scatterRubble(flat, rng);

    this.addMerged(solid, concrete, 'tut-concrete');
    this.addMerged(metal, steel, 'tut-steel');
    this.addMerged(flat, rust, 'tut-debris');
  }

  /* ── 시작 폐허: 깨어나는 자리를 감싸는 부서진 벽 몇 장과 넘어진 안테나 ── */
  private buildRuins(hash: SpatialHash, solid: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random): void {
    const y = DECK_UPPER_Y;
    // 반쯤 남은 벽 다섯 장 — 깨어난 자리(0, 112)를 둘러싸되 앞(−Z)은 열어 둔다.
    // 이 구간의 반폭은 11 이고 벽이 안쪽으로 최대 1.1 파고드므로(`Ground` 의 bite) 어느 장도 |x| 9.9 를 넘지 않는다.
    const walls: Array<[number, number, number, number, number]> = [
      // x, z, 길이, yaw, 높이
      [-5, 116, 9, 0, 3.4],
      [5, 115, 8, 0.12, 2.6],
      [-8.5, 107, 9, Math.PI / 2, 3.0],
      [8.8, 104, 12, Math.PI / 2 + 0.08, 2.2],
      [-4, 98, 7, 0.25, 1.9],
    ];
    for (const [x, z, len, yaw, h] of walls) {
      solid.push(box(len, h, 0.9, x, y + h / 2, z, yaw));
      this.addBox(hash, x, y, z, len / 2, 0.45, yaw, h, 'tut_ruin');
      // 벽 밑동의 무너진 조각
      flat.push(box(len * 0.8, FLAT_DEBRIS_H, 2.2, x + rng.range(-1, 1), y + FLAT_DEBRIS_H / 2, z + rng.range(-2, 2), yaw + 0.1));
    }
    // 넘어진 안테나 기둥 (눕혀 둔 원기둥 — 넘어가는 높이라 콜라이더를 주지 않는다)
    const mast = new THREE.CylinderGeometry(0.35, 0.45, 13, 8);
    mast.rotateZ(Math.PI / 2);
    mast.rotateY(0.4);
    mast.translate(2, y + 0.4, 109);
    flat.push(mast);
    // 포드 잔해 한 조각 — "여기서 떨어졌다" 를 말하는 유일한 소품
    solid.push(box(3.2, 2.0, 2.6, -2.5, y + 1.0, 118.5, 0.5));
    this.addBox(hash, -2.5, y, 118.5, 1.6, 1.3, 0.5, 2.0, 'tut_ruin');
  }

  /**
   * 무너진 통로 — 양옆이 잔해로 막혀 `CRAWL.gapHalfX` 만큼만 열려 있고, 그 위를 슬래브가 덮는다.
   * 슬래브 밑면은 `CRAWL.clearance`(1.6) — 선 몸(2.1)은 막고 앉은 몸(1.3)은 지나는 사이 값이다.
   * 거기에 콜라이더 없는 철근이 앉은 키 바로 위까지 늘어져 "숙여야 한다" 를 눈으로 먼저 말한다.
   */
  private buildCrawl(
    hash: SpatialHash, solid: THREE.BufferGeometry[], metal: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random,
  ): void {
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
    // 머리 위 슬래브 (가운데 틈을 덮는다)
    const slabW = CRAWL.gapHalfX * 2 + 1.2;
    solid.push(box(slabW, CRAWL.slabThickness, depth, 0, y + CRAWL.clearance + CRAWL.slabThickness / 2, zMid, 0));
    this.addBox(hash, 0, y + CRAWL.clearance, zMid, slabW / 2, depth / 2, 0, CRAWL.slabThickness, 'tut_crawl');
    // 늘어진 철근 · 케이블 (콜라이더 없음 — 지나가면 몸을 스친다)
    for (let i = 0; i < 9; i++) {
      const len = rng.range(0.15, 0.32);   // 끝이 앉은 키(1.3) 바로 위에 멈췄다 — 지나가는 머리를 뚫지 않는다
      metal.push(box(0.08, len, 0.08, rng.range(-CRAWL.gapHalfX + 0.3, CRAWL.gapHalfX - 0.3), y + CRAWL.clearance - len / 2, CRAWL.z1 + rng.range(0.5, depth - 0.5), rng.range(0, 1)));
    }
    flat.push(box(CRAWL.gapHalfX * 2, FLAT_DEBRIS_H, depth * 0.8, 0, y + FLAT_DEBRIS_H / 2, zMid, 0));
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
      const z = rng.range(-124, RUINS.z0);
      const y = z > -46 ? DECK_UPPER_Y : DECK_LOWER_Y;
      // 벽에서 2 m 떨어뜨린다 — 좁은 구간에서는 그 구간의 반폭을 기준으로 (rng 호출 순서는 그대로다)
      const lim = Math.max(2.5, corridorHalfXAt(z) - 2);
      const x = rng.range(-lim, lim);
      if (z < 83 && z > 77) continue;          // 절벽 1 의 틈에는 아무것도 없다
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
