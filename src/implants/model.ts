/**
 * src/implants/model.ts — the implant folder's shared vocabulary.
 *
 * Only the constants · types (and the stateless helper classes) split off from `ImplantSystem`. It references no
 * class, so a `parts/*` module can use it without importing `ImplantSystem.ts` back (which avoids an import cycle).
 * `ImplantSystem.ts` re-exports it with `export *`, so every existing import path is kept.
 */
import * as THREE from 'three';
import {
  type PlayerRef, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';

export type Host = PlayerRef & Partial<PlayerWeaponHost>;

/** Speed-modifier key of the raised shield (the contract with player/). */
export const SHIELD_SPEED_KEY = 'shield';
/** Speed (m/s) of the grapple hook flying to its anchor. */
export const GRAPPLE_FLY_SPEED = 90;
/** The pull auto-releases when the player gets this close to the anchor, or after this long. */
export const GRAPPLE_ARRIVE_DIST = 2.6;
export const GRAPPLE_MAX_TIME = 5;
/** Cooldown / barrier / energy readouts are pushed to the HUD at most this often (plus every discrete change). */
export const HUD_EMIT_INTERVAL = 0.1;
/** Overcharge network throttles. */
export const HEAL_SEND_INTERVAL = 0.2;
export const BOOST_SEND_INTERVAL = 0.5;
/** The buff is refreshed every frame while channelling and lingers this long after the channel ends. */
export const BOOST_LINGER = 0.6;
/** Channelling may start only with this much energy (seconds) left. */
export const OVERCHARGE_MIN_START = 0.75;
/** Phase 7: `imp beam` refresh period while the overcharge beam is on (on / target change / off go out at once). */
export const BEAM_SEND_INTERVAL = 0.25;
/** 2026-09-11: a grapple hooked on a (moving) air drone re-sends `imp grapple {o, p}` this often while attached (≤ 4 Hz). */
export const GRAPPLE_SEND_INTERVAL = BEAM_SEND_INTERVAL;
/** Blocked hits between two replicated shield-durability updates. */
export const BARRIER_SEND_EVERY_HITS = 4;
/** Phase 12: a melee attack from farther than this (m, from the carrier) is never "frontal" for `absorbFrontalAttack`. */
export const ABSORB_RANGE = 3;
/** Phase 12: `implant:barrierBumped` sparks are throttled to one per this many seconds (enemies/ emits per bug per tick). */
export const BUMP_FX_INTERVAL = 0.12;
/** Phase 12: how long the 정찰 pulse shell takes to reach `IMPLANT_SCAN_RADIUS` (s). */
export const SCAN_PULSE_FX_S = 1.6;
/** Phase 12: 실드 배쉬 swing FX — streak height above the feet and how far past the panel width it sweeps. */
export const BASH_FX_Y = 1.1;

export const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3();
export const _from = new THREE.Vector3(), _muzzle = new THREE.Vector3(), _hitPt = new THREE.Vector3();
export const _bp = new THREE.Vector3(), _tmp = new THREE.Vector3();
export const _n = new THREE.Vector3(), _r = new THREE.Vector3(), _hp = new THREE.Vector3();

export function tuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/**
 * Tactical implants (전술 임플란트). Publishes `ctx.implants`.
 *
 * One implant is equipped in the ship and carried into the raid. **Q** (`Keys.IMPLANT`) drives it in three ways
 * (`ImplantDef.mode`, reworked 2026-09-06):
 *   - `instant` (갈고리 / 대시 / **정찰** since Phase 12): the press casts. The grapple fires at the crosshair anchor
 *     right away and a second press cuts the wire; the 정찰 pulse is one wide reveal shared with the squad; the gun
 *     stays in hand throughout.
 *   - `hold` (오버차지): the effect runs while Q is held — the overcharge channel heals the caster slowly (and the
 *     ally under the crosshair faster) and drains an energy pool that refills while released. The gun stays in hand.
 *   - `wielded` (**배리어** since Phase 10; 대전차포 retired 2026-09-15): Q takes it into the hands (weapons holster),
 *     LMB or the melee key **bashes** with the shield (Phase 12), Q — or any weapon key, handled by
 *     weapons/ via `stow()` — puts it away.
 *
 * Phase 12 (2026-09-08): the raised shield is also a **wall for bugs** (`resolveBarrierCollision`, called by enemies/
 * per simulated bug) and takes a frontal melee attack instead of the carrier (`absorbFrontalAttack`, called by the
 * host's enemies/ before enemy melee damage).
 *
 * Everything is simulated locally and only *shown* to the other players (`imp` messages); friendly effects on
 * someone else's character travel as `buff`. Cooldowns are multiplied by `ctx.progression?.derived.implantCooldownMul`.
 */

