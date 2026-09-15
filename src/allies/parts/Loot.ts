/**
 * src/allies/parts/Loot.ts — **루팅**. 사용자 결정 「기본적으로 하네스 범위 내에서 탐색하며, 아이템 상자가 있으면 먹으려 함」 ·
 * 「먹고 있을 때 PC 가 그 상자를 열면 중단」 · 「PC 가 버린 아이템 / 상자 핑을 찍으면 그리로 간다」.
 *
 * 내용물은 **여는 것과 같은 굴림**으로 미리 본다 (`InventoryRef.peekContainerItems` — 2026-09-12 드론 스캔이 쓰던 길).
 * 실제로 가져가는 것은 호스트 권위의 `takeContainerItemFor` 뿐이다 — 사람의 가져가기와 같은 기록 · 방송을 탄다.
 */
import type * as THREE from 'three';
import {
  ALLY_LOOT_ITEM_S, ALLY_LOOT_REACH_M, ALLY_RUN_SPEED, ALLY_WALK_SPEED,
} from '@/shared';
import type { ItemInstance, LootContainerInfo } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { PRIO, _v1, dist2D } from '../model';
import * as Nav from './Nav';
import * as Bag from './Bag';

/** 상자 후보를 다시 훑는 주기 (s) — 배치값이다. */
const LOOT_SCAN_S = 1;

export function onEnter(sys: AllySystem, a: Ally): void { a.lootTakeT = 0; void sys; }
export function onExit(sys: AllySystem, a: Ally): void { a.lootTakeT = 0; void sys; }

/** 자율 루팅 · 명령받은 상자 · 바닥 아이템을 한 곳에서 제안한다. */
export function autoProposal(sys: AllySystem, a: Ally): Proposal | null {
  if (a.taskKind === 'crate') {
    const id = a.taskTargetId ?? nearestContainerId(sys, a, a.taskAt);
    if (id) { a.lootContainerId = id; return { state: 'loot', prio: PRIO.orderLoot }; }
  }
  if (a.taskKind === 'item' && !a.taskDefId) {
    const p = sys.ctx.pickups?.findNear(a.taskAt, ALLY_LOOT_REACH_M * 3) ?? null;
    if (p) { a.pickupId = p.id; return { state: 'pickup', prio: PRIO.orderLoot }; }
  }
  if (a.taskKind) return null;                    // 요청을 맡고 있으면 자율 루팅은 쉰다
  // 내용물 미리보기는 싸지 않다 — 이미 고른 상자가 살아 있으면 그대로 두고, 아니면 주기마다만 다시 훑는다.
  if (a.lootContainerId && stillWorth(sys, a, a.lootContainerId)) return { state: 'loot', prio: PRIO.autoLoot };
  if (a.lootScanT > 0) return null;          // 주기는 `parts/Fsm` 이 깎는다
  a.lootScanT = LOOT_SCAN_S;
  const id = pickContainer(sys, a);
  if (!id) { a.lootContainerId = null; return null; }
  a.lootContainerId = id;
  return { state: 'loot', prio: PRIO.autoLoot };
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  if (a.state === 'pickup') { actPickup(sys, a, dt); return; }
  const info = containerOf(sys, a.lootContainerId);
  if (!info || sys.viewedContainers.has(info.id)) { a.lootContainerId = null; Nav.halt(a); return; }
  _v1.copy(info.position);
  const left = Nav.step(sys, a, _v1, ALLY_WALK_SPEED, dt);
  if (left > ALLY_LOOT_REACH_M) return;
  Nav.halt(a);
  a.lootTakeT -= dt;
  if (a.lootTakeT > 0) return;
  a.lootTakeT = ALLY_LOOT_ITEM_S;
  if (!takeOne(sys, a, info)) {
    a.lootContainerId = null;
    if (a.taskKind === 'crate') a.taskKind = null;
  }
}

function actPickup(sys: AllySystem, a: Ally, dt: number): void {
  const pk = sys.ctx.pickups?.getPickups().find((p) => p.id === a.pickupId) ?? null;
  if (!pk) { a.pickupId = null; a.taskKind = null; Nav.halt(a); return; }
  _v1.copy(pk.position);
  const left = Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
  if (left > ALLY_LOOT_REACH_M) return;
  Nav.halt(a);
  const item = sys.ctx.pickups?.takeBy?.(pk.id, a.id) ?? null;
  if (item) Bag.take(sys, a, item);
  a.pickupId = null;
  a.taskKind = null;
}

/* ── 상자 고르기 ─────────────────────────────────────────────────────────── */

function containers(sys: AllySystem): readonly LootContainerInfo[] {
  return sys.ctx.world?.getLootContainers?.() ?? [];
}
function containerOf(sys: AllySystem, id: string | null): LootContainerInfo | null {
  if (!id) return null;
  for (const c of containers(sys)) if (c.id === id) return c;
  return null;
}

/** 하네스 안에서 아직 가져갈 것이 남은 가장 가까운 상자. */
function pickContainer(sys: AllySystem, a: Ally): string | null {
  if (!sys.leaderKnown) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of containers(sys)) {
    if (sys.viewedContainers.has(c.id)) continue;
    if (dist2D(c.position, sys.leaderPos) > sys.harness) continue;
    const fog = sys.ctx.world?.fog;
    if (fog && !fog.isDiscovered(c.position)) continue;
    const d = dist2D(a.position, c.position);
    if (d >= bestD) continue;
    if (!peekBest(sys, c)) continue;
    best = c.id; bestD = d;
  }
  return best;
}

function nearestContainerId(sys: AllySystem, a: Ally, near: THREE.Vector3): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of containers(sys)) {
    const d = dist2D(c.position, near);
    if (d < bestD) { best = c.id; bestD = d; }
  }
  void a;
  return bestD <= ALLY_LOOT_REACH_M * 4 ? best : null;
}

function stillWorth(sys: AllySystem, a: Ally, id: string): boolean {
  const c = containerOf(sys, id);
  if (!c || sys.viewedContainers.has(id)) return false;
  void a;
  return !!peekBest(sys, c);
}

/** 이 상자에서 가장 값어치 있는 한 줄 (없으면 null). 여는 것과 **같은 굴림**이라 미리 보기와 결과가 같다. */
function peekBest(sys: AllySystem, c: LootContainerInfo): ItemInstance | null {
  const items = sys.ctx.inventory?.peekContainerItems?.(c.id, c.tier) ?? null;
  if (!items || items.length === 0) return null;
  let best: ItemInstance | null = null;
  let bestV = 0;
  for (const it of items) {
    const v = Bag.valueOf(sys, it);
    if (v > bestV) { best = it; bestV = v; }
  }
  return best;
}

/** 한 줄 가져간다. 가져갔으면 true. */
function takeOne(sys: AllySystem, a: Ally, c: LootContainerInfo): boolean {
  const want = peekBest(sys, c);
  if (!want) return false;
  const got = sys.ctx.inventory?.takeContainerItemFor?.(c.id, c.tier, want.defId, a.id) ?? null;
  if (!got) return false;
  const slot = Bag.upgradeSlotOf(sys, a, got);
  Bag.take(sys, a, got);
  if (slot) Bag.tryUpgrade(sys, a);
  // 분대장보다 좋은 장비면 알린다 (사용자 결정 — 아이템 핑 → 건네주기).
  if (Bag.beatsLeader(sys, got)) sys.offerToLeader(a, got);
  return true;
}
