/**
 * src/allies/parts/Rescue.ts — **rescue**. Exactly the user's decision:
 * 「PC 가 쓰러지면 주변을 안전하게 만든 뒤(적 먼저 처치) 일으킨다. 제세동기가 있으면 안전하지 않아도 쓴다.
 *  환경 기믹(폭풍 · 눈보라) 안이면 들쳐업고 안전 범위까지 뛴다.」
 *
 * There are two paths to getting one up — **the host's own body** straight through `ctx.player.revive()`, anybody
 * else through `ally revive` (the receiving player/ handles it). Mixing the two gets the same person up twice, or
 * nobody up.
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

/** The defibrillator item def id — a name, not a csv number (the same place as the contract's `ANDROID_KIT`). */
const DEFIB_DEF_ID = 'gad_defib';

/** Writes the position of a downed person into `out`. Null with none. */
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
    // Somebody already got them up (or they died).
    a.carrying = null;
    a.rescueTarget = null;
    a.reviveHoldT = 0;
    Nav.halt(a);
    return;
  }

  if (a.state === 'carry') { carry(sys, a, at, dt); return; }

  const defib = Bag.findInBag(sys, a, (d) => d.id === DEFIB_DEF_ID);
  // With no defibrillator it makes the area safe first — until then it runs its combat behaviour as it stands.
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

/** Inside a hazard it carries them and runs — to the nearest safe point. */
function carry(sys: AllySystem, a: Ally, at: THREE.Vector3, dt: number): void {
  if (a.carrying !== a.rescueTarget) {
    // First, get to the body.
    a.running = true;
    const left = Nav.step(sys, a, at, ALLY_RUN_SPEED, dt);
    if (left > PLAYER_REVIVE_RANGE) return;
    a.carrying = a.rescueTarget;
    a.hasCarryDest = false;
  }
  if (!a.hasCarryDest) {
    const hz = sys.ctx.world?.hazard ?? null;
    const safe = hz?.nearestSafePoint?.(a.position.x, a.position.z, ALLY_HAZARD_SAFE_MARGIN_M, _v2) ?? null;
    if (!safe) { a.carrying = null; return; }     // the map is fully covered — carrying leads nowhere
    a.carryDest.copy(safe);
    a.hasCarryDest = true;
  }
  a.running = true;
  const left = Nav.step(sys, a, a.carryDest, ALLY_CARRY_SPEED, dt);
  if (left > 1) return;
  // Put them down and get them up. The decision 「제세동기가 있으면 안전하지 않아도 쓴다」 holds on this road
  // out too — carrying is the **most** unsafe of the two, so the one that heals is the one to use here, and it is
  // consumed exactly as on the standing revive in `act` above.
  a.carrying = null;
  a.hasCarryDest = false;
  a.running = false;
  Nav.halt(a);
  if (a.rescueTarget) {
    const defib = Bag.findInBag(sys, a, (d) => d.id === DEFIB_DEF_ID);
    if (defib) { a.bag?.remove(defib.uid); a.bagDirty = true; }
    sys.revivePlayer(a, a.rescueTarget, !!defib);
  }
  a.rescueTarget = null;
}
