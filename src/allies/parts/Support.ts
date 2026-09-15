/**
 * src/allies/parts/Support.ts — **건네주기**. 사용자 결정의 조건을 그대로 옮긴다:
 * 「회복 아이템이 있으면 핑을 찍고, PC 근처에 와서, PC 가 멈추거나 자신을 바라보고 있을 때 떨군 뒤 다시 핑」.
 *
 * 건네는 것은 **레이드에서 주운 것**뿐이다 — 기본 킷은 묶인 물건이라 손을 못 댄다 (`parts/Bag`).
 * `ALLY_DELIVER_WAIT_MAX_S` 를 넘게 기다리면 그냥 발밑에 떨구고 핑을 찍는다 (영영 들고 서 있지 않게).
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

/** 건넬 물건을 찾는다 (요청 종류별). 없으면 null. */
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
  if (a.taskKind === 'item' && !a.taskDefId) return null;    // 바닥 아이템 줍기는 `parts/Loot`
  return pick(sys, a) ? { state: 'deliver', prio: PRIO.deliver } : null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  const item = pick(sys, a);
  if (!item || !a.taskBy) { Commands.finishTask(sys, a); Nav.halt(a); return; }
  a.deliverUid = item.uid;

  // ① 먼저 무엇을 줄지 핑을 찍는다.
  if (!a.deliverPinged) {
    a.deliverPinged = true;
    Ping.place(sys, a, 'item', a.position, Bag.defOf(sys, item.defId)?.name);
  }

  const who = Commands.requesterOf(sys, a.taskBy);
  if (!who) { Commands.finishTask(sys, a); Nav.halt(a); return; }

  // ② 요청자 곁으로.
  _v1.copy(who.position);
  const left = Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
  if (left > ALLY_DELIVER_RANGE_M) { a.running = true; return; }
  a.running = false;
  Nav.halt(a);
  Nav.face(a, who.position, dt);

  // ③ 멈췄거나 나를 보고 있을 때 떨군다.
  a.deliverWaitT += dt;
  const still = who.speed < ALLY_DELIVER_STILL_SPEED;
  forwardOf(who.yaw, _v2);
  const dx = a.position.x - who.position.x, dz = a.position.z - who.position.z;
  const d = Math.hypot(dx, dz);
  const looking = d > 1e-3 && (_v2.x * (dx / d) + _v2.z * (dz / d)) >= ALLY_DELIVER_LOOK_DOT;
  if (!still && !looking && a.deliverWaitT < ALLY_DELIVER_WAIT_MAX_S) return;

  const taken = a.bag?.remove(item.uid) ?? null;
  if (taken) {
    // 요청자 앞에 둔다 (조건이 안 맞아 시간이 다 됐으면 발밑).
    _v1.copy(who.position);
    if (still || looking) _v1.addScaledVector(_v2, 1);
    sys.ctx.pickups?.spawn(taken, _v1);
    a.bagDirty = true;
    Ping.place(sys, a, 'item', _v1, Bag.defOf(sys, taken.defId)?.name);
  }
  Commands.finishTask(sys, a);
}

/** 분대장이 낀 것보다 좋은 장비를 주웠다 — 핑을 찍고 건네주는 일감으로 잡는다 (사용자 결정). */
export function offerToLeader(sys: AllySystem, a: Ally, item: ItemInstance): void {
  if (a.taskKind) return;                       // 이미 다른 요청을 맡고 있으면 나중에
  if (!sys.leaderKnown) return;
  a.taskKind = 'item';
  a.taskBy = sys.leaderId;
  a.taskAt.copy(sys.leaderPos);
  a.taskDefId = item.defId;
  a.deliverUid = item.uid;
  a.deliverPinged = false;
  a.deliverWaitT = 0;
}
