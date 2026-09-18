/**
 * src/world/structures/parts/Stairs.ts — **one stair flight** (drawn steps + one ramp collider, 2026-09-11).
 *
 * User's request: "climbing stair terrain should glide up smoothly instead of jerking". The old stairs had one box
 * collider per step and a body **popped** up one step at a time through `getSurfaceY`. Now the collider is **one
 * ramp** (`Obstacle.ramp`) and the steps are drawing only. The ramp is the line through the **middle of each tread** —
 * joining the step edges makes the feet look half a step above the tread, joining the middles sinks them half a step
 * only at the edges. The upper and lower ends meet the two floors' heights exactly.
 *
 * Structures (basement · floor 1 → 2) and rail platforms use the same function.
 */
import * as THREE from 'three';
import type { Random } from '@/shared';
import { type BuildCtx, paintGradient, xform } from '../../build';
import { STAIR_STEP_RISE } from '../model';

export interface StairFlight {
  /** Middle of the high end (the edge meeting the upper floor), world XZ. */
  hx: number;
  hz: number;
  /** Horizontal unit vector, high end → low end. */
  ux: number;
  uz: number;
  width: number;
  /** Horizontal length (m). */
  run: number;
  topY: number;
  bottomY: number;
  /** Bottom face of the step solids — `bottomY` with none. A function gives the bottom at that spot
   * (platform stairs rise from the terrain). */
  solidY?: number | ((x: number, z: number) => number);
  /** Drawn height of one step (m). `STAIR_STEP_RISE` with none. */
  stepRise?: number;
  dark: THREE.Color;
  light: THREE.Color;
  kind: string;
}

/**
 * Draws the stairs (pushing pieces into `parts`) and adds the ramp collider. Every step is a solid rising
 * from the bottom face, so there is no gap under it.
 */
export function buildStairFlight(ctx: BuildCtx, parts: THREE.BufferGeometry[], _rng: Random, f: StairFlight): void {
  const rise = f.topY - f.bottomY;
  if (rise <= 0.02 || f.run <= 0.05) return;
  const n = Math.max(2, Math.round(rise / Math.max(0.1, f.stepRise ?? STAIR_STEP_RISE)));
  const tread = f.run / n;
  const yaw = Math.atan2(-f.uz, -f.ux);              // climbing direction = local +X (math convention)
  let baseMin = f.bottomY;
  for (let i = 0; i < n; i++) {
    const off = tread * (i + 0.5);
    const px = f.hx + f.ux * off, pz = f.hz + f.uz * off;
    const top = f.topY - (rise * (i + 0.5)) / n;
    const solid = typeof f.solidY === 'function' ? f.solidY(px, pz) : (f.solidY ?? f.bottomY);
    const base = Math.min(solid, top - 0.08);
    if (base < baseMin) baseMin = base;
    const h = Math.max(0.05, top - base);
    const g = new THREE.BoxGeometry(tread + 0.02, h, f.width);
    xform(g, { x: px, y: base + h / 2, z: pz }, new THREE.Euler(0, -yaw, 0));
    paintGradient(g, f.dark, f.light, base, top);
    parts.push(g);
  }
  const cx = f.hx + f.ux * (f.run / 2), cz = f.hz + f.uz * (f.run / 2);
  const baseY = Math.min(baseMin, f.bottomY) - 0.02;
  ctx.hash.addRamp(new THREE.Vector3(cx, baseY, cz), f.run / 2, f.width / 2, yaw, f.topY - baseY, rise, f.kind);
}
