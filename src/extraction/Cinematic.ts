import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { EXTRACTION_CINEMATIC_BLEND_S } from '@/shared';
import type { Dropship } from './Ship';

/**
 * src/extraction/Cinematic.ts — **the liftoff cinematic camera** (2026-09-13 extraction rework, user's decision).
 *
 * The question this file answers: *what does someone see once the departure grace ends and the ship carries them away.*
 *
 * The character camera blends into an external camera behind the ship over `EXTRACTION_CINEMATIC_BLEND_S`, and from
 * there **trails the flying ship late** (damped chase) — as the ship accelerates the camera falls behind and it
 * recedes into the sky. The HUD is faded out by ui/ on `ui:cinematic`.
 *
 * The blend is done here instead of leaning on `PlayerRef.setCameraOverride`'s damping (12): every frame hands over an
 * **already blended** position with `snap = true`, so the override position on the first frame *is* the current camera
 * position and nothing jumps. It is driven from `update` — extraction is registered after player, and the override is
 * consumed by player's `lateUpdate`.
 */

/** Settled shot: behind-right of the ship and a little above its deck, in the ship's yaw frame (local +Z = rear). */
const CAM_OFFSET = new THREE.Vector3(7.5, 3.2, 17);
/** Where the shot looks: the middle of the hull (ship-local, full attitude). */
const LOOK_LOCAL = new THREE.Vector3(0, 1.6, -3);
/** Follow rate (1/s) of the chase point — low, so the accelerating ship pulls away from the camera. */
const FOLLOW_RATE = 1.1;
/** Never put the camera underground. */
const MIN_ABOVE_TERRAIN = 1.5;

const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _outLook = new THREE.Vector3();

const smooth = (t: number): number => t * t * (3 - 2 * t);

export class DepartureCinematic {
  active = false;
  private t = 0;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromLook = new THREE.Vector3();
  private readonly chase = new THREE.Vector3();

  start(ctx: GameContext, ship: Dropship): void {
    this.active = true;
    this.t = 0;
    const cam = ctx.camera;
    this.fromPos.copy(cam.position);
    cam.getWorldDirection(_dir);
    this.fromLook.copy(cam.position).addScaledVector(_dir, 12);
    this.target(ship, this.chase);
    // an open screen would sit over the shot and keep the cursor — the ride is not interactive any more
    ctx.inventory?.closeAll();
    ctx.bus.emit('ui:cinematic', { active: true });
  }

  update(dt: number, ctx: GameContext, ship: Dropship): void {
    if (!this.active) return;
    this.t += dt;
    this.target(ship, _target);
    this.chase.lerp(_target, 1 - Math.exp(-FOLLOW_RATE * dt));
    const world = ctx.world;
    if (world?.ready) {
      const floor = world.getHeightAt(this.chase.x, this.chase.z) + MIN_ABOVE_TERRAIN;
      if (this.chase.y < floor) this.chase.y = floor;
    }
    ship.root.updateMatrixWorld(true);
    _look.copy(LOOK_LOCAL).applyMatrix4(ship.root.matrixWorld);
    const e = smooth(Math.min(1, this.t / Math.max(0.05, EXTRACTION_CINEMATIC_BLEND_S)));
    _pos.lerpVectors(this.fromPos, this.chase, e);
    _outLook.lerpVectors(this.fromLook, _look, e);
    ctx.player?.setCameraOverride(_pos, _outLook, true);
  }

  /** Hand the camera back (hard cut — the ship is far away by now) and bring the HUD back. */
  stop(ctx: GameContext): void {
    if (!this.active) return;
    this.active = false;
    ctx.player?.setCameraOverride(null, undefined, true);
    ctx.bus.emit('ui:cinematic', { active: false });
  }

  private target(ship: Dropship, out: THREE.Vector3): THREE.Vector3 {
    const p = ship.root.position;
    ship.bayToWorld(CAM_OFFSET.x, CAM_OFFSET.z, p.y + CAM_OFFSET.y, out);
    return out;
  }
}
