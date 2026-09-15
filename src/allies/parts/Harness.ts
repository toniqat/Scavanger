/**
 * src/allies/parts/Harness.ts — **분대장과 하네스**.
 *
 * 하네스 = 안드로이드가 따라다니고 탐색하는 반경. 중심은 **분대장**(`lobby.hostId`, 로비가 없으면 로컬 플레이어 —
 * 사용자 결정). 사용자 결정 「PC 가 한쪽 방향으로 계속 움직이면 하네스가 절반으로 줄어든다」를 방향 일관성의
 * 지수평균(`commit`)으로 구현한다: 빠르게 + 같은 방향으로 갈수록 1 에 가까워지고, 반경은
 * `ALLY_HARNESS_RADIUS_M × lerp(1, ALLY_HARNESS_MIN_FRAC, commit)` 이 된다.
 */
import * as THREE from 'three';
import {
  ALLY_HARNESS_COMMIT_SPEED, ALLY_HARNESS_COMMIT_TAU_S, ALLY_HARNESS_MIN_FRAC, ALLY_HARNESS_RADIUS_M,
  ALLY_LOCAL_PEER, isAndroidId,
} from '@/shared';
import type { PeerId } from '@/shared';
import type { AllySystem } from '../AllySystem';

const _dir = new THREE.Vector3();
let override: THREE.Vector3 | null = null;

/** 스모크용 — 분대장 위치를 덮어쓴다 (null 이면 해제). */
export function debugOverride(sys: AllySystem, pos: THREE.Vector3 | null): void {
  override = pos ? pos.clone() : null;
  void sys;
}

/** 지금 분대장의 PeerId — 로비 호스트, 로비가 없으면 로컬 플레이어. 봇은 절대 호스트가 되지 않는다 (릴레이 규약). */
export function leaderOf(sys: AllySystem): PeerId {
  const host = sys.ctx.net?.lobby?.hostId;
  if (host && !isAndroidId(host)) return host;
  return sys.ctx.net?.localId ?? ALLY_LOCAL_PEER;
}

/** 분대장의 발 위치를 `out` 에 쓴다. 모르면 false (그 프레임은 따라가지 않는다). */
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
    sys.harness = ALLY_HARNESS_RADIUS_M;
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
    // 「같은 방향으로 계속」 — 지금 방향과 그동안 누적한 방향의 내적 (처음에는 1 로 본다).
    const consistency = sys.leaderDir.lengthSq() > 1e-6 ? Math.max(0, sys.leaderDir.dot(_dir)) : 1;
    sample = consistency;
    sys.leaderDir.lerp(_dir, Math.min(1, dt / Math.max(1e-3, ALLY_HARNESS_COMMIT_TAU_S))).normalize();
  } else {
    sys.leaderDir.multiplyScalar(0);
  }
  const k = 1 - Math.exp(-dt / Math.max(1e-3, ALLY_HARNESS_COMMIT_TAU_S));
  sys.commit += (sample - sys.commit) * k;
  sys.commit = Math.min(1, Math.max(0, sys.commit));
  sys.harness = ALLY_HARNESS_RADIUS_M * (1 + (ALLY_HARNESS_MIN_FRAC - 1) * sys.commit);
}
