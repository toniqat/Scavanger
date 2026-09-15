/**
 * src/allies/parts/Commands.ts — **명령**. 새 입력은 하나도 없다 (사용자 결정): 핑(`ping:placedV3`) ·
 * 의사소통 휠(`comms:sent`) · 인벤토리 요청(`inventory:itemRequested`, 원격은 `allyq item`)을 듣는다.
 *
 * 두 갈래다.
 *  - **명령** (이동 `attack` · 주의 `caution` · 앞장 `lead`): **분대장 것만** 따른다. 분대 전체가 같이 움직인다.
 *  - **요청** (회복 · 실드 · 탄약 · 아이템 · 상자 · 탈출 · 계약): 누구나 보낼 수 있고 **먼저 온 하나**만 받는다.
 *    그 뒤 `ALLY_REQUEST_COOLDOWN_S` 동안은 다른 요청을 무시한다 (분대 공용). 할 수 있는 가장 가까운 기가 맡고,
 *    아무도 못 하면 가장 가까운 기가 한 줄 말한다.
 */
import * as THREE from 'three';
import {
  ALLY_LEAD_AHEAD_M, ALLY_MOVE_ARRIVE_M, ALLY_MOVE_HOLD_S, ALLY_REQUEST_COOLDOWN_S, ALLY_RUN_SPEED,
  ALLY_WALK_SPEED, ALLY_WATCH_S, isAndroidId,
} from '@/shared';
import type { CommsId, ItemRequestKind, PeerId, PingKind } from '@/shared';
import { shieldChargeOf, boostItemOf, AMMO_LABEL_KO } from '@/items';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v1, dist2D, forwardOf } from '../model';
import type { AllyRequestKind } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Bag from './Bag';
import * as Harness from './Harness';

/** 주의 핑 자리에 이보다 가까이 가지 않는다 (m) — 「해당 위치로 가려고 하지 않음」. */
const WATCH_KEEP_OUT_M = 6;

/* ═══════════════════════════ 입력 ═══════════════════════════ */

export function onPing(
  sys: AllySystem,
  e: { position: THREE.Vector3; kind: PingKind; owner: PeerId | null; label?: string; enemyId?: number },
): void {
  if (isAndroidId(e.owner)) return;                 // 자기(또는 동료)가 찍은 핑은 명령이 아니다
  const by = e.owner ?? (sys.ctx.net?.localId ?? 'local');
  const fromLeader = by === sys.leaderId;
  switch (e.kind) {
    case 'attack':
      if (fromLeader) { sys.orderKind = 'moveTo'; sys.orderPos.copy(e.position); sys.orderUntil = Infinity; }
      break;
    case 'caution':
      if (fromLeader) { sys.watchPos.copy(e.position); sys.watchUntil = sys.ctx.time + ALLY_WATCH_S; }
      break;
    case 'enemy':
      if (fromLeader && typeof e.enemyId === 'number') sys.preferredEnemyId = e.enemyId;
      break;
    case 'crate':
      request(sys, 'crate', by, e.position, { targetId: e.label ?? null });
      break;
    case 'item':
      request(sys, 'item', by, e.position, {});
      break;
    default:
      break;
  }
}

export function onComms(sys: AllySystem, e: { id: CommsId; by: string | null; position: THREE.Vector3 | null; text: string }): void {
  const by = e.by ?? (sys.ctx.net?.localId ?? 'local');
  if (isAndroidId(by)) return;
  const at = e.position ?? sys.leaderPos;
  switch (e.id) {
    case 'need_heal':
      request(sys, 'heal', by, at, {});
      break;
    case 'extract':
      onExtractComms(sys, by, at);
      break;
    case 'contract':
      request(sys, 'contract', by, at, { text: e.text });
      break;
    case 'lead':
      if (by === sys.leaderId) {
        forwardOf(leaderYaw(sys), _v1);
        sys.orderKind = 'lead';
        sys.orderPos.copy(sys.leaderPos).addScaledVector(_v1, ALLY_LEAD_AHEAD_M);
        sys.orderUntil = Infinity;
      }
      break;
    default:
      break;
  }
}

/** 로컬 플레이어의 인벤토리 요청 (가운데 클릭 · 메뉴). */
export function onItemRequest(
  sys: AllySystem,
  e: { kind: ItemRequestKind; defId: string | null; ammoType: string | null; position: THREE.Vector3 },
): void {
  const by = sys.ctx.net?.localId ?? 'local';
  request(sys, e.kind, by, e.position, { defId: e.defId, ammoType: e.ammoType });
}

