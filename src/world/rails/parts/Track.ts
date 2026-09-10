/**
 * src/world/rails/parts/Track.ts — **선로 지오메트리 · 발판 콜라이더**.
 *
 * `Rails` 에서 떼어낸 메서드 묶음이고 상태는 없다 (2026-09-10 분할). 만드는 것은
 * ① 침목 · 레일 · 교각의 병합용 지오메트리, ② 교각 콜라이더, ③ **걸어 다니는 선로 발판** 상자다.
 *
 * 규약 두 가지:
 *  - **로컬 +X = 진행 방향, 로컬 +Z = 좌우** (`rails/model` 의 축 규약).
 *  - `Obstacle.box.yaw` 는 수학 규약, 같은 상자를 그리는 메시의 Euler 는 `-yaw` 다.
 */
import * as THREE from 'three';
import { Layers, type Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import {
  GAUGE_HALF, PIER_STEP, RAIL_DECK_HALF_W, RAIL_DECK_STEP, RAIL_DECK_T, STEEL, STEEL_DARK, TIE_COLOR, TIE_STEP,
  type RailBuild, type RailPath, sampleAt,
} from '../model';

/**
 * 침목 · 레일 토막 · 교각을 세우고, `RAIL_DECK_STEP` 마다 **얇은 발판 상자**를 이어 붙인다.
 *
 * 발판이 있어야 선로 위를 걸어 다닌다 (예전에는 교각만 콜라이더라 침목 사이로 그대로 빠졌다).
 * 윗면이 레일 상면과 같으므로 `getSurfaceY` 가 그것을 잡고, 땅에서 `RAIL_DECK_Y`(0.75 m,
 * `PROP_STEP_UP_MAX` 안) 만큼 올라선다. 침목마다 걸지 않는 이유는 `rails/model` 의 주석에 있다.
 */
export function buildTrack(ctx: BuildCtx, rng: Random, path: RailPath, out: RailBuild): void {
  const parts: THREE.BufferGeometry[] = [];
  const pos = new THREE.Vector3(), tan = new THREE.Vector3();

  // 침목 + 레일 토막: 구간마다 한 덩어리로 놓아 곡선을 따라간다
  for (let s = 0; s < path.total; s += TIE_STEP) {
    sampleAt(path, s, pos, tan);
    const yaw = Math.atan2(tan.z, tan.x);
    const tie = new THREE.BoxGeometry(0.9, 0.16, GAUGE_HALF * 2 + 0.5);
    xform(tie, { x: pos.x, y: pos.y - 0.16, z: pos.z }, new THREE.Euler(0, -yaw, 0));
    paint(tie, TIE_COLOR, 0.09, rng);
    parts.push(tie);
    for (const side of [-1, 1]) {
      const rail = new THREE.BoxGeometry(TIE_STEP + 0.12, 0.14, 0.16);
      xform(rail, { x: 0, y: 0, z: side * GAUGE_HALF });
      xform(rail, { x: pos.x, y: pos.y - 0.04, z: pos.z }, new THREE.Euler(0, -yaw, 0));
      paintGradient(rail, STEEL_DARK, STEEL);
      parts.push(rail);
    }
  }

  // 교각 (지형까지 내려가는 기둥)
  for (let s = 0; s < path.total; s += PIER_STEP) {
    sampleAt(path, s, pos, tan);
    const ground = ctx.terrain.getHeightAt(pos.x, pos.z);
    const h = Math.max(0.4, pos.y - 0.3 - ground);
    const yaw = Math.atan2(tan.z, tan.x);
    const pier = new THREE.BoxGeometry(0.55, h, 0.55);
    xform(pier, { x: pos.x, y: ground + h / 2, z: pos.z }, new THREE.Euler(0, -yaw, 0));
    paintGradient(pier, STEEL_DARK, STEEL, ground, ground + h);
    parts.push(pier);
    const cap = new THREE.BoxGeometry(1.5, 0.2, GAUGE_HALF * 2 + 0.7);
    xform(cap, { x: pos.x, y: ground + h + 0.1, z: pos.z }, new THREE.Euler(0, -yaw, 0));
    paint(cap, STEEL_DARK, 0.05, rng);
    parts.push(cap);
    ctx.hash.addBox(new THREE.Vector3(pos.x, ground, pos.z), 0.3, 0.3, yaw, h, 'pier');
  }

  // 걸어 다니는 발판
  for (let s = 0; s < path.total; s += RAIL_DECK_STEP) {
    sampleAt(path, s + RAIL_DECK_STEP / 2, pos, tan);
    const yaw = Math.atan2(tan.z, tan.x);
    ctx.hash.addBox(
      new THREE.Vector3(pos.x, pos.y - RAIL_DECK_T, pos.z),
      RAIL_DECK_STEP / 2 + 0.15, RAIL_DECK_HALF_W, yaw, RAIL_DECK_T, 'rail',
    );
  }

  const geo = merge(parts);
  out.geos.push(geo);
  const mesh = new THREE.Mesh(geo, out.mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(Layers.PROP);
  mesh.name = 'rail_track';
  out.group.add(mesh);
}
