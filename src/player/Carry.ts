import type * as THREE from 'three';

/**
 * 부상자 들쳐메기 (Phase 10) — the seam between the two systems in this folder.
 *
 * `PlayerSystem` owns the rules (`PlayerRef.carry / dropCarried / carrying / isCarried / setCarriedBy`, the F-tap
 * precedence and the carry pose) but it must not know how remote bodies are built; `RemotePlayerSystem` owns the
 * `RemoteAvatar`s, the interpolated refs and the debug refs, so it implements this host and registers itself with
 * `PlayerSystem.setCarryHost(this)` in its own `init` (it is registered right after the player, so `ctx.player`
 * already exists).
 */
export interface CarryTarget {
  id: string;
  name: string;
  /** The peer's live position vector (the ref's own instance — do not mutate). */
  position: THREE.Vector3;
}

/** Why a carry can no longer continue (mapped onto `CarryEndReason` by `PlayerSystem`). */
export type CarryStatus = 'ok' | 'revived' | 'died' | 'gone';

export interface CarryHost {
  /** Nearest carriable (downed, alive, present, not already carried) squadmate within `range` of `from`. */
  findCarriable(from: THREE.Vector3, range: number): CarryTarget | null;
  /** That peer as a carry target, or null when it is not carriable right now. */
  targetOf(id: string): CarryTarget | null;
  /** Why an in-progress carry must end (`'ok'` = keep going). */
  carryStatus(id: string): CarryStatus;
  /** Parent that peer's avatar into `socket` (our right shoulder). false when the peer has no avatar. */
  attachCarried(id: string, socket: THREE.Object3D): boolean;
  /** Put that peer's avatar back into the scene, standing at `position`. */
  detachCarried(id: string, position: THREE.Vector3): void;
}