/** 원격 분대원의 인벤토리 요청 (`allyq item`, 호스트에서만 도착한다). */
export function onRemoteItemRequest(
  sys: AllySystem, from: PeerId,
  e: { kind: ItemRequestKind; defId?: string; ammoType?: string; p: [number, number, number] },
): void {
  _v1.set(e.p[0], e.p[1], e.p[2]);
  request(sys, e.kind, from, _v1, { defId: e.defId ?? null, ammoType: e.ammoType ?? null });
}

export function onContainerViewed(sys: AllySystem, containerId: string): void {
  sys.viewedContainers.add(containerId);
  for (const a of sys.bodies) if (a.lootContainerId === containerId) a.lootContainerId = null;
}

/** 「탈출하고 싶다」 — 두 번째가 `ALLY_EXTRACT_CONFIRM_S` 안에 오면 호출 버튼을 누른다 (`parts/Extract`). */
function onExtractComms(sys: AllySystem, by: PeerId, at: THREE.Vector3): void {
  for (const a of sys.bodies) {
    if (a.extractRequester === by && a.extractPadId && sys.ctx.time - a.extractPingAt <= sys.extractConfirmWindow) {
      a.taskKind = 'extract';
      a.taskBy = by;
      a.confirmExtract = true;
      return;
    }
  }
  request(sys, 'extract', by, at, {});
}

/* ═══════════════════════════ 요청 ═══════════════════════════ */

function request(
  sys: AllySystem, kind: AllyRequestKind, by: PeerId, at: THREE.Vector3,
  opts: { defId?: string | null; ammoType?: string | null; targetId?: string | null; text?: string },
): void {
  if (!sys.raidActive || !sys.simulating) return;
  if (sys.ctx.time < sys.requestBlockedUntil) return;     // 선착순 — 그동안 온 요청은 버린다
  sys.request = {
    kind, by, at: at.clone(), defId: opts.defId ?? null, ammoType: opts.ammoType ?? null,
    targetId: opts.targetId ?? null, time: sys.ctx.time, claimedBy: null,
  };
  sys.requestText = opts.text ?? '';
  sys.requestBlockedUntil = sys.ctx.time + ALLY_REQUEST_COOLDOWN_S;
}

/** 아직 아무도 맡지 않은 요청을 **할 수 있는 가장 가까운 기**에게 붙인다. 아무도 못 하면 한 줄 말하고 버린다. */
export function tickRequest(sys: AllySystem): void {
  const req = sys.request;
  if (!req || req.claimedBy) return;
  let best: Ally | null = null;
  let bestD = Infinity;
  let nearest: Ally | null = null;
  let nearestD = Infinity;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
    const d = dist2D(a.position, req.at);
    if (d < nearestD) { nearest = a; nearestD = d; }
    if (!canFulfil(sys, a, req.kind, req.defId, req.ammoType)) continue;
    if (d < bestD) { best = a; bestD = d; }
  }
  if (best) {
    req.claimedBy = best.id;
    best.taskKind = req.kind;
    best.taskBy = req.by;
    best.taskAt.copy(req.at);
    best.taskDefId = req.defId;
    best.taskAmmoType = req.ammoType;
    best.taskTargetId = req.targetId;
    best.deliverUid = null;
    best.deliverPinged = false;
    best.deliverWaitT = 0;
    return;
  }
  if (nearest) Ping.say(sys, nearest, missingLine(req.kind, req.ammoType));
  sys.request = null;
}

/** 지금 몸에 그 요청을 채울 것이 있는가. 탐색형(상자 · 탈출 · 계약)은 늘 맡는다. */
function canFulfil(sys: AllySystem, a: Ally, kind: AllyRequestKind, defId: string | null, ammoType: string | null): boolean {
  switch (kind) {
    case 'heal':
      // 「회복 아이템」 = 순수 회복약이다 — 실드 충전기 · 부스트는 아니다.
      return !!Bag.findInBag(sys, a, (d) => d.category === 'stim' && !shieldChargeOf(d.id) && !boostItemOf(d.id));
    case 'shield':
      return !!Bag.findInBag(sys, a, (d) => !!shieldChargeOf(d.id));
    case 'ammo':
      return !!Bag.findInBag(sys, a, (d) => d.category === 'ammo' && (!ammoType || d.ammoType === ammoType));
    case 'item':
      return !!defId && !!Bag.findInBag(sys, a, (d) => d.id === defId);
    default:
      return true;
  }
}

