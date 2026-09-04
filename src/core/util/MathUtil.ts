import * as THREE from 'three';

/** Frame-rate independent exponential approach: returns value moved toward target. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

export function dampVec3(current: THREE.Vector3, target: THREE.Vector3, lambda: number, dt: number): THREE.Vector3 {
  const t = 1 - Math.exp(-lambda * dt);
  current.x += (target.x - current.x) * t;
  current.y += (target.y - current.y) * t;
  current.z += (target.z - current.z) * t;
  return current;
}

/** Shortest-path angle damp (radians). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-lambda * dt));
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function easeOutCubic(t: number): number { const u = 1 - clamp01(t); return 1 - u * u * u; }
export function easeInCubic(t: number): number { const u = clamp01(t); return u * u * u; }
export function easeInOutSine(t: number): number { return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2; }
export function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1, u = clamp01(t) - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/**
 * Critically damped spring for scalars (Unity-style SmoothDamp).
 * `state` holds {value, velocity}; mutated in place.
 */
export interface SpringState { value: number; velocity: number }
export function smoothDamp(state: SpringState, target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = state.value - target;
  const maxChange = maxSpeed * smoothTime;
  change = THREE.MathUtils.clamp(change, -maxChange, maxChange);
  const temp = (state.velocity + omega * change) * dt;
  state.velocity = (state.velocity - omega * temp) * exp;
  let out = (state.value - change) + (change + temp) * exp;
  if ((target - state.value > 0) === (out > target)) { out = target; state.velocity = 0; }
  state.value = out;
  return out;
}

/** Cheap deterministic 1-D value noise in [-1, 1] built from summed sines. */
export function noise1(t: number, seed = 0): number {
  return (
    Math.sin(t * 1.0 + seed * 1.7) * 0.5 +
    Math.sin(t * 2.3 + seed * 3.1) * 0.3 +
    Math.sin(t * 5.1 + seed * 0.7) * 0.2
  );
}

/** Random unit vector inside a cone around `dir` (half-angle in radians). Writes `out`. */
export function randomInCone(dir: THREE.Vector3, halfAngle: number, out: THREE.Vector3, tmpA: THREE.Vector3, tmpB: THREE.Vector3): THREE.Vector3 {
  if (halfAngle <= 0) return out.copy(dir);
  // orthonormal basis
  tmpA.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.99) tmpA.set(1, 0, 0);
  tmpA.cross(dir).normalize();          // right
  tmpB.crossVectors(dir, tmpA).normalize(); // up
  const ang = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * Math.tan(halfAngle);
  out.copy(dir).addScaledVector(tmpA, Math.cos(ang) * r).addScaledVector(tmpB, Math.sin(ang) * r).normalize();
  return out;
}
