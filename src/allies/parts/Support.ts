/**
 * src/allies/parts/Support.ts — **handing over**. It carries the user's decision across exactly as stated:
 * 「회복 아이템이 있으면 핑을 찍고, PC 근처에 와서, PC 가 멈추거나 자신을 바라보고 있을 때 떨군 뒤 다시 핑」.
 *
 * Only what was **found in the raid** is handed over — the base kit is a bound thing and cannot be touched
 * (`parts/Bag`). Waiting longer than `ALLY_DELIVER_WAIT_MAX_S` it simply drops the item at its own feet and pings
 * (so it never stands there holding it forever).
 */
import {
  ALLY_DELIVER_LOOK_DOT, ALLY_DELIVER_RANGE_M, ALLY_DELIVER_STILL_SPEED, ALLY_DELIVER_WAIT_MAX_S,
  ALLY_RUN_SPEED,
} from '@/shared';
import type { ItemInstance } from '@/shared';
import { shieldChargeOf, boostItemOf } from '@/items';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { PRIO, _v1, _v2, forwardOf } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Bag from './Bag';
import * as Commands from './Commands';

/** Finds the thing to hand over (by request kind). Null with none. */
function pick(sys: AllySystem, a: Ally): ItemInstance | null {
  if (a.deliverUid) {
    const held = a.bag?.items().find((i) => i.uid === a.deliverUid) ?? null;
    if (held) return held;
    a.deliverUid = null;
  }
  switch (a.taskKind) {
    case 'heal':
      return Bag.findInBag(sys, a, (d) => d.category === 'stim' && !shieldChargeOf(d.id) && !boostItemOf(d.id));
    case 'shield':
      return Bag.findInBag(sys, a, (d) => !!shieldChargeOf(d.id));
    case 'ammo': {
      const want = a.taskAmmoType ?? (a.taskBy ? Commands.requesterAmmoType(sys, a.taskBy) : null);
      return Bag.findInBag(sys, a, (d) => d.category === 'ammo' && (!want || d.ammoType === want));
    }
    case 'item':
      return a.taskDefId ? Bag.findInBag(sys, a, (d) => d.id === a.taskDefId) : null;
    default:
      return null;
  }
}

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  if (a.taskKind !== 'heal' && a.taskKind !== 'shield' && a.taskKind !== 'ammo' && a.taskKind !== 'item') return null;
  if (a.taskKind === 'item' && !a.taskDefId) return null;    // picking an item up off the ground is `parts/Loot`
  return pick(sys, a) ? { state: 'deliver', prio: PRIO.deliver } : null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  const item = pick(sys, a);
  if (!item || !a.taskBy) { Commands.finishTask(sys, a); Nav.halt(a); return; }
  a.deliverUid = item.uid;

  // ① First it pings what it is going to give.
  if (!a.deliverPinged) {
    a.deliverPinged = true;
    Ping.place(sys, a, 'item', a.position, Bag.defOf(sys, item.defId)?.name);
  }

  const who = Commands.requesterOf(sys, a.taskBy);
  if (!who) { Commands.finishTask(sys, a); Nav.halt(a); return; }

  // ② Over beside the requester.
  _v1.copy(who.position);
  const left = Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
  if (left > ALLY_DELIVER_RANGE_M) { a.running = true; return; }
  a.running = false;
  Nav.halt(a);
  Nav.face(a, who.position, dt);

  // ③ Drops it once the requester stopped or is looking at it.
  a.deliverWaitT += dt;
  const still = who.speed < ALLY_DELIVER_STILL_SPEED;
  forwardOf(who.yaw, _v2);
  const dx = a.position.x - who.position.x, dz = a.position.z - who.position.z;
  const d = Math.hypot(dx, dz);
  const looking = d > 1e-3 && (_v2.x * (dx / d) + _v2.z * (dz / d)) >= ALLY_DELIVER_LOOK_DOT;
  if (!still && !looking && a.deliverWaitT < ALLY_DELIVER_WAIT_MAX_S) return;

  const taken = a.bag?.remove(item.uid) ?? null;
  if (taken) {
    // Puts it in front of the requester (at its own feet when the condition never held and the time ran out).
    _v1.copy(who.position);
    if (still || looking) _v1.addScaledVector(_v2, 1);
    sys.ctx.pickups?.spawn(taken, _v1);
    a.bagDirty = true;
    Ping.place(sys, a, 'item', _v1, Bag.defOf(sys, taken.defId)?.name);
  }
  Commands.finishTask(sys, a);
}

/**
 * Picked up better gear than what the squad leader has equipped — pings it and takes it on as a hand-over task
 * (user's decision).
 */
export function offerToLeader(sys: AllySystem, a: Ally, item: ItemInstance): void {
  if (a.taskKind) return;                       // already holding another request → later
  if (!sys.leaderKnown) return;
  a.taskKind = 'item';
  a.taskBy = sys.leaderId;
  a.taskAt.copy(sys.leaderPos);
  a.taskDefId = item.defId;
  a.deliverUid = item.uid;
  a.deliverPinged = false;
  a.deliverWaitT = 0;
}
