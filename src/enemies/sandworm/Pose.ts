/**
 * src/enemies/sandworm/Pose.ts — **sandworm pose hints** (2026-09-13).
 *
 * The authority (the sandworm tick in `sandworm/Director`) and the replica (`net/Replica.drive`) resolve the wire hint
 * into a pose with the **same function** — the mouth opening · throat surge · lean the host sees never go out of step
 * with a non-host's screen. The hints are `EnemyWire.a` 21 · 22 (`shared/net.ts`, `EnemyEventAppended2026_09_13`). No judgement, no timers.
 */
import type { Enemy } from '../Enemy';

/** Spitting bugs — the throat surges and the mouth opens wide. */
export const WORM_HINT_SPIT = 21;
/** Acid volley wind-up · fire — leans forward and opens the mouth. */
export const WORM_HINT_ACID = 22;

/** Eases `e.anim`'s mouth opening (`mandible`) · throat surge (`abdomen`) · lean (`aim`) · tremble (`shake`) toward `hint`. */
export function applyWormHint(e: Enemy, hint: number, dt: number): void {
  const a = e.anim;
  const spit = hint === WORM_HINT_SPIT;
  const acid = hint === WORM_HINT_ACID;
  const mandT = spit ? 1 : acid ? 0.75 : 0.15;
  const abdT = spit ? 1 : 0;
  const aimT = acid ? 1 : 0;
  const shakeT = e.emergeT > 0 ? 1 : 0;
  a.mandible += (mandT - a.mandible) * Math.min(1, dt * (mandT > a.mandible ? 6 : 3));
  a.abdomen += (abdT - a.abdomen) * Math.min(1, dt * (abdT > a.abdomen ? 4 : 2));
  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 5 : 2));
  a.shake += (shakeT - a.shake) * Math.min(1, dt * (shakeT > a.shake ? 8 : 2));
  a.speed = 0;
}
