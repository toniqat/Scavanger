/**
 * src/allies/parts/Rescue.ts — **구조**. 사용자 결정 그대로:
 * 「PC 가 쓰러지면 주변을 안전하게 만든 뒤(적 먼저 처치) 일으킨다. 제세동기가 있으면 안전하지 않아도 쓴다.
 *  환경 기믹(폭풍 · 눈보라) 안이면 들쳐업고 안전 범위까지 뛴다.」
 *
 * 일으키는 길은 둘이다 — **호스트 자신의 몸**은 `ctx.player.revive()` 로 바로, 다른 사람은 `ally revive` 로
 * (받는 쪽 player/ 가 처리한다). 둘을 섞으면 같은 사람을 두 번 일으키거나 아무도 못 일으킨다.
 */
import type * as THREE from 'three';
import {
  ALLY_CARRY_SPEED, ALLY_HAZARD_SAFE_MARGIN_M, ALLY_RESCUE_SAFE_RADIUS_M, ALLY_RUN_SPEED,
  PLAYER_REVIVE_HOLD, PLAYER_REVIVE_RANGE,
} from '@/shared';
import type { PeerId } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { PRIO, _v1, _v2 } from '../model';
import * as Nav from './Nav';
import * as Combat from './Combat';
import * as Bag from './Bag';

/** 제세동기 아이템 def id — 아이템 이름이라 csv 수치가 아니다 (계약 `ANDROID_KIT` 와 같은 자리). */
const DEFIB_DEF_ID = 'gad_defib';

/** 쓰러진 사람의 위치를 `out` 에 쓴다. 없으면 null. */
function downedTarget(sys: AllySystem, out: THREE.Vector3): PeerId | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  const p = ctx.player;
  if (p && p.isDowned && !p.isDead) { out.copy(p.position); return localId; }
  for (const rp of ctx.net?.getRemotePlayers() ?? []) {
    if (!rp.isDowned || rp.isDead || !rp.inMission) continue;
    out.copy(rp.position);
    return rp.id;
  }
  return null;
}

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  const who = downedTarget(sys, _v1);
  if (!who) { a.rescueTarget = null; if (a.carrying) a.carrying = null; return null; }
  a.rescueTarget = who;
  const hz = sys.ctx.world?.hazard ?? null;
  const inHazard = !!hz?.active && hz.isInside(_v1.x, _v1.z);
  return { state: inHazard ? 'carry' : 'rescue', prio: inHazard ? PRIO.carry : PRIO.rescue };
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  const who = a.rescueTarget;
  if (!who) { Nav.halt(a); return; }
  const at = _v1;
  if (downedTarget(sys, at) !== who) {
    // 이미 누가 일으켰다 (또는 죽었다).
    a.carrying = null;
    a.rescueTarget = null;
    a.reviveHoldT = 0;
    Nav.halt(a);
    return;
  }

  if (a.state === 'carry') { carry(sys, a, at, dt); return; }

  const defib = Bag.findInBag(sys, a, (d) => d.id === DEFIB_DEF_ID);
  // 제세동기가 없으면 먼저 주변을 안전하게 만든다 — 그동안은 전투 행동을 그대로 쓴다.
  if (!defib && Combat.enemiesNear(sys, at, ALLY_RESCUE_SAFE_RADIUS_M)) {
    const target = Combat.senseEnemy(sys, a);
    if (target) { a.targetEnemyId = target.id; Combat.act(sys, a, dt); return; }
  }

  a.running = true;
  const left = Nav.step(sys, a, at, ALLY_RUN_SPEED, dt);
  if (left > PLAYER_REVIVE_RANGE) return;
  a.running = false;
  Nav.halt(a);
  Nav.face(a, at, dt);
  a.reviveHoldT += dt;
  if (a.reviveHoldT < PLAYER_REVIVE_HOLD) return;
  a.reviveHoldT = 0;
  if (defib) { a.bag?.remove(defib.uid); a.bagDirty = true; }
  sys.revivePlayer(a, who, !!defib);
  a.rescueTarget = null;
}

/** 재해 안이면 업고 뛴다 — 가장 가까운 안전 지점까지. */
function carry(sys: AllySystem, a: Ally, at: THREE.Vector3, dt: number): void {
  if (a.carrying !== a.rescueTarget) {
    // 먼저 몸까지 간다.
    a.running = true;
    const left = Nav.step(sys, a, at, ALLY_RUN_SPEED, dt);
    if (left > PLAYER_REVIVE_RANGE) return;
    a.carrying = a.rescueTarget;
    a.hasCarryDest = false;
  }
  if (!a.hasCarryDest) {
    const hz = sys.ctx.world?.hazard ?? null;
    const safe = hz?.nearestSafePoint?.(a.position.x, a.position.z, ALLY_HAZARD_SAFE_MARGIN_M, _v2) ?? null;
    if (!safe) { a.carrying = null; return; }     // 맵이 다 덮였다 — 업어도 갈 곳이 없다
    a.carryDest.copy(safe);
    a.hasCarryDest = true;
  }
  a.running = true;
  const left = Nav.step(sys, a, a.carryDest, ALLY_CARRY_SPEED, dt);
  if (left > 1) return;
  // 내려놓고 일으킨다.
  a.carrying = null;
  a.hasCarryDest = false;
  a.running = false;
  Nav.halt(a);
  if (a.rescueTarget) sys.revivePlayer(a, a.rescueTarget, false);
  a.rescueTarget = null;
}
