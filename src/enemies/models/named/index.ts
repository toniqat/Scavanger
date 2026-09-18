/**
 * src/enemies/models/named/index.ts — **the look dispatch for named rogues · the scan drone** (2026-09-11).
 *
 * All four build on the humanoid rogue rig (`models/RogueModel`); one file per type adds the parts
 * (`decorate*` — the hammer · minigun · long sniper rifle · drone body) and adds a pose every frame (`animate*`, **after** the base `animateRogue`).
 * The parts and their state hang on `RogueRig.named` as a per-type object.
 *
 * ⚠ Circular import: `RogueModel` calls this file **by value**, so the files in this folder take
 * **`import type` only** from `RogueModel`. Shared geometry · materials they need are built inside their own file.
 */
import * as THREE from 'three';
import type { BugAnim } from '../BugModel';
import { closestOnSegment, nearestOnCapsule, raySegmentCapsule } from '../../RayTests';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';
import { animateSniperLook, decorateSniperLook, disposeSniperLook, sniperBodyCapsule, sniperBodyCenterY } from './SniperLook';
import { animateHammerLook, decorateHammerLook, disposeHammerLook } from './HammerLook';
import { animateHeavyLook, decorateHeavyLook, disposeHeavyLook } from './HeavyLook';
import { animateScanDroneLook, decorateScanDroneLook, disposeScanDroneLook } from './ScanDroneLook';

/** Once at the end of `createRogueRig`. It does nothing for anything but a named. */
export function decorateNamedRig(rig: RogueRig): void {
  switch (rig.type) {
    case 'rogue_sniper': decorateSniperLook(rig); return;
    case 'rogue_hammer': decorateHammerLook(rig); return;
    case 'rogue_heavy': decorateHeavyLook(rig); return;
    case 'rogue_scan_drone': decorateScanDroneLook(rig); return;
    default: return;
  }
}

/** Every frame in `Enemy.animate`, right after `animateRogue`. `e.namedHint` is filled by the host AI and the replica alike. */
export function animateNamedRig(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  switch (rig.type) {
    case 'rogue_sniper': animateSniperLook(rig, a, e, dt); return;
    case 'rogue_hammer': animateHammerLook(rig, a, e, dt); return;
    case 'rogue_heavy': animateHeavyLook(rig, a, e, dt); return;
    case 'rogue_scan_drone': animateScanDroneLook(rig, a, e, dt); return;
    default: return;
  }
}

/* ── non-vertical body test (C-55) ── */
const _ba = new THREE.Vector3();
const _bb = new THREE.Vector3();
/** `namedBodyRay`'s answer: this enemy uses the ordinary vertical capsule. */
export const BODY_RAY_VERTICAL = -2;

/**
 * For a pose whose body test is **not a vertical capsule** (today only a prone Roden), the distance from the ray to that
 * capsule (-1 on a miss); `BODY_RAY_VERTICAL` when the ordinary vertical capsule is to be used. `EnemySystem.raycastEx` calls it per enemy, so it returns at once for anything but a named.
 */
export function namedBodyRay(e: Enemy, o: THREE.Vector3, d: THREE.Vector3): number {
  if (e.type !== 'rogue_sniper') return BODY_RAY_VERTICAL;
  const r = sniperBodyCapsule(e, _ba, _bb);
  return r > 0 ? raySegmentCapsule(o, d, _ba, _bb, r) : BODY_RAY_VERTICAL;
}

/** Outward normal at a point hit through `namedBodyRay` (hit point − the nearest point on the capsule axis, before normalising) → `out`. */
export function namedBodyNormal(e: Enemy, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (e.type !== 'rogue_sniper' || sniperBodyCapsule(e, _ba, _bb) <= 0) return out.set(point.x - e.position.x, 0, point.z - e.position.z);
  closestOnSegment(point, _ba, _bb, out);
  return out.set(point.x - out.x, point.y - out.y, point.z - out.z);
}

/**
 * For a pose whose body test is not a vertical capsule (a prone Roden), writes the point of **the same capsule
 * `namedBodyRay` uses** nearest to `from` into `out` and returns true; false when the ordinary vertical capsule is to be used (C-62 — `Enemy.nearestBodyPoint` → the `weapons/Melee` cone).
 */
export function namedBodyNearest(e: Enemy, from: THREE.Vector3, out: THREE.Vector3): boolean {
  if (e.type !== 'rogue_sniper') return false;
  const r = sniperBodyCapsule(e, _ba, _bb);
  if (r <= 0) return false;
  nearestOnCapsule(from, _ba, _bb, r, out);
  return true;
}

/** Body centre height an explosion measures to (above the feet, m) — half the height by default, the middle of the body capsule for a prone Roden. */
export function namedBodyCenterY(e: Enemy): number {
  return e.type === 'rogue_sniper' ? sniperBodyCenterY(e) : e.stats.height * 0.5;
}

/** From `disposeRogueRig`. Releases the instance materials and the like that the type's file created. */
export function disposeNamedRig(rig: RogueRig): void {
  switch (rig.type) {
    case 'rogue_sniper': disposeSniperLook(rig); return;
    case 'rogue_hammer': disposeHammerLook(rig); return;
    case 'rogue_heavy': disposeHeavyLook(rig); return;
    case 'rogue_scan_drone': disposeScanDroneLook(rig); return;
    default: return;
  }
}
