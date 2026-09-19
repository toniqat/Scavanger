/**
 * src/allies/parts/Harness.ts — **the squad leader and the harness**.
 *
 * The harness = the radius an android follows and searches inside. Its centre is the **squad leader**
 * (`lobby.hostId`, or the local player when there is no lobby — user's decision). The user's decision 「PC 가 한쪽
 * 방향으로 계속 움직이면 하네스가 절반으로 줄어든다」 is implemented as an exponential average of heading
 * consistency (`commit`): the faster and the more in one direction the leader goes, the closer it gets to 1,
 * and the radius becomes `ALLY_HARNESS_RADIUS_M × lerp(1, ALLY_HARNESS_MIN_FRAC, commit)`.
 *
 * 2026-09-16 user's decision 「앞장서라 = 일반 범위의 2배로 각자 일대를 수색」 — up to `sys.leadUntil` it multiplies
 * by `ALLY_LEAD_HARNESS_MUL` last. **Widening the one radius** is enough: following · the free search · the
 * cover spot · the extraction clamp all read the same value, so no consumer needs a fix of its own
 * (`sys.harness` is the only way out).
 */
import * as THREE from 'three';
import {
  ALLY_HARNESS_COMMIT_SPEED, ALLY_HARNESS_COMMIT_TAU_S, ALLY_HARNESS_MIN_FRAC, ALLY_HARNESS_RADIUS_M,
  ALLY_LEAD_HARNESS_MUL, ALLY_LOCAL_PEER, isAndroidId,
} from '@/shared';
import type { PeerId } from '@/shared';
import type { AllySystem } from '../AllySystem';

const _dir = new THREE.Vector3();
let override: THREE.Vector3 | null = null;

/**
 * For the smokes — overwrites the squad leader's position (null clears it). It is **module state**, so it is
 * dropped on every raid boundary (`AllySystem.clearPingOrders` → `clearDebug`, on `world:ready` · `game:abort`):
 * a smoke that set it and never cleared it would otherwise pin the harness centre for the rest of the session.
 */
export function debugOverride(sys: AllySystem, pos: THREE.Vector3 | null): void {
  override = pos ? pos.clone() : null;
  void sys;
}

/** Drops the smoke override (a new map · leaving a raid). */
export function clearDebug(): void {
  override = null;
}

/**
 * The squad leader's PeerId now — the lobby host, or the local player when there is no lobby. A bot is never
 * the host (the relay contract).
 */
export function leaderOf(sys: AllySystem): PeerId {
  const host = sys.ctx.net?.lobby?.hostId;
  if (host && !isAndroidId(host)) return host;
  return sys.ctx.net?.localId ?? ALLY_LOCAL_PEER;
}

/** Writes the squad leader's feet position into `out`. false when it is unknown (that frame follows nothing). */
export function leaderPos(sys: AllySystem, out: THREE.Vector3): boolean {
  if (override) { out.copy(override); return true; }
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? ALLY_LOCAL_PEER;
  if (sys.leaderId === localId) {
    if (!ctx.player) return false;
    out.copy(ctx.player.position);
    return true;
  }
  const rp = ctx.net?.getRemotePlayer(sys.leaderId);
  if (!rp) return false;
  out.copy(rp.position);
  return true;
}

export function update(sys: AllySystem, dt: number): void {
  sys.leaderId = leaderOf(sys);
  const had = sys.leaderKnown;
  sys.leaderPrev.copy(sys.leaderPos);
  sys.leaderKnown = leaderPos(sys, sys.leaderPos);
  if (!sys.leaderKnown || dt <= 0) {
    sys.harness = ALLY_HARNESS_RADIUS_M * leadMul(sys);
    return;
  }
  if (!had) {
    sys.leaderPrev.copy(sys.leaderPos);
    sys.leaderDir.set(0, 0, 0);
  }

  _dir.set(sys.leaderPos.x - sys.leaderPrev.x, 0, sys.leaderPos.z - sys.leaderPrev.z);
  const speed = _dir.length() / dt;
  let sample = 0;
  if (speed >= ALLY_HARNESS_COMMIT_SPEED) {
    _dir.normalize();
    // 「in one direction, continuously」 — the dot product of the current heading and the direction
    // accumulated so far (1 at the start).
    const consistency = sys.leaderDir.lengthSq() > 1e-6 ? Math.max(0, sys.leaderDir.dot(_dir)) : 1;
    sample = consistency;
    sys.leaderDir.lerp(_dir, Math.min(1, dt / Math.max(1e-3, ALLY_HARNESS_COMMIT_TAU_S))).normalize();
  } else {
    sys.leaderDir.multiplyScalar(0);
  }
  const k = 1 - Math.exp(-dt / Math.max(1e-3, ALLY_HARNESS_COMMIT_TAU_S));
  sys.commit += (sample - sys.commit) * k;
  sys.commit = Math.min(1, Math.max(0, sys.commit));
  sys.harness = ALLY_HARNESS_RADIUS_M * (1 + (ALLY_HARNESS_MIN_FRAC - 1) * sys.commit) * leadMul(sys);
}

/** The radius multiplier while 「앞장서라」 is alive (past `ALLY_LEAD_DURATION_S` it returns to 1 by itself). */
function leadMul(sys: AllySystem): number {
  return sys.ctx && sys.ctx.time < sys.leadUntil ? ALLY_LEAD_HARNESS_MUL : 1;
}
