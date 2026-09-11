import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────────────────
 * Allocation-free analytic ray tests shared by hit detection (EnemySystem.raycast), rogue hitscan shots and shell
 * interception. `raySegmentCapsule` is the any-orientation capsule (a lying body); `rayCapsule` stays the fast vertical one.
 * C-62 (2026-09-11): `nearestOnCapsule` / `nearestOnStandingCapsule` — the same capsules as nearest-point queries (melee).
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

/**
 * Ray vs a capsule of any orientation — segment `a`→`b`, radius `r` (C-55, 2026-09-11: the prone sniper's body).
 * Distance along `d` (unit) to the first surface point at t ≥ 0, or -1 — same convention as `raySphere` (a ray starting
 * inside gets the exit). Allocation-free: plain arithmetic on the side cylinder + the two end spheres.
 * The surface normal at the hit is `point − closestPointOnSegment(point)`.
 */
export function raySegmentCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  let best = -1;
  if (baba > 1e-10) {
    const bard = bax * d.x + bay * d.y + baz * d.z;
    const baoa = bax * oax + bay * oay + baz * oaz;
    const rdoa = d.x * oax + d.y * oay + d.z * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    // |(o + t d − a) × ba|² = r² |ba|²  →  A t² + 2 B t + C = 0
    const A = baba - bard * bard;
    if (A > 1e-10) {
      const B = baba * rdoa - baoa * bard;
      const C = baba * oaoa - baoa * baoa - r * r * baba;
      const h = B * B - A * C;
      if (h >= 0) {
        const s = Math.sqrt(h);
        for (let k = 0; k < 2; k++) {
          const t = (-B + (k === 0 ? -s : s)) / A;
          if (t < 0) continue;
          const y = baoa + t * bard;                // axial coordinate × |ba|
          if (y >= 0 && y <= baba) { best = t; break; }
        }
      }
    }
  }
  const ta = raySphere(o, d, a, r);
  if (ta >= 0 && (best < 0 || ta < best)) best = ta;
  if (baba > 1e-10) {
    const tb = raySphere(o, d, b, r);
    if (tb >= 0 && (best < 0 || tb < best)) best = tb;
  }
  return best;
}

/** Closest point on segment `a`→`b` to `p`, written to `out` (the normal of a `raySegmentCapsule` hit is `p − out`). */
export function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  let t = baba > 1e-10 ? ((p.x - a.x) * bax + (p.y - a.y) * bay + (p.z - a.z) * baz) / baba : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return out.set(a.x + bax * t, a.y + bay * t, a.z + baz * t);
}

/**
 * Point of the capsule `a`→`b` (radius `r`) nearest to `p`, written to `out` — on the surface, or `p` itself when `p` is
 * already inside (C-62, 2026-09-11: melee aims at it). The axis point is `closestOnSegment`, the same one the hit normal uses.
 */
export function nearestOnCapsule(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, out: THREE.Vector3): THREE.Vector3 {
  closestOnSegment(p, a, b, out);
  const dx = p.x - out.x, dy = p.y - out.y, dz = p.z - out.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 <= r * r) return out.copy(p);
  const k = r / Math.sqrt(l2);
  return out.set(out.x + dx * k, out.y + dy * k, out.z + dz * k);
}

/**
 * Top axis height of a capsule standing at `feetY` (bottom axis = `feetY + r`) — the one rule the standing-capsule tests
 * share. 2026-09-11 (C-72): exported, because `EnemySystem.raycastEx` needs the raw `rayCapsule` result (kind / capY) and
 * so cannot go through `rayStandingCapsule`; it used to write the same `max(feetY + r, feetY + h − r)` a second time.
 */
export function standingTopY(feetY: number, r: number, h: number): number {
  return Math.max(feetY + r, feetY + h - r);
}

/** Ray vs a player-style capsule standing at `feet` (radius r, total height h). Distance or -1. */
export function rayStandingCapsule(o: THREE.Vector3, d: THREE.Vector3, feet: THREE.Vector3, r: number, h: number): number {
  return rayCapsule(o, d, feet.x, feet.z, feet.y + r, standingTopY(feet.y, r, h), r).t;
}

const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
/**
 * `nearestOnCapsule` for the capsule standing at `feet` (radius r, total height h) — the vertical body capsule
 * `EnemySystem.raycastEx` tests (axis `feet + r` … `max(that, feet + h − r)`; a short body degenerates to a sphere).
 */
export function nearestOnStandingCapsule(p: THREE.Vector3, feet: THREE.Vector3, r: number, h: number, out: THREE.Vector3): THREE.Vector3 {
  _ca.set(feet.x, feet.y + r, feet.z);
  _cb.set(feet.x, standingTopY(feet.y, r, h), feet.z);
  return nearestOnCapsule(p, _ca, _cb, r, out);
}
