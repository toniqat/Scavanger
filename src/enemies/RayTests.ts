import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────────────────
 * Allocation-free analytic ray tests shared by hit detection (EnemySystem.raycast), rogue hitscan shots and shell
 * interception.
 * ──────────────────────────────────────────────────────────────────────────── */

const _n = new THREE.Vector3();

/** Ray vs sphere: distance along `d` (unit) or -1. */
export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  return t < 0 ? -1 : t;
}

export interface CapsuleResult { t: number; kind: number; capY: number }
const capsuleResult: CapsuleResult = { t: -1, kind: 0, capY: 0 };

/** Ray vs vertical capsule (axis x=cx,z=cz from y0..y1, radius r). kind: 0 side, 1 cap. Returns a shared result object. */
export function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, cx: number, cz: number, y0: number, y1: number, r: number): CapsuleResult {
  const res = capsuleResult;
  res.t = -1; res.kind = 0; res.capY = y0;
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  let tSide = -1;
  if (a > 1e-8) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      let t = (-b - s) / a;
      if (t < 0) t = (-b + s) / a;
      if (t >= 0) {
        const y = o.y + d.y * t;
        if (y >= y0 && y <= y1) tSide = t;
      }
    }
  }
  if (tSide >= 0) { res.t = tSide; res.kind = 0; return res; }
  // caps
  _n.set(cx, y0, cz);
  let tc = raySphere(o, d, _n, r);
  let capY = y0;
  if (y1 > y0) {
    _n.set(cx, y1, cz);
    const t2 = raySphere(o, d, _n, r);
    if (t2 >= 0 && (tc < 0 || t2 < tc)) { tc = t2; capY = y1; }
  }
  if (tc >= 0) { res.t = tc; res.kind = 1; res.capY = capY; }
  return res;
}

/** Ray vs a player-style capsule standing at `feet` (radius r, total height h). Distance or -1. */
export function rayStandingCapsule(o: THREE.Vector3, d: THREE.Vector3, feet: THREE.Vector3, r: number, h: number): number {
  const y0 = feet.y + r;
  const y1 = Math.max(y0, feet.y + h - r);
  return rayCapsule(o, d, feet.x, feet.z, y0, y1, r).t;
}
