import * as THREE from 'three';
import { SHELL_ARC_GRAVITY } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * The shell arc (2026-09-10)
 *
 * The **closed form** of the parabola an artillery shell flies. `enemies/fx/ShellProjectile`
 * (the real shell) and `ui/hud/DangerIndicators` (the HUD danger indicator) have to draw
 * **the same spot**, and folders never import one another (`@/shared` only), so the formula
 * lives here in one place. The two used to keep a copy each — fix one and the marker comes
 * off the shell.
 *
 * The gravity is **`SHELL_ARC_GRAVITY`, not `GRAVITY`**. The apex height is `0.5 × g × (T/2)²`,
 * so with real gravity (9.81) a 6.3 s flight climbed to 49 m and fell back in off-screen. To
 * lower the arc, fix the one `SHELL_ARC_GRAVITY` line in `data/constants.csv` — the code stays.
 * ──────────────────────────────────────────────────────────────────────────── */

const _d = new THREE.Vector3();

/** `p(t) = from + vel0·t − ½·g·t²·ŷ`. `vel0` must be the value `shellLaunchVelocity` gave. */
export function shellPositionAt(from: THREE.Vector3, vel0: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(
    from.x + vel0.x * t,
    from.y + vel0.y * t - 0.5 * SHELL_ARC_GRAVITY * t * t,
    from.z + vel0.z * t,
  );
}

/** The launch velocity that lands exactly on `target` after `T` seconds (the caller clamps `T` to ≥ 0.5). */
export function shellLaunchVelocity(from: THREE.Vector3, target: THREE.Vector3, T: number, out: THREE.Vector3): THREE.Vector3 {
  _d.subVectors(target, from);
  return out.set(_d.x / T, _d.y / T + 0.5 * SHELL_ARC_GRAVITY * T, _d.z / T);
}

/** How far above the launch point the arc's apex is (m). For tuning and debugging. */
export function shellApexHeight(flightTime: number): number {
  const t = flightTime * 0.5;
  return 0.5 * SHELL_ARC_GRAVITY * t * t;
}