function missingLine(kind: AllyRequestKind, ammoType: string | null): string {
  switch (kind) {
    case 'heal': return CHAT_KO.noHeal;
    case 'shield': return CHAT_KO.noShield;
    case 'ammo': return CHAT_KO.noAmmo(ammoType ? ((AMMO_LABEL_KO as Record<string, string>)[ammoType] ?? ammoType) : '');
    case 'extract': return CHAT_KO.noExtract;
    case 'contract': return CHAT_KO.noContract;
    default: return CHAT_KO.noItem;
  }
}

/** 요청을 끝낸다 (건네줬다 · 못 했다). */
export function finishTask(sys: AllySystem, a: Ally): void {
  if (sys.request?.claimedBy === a.id) sys.request = null;
  a.taskKind = null;
  a.taskBy = null;
  a.taskDefId = null;
  a.taskAmmoType = null;
  a.taskTargetId = null;
  a.deliverUid = null;
  a.deliverPinged = false;
  a.deliverWaitT = 0;
}

/* ═══════════════════════════ 명령 상태 ═══════════════════════════ */

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  const now = sys.ctx.time;
  if (now < sys.watchUntil) return { state: 'watch', prio: PRIO.order };
  if (sys.orderKind && now < sys.orderUntil) {
    if (a.state === 'moveTo' && a.moveHoldT <= 0) return null;   // 머무름이 끝났다 → 하네스로
    return { state: sys.orderKind, prio: PRIO.order };
  }
  return null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  if (a.state === 'watch') {
    // 그 자리를 바라보되 가지 않는다 (사용자 결정).
    a.lookVec.copy(sys.watchPos);
    a.lookAt = a.lookVec;
    Nav.face(a, sys.watchPos, dt);
    // 분대장 곁은 지킨다 — 주의 중에도 하네스는 살아 있다.
    if (sys.leaderKnown && dist2D(a.position, sys.leaderPos) > sys.harness) {
      a.running = true;
      Nav.step(sys, a, sys.leaderPos, ALLY_RUN_SPEED, dt, sys.watchPos, WATCH_KEEP_OUT_M);
    } else Nav.halt(a);
    return;
  }
  const dest = sys.orderPos;
  const left = Nav.step(sys, a, dest, a.state === 'lead' ? ALLY_RUN_SPEED : ALLY_WALK_SPEED, dt,
    sys.ctx.time < sys.watchUntil ? sys.watchPos : null, WATCH_KEEP_OUT_M);
  if (left <= ALLY_MOVE_ARRIVE_M) {
    Nav.halt(a);
    if (a.state === 'moveTo') {
      if (a.moveHoldT <= 0) a.moveHoldT = ALLY_MOVE_HOLD_S;
      a.moveHoldT -= dt;
      if (a.moveHoldT <= 0) { sys.orderKind = null; sys.orderUntil = -Infinity; }
    } else { sys.orderKind = null; sys.orderUntil = -Infinity; }
  }
}

function leaderYaw(sys: AllySystem): number {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (sys.leaderId === localId) return ctx.player?.yaw ?? 0;
  return ctx.net?.getRemotePlayer(sys.leaderId)?.yaw ?? 0;
}

/** 요청자의 위치 · 속도 · 시선 (건네기 조건 판정, `parts/Support`). 모르면 null. */
export function requesterOf(sys: AllySystem, peer: PeerId): { position: THREE.Vector3; speed: number; yaw: number } | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (peer === localId) {
    const p = ctx.player;
    return p ? { position: p.position, speed: Math.hypot(p.velocity.x, p.velocity.z), yaw: p.yaw } : null;
  }
  const rp = ctx.net?.getRemotePlayer(peer);
  return rp ? { position: rp.position, speed: Math.hypot(rp.velocity.x, rp.velocity.z), yaw: rp.yaw } : null;
}

/** 요청자의 장착 주무기 탄종 (탄약 요청의 기본값). */
export function requesterAmmoType(sys: AllySystem, peer: PeerId): string | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (peer === localId) {
    const prim = ctx.inventory?.getLoadout().primary ?? null;
    return prim ? ctx.loot?.getEffectiveStats(prim)?.ammoType ?? null : null;
  }
  const card = ctx.net?.getCrewCard(peer);
  return card?.primary ? ctx.loot?.getEffectiveStats(card.primary)?.ammoType ?? null : null;
}

/** 분대장을 다시 읽는다 (`parts/Harness` 위임 — 콘솔 치트가 쓴다). */
export const leaderIdOf = Harness.leaderOf;
