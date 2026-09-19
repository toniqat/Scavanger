/**
 * src/allies/parts/Loot.ts — **looting**. User's decisions 「PC 가 버린 아이템 / 상자 핑을 찍으면 그리로 간다」 ·
 * 「먹고 있을 때 PC 가 그 상자를 열면 중단」.
 *
 * 2026-09-16 user's decision 「**핑이 먼저고, 혼자 주워 담는 것은 한가할 때뿐**」:
 *  - A **pinged** crate · ground item (`taskKind` `'crate'` / `'item'`) keeps the priority `PRIO.orderLoot` and has
 *    **no distance limit** — it goes even outside the harness. Taking it on it says one line (`CHAT_KO.agreeCrate`).
 *  - **Autonomous looting** happens only with no order · request · combat · rescue at all (`isIdle`), and even then
 *    it looks only at containers inside `ALLY_IDLE_LOOT_M` (a corpse container passes the same gate —
 *    `getLootContainers()` is the only list of autonomous candidates).
 *
 * The contents are previewed with **the same roll as opening** (`InventoryRef.peekContainerItems` — the path the
 * 2026-09-12 drone scan used). Only the host authority's `takeContainerItemFor` actually takes anything — it rides
 * the same record · broadcast as a person's take.
 */
import type * as THREE from 'three';
import {
  ALLY_IDLE_LOOT_M, ALLY_LOOT_ITEM_S, ALLY_LOOT_REACH_M, ALLY_RUN_SPEED, ALLY_WALK_SPEED,
} from '@/shared';
import type { ItemInstance, LootContainerInfo } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v1, dist2D } from '../model';
import * as Nav from './Nav';
import * as Bag from './Bag';
import * as Ping from './Ping';

/** How often the crate candidates are scanned again (s) — a layout constant. */
const LOOT_SCAN_S = 1;
/**
 * The match window (m) between a ping spot and a container — not a limit on how far an android may go, but
 * 「is this ping this crate」.
 */
const PING_CRATE_MATCH_M = ALLY_LOOT_REACH_M * 4;

export function onEnter(sys: AllySystem, a: Ally): void { a.lootTakeT = 0; void sys; }
export function onExit(sys: AllySystem, a: Ally): void { a.lootTakeT = 0; void sys; }

/** Proposes autonomous looting · an ordered crate · a ground item, all in one place. */
export function autoProposal(sys: AllySystem, a: Ally): Proposal | null {
  // ── pinged — no distance limit ──
  if (a.taskKind === 'crate') {
    const id = a.taskTargetId ?? nearestContainerId(sys, a, a.taskAt);
    if (id) {
      if (a.lootContainerId !== id) Ping.say(sys, a, CHAT_KO.agreeCrate);   // `Ping.say` blocks the repeat
      a.lootContainerId = id;
      return { state: 'loot', prio: PRIO.orderLoot };
    }
  }
  if (a.taskKind === 'item' && !a.taskDefId) {
    const p = sys.ctx.pickups?.findNear(a.taskAt, ALLY_LOOT_REACH_M * 3) ?? null;
    if (p) { a.pickupId = p.id; return { state: 'pickup', prio: PRIO.orderLoot }; }
  }
  // ── autonomous looting — only while idle, only inside `ALLY_IDLE_LOOT_M` ──
  if (!isIdle(sys, a)) { a.lootContainerId = null; return null; }
  // The contents preview is not cheap — a crate already picked is left alone while it lives, and otherwise the
  // candidates are scanned again only once per period.
  if (a.lootContainerId && stillWorth(sys, a, a.lootContainerId)) return { state: 'loot', prio: PRIO.autoLoot };
  if (a.lootScanT > 0) return null;          // `parts/Fsm` ticks the period down
  a.lootScanT = LOOT_SCAN_S;
  const id = pickContainer(sys, a);
  if (!id) { a.lootContainerId = null; return null; }
  a.lootContainerId = id;
  return { state: 'loot', prio: PRIO.autoLoot };
}

/**
 * 「is it idle」 — it picks things up on its own only with no order (`가자` · `주의` · `앞장`) · request · combat
 * (an enemy ping included) · rescue at all (2026-09-16 user's decision 「상자 · 컨테이너 · 시체로 달려가지 않는다」).
 */
function isIdle(sys: AllySystem, a: Ally): boolean {
  if (a.taskKind) return false;                                       // it is holding a request
  if (a.targetEnemyId !== null || sys.preferredEnemyId !== null) return false;   // engaged · an enemy ping
  if (a.rescueTarget || a.carrying) return false;                     // rescue · carrying
  const now = sys.ctx.time;
  if (now < sys.watchUntil) return false;                             // a `주의` ping
  if (sys.orderKind && now < sys.orderUntil) return false;            // `가자` · `앞장`
  return true;
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

/* ── picking a crate ─────────────────────────────────────────────────────── */

function containers(sys: AllySystem): readonly LootContainerInfo[] {
  return sys.ctx.world?.getLootContainers?.() ?? [];
}
function containerOf(sys: AllySystem, id: string | null): LootContainerInfo | null {
  if (!id) return null;
  for (const c of containers(sys)) if (c.id === id) return c;
  return null;
}

/**
 * The crate it loots on its own — **right beside it (`ALLY_IDLE_LOOT_M`)**, inside the harness, still holding
 * something to take, and the nearest of those. Those two conditions say one thing: it never runs off toward a distant
 * crate (a pinged crate does not come down this path).
 */
function pickContainer(sys: AllySystem, a: Ally): string | null {
  if (!sys.leaderKnown) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of containers(sys)) {
    if (sys.viewedContainers.has(c.id)) continue;
    if (dist2D(c.position, sys.leaderPos) > sys.harness) continue;
    const d = dist2D(a.position, c.position);
    if (d > ALLY_IDLE_LOOT_M) continue;
    if (d >= bestD) continue;
    const fog = sys.ctx.world?.fog;
    if (fog && !fog.isDiscovered(c.position)) continue;
    if (!peekBest(sys, c)) continue;
    best = c.id; bestD = d;
  }
  return best;
}

/**
 * The container standing at the ping spot (null when nothing is inside `PING_CRATE_MATCH_M` — that ping was not a
 * crate).
 */
function nearestContainerId(sys: AllySystem, a: Ally, near: THREE.Vector3): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of containers(sys)) {
    const d = dist2D(c.position, near);
    if (d < bestD) { best = c.id; bestD = d; }
  }
  void a;
  return bestD <= PING_CRATE_MATCH_M ? best : null;
}

function stillWorth(sys: AllySystem, a: Ally, id: string): boolean {
  const c = containerOf(sys, id);
  if (!c || sys.viewedContainers.has(id)) return false;
  void a;
  return !!peekBest(sys, c);
}

/** The most valuable row in this crate (null with none). **The same roll** as opening, so peek equals take. */
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

/** Takes one row. True when it took something. */
function takeOne(sys: AllySystem, a: Ally, c: LootContainerInfo): boolean {
  const want = peekBest(sys, c);
  if (!want) return false;
  const got = sys.ctx.inventory?.takeContainerItemFor?.(c.id, c.tier, want.defId, a.id) ?? null;
  if (!got) return false;
  const slot = Bag.upgradeSlotOf(sys, a, got);
  Bag.take(sys, a, got);
  if (slot) Bag.tryUpgrade(sys, a);
  // Gear better than the squad leader's is announced (user's decision — an item ping → handing it over).
  if (Bag.beatsLeader(sys, got)) sys.offerToLeader(a, got);
  return true;
}
