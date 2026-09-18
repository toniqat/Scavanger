/**
 * src/world/rails/parts/Track.ts — **the rail geometry · the deck colliders**.
 *
 * A bundle of methods taken out of `Rails`, with no state (the 2026-09-10 split). It builds
 * ① the merge geometry of ties · rails · piers, ② the pier colliders, ③ the **walkable rail deck** boxes.
 *
 * Two conventions:
 *  - **Local +X = the travel direction, local +Z = sideways** (`rails/model`'s axis convention).
 *  - `Obstacle.box.yaw` is the math convention; the mesh drawing the same box has Euler `-yaw`.
 */
import * as THREE from 'three';
import { Layers, type Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import {
  GAUGE_HALF, PIER_STEP, RAIL_DECK_HALF_W, RAIL_DECK_STEP, RAIL_DECK_T, STEEL, STEEL_DARK, TIE_COLOR, TIE_STEP,
  type RailBuild, type RailPath, sampleAt,
} from '../model';

/**
 * Builds the ties, the rail segments and the piers, and chains a **thin deck box** every `RAIL_DECK_STEP`.
 *
 * Without the deck the rail is not walkable (only the piers used to be colliders, so people fell straight through
 * between the ties). Its top face is level with the rail top face, so `getSurfaceY` catches it and one steps up
 * `RAIL_DECK_Y` (0.75 m, within `PROP_STEP_UP_MAX`) from the ground. Why not one per tie is in `rails/model`'s comment.
 */
export function buildTrack(ctx: BuildCtx, rng: Random, path: RailPath, out: RailBuild): void {
  const parts: THREE.BufferGeometry[] = [];
  const pos = new THREE.Vector3(), tan = new THREE.Vector3();

  // Ties + rail segments: one lump per stretch, so they follow the curve
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

  // Piers (columns running down to the terrain)
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

  // The walkable deck
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
